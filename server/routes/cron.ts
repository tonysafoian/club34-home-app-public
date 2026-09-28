import cron from 'node-cron';
import { logAudit } from '../lib/auditLog';
import { generateCorrelationId } from '../lib/correlation';
import { runVerkadaWebhookHealthCheck } from '../scheduledTasks';
import { pingTunnel as pingRuckusTunnel } from '../lib/ruckus';
import { pingTunnel as pingFortigateTunnel } from '../lib/fortigate';

// NOTE (2026-05-17): checkAndRemovePgCronJobs() and the 15-min runDatabaseSync
// cron used to manage a separate Supabase-hosted PROD_DATABASE_URL. That
// project was deleted during the Express migration; PROD_DATABASE_URL has
// been unset since. Both code paths were silent no-ops and have been removed.
// See server/lib/auditLog.ts header for full history.

const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

async function triggerRoute(path: string, body: Record<string, unknown> = {}): Promise<void> {
  const t0 = Date.now();
  // Generate one correlation id per cron tick and pass it as
  // X-Correlation-Id on the POST. The route's correlationMiddleware
  // sees the header and reuses it for the whole downstream run, so
  // the cron-trigger audit row and every audit / failed-jobs / chat-log
  // row written during the route's work share the same id. "Why did
  // Janus broadcast the weather twice on Tuesday?" becomes a single
  // SELECT … WHERE correlation_id = $1.
  const correlationId = `cron:${generateCorrelationId()}`;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': process.env.CRON_SECRET || '',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify(body),
    });
    const durationMs = Date.now() - t0;
    const status = res.ok ? 'ok' : `error ${res.status}`;
    console.log(`[cron] ${path} → ${status} (cid=${correlationId})`);
    logAudit('cron-trigger', {
      category: 'automation', event_type: 'cron_route_triggered', severity: 'info',
      actor_id: 'system', channel: 'cron',
      summary: `Cron triggered ${path}${res.ok ? '' : ` (HTTP ${res.status})`}`,
      detail: { path, http_status: res.status, body: Object.keys(body).length > 0 ? body : undefined },
      status: res.ok ? 'success' : 'error',
      duration_ms: durationMs,
      correlation_id: correlationId,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
  } catch (err) {
    const durationMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron] ${path} failed (cid=${correlationId}):`, message);
    logAudit('cron-trigger', {
      category: 'automation', event_type: 'cron_route_failed', severity: 'error',
      actor_id: 'system', channel: 'cron',
      summary: `Cron trigger failed for ${path}: ${message}`,
      detail: { path, error: message },
      status: 'error',
      duration_ms: durationMs,
      correlation_id: correlationId,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
  }
}

let cronInitialized = false;

export function initCronJobs(): void {
  if (cronInitialized) {
    console.warn('[cron] initCronJobs() called more than once — skipping to prevent duplicate cron jobs.');
    return;
  }
  cronInitialized = true;

  const isDeployment = !!process.env.REPLIT_DEPLOYMENT;
  const forceEnable = process.env.ENABLE_CRON === '1';
  if (!isDeployment && !forceEnable) {
    console.log('[cron] Skipping cron initialization (dev environment). Set ENABLE_CRON=1 to override.');
    return;
  }
  console.log(`[cron] Initializing scheduled jobs... (${isDeployment ? 'deployment' : 'dev+ENABLE_CRON'})`);

  cron.schedule('*/30 * * * * *', () => {
    triggerRoute('/api/janus/email-poll');
  });

  cron.schedule('*/30 * * * * *', () => {
    triggerRoute('/api/janus/reminder-dispatch');
  });

  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/janus/health-check');
  });

  cron.schedule('0 14 * * *', () => {
    console.log('[cron] Running daily entertainment sync (6:00 AM PST)');
    triggerRoute('/api/entertainment-sync', { action: 'all' });
  }, { timezone: 'UTC' });

  cron.schedule('15 14 * * *', () => {
    console.log('[cron] Running daily media sync (6:15 AM PST)');
    triggerRoute('/api/media-sync', { action: 'all' });
  }, { timezone: 'UTC' });

  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/internet-health-monitor');
  }, { timezone: 'UTC' });

  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/fortigate-health-snapshot');
  }, { timezone: 'UTC' });

  // WAN throughput history sampler — inserts one row per minute into
  // wan_throughput_history for the WAN History sparkline panel.
  cron.schedule('* * * * *', () => {
    triggerRoute('/api/fortigate-wan-snapshot');
  }, { timezone: 'UTC' });

  // Wireless observability snapshot (Ruckus controller). Every 5 min
  // we record AP/SSID/client counts + per-AP states to wireless_snapshots
  // and emit derived ap_joined/ap_disconnected/ap_unknown/ssid_clients_drop
  // /telemetry_stale events to wireless_events. Diagnostics surface at
  // /api/wireless/diagnostics and in the Admin Wireless Diagnostics tab.
  cron.schedule('*/5 * * * *', () => {
    triggerRoute('/api/wireless-snapshot');
  }, { timezone: 'UTC' });

  // Keep the Ruckus Cloudflare Tunnel warm. The origin TCP/TLS session
  // goes idle between the 5-min wireless polls, so the first poll after
  // idle eats a 10-12s cold start (and often fails, tripping the breaker).
  // A cheap unauthenticated GET every 2 min keeps the socket hot so real
  // polls stay sub-second. Best-effort: pingTunnel() swallows its own
  // errors and writes no audit row, so we don't route it through
  // triggerRoute() (which would add audit noise on every tick).
  cron.schedule('*/2 * * * *', () => {
    pingRuckusTunnel();
  });

  // Keep the FortiGate Cloudflare Tunnel warm too — same cold-tunnel
  // problem as Ruckus above: the origin TCP/TLS session goes idle between
  // polls, so the first FortiGate poll (interfaces, SD-WAN health, WAN
  // stats) after a quiet period is slow or fails. Best-effort and silent,
  // called directly (not via triggerRoute) to avoid audit noise.
  cron.schedule('*/2 * * * *', () => {
    pingFortigateTunnel();
  });

  // Seed network_devices from HA device_tracker.* entities (MAC + hostname)
  // so the WiFi Clients inventory is populated even before Ruckus/FortiGate
  // REST device data flows. Idempotent; every 30 min.
  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/network-device-backfill');
  }, { timezone: 'UTC' });

  // Flag newly-appeared unknown devices (catch-weird-activity). Every 15 min.
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/network-new-device-monitor');
  }, { timezone: 'UTC' });

  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/printer-health-monitor');
  }, { timezone: 'UTC' });

  cron.schedule('0 3 * * *', () => {
    console.log('[cron] Running log retention worker (daily 3:00 AM UTC)');
    triggerRoute('/api/log-retention-worker');
  }, { timezone: 'UTC' });

  cron.schedule('*/5 * * * *', () => {
    triggerRoute('/api/failed-job-retry-worker');
  }, { timezone: 'UTC' });

  cron.schedule('*/5 * * * *', () => {
    triggerRoute('/api/package-arrival-monitor');
  }, { timezone: 'UTC' });

  cron.schedule('*/5 * * * *', () => {
    triggerRoute('/api/ha-server-health-monitor');
  }, { timezone: 'UTC' });

  cron.schedule('0 */6 * * *', () => {
    triggerRoute('/api/ha-update-checker');
  }, { timezone: 'UTC' });

  // Door locks & battery monitor — checks lock states, battery telemetry, and
  // Crestron connection status every 4 hours. Alerts via WhatsApp if any lock
  // is jammed, offline, or battery drops below 20%.
  cron.schedule('0 */4 * * *', () => {
    triggerRoute('/api/ha-locks-monitor');
  }, { timezone: 'America/Los_Angeles' });

  // Google Assistant SDK health check — probes the service every 15 min and
  // sends a WhatsApp alert if the integration is down (deduplicated to 6 hrs).
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/google-assistant-sdk-monitor');
  }, { timezone: 'UTC' });

  // Thermostat monitor — polls all climate entities, logs to thermostat_logs,
  // enforces Gym AC 6 AM–3 PM PT schedule, alerts if temp out of range.
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/thermostat-monitor');
  }, { timezone: 'America/Los_Angeles' });

  // Energy Savings: fountains off at 9:00 PM PT nightly.
  cron.schedule('0 21 * * *', () => {
    triggerRoute('/api/energy/fountains-off');
  }, { timezone: 'America/Los_Angeles' });

  // Energy Savings: closet (30 min) & bathroom (15 min / Primary 1 hr)
  // light timers — checks every 5 minutes using HA last_changed.
  cron.schedule('*/5 * * * *', () => {
    triggerRoute('/api/energy/light-timers');
  }, { timezone: 'UTC' });

  // AV Closet temp monitor — reads the Govee AV Closet temperature sensor every
  // 10 min; emails Tony/Sandra/Jesse over 90°F, WhatsApps Tony over 100°F.
  cron.schedule('*/10 * * * *', () => {
    triggerRoute('/api/av-closet-temp-monitor');
  }, { timezone: 'America/Los_Angeles' });

  // Thermostat freshness monitor — alerts via WhatsApp if no rows have been
  // written to thermostat_logs in the last 30 minutes during operating hours
  // (6 AM – midnight PT). Deduplicated to one alert per stale incident.
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/thermostat-freshness-monitor');
  }, { timezone: 'America/Los_Angeles' });

  // Pool temp freshness monitor — alerts via WhatsApp if no successful
  // pool_temp_check audit entries have been written within the threshold
  // window during pool hours (6 AM – 11 PM PT). Deduplicated to one alert
  // per stale incident with a recovery entry when data resumes.
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/pool-temp-freshness-monitor');
  }, { timezone: 'America/Los_Angeles' });

  // Wireless snapshot pipeline watchdog — alerts (actionable audit row) if
  // the /api/wireless-snapshot heartbeat (wireless_snapshot_ok) hasn't been
  // seen in >20 min (≈4 missed 5-min cycles). Deduped to one alert per
  // 60-min window. Surfaces in Admin → Actionable Alerts.
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/wireless-snapshot-watchdog');
  });

  // Speed test pull from Home Assistant — reads sensor.speedtest_download/
  // upload/ping every 15 min and writes a speed_tests row when the sensor
  // last_changed is newer than the most recent stored row. Replaces the
  // brittle HA-side push automation that used to POST to /api/speedtest-
  // ingest (the table sat empty for weeks when that automation rotted).
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/speedtest-pull-from-ha');
  }, { timezone: 'UTC' });

  // Speed test freshness monitor — alerts via WhatsApp if no rows have
  // been inserted into speed_tests within the threshold window. Runs 24/7
  // since the HA speedtest automation does not have an operating-hours gate.
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/speed-test-freshness-monitor');
  }, { timezone: 'UTC' });

  cron.schedule('30 8 * * 1,3,5', () => {
    console.log('[cron] Running Morning Sauna automation (8:30 AM PT Mon/Wed/Fri)');
    triggerRoute('/api/automation/morning-sauna');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('50 8 * * 2,4', () => {
    console.log('[cron] Running Morning Sauna automation (8:50 AM PT Tue/Thu)');
    triggerRoute('/api/automation/morning-sauna');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 9 * * 1,3,5', () => {
    console.log('[cron] Stopping Morning Sauna after 30 minutes (9:00 AM PT Mon/Wed/Fri)');
    triggerRoute('/api/automation/morning-sauna/stop');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('20 9 * * 2,4', () => {
    console.log('[cron] Stopping Morning Sauna after 30 minutes (9:20 AM PT Tue/Thu)');
    triggerRoute('/api/automation/morning-sauna/stop');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/pool/temp-monitor');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/pool/spa-mode-monitor');
  }, { timezone: 'America/Los_Angeles' });

  // ── Grocery weekly cycle ────────────────────────────────────────────────
  // Sat 00:00 PT — open the Sat→Fri cart cycle (idempotent)
  cron.schedule('0 0 * * 6', () => {
    console.log('[cron] Grocery: opening weekly cycle (Sat 00:00 PT)');
    triggerRoute('/cron/open-cycle');
  }, { timezone: 'America/Los_Angeles' });

  // Tue 16:00 PT — open-reminder notification (cart is open for next week)
  cron.schedule('0 16 * * 2', () => {
    console.log('[cron] Grocery: sending open-reminder notification (Tue 16:00 PT)');
    triggerRoute('/cron/open-reminder');
  }, { timezone: 'America/Los_Angeles' });

  // Thu 16:00 PT — last-call notification (cart closes tomorrow)
  cron.schedule('0 16 * * 4', () => {
    console.log('[cron] Grocery: sending last-call notification (Thu 16:00 PT)');
    triggerRoute('/cron/last-call');
  }, { timezone: 'America/Los_Angeles' });

  // Fri 16:00 PT — lock cart and submit to Amazon Grocery
  cron.schedule('0 16 * * 5', () => {
    console.log('[cron] Grocery: locking and submitting weekly order (Fri 16:00 PT)');
    triggerRoute('/cron/lock-and-submit');
  }, { timezone: 'America/Los_Angeles' });

  // Mon 06:00 PT — delivery-day notification to Rina
  cron.schedule('0 6 * * 1', () => {
    console.log('[cron] Grocery: Monday delivery follow-up (Mon 06:00 PT)');
    triggerRoute('/cron/rina-monday');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 7 * * *', () => {
    console.log('[cron] Running Morning Weather Email (7:00 AM PT daily)');
    triggerRoute('/api/reports/morning-weather');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 16 * * *', () => {
    console.log('[cron] Running Daily EOD Summary (4:00 PM PT daily)');
    triggerRoute('/api/reports/eod-summary');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 16 * * 5', () => {
    console.log('[cron] Running Weekly Planning Email (Fridays 4:00 PM PT)');
    triggerRoute('/api/reports/weekly-planning');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 8 * * *', () => {
    console.log('[cron] Running Executive Status Email (8:00 AM PT daily)');
    triggerRoute('/api/reports/executive-status');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/calendar/conflicts');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('50 6 * * 1-5', () => {
    console.log('[cron] Running School Morning Broadcast (6:50 AM PT weekdays)');
    triggerRoute('/api/broadcast/school-morning');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('30 7 * * 1-5', () => {
    console.log('[cron] Running School Morning Broadcast (7:30 AM PT weekdays)');
    triggerRoute('/api/broadcast/school-morning');
  }, { timezone: 'America/Los_Angeles' });

  // CT #129: meeting-prep cron retired permanently (was disabled 2026-05-11).

  cron.schedule('0 */2 * * *', () => {
    triggerRoute('/api/followup/accountability');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('*/5 * * * *', () => {
    console.log('[cron] Running Calendar Nav Tesla (every 5 min)');
    triggerRoute('/api/calendar/nav-tesla');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/tesla/battery-monitor');
  }, { timezone: 'UTC' });

  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/pool/rain-guard');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('*/15 * * * *', () => {
    runVerkadaWebhookHealthCheck().catch(err => console.error('[cron] Verkada webhook health check failed:', err));
  }, { timezone: 'UTC' });

  // Verkada POI backfill — every 4 h, pulls the last 4-hour window of Verkada
  // POI alert history and inserts any sightings the live webhook missed
  // (restarts, downtime, dropped deliveries). Deduped by existing dedup_key.
  cron.schedule('0 */4 * * *', () => {
    triggerRoute('/api/verkada/poi-backfill');
  }, { timezone: 'UTC' });

  cron.schedule('*/5 * * * *', () => {
    triggerRoute('/api/goaccess/poll');
  }, { timezone: 'America/Los_Angeles' });

  // Notion activity poller — safety net for when the Notion webhook
  // subscription is inactive. Every 10 min it queries each active
  // notion_sync_config database for pages edited since the last sync and
  // records synthetic notion_webhook_events so the Activity Level chart keeps
  // filling in. Deduplicated against notion_cached_pages; when the live
  // webhook is healthy the poller finds nothing new.
  cron.schedule('*/10 * * * *', () => {
    triggerRoute('/api/notion/poll');
  }, { timezone: 'UTC' });

  // Notion webhook health monitor — uses the poller as ground truth: if the
  // poller is capturing activity but no live webhook events are arriving, the
  // webhook subscription has silently died (it auto-disables after repeated
  // slow deliveries — exactly what left the Activity chart empty for ~2 weeks).
  // Also verifies the poller cron itself is still firing. Alerts via WhatsApp +
  // audit log with incident-based dedup. Runs 24/7.
  cron.schedule('*/15 * * * *', () => {
    triggerRoute('/api/notion-webhook-health-monitor');
  }, { timezone: 'UTC' });

  // Electricity cost intelligence — hourly snapshot of energy stats from HA
  // for trend analysis without hammering HA on every API request.
  cron.schedule('5 * * * *', () => {
    console.log('[cron] Running hourly electricity snapshot sync');
    triggerRoute('/api/electricity/live-cost');
  }, { timezone: 'America/Los_Angeles' });

  // Per-circuit daily energy snapshot — 05:10 AM PT. Records the PRIOR
  // LA-local day's kWh for all 89 Emporia circuits into circuit_energy_daily
  // so Club34 owns the full history (monthly reports work forever, even past
  // HA's recorder purge window). Idempotent: re-runs upsert the same day.
  cron.schedule('10 5 * * *', () => {
    console.log('[cron] Running daily per-circuit energy snapshot (prior day)');
    triggerRoute('/api/electricity/snapshot-daily');
  }, { timezone: 'America/Los_Angeles' });

  // Daily water usage snapshot — 05:15 AM PT. Records the PRIOR LA-local day's
  // interior gallons (FloLogic adapter) + per-zone irrigation gallons (Rain Bird
  // runtime × GPM from HA history) into water_usage_daily → tiered LADWP $.
  // Idempotent: re-runs upsert the same day.
  cron.schedule('15 5 * * *', () => {
    console.log('[cron] Running daily water usage snapshot (prior day)');
    triggerRoute('/api/water/snapshot-daily');
  }, { timezone: 'America/Los_Angeles' });

  // Proactive token-expiration warnings — daily 9:00 AM PT. Scans
  // tesla_tokens + google_tokens for rows expiring within 24h and
  // WhatsApps the admin alert phone so Tony re-auths before the 401
  // storm. Dedup is keyed (user_id, kind) so retries don't re-message.
  cron.schedule('0 9 * * *', () => {
    console.log('[cron] Running token-expiration warnings sweep (9:00 AM PT)');
    triggerRoute('/api/janus/token-expiration-warnings');
  }, { timezone: 'America/Los_Angeles' });

  // HA Workflow Trigger Reconciler — checks every 30 min that Club34-managed
  // HA automations still exist and re-deploys any that went missing (e.g. after
  // an HA restart). Logs each redeploy to the audit log so it's visible in
  // the Automations page. Also fires a smart alert if the same rule keeps
  // needing repeated redeploys within an hour.
  cron.schedule('*/30 * * * *', () => {
    triggerRoute('/api/ha-workflow-reconciler');
  }, { timezone: 'UTC' });

  // ── Club34 Ball — Wednesday Night Pickup Basketball ─────────────
  //   1st of month, 9:00 AM PT — blast multi-game month invite
  //   Wed 9:00 AM PT — day-of hard re-confirm (must click to stay IN)
  //   Wed 11:00 AM PT — decide game ON or OFF, notify re-confirmed dads
  //   Wed 12:00 PM PT — email confirmed roster to gatehouse (~6h before 6pm game)
  //   Wed 5:00 PM PT — 1-hour reminder to confirmed dads
  // All endpoints are idempotent (skip if already sent / wrong status).
  cron.schedule('0 9 1 * *', () => {
    console.log('[cron] Ball — sending monthly invite blast');
    triggerRoute('/api/ball/cron/send-month-invite');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 9 * * 3', () => {
    console.log('[cron] Ball — sending Wed AM hard re-confirm');
    triggerRoute('/api/ball/cron/reconfirm');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 11 * * 3', () => {
    console.log('[cron] Ball — deciding ON/OFF for tonight');
    triggerRoute('/api/ball/cron/decide');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 12 * * 3', () => {
    console.log('[cron] Ball — emailing confirmed roster to gatehouse');
    triggerRoute('/api/ball/cron/email-gate');
  }, { timezone: 'America/Los_Angeles' });

  cron.schedule('0 17 * * 3', () => {
    console.log('[cron] Ball — sending 5:00 PM 1-hour reminder');
    triggerRoute('/api/ball/cron/remind');
  }, { timezone: 'America/Los_Angeles' });

  // Dependency security audit — daily 6:30 AM PT. Runs `npm audit --json
  // --omit=dev`, logs a vulnerability-count snapshot to the audit log, and
  // WhatsApps the admin alert phone when NEW high/critical advisories appear
  // (dedup keyed on the high/critical package set, 24h window). Surfaces new
  // advisories before they pile up into a silent backlog.
  cron.schedule('30 6 * * *', () => {
    console.log('[cron] Running dependency security audit (6:30 AM PT daily)');
    triggerRoute('/api/security-audit-monitor');
  }, { timezone: 'America/Los_Angeles' });

  // What's New auto-generator — daily 5:30 PM PT. Reads the GitHub commits that
  // landed since the last run, has AI summarize them into short family-friendly
  // changelog entries, and auto-publishes them to the /updates page. A commit
  // SHA cursor in system_configs prevents re-summarizing the same work twice.
  cron.schedule('30 17 * * *', () => {
    console.log("[cron] Running What's New auto-generator (5:30 PM PT daily)");
    triggerRoute('/api/updates-autogen');
  }, { timezone: 'America/Los_Angeles' });

  // ── Club34 Time Tracking crons ───────────────────────────────────────────

  // Worker daily digest — 6 PM PT Mon–Sat. Emails workers whose entries had
  // status changes (approved/rejected) that day so they know what happened.
  cron.schedule('0 18 * * 1-6', () => {
    console.log('[cron] Running time worker daily digest (6 PM PT)');
    triggerRoute('/api/time/cron/worker-digest');
  }, { timezone: 'America/Los_Angeles' });

  // Admin pending digest — 7 AM PT Mon–Sat. Emails the admin(s) a summary of
  // all workers with pending entries awaiting approval.
  cron.schedule('0 7 * * 1-6', () => {
    console.log('[cron] Running time admin pending digest (7 AM PT)');
    triggerRoute('/api/time/cron/admin-pending-digest');
  }, { timezone: 'America/Los_Angeles' });

  // Weekly close-out — 7 AM PT Monday. Emails the admin a summary of last
  // week's hours, approved/pending totals, and who is ready to be paid.
  cron.schedule('0 7 * * 1', () => {
    console.log('[cron] Running time weekly close-out (Mon 7 AM PT)');
    triggerRoute('/api/time/cron/weekly-closeout');
  }, { timezone: 'America/Los_Angeles' });

  console.log('[cron] All scheduled jobs registered');
}
