import { Router, type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { storage } from '../storage';
import { logAudit } from '../lib/auditLog.js';
import { sendWhatsApp } from '../lib/helpers.js';
import {
  GYM_SCHEDULE,
  THEATER_SCHEDULE,
  GYM_HEAT_TEMP,
  GYM_COOL_TEMP,
  THEATER_HEAT_TEMP,
  THEATER_COOL_TEMP,
  isWithinSchedule,
  isWithinScheduleStartGrace,
} from '../../shared/scheduleWindows';
import { WORKFLOW_RULES } from '../../shared/workflowRules.js';
import { getEntityCache, isCacheReady } from '../lib/haWebSocket.js';
import { backfillFromDeviceTrackers, unknownDevices } from '../lib/network-devices.js';
import {
  AV_CLOSET_WARN_TEMP,
  AV_CLOSET_CRITICAL_TEMP,
  findAvClosetTempSensor,
} from '../../shared/avCloset.js';
import { getAvClosetReading } from '../services/govee.js';
import type { CreatedAtRow } from '../../shared/dbRows.js';

const execFileAsync = promisify(execFile);

const router = Router();

// ── Google Assistant SDK Health Monitor ─────────────────────────────────────
// Probes HA's google_assistant_sdk.send_text_command service with a no-op
// command every 15 min (see cron.ts). Alerts via WhatsApp if the integration
// is down, with a 6-hour dedup window so you don't get spammed.

const GA_SDK_DEDUP_HOURS = 6;
const GA_SDK_AUDIT_KEY = 'google_assistant_sdk_down';

async function probeGoogleAssistantSDK(): Promise<{ ok: boolean; status: number | null; error?: string; skipped?: boolean; skipReason?: string }> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) return { ok: false, status: null, error: 'HA_URL or HA_TOKEN not configured' };

  // Skip the probe entirely when any media player is actively playing. Even the inert
  // 'what time is it' query makes Google Assistant speak aloud on the Nest speakers, which
  // would interrupt/annoy anyone listening to music. We read the live HA entity cache
  // (kept fresh over the WebSocket) for any media_player.* in the 'playing' state.
  if (isCacheReady()) {
    const playing = getEntityCache().find(
      e => e.entity_id.startsWith('media_player.') && e.state === 'playing',
    );
    if (playing) {
      return { ok: true, status: null, skipped: true, skipReason: `${playing.entity_id} is playing` };
    }
  }

  // Use an inert read-only query so the probe exercises the full integration path without
  // issuing a media-control verb. 'cancel' and 'stop' are interpreted by Google Assistant
  // as account-wide "stop whatever is playing" commands, which pauses music on any active
  // Nest speaker/display. 'what time is it' returns a benign response and does not affect playback.
  const url = `${haUrl.replace(/\/$/, '')}/api/services/google_assistant_sdk/send_text_command`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'what time is it' }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { ok: res.status < 400, status: res.status };
  } catch (e: any) {
    clearTimeout(timer);
    return { ok: false, status: null, error: e.message || String(e) };
  }
}

router.post('/api/google-assistant-sdk-monitor', requireAuth, async (req: any, res: any) => {
  const db = storage;
  try {
    if (!isHAConfigured()) {
      console.log('[GA SDK Monitor] Home Assistant not configured — skipping probe.');
      return res.json({ skipped: true, reason: 'Home Assistant not configured' });
    }
    const probe = await probeGoogleAssistantSDK();

    if (probe.skipped) {
      // A media player is actively playing — skip the probe to avoid the spoken
      // GA response interrupting playback. Record it so health history stays interpretable.
      await logAudit('google-assistant-sdk-monitor', {
        category: 'home',
        event_type: 'google_assistant_sdk_health_check',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'GA SDK Monitor',
        channel: 'cron',
        summary: `Google Assistant SDK probe skipped — media is playing (${probe.skipReason})`,
        detail: { skipped: true, skip_reason: probe.skipReason ?? null },
        status: 'success',
      });
      return res.json({ skipped: true, reason: probe.skipReason });
    }

    const statusText = probe.ok
      ? `OK (HTTP ${probe.status})`
      : probe.status
        ? `FAILED (HTTP ${probe.status})`
        : `FAILED (${probe.error || 'no response'})`;

    await logAudit('google-assistant-sdk-monitor', {
      category: 'home',
      event_type: 'google_assistant_sdk_health_check',
      severity: probe.ok ? 'info' : 'error',
      actor_id: 'system',
      actor_name: 'GA SDK Monitor',
      channel: 'cron',
      summary: probe.ok
        ? `Google Assistant SDK healthy — ${statusText}`
        : `⚠️ Google Assistant SDK DOWN — ${statusText}. Sauna control & automation will fail.`,
      detail: { status: probe.status, error: probe.error ?? null },
      status: probe.ok ? 'success' : 'error',
    });

    if (!probe.ok) {
      // Dedup: only alert once per GA_SDK_DEDUP_HOURS
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log
         WHERE event_type = $1
           AND detail->>'alert_key' = $2
           AND created_at > NOW() - INTERVAL '${GA_SDK_DEDUP_HOURS} hours'
         LIMIT 1`,
        ['google_assistant_sdk_alert', GA_SDK_AUDIT_KEY]
      );

      if (recent.length === 0) {
        // Log the dedup-gated alert entry
        await logAudit('google-assistant-sdk-monitor', {
          category: 'home',
          event_type: 'google_assistant_sdk_alert',
          severity: 'critical',
          actor_id: 'system',
          actor_name: 'GA SDK Monitor',
          channel: 'cron',
          summary: `🚨 Google Assistant SDK disconnected — Google Home voice commands unavailable`,
          detail: { alert_key: GA_SDK_AUDIT_KEY, status: probe.status, error: probe.error ?? null },
          status: 'error',
        });

        // Send WhatsApp
        const msg =
          `🚨 *Google Assistant SDK Alert*\n\n` +
          `The Google Assistant SDK integration in Home Assistant is *DOWN*.\n\n` +
          `*Impact:* Google Home voice commands and any HA automations using 'send_text_command' will not work.\n` +
          `Note: Sauna control is *not affected* — it uses HA helpers directly (input_boolean/input_number).\n\n` +
          `*Error:* ${statusText}\n\n` +
          `*Fix:* Home Assistant → Settings → Integrations → Google Assistant SDK → Reconfigure/Reauthenticate.\n\n` +
          `http://homeassistant.local:8123/config/integrations`;

        try {
          await sendWhatsApp(msg);
          console.log('[GA SDK Monitor] WhatsApp alert sent.');
        } catch (e: any) {
          console.error('[GA SDK Monitor] WhatsApp send failed:', e.message);
        }
      } else {
        console.log('[GA SDK Monitor] GA SDK down but alert already sent within dedup window — skipping WhatsApp.');
      }
    }

    res.json({ ok: probe.ok, status: probe.status, error: probe.error ?? null });
  } catch (err: any) {
    console.error('[google-assistant-sdk-monitor] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

function fetchT(input: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input as any, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const SPEEDTEST_ENTITIES = {
  download: 'sensor.speedtest_download',
  upload: 'sensor.speedtest_upload',
  ping: 'sensor.speedtest_ping',
};

const FORTIGATE_WAN_ENTITIES = ['sensor.fortigate_wan_status', 'sensor.fortigate_wan1_status', 'sensor.fortinet_wan_status'];

const INTERNET_THRESHOLDS = {
  download_degraded: 100, download_critical: 25,
  upload_degraded: 30, upload_critical: 10,
  ping_degraded: 50, ping_critical: 150,
};

const DEDUP_MINUTES = 60;

const PRINTERS = [
  {
    name: "Sandra's Office",
    statusEntity: 'sensor.hp_color_laserjet_pro_mfp_3301_2',
    cartridges: [
      { color: 'Black', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_black_cartridge_2' },
      { color: 'Cyan', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_cyan_cartridge_2' },
      { color: 'Magenta', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_magenta_cartridge_2' },
      { color: 'Yellow', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_yellow_cartridge_2' },
    ],
  },
  {
    name: 'TigerDen',
    statusEntity: 'sensor.hp_color_laserjet_pro_mfp_3301',
    cartridges: [
      { color: 'Black', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_black_cartridge' },
      { color: 'Cyan', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_cyan_cartridge' },
      { color: 'Magenta', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_magenta_cartridge' },
      { color: 'Yellow', entity: 'sensor.hp_color_laserjet_pro_mfp_3301_yellow_cartridge' },
    ],
  },
  {
    name: "Tony's Office Printer",
    statusEntity: 'sensor.hl_l2460dw_status',
    cartridges: [
      { color: 'Black', entity: 'sensor.hl_l2460dw_black_toner_remaining' },
    ],
    drumEntity: 'sensor.hl_l2460dw_drum_remaining',
  },
];

const BAMBU_STATUS_SUFFIXES = ['print_status', 'current_stage', 'status'];
const BAMBU_ERROR_STATES = ['error', 'failed', 'fault'];
const BAMBU_TEMP_SUFFIXES = { nozzle: ['nozzle_temperature', 'nozzle_temp'], bed: ['bed_temperature', 'bed_temp'] };
const BAMBU_NOZZLE_MAX = 300;
const BAMBU_BED_MAX = 120;
const TONER_THRESHOLD = 10;

const HA_ENTITIES = {
  cpu: 'sensor.system_monitor_processor_use',
  ram: 'sensor.system_monitor_memory_usage',
  swap: 'sensor.system_monitor_swap_usage',
  load: 'sensor.system_monitor_load_1_min',
  temp: 'sensor.system_monitor_processor_temperature',
};

const CPU_SUSTAINED = 85;
const RAM_SUSTAINED = 90;
const CRITICAL_THRESHOLD = 95;
const SUSTAINED_COUNT = 3;
const COOLDOWN_MS = 60 * 60 * 1000;

function isHAConfigured(): boolean {
  return !!(process.env.HA_URL || process.env.HOME_ASSISTANT_URL) && !!(process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN);
}

async function callHAProxy(body: Record<string, unknown>) {
  const haUrl = process.env.HA_URL || process.env.HOME_ASSISTANT_URL;
  const haToken = process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN;
  if (!haUrl || !haToken) throw new Error('Home Assistant not configured');
  if (body.action === 'get-states') {
    const r = await fetchT(`${haUrl}/api/states`, { headers: { Authorization: `Bearer ${haToken}` } });
    if (!r.ok) throw new Error(`HA returned ${r.status}`);
    return r.json();
  }
  throw new Error(`Unknown HA action: ${body.action}`);
}

async function logRun(db: any, automationId: string, status: string, output: Record<string, unknown>, errorMessage?: string) {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO family_automation_logs (automation_id, status, output, error_message, started_at, completed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [automationId, status, JSON.stringify(output), errorMessage || null, now, now]
  );
  await db.query(`UPDATE family_automations SET last_run_at = $1 WHERE id = $2`, [now, automationId]);
}

router.post('/api/internet-health-monitor', requireAuth, async (req: any, res: any) => {
  try {
    const db = storage;
    const { rows: [automation] } = await db.query(`SELECT id, is_active FROM family_automations WHERE name = 'Internet Health Monitor' LIMIT 1`);
    if (!automation) return res.status(404).json({ error: 'Automation not found in DB' });
    if (!automation.is_active) return res.json({ skipped: true, reason: 'Automation is disabled' });
    if (!isHAConfigured()) {
      console.log('[internet-health-monitor] Home Assistant not configured — skipping.');
      return res.json({ skipped: true, reason: 'Home Assistant not configured' });
    }

    const allStates = await callHAProxy({ action: 'get-states' });
    const states: Record<string, any> = {};
    if (Array.isArray(allStates)) { for (const s of allStates) states[s.entity_id] = { state: s.state, attributes: s.attributes || {} }; }

    const wanEntity = FORTIGATE_WAN_ENTITIES.find(e => states[e]);
    const wanState = wanEntity ? states[wanEntity].state : null;
    const wanAttributes = wanEntity ? (states[wanEntity].attributes || {}) : {};
    const download = states[SPEEDTEST_ENTITIES.download] ? parseFloat(states[SPEEDTEST_ENTITIES.download].state) : NaN;
    const upload = states[SPEEDTEST_ENTITIES.upload] ? parseFloat(states[SPEEDTEST_ENTITIES.upload].state) : NaN;
    const ping = states[SPEEDTEST_ENTITIES.ping] ? parseFloat(states[SPEEDTEST_ENTITIES.ping].state) : NaN;

    const wanTraffic: Record<string, unknown> = {};
    const rxBytes = wanAttributes.rx_bytes ?? wanAttributes.wan_rx_bytes ?? wanAttributes.bytes_recv ?? null;
    const txBytes = wanAttributes.tx_bytes ?? wanAttributes.wan_tx_bytes ?? wanAttributes.bytes_sent ?? null;
    const wanSpeed = wanAttributes.wan_speed ?? wanAttributes.speed ?? null;
    const ipsAnomalies = wanAttributes.ips_anomalies ?? wanAttributes.anomaly_count ?? null;
    if (rxBytes != null) wanTraffic.rx_bytes = rxBytes;
    if (txBytes != null) wanTraffic.tx_bytes = txBytes;
    if (wanSpeed != null) wanTraffic.wan_speed = wanSpeed;
    if (ipsAnomalies != null) wanTraffic.ips_anomalies = ipsAnomalies;

    const issues: any[] = [];
    if (wanState && ['down', 'offline'].includes(wanState.toLowerCase())) {
      issues.push({ key: 'wan_down', type: 'wan_down', detail: `WAN status is ${wanState}`, priority: 'High' });
    }
    if (!isNaN(download)) {
      if (download < INTERNET_THRESHOLDS.download_critical) issues.push({ key: 'download_critical', type: 'speed_critical', detail: `Download critically low: ${download.toFixed(1)} Mbps`, priority: 'High' });
      else if (download < INTERNET_THRESHOLDS.download_degraded) issues.push({ key: 'download_degraded', type: 'speed_degraded', detail: `Download degraded: ${download.toFixed(1)} Mbps`, priority: 'Medium' });
    }
    if (!isNaN(upload)) {
      if (upload < INTERNET_THRESHOLDS.upload_critical) issues.push({ key: 'upload_critical', type: 'speed_critical', detail: `Upload critically low: ${upload.toFixed(1)} Mbps`, priority: 'High' });
      else if (upload < INTERNET_THRESHOLDS.upload_degraded) issues.push({ key: 'upload_degraded', type: 'speed_degraded', detail: `Upload degraded: ${upload.toFixed(1)} Mbps`, priority: 'Medium' });
    }
    if (!isNaN(ping)) {
      if (ping > INTERNET_THRESHOLDS.ping_critical) issues.push({ key: 'ping_critical', type: 'high_ping', detail: `Ping critically high: ${ping.toFixed(1)} ms`, priority: 'High' });
      else if (ping > INTERNET_THRESHOLDS.ping_degraded) issues.push({ key: 'ping_degraded', type: 'high_ping', detail: `Ping elevated: ${ping.toFixed(1)} ms`, priority: 'Medium' });
    }

    const output: Record<string, any> = {
      speedtest: { download: isNaN(download) ? null : download, upload: isNaN(upload) ? null : upload, ping: isNaN(ping) ? null : ping },
      wan: { entity: wanEntity ?? null, status: wanState ?? null, ...(Object.keys(wanTraffic).length > 0 ? { traffic: wanTraffic } : {}) },
      issues_detected: issues.map(i => i.key),
      issues_reported: issues.map(i => i.key),
    };
    if (issues.length > 0) {
      try {
        const { fetchTroubleshootingAdvice } = await import('../services/perplexity.js');
        const issueDetails = issues.map(i => i.detail).join('; ');
        const advice = await fetchTroubleshootingAdvice('Network/Internet', issueDetails);
        if (advice && advice.length > 20) output.troubleshooting_advice = advice;
      } catch (e) {
        console.error('[Monitoring] Perplexity internet troubleshooting failed:', e);
      }
    }
    await logRun(db, automation.id, 'success', output);

    const issueCount = issues.length;
    const severity = issueCount === 0 ? 'info' : issues.some(i => i.priority === 'High') ? 'error' : 'warn';
    const summaryParts: string[] = [];
    if (!isNaN(download)) summaryParts.push(`DL ${download.toFixed(1)} Mbps`);
    if (!isNaN(upload)) summaryParts.push(`UL ${upload.toFixed(1)} Mbps`);
    if (!isNaN(ping)) summaryParts.push(`Ping ${ping.toFixed(1)} ms`);
    const summary = issueCount === 0
      ? `Healthy — ${summaryParts.join(', ')}`
      : `${issueCount} issue(s) — ${summaryParts.join(', ')}`;

    await logAudit('internet-health-monitor', {
      category: 'automation',
      event_type: 'internet_health_check',
      severity,
      actor_id: 'system',
      actor_name: 'Internet Health Monitor',
      channel: 'cron',
      summary,
      detail: output,
    });

    res.json(output);
  } catch (err: any) {
    console.error('internet-health-monitor error:', err.message);
    await logAudit('internet-health-monitor', {
      category: 'automation',
      event_type: 'internet_health_check',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'Internet Health Monitor',
      channel: 'cron',
      summary: `Error: ${err.message}`,
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * Pull-side speed-test ingest. Reads the three speedtest.net sensors
 * directly from Home Assistant and writes a speed_tests row when the
 * sensor's last_changed is newer than the most recent stored row. Runs
 * every 15 min from cron and replaces the brittle HA-side automation
 * that used to push to /api/speedtest-ingest — the HA automation can
 * be deleted, disabled, or its webhook URL can rot without anyone
 * noticing (which is exactly how we ended up with an empty table).
 *
 * Idempotent: if HA's sensor hasn't refreshed since our last insert,
 * the call is a no-op. Returns { inserted: bool, reason, age_minutes }.
 */
router.post('/api/speedtest-pull-from-ha', requireAuth, async (req: any, res: any) => {
  try {
    const allStates = await callHAProxy({ action: 'get-states' });
    const states: Record<string, any> = {};
    if (Array.isArray(allStates)) {
      for (const s of allStates) states[s.entity_id] = s;
    }
    const dl = states[SPEEDTEST_ENTITIES.download];
    const ul = states[SPEEDTEST_ENTITIES.upload];
    const pg = states[SPEEDTEST_ENTITIES.ping];
    if (!dl || !ul || !pg) {
      return res.status(503).json({
        skipped: true,
        reason: 'ha_speedtest_sensors_missing',
        missing: [
          !dl ? SPEEDTEST_ENTITIES.download : null,
          !ul ? SPEEDTEST_ENTITIES.upload : null,
          !pg ? SPEEDTEST_ENTITIES.ping : null,
        ].filter(Boolean),
      });
    }

    const download = parseFloat(dl.state);
    const upload = parseFloat(ul.state);
    const latency = parseFloat(pg.state);
    if (!Number.isFinite(download) || download <= 0 || !Number.isFinite(upload) || !Number.isFinite(latency)) {
      return res.json({
        skipped: true,
        reason: 'ha_sensors_unavailable',
        sensors: { download: dl.state, upload: ul.state, ping: pg.state },
      });
    }

    // The freshest sensor's last_changed is the canonical "when this
    // speed test ran" timestamp.
    const lastChangedTimes = [dl.last_changed, ul.last_changed, pg.last_changed]
      .map((t) => (t ? new Date(t).getTime() : NaN))
      .filter((t) => Number.isFinite(t));
    const sensorRunAt = lastChangedTimes.length > 0 ? new Date(Math.max(...lastChangedTimes)) : new Date();

    const db = storage;
    const { rows: latestRows } = await db.query(
      `SELECT MAX(tested_at) AS latest FROM speed_tests WHERE provider = $1`,
      ['spectrum'],
    );
    const latestStored: Date | null = latestRows[0]?.latest ?? null;
    if (latestStored && sensorRunAt.getTime() <= new Date(latestStored).getTime()) {
      return res.json({
        skipped: true,
        reason: 'no_new_sensor_data',
        sensor_run_at: sensorRunAt.toISOString(),
        latest_stored_at: new Date(latestStored).toISOString(),
      });
    }

    const { rows } = await db.query(
      `INSERT INTO speed_tests (provider, download_mbps, upload_mbps, latency_ms, server_name, tested_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      ['spectrum', download, upload, latency, 'home-assistant-pull', sensorRunAt.toISOString()],
    );

    await logAudit('speedtest-pull-from-ha', {
      category: 'automation', event_type: 'speedtest_recorded', severity: 'info',
      actor_id: 'system', channel: 'cron',
      summary: `Speed test pulled from HA: ${download.toFixed(0)}↓ ${upload.toFixed(0)}↑ Mbps, ${latency.toFixed(0)}ms ping`,
      detail: {
        provider: 'spectrum',
        download_mbps: download,
        upload_mbps: upload,
        latency_ms: latency,
        source: 'ha_pull',
        sensor_run_at: sensorRunAt.toISOString(),
        record_id: rows?.[0]?.id,
      },
      status: 'success',
    });

    res.json({
      inserted: true,
      id: rows?.[0]?.id,
      sensor_run_at: sensorRunAt.toISOString(),
      recorded: { provider: 'spectrum', download_mbps: download, upload_mbps: upload, latency_ms: latency },
    });
  } catch (err: any) {
    console.error('[speedtest-pull-from-ha] error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/speedtest-ingest', async (req: any, res: any) => {
  try {
    const body = req.body;
    const download = parseFloat(body.download_mbps ?? body.download ?? 0);
    const upload = parseFloat(body.upload_mbps ?? body.upload ?? 0);
    const latency = parseFloat(body.latency_ms ?? body.ping ?? body.latency ?? 0);
    const jitter = body.jitter_ms != null ? parseFloat(body.jitter_ms) : (body.jitter != null ? parseFloat(body.jitter) : null);
    const serverName = body.server_name ?? body.server ?? null;
    const provider = body.provider ?? 'spectrum';

    if (isNaN(download) || isNaN(upload) || isNaN(latency) || download <= 0) {
      return res.status(400).json({ error: 'Invalid speed test data. Required: download_mbps, upload_mbps, latency_ms' });
    }

    const db = storage;
    const { rows } = await db.query(
      `INSERT INTO speed_tests (provider, download_mbps, upload_mbps, latency_ms, jitter_ms, server_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [provider, download, upload, latency, jitter, serverName]
    );

    const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
    logAudit('speedtest-ingest', {
      category: 'automation', event_type: 'speedtest_recorded', severity: 'info',
      actor_id: 'system', channel: 'api',
      summary: `Speed test recorded: ${download.toFixed(0)}↓ ${upload.toFixed(0)}↑ Mbps, ${latency.toFixed(0)}ms ping via ${providerLabel}`,
      detail: {
        provider,
        download_mbps: download,
        upload_mbps: upload,
        latency_ms: latency,
        ...(jitter != null ? { jitter_ms: jitter } : {}),
        ...(serverName ? { server_name: serverName } : {}),
        record_id: rows?.[0]?.id,
      },
      status: 'success',
    });

    res.json({ success: true, id: rows?.[0]?.id, recorded: { provider, download_mbps: download, upload_mbps: upload, latency_ms: latency } });
  } catch (err: any) {
    console.error('speedtest-ingest error:', err);
    res.status(500).json({ error: err.message });
  }
});

function buildIssueKey(printer: string, type: string, detail: string): string {
  return `${type}_${detail.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${printer.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

router.post('/api/printer-health-monitor', requireAuth, async (req: any, res: any) => {
  try {
    const db = storage;
    const { rows: [automation] } = await db.query(`SELECT id, is_active FROM family_automations WHERE name = 'Printer Health Monitor' LIMIT 1`);
    if (!automation) return res.status(404).json({ error: 'Automation not found in DB' });
    if (!automation.is_active) return res.json({ skipped: true, reason: 'Automation is disabled' });
    if (!isHAConfigured()) {
      console.log('[printer-health-monitor] Home Assistant not configured — skipping.');
      return res.json({ skipped: true, reason: 'Home Assistant not configured' });
    }

    const allStates = await callHAProxy({ action: 'get-states' });
    const states: Record<string, any> = {};
    if (Array.isArray(allStates)) { for (const s of allStates) states[s.entity_id] = { state: s.state, attributes: s.attributes || {} }; }

    const issues: any[] = [];
    const printerSummaries: any[] = [];

    for (const printer of PRINTERS) {
      const statusVal = states[printer.statusEntity]?.state ?? 'unavailable';
      const isNotConnected = statusVal === 'unavailable' || statusVal === 'unknown';
      const cartridgeLevels: Record<string, number> = {};
      if (!isNotConnected) {
        for (const cart of printer.cartridges) {
          const level = states[cart.entity]?.state ? parseInt(states[cart.entity].state, 10) : NaN;
          cartridgeLevels[cart.color] = isNaN(level) ? -1 : level;
          if (!isNaN(level) && level < TONER_THRESHOLD) {
            issues.push({ key: buildIssueKey(printer.name, 'low_toner', cart.color), printer: printer.name, type: 'low_toner', detail: `${cart.color} toner at ${level}%`, priority: 'Medium' });
          }
        }
        if ((printer as any).drumEntity) {
          const drumLevel = states[(printer as any).drumEntity]?.state ? parseInt(states[(printer as any).drumEntity].state, 10) : NaN;
          cartridgeLevels['Drum'] = isNaN(drumLevel) ? -1 : drumLevel;
          if (!isNaN(drumLevel) && drumLevel < TONER_THRESHOLD) {
            issues.push({ key: buildIssueKey(printer.name, 'low_drum', 'drum'), printer: printer.name, type: 'low_drum', detail: `Drum life at ${drumLevel}%`, priority: 'Medium' });
          }
        }
        if (!['idle', 'printing'].includes(statusVal.toLowerCase())) {
          issues.push({ key: buildIssueKey(printer.name, 'status_error', statusVal), printer: printer.name, type: 'status_error', detail: `Printer status: ${statusVal}`, priority: 'High' });
        }
      }
      printerSummaries.push({ name: printer.name, type: 'office', status: statusVal, cartridges: cartridgeLevels });
    }

    const BAMBU_SIGNATURE_SUFFIXES = ['print_status', 'current_stage', 'print_progress', 'print_percentage', 'nozzle_temperature', 'nozzle_temp', 'bed_temperature', 'bed_temp', 'chamber_temperature', 'chamber_temp', 'remaining_time', 'task_name', 'wifi_signal', 'fan_speed', 'hms_errors', 'hms_error'];
    const HP_ENTITY_PREFIXES = ['hp_color_laserjet', 'hl_l2460dw'];
    const bambuPrefixes = new Set<string>();
    for (const eid of Object.keys(states)) {
      for (const suffix of BAMBU_SIGNATURE_SUFFIXES) {
        const match = eid.match(new RegExp(`^sensor\\.(.+?)_${suffix}$`));
        if (match && !HP_ENTITY_PREFIXES.some(hp => match[1].startsWith(hp))) { bambuPrefixes.add(match[1]); break; }
      }
    }

    for (const prefix of bambuPrefixes) {
      const findState = (suffixes: string[]) => { for (const s of suffixes) { const e = states[`sensor.${prefix}_${s}`]; if (e) return e; } return undefined; };
      const statusEntity = findState(BAMBU_STATUS_SUFFIXES);
      const statusVal = statusEntity?.state ?? 'unavailable';
      const printerName = (statusEntity?.attributes?.friendly_name || prefix).replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()).replace(/\s*(Print Status|Current Stage|Status)$/i, '').trim() || `Bambu ${prefix}`;
      const hmsEntity = findState(['hms_errors', 'hms_error']);
      const hmsVal = hmsEntity?.state ?? '';
      const hasHmsError = hmsVal && hmsVal !== 'unavailable' && hmsVal !== 'unknown' && hmsVal !== '0' && hmsVal.toLowerCase() !== 'none' && hmsVal.toLowerCase() !== 'no error';
      if (BAMBU_ERROR_STATES.includes(statusVal.toLowerCase())) {
        issues.push({ key: buildIssueKey(printerName, 'bambu_error', statusVal), printer: printerName, type: 'bambu_error', detail: `3D printer error: ${statusEntity?.attributes?.error_message || statusVal}`, priority: 'High' });
      } else if (hasHmsError) {
        issues.push({ key: buildIssueKey(printerName, 'bambu_hms_error', hmsVal), printer: printerName, type: 'bambu_error', detail: `3D printer HMS error: ${hmsVal}`, priority: 'High' });
      }
      const nozzleTemp = findState(BAMBU_TEMP_SUFFIXES.nozzle) ? parseFloat(findState(BAMBU_TEMP_SUFFIXES.nozzle)!.state) : NaN;
      const bedTemp = findState(BAMBU_TEMP_SUFFIXES.bed) ? parseFloat(findState(BAMBU_TEMP_SUFFIXES.bed)!.state) : NaN;
      if (!isNaN(nozzleTemp) && nozzleTemp > BAMBU_NOZZLE_MAX) issues.push({ key: buildIssueKey(printerName, 'bambu_temp_anomaly', 'nozzle'), printer: printerName, type: 'bambu_temp_anomaly', detail: `Nozzle temp ${nozzleTemp}°C exceeds ${BAMBU_NOZZLE_MAX}°C`, priority: 'High' });
      if (!isNaN(bedTemp) && bedTemp > BAMBU_BED_MAX) issues.push({ key: buildIssueKey(printerName, 'bambu_temp_anomaly', 'bed'), printer: printerName, type: 'bambu_temp_anomaly', detail: `Bed temp ${bedTemp}°C exceeds ${BAMBU_BED_MAX}°C`, priority: 'High' });
      printerSummaries.push({ name: printerName, type: 'bambu', status: statusVal, nozzle_temp: isNaN(nozzleTemp) ? null : nozzleTemp, bed_temp: isNaN(bedTemp) ? null : bedTemp });
    }

    const output: Record<string, any> = { printers: printerSummaries, issues_detected: issues.map(i => i.key), issues_reported: issues.map(i => i.key) };
    if (issues.length > 0) {
      try {
        const { fetchTroubleshootingAdvice } = await import('../services/perplexity.js');
        const issueDetails = issues.map(i => i.detail).join('; ');
        const advice = await fetchTroubleshootingAdvice('Printer', issueDetails);
        if (advice && advice.length > 20) output.troubleshooting_advice = advice;
      } catch (e) {
        console.error('[Monitoring] Perplexity printer troubleshooting failed:', e);
      }
    }
    await logRun(db, automation.id, 'success', output);

    const issueCount = issues.length;
    const printerSeverity = issueCount === 0 ? 'info' : issues.some(i => i.priority === 'High') ? 'error' : 'warn';
    const printerNames = printerSummaries.map(p => p.name).join(', ');
    const printerSummary = issueCount === 0
      ? `All printers healthy — ${printerNames}`
      : `${issueCount} issue(s) across ${printerNames}`;

    await logAudit('printer-health-monitor', {
      category: 'automation',
      event_type: 'printer_health_check',
      severity: printerSeverity,
      actor_id: 'system',
      actor_name: 'Printer Health Monitor',
      channel: 'cron',
      summary: printerSummary,
      detail: output,
    });

    res.json(output);
  } catch (err: any) {
    console.error('printer-health-monitor error:', err.message);
    await logAudit('printer-health-monitor', {
      category: 'automation',
      event_type: 'printer_health_check',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'Printer Health Monitor',
      channel: 'cron',
      summary: `Error: ${err.message}`,
    });
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/ha-server-health-monitor', requireAuth, async (req: any, res: any) => {
  try {
    const db = storage;
    const { rows: [automation] } = await db.query(`SELECT id, is_active FROM family_automations WHERE name = 'HA Server Health Monitor' LIMIT 1`);
    if (!automation) return res.status(404).json({ error: 'Automation not found in DB' });
    if (!automation.is_active) return res.json({ skipped: true, reason: 'Automation is disabled' });
    if (!isHAConfigured()) {
      console.log('[ha-server-health-monitor] Home Assistant not configured — skipping.');
      return res.json({ skipped: true, reason: 'Home Assistant not configured' });
    }

    const allStates = await callHAProxy({ action: 'get-states' });
    const stateMap: Record<string, string> = {};
    if (Array.isArray(allStates)) { for (const s of allStates) stateMap[s.entity_id] = s.state; }

    const parseF = (val: string | undefined) => { if (!val) return NaN; const n = parseFloat(val); return isNaN(n) ? NaN : n; };
    const cpu = parseF(stateMap[HA_ENTITIES.cpu]);
    const ram = parseF(stateMap[HA_ENTITIES.ram]);
    const swap = parseF(stateMap[HA_ENTITIES.swap]);
    const load = parseF(stateMap[HA_ENTITIES.load]);
    const temp = parseF(stateMap[HA_ENTITIES.temp]);
    const metrics = { cpu, ram, swap, load, temp };

    const cpuCritical = !isNaN(cpu) && cpu > CRITICAL_THRESHOLD;
    const ramCritical = !isNaN(ram) && ram > CRITICAL_THRESHOLD;
    const cpuHigh = !isNaN(cpu) && cpu > CPU_SUSTAINED;
    const ramHigh = !isNaN(ram) && ram > RAM_SUSTAINED;

    let consecutiveCpuHigh = cpuHigh ? 1 : 0;
    let consecutiveRamHigh = ramHigh ? 1 : 0;

    if (cpuHigh || ramHigh) {
      const { rows: recentLogs } = await db.query(
        `SELECT output FROM family_automation_logs WHERE automation_id = $1 AND status = 'success' ORDER BY created_at DESC LIMIT $2`,
        [automation.id, SUSTAINED_COUNT]
      );
      if (recentLogs) {
        for (const log of recentLogs) {
          const m = (log.output as any)?.metrics;
          if (!m) break;
          if (cpuHigh && typeof m.cpu === 'number' && m.cpu > CPU_SUSTAINED) consecutiveCpuHigh++;
          else if (cpuHigh) break;
          if (ramHigh && typeof m.ram === 'number' && m.ram > RAM_SUSTAINED) consecutiveRamHigh++;
          else if (ramHigh) break;
        }
      }
    }

    const cpuSustained = consecutiveCpuHigh >= SUSTAINED_COUNT;
    const ramSustained = consecutiveRamHigh >= SUSTAINED_COUNT;
    const shouldAlert = cpuCritical || ramCritical || cpuSustained || ramSustained;

    const isCritical = cpuCritical || ramCritical;
    const output: Record<string, any> = { metrics, cpu_high: cpuHigh, ram_high: ramHigh, consecutive_cpu_high: consecutiveCpuHigh, consecutive_ram_high: consecutiveRamHigh, alert_triggered: shouldAlert, alert_sent: false };

    if (shouldAlert) {
      try {
        const { fetchTroubleshootingAdvice } = await import('../services/perplexity.js');
        const issueDesc = `HA server ${isCritical ? 'critical' : 'sustained'} alert: CPU=${!isNaN(cpu) ? cpu.toFixed(1) + '%' : 'N/A'}, RAM=${!isNaN(ram) ? ram.toFixed(1) + '%' : 'N/A'}, Temp=${!isNaN(temp) ? temp.toFixed(1) + '°C' : 'N/A'}`;
        const advice = await fetchTroubleshootingAdvice('Home Assistant server', issueDesc);
        if (advice && advice.length > 20) {
          output.troubleshooting_advice = advice;
        }
      } catch (e) {
        console.error('[Monitoring] Perplexity troubleshooting advice failed:', e);
      }
    }
    await logRun(db, automation.id, 'success', output);

    const haSeverity = isCritical ? 'error' : shouldAlert ? 'warn' : (cpuHigh || ramHigh) ? 'warn' : 'info';
    const metricParts: string[] = [];
    if (!isNaN(cpu)) metricParts.push(`CPU ${cpu.toFixed(1)}%`);
    if (!isNaN(ram)) metricParts.push(`RAM ${ram.toFixed(1)}%`);
    if (!isNaN(temp)) metricParts.push(`Temp ${temp.toFixed(1)}°C`);
    const haSummary = shouldAlert
      ? `Alert triggered — ${metricParts.join(', ')}`
      : (cpuHigh || ramHigh)
        ? `Degraded — ${metricParts.join(', ')}`
        : `Healthy — ${metricParts.join(', ')}`;

    await logAudit('ha-server-health-monitor', {
      category: 'automation',
      event_type: 'ha_server_health_check',
      severity: haSeverity,
      actor_id: 'system',
      actor_name: 'HA Server Health Monitor',
      channel: 'cron',
      summary: haSummary,
      detail: output,
    });

    res.json(output);
  } catch (err: any) {
    console.error('ha-server-health-monitor error:', err.message);
    await logAudit('ha-server-health-monitor', {
      category: 'automation',
      event_type: 'ha_server_health_check',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'HA Server Health Monitor',
      channel: 'cron',
      summary: `Error: ${err.message}`,
    });
    res.status(500).json({ error: err.message });
  }
});

const FORTIGATE_HEALTH_THRESHOLDS = {
  cpu_warn: 75,
  cpu_critical: 90,
  mem_warn: 80,
  mem_critical: 92,
};

const FG_DEDUP_MINUTES = 30;

async function getFortigateHealth(): Promise<{ cpu: number | null; mem: number | null; sessions: number | null; wanStatus: string | null; wanLink: boolean | null; threatCount: number | null }> {
  // Uses direct Cloudflare Tunnel lib (server/lib/fortigate.ts) instead of old HA WebSocket proxy
  try {
    const { getResourceUsage, getInterfaces, getIpsThreats, isFortigateConfigured } = await import('../lib/fortigate.js');
    if (!isFortigateConfigured()) {
      console.warn('[FG health snapshot] FORTIGATE_API_TOKEN not configured — skipping snapshot');
      return { cpu: null, mem: null, sessions: null, wanStatus: null, wanLink: null, threatCount: null };
    }

    const [resourcesR, interfacesR, threatsR] = await Promise.allSettled([
      getResourceUsage(),
      getInterfaces(),
      getIpsThreats(100),
    ]);

    const cpu = resourcesR.status === 'fulfilled' ? (resourcesR.value.cpu_current ?? null) : null;
    const mem = resourcesR.status === 'fulfilled' ? (resourcesR.value.mem_current ?? null) : null;
    const sessions = resourcesR.status === 'fulfilled' ? (resourcesR.value.session_count ?? null) : null;

    let wanStatus: string | null = null;
    let wanLink: boolean | null = null;
    if (interfacesR.status === 'fulfilled') {
      const wan = interfacesR.value.find(i => i.role === 'wan') ?? interfacesR.value.find(i => /^wan/i.test(i.name));
      if (wan) { wanLink = wan.link; wanStatus = wan.link ? 'up' : 'down'; }
    }

    const threatCount = threatsR.status === 'fulfilled' ? threatsR.value.length : null;

    if (resourcesR.status === 'rejected') console.warn('[FG health snapshot] resources failed:', resourcesR.reason);
    if (interfacesR.status === 'rejected') console.warn('[FG health snapshot] interfaces failed:', interfacesR.reason);
    if (threatsR.status === 'rejected') console.warn('[FG health snapshot] threats failed:', threatsR.reason);

    return { cpu, mem, sessions, wanStatus, wanLink, threatCount };
  } catch (e) {
    console.error('[FG health snapshot] Failed to fetch FortiGate health:', e);
    return { cpu: null, mem: null, sessions: null, wanStatus: null, wanLink: null, threatCount: null };
  }
}

router.post('/api/fortigate-health-snapshot', requireAuth, async (req: any, res: any) => {
  const db = storage;
  try {
    const { cpu, mem, sessions, wanStatus, wanLink, threatCount } = await getFortigateHealth();

    await db.query(
      `INSERT INTO network_health_snapshots (cpu_usage, memory_usage, active_sessions, wan_status, wan_link, threat_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [cpu, mem, sessions, wanStatus, wanLink, threatCount]
    );

    const alerts: string[] = [];

    if (cpu !== null && cpu >= FORTIGATE_HEALTH_THRESHOLDS.cpu_critical) {
      const dedupKey = 'fg_cpu_critical';
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log WHERE event_type = 'network_alert' AND detail->>'alert_key' = $1 AND created_at > NOW() - INTERVAL '${FG_DEDUP_MINUTES} minutes' LIMIT 1`,
        [dedupKey]
      );
      if (recent.length === 0) {
        await logAudit('fortigate-health-monitor', {
          category: 'network',
          event_type: 'network_alert',
          severity: 'error',
          actor_id: 'system',
          actor_name: 'FortiGate Health Monitor',
          channel: 'cron',
          summary: `FortiGate CPU critical: ${cpu.toFixed(0)}% (threshold: ${FORTIGATE_HEALTH_THRESHOLDS.cpu_critical}%)`,
          detail: { alert_key: dedupKey, cpu, threshold: FORTIGATE_HEALTH_THRESHOLDS.cpu_critical },
        });
        alerts.push('cpu_critical');
      }
    } else if (cpu !== null && cpu >= FORTIGATE_HEALTH_THRESHOLDS.cpu_warn) {
      const dedupKey = 'fg_cpu_warn';
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log WHERE event_type = 'network_alert' AND detail->>'alert_key' = $1 AND created_at > NOW() - INTERVAL '${FG_DEDUP_MINUTES} minutes' LIMIT 1`,
        [dedupKey]
      );
      if (recent.length === 0) {
        await logAudit('fortigate-health-monitor', {
          category: 'network',
          event_type: 'network_alert',
          severity: 'warn',
          actor_id: 'system',
          actor_name: 'FortiGate Health Monitor',
          channel: 'cron',
          summary: `FortiGate CPU elevated: ${cpu.toFixed(0)}% (threshold: ${FORTIGATE_HEALTH_THRESHOLDS.cpu_warn}%)`,
          detail: { alert_key: dedupKey, cpu, threshold: FORTIGATE_HEALTH_THRESHOLDS.cpu_warn },
        });
        alerts.push('cpu_warn');
      }
    }

    if (mem !== null && mem >= FORTIGATE_HEALTH_THRESHOLDS.mem_critical) {
      const dedupKey = 'fg_mem_critical';
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log WHERE event_type = 'network_alert' AND detail->>'alert_key' = $1 AND created_at > NOW() - INTERVAL '${FG_DEDUP_MINUTES} minutes' LIMIT 1`,
        [dedupKey]
      );
      if (recent.length === 0) {
        await logAudit('fortigate-health-monitor', {
          category: 'network',
          event_type: 'network_alert',
          severity: 'error',
          actor_id: 'system',
          actor_name: 'FortiGate Health Monitor',
          channel: 'cron',
          summary: `FortiGate memory critical: ${mem.toFixed(0)}% (threshold: ${FORTIGATE_HEALTH_THRESHOLDS.mem_critical}%)`,
          detail: { alert_key: dedupKey, mem, threshold: FORTIGATE_HEALTH_THRESHOLDS.mem_critical },
        });
        alerts.push('mem_critical');
      }
    } else if (mem !== null && mem >= FORTIGATE_HEALTH_THRESHOLDS.mem_warn) {
      const dedupKey = 'fg_mem_warn';
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log WHERE event_type = 'network_alert' AND detail->>'alert_key' = $1 AND created_at > NOW() - INTERVAL '${FG_DEDUP_MINUTES} minutes' LIMIT 1`,
        [dedupKey]
      );
      if (recent.length === 0) {
        await logAudit('fortigate-health-monitor', {
          category: 'network',
          event_type: 'network_alert',
          severity: 'warn',
          actor_id: 'system',
          actor_name: 'FortiGate Health Monitor',
          channel: 'cron',
          summary: `FortiGate memory elevated: ${mem.toFixed(0)}% (threshold: ${FORTIGATE_HEALTH_THRESHOLDS.mem_warn}%)`,
          detail: { alert_key: dedupKey, mem, threshold: FORTIGATE_HEALTH_THRESHOLDS.mem_warn },
        });
        alerts.push('mem_warn');
      }
    }

    if (wanLink === false || wanStatus === 'down') {
      const dedupKey = 'fg_wan_down';
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log WHERE event_type = 'network_alert' AND detail->>'alert_key' = $1 AND created_at > NOW() - INTERVAL '${FG_DEDUP_MINUTES} minutes' LIMIT 1`,
        [dedupKey]
      );
      if (recent.length === 0) {
        await logAudit('fortigate-health-monitor', {
          category: 'network',
          event_type: 'network_alert',
          severity: 'error',
          actor_id: 'system',
          actor_name: 'FortiGate Health Monitor',
          channel: 'cron',
          summary: `WAN link is down`,
          detail: { alert_key: dedupKey, wan_status: wanStatus, wan_link: wanLink },
        });
        alerts.push('wan_down');
      }
    }

    if (threatCount !== null && threatCount > 0) {
      const dedupKey = `fg_threats_${threatCount}`;
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log WHERE event_type = 'network_alert' AND detail->>'alert_key' LIKE 'fg_threats_%' AND created_at > NOW() - INTERVAL '${FG_DEDUP_MINUTES} minutes' LIMIT 1`,
        []
      );
      if (recent.length === 0) {
        await logAudit('fortigate-health-monitor', {
          category: 'network',
          event_type: 'network_alert',
          severity: 'warn',
          actor_id: 'system',
          actor_name: 'FortiGate Health Monitor',
          channel: 'cron',
          summary: `FortiGate IPS detected ${threatCount} threat${threatCount !== 1 ? 's' : ''}`,
          detail: { alert_key: dedupKey, threat_count: threatCount },
        });
        alerts.push('threats_detected');
      }
    }

    await db.query(`DELETE FROM network_health_snapshots WHERE captured_at < NOW() - INTERVAL '7 days'`, []);

    res.json({ success: true, snapshot: { cpu, mem, sessions, wanStatus, wanLink, threatCount }, alerts });
  } catch (err: any) {
    console.error('[fortigate-health-snapshot] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Seed the network_devices inventory from HA device_tracker.* entities.
// FortiGate publishes one tracker per DHCP lease keyed by MAC, so this
// populates the WiFi Clients inventory with MAC + friendly hostname even
// before Ruckus/FortiGate REST device data flows. Cron-triggered every
// 30 min; idempotent (upsert de-dupes on MAC).
router.post('/api/network-device-backfill', requireAuth, async (_req: Request, res: Response) => {
  try {
    if (!isCacheReady()) {
      res.status(503).json({ error: 'ha_cache_not_ready' });
      return;
    }
    const trackers = getEntityCache().filter((e) =>
      e.entity_id.startsWith('device_tracker.'),
    );
    const result = await backfillFromDeviceTrackers(trackers);
    console.log(
      `[network-device-backfill] scanned=${result.scanned} mac=${result.mac_based} upserted=${result.upserted} skipped=${result.named_skipped}`,
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[network-device-backfill] Error:', message);
    res.status(500).json({ error: message });
  }
});

// New-/unknown-device monitor. Flags devices that appeared recently and are
// still unlabeled + untrusted (the "catch weird activity" objective). Emits a
// deduped network_alert per device so it surfaces in the Command Center /
// alert sink alongside FortiGate health alerts. Cron-triggered every 15 min.
router.post('/api/network-new-device-monitor', requireAuth, async (_req: Request, res: Response) => {
  const db = storage;
  try {
    // Devices that were FIRST seen within the last hour and are still unknown.
    const candidates = await unknownDevices(24);
    const newlyAppeared = candidates.filter((d) => {
      const firstSeen = new Date(d.first_seen).getTime();
      return Number.isFinite(firstSeen) && firstSeen > Date.now() - 60 * 60 * 1000;
    });

    const flagged: string[] = [];
    for (const d of newlyAppeared) {
      const dedupKey = `net_new_device_${d.mac_address}`;
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log WHERE event_type = 'network_alert' AND detail->>'alert_key' = $1 AND created_at > NOW() - INTERVAL '${FG_DEDUP_MINUTES} minutes' LIMIT 1`,
        [dedupKey],
      );
      if (recent.length > 0) continue;
      const name = d.label || (d.hostnames?.[0] ?? null) || d.device_vendor || d.mac_address;
      const ssid = d.ssids?.[0] ?? null;
      await logAudit('network-new-device-monitor', {
        category: 'network',
        event_type: 'network_alert',
        severity: 'warn',
        actor_id: 'system',
        actor_name: 'Network New-Device Monitor',
        channel: 'cron',
        summary: `New unknown device on the network: ${name}${ssid ? ` (SSID ${ssid})` : ''}`,
        detail: {
          alert_key: dedupKey,
          mac: d.mac_address,
          vendor: d.device_vendor,
          ssids: d.ssids,
          first_seen: d.first_seen,
        },
      });
      flagged.push(d.mac_address);
    }

    res.json({ ok: true, candidates: newlyAppeared.length, flagged: flagged.length, macs: flagged });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[network-new-device-monitor] Error:', message);
    res.status(500).json({ error: message });
  }
});

router.get('/api/network/health-snapshots', async (req: any, res: any) => {
  try {
    const db = storage;
    const hours = parseInt(req.query.hours as string) || 24;
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    const { rows } = await db.query(
      `SELECT id, captured_at, cpu_usage, memory_usage, active_sessions, wan_status, wan_link, threat_count
       FROM network_health_snapshots
       WHERE captured_at > NOW() - INTERVAL '${hours} hours'
       ORDER BY captured_at ASC
       LIMIT $1`,
      [limit]
    );
    res.json({ snapshots: rows, count: rows.length });
  } catch (err: any) {
    console.error('[network/health-snapshots] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/network/speed-history', async (req: any, res: any) => {
  try {
    const db = storage;
    const hours = parseInt(req.query.hours as string) || 24;
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    const provider = (req.query.provider as string) || null;
    const params: any[] = [limit];
    const providerClause = provider ? `AND provider = $2` : '';
    if (provider) params.push(provider);
    const { rows } = await db.query(
      `SELECT id, provider, download_mbps, upload_mbps, latency_ms, jitter_ms, server_name, tested_at
       FROM speed_tests
       WHERE tested_at > NOW() - INTERVAL '${hours} hours'
       ${providerClause}
       ORDER BY tested_at ASC
       LIMIT $1`,
      params
    );
    res.json({ tests: rows, count: rows.length });
  } catch (err: any) {
    console.error('[network/speed-history] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/network/alerts', async (req: any, res: any) => {
  try {
    const db = storage;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const { rows } = await db.query(
      `SELECT id, created_at, category, event_type, severity, summary, detail, actor_name
       FROM system_audit_log
       WHERE (category = 'network' OR event_type IN ('internet_health_check', 'speedtest_recorded'))
         AND event_type != 'cron_route_triggered'
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ alerts: rows, count: rows.length });
  } catch (err: any) {
    console.error('[network/alerts] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/ha-update-checker', requireAuth, async (req: any, res: any) => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    console.log('[ha-update-checker] SUPABASE_URL/SERVICE_ROLE_KEY not configured — skipping.');
    return res.json({ skipped: true, reason: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured' });
  }

  try {
    const edgeRes = await fetchT(
      `${supabaseUrl}/functions/v1/ha-update-checker`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
        },
        body: JSON.stringify({}),
      },
      60_000,
    );

    const data = await edgeRes.json().catch(() => ({}));

    if (!edgeRes.ok) {
      console.error(`[ha-update-checker] Edge function returned ${edgeRes.status}`, data);
      return res.status(edgeRes.status).json(data);
    }

    console.log(`[ha-update-checker] Edge function completed → updates_found=${(data as any).updates_found ?? 'N/A'}`);
    res.json(data);
  } catch (err: any) {
    console.error('[ha-update-checker] proxy error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Thermostat Monitor ────────────────────────────────────────────────────────
// Polls all HA climate entities every 15 min, logs readings to thermostat_logs,
// and for the Gym entity enforces a 6 AM–3 PM PT schedule.

const GYM_ENTITY_ID = process.env.GYM_THERMOSTAT_ENTITY || 'climate.gym_gym';
const THEATER_ENTITY_ID = process.env.THEATER_THERMOSTAT_ENTITY || 'climate.theater_theater';

const THERMOSTAT_DEDUP_HOURS = 2;
const THEATER_STARTUP_GRACE_MINUTES = 30;
const POOL_SPA_KEYWORDS = ['pool', 'spa'];

function isPoolOrSpa(entityId: string, friendlyName: string): boolean {
  const combined = `${entityId} ${friendlyName}`.toLowerCase();
  return POOL_SPA_KEYWORDS.some(kw => combined.includes(kw));
}

function getGymScheduleState(_nowPT: Date): 'on' | 'off' {
  return isWithinSchedule(GYM_SCHEDULE) ? 'on' : 'off';
}

function getTheaterScheduleState(_nowPT: Date): 'on' | 'off' {
  return isWithinSchedule(THEATER_SCHEDULE) ? 'on' : 'off';
}

interface SetClimateOptions {
  temperature?: number;
  targetTempLow?: number;
  targetTempHigh?: number;
}

async function setHAClimateMode(entityId: string, hvacMode: string, opts: SetClimateOptions | number = {}): Promise<void> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) throw new Error('HA not configured');

  // Backwards-compat: allow passing a bare number for single-setpoint callers
  const options: SetClimateOptions = typeof opts === 'number' ? { temperature: opts } : opts;

  await fetchT(`${haUrl}/api/services/climate/set_hvac_mode`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entity_id: entityId, hvac_mode: hvacMode }),
  });

  const tempBody: Record<string, unknown> = { entity_id: entityId };
  if (options.targetTempLow !== undefined && options.targetTempHigh !== undefined) {
    tempBody.target_temp_low = options.targetTempLow;
    tempBody.target_temp_high = options.targetTempHigh;
  } else if (options.temperature !== undefined) {
    tempBody.temperature = options.temperature;
  } else {
    return;
  }

  await fetchT(`${haUrl}/api/services/climate/set_temperature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(tempBody),
  });
}

router.post('/api/thermostat-monitor', requireAuth, async (req: any, res: any) => {
  try {
    const db = storage;

    if (!isHAConfigured()) {
      console.log('[thermostat-monitor] Home Assistant not configured — skipping.');
      return res.json({ skipped: true, reason: 'Home Assistant not configured' });
    }

    // Fetch all HA states
    const allStates = await callHAProxy({ action: 'get-states' });
    const stateMap: Record<string, any> = {};
    if (Array.isArray(allStates)) {
      for (const s of allStates) stateMap[s.entity_id] = s;
    }

    // Filter climate entities, excluding pool/spa
    const climateEntities = Object.values(stateMap).filter((s: any) => {
      if (!s.entity_id.startsWith('climate.')) return false;
      const fn = s.attributes?.friendly_name ?? '';
      return !isPoolOrSpa(s.entity_id, fn);
    });

    const logged: any[] = [];
    const gymActions: string[] = [];

    // Log all climate readings
    for (const entity of climateEntities) {
      const entityId = entity.entity_id as string;
      const friendlyName = (entity.attributes?.friendly_name ?? entityId) as string;
      const currentTemp = entity.attributes?.current_temperature != null
        ? parseFloat(entity.attributes.current_temperature)
        : null;
      const targetTemp = entity.attributes?.temperature != null
        ? parseFloat(entity.attributes.temperature)
        : null;
      const hvacMode = entity.state as string;
      const hvacAction = (entity.attributes?.hvac_action ?? null) as string | null;

      await db.query(
        `INSERT INTO thermostat_logs (entity_id, friendly_name, current_temperature, target_temperature, hvac_mode, hvac_action)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [entityId, friendlyName, currentTemp, targetTemp, hvacMode, hvacAction]
      );
      logged.push({ entityId, friendlyName, currentTemp, targetTemp, hvacMode });
    }

    // AV Closet — a Govee temperature *sensor* (not a climate entity), logged so it
    // appears alongside the thermostats in the Automations view with both a live
    // reading and 6-hour history. Setpoint/mode/action are null (it's read-only).
    // The value comes DIRECTLY from the Govee Cloud API (HA's Govee integration
    // double-converts °F→°C→°F, producing a bogus ~155°F). The HA entity is used
    // only for a stable log identity so the existing history/sparkline keeps
    // matching. If Govee is unavailable we skip the row rather than log HA's
    // bad value.
    const avSensor = findAvClosetTempSensor(
      Object.values(stateMap) as any[],
      process.env.AV_CLOSET_TEMP_ENTITY,
    );
    const avReading = await getAvClosetReading();
    if (avReading && Number.isFinite(avReading.tempF as number)) {
      const avEntityId = avSensor?.entity_id ?? 'sensor.av_closet_govee';
      const avName = (avSensor?.attributes?.friendly_name ?? 'AV Closet') as string;
      const avTemp = avReading.tempF as number;
      await db.query(
        `INSERT INTO thermostat_logs (entity_id, friendly_name, current_temperature, target_temperature, hvac_mode, hvac_action)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [avEntityId, avName, avTemp, null, null, null]
      );
      logged.push({ entityId: avEntityId, friendlyName: avName, currentTemp: avTemp, targetTemp: null, hvacMode: null });
    }

    // Gym-specific schedule enforcement
    // Get current PT time
    const nowPT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const scheduleState = getGymScheduleState(nowPT);
    const gymEntity = stateMap[GYM_ENTITY_ID];

    if (gymEntity) {
      const gymCurrentTemp = gymEntity.attributes?.current_temperature != null
        ? parseFloat(gymEntity.attributes.current_temperature)
        : null;

      if (scheduleState === 'on') {
        // During active hours: ensure AC is on, check temp
        const currentMode = gymEntity.state as string;
        if (currentMode === 'off' || currentMode === 'unavailable') {
          await setHAClimateMode(GYM_ENTITY_ID, 'cool', GYM_COOL_TEMP);
          gymActions.push(`Turned on Gym AC — set cool to ${GYM_COOL_TEMP}°F`);
        }

        // Alert if temperature is out of the 64–68°F band
        if (gymCurrentTemp !== null && (gymCurrentTemp < GYM_HEAT_TEMP || gymCurrentTemp > GYM_COOL_TEMP)) {
          const { rows: recent } = await db.query(
            `SELECT id FROM system_audit_log
             WHERE event_type = 'monitor_alert_sent'
               AND detail->>'cooldownKey' = 'gym_thermostat_out_of_range'
               AND created_at > NOW() - INTERVAL '${THERMOSTAT_DEDUP_HOURS} hours'
             LIMIT 1`
          );

          if (recent.length === 0) {
            const { sendMonitorAlert } = await import('../utils/notifications.js');
            await sendMonitorAlert({
              recipients: [{ email: process.env.ALERT_EMAIL || 'admin@example.com' }],
              subject: `⚠️ Gym Temperature Out of Range: ${gymCurrentTemp}°F`,
              body: `The Gym AC is active (6 AM–3 PM schedule) but the current temperature (${gymCurrentTemp}°F) is outside the target band of ${GYM_HEAT_TEMP}–${GYM_COOL_TEMP}°F.\n\nPlease check the thermostat.`,
              channels: ['email'],
              cooldownKey: 'gym_thermostat_out_of_range',
              cooldownMs: THERMOSTAT_DEDUP_HOURS * 60 * 60 * 1000,
              auditEdgeFunction: 'thermostat-monitor',
            });
            gymActions.push(`Alert sent — temp ${gymCurrentTemp}°F out of ${GYM_HEAT_TEMP}–${GYM_COOL_TEMP}°F band`);
          }
        }
      } else {
        // Outside active hours: ensure AC is off
        const currentMode = gymEntity.state as string;
        if (currentMode !== 'off' && currentMode !== 'unavailable') {
          await setHAClimateMode(GYM_ENTITY_ID, 'off');
          gymActions.push(`Turned off Gym AC (outside 6 AM–3 PM window)`);
        }
      }
    } else {
      gymActions.push(`Gym entity ${GYM_ENTITY_ID} not found in HA states`);
    }

    // Theater-specific schedule enforcement (10 AM – 11 PM PT, dual auto: heat 66 / cool 72)
    const theaterActions: string[] = [];
    const theaterScheduleState = getTheaterScheduleState(nowPT);
    const theaterInStartupGrace = isWithinScheduleStartGrace(
      THEATER_SCHEDULE,
      THEATER_STARTUP_GRACE_MINUTES,
    );
    const theaterEntity = stateMap[THEATER_ENTITY_ID];

    if (theaterEntity) {
      const theaterCurrentTemp = theaterEntity.attributes?.current_temperature != null
        ? parseFloat(theaterEntity.attributes.current_temperature)
        : null;
      const currentMode = theaterEntity.state as string;
      const targetLow = theaterEntity.attributes?.target_temp_low != null
        ? parseFloat(theaterEntity.attributes.target_temp_low) : null;
      const targetHigh = theaterEntity.attributes?.target_temp_high != null
        ? parseFloat(theaterEntity.attributes.target_temp_high) : null;

      if (theaterScheduleState === 'on') {
        // During active hours: ensure heat_cool mode with proper setpoints
        const setpointsWrong = targetLow !== THEATER_HEAT_TEMP || targetHigh !== THEATER_COOL_TEMP;
        if (currentMode !== 'heat_cool' || setpointsWrong) {
          await setHAClimateMode(THEATER_ENTITY_ID, 'heat_cool', {
            targetTempLow: THEATER_HEAT_TEMP,
            targetTempHigh: THEATER_COOL_TEMP,
          });
          theaterActions.push(`Set Theater to heat_cool — heat ${THEATER_HEAT_TEMP}°F / cool ${THEATER_COOL_TEMP}°F`);
        }

        // The Theater is off overnight, so let it condition the room for
        // 30 minutes after the 10 AM startup before evaluating temperature.
        if (
          !theaterInStartupGrace
          && theaterCurrentTemp !== null
          && (theaterCurrentTemp < THEATER_HEAT_TEMP || theaterCurrentTemp > THEATER_COOL_TEMP)
        ) {
          const { rows: recent } = await db.query(
            `SELECT id FROM system_audit_log
             WHERE event_type = 'monitor_alert_sent'
               AND detail->>'cooldownKey' = 'theater_thermostat_out_of_range'
               AND created_at > NOW() - INTERVAL '${THERMOSTAT_DEDUP_HOURS} hours'
             LIMIT 1`
          );

          if (recent.length === 0) {
            const { sendMonitorAlert } = await import('../utils/notifications.js');
            await sendMonitorAlert({
              recipients: [{ email: process.env.ALERT_EMAIL || 'admin@example.com' }],
              subject: `⚠️ Theater Temperature Out of Range: ${theaterCurrentTemp}°F`,
              body: `The Theater HVAC is active (10 AM–11 PM schedule) but the current temperature (${theaterCurrentTemp}°F) is outside the target band of ${THEATER_HEAT_TEMP}–${THEATER_COOL_TEMP}°F.\n\nPlease check the thermostat.`,
              channels: ['email'],
              cooldownKey: 'theater_thermostat_out_of_range',
              cooldownMs: THERMOSTAT_DEDUP_HOURS * 60 * 60 * 1000,
              auditEdgeFunction: 'thermostat-monitor',
            });
            theaterActions.push(`Alert sent — temp ${theaterCurrentTemp}°F out of ${THEATER_HEAT_TEMP}–${THEATER_COOL_TEMP}°F band`);
          }
        }
      } else {
        // Outside active hours: ensure HVAC is off
        if (currentMode !== 'off' && currentMode !== 'unavailable') {
          await setHAClimateMode(THEATER_ENTITY_ID, 'off');
          theaterActions.push(`Turned off Theater HVAC (outside 10 AM–11 PM window)`);
        }
      }
    } else {
      theaterActions.push(`Theater entity ${THEATER_ENTITY_ID} not found in HA states`);
    }

    const output = {
      entities_logged: logged.length,
      logged,
      gym: {
        schedule_state: scheduleState,
        hour_pt: nowPT.getHours(),
        actions: gymActions,
      },
      theater: {
        schedule_state: theaterScheduleState,
        hour_pt: nowPT.getHours(),
        startup_grace_active: theaterInStartupGrace,
        actions: theaterActions,
      },
    };

    await logAudit('thermostat-monitor', {
      category: 'automation',
      event_type: 'thermostat_monitor_run',
      severity: 'info',
      actor_id: 'system',
      actor_name: 'Thermostat Monitor',
      channel: 'cron',
      summary: `Logged ${logged.length} climate entities — Gym schedule: ${scheduleState} (${gymActions.length > 0 ? gymActions.join('; ') : 'no action needed'})`,
      detail: output,
      status: 'success',
    });

    res.json(output);
  } catch (err: any) {
    console.error('[thermostat-monitor] Error:', err.message);
    await logAudit('thermostat-monitor', {
      category: 'automation',
      event_type: 'thermostat_monitor_run',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'Thermostat Monitor',
      channel: 'cron',
      summary: `Error: ${err.message}`,
      status: 'error',
    });
    res.status(500).json({ error: err.message });
  }
});

// ── AV Closet Temperature Monitor ───────────────────────────────────────────
// Runs every 10 min (see cron.ts). Reads the AV Closet temperature straight from
// the Govee Cloud API (HA's Govee integration double-converts to a bogus ~155°F,
// so we never alert on the HA value). If temp > 90°F, emails Tony, Sandra & Jesse.
// If temp > 100°F, also WhatsApps Tony (from Janus). Each threshold has its own
// 2-hour dedup cooldown.
const AV_CLOSET_RECIPIENT_EMAILS = ['admin@example.com', 'staff@example.com', 'staff2@example.com'];
const AV_CLOSET_DEDUP_HOURS = 2;

router.post('/api/av-closet-temp-monitor', requireAuth, async (req: any, res: any) => {
  const db = storage;
  try {
    const { rows: [automation] } = await db.query(
      `SELECT id, is_active FROM family_automations WHERE name = 'AV Closet Temperature Monitor' LIMIT 1`
    );
    if (automation && automation.is_active === false) {
      res.json({ skipped: true, reason: 'automation disabled' });
      return;
    }

    // HA states are fetched best-effort only for a friendly name/identity. The
    // temperature itself comes from Govee, so a HA outage must not block alerts.
    let statesArr: any[] = [];
    try {
      const allStates = await callHAProxy({ action: 'get-states' });
      statesArr = Array.isArray(allStates) ? allStates : [];
    } catch (e: any) {
      console.warn('[av-closet-temp-monitor] HA states fetch failed (using Govee only):', e?.message || e);
    }
    const avSensor = findAvClosetTempSensor(statesArr as any[], process.env.AV_CLOSET_TEMP_ENTITY);

    // Read the real temperature straight from Govee. HA's Govee integration
    // double-converts (°F→°C→°F) and reports a bogus ~155°F, so we never alert on
    // the HA value. If Govee is unavailable we skip this run rather than risk a
    // false alarm or a missed overheat.
    const avReading = await getAvClosetReading();

    // Govee API unreachable — this is a transient failure on our side (network/
    // rate limit), NOT necessarily a dead sensor, so we skip rather than risk a
    // false offline alarm. (We also never alert on HA's double-converted value.)
    if (!avReading) {
      const output = {
        found: false,
        reason: 'AV Closet reading unavailable from Govee API (transient — skipped, no alert)',
      };
      await logAudit('av-closet-temp-monitor', {
        category: 'automation',
        event_type: 'av_closet_temp_monitor_run',
        severity: 'warning',
        actor_id: 'system',
        actor_name: 'AV Closet Monitor',
        channel: 'cron',
        summary: output.reason,
        detail: output,
        status: 'success',
      });
      if (automation) await db.query(`UPDATE family_automations SET last_run_at = NOW() WHERE id = $1`, [automation.id]);
      res.json(output);
      return;
    }

    const unit = '°F';
    const name = (avSensor?.attributes?.friendly_name as string | undefined) || 'AV Closet';
    const actions: string[] = [];

    // Resolve household members (email + whatsapp) for the configured recipients.
    const { rows: members } = await db.query(
      `SELECT display_name, email, whatsapp_number FROM household_members WHERE email = ANY($1)`,
      [AV_CLOSET_RECIPIENT_EMAILS]
    );
    const findMember = (email: string) => members.find((m: any) => m.email === email);

    const { sendMonitorAlert } = await import('../utils/notifications.js');

    // Offline detection — the Govee API responded but the device is reporting
    // offline (online === false) or returned no usable temperature. This means
    // the sensor is down (dead battery, lost connectivity), so monitoring is
    // blind. Alert the same recipients as an overheat: email Tony/Sandra/Jesse
    // AND WhatsApp Tony. Own 2-hour dedup cooldown.
    const isOffline = avReading.online === false || !Number.isFinite(avReading.tempF as number);
    if (isOffline) {
      const tony = findMember('admin@example.com');
      const tonyWhatsApp = tony?.whatsapp_number || process.env.ALERT_PHONE_NUMBER;
      // Only a *successful* prior send counts toward the cooldown — a failed
      // delivery must not suppress retries while the sensor is still down.
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log
         WHERE event_type = 'monitor_alert_sent'
           AND detail->>'cooldownKey' = 'av_closet_offline'
           AND detail->>'anySuccess' = 'true'
           AND created_at > NOW() - INTERVAL '${AV_CLOSET_DEDUP_HOURS} hours'
         LIMIT 1`
      );
      if (recent.length === 0) {
        const recipients: Array<{ email?: string; whatsapp?: string }> = [
          ...AV_CLOSET_RECIPIENT_EMAILS.map(e => ({ email: findMember(e)?.email || e })),
          ...(tonyWhatsApp ? [{ whatsapp: tonyWhatsApp }] : []),
        ];
        const sendResult = await sendMonitorAlert({
          recipients,
          subject: `🚨 AV Closet Sensor Offline`,
          body: `The ${name} temperature sensor is offline — Govee is no longer reporting readings (likely a dead battery or lost connectivity).\n\nTemperature monitoring for the AV equipment closet is blind until the sensor is back online. Please check or replace the sensor's battery.`,
          channels: ['email', 'whatsapp'],
          cooldownKey: 'av_closet_offline',
          cooldownMs: AV_CLOSET_DEDUP_HOURS * 60 * 60 * 1000,
          auditEdgeFunction: 'av-closet-temp-monitor',
        });
        actions.push(
          sendResult.sent
            ? 'Offline alert sent (email + WhatsApp)'
            : 'Offline alert delivery FAILED (will retry next run)'
        );
      } else {
        actions.push('Offline alert suppressed (cooldown active)');
      }

      const output = {
        found: true,
        offline: true,
        entity_id: avSensor?.entity_id ?? 'sensor.av_closet_govee',
        online: avReading.online,
        actions,
      };
      await logAudit('av-closet-temp-monitor', {
        category: 'automation',
        event_type: 'av_closet_temp_monitor_run',
        severity: 'error',
        actor_id: 'system',
        actor_name: 'AV Closet Monitor',
        channel: 'cron',
        summary: `AV Closet sensor offline — ${actions.join('; ')}`,
        detail: output,
        status: 'success',
      });
      if (automation) await db.query(`UPDATE family_automations SET last_run_at = NOW() WHERE id = $1`, [automation.id]);
      res.json(output);
      return;
    }

    const temp = avReading.tempF as number;

    const isCriticalActive = Number.isFinite(temp) && temp > AV_CLOSET_CRITICAL_TEMP;
    const isWarnActive = Number.isFinite(temp) && temp > AV_CLOSET_WARN_TEMP;

    // Warning threshold (> 90°F): email Tony, Sandra & Jesse.
    if (isWarnActive) {
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log
         WHERE event_type = 'monitor_alert_sent'
           AND detail->>'cooldownKey' = 'av_closet_temp_warn'
           AND created_at > NOW() - INTERVAL '${AV_CLOSET_DEDUP_HOURS} hours'
         LIMIT 1`
      );
      if (recent.length === 0) {
        const recipients = AV_CLOSET_RECIPIENT_EMAILS
          .map(e => findMember(e)?.email || e)
          .map(email => ({ email }));
        await sendMonitorAlert({
          recipients,
          subject: `⚠️ AV Closet Temperature High: ${temp}${unit}`,
          body: `The ${name} temperature is ${temp}${unit}, which is above the ${AV_CLOSET_WARN_TEMP}${unit} threshold.\n\nPlease check ventilation/cooling for the AV equipment closet.`,
          channels: ['email'],
          cooldownKey: 'av_closet_temp_warn',
          cooldownMs: AV_CLOSET_DEDUP_HOURS * 60 * 60 * 1000,
          auditEdgeFunction: 'av-closet-temp-monitor',
        });
        actions.push(`Email alert sent (>${AV_CLOSET_WARN_TEMP}${unit}) to ${recipients.map(r => r.email).join(', ')}`);
      } else {
        actions.push(`Warning alert suppressed (cooldown active)`);
      }
    }

    // Critical threshold (> 100°F): WhatsApp Tony from Janus.
    if (isCriticalActive) {
      const tony = findMember('admin@example.com');
      const tonyWhatsApp = tony?.whatsapp_number || process.env.ALERT_PHONE_NUMBER;
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log
         WHERE event_type = 'monitor_alert_sent'
           AND detail->>'cooldownKey' = 'av_closet_temp_critical'
           AND created_at > NOW() - INTERVAL '${AV_CLOSET_DEDUP_HOURS} hours'
         LIMIT 1`
      );
      if (recent.length === 0 && tonyWhatsApp) {
        await sendMonitorAlert({
          recipients: [{ whatsapp: tonyWhatsApp }],
          subject: `🚨 AV Closet Temperature Critical: ${temp}${unit}`,
          body: `The ${name} temperature is ${temp}${unit}, above the critical ${AV_CLOSET_CRITICAL_TEMP}${unit} threshold. Immediate attention needed to prevent equipment damage.`,
          channels: ['whatsapp'],
          cooldownKey: 'av_closet_temp_critical',
          cooldownMs: AV_CLOSET_DEDUP_HOURS * 60 * 60 * 1000,
          auditEdgeFunction: 'av-closet-temp-monitor',
        });
        actions.push(`WhatsApp alert sent to Tony (>${AV_CLOSET_CRITICAL_TEMP}${unit})`);
      } else if (recent.length > 0) {
        actions.push(`Critical alert suppressed (cooldown active)`);
      } else {
        actions.push(`Critical threshold met but no WhatsApp number resolved for Tony`);
      }
    }

    const output = {
      found: true,
      entity_id: avSensor?.entity_id ?? 'sensor.av_closet_govee',
      temperature: Number.isFinite(temp) ? temp : null,
      unit,
      warn_threshold: AV_CLOSET_WARN_TEMP,
      critical_threshold: AV_CLOSET_CRITICAL_TEMP,
      warn_active: isWarnActive,
      critical_active: isCriticalActive,
      actions,
    };

    await logAudit('av-closet-temp-monitor', {
      category: 'automation',
      event_type: 'av_closet_temp_monitor_run',
      severity: isCriticalActive ? 'error' : isWarnActive ? 'warning' : 'info',
      actor_id: 'system',
      actor_name: 'AV Closet Monitor',
      channel: 'cron',
      summary: `AV Closet ${Number.isFinite(temp) ? `${temp}${unit}` : 'unknown'} — ${actions.length > 0 ? actions.join('; ') : 'within range, no action'}`,
      detail: output,
      status: 'success',
    });

    if (automation) await db.query(`UPDATE family_automations SET last_run_at = NOW() WHERE id = $1`, [automation.id]);

    res.json(output);
  } catch (err: any) {
    console.error('[av-closet-temp-monitor] Error:', err.message);
    await logAudit('av-closet-temp-monitor', {
      category: 'automation',
      event_type: 'av_closet_temp_monitor_run',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'AV Closet Monitor',
      channel: 'cron',
      summary: `Error: ${err.message}`,
      status: 'error',
    });
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/thermostat-monitor/history', async (req: any, res: any) => {
  try {
    const db = storage;
    const hours = Math.min(parseInt(req.query.hours as string) || 24, 168);
    const limit = Math.min(parseInt(req.query.limit as string) || 200, 500);
    const entityId = (req.query.entity_id as string) || null;

    const params: any[] = [limit];
    const entityClause = entityId ? `AND entity_id = $2` : '';
    if (entityId) params.push(entityId);

    const { rows } = await db.query(
      `SELECT id, entity_id, friendly_name, current_temperature, target_temperature, hvac_mode, hvac_action, logged_at
       FROM thermostat_logs
       WHERE logged_at > NOW() - INTERVAL '${hours} hours'
       ${entityClause}
       ORDER BY logged_at ASC
       LIMIT $1`,
      params
    );
    res.json({ logs: rows, count: rows.length });
  } catch (err: any) {
    console.error('[thermostat-monitor/history] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Thermostat Data Freshness Monitor ────────────────────────────────────────
// Runs every 15 min alongside the thermostat-monitor cron.
// If no row has been written to thermostat_logs in the last 30 minutes during
// normal operating hours (6 AM – midnight PT), sends a WhatsApp alert to Tony.
// Deduplicated: at most one alert per stale incident; writes a "recovered"
// entry the first time fresh data is seen again after an alert.

const THERMOSTAT_FRESHNESS_THRESHOLD_MINUTES = (() => {
  const raw = process.env.THERMOSTAT_FRESHNESS_THRESHOLD_MINUTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
})();
const THERMOSTAT_FRESHNESS_ALERT_KEY = 'thermostat_freshness_stale';

router.post('/api/thermostat-freshness-monitor', requireAuth, async (req: any, res: any) => {
  const db = storage;
  try {
    // Only run between 6 AM and midnight Pacific time
    const nowPT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const hourPT = nowPT.getHours();
    if (hourPT < 6) {
      return res.json({ skipped: true, reason: 'Outside operating hours (before 6 AM PT)' });
    }

    // Find the most recent thermostat log entry
    const { rows: latestRows } = await db.query(
      `SELECT MAX(logged_at) AS latest FROM thermostat_logs`
    );
    const latestAt: Date | null = latestRows[0]?.latest ?? null;
    const thresholdMs = THERMOSTAT_FRESHNESS_THRESHOLD_MINUTES * 60 * 1000;
    const isStale = !latestAt || (Date.now() - new Date(latestAt).getTime() > thresholdMs);
    const ageMinutes = latestAt
      ? Math.round((Date.now() - new Date(latestAt).getTime()) / 60000)
      : null;

    // Find last alert entry (no dedup key needed since we look for recovery separately)
    const { rows: lastAlertRows } = await db.query(
      `SELECT id, created_at FROM system_audit_log
       WHERE event_type = $1
         AND detail->>'alert_key' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      ['thermostat_freshness_alert', THERMOSTAT_FRESHNESS_ALERT_KEY]
    );
    const lastAlert = lastAlertRows[0] ?? null;

    // Check if there is a recovery after the last alert
    const { rows: lastRecoveryRows } = lastAlert
      ? await db.query(
          `SELECT id FROM system_audit_log
           WHERE event_type = $1
             AND detail->>'alert_key' = $2
             AND created_at > $3
           LIMIT 1`,
          ['thermostat_freshness_recovered', THERMOSTAT_FRESHNESS_ALERT_KEY, lastAlert.created_at]
        )
      : { rows: [] };
    const incidentActive = Boolean(lastAlert && lastRecoveryRows.length === 0);

    if (isStale) {
      console.log(`[thermostat-freshness] Data is STALE — last logged_at: ${latestAt?.toISOString() ?? 'never'} (${ageMinutes ?? '∞'} min ago)`);

      await logAudit('thermostat-freshness-monitor', {
        category: 'home',
        event_type: 'thermostat_freshness_check',
        severity: 'error',
        actor_id: 'system',
        actor_name: 'Thermostat Freshness Monitor',
        channel: 'cron',
        summary: `Thermostat logs STALE — last entry ${ageMinutes ?? '∞'} min ago`,
        detail: { latest_logged_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes, threshold_minutes: THERMOSTAT_FRESHNESS_THRESHOLD_MINUTES },
        status: 'error',
      });

      if (!incidentActive) {
        // First alert for this stale incident — send WhatsApp first, then write
        // the dedup-gated audit entry. If the send fails, the dedup entry is NOT
        // written so the next cron run will retry the alert rather than suppressing it.
        const msg =
          `⚠️ *Thermostat Logger Alert*\n\n` +
          `No thermostat readings have been recorded in the last *${ageMinutes ?? '∞'} minutes*.\n\n` +
          `Last reading: ${latestAt ? new Date(latestAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short' }) + ' PT' : 'never'}\n\n` +
          `The thermostat-monitor cron may have stopped or the deployed server may be down. ` +
          `Check the audit log and deployment status.`;

        let waSent = false;
        try {
          await sendWhatsApp(msg);
          waSent = true;
          console.log('[thermostat-freshness] WhatsApp alert sent — new stale incident.');
        } catch (e: any) {
          console.error('[thermostat-freshness] WhatsApp send failed:', e.message);
        }

        if (waSent) {
          // Only write the dedup-gated alert entry after a successful send so
          // transient WhatsApp failures do not permanently suppress future alerts.
          await logAudit('thermostat-freshness-monitor', {
            category: 'home',
            event_type: 'thermostat_freshness_alert',
            severity: 'error',
            actor_id: 'system',
            actor_name: 'Thermostat Freshness Monitor',
            channel: 'cron',
            summary: `🚨 Thermostat logger stopped writing — no data for ${ageMinutes ?? '∞'} min`,
            detail: { alert_key: THERMOSTAT_FRESHNESS_ALERT_KEY, latest_logged_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes },
            status: 'error',
          });
        }
      } else {
        console.log('[thermostat-freshness] Data stale but incident already active — skipping WhatsApp.');
      }

      return res.json({ stale: true, age_minutes: ageMinutes, incident_active: incidentActive });
    }

    // Data is fresh
    console.log(`[thermostat-freshness] Data is FRESH — last logged_at: ${latestAt?.toISOString()} (${ageMinutes} min ago)`);

    await logAudit('thermostat-freshness-monitor', {
      category: 'home',
      event_type: 'thermostat_freshness_check',
      severity: 'info',
      actor_id: 'system',
      actor_name: 'Thermostat Freshness Monitor',
      channel: 'cron',
      summary: `Thermostat logs fresh — last entry ${ageMinutes} min ago`,
      detail: { latest_logged_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes, threshold_minutes: THERMOSTAT_FRESHNESS_THRESHOLD_MINUTES },
      status: 'success',
    });

    // Write recovery if a stale incident was active
    if (incidentActive) {
      await logAudit('thermostat-freshness-monitor', {
        category: 'home',
        event_type: 'thermostat_freshness_recovered',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'Thermostat Freshness Monitor',
        channel: 'cron',
        summary: `✅ Thermostat logger recovered — data flowing again (${ageMinutes} min since last entry)`,
        detail: { alert_key: THERMOSTAT_FRESHNESS_ALERT_KEY, latest_logged_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes },
        status: 'success',
      });
      console.log('[thermostat-freshness] Recovery logged — stale incident resolved.');
    }

    return res.json({ stale: false, age_minutes: ageMinutes, recovered: incidentActive });
  } catch (err: any) {
    console.error('[thermostat-freshness-monitor] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Pool Temp Data Freshness Monitor ─────────────────────────────────────────
// Mirrors the thermostat-freshness-monitor pattern. The pool-temp-monitor
// cron runs every 30 min during pool hours and writes a `pool_temp_check`
// audit log entry on each success. If we have not seen a successful entry in
// the last threshold window during pool hours (6 AM – 11 PM PT), we send a
// WhatsApp alert and write a deduplicated audit entry. A "recovered" entry is
// written the first time fresh data is seen again after an alert.

const POOL_TEMP_FRESHNESS_THRESHOLD_MINUTES = (() => {
  const raw = process.env.POOL_TEMP_FRESHNESS_THRESHOLD_MINUTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 40;
})();
const POOL_TEMP_FRESHNESS_ALERT_KEY = 'pool_temp_freshness_stale';

router.post('/api/pool-temp-freshness-monitor', requireAuth, async (req: any, res: any) => {
  const db = storage;
  try {
    // Only run during pool hours (6 AM – 11 PM PT)
    const nowPT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const hourPT = nowPT.getHours();
    if (hourPT < 6 || hourPT >= 23) {
      return res.json({ skipped: true, reason: 'Outside pool hours (6 AM – 11 PM PT)' });
    }

    // Find the most recent successful pool_temp_check audit entry
    const { rows: latestRows } = await db.query(
      `SELECT MAX(created_at) AS latest FROM system_audit_log
       WHERE event_type = 'pool_temp_check' AND status = 'success'`
    );
    const latestAt: Date | null = latestRows[0]?.latest ?? null;
    const thresholdMs = POOL_TEMP_FRESHNESS_THRESHOLD_MINUTES * 60 * 1000;
    const isStale = !latestAt || (Date.now() - new Date(latestAt).getTime() > thresholdMs);
    const ageMinutes = latestAt
      ? Math.round((Date.now() - new Date(latestAt).getTime()) / 60000)
      : null;

    const { rows: lastAlertRows } = await db.query(
      `SELECT id, created_at FROM system_audit_log
       WHERE event_type = $1
         AND detail->>'alert_key' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      ['pool_temp_freshness_alert', POOL_TEMP_FRESHNESS_ALERT_KEY]
    );
    const lastAlert = lastAlertRows[0] ?? null;

    const { rows: lastRecoveryRows } = lastAlert
      ? await db.query(
          `SELECT id FROM system_audit_log
           WHERE event_type = $1
             AND detail->>'alert_key' = $2
             AND created_at > $3
           LIMIT 1`,
          ['pool_temp_freshness_recovered', POOL_TEMP_FRESHNESS_ALERT_KEY, lastAlert.created_at]
        )
      : { rows: [] };
    const incidentActive = Boolean(lastAlert && lastRecoveryRows.length === 0);

    if (isStale) {
      console.log(`[pool-temp-freshness] Data is STALE — last pool_temp_check: ${latestAt?.toISOString() ?? 'never'} (${ageMinutes ?? '∞'} min ago)`);

      await logAudit('pool-temp-freshness-monitor', {
        category: 'home',
        event_type: 'pool_temp_freshness_check',
        severity: 'error',
        actor_id: 'system',
        actor_name: 'Pool Temp Freshness Monitor',
        channel: 'cron',
        summary: `Pool temp readings STALE — last entry ${ageMinutes ?? '∞'} min ago`,
        detail: { latest_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes, threshold_minutes: POOL_TEMP_FRESHNESS_THRESHOLD_MINUTES },
        status: 'error',
      });

      if (!incidentActive) {
        const msg =
          `⚠️ *Pool Temperature Logger Alert*\n\n` +
          `No pool temperature readings have been recorded in the last *${ageMinutes ?? '∞'} minutes*.\n\n` +
          `Last reading: ${latestAt ? new Date(latestAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short' }) + ' PT' : 'never'}\n\n` +
          `The pool-temp-monitor cron may have stopped or the deployed server may be down. ` +
          `Check the audit log and deployment status.`;

        let waSent = false;
        try {
          await sendWhatsApp(msg);
          waSent = true;
          console.log('[pool-temp-freshness] WhatsApp alert sent — new stale incident.');
        } catch (e: any) {
          console.error('[pool-temp-freshness] WhatsApp send failed:', e.message);
        }

        if (waSent) {
          await logAudit('pool-temp-freshness-monitor', {
            category: 'home',
            event_type: 'pool_temp_freshness_alert',
            severity: 'error',
            actor_id: 'system',
            actor_name: 'Pool Temp Freshness Monitor',
            channel: 'cron',
            summary: `🚨 Pool temp logger stopped writing — no data for ${ageMinutes ?? '∞'} min`,
            detail: { alert_key: POOL_TEMP_FRESHNESS_ALERT_KEY, latest_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes },
            status: 'error',
          });
        }
      } else {
        console.log('[pool-temp-freshness] Data stale but incident already active — skipping WhatsApp.');
      }

      return res.json({ stale: true, age_minutes: ageMinutes, incident_active: incidentActive });
    }

    console.log(`[pool-temp-freshness] Data is FRESH — last pool_temp_check: ${latestAt?.toISOString()} (${ageMinutes} min ago)`);

    await logAudit('pool-temp-freshness-monitor', {
      category: 'home',
      event_type: 'pool_temp_freshness_check',
      severity: 'info',
      actor_id: 'system',
      actor_name: 'Pool Temp Freshness Monitor',
      channel: 'cron',
      summary: `Pool temp readings fresh — last entry ${ageMinutes} min ago`,
      detail: { latest_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes, threshold_minutes: POOL_TEMP_FRESHNESS_THRESHOLD_MINUTES },
      status: 'success',
    });

    if (incidentActive) {
      await logAudit('pool-temp-freshness-monitor', {
        category: 'home',
        event_type: 'pool_temp_freshness_recovered',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'Pool Temp Freshness Monitor',
        channel: 'cron',
        summary: `✅ Pool temp logger recovered — data flowing again (${ageMinutes} min since last entry)`,
        detail: { alert_key: POOL_TEMP_FRESHNESS_ALERT_KEY, latest_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes },
        status: 'success',
      });
      console.log('[pool-temp-freshness] Recovery logged — stale incident resolved.');
    }

    return res.json({ stale: false, age_minutes: ageMinutes, recovered: incidentActive });
  } catch (err: any) {
    console.error('[pool-temp-freshness-monitor] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Wireless Snapshot Pipeline Watchdog ──────────────────────────────────────
// The 5-min Ruckus poll (/api/wireless-snapshot) writes a
// `wireless_snapshot_ok` heartbeat audit row on every successful run. If
// the pipeline silently breaks (stuck circuit breaker, HA/Ruckus tunnel
// down, rotated credentials) the dashboard just shows stale data with no
// alarm. This watchdog (cron every 15 min) reads the most recent heartbeat
// and, if it is older than the threshold (default 20 min ≈ 4 missed
// 5-min cycles) — or has never been seen — writes a single actionable
// audit row so it surfaces in Admin → Actionable Alerts. Deduped to at
// most one alert per 60-min window so a prolonged outage doesn't spam the
// alert list every 15 min. Once the heartbeat is fresh again after an
// active stale incident, a single wireless_snapshot_recovered row (same
// alert_key) is written so admins can see the incident closed itself.

const WIRELESS_HEARTBEAT_STALE_MINUTES = (() => {
  const raw = process.env.WIRELESS_HEARTBEAT_STALE_MINUTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
})();
const WIRELESS_HEARTBEAT_DEDUP_MINUTES = 60;
const WIRELESS_HEARTBEAT_ALERT_KEY = 'wireless_snapshot_stale';

router.post('/api/wireless-snapshot-watchdog', requireAuth, async (_req: Request, res: Response) => {
  try {
    // Most recent successful wireless-snapshot heartbeat.
    const { rows: latestRows } = await storage.query(
      `SELECT MAX(created_at) AS latest
         FROM system_audit_log
        WHERE event_type = 'wireless_snapshot_ok'`,
    );
    const latestAt: Date | null = latestRows[0]?.latest ?? null;
    const thresholdMs = WIRELESS_HEARTBEAT_STALE_MINUTES * 60 * 1000;
    const ageMinutes = latestAt
      ? Math.round((Date.now() - new Date(latestAt).getTime()) / 60000)
      : null;
    const isStale = !latestAt || Date.now() - new Date(latestAt).getTime() > thresholdMs;

    if (!isStale) {
      console.log(
        `[wireless-watchdog] Heartbeat fresh — last wireless_snapshot_ok ${ageMinutes} min ago.`,
      );

      // A prior stale incident is "active" when the most recent stale alert
      // has no recovery row after it. Mirror the thermostat-freshness-monitor
      // pattern: write a single wireless_snapshot_recovered row so the
      // Actionable Alerts surface shows the incident closed itself.
      const { rows: lastAlertRows } = await storage.query(
        `SELECT id, created_at FROM system_audit_log
          WHERE event_type = $1
            AND detail->>'alert_key' = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [WIRELESS_HEARTBEAT_ALERT_KEY, WIRELESS_HEARTBEAT_ALERT_KEY],
      );
      const lastAlert = lastAlertRows[0] ?? null;
      const { rows: lastRecoveryRows } = lastAlert
        ? await storage.query(
            `SELECT id FROM system_audit_log
              WHERE event_type = $1
                AND detail->>'alert_key' = $2
                AND created_at > $3
              LIMIT 1`,
            ['wireless_snapshot_recovered', WIRELESS_HEARTBEAT_ALERT_KEY, lastAlert.created_at],
          )
        : { rows: [] };
      const incidentActive = Boolean(lastAlert && lastRecoveryRows.length === 0);

      if (incidentActive) {
        await logAudit('wireless-snapshot-watchdog', {
          category: 'system',
          event_type: 'wireless_snapshot_recovered',
          severity: 'info',
          actor_id: 'system',
          actor_name: 'Wireless Snapshot Watchdog',
          channel: 'cron',
          summary: `✅ Wireless snapshot pipeline recovered — heartbeat fresh again (last heartbeat ${ageMinutes}m ago)`,
          detail: {
            alert_key: WIRELESS_HEARTBEAT_ALERT_KEY,
            last_heartbeat_at: latestAt ? new Date(latestAt).toISOString() : null,
            age_minutes: ageMinutes,
            threshold_minutes: WIRELESS_HEARTBEAT_STALE_MINUTES,
          },
          status: 'success',
        });
        console.log('[wireless-watchdog] Recovery logged — stale incident resolved.');
      }

      return res.json({ stale: false, age_minutes: ageMinutes, recovered: incidentActive });
    }

    // Dedup: suppress if we've already written an actionable stale alert
    // within the dedup window.
    const { rows: recentAlertRows } = await storage.query(
      `SELECT id FROM system_audit_log
        WHERE event_type = $1
          AND created_at > NOW() - ($2 || ' minutes')::interval
        LIMIT 1`,
      [WIRELESS_HEARTBEAT_ALERT_KEY, String(WIRELESS_HEARTBEAT_DEDUP_MINUTES)],
    );
    const alreadyAlerted = recentAlertRows.length > 0;

    const ageLabel = ageMinutes === null ? 'ever (no heartbeat on record)' : `${ageMinutes}m`;
    console.log(
      `[wireless-watchdog] Heartbeat STALE — last wireless_snapshot_ok ${ageLabel} ago` +
        (alreadyAlerted ? ' (alert already raised within dedup window — skipping)' : ''),
    );

    if (!alreadyAlerted) {
      await logAudit('wireless-snapshot-watchdog', {
        category: 'system',
        event_type: WIRELESS_HEARTBEAT_ALERT_KEY,
        severity: 'warn',
        actor_id: 'system',
        actor_name: 'Wireless Snapshot Watchdog',
        channel: 'cron',
        summary:
          ageMinutes === null
            ? 'Wireless snapshot pipeline silent — no heartbeat on record'
            : `Wireless snapshot pipeline silent for ${ageMinutes}m`,
        detail: {
          alert_key: WIRELESS_HEARTBEAT_ALERT_KEY,
          last_heartbeat_at: latestAt ? new Date(latestAt).toISOString() : null,
          age_minutes: ageMinutes,
          threshold_minutes: WIRELESS_HEARTBEAT_STALE_MINUTES,
          remediation:
            'Check the Ruckus circuit breaker, HA proxy tunnel, and RUCKUS_USERNAME/RUCKUS_PASSWORD; confirm the /api/wireless-snapshot cron is firing.',
        },
        status: 'warn',
        actionable: true,
      });
    }

    return res.json({
      stale: true,
      age_minutes: ageMinutes,
      alerted: !alreadyAlerted,
      deduped: alreadyAlerted,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[wireless-snapshot-watchdog] Error:', message);
    res.status(500).json({ error: message });
  }
});

// ── Speed Test Data Freshness Monitor ────────────────────────────────────────
// Speed test rows are written by the server-side pull cron at
// /api/speedtest-pull-from-ha, which reads sensor.speedtest_{download,upload,
// ping} from Home Assistant every 15 min. If no rows have appeared in the last
// threshold window the pull endpoint is failing, the cron isn't firing, or
// HA's speedtest.net integration has stopped updating its sensors. Sends a
// WhatsApp alert (deduplicated to one per stale incident) and writes a
// recovery entry when data resumes. No operating-hours gate — speed tests
// run 24/7. (The legacy /api/speedtest-ingest push endpoint remains as a
// fallback path but is no longer the primary writer.)

const SPEED_TEST_FRESHNESS_THRESHOLD_MINUTES = (() => {
  const raw = process.env.SPEED_TEST_FRESHNESS_THRESHOLD_MINUTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180;
})();
const SPEED_TEST_FRESHNESS_ALERT_KEY = 'speed_test_freshness_stale';

router.post('/api/speed-test-freshness-monitor', requireAuth, async (req: any, res: any) => {
  const db = storage;
  try {
    const { rows: latestRows } = await db.query(
      `SELECT MAX(tested_at) AS latest FROM speed_tests`
    );
    const latestAt: Date | null = latestRows[0]?.latest ?? null;
    const thresholdMs = SPEED_TEST_FRESHNESS_THRESHOLD_MINUTES * 60 * 1000;
    const isStale = !latestAt || (Date.now() - new Date(latestAt).getTime() > thresholdMs);
    const ageMinutes = latestAt
      ? Math.round((Date.now() - new Date(latestAt).getTime()) / 60000)
      : null;

    const { rows: lastAlertRows } = await db.query(
      `SELECT id, created_at FROM system_audit_log
       WHERE event_type = $1
         AND detail->>'alert_key' = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      ['speed_test_freshness_alert', SPEED_TEST_FRESHNESS_ALERT_KEY]
    );
    const lastAlert = lastAlertRows[0] ?? null;

    const { rows: lastRecoveryRows } = lastAlert
      ? await db.query(
          `SELECT id FROM system_audit_log
           WHERE event_type = $1
             AND detail->>'alert_key' = $2
             AND created_at > $3
           LIMIT 1`,
          ['speed_test_freshness_recovered', SPEED_TEST_FRESHNESS_ALERT_KEY, lastAlert.created_at]
        )
      : { rows: [] };
    const incidentActive = Boolean(lastAlert && lastRecoveryRows.length === 0);

    if (isStale) {
      console.log(`[speed-test-freshness] Data is STALE — last tested_at: ${latestAt?.toISOString() ?? 'never'} (${ageMinutes ?? '∞'} min ago)`);

      await logAudit('speed-test-freshness-monitor', {
        category: 'automation',
        event_type: 'speed_test_freshness_check',
        severity: 'error',
        actor_id: 'system',
        actor_name: 'Speed Test Freshness Monitor',
        channel: 'cron',
        summary: `Speed test rows STALE — last entry ${ageMinutes ?? '∞'} min ago`,
        detail: { latest_tested_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes, threshold_minutes: SPEED_TEST_FRESHNESS_THRESHOLD_MINUTES },
        status: 'error',
      });

      if (!incidentActive) {
        const msg =
          `⚠️ *Speed Test Logger Alert*\n\n` +
          `No speed test rows have been written in the last *${ageMinutes ?? '∞'} minutes*.\n\n` +
          `Last reading: ${latestAt ? new Date(latestAt).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'short' }) + ' PT' : 'never'}\n\n` +
          `The server-side HA speedtest pull (/api/speedtest-pull-from-ha) may be failing, ` +
          `or the underlying sensor.speedtest_* entities in Home Assistant have stopped updating. ` +
          `Check the audit log and HA's speedtest.net integration.`;

        let waSent = false;
        try {
          await sendWhatsApp(msg);
          waSent = true;
          console.log('[speed-test-freshness] WhatsApp alert sent — new stale incident.');
        } catch (e: any) {
          console.error('[speed-test-freshness] WhatsApp send failed:', e.message);
        }

        if (waSent) {
          await logAudit('speed-test-freshness-monitor', {
            category: 'automation',
            event_type: 'speed_test_freshness_alert',
            severity: 'error',
            actor_id: 'system',
            actor_name: 'Speed Test Freshness Monitor',
            channel: 'cron',
            summary: `🚨 Speed test logger stopped writing — no data for ${ageMinutes ?? '∞'} min`,
            detail: { alert_key: SPEED_TEST_FRESHNESS_ALERT_KEY, latest_tested_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes },
            status: 'error',
          });
        }
      } else {
        console.log('[speed-test-freshness] Data stale but incident already active — skipping WhatsApp.');
      }

      return res.json({ stale: true, age_minutes: ageMinutes, incident_active: incidentActive });
    }

    console.log(`[speed-test-freshness] Data is FRESH — last tested_at: ${latestAt?.toISOString()} (${ageMinutes} min ago)`);

    await logAudit('speed-test-freshness-monitor', {
      category: 'automation',
      event_type: 'speed_test_freshness_check',
      severity: 'info',
      actor_id: 'system',
      actor_name: 'Speed Test Freshness Monitor',
      channel: 'cron',
      summary: `Speed test rows fresh — last entry ${ageMinutes} min ago`,
      detail: { latest_tested_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes, threshold_minutes: SPEED_TEST_FRESHNESS_THRESHOLD_MINUTES },
      status: 'success',
    });

    if (incidentActive) {
      await logAudit('speed-test-freshness-monitor', {
        category: 'automation',
        event_type: 'speed_test_freshness_recovered',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'Speed Test Freshness Monitor',
        channel: 'cron',
        summary: `✅ Speed test logger recovered — data flowing again (${ageMinutes} min since last entry)`,
        detail: { alert_key: SPEED_TEST_FRESHNESS_ALERT_KEY, latest_tested_at: latestAt?.toISOString() ?? null, age_minutes: ageMinutes },
        status: 'success',
      });
      console.log('[speed-test-freshness] Recovery logged — stale incident resolved.');
    }

    return res.json({ stale: false, age_minutes: ageMinutes, recovered: incidentActive });
  } catch (err: any) {
    console.error('[speed-test-freshness-monitor] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Notion Webhook Health Monitor ────────────────────────────────────────────
// Detects when the Notion webhook subscription has silently died (it auto-
// disables after repeated slow/failed deliveries — that is what left the
// Activity chart empty for ~2 weeks before anyone noticed).
//
// Detection uses the poller (/api/notion/poll) as ground truth: it queries
// Notion directly every 10 min and stands down whenever the live webhook is
// healthy. So if poller-sourced events are appearing but NO webhook-sourced
// events are, real activity is happening yet the webhook isn't delivering →
// the webhook is down. This avoids false alarms during genuine quiet periods
// (when neither source produces events, nothing is wrong).
//
// A second, cheaper check confirms the poller cron itself is still firing, so
// the safety net can't die silently too. Both alerts are WhatsApp + audit with
// an incident-based dedup (one alert per incident, plus a recovery entry).
const NOTION_HEALTH_WINDOW_MINUTES = 30;
const NOTION_WEBHOOK_DOWN_KEY = 'notion_webhook_down';
const NOTION_POLLER_DOWN_KEY = 'notion_poller_down';
const NOTION_WEBHOOK_URL = 'https://club34.replit.app/api/notion/webhook';

async function notionIncidentActive(
  db: typeof storage,
  alertEvent: string,
  recoveredEvent: string,
  alertKey: string,
): Promise<boolean> {
  const { rows: lastAlertRows } = await db.query(
    `SELECT id, created_at FROM system_audit_log
     WHERE event_type = $1 AND detail->>'alert_key' = $2
     ORDER BY created_at DESC LIMIT 1`,
    [alertEvent, alertKey],
  );
  const lastAlert = lastAlertRows[0] ?? null;
  const { rows: recRows } = lastAlert
    ? await db.query(
        `SELECT id FROM system_audit_log
         WHERE event_type = $1 AND detail->>'alert_key' = $2 AND created_at > $3 LIMIT 1`,
        [recoveredEvent, alertKey, lastAlert.created_at],
      )
    : { rows: [] };
  return Boolean(lastAlert && recRows.length === 0);
}

router.post('/api/notion-webhook-health-monitor', requireAuth, async (_req: any, res: any) => {
  const db = storage;
  try {
    const sinceIso = new Date(
      Date.now() - NOTION_HEALTH_WINDOW_MINUTES * 60 * 1000,
    ).toISOString();

    // Live webhook deliveries in the window. Webhook rows are inserted with the
    // default created_at = now(), so a created_at window correctly reflects when
    // the webhook actually delivered.
    const { rows: webhookRows } = await db.query(
      `SELECT COUNT(*) AS c FROM notion_webhook_events
       WHERE created_at > $1 AND payload->>'_source' IS DISTINCT FROM 'poller'`,
      [sinceIso],
    );
    const webhookEvents = Number(webhookRows[0]?.c ?? 0);

    // Poller ground-truth activity. We must key this on the poll *run* time, not
    // on notion_webhook_events.created_at — the poller writes synthetic rows with
    // created_at = the page's last_edited_time, so a backfill of older edits would
    // otherwise look like "no recent poller activity" and mask a dead webhook.
    // notion_poll_run audit rows are stamped at real run time and carry the
    // inserted count, so a run that ingested >0 edits proves activity is happening.
    const { rows: pollerActivityRows } = await db.query(
      `SELECT COUNT(*) AS c FROM system_audit_log
       WHERE event_type = 'notion_poll_run'
         AND created_at > $1
         AND COALESCE((detail->>'inserted')::int, 0) > 0`,
      [sinceIso],
    );
    const pollerInsertedRuns = Number(pollerActivityRows[0]?.c ?? 0);

    // Poller liveness: require a *successful* poll trigger (HTTP 2xx). This catches
    // both "the cron never fired" and "the cron fired but the route keeps erroring"
    // — a poll that 500s logs cron_route_triggered with status='error'.
    const { rows: pollRunRows } = await db.query(
      `SELECT COUNT(*) AS runs FROM system_audit_log
       WHERE event_type = 'cron_route_triggered'
         AND status = 'success'
         AND detail->>'path' = '/api/notion/poll'
         AND created_at > $1`,
      [sinceIso],
    );
    const pollerRuns = Number(pollRunRows[0]?.runs ?? 0);

    // ── Webhook-down detection (poller is ingesting activity, webhook is not) ──
    const webhookDown = pollerInsertedRuns > 0 && webhookEvents === 0;
    const webhookIncidentActive = await notionIncidentActive(
      db, 'notion_webhook_down_alert', 'notion_webhook_recovered', NOTION_WEBHOOK_DOWN_KEY,
    );

    if (webhookDown) {
      console.log(`[notion-webhook-health] Webhook DOWN — poller_inserted_runs=${pollerInsertedRuns}, webhook=0 in last ${NOTION_HEALTH_WINDOW_MINUTES} min`);
      await logAudit('notion-webhook-health-monitor', {
        category: 'automation', event_type: 'notion_webhook_health_check', severity: 'error',
        actor_id: 'system', actor_name: 'Notion Webhook Health Monitor', channel: 'cron',
        summary: `Notion webhook appears DOWN — poller ingested new activity (${pollerInsertedRuns} run(s)) but 0 webhook events in last ${NOTION_HEALTH_WINDOW_MINUTES} min`,
        detail: { webhook_events: webhookEvents, poller_inserted_runs: pollerInsertedRuns, window_minutes: NOTION_HEALTH_WINDOW_MINUTES },
        status: 'error',
      });

      if (!webhookIncidentActive) {
        const msg =
          `⚠️ *Notion Webhook Alert*\n\n` +
          `The Notion webhook appears to be down. The poller is still ingesting Notion activity ` +
          `in the last ${NOTION_HEALTH_WINDOW_MINUTES} min but *0* live webhook events have arrived.\n\n` +
          `Reconnect it in Notion → your integration → Webhooks, pointing to:\n${NOTION_WEBHOOK_URL}\n\n` +
          `The Activity chart keeps updating via the poller in the meantime, but real-time detail is paused until it's reconnected.`;
        let waSent = false;
        try {
          await sendWhatsApp(msg);
          waSent = true;
          console.log('[notion-webhook-health] WhatsApp alert sent — new webhook-down incident.');
        } catch (e: any) {
          console.error('[notion-webhook-health] WhatsApp send failed:', e.message);
        }
        if (waSent) {
          await logAudit('notion-webhook-health-monitor', {
            category: 'automation', event_type: 'notion_webhook_down_alert', severity: 'error',
            actor_id: 'system', actor_name: 'Notion Webhook Health Monitor', channel: 'cron',
            summary: `🚨 Notion webhook down — poller ingesting activity but no webhook events`,
            detail: { alert_key: NOTION_WEBHOOK_DOWN_KEY, webhook_events: webhookEvents, poller_inserted_runs: pollerInsertedRuns },
            status: 'error',
          });
        }
      } else {
        console.log('[notion-webhook-health] Webhook down but incident already active — skipping WhatsApp.');
      }
    } else if (webhookEvents > 0 && webhookIncidentActive) {
      await logAudit('notion-webhook-health-monitor', {
        category: 'automation', event_type: 'notion_webhook_recovered', severity: 'info',
        actor_id: 'system', actor_name: 'Notion Webhook Health Monitor', channel: 'cron',
        summary: `✅ Notion webhook recovered — live events flowing again`,
        detail: { alert_key: NOTION_WEBHOOK_DOWN_KEY, webhook_events: webhookEvents, poller_inserted_runs: pollerInsertedRuns },
        status: 'success',
      });
      console.log('[notion-webhook-health] Recovery logged — webhook incident resolved.');
    }

    // ── Poller-cron-alive detection (the safety net must keep running) ──
    const pollerDown = pollerRuns === 0;
    const pollerIncidentActive = await notionIncidentActive(
      db, 'notion_poller_down_alert', 'notion_poller_recovered', NOTION_POLLER_DOWN_KEY,
    );

    if (pollerDown) {
      console.log(`[notion-webhook-health] Poller cron has NOT fired in last ${NOTION_HEALTH_WINDOW_MINUTES} min`);
      await logAudit('notion-webhook-health-monitor', {
        category: 'automation', event_type: 'notion_poller_health_check', severity: 'error',
        actor_id: 'system', actor_name: 'Notion Webhook Health Monitor', channel: 'cron',
        summary: `Notion poller cron has not fired in the last ${NOTION_HEALTH_WINDOW_MINUTES} min`,
        detail: { poller_runs: pollerRuns, window_minutes: NOTION_HEALTH_WINDOW_MINUTES },
        status: 'error',
      });

      if (!pollerIncidentActive) {
        const msg =
          `⚠️ *Notion Poller Alert*\n\n` +
          `The Notion activity poller (the webhook safety net) has not run in the last ${NOTION_HEALTH_WINDOW_MINUTES} minutes. ` +
          `If the webhook is also down, the Activity chart will stop updating. Check the cron scheduler / deployment.`;
        let waSent = false;
        try {
          await sendWhatsApp(msg);
          waSent = true;
          console.log('[notion-webhook-health] WhatsApp alert sent — new poller-down incident.');
        } catch (e: any) {
          console.error('[notion-webhook-health] WhatsApp send failed:', e.message);
        }
        if (waSent) {
          await logAudit('notion-webhook-health-monitor', {
            category: 'automation', event_type: 'notion_poller_down_alert', severity: 'error',
            actor_id: 'system', actor_name: 'Notion Webhook Health Monitor', channel: 'cron',
            summary: `🚨 Notion poller cron stopped firing`,
            detail: { alert_key: NOTION_POLLER_DOWN_KEY, poller_runs: pollerRuns },
            status: 'error',
          });
        }
      } else {
        console.log('[notion-webhook-health] Poller down but incident already active — skipping WhatsApp.');
      }
    } else if (pollerRuns > 0 && pollerIncidentActive) {
      await logAudit('notion-webhook-health-monitor', {
        category: 'automation', event_type: 'notion_poller_recovered', severity: 'info',
        actor_id: 'system', actor_name: 'Notion Webhook Health Monitor', channel: 'cron',
        summary: `✅ Notion poller cron firing again`,
        detail: { alert_key: NOTION_POLLER_DOWN_KEY, poller_runs: pollerRuns },
        status: 'success',
      });
    }

    return res.json({
      webhook_events: webhookEvents,
      poller_inserted_runs: pollerInsertedRuns,
      poller_runs: pollerRuns,
      webhook_down: webhookDown,
      poller_down: pollerDown,
      window_minutes: NOTION_HEALTH_WINDOW_MINUTES,
    });
  } catch (err: any) {
    console.error('[notion-webhook-health-monitor] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HA Workflow Trigger Reconciler ───────────────────────────────────────────
// Checks that every Club34 workflow rule's HA automation(s) still exist and
// re-deploys any that are missing. Runs every 30 min via cron.

// ── HA Workflow Trigger Status (UI polling) ──────────────────────────────────
// Lightweight read-only endpoint that the Automations page polls every ~60s to
// show per-rule health badges and the last auto-heal timestamp without having
// to dig through the audit log.
router.get('/api/ha-workflow-status', async (_req: any, res: any) => {
  try {
    const { fetchAutomationMap } = await import('../lib/workflowReconciler.js');
    const { query } = await import('../lib/db.js');

    const haConfigured = !!process.env.HA_URL && !!process.env.HA_TOKEN;

    let automations: Map<string, string> | null = null;
    let haError: string | null = null;
    if (haConfigured) {
      try {
        automations = await fetchAutomationMap();
      } catch (err: any) {
        haError = err?.message ?? String(err);
      }
    }

    // Pull most-recent auto-heal timestamp per rule from the audit log.
    const healMap = new Map<string, string>();
    try {
      const { rows } = await query<CreatedAtRow & { rule_id: string | null }>(
        `SELECT DISTINCT ON (detail->>'rule_id')
                detail->>'rule_id' AS rule_id,
                created_at
         FROM system_audit_log
         WHERE event_type = 'workflow_trigger_redeployed'
         ORDER BY detail->>'rule_id', created_at DESC`,
      );
      for (const r of rows) {
        if (r.rule_id && r.created_at) {
          const ts = r.created_at instanceof Date
            ? r.created_at.toISOString()
            : new Date(r.created_at).toISOString();
          healMap.set(r.rule_id, ts);
        }
      }
    } catch {
      // non-fatal
    }

    // Most recent reconciler run (success or error)
    let lastReconcileRunAt: string | null = null;
    try {
      const { rows } = await query<CreatedAtRow>(
        `SELECT created_at FROM system_audit_log
         WHERE event_type = 'workflow_reconcile_run'
         ORDER BY created_at DESC LIMIT 1`,
      );
      if (rows[0]?.created_at) {
        lastReconcileRunAt = rows[0].created_at instanceof Date
          ? rows[0].created_at.toISOString()
          : new Date(rows[0].created_at).toISOString();
      }
    } catch {
      // non-fatal
    }

    const rules = WORKFLOW_RULES.map((rule) => {
      const forwardId = `club34_${rule.id}`;
      const reverseId = `club34_${rule.id}__reverse`;

      const forwardState = automations?.get(forwardId) ?? null;
      const reverseState = rule.bidirectional ? (automations?.get(reverseId) ?? null) : null;

      const forwardExists = forwardState !== null;
      const reverseExists = rule.bidirectional ? reverseState !== null : true;

      let status: 'live' | 'missing' | 'error' | 'unknown';
      if (!haConfigured || haError) status = 'error';
      else if (!automations) status = 'unknown';
      else if (forwardExists && reverseExists && forwardState === 'on' &&
               (!rule.bidirectional || reverseState === 'on')) status = 'live';
      else status = 'missing';

      return {
        ruleId: rule.id,
        name: rule.name,
        bidirectional: rule.bidirectional,
        forwardAutomationId: forwardId,
        reverseAutomationId: rule.bidirectional ? reverseId : null,
        forwardExists,
        forwardState,
        reverseExists,
        reverseState,
        status,
        lastAutoHealedAt: healMap.get(rule.id) ?? null,
      };
    });

    res.json({
      haConfigured,
      haError,
      lastReconcileRunAt,
      rules,
    });
  } catch (err: any) {
    console.error('[ha-workflow-status] Error:', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

router.post('/api/ha-workflow-reconciler', requireAuth, async (_req: any, res: any) => {
  const t0 = Date.now();
  try {
    const { reconcileWorkflowTriggers } = await import('../lib/workflowReconciler.js');
    const result = await reconcileWorkflowTriggers();

    const durationMs = Date.now() - t0;
    const { checked, redeployed, skipped, errors } = result;

    const summary = redeployed.length > 0
      ? `Re-deployed ${redeployed.length} missing automation(s): ${redeployed.map(r => r.automationId).join(', ')}`
      : errors.length > 0
        ? `Reconcile complete — ${errors.length} error(s) encountered`
        : `All ${checked} workflow rule(s) verified — no missing automations`;

    await logAudit('ha-workflow-reconciler', {
      category: 'automations',
      event_type: 'workflow_reconcile_run',
      severity: errors.length > 0 ? 'warn' : 'info',
      actor_id: 'system',
      actor_name: 'Workflow Reconciler',
      channel: 'cron',
      summary,
      detail: { checked, redeployed, skipped, errors },
      status: errors.length > 0 ? 'error' : 'success',
      duration_ms: durationMs,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    console.log(`[ha-workflow-reconciler] ${summary} (${durationMs}ms)`);
    res.json({ ok: true, ...result, duration_ms: durationMs });
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    console.error('[ha-workflow-reconciler] Unhandled error:', err.message ?? err);
    await logAudit('ha-workflow-reconciler', {
      category: 'automations',
      event_type: 'workflow_reconcile_run',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'Workflow Reconciler',
      channel: 'cron',
      summary: `Workflow reconciler error: ${err.message ?? String(err)}`,
      detail: { error: err.message ?? String(err) },
      status: 'error',
      duration_ms: durationMs,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
    res.status(500).json({ error: err.message ?? String(err) });
  }
});

// ── Dependency Security Audit Monitor ───────────────────────────────────────
// Runs `npm audit --json --omit=dev` on a daily schedule (see cron.ts), logs a
// snapshot of the vulnerability counts to the audit log, and fires a WhatsApp
// alert when NEW high/critical advisories appear. Dedup is keyed on a hash of
// the sorted set of high+critical package names so an identical advisory set
// only alerts once per dedup window — but the moment a new high/critical vuln
// shows up the key changes and a fresh alert goes out. This is the CI-style
// check that catches the next 34-vuln backlog before it piles up silently.
const SECURITY_AUDIT_DEDUP_HOURS = 24;

async function runNpmAudit(): Promise<any> {
  // npm audit exits non-zero when vulnerabilities are found, which makes
  // execFile reject — but the JSON report is still on stdout of the error.
  try {
    const { stdout } = await execFileAsync('npm', ['audit', '--json', '--omit=dev'], {
      cwd: process.cwd(),
      timeout: 120_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err: any) {
    if (err && typeof err.stdout === 'string' && err.stdout.trim().startsWith('{')) {
      return JSON.parse(err.stdout);
    }
    throw err;
  }
}

router.post('/api/security-audit-monitor', requireAuth, async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const report = await runNpmAudit();
    const counts = (report?.metadata?.vulnerabilities ?? {}) as Record<string, number>;
    const high = Number(counts.high ?? 0);
    const critical = Number(counts.critical ?? 0);
    const moderate = Number(counts.moderate ?? 0);
    const low = Number(counts.low ?? 0);
    const total = Number(counts.total ?? high + critical + moderate + low);

    // Collect the package names behind every high/critical advisory.
    const advisories = (report?.vulnerabilities ?? {}) as Record<string, any>;
    const severePackages = Object.values(advisories)
      .filter((a: any) => a && (a.severity === 'high' || a.severity === 'critical'))
      .map((a: any) => `${a.name}:${a.severity}`)
      .sort();

    const severeCount = high + critical;
    const durationMs = Date.now() - t0;

    // Always write a snapshot row so the Automations UI shows the check ran.
    await logAudit('security-audit-monitor', {
      category: 'system',
      event_type: 'security_audit_run',
      severity: severeCount > 0 ? 'warn' : 'info',
      actor_id: 'system',
      actor_name: 'Dependency Audit Monitor',
      channel: 'cron',
      summary: severeCount > 0
        ? `npm audit: ${critical} critical, ${high} high (+${moderate} moderate, ${low} low)`
        : `npm audit clean of high-severity issues (${moderate} moderate, ${low} low)`,
      detail: { critical, high, moderate, low, total, severe_packages: severePackages },
      status: 'success',
      duration_ms: durationMs,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    let alerted = false;
    if (severeCount > 0) {
      // Dedup key = hash of the sorted high/critical package set. New advisory
      // set ⇒ new key ⇒ new alert; identical set within the window is suppressed.
      const dedupKey = `secaudit_${createHash('sha256').update(severePackages.join('|')).digest('hex').slice(0, 16)}`;
      const { rows: recent } = await storage.query(
        `SELECT id FROM system_audit_log
           WHERE event_type = 'security_audit_alert'
             AND detail->>'alert_key' = $1
             AND created_at > NOW() - INTERVAL '${SECURITY_AUDIT_DEDUP_HOURS} hours'
           LIMIT 1`,
        [dedupKey]
      );

      if (recent.length === 0) {
        const topList = severePackages.slice(0, 10).join(', ');
        const summary = `🔒 npm audit found ${critical} critical / ${high} high-severity dependency advisor${severeCount === 1 ? 'y' : 'ies'}: ${topList}${severePackages.length > 10 ? ` (+${severePackages.length - 10} more)` : ''}`;
        await logAudit('security-audit-monitor', {
          category: 'system',
          event_type: 'security_audit_alert',
          severity: critical > 0 ? 'error' : 'warn',
          actor_id: 'system',
          actor_name: 'Dependency Audit Monitor',
          channel: 'cron',
          summary,
          detail: { alert_key: dedupKey, critical, high, severe_packages: severePackages },
          status: critical > 0 ? 'error' : 'warn',
        }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

        try {
          await sendWhatsApp(`${summary}\n\nRun \`npm audit\` and patch with \`npm audit fix\`.`);
          alerted = true;
        } catch (waErr: any) {
          console.warn('[security-audit-monitor] WhatsApp alert failed:', waErr?.message ?? waErr);
        }
      } else {
        console.log('[security-audit-monitor] Severe advisories unchanged within dedup window — skipping WhatsApp.');
      }
    }

    res.json({ success: true, counts: { critical, high, moderate, low, total }, severe_packages: severePackages, alerted });
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    console.error('[security-audit-monitor] Error:', err?.message ?? err);
    await logAudit('security-audit-monitor', {
      category: 'system',
      event_type: 'security_audit_run',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'Dependency Audit Monitor',
      channel: 'cron',
      summary: `Dependency audit failed to run: ${err?.message ?? String(err)}`,
      detail: { error: err?.message ?? String(err) },
      status: 'error',
      duration_ms: durationMs,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

// ── HA Door Locks & Battery Monitor ──────────────────────────────────────────
// Inspects all lock.* entities and companion battery sensors from Home Assistant.
// Checks for jammed locks, offline/unavailable states, and low battery (<20% warning, <10% critical).
// Alerts via WhatsApp to Tony with a 24-hour deduplication window.
const LOCKS_AUDIT_KEY = 'ha_locks_alert';
const LOCKS_DEDUP_HOURS = 24;

router.post('/api/ha-locks-monitor', async (_req: any, res: any) => {
  const t0 = Date.now();
  try {
    const db = storage;
    const { rows: [automation] } = await db.query(
      `SELECT id, is_active FROM family_automations WHERE name = 'Door Locks & Battery Monitor' LIMIT 1`
    );
    if (automation && !automation.is_active) {
      return res.json({ skipped: true, reason: 'Automation is disabled' });
    }

    const allStates = await callHAProxy({ action: 'get-states' });
    if (!Array.isArray(allStates)) {
      throw new Error('Expected array of states from Home Assistant');
    }

    const lockEntities = allStates.filter(s => s.entity_id.startsWith('lock.'));
    const locksSummary: Array<{
      entity_id: string;
      name: string;
      state: string;
      room?: string;
      battery?: number;
      connection_status?: string;
      crestron_id?: number;
      issue?: string;
    }> = [];

    const issues: string[] = [];
    let hasCritical = false;

    for (const lock of lockEntities) {
      const name = (lock.attributes?.friendly_name as string) || lock.entity_id;
      const room = lock.attributes?.room_name as string | undefined;
      const connectionStatus = (lock.attributes?.connection_status as string) || (lock.state === 'unavailable' ? 'offline' : 'online');
      const crestronId = lock.attributes?.crestron_id as number | undefined;

      // Check battery from lock attributes or companion sensor
      let battery: number | undefined;
      const rawAttrBattery = lock.attributes?.battery_level ?? lock.attributes?.battery;
      if (typeof rawAttrBattery === 'number') {
        battery = rawAttrBattery;
      } else {
        const cleanLockId = lock.entity_id.replace('lock.', '');
        const companion = allStates.find(s =>
          s.entity_id.startsWith('sensor.') &&
          s.entity_id.includes(cleanLockId) &&
          (s.entity_id.includes('battery') || s.attributes?.device_class === 'battery')
        );
        if (companion && !isNaN(parseFloat(companion.state))) {
          battery = parseFloat(companion.state);
        }
      }

      let issue: string | undefined;
      if (lock.state === 'jammed') {
        issue = 'Lock is jammed';
        issues.push(`🚨 ${name}: JAMMED`);
        hasCritical = true;
      } else if (lock.state === 'unavailable' || connectionStatus === 'offline') {
        issue = 'Lock is offline / unavailable';
        issues.push(`⚠️ ${name}: Offline / Unavailable`);
      } else if (battery !== undefined) {
        if (battery < 10) {
          issue = `Battery critically low (${battery}%)`;
          issues.push(`🚨 ${name}: Battery Critical (${battery}%)`);
          hasCritical = true;
        } else if (battery < 20) {
          issue = `Battery low (${battery}%)`;
          issues.push(`⚠️ ${name}: Battery Low (${battery}%)`);
        }
      }

      locksSummary.push({
        entity_id: lock.entity_id,
        name,
        state: lock.state,
        room,
        battery,
        connection_status: connectionStatus,
        crestron_id: crestronId,
        issue,
      });
    }

    let alertSent = false;
    const durationMs = Date.now() - t0;

    if (issues.length > 0) {
      const { rows: recent } = await db.query(
        `SELECT id FROM system_audit_log
         WHERE event_type = $1
           AND detail->>'alert_key' = $2
           AND created_at > NOW() - INTERVAL '${LOCKS_DEDUP_HOURS} hours'
         LIMIT 1`,
        ['ha_locks_alert', LOCKS_AUDIT_KEY]
      );

      if (recent.length === 0) {
        const lines = [
          `🔒 *Door Locks & Battery Alert*`,
          ``,
          `The following issue(s) were detected on household door locks:`,
          ...issues.map(i => `• ${i}`),
          ``,
          `*Lock Status Summary:*`,
          ...locksSummary.map(l => `- ${l.name}: ${l.state.toUpperCase()}${l.battery !== undefined ? ` (${l.battery}% batt)` : ` (${l.connection_status || 'online'})`}`),
          ``,
          `Check Club 34 Security dashboard for status:`,
          `https://example.com/security`,
        ];
        const msg = lines.join('\n');

        try {
          await sendWhatsApp(msg);
          alertSent = true;
          console.log('[ha-locks-monitor] WhatsApp alert sent to Tony.');
        } catch (waErr: any) {
          console.error('[ha-locks-monitor] WhatsApp send failed:', waErr.message);
        }

        await logAudit('ha-locks-monitor', {
          category: 'security',
          event_type: 'ha_locks_alert',
          severity: hasCritical ? 'critical' : 'warning',
          actor_id: 'system',
          actor_name: 'HA Locks Monitor',
          channel: 'cron',
          summary: `Door Locks Alert: ${issues.join('; ')}`,
          detail: { alert_key: LOCKS_AUDIT_KEY, issues, locks: locksSummary },
          status: 'warning',
          duration_ms: durationMs,
        });
      } else {
        console.log('[ha-locks-monitor] Issues detected but alert already sent within 24hr dedup window — skipping WhatsApp.');
      }
    } else {
      const lockedCount = locksSummary.filter(l => l.state === 'locked').length;
      const summaryText = `All ${locksSummary.length} door locks operational (${lockedCount}/${locksSummary.length} locked, all online)`;
      await logAudit('ha-locks-monitor', {
        category: 'security',
        event_type: 'ha_locks_check',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'HA Locks Monitor',
        channel: 'cron',
        summary: summaryText,
        detail: { locks: locksSummary, total: locksSummary.length, locked: lockedCount },
        status: 'success',
        duration_ms: durationMs,
      });
    }

    const output = {
      ok: true,
      total: locksSummary.length,
      locks: locksSummary,
      issues,
      alert_sent: alertSent,
      duration_ms: durationMs,
    };

    if (automation) {
      await logRun(db, automation.id, issues.length > 0 ? 'warning' : 'success', output);
    }

    res.json(output);
  } catch (err: any) {
    const durationMs = Date.now() - t0;
    console.error('[ha-locks-monitor] Error:', err.message);
    await logAudit('ha-locks-monitor', {
      category: 'security',
      event_type: 'ha_locks_error',
      severity: 'error',
      actor_id: 'system',
      actor_name: 'HA Locks Monitor',
      channel: 'cron',
      summary: `HA locks monitor error: ${err.message}`,
      detail: { error: err.message },
      status: 'error',
      duration_ms: durationMs,
    }).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

export default router;
