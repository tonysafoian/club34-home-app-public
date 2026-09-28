import { fetchT } from './lib/fetchWithTimeout.js';
import { logAudit } from './lib/auditLog.js';
import { query } from './lib/db.js';
import type { TeslaTokenRow, TeslaBatteryAlertRow } from '../shared/dbRows.js';
import { getLastWebhookReceivedAt } from './routes/verkada.js';
import { getAlertPhoneNumber } from './lib/helpers.js';

const TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_AUTH_BASE = "https://fleet-auth.prd.vn.cloud.tesla.com";

const RANGE_THRESHOLD_MILES = 100;
const ALERT_COOLDOWN_HOURS = 4;
const RECIPIENTS = (process.env.BATTERY_ALERT_EMAILS || "admin@example.com").split(",").map(e => e.trim());

async function refreshTokenIfNeeded(
  userId: string,
  tokenRow: Pick<TeslaTokenRow, 'access_token' | 'refresh_token' | 'token_expires_at'>
): Promise<string> {
  const expiresAt = new Date(tokenRow.token_expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return tokenRow.access_token;
  }

  const clientId = process.env.TESLA_CLIENT_ID!;
  const clientSecret = process.env.TESLA_CLIENT_SECRET!;

  const res = await fetchT(`${TESLA_AUTH_BASE}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token,
    }),
  });

  if (!res.ok) throw new Error("Failed to refresh Tesla token");

  const data = await res.json() as any;
  await query(
    `UPDATE tesla_tokens SET access_token = $1, refresh_token = $2, token_expires_at = $3 WHERE user_id = $4`,
    [data.access_token, data.refresh_token || tokenRow.refresh_token, new Date(Date.now() + data.expires_in * 1000).toISOString(), userId]
  );

  return data.access_token as string;
}

async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetchT(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16`,
      { headers: { 'User-Agent': 'Club34/1.0' } },
      5000
    );
    if (!res.ok) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const data = await res.json() as any;
    const addr = data.address || {};
    const parts = [addr.road, addr.neighbourhood || addr.suburb, addr.city || addr.town].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}

async function logEvent(
  vehicleId: string,
  vehicleName: string,
  eventType: string,
  details: Record<string, unknown>
) {
  try {
    await query(
      `INSERT INTO tesla_activity_logs (vehicle_id, vehicle_name, event_type, details, occurred_at) VALUES ($1, $2, $3, $4, $5)`,
      [vehicleId, vehicleName, eventType, JSON.stringify(details), new Date().toISOString()]
    );
    console.log(`Logged event: ${eventType} for ${vehicleName}`);
  } catch (e) {
    console.error(`Failed to log event ${eventType} for ${vehicleName}:`, e);
  }
}

export async function runTeslaBatteryMonitor(): Promise<void> {
  try {
    const { rows: tokenRows } = await query<TeslaTokenRow>(`SELECT * FROM tesla_tokens`);

    if (tokenRows.length === 0) {
      console.log("Tesla battery monitor: No Tesla accounts connected");
      return;
    }

    let totalChecked = 0, totalAlerts = 0;

    for (const tokenRow of tokenRows) {
      try {
        const accessToken = await refreshTokenIfNeeded(tokenRow.user_id, tokenRow);

        const vehRes = await fetchT(`${TESLA_API_BASE}/api/1/vehicles`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!vehRes.ok) {
          console.error(`Failed to list vehicles for user ${tokenRow.user_id}:`, vehRes.status);
          continue;
        }
        const vehData = await vehRes.json() as any;
        const vehicles = vehData.response || [];

        for (const vehicle of vehicles) {
          totalChecked++;
          const vehicleId = String(vehicle.id);
          const vehicleName = vehicle.display_name || `Vehicle ${vehicleId}`;

          const { rows: alertRows } = await query<TeslaBatteryAlertRow>(`SELECT * FROM tesla_battery_alerts WHERE vehicle_id = $1 LIMIT 1`, [vehicleId]);
          const alertRow = alertRows.length > 0 ? alertRows[0] : null;

          try {
            const dataRes = await fetchT(
              `${TESLA_API_BASE}/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=${encodeURIComponent("charge_state;drive_state")}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );

            if (!dataRes.ok) {
              console.log(`Vehicle ${vehicleName} data unavailable (${dataRes.status}), possibly asleep`);
              const prevSleepDetails = alertRow?.details as Record<string, unknown> | null ?? null;
              const prevSleepVehicleState = prevSleepDetails?.vehicle_state as string | null ?? null;
              const currentSleepState = vehicle.state as string;
              if (prevSleepVehicleState === 'online' && (currentSleepState === 'asleep' || currentSleepState === 'offline')) {
                await logEvent(vehicleId, vehicleName, "vehicle_slept", {
                  previous_state: prevSleepVehicleState,
                });
              }
              await query(
                `INSERT INTO tesla_battery_alerts (vehicle_id, vehicle_name, details) VALUES ($1, $2, $3) ON CONFLICT (vehicle_id) DO UPDATE SET vehicle_name = EXCLUDED.vehicle_name, details = EXCLUDED.details`,
                [vehicleId, vehicleName, JSON.stringify({ ...(prevSleepDetails || {}), vehicle_state: currentSleepState })]
              );

              const lastKnownRange = alertRow?.last_range_miles != null ? Number(alertRow.last_range_miles) : null;
              const lastKnownPluggedIn = prevSleepDetails?.plugged_in as boolean | undefined;
              const alreadyAlertActive = alertRow?.alert_active === true;
              if (
                lastKnownRange !== null &&
                lastKnownRange < RANGE_THRESHOLD_MILES &&
                lastKnownPluggedIn !== true &&
                !alreadyAlertActive
              ) {
                const lastAlerted = alertRow?.last_alerted_at ? new Date(alertRow.last_alerted_at) : null;
                const cooldownExpired = !lastAlerted || (Date.now() - lastAlerted.getTime()) > ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;
                if (cooldownExpired) {
                  console.log(`ALERT (asleep): ${vehicleName} last known range ${lastKnownRange}mi — sending emails`);
                  const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
                  for (const to of RECIPIENTS) {
                    try {
                      await fetchT(`${baseUrl}/api/janus/email`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "send", to,
                          subject: `⚡ ${vehicleName} — Battery Low (${Math.round(lastKnownRange)} mi, vehicle asleep)`,
                          body: `${vehicleName} is asleep and its last known range was ${Math.round(lastKnownRange)} miles (below ${RANGE_THRESHOLD_MILES} mi threshold).\nThe vehicle has been unresponsive, so the battery may be even lower now.\nPlease plug in the vehicle when possible.\n— Janus`,
                        }),
                      });
                    } catch (e) { console.error(`Failed to email ${to}:`, e); }
                  }
                  await query(
                    `UPDATE tesla_battery_alerts SET last_alerted_at = $1, alert_active = true WHERE vehicle_id = $2`,
                    [new Date().toISOString(), vehicleId]
                  );
                  await logEvent(vehicleId, vehicleName, "low_battery_alert", {
                    battery_level: null, range_miles: Math.round(lastKnownRange), alert_sent_to: RECIPIENTS, vehicle_asleep: true,
                  });
                  totalAlerts++;
                }
              }

              continue;
            }

            const vehicleData = await dataRes.json() as any;
            const chargeState = vehicleData?.response?.charge_state;
            const driveState = vehicleData?.response?.drive_state;

            if (!chargeState) {
              console.log(`No charge_state for ${vehicleName}`);
              continue;
            }

            const rangeMiles = chargeState.battery_range || 0;
            const batteryLevel = chargeState.battery_level || 0;
            const chargingState = chargeState.charging_state as string;
            const isPluggedIn = chargeState.charging_state !== "Disconnected";
            const isDriving = driveState?.shift_state != null && driveState.shift_state !== '';

            console.log(`${vehicleName}: range=${rangeMiles}mi, charging=${chargingState}, pluggedIn=${isPluggedIn}`);

            // Read previous state for transition detection
            const prevDetails = alertRow?.details as Record<string, unknown> | null ?? null;
            const prevVehicleState = prevDetails?.vehicle_state as string | null ?? null;
            const prevChargingState = prevDetails?.charging_state as string | null ?? null;
            const prevPluggedIn = prevDetails?.plugged_in as boolean | null ?? null;
            const prevIsDriving = prevDetails?.is_driving as boolean | null ?? null;
            const hasPrevState = prevDetails !== null && prevVehicleState !== null;

            const currentVehicleState = vehicle.state as string;

            // Detect state transitions (only when we have a previous state to compare against)
            if (hasPrevState) {
              const wasAsleep = prevVehicleState === 'asleep' || prevVehicleState === 'offline';
              const justWoke = wasAsleep && currentVehicleState === 'online';

              if (justWoke) {
                await logEvent(vehicleId, vehicleName, "vehicle_woke", {
                  previous_state: prevVehicleState,
                  battery_level: batteryLevel,
                });
                // After waking, skip other transition checks to avoid false-fires from stale data
              } else {
                // Drive transitions
                if (prevIsDriving !== null) {
                  if (!prevIsDriving && isDriving) {
                    const location = (driveState?.latitude && driveState?.longitude)
                      ? await reverseGeocode(driveState.latitude, driveState.longitude)
                      : undefined;
                    await logEvent(vehicleId, vehicleName, "drive_started", {
                      battery_level: batteryLevel,
                      ...(location ? { location } : {}),
                    });

                    // Send WhatsApp alert to Tony
                    try {
                      const phone = await getAlertPhoneNumber();
                      const msg = `🚗 ${vehicleName} started driving near ${location || 'unknown location'}.`;
                      const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
                      await fetchT(`${baseUrl}/api/janus/whatsapp`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "send",
                          to: phone,
                          message: msg,
                        }),
                      });
                      console.log(`Sent drive started WhatsApp alert for ${vehicleName}`);
                    } catch (waErr) {
                      console.error(`Failed to send drive started WhatsApp alert for ${vehicleName}:`, waErr);
                    }
                  } else if (prevIsDriving && !isDriving) {
                    const location = (driveState?.latitude && driveState?.longitude)
                      ? await reverseGeocode(driveState.latitude, driveState.longitude)
                      : undefined;
                    await logEvent(vehicleId, vehicleName, "drive_stopped", {
                      battery_level: batteryLevel,
                      ...(location ? { location } : {}),
                    });

                    // Send WhatsApp alert to Tony
                    try {
                      const phone = await getAlertPhoneNumber();
                      const msg = `🅿️ ${vehicleName} stopped driving near ${location || 'unknown location'}.`;
                      const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
                      await fetchT(`${baseUrl}/api/janus/whatsapp`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "send",
                          to: phone,
                          message: msg,
                        }),
                      });
                      console.log(`Sent drive stopped WhatsApp alert for ${vehicleName}`);
                    } catch (waErr) {
                      console.error(`Failed to send drive stopped WhatsApp alert for ${vehicleName}:`, waErr);
                    }
                  }
                }

                // Plug transitions
                if (prevPluggedIn !== null) {
                  if (!prevPluggedIn && isPluggedIn) {
                    await logEvent(vehicleId, vehicleName, "plugged_in", {
                      battery_level: batteryLevel,
                      charging_state: chargingState,
                    });
                  } else if (prevPluggedIn && !isPluggedIn) {
                    await logEvent(vehicleId, vehicleName, "unplugged", {
                      battery_level: batteryLevel,
                    });
                  }
                }

                // Charging transitions (only when plugged in)
                if (prevChargingState !== null && prevChargingState !== chargingState) {
                  const wasCharging = prevChargingState === "Charging";
                  const isCharging = chargingState === "Charging";
                  const isComplete = chargingState === "Complete";

                  if (!wasCharging && isCharging) {
                    await logEvent(vehicleId, vehicleName, "charging_started", {
                      battery_level: batteryLevel,
                    });
                  } else if (wasCharging && !isCharging) {
                    if (isComplete) {
                      await logEvent(vehicleId, vehicleName, "charging_complete", {
                        battery_level: batteryLevel,
                      });
                    } else {
                      await logEvent(vehicleId, vehicleName, "charging_stopped", {
                        battery_level: batteryLevel,
                        charging_state: chargingState,
                      });
                    }
                  }
                }
              }
            }

            // Detect vehicle going to sleep (current poll shows online->asleep transition)
            if (hasPrevState && prevVehicleState === 'online' && (currentVehicleState === 'asleep' || currentVehicleState === 'offline')) {
              await logEvent(vehicleId, vehicleName, "vehicle_slept", {
                battery_level: batteryLevel,
              });
            }

            await query(
              `INSERT INTO tesla_battery_alerts (vehicle_id, vehicle_name, last_range_miles, details) VALUES ($1, $2, $3, $4) ON CONFLICT (vehicle_id) DO UPDATE SET vehicle_name = EXCLUDED.vehicle_name, last_range_miles = EXCLUDED.last_range_miles, details = EXCLUDED.details`,
              [vehicleId, vehicleName, rangeMiles, JSON.stringify({
                vehicle_state: currentVehicleState,
                charging_state: chargingState,
                plugged_in: isPluggedIn,
                battery_level: batteryLevel,
                is_driving: isDriving,
                latitude: driveState?.latitude ?? null,
                longitude: driveState?.longitude ?? null,
                speed: driveState?.speed ?? null,
                last_checked_at: new Date().toISOString(),
              })]
            );

            if (rangeMiles < RANGE_THRESHOLD_MILES && !isPluggedIn) {
              const lastAlerted = alertRow?.last_alerted_at ? new Date(alertRow.last_alerted_at) : null;
              const cooldownExpired = !lastAlerted || (Date.now() - lastAlerted.getTime()) > ALERT_COOLDOWN_HOURS * 60 * 60 * 1000;

              if (cooldownExpired) {
                console.log(`ALERT: ${vehicleName} at ${rangeMiles}mi — sending emails`);
                const baseUrl = `http://localhost:${process.env.PORT || 5000}`;

                for (const to of RECIPIENTS) {
                  try {
                    await fetchT(`${baseUrl}/api/janus/email`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "send", to,
                        subject: `⚡ ${vehicleName} — Battery Low (${Math.round(rangeMiles)} mi)`,
                        body: `${vehicleName} has dropped below ${RANGE_THRESHOLD_MILES} miles of range.\nCurrent range: ${Math.round(rangeMiles)} miles.\nPlease plug in the vehicle when possible.\n— Janus`,
                      }),
                    });
                  } catch (e) { console.error(`Failed to email ${to}:`, e); }
                }

                await query(
                  `UPDATE tesla_battery_alerts SET last_alerted_at = $1, alert_active = true WHERE vehicle_id = $2`,
                  [new Date().toISOString(), vehicleId]
                );

                await logEvent(vehicleId, vehicleName, "low_battery_alert", {
                  battery_level: batteryLevel, range_miles: Math.round(rangeMiles), alert_sent_to: RECIPIENTS,
                });

                totalAlerts++;
              }
            } else if (alertRow?.alert_active) {
              await query(`UPDATE tesla_battery_alerts SET alert_active = false WHERE vehicle_id = $1`, [vehicleId]);
              await logEvent(vehicleId, vehicleName, "battery_recovered", {
                battery_level: batteryLevel, range_miles: Math.round(rangeMiles), plugged_in: isPluggedIn, charging_state: chargingState,
              });
              console.log(`RECOVERY: ${vehicleName} battery alert cleared`);
            }
          } catch (vErr) {
            console.error(`Error checking ${vehicleName}:`, vErr);
          }
        }
      } catch (err) {
        console.error(`Tesla battery monitor error for user ${tokenRow.user_id}:`, err);
      }
    }

    console.log(`Tesla battery monitor complete: checked=${totalChecked}, alerts=${totalAlerts}`);
    logAudit('tesla-battery-monitor', {
      category: 'home', event_type: 'battery_monitor_run', severity: 'info',
      actor_id: 'system', channel: 'cron',
      summary: `Tesla battery check complete — ${totalChecked} vehicle${totalChecked !== 1 ? 's' : ''} checked, ${totalAlerts} low-battery alert${totalAlerts !== 1 ? 's' : ''} sent`,
      status: 'success',
    });
  } catch (err) {
    console.error('Tesla battery monitor error:', err);
    logAudit('tesla-battery-monitor', {
      category: 'home', event_type: 'battery_monitor_error', severity: 'error',
      actor_id: 'system', channel: 'cron',
      summary: `Tesla battery monitor failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      status: 'error',
    });
  }
}

function getCronAuthHeader(): Record<string, string> {
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (secret) {
    return { 'Authorization': `Bearer ${secret}` };
  }
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    return { 'x-cron-secret': cronSecret };
  }
  return {};
}

async function runPoolHeaterRainGuard(): Promise<void> {
  const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
  try {
    const res = await fetchT(`${baseUrl}/api/pool/rain-guard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getCronAuthHeader() },
      body: JSON.stringify({}),
    });
    const data = await res.json() as any;
    console.log('Scheduled pool-heater-rain-guard result:', data.action || data.error);
  } catch (err) {
    console.error('Scheduled pool-heater-rain-guard error:', err);
  }
}

export async function runVerkadaWebhookHealthCheck(): Promise<void> {
  try {
    const lastAt = getLastWebhookReceivedAt();
    const nowLA = new Date();
    const laHourStr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(nowLA);
    const laHour = parseInt(laHourStr);
    const isDaytime = laHour >= 7 && laHour < 22;

    if (!isDaytime) return;

    const minutesSince = lastAt ? Math.floor((Date.now() - lastAt) / 60000) : null;
    const noWebhookReceived = lastAt === null;
    const stale = minutesSince !== null && minutesSince >= 15;

    if (noWebhookReceived || stale) {
      const reason = noWebhookReceived
        ? 'no webhook received since startup'
        : `last webhook was ${minutesSince} minutes ago`;
      console.warn(`[verkada] WEBHOOK HEALTH WARNING: ${reason}. Check Verkada Command webhook configuration.`);

      await logAudit('verkada-webhook-health-monitor', {
        category: 'security',
        event_type: 'verkada_webhook_health_warning',
        severity: 'warning',
        actor_id: 'system',
        actor_name: 'system',
        channel: 'cron',
        summary: `Verkada webhook connectivity issue: ${reason}`,
        detail: {
          last_webhook_at: lastAt ? new Date(lastAt).toISOString() : null,
          minutes_since_last_webhook: minutesSince,
          is_daytime: isDaytime,
        },
        status: 'warning',
      });
    } else {
      console.log(`[verkada] Webhook health OK — last received ${minutesSince}m ago`);
    }
  } catch (err) {
    console.error('[cron] Verkada webhook health check error:', err);
  }
}

export function startScheduledTasks(): void {
  console.log('Starting scheduled tasks...');
  console.log('Scheduled tasks registered: (none — all scheduling handled by server/routes/cron.ts)');
}
