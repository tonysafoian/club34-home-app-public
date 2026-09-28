import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLog.js';
import { safeErrorJson } from '../lib/errorSanitizer.js';
import { fetchT } from '../lib/fetchWithTimeout.js';
import { query } from '../lib/db.js';
import type { AutomationStatusRow } from '../../shared/dbRows.js';
import { sendMonitorAlert } from '../utils/notifications.js';
import { getAlertPhoneNumber } from '../utils/janus-tools.js';
import { fetchGoogleHourlyForecast } from '../utils/google-weather.js';

const router = Router();

const ZODIAC_BASE = 'https://prod.zodiac-io.com';
const IAQUALINK_BASE = 'https://r-api.iaqualink.net';
const IAQUALINK_API_KEY = process.env.IAQUALINK_API_KEY || '';
const AWS_REGION = 'us-east-1';
const AWS_SERVICE = 'execute-api';

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const { webcrypto } = await import('crypto');
  const cryptoKey = await webcrypto.subtle.importKey(
    'raw', key instanceof ArrayBuffer ? key : key.buffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return webcrypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256(message: string): Promise<string> {
  const { webcrypto } = await import('crypto');
  const hash = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return toHex(hash);
}

async function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode('AWS4' + key), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

interface AwsCredentials {
  AccessKeyId: string;
  SecretKey: string;
  SessionToken: string;
  IdentityId: string;
  Expiration: string;
}

async function signRequest(method: string, url: string, headers: Record<string, string>, body: string, credentials: AwsCredentials): Promise<Record<string, string>> {
  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const path = parsedUrl.pathname;
  const queryString = parsedUrl.searchParams.toString();

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dateStamp = amzDate.substring(0, 8);

  const payloadHash = await sha256(body);

  const signedHeadersList = ['host', 'x-amz-date', 'x-amz-security-token'];
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\nx-amz-security-token:${credentials.SessionToken}\n`;
  const signedHeaders = signedHeadersList.join(';');

  const canonicalRequest = [method, path, queryString, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope = `${dateStamp}/${AWS_REGION}/${AWS_SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, await sha256(canonicalRequest)].join('\n');

  const signingKey = await getSignatureKey(credentials.SecretKey, dateStamp, AWS_REGION, AWS_SERVICE);
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBuffer);

  const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${credentials.AccessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...headers, 'Host': host, 'X-Amz-Date': amzDate, 'X-Amz-Security-Token': credentials.SessionToken, 'Authorization': authorizationHeader };
}

interface IaqualinkSession {
  userId: string;
  authToken: string;
  credentials: AwsCredentials;
  expiresAt: number;
}

let cachedSession: IaqualinkSession | null = null;

export async function getIaqualinkSession(): Promise<IaqualinkSession> {
  const now = Date.now();
  if (cachedSession && cachedSession.expiresAt > now + 2 * 60 * 1000) {
    return cachedSession;
  }

  const email = process.env.IAQUALINK_EMAIL;
  const password = process.env.IAQUALINK_PASSWORD;

  if (!email || !password) {
    throw new Error('IAQUALINK_EMAIL and IAQUALINK_PASSWORD are not configured');
  }

  const response = await fetch(`${ZODIAC_BASE}/users/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: IAQUALINK_API_KEY, email, password }),
  });

  const data = await response.json().catch(() => ({})) as Record<string, any>;

  if (!response.ok) {
    throw new Error(`iAqualink login failed (${response.status}): ${data.message || data.error || JSON.stringify(data)}`);
  }

  const userId = String(data.id || data.user_id);
  const authToken = data.authentication_token || data.auth_token;
  const credentials = data.credentials as AwsCredentials;

  if (!userId || !authToken) {
    throw new Error(`Unexpected login response format. Keys: ${Object.keys(data).join(', ')}`);
  }

  if (!credentials?.AccessKeyId) {
    throw new Error('No AWS credentials in login response — cannot sign device requests');
  }

  cachedSession = { userId, authToken, credentials, expiresAt: now + 55 * 60 * 1000 };
  console.log('iAqualink session established for user', userId);
  return cachedSession;
}

async function iaqualinkSignedGet(path: string, session: IaqualinkSession, extraParams?: Record<string, string>) {
  const qs = new URLSearchParams({ api_key: IAQUALINK_API_KEY, authentication_token: session.authToken, user_id: session.userId, ...extraParams });
  const url = `${IAQUALINK_BASE}${path}?${qs.toString()}`;
  const signedHeaders = await signRequest('GET', url, { 'Accept': 'application/json', 'Content-Type': 'application/json' }, '', session.credentials);
  const response = await fetch(url, { method: 'GET', headers: signedHeaders });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text, status: response.status }; }
}

async function iaqualinkSignedPut(path: string, session: IaqualinkSession, body: Record<string, unknown>) {
  const qs = new URLSearchParams({ api_key: IAQUALINK_API_KEY, authentication_token: session.authToken, user_id: session.userId });
  const url = `${IAQUALINK_BASE}${path}?${qs.toString()}`;
  const bodyStr = JSON.stringify(body);
  const signedHeaders = await signRequest('PUT', url, { 'Accept': 'application/json', 'Content-Type': 'application/json' }, bodyStr, session.credentials);
  const response = await fetch(url, { method: 'PUT', headers: signedHeaders, body: bodyStr });
  const text = await response.text();
  try { return { data: JSON.parse(text), ok: response.ok, status: response.status }; } catch { return { data: { raw: text }, ok: response.ok, status: response.status }; }
}

export async function iaqualinkSimpleGet(path: string, session: IaqualinkSession) {
  const qs = new URLSearchParams({ api_key: IAQUALINK_API_KEY, authentication_token: session.authToken, user_id: session.userId });
  const url = `${IAQUALINK_BASE}${path}?${qs.toString()}`;
  const response = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
  return response.json();
}

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const session = await getIaqualinkSession();
    const { action, ...params } = req.body;

    if (action === 'list-devices') {
      const data = await iaqualinkSimpleGet('/devices.json', session);
      res.json({ success: true, devices: data });
      return;
    }

    if (action === 'device-status') {
      const { serial_number } = params;
      if (!serial_number) { res.status(400).json({ success: false, error: 'serial_number is required' }); return; }
      res.json({ success: false, error: 'Device status requires Home Assistant integration. Zodiac API access is restricted.' });
      return;
    }

    if (action === 'set-aux') {
      const { serial_number, aux_id, value } = params;
      if (!serial_number || !aux_id) { res.status(400).json({ success: false, error: 'serial_number and aux_id are required' }); return; }
      const result = await iaqualinkSignedPut(`/devices/${serial_number}/aux.json`, session, { aux: aux_id, value: value ?? '1' });
      if (!result.ok) { res.json({ success: false, error: result.data?.message || `iAqualink API error ${result.status}` }); return; }
      res.json({ success: true, result: result.data });
      return;
    }

    if (action === 'set-temperature') {
      const { serial_number, temp_type, value } = params;
      if (!serial_number || !temp_type || value === undefined) { res.status(400).json({ success: false, error: 'serial_number, temp_type, and value are required' }); return; }
      const result = await iaqualinkSignedPut(`/devices/${serial_number}/temperature.json`, session, { [temp_type]: String(value) });
      if (!result.ok) { res.json({ success: false, error: result.data?.message || `iAqualink API error ${result.status}` }); return; }
      res.json({ success: true, result: result.data });
      return;
    }

    res.status(400).json({ success: false, error: 'Invalid action. Use: list-devices, device-status, set-aux, set-temperature' });
  } catch (error) {
    console.error('iAqualink proxy error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

const LAT = 34.0522;
const LON = -118.2437;
const POOL_HEATER_ENTITY = 'switch.pool_heater';
const SPA_HEATER_ENTITY = 'switch.spa_heater';
const POOL_CLIMATE_ENTITY = 'climate.pool';
const TARGET_TEMP = 87;

async function callHAProxy(body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) throw new Error('HA_URL or HA_TOKEN not configured');

  const url = `${haUrl.replace(/\/$/, '')}/api/services/${(body as any).domain}/${(body as any).service}`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify((body as any).service_data || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function fetchForecast(): Promise<number[]> {
  // Migrated from Open-Meteo 48-h precipitation → TWO sequential Google
  // forecast/hours:lookup calls (24 h each) using nextPageToken pagination.
  // fetchGoogleHourlyForecast handles pagination internally; we request 48 h.
  // Google returns precipitation in inches (IMPERIAL). The rain-guard logic
  // only checks p > 0 so units don't affect the control decision.
  const hours = await fetchGoogleHourlyForecast(LAT, LON, 48);
  return hours.map((h: any) => h.precipitation?.qpf?.quantity ?? 0);
}

router.post('/rain-guard', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    let automationId: string | null = null;
    const { rows: automations } = await query<AutomationStatusRow>(`SELECT id, is_active FROM family_automations WHERE name = $1 LIMIT 1`, ['Pool Heater Rain Guard']);
    if (automations.length > 0) {
      if (!automations[0].is_active) {
        res.json({ skipped: true, reason: 'Automation is disabled' });
        return;
      }
      automationId = automations[0].id;
    }

    const precipitation = await fetchForecast();
    const hours0to24 = precipitation.slice(0, 24);
    const hours24to48 = precipitation.slice(24, 48);

    const rainIn24h = hours0to24.some((p) => p > 0);
    const rainIn48h = [...hours0to24, ...hours24to48].some((p) => p > 0);

    const maxPrecip24 = Math.max(...hours0to24);
    const maxPrecip48 = Math.max(...hours0to24, ...hours24to48);

    let action: string;
    const haResults: Record<string, unknown>[] = [];

    if (rainIn24h) {
      action = 'heaters_off';
      const r1 = await callHAProxy({ action: 'call-service', domain: 'switch', service: 'turn_off', service_data: { entity_id: POOL_HEATER_ENTITY } });
      haResults.push({ entity: POOL_HEATER_ENTITY, service: 'turn_off', status: r1.status });
      const r2 = await callHAProxy({ action: 'call-service', domain: 'switch', service: 'turn_off', service_data: { entity_id: SPA_HEATER_ENTITY } });
      haResults.push({ entity: SPA_HEATER_ENTITY, service: 'turn_off', status: r2.status });
    } else if (!rainIn48h) {
      action = 'pool_heater_on_87';
      const r1 = await callHAProxy({ action: 'call-service', domain: 'switch', service: 'turn_on', service_data: { entity_id: POOL_HEATER_ENTITY } });
      haResults.push({ entity: POOL_HEATER_ENTITY, service: 'turn_on', status: r1.status });
      const r2 = await callHAProxy({ action: 'call-service', domain: 'climate', service: 'set_temperature', service_data: { entity_id: POOL_CLIMATE_ENTITY, temperature: TARGET_TEMP } });
      haResults.push({ entity: POOL_CLIMATE_ENTITY, service: 'set_temperature', status: r2.status });
    } else {
      action = 'no_change';
    }

    const output = {
      action,
      forecast: { rain_in_24h: rainIn24h, rain_in_48h: rainIn48h, max_precip_24h_in: maxPrecip24, max_precip_48h_in: maxPrecip48 },
      ha_results: haResults,
    };

    console.log('pool-heater-rain-guard result:', JSON.stringify(output));

    if (automationId) {
      const now = new Date().toISOString();
      await query(
        `INSERT INTO family_automation_logs (automation_id, status, output, started_at, completed_at) VALUES ($1, $2, $3, $4, $5)`,
        [automationId, 'success', JSON.stringify(output), now, now]
      );
      await query(`UPDATE family_automations SET last_run_at = $1 WHERE id = $2`, [now, automationId]);
    }

    logAudit('pool-heater-rain-guard', {
      category: 'automation', event_type: 'rain_guard', severity: 'info',
      actor_id: 'system', actor_name: 'Cron', channel: 'cron',
      summary: `Rain guard: ${action}`, detail: output, status: 'success',
    });

    res.json(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('pool-heater-rain-guard error:', msg);
    logAudit('pool-heater-rain-guard', {
      category: 'automation', event_type: 'rain_guard_error', severity: 'error',
      actor_id: 'system', channel: 'cron',
      summary: `Rain guard error: ${msg.slice(0, 100)}`, status: 'error',
    });
    res.status(500).json({ error: msg });
  }
});

async function fetchHAHistory(entityId: string, hours: number): Promise<unknown[]> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) throw new Error('HA_URL or HA_TOKEN not configured');

  const end = new Date().toISOString();
  const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const path = `/api/history/period/${start}?end_time=${encodeURIComponent(end)}&minimal_response&filter_entity_id=${entityId}`;
  const url = `${haUrl.replace(/\/$/, '')}${path}`;

  const res = await fetchT(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`HA history request failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
}

function aggregateToDailyAverages(historyPoints: any[]): { date: string; avg: number }[] {
  const buckets: Record<string, number[]> = {};
  for (const point of historyPoints) {
    const state = parseFloat(point.state ?? point.s);
    if (isNaN(state)) continue;
    const ts = point.last_changed ?? point.lu;
    const date = typeof ts === 'number'
      ? new Date(ts * 1000).toISOString().split('T')[0]
      : new Date(ts).toISOString().split('T')[0];
    if (!buckets[date]) buckets[date] = [];
    buckets[date].push(state);
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, values]) => ({
      date,
      avg: Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10,
    }));
}

router.get('/temp-history', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const hours = 30 * 24;
    const [poolHistory, spaHistory] = await Promise.all([
      fetchHAHistory('sensor.pool_temp', hours),
      fetchHAHistory('sensor.spa_temp', hours),
    ]);

    const poolDaily = aggregateToDailyAverages(poolHistory);
    const spaDaily = aggregateToDailyAverages(spaHistory);

    const allDates = new Set([...poolDaily.map(d => d.date), ...spaDaily.map(d => d.date)]);
    const poolMap = new Map(poolDaily.map(d => [d.date, d.avg]));
    const spaMap = new Map(spaDaily.map(d => [d.date, d.avg]));

    const chartData = Array.from(allDates).sort().map(date => ({
      date,
      pool: poolMap.get(date) ?? null,
      spa: spaMap.get(date) ?? null,
    }));

    res.json({ success: true, data: chartData });
  } catch (err) {
    console.error('temp-history error:', err);
    res.status(500).json({ success: false, ...safeErrorJson(err) });
  }
});

const POOL_TEMP_THRESHOLD = 82;
const POOL_TEMP_COOLDOWN_MS = 4 * 60 * 60 * 1000;

async function fetchCurrentPoolTemp(): Promise<number | null> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) throw new Error('HA_URL or HA_TOKEN not configured');

  const url = `${haUrl.replace(/\/$/, '')}/api/states/sensor.pool_temp`;
  const res = await fetchT(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`HA state request failed (${res.status})`);
  const data = await res.json() as Record<string, any>;
  const val = parseFloat(data.state);
  if (isNaN(val)) return null;
  return val;
}

router.post('/temp-monitor', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    let automationId: string | null = null;
    const { rows: automations } = await query<AutomationStatusRow>(
      `SELECT id, is_active FROM family_automations WHERE name = $1 LIMIT 1`,
      ['Pool Temp Monitor']
    );
    if (automations.length > 0) {
      if (!automations[0].is_active) {
        res.json({ skipped: true, reason: 'Automation is disabled' });
        return;
      }
      automationId = automations[0].id;
    }

    const currentTemp = await fetchCurrentPoolTemp();
    const belowThreshold = currentTemp !== null && currentTemp < POOL_TEMP_THRESHOLD;

    let alertResult: Awaited<ReturnType<typeof sendMonitorAlert>> | null = null;
    if (belowThreshold) {
      const alertPhone = await getAlertPhoneNumber();
      alertResult = await sendMonitorAlert({
        recipients: [
          { email: 'staff2@example.com' },
          { email: 'staff@example.com' },
          { email: 'admin@example.com', whatsapp: alertPhone },
        ],
        subject: `🏊 Pool Temperature Alert — ${currentTemp}°F`,
        body: `The pool temperature has dropped to ${currentTemp}°F, which is below the ${POOL_TEMP_THRESHOLD}°F threshold.\n\nPlease check the pool heater.\n\n— Janus`,
        channels: ['email', 'whatsapp'],
        cooldownKey: 'pool-temp-monitor',
        cooldownMs: POOL_TEMP_COOLDOWN_MS,
        auditEdgeFunction: 'pool-temp-monitor',
      });
    }

    const output: Record<string, unknown> = {
      currentTemp,
      threshold: POOL_TEMP_THRESHOLD,
      belowThreshold,
      alertSent: alertResult?.sent ?? false,
      cooldownActive: alertResult?.cooldownActive ?? false,
    };

    if (belowThreshold) {
      try {
        const { fetchTroubleshootingAdvice } = await import('../services/perplexity.js');
        const advice = await fetchTroubleshootingAdvice('Pool heater', `Pool temperature dropped to ${currentTemp}°F, below the ${POOL_TEMP_THRESHOLD}°F threshold`);
        if (advice && advice.length > 20) output.troubleshooting_advice = advice;
      } catch (e) {
        console.error('[Pool] Perplexity troubleshooting failed:', e);
      }
    }

    console.log('pool-temp-monitor result:', JSON.stringify(output));

    if (automationId) {
      const now = new Date().toISOString();
      await query(
        `INSERT INTO family_automation_logs (automation_id, status, output, started_at, completed_at) VALUES ($1, $2, $3, $4, $5)`,
        [automationId, 'success', JSON.stringify(output), now, now]
      );
      await query(`UPDATE family_automations SET last_run_at = $1 WHERE id = $2`, [now, automationId]);
    }

    logAudit('pool-temp-monitor', {
      category: 'automation',
      event_type: 'pool_temp_check',
      severity: belowThreshold ? 'warning' : 'info',
      actor_id: 'system',
      actor_name: 'Cron',
      channel: 'cron',
      summary: `Pool temp: ${currentTemp}°F (threshold: ${POOL_TEMP_THRESHOLD}°F)`,
      detail: output,
      status: 'success',
    });

    res.json(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('pool-temp-monitor error:', msg);
    logAudit('pool-temp-monitor', {
      category: 'automation',
      event_type: 'pool_temp_check_error',
      severity: 'error',
      actor_id: 'system',
      channel: 'cron',
      summary: `Pool temp monitor error: ${msg.slice(0, 100)}`,
      status: 'error',
    });
    res.status(500).json({ success: false, ...safeErrorJson(err) });
  }
});

async function fetchSpaPumpState(): Promise<{ state: string; last_changed: string } | null> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) throw new Error('HA_URL or HA_TOKEN not configured');

  const url = `${haUrl.replace(/\/$/, '')}/api/states/switch.spa_pump`;
  const res = await fetchT(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${haToken}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`HA state request failed (${res.status})`);
  const data = await res.json() as Record<string, unknown>;
  if (!data || typeof data.state !== 'string') return null;
  return {
    state: data.state,
    last_changed: typeof data.last_changed === 'string' ? data.last_changed : '',
  };
}

router.post('/spa-mode-monitor', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    let automationId: string | null = null;
    const { rows: automations } = await query<AutomationStatusRow>(
      `SELECT id, is_active FROM family_automations WHERE name = $1 LIMIT 1`,
      ['Spa Mode 12 Hour Alert']
    );
    if (automations.length > 0) {
      if (!automations[0].is_active) {
        res.json({ skipped: true, reason: 'Automation is disabled' });
        return;
      }
      automationId = automations[0].id;
    }

    const spaState = await fetchSpaPumpState();
    if (!spaState) {
      res.status(500).json({ success: false, error: 'Could not fetch Spa Pump state from HA' });
      return;
    }

    const isSpaOn = spaState.state === 'on';
    let durationHours = 0;
    let alertSent = false;
    let cooldownActive = false;
    let alertResult: Awaited<ReturnType<typeof sendMonitorAlert>> | null = null;

    if (isSpaOn && spaState.last_changed) {
      const lastChanged = new Date(spaState.last_changed);
      const durationMs = Date.now() - lastChanged.getTime();
      durationHours = durationMs / (1000 * 60 * 60);

      if (durationHours > 12) {
        const alertPhone = await getAlertPhoneNumber();
        alertResult = await sendMonitorAlert({
          recipients: [
            { email: 'staff2@example.com' },
            { email: 'staff@example.com' },
            { email: 'admin@example.com', whatsapp: alertPhone },
          ],
          subject: `♨️ Spa Mode 12 Hour Alert`,
          body: `The Pool has been left on SPA mode for ${durationHours.toFixed(1)} hours (since ${lastChanged.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} on ${lastChanged.toLocaleDateString()}).\n\nPlease verify if this is intentional and turn it off if not needed.\n\n— Janus`,
          channels: ['email'],
          cooldownKey: 'spa-mode-12h-alert',
          cooldownMs: 4 * 60 * 60 * 1000, // 4 hours cooldown
          auditEdgeFunction: 'spa-mode-monitor',
        });
        alertSent = alertResult?.sent ?? false;
        cooldownActive = alertResult?.cooldownActive ?? false;
      }
    }

    const output: Record<string, unknown> = {
      spaPumpState: spaState.state,
      lastChanged: spaState.last_changed,
      durationHours,
      alertTriggered: isSpaOn && durationHours > 12,
      alertSent,
      cooldownActive,
    };

    console.log('spa-mode-monitor result:', JSON.stringify(output));

    if (automationId) {
      const now = new Date().toISOString();
      await query(
        `INSERT INTO family_automation_logs (automation_id, status, output, started_at, completed_at) VALUES ($1, $2, $3, $4, $5)`,
        [automationId, 'success', JSON.stringify(output), now, now]
      );
      await query(`UPDATE family_automations SET last_run_at = $1 WHERE id = $2`, [now, automationId]);
    }

    logAudit('spa-mode-monitor', {
      category: 'automation',
      event_type: 'spa_mode_check',
      severity: (isSpaOn && durationHours > 12) ? 'warning' : 'info',
      actor_id: 'system',
      actor_name: 'Cron',
      channel: 'cron',
      summary: isSpaOn
        ? `Spa Pump is ON for ${durationHours.toFixed(1)} hours`
        : 'Spa Pump is OFF',
      detail: output,
      status: 'success',
    });

    res.json(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('spa-mode-monitor error:', msg);
    logAudit('spa-mode-monitor', {
      category: 'automation',
      event_type: 'spa_mode_check_error',
      severity: 'error',
      actor_id: 'system',
      channel: 'cron',
      summary: `Spa mode monitor error: ${msg.slice(0, 100)}`,
      status: 'error',
    });
    res.status(500).json({ success: false, ...safeErrorJson(err) });
  }
});

export default router;
