import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { getAuthUser } from '../auth.js';
import { logAudit } from '../lib/auditLog.js';
import { safeErrorJson } from '../lib/errorSanitizer.js';
import { webcrypto } from 'crypto';
import { query } from '../lib/db.js';
import { pool } from '../db.js';
import { emitToAll } from '../socket.js';

const router = Router();

const VERKADA_BASE = 'https://api.verkada.com';
const SIGHTING_COOLDOWN_MS = 30 * 60 * 1000;

const sightingCooldown = new Map<string, number>();

let cachedToken: { token: string; expiresAt: number } | null = null;
let lastWebhookReceivedAt: number | null = null;

let cameraNameCache: { map: Map<string, string>; expiresAt: number } = {
  map: new Map(),
  expiresAt: 0,
};

async function getVerkadaToken(apiKey: string, orgId: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 2 * 60 * 1000) {
    return cachedToken.token;
  }

  const response = await fetch(`${VERKADA_BASE}/token`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id: orgId }),
  });

  const data = await response.json().catch(() => ({})) as any;

  if (!response.ok) {
    throw new Error(`Verkada auth failed (${response.status}): ${data.message || data.error || JSON.stringify(data)}`);
  }

  const token = data.token || data.access_token || data.jwt;
  if (!token) {
    throw new Error(`Unexpected Verkada /token response format. Keys: ${Object.keys(data).join(', ')}`);
  }

  cachedToken = { token, expiresAt: now + 28 * 60 * 1000 };
  return token;
}

function getVerkadaHeaders(token: string): Record<string, string> {
  return {
    'x-verkada-token': token,
    'x-verkada-auth': token,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function getCameraNameMap(): Promise<Map<string, string>> {
  if (cameraNameCache.expiresAt > Date.now() && cameraNameCache.map.size > 0) {
    return cameraNameCache.map;
  }

  const apiKey = process.env.VERKADA_API_KEY;
  const orgId = process.env.VERKADA_ORG_ID;
  if (!apiKey || !orgId) return cameraNameCache.map;

  try {
    const token = await getVerkadaToken(apiKey, orgId);
    const headers = getVerkadaHeaders(token);
    const res = await fetch(`${VERKADA_BASE}/cameras/v1/devices?org_id=${orgId}`, { headers });
    if (res.ok) {
      const data = await res.json() as any;
      const map = new Map<string, string>();
      for (const cam of (data.cameras || [])) {
        const id = cam.camera_id || cam.device_id;
        if (id && cam.name) map.set(id, cam.name);
      }
      cameraNameCache = { map, expiresAt: Date.now() + 10 * 60 * 1000 };
    }
  } catch (e) {
    console.error('Failed to refresh camera name cache:', e);
  }

  return cameraNameCache.map;
}

function toISO(ts: number | string | undefined, fallback?: number): string {
  if (!ts && !fallback) return new Date().toISOString();
  const v = ts || fallback!;
  if (typeof v === 'string') return new Date(v).toISOString();
  return new Date(v > 1e12 ? v : v * 1000).toISOString();
}


function getTodayStartLA(): string {
  const laDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const probe = new Date(`${laDateStr}T12:00:00Z`);
  const laHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(probe)
  );
  const offsetMs = (laHour - 12) * 3600000;
  const midnightLA = new Date(`${laDateStr}T00:00:00Z`);
  midnightLA.setTime(midnightLA.getTime() - offsetMs);
  return midnightLA.toISOString();
}

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKey = process.env.VERKADA_API_KEY;
    const orgId = process.env.VERKADA_ORG_ID;

    if (!apiKey) { res.status(500).json({ success: false, error: 'VERKADA_API_KEY not configured' }); return; }
    if (!orgId) { res.status(500).json({ success: false, error: 'VERKADA_ORG_ID not configured' }); return; }

    const verkadaToken = await getVerkadaToken(apiKey, orgId);
    const verkadaHeaders = getVerkadaHeaders(verkadaToken);

    const { action, ...params } = req.body;

    if (action === 'list-cameras') {
      const response = await fetch(`${VERKADA_BASE}/cameras/v1/devices?org_id=${orgId}`, { method: 'GET', headers: verkadaHeaders });
      const data = await response.json() as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true, cameras: data.cameras || [] });
      return;
    }

    if (action === 'camera-thumbnail') {
      const { camera_id } = params;
      if (!camera_id) { res.status(400).json({ success: false, error: 'camera_id is required' }); return; }
      const response = await fetch(`${VERKADA_BASE}/cameras/v1/footage/thumbnails/latest?org_id=${orgId}&camera_id=${camera_id}`, { method: 'GET', headers: verkadaHeaders });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as any;
        res.json({ success: false, error: data.message || `Verkada API error ${response.status}` });
        return;
      }
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      res.json({ success: true, thumbnail: `data:image/jpeg;base64,${base64}` });
      return;
    }

    if (action === 'camera-livestream-thumbnail') {
      const { camera_id } = params;
      if (!camera_id) { res.status(400).json({ success: false, error: 'camera_id is required' }); return; }
      const now = Math.floor(Date.now() / 1000);
      const response = await fetch(`${VERKADA_BASE}/cameras/v1/footage/thumbnails/latest?org_id=${orgId}&camera_id=${camera_id}&timestamp=${now}`, { method: 'GET', headers: verkadaHeaders });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as any;
        res.json({ success: false, error: data.message || `Verkada API error ${response.status}` });
        return;
      }
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      res.json({ success: true, thumbnail: `data:image/jpeg;base64,${base64}`, timestamp: now });
      return;
    }

    if (action === 'camera-stream-link') {
      const { camera_id } = params;
      if (!camera_id) { res.status(400).json({ success: false, error: 'camera_id is required' }); return; }
      const response = await fetch(`${VERKADA_BASE}/cameras/v1/footage/stream/link?org_id=${orgId}&camera_id=${camera_id}`, { method: 'GET', headers: verkadaHeaders });
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as any;
        res.json({ success: false, error: data.message || `Verkada API error ${response.status}` });
        return;
      }
      const data = await response.json() as any;
      const hlsUrl = data.url || data.hls_url || data.stream_url || data.link;
      if (!hlsUrl) {
        res.json({ success: false, error: 'No stream URL returned by Verkada API' });
        return;
      }
      res.json({ success: true, url: hlsUrl });
      return;
    }

    if (action === 'list-doors') {
      const response = await fetch(`${VERKADA_BASE}/access/v1/doors?org_id=${orgId}`, { method: 'GET', headers: verkadaHeaders });
      const data = await response.json() as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true, doors: data.doors || data });
      return;
    }

    if (action === 'unlock-door') {
      const { door_id } = params;
      if (!door_id) { res.status(400).json({ success: false, error: 'door_id is required' }); return; }
      const response = await fetch(`${VERKADA_BASE}/access/v1/door/admin_unlock?org_id=${orgId}`, {
        method: 'POST', headers: verkadaHeaders, body: JSON.stringify({ door_id }),
      });
      const data = await response.json().catch(() => ({})) as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true });
      return;
    }

    if (action === 'access-events') {
      const { start_time, end_time, page_size } = params;
      const qs = new URLSearchParams({ org_id: orgId });
      if (start_time) qs.append('start_time', start_time);
      if (end_time) qs.append('end_time', end_time);
      if (page_size) qs.append('page_size', String(page_size));
      const response = await fetch(`${VERKADA_BASE}/events/v1/access?${qs.toString()}`, { method: 'GET', headers: verkadaHeaders });
      const data = await response.json() as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true, events: data.events || data });
      return;
    }

    if (action === 'list-alarms') {
      const response = await fetch(`${VERKADA_BASE}/alarms/v1/sites?org_id=${orgId}`, { method: 'GET', headers: verkadaHeaders });
      const data = await response.json() as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true, sites: data.sites || data });
      return;
    }

    if (action === 'person-of-interest') {
      const response = await fetch(`${VERKADA_BASE}/cameras/v1/people/person_of_interest?org_id=${orgId}`, { method: 'GET', headers: verkadaHeaders });
      const data = await response.json() as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true, persons: data.persons_of_interest || data.persons || data });
      return;
    }

    if (action === 'people-counts') {
      const { camera_id, start_time, end_time } = params;
      if (!camera_id) { res.status(400).json({ success: false, error: 'camera_id is required' }); return; }
      const qs = new URLSearchParams({ org_id: orgId, camera_id });
      if (start_time) qs.append('start_time', start_time);
      if (end_time) qs.append('end_time', end_time);
      const response = await fetch(`${VERKADA_BASE}/cameras/v1/analytics/object_counts?${qs.toString()}`, { method: 'GET', headers: verkadaHeaders });
      const data = await response.json() as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true, counts: data });
      return;
    }

    if (action === 'get-alerts') {
      const { start_time, end_time, alert_type, page_size } = params;
      const qs = new URLSearchParams({ org_id: orgId });
      if (start_time) qs.append('start_time', start_time);
      if (end_time) qs.append('end_time', end_time);
      // Verkada's GET /cameras/v1/alerts filters by `notification_type`
      // (e.g. person_of_interest, motion, crowd, tamper).
      if (alert_type) qs.append('notification_type', alert_type);
      if (page_size) qs.append('page_size', String(page_size));

      const response = await fetch(`${VERKADA_BASE}/cameras/v1/alerts?${qs.toString()}`, { method: 'GET', headers: verkadaHeaders });
      const data = await response.json().catch(() => ({})) as any;
      if (!response.ok) { res.json({ success: false, error: data.message || `Verkada API error ${response.status}` }); return; }
      res.json({ success: true, alerts: data.notifications || data.alerts || data.events || data.detections || [] });
      return;
    }

    res.status(400).json({ success: false, error: `Invalid action: ${action}` });
  } catch (error) {
    console.error('Verkada proxy error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.post('/poi-sync', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const startTime = Date.now();
  const authUser = getAuthUser(req);
  const actorId = authUser?.userId || req.userId || 'UNKNOWN';
  const actorName = authUser?.displayName || authUser?.email || 'UNKNOWN';

  try {
    const result = await runPoiRosterSync();
    const durationMs = Date.now() - startTime;

    if (result.skipped) {
      // Credentials not configured — return success silently. No audit
      // row is written here: logging a skip on every cron tick would
      // produce the same noisy accumulation as the error it replaced.
      // The console.log inside runPoiRosterSync() is enough for server logs.
      res.json({ skipped: true, profiles_synced: 0, duration_ms: durationMs });
      return;
    }

    logAudit('verkada-poi-sync', {
      category: 'security', event_type: 'verkada_poi_sync', severity: 'info',
      actor_id: actorId, actor_name: actorName, channel: 'web',
      summary: `Synced ${result.profilesSynced} profiles`,
      detail: { ...result, duration_ms: durationMs },
      status: 'success', duration_ms: durationMs,
    });

    res.json({ profiles_synced: result.profilesSynced, duration_ms: durationMs });
  } catch (e) {
    const durationMs = Date.now() - startTime;
    console.error('verkada-poi-sync error:', e);
    logAudit('verkada-poi-sync', {
      category: 'security', event_type: 'verkada_poi_sync_error', severity: 'error',
      actor_id: actorId, actor_name: actorName, channel: 'web',
      summary: `Error: ${e instanceof Error ? e.message : 'Unknown'}`,
      status: 'error', duration_ms: durationMs,
    });
    res.status(500).json({ error: e instanceof Error ? e.message : 'Unknown error' });
  }
});

/**
 * Upsert a POI profile, merging duplicates by label.
 * If a profile with the same label (case-insensitive, trimmed) already exists,
 * we update it rather than creating a new row. This prevents duplicate profiles
 * for the same person when Verkada assigns different person_ids across code paths.
 */
async function upsertPoiProfile(
  verkadaPersonId: string,
  label: string | null,
  thumbnailUrl: string | null,
  lastSeenAt: string | null
): Promise<void> {
  const trimmedLabel = label ? label.trim() : null;

  if (trimmedLabel) {
    // Try to find an existing profile with matching label (case-insensitive)
    // Order deterministically by most recent last_seen_at to pick the canonical profile
    const { rows: existing } = await query(
      `SELECT verkada_person_id FROM poi_profiles WHERE LOWER(TRIM(label)) = LOWER($1) ORDER BY last_seen_at DESC NULLS LAST LIMIT 1`,
      [trimmedLabel]
    );

    if (existing.length > 0 && existing[0].verkada_person_id !== verkadaPersonId) {
      const canonicalId = existing[0].verkada_person_id as string;
      // Merge into the canonical profile atomically, keeping the most recent thumbnail
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Use incoming thumbnail if it's newer than current or canonical has none
        await client.query(
          `UPDATE poi_profiles
           SET thumbnail_url = CASE
                 WHEN $1 IS NOT NULL AND (
                   thumbnail_url IS NULL OR
                   ($2::timestamptz IS NOT NULL AND last_seen_at IS NOT NULL AND $2::timestamptz > last_seen_at)
                 ) THEN $1
                 ELSE COALESCE(thumbnail_url, $1)
               END,
               last_seen_at = COALESCE(GREATEST(last_seen_at, $2::timestamptz), last_seen_at, $2::timestamptz)
           WHERE verkada_person_id = $3`,
          [thumbnailUrl, lastSeenAt, canonicalId]
        );
        await client.query(
          `UPDATE verkada_events SET person_id = $1 WHERE person_id = $2`,
          [canonicalId, verkadaPersonId]
        );
        // Remove the incoming duplicate profile if it already exists as a separate row
        await client.query(
          `DELETE FROM poi_profiles WHERE verkada_person_id = $1`,
          [verkadaPersonId]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
      return;
    }
  }

  // Standard upsert by verkada_person_id
  await query(
    `INSERT INTO poi_profiles (verkada_person_id, label, thumbnail_url, last_seen_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (verkada_person_id) DO UPDATE
       SET label = COALESCE(EXCLUDED.label, poi_profiles.label),
           thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, poi_profiles.thumbnail_url),
           last_seen_at = COALESCE(GREATEST(poi_profiles.last_seen_at, EXCLUDED.last_seen_at), poi_profiles.last_seen_at, EXCLUDED.last_seen_at)`,
    [verkadaPersonId, trimmedLabel, thumbnailUrl, lastSeenAt]
  );
}

/**
 * Deduplicate poi_profiles by label: consolidate rows sharing the same label
 * into a single row (keeping best thumbnail and latest last_seen_at),
 * and update verkada_events references to use the canonical person_id.
 */
async function deduplicatePoiProfiles(): Promise<void> {
  try {
    // Find groups of profiles sharing the same normalized label
    const { rows: duplicateGroups } = await query(
      `SELECT LOWER(TRIM(label)) as norm_label, array_agg(verkada_person_id ORDER BY last_seen_at DESC NULLS LAST) as ids
       FROM poi_profiles
       WHERE label IS NOT NULL AND label != ''
       GROUP BY LOWER(TRIM(label))
       HAVING COUNT(*) > 1`
    );

    for (const group of duplicateGroups) {
      const [canonicalId, ...duplicateIds] = group.ids as string[];
      if (!duplicateIds.length) continue;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Update canonical profile: pick most-recent thumbnail from all profiles in the group
        // (canonical + duplicates), and use latest last_seen_at across all
        const allIds = [canonicalId, ...duplicateIds];
        await client.query(
          `UPDATE poi_profiles
           SET thumbnail_url = (
                 SELECT thumbnail_url FROM poi_profiles
                 WHERE verkada_person_id = ANY($1) AND thumbnail_url IS NOT NULL
                 ORDER BY last_seen_at DESC NULLS LAST
                 LIMIT 1
               ),
               last_seen_at = (
                 SELECT MAX(last_seen_at) FROM poi_profiles WHERE verkada_person_id = ANY($1)
               )
           WHERE verkada_person_id = $2`,
          [allIds, canonicalId]
        );

        // Re-point events from duplicate IDs to canonical
        await client.query(
          `UPDATE verkada_events SET person_id = $1 WHERE person_id = ANY($2)`,
          [canonicalId, duplicateIds]
        );

        // Remove duplicate profiles
        await client.query(
          `DELETE FROM poi_profiles WHERE verkada_person_id = ANY($1)`,
          [duplicateIds]
        );

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        console.error(`[verkada] Dedup transaction failed for label "${group.norm_label}":`, txErr);
        continue;
      } finally {
        client.release();
      }

      console.log(`[verkada] Merged ${duplicateIds.length} duplicate profile(s) for label "${group.norm_label}" into ${canonicalId}`);
    }

    if (duplicateGroups.length > 0) {
      console.log(`[verkada] Profile deduplication complete: processed ${duplicateGroups.length} label group(s)`);
    }
  } catch (e) {
    console.error('[verkada] Profile deduplication error:', e);
  }
}

async function verifyVerkadaSignature(rawBody: Buffer, sigHeader: string, secret: string): Promise<boolean> {
  try {
    const [timestampStr, signature] = sigHeader.split('|');
    if (!timestampStr || !signature) return false;
    const ts = parseInt(timestampStr, 10);
    if (Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const encoder = new TextEncoder();
    const toHash = Buffer.concat([rawBody, encoder.encode('|') as any, encoder.encode(timestampStr) as any]);
    const key = await webcrypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await webcrypto.subtle.sign('HMAC', key, toHash);
    const expected = Buffer.from(sig).toString('hex');

    if (expected.length !== signature.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return mismatch === 0;
  } catch { return false; }
}

router.post('/poi-webhook', async (req: Request, res: Response) => {
  try {
    const rawBody: Buffer = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
    const payload = req.body;

    const sharedSecret = process.env.VERKADA_WEBHOOK_SECRET;
    const sigHeader = (req.headers['verkada-signature'] || req.headers['Verkada-Signature']) as string | undefined;

    if (sharedSecret && sigHeader) {
      const valid = await verifyVerkadaSignature(rawBody, sigHeader, sharedSecret);
      if (!valid) {
        console.warn('[verkada] Webhook rejected — invalid signature from', req.ip);
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    } else if (sharedSecret && !sigHeader) {
      console.warn('[verkada] Webhook rejected — missing signature header from', req.ip);
      res.status(401).json({ error: 'Unauthorized: Missing signature' });
      return;
    }

    lastWebhookReceivedAt = Date.now();

    const webhookType = (payload.webhook_type || '').toLowerCase();
    const data = payload.data || {};
    const createdAt = payload.created_at || Math.floor(Date.now() / 1000);

    const cameraMap = await getCameraNameMap();
    const cameraId = data.camera_id || data.device_id || null;
    const cameraName = data.camera_name || data.device_name || (cameraId ? cameraMap.get(cameraId) : null) || cameraId || 'Unknown Camera';
    const notificationType = (data.notification_type || '').toLowerCase();

    const personId = data.person_id || data.person_of_interest_id || data.poi_id;
    if (personId || notificationType === 'person_of_interest') {
      const pid = personId || 'unknown';
      const label = data.label || data.person_label || data.name || null;
      const thumbnailUrl = data.thumbnail_url || data.image_url || null;
      const ts = data.timestamp || data.created || data.detected_at || createdAt;
      const occurredAt = toISO(ts);
      const dedupKey = `poi_${pid}_${cameraId || 'unknown'}_${ts}`;

      let eventInserted = false;
      try {
        const evRes = await query(
          `INSERT INTO verkada_events (event_type, person_id, person_label, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dedup_key) DO NOTHING`,
          ['person_of_interest', pid, label, cameraId, cameraName, occurredAt, dedupKey, JSON.stringify(data)]
        );
        eventInserted = (evRes.rowCount ?? 0) > 0;
      } catch (dbErr) { console.error('[verkada] Failed to insert POI event:', dbErr); }

      await upsertPoiProfile(pid, label, thumbnailUrl, occurredAt);

      let sightingInserted = false;
      let sightingDropReason: string | null = null;
      try {
        const sightRes = await query(
          `INSERT INTO poi_sightings (verkada_person_id, label, seen_at, camera_name, thumbnail_url) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (verkada_person_id, seen_at, camera_name) DO NOTHING`,
          [pid, label, occurredAt, cameraName, thumbnailUrl]
        );
        sightingInserted = (sightRes.rowCount ?? 0) > 0;
        if (!sightingInserted) sightingDropReason = 'duplicate (person+time+camera)';
      } catch (sightErr: any) {
        sightingDropReason = `db_error: ${sightErr?.message || sightErr}`;
        console.error('[verkada] poi_sightings insert error:', sightErr);
      }

      console.log(
        `[verkada] webhook processed — type=${webhookType || 'poi'} person=${label || pid} camera=${cameraName}` +
        ` sighting=${sightingInserted ? 'inserted' : `skipped(${sightingDropReason})`}` +
        ` event=${eventInserted ? 'inserted' : 'dedup'}`
      );

      emitToAll('verkada:sighting', { personId: pid, label, cameraName, occurredAt });
      console.log(`[verkada] SIGHTING: ${label || pid} at ${cameraName}`);

      const cooldownKey = pid !== 'unknown' ? pid : (label || 'unknown');
      const now = Date.now();
      const lastNotified = sightingCooldown.get(cooldownKey) ?? 0;
      if (label && (now - lastNotified) > SIGHTING_COOLDOWN_MS) {
        sightingCooldown.set(cooldownKey, now);
        const timeStr = new Date(occurredAt).toLocaleString('en-US', {
          timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true,
        });
        const whatsappUrl = process.env.WHATSAPP_WEBHOOK_URL;
        if (whatsappUrl) {
          fetch(whatsappUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: `👁 ${label} seen at ${cameraName} at ${timeStr}` }),
          }).catch(err => console.error('[verkada] WhatsApp notification failed:', err));
        }
      }

      logAudit('verkada-poi-webhook', {
        category: 'security', event_type: 'verkada_poi_webhook', severity: 'info',
        actor_id: 'system', actor_name: 'Verkada', channel: 'webhook',
        summary: `${label || 'Unknown person'} seen at ${cameraName}`,
        detail: { person_id: pid, name: label, camera_name: cameraName, seen_at: occurredAt, sighting_inserted: sightingInserted, drop_reason: sightingDropReason },
        status: 'success',
      });

      res.json({ ok: true, action: 'poi', person_id: pid, name: label, sighting_inserted: sightingInserted });
      return;
    }

    const isVehicleMotionWithPlate =
      (notificationType === 'alert_rule_motion' || notificationType === 'alert_rule_line_crossing') &&
      Array.isArray(data.objects) && data.objects.includes('vehicle') &&
      !!data.license_plate_number;

    const isLpr =
      isVehicleMotionWithPlate ||
      notificationType === 'license_plate' ||
      notificationType === 'license_plate_of_interest' ||
      notificationType === 'lpr' ||
      notificationType.includes('license_plate') ||
      notificationType.includes('lpr') ||
      webhookType === 'lpr' ||
      webhookType === 'license_plate' ||
      webhookType.includes('lpr') ||
      webhookType.includes('license_plate') ||
      !!data.license_plate_number ||
      !!data.license_plate ||
      !!data.plate_number ||
      !!data.lpr_plate ||
      !!(data.lpr && (data.lpr.plate || data.lpr.plate_number));

    if (isLpr) {
      const plate = data.license_plate_number || data.license_plate || data.plate_number || data.lpr_plate || (data.lpr && (data.lpr.plate || data.lpr.plate_number)) || null;
      const plateState = data.license_plate_state || data.plate_state || (data.lpr && data.lpr.state) || null;
      const ts = data.timestamp || data.created || createdAt;
      const occurredAt = toISO(ts);
      const vehicleKey = plate || `unplated_${cameraId || 'unknown'}_${Math.floor(new Date(occurredAt).getTime() / (5 * 60 * 1000))}`;
      const dedupKey = `lpr_${vehicleKey}_${ts}`;
      let imageUrl = data.thumbnail_url || data.image_url || (data.lpr && (data.lpr.thumbnail_url || data.lpr.image_url || data.lpr.image)) || null;

      if (!imageUrl && cameraId) {
        const apiKey = process.env.VERKADA_API_KEY;
        const orgId = process.env.VERKADA_ORG_ID;
        if (apiKey && orgId) {
          try {
            const token = await Promise.race([
              getVerkadaToken(apiKey, orgId),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('token timeout')), 3000)),
            ]);
            const tsSeconds = typeof ts === 'number' ? (ts > 1e12 ? Math.floor(ts / 1000) : ts) : Math.floor(new Date(occurredAt).getTime() / 1000);
            const snapshotUrl = `${VERKADA_BASE}/cameras/v1/footage/thumbnails/latest?org_id=${orgId}&camera_id=${cameraId}&timestamp=${tsSeconds}`;
            const snapRes = await Promise.race([
              fetch(snapshotUrl, { headers: getVerkadaHeaders(token) }),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('snapshot timeout')), 5000)),
            ]);
            if (snapRes.ok) {
              const arrayBuffer = await snapRes.arrayBuffer();
              const base64 = Buffer.from(arrayBuffer).toString('base64');
              if (base64.length > 0 && base64.length < 200000) {
                imageUrl = `data:image/jpeg;base64,${base64}`;
                console.log(`[verkada] LPR snapshot fetched for camera ${cameraId} (${Math.round(base64.length / 1024)}KB)`);
              }
            }
          } catch (snapErr) {
            console.debug('[verkada] LPR snapshot fallback skipped:', (snapErr as Error).message);
          }
        }
      }

      try {
        await query(
          `INSERT INTO verkada_events (event_type, vehicle_plate, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (dedup_key) DO NOTHING`,
          ['license_plate', vehicleKey, cameraId, cameraName, occurredAt, dedupKey, JSON.stringify({ ...data, _image_url: imageUrl })]
        );
      } catch (dbErr) { console.error('[verkada] Failed to insert LPR event:', dbErr); }

      if (plate) {
        try {
          await query(
            `UPDATE vehicle_profiles SET last_seen_at = $1, last_seen_camera = $2, updated_at = now() WHERE UPPER(plate) = UPPER($3) AND (last_seen_at IS NULL OR last_seen_at < $1)`,
            [occurredAt, cameraName || null, plate]
          );
        } catch (vpErr) { console.error('[verkada] Failed to update vehicle_profile last_seen_at:', vpErr); }
      }

      emitToAll('verkada:vehicle', { plate, plateState, cameraName, occurredAt });
      res.json({ ok: true, action: 'license_plate', plate, plate_state: plateState });
      return;
    }

    if (notificationType === 'motion' || notificationType.includes('motion') || notificationType.includes('line_crossing') || webhookType.includes('motion')) {
      const ts = data.timestamp || data.created || createdAt;
      const occurredAt = toISO(ts);
      const dedupKey = `motion_${cameraId || 'unknown'}_${ts}`;

      try {
        await query(
          `INSERT INTO verkada_events (event_type, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedup_key) DO NOTHING`,
          ['motion', cameraId, cameraName, occurredAt, dedupKey, JSON.stringify(data)]
        );
      } catch (dbErr) { console.error('[verkada] Failed to insert motion event:', dbErr); }

      res.json({ ok: true, action: 'motion' });
      return;
    }

    const isCameraStatus = notificationType === 'camera_offline' || notificationType === 'camera_online' || notificationType === 'tamper';
    if (isCameraStatus) {
      const ts = data.timestamp || data.created || createdAt;
      const occurredAt = toISO(ts);
      const dedupKey = `status_${notificationType}_${cameraId || 'unknown'}_${ts}`;

      try {
        await query(
          `INSERT INTO verkada_events (event_type, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedup_key) DO NOTHING`,
          [notificationType, cameraId, cameraName, occurredAt, dedupKey, JSON.stringify(data)]
        );
      } catch (dbErr) { console.error('[verkada] Failed to insert camera status event:', dbErr); }

      emitToAll('verkada:camera-status', { cameraId, cameraName, status: notificationType, occurredAt });
      res.json({ ok: true, action: notificationType });
      return;
    }

    const isAlert = webhookType === 'notification' || webhookType.includes('alert') || data.alert_id || data.notification_id;
    if (isAlert) {
      const alertId = data.alert_id || data.id || `${cameraId || 'unknown'}_${createdAt}`;
      const alertType = data.alert_type || data.type || notificationType || webhookType || 'alert';
      const ts = data.timestamp || data.created || createdAt;
      const occurredAt = toISO(ts);
      const dedupKey = `alert_${alertId}`;

      try {
        await query(
          `INSERT INTO verkada_events (event_type, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedup_key) DO NOTHING`,
          [alertType, cameraId, cameraName, occurredAt, dedupKey, JSON.stringify(data)]
        );
      } catch (dbErr) { console.error('[verkada] Failed to insert alert event:', dbErr); }

      await query(
        `INSERT INTO verkada_alert_log (verkada_alert_id, alert_type, camera_name, sent_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [String(alertId), alertType, cameraName, new Date().toISOString()]
      ).catch(() => {});

      logAudit('verkada-poi-webhook', {
        category: 'security', event_type: 'verkada_alert_webhook', severity: 'info',
        actor_id: 'system', actor_name: 'Verkada', channel: 'webhook',
        summary: `${alertType} at ${cameraName}`,
        detail: { alert_id: alertId, alert_type: alertType, camera_name: cameraName },
        status: 'success',
      });

      res.json({ ok: true, action: 'alert_logged', alert_id: alertId });
      return;
    }

    const ts = data.timestamp || data.created || createdAt;
    const occurredAt = toISO(ts);
    const dedupKey = `other_${webhookType || 'unknown'}_${cameraId || 'unknown'}_${ts}`;
    console.warn(
      `[verkada] UNRECOGNIZED webhook — webhook_type=${JSON.stringify(webhookType)} notification_type=${JSON.stringify(notificationType)} data_keys=${JSON.stringify(Object.keys(data))}`
    );
    try {
      await query(
        `INSERT INTO verkada_events (event_type, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedup_key) DO NOTHING`,
        [webhookType || 'unknown', cameraId, cameraName, occurredAt, dedupKey, JSON.stringify(data)]
      );
    } catch (dbErr) { console.error('[verkada] Failed to insert event:', dbErr); }

    res.json({ ok: true, action: 'logged' });
  } catch (error) {
    console.error('Verkada webhook error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.get('/activity-summary', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const laDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const probe = new Date(`${laDateStr}T12:00:00Z`);
    const laHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(probe)
    );
    const offsetMs = (laHour - 12) * 3600000;
    const midnightLA = new Date(`${laDateStr}T00:00:00Z`);
    midnightLA.setTime(midnightLA.getTime() - offsetMs);
    const todayStart = midnightLA.toISOString();

    const { rows: uniquePeopleRows } = await query(
      `SELECT COUNT(DISTINCT
         CASE
           WHEN person_label IS NOT NULL AND person_label != '' THEN person_label
           WHEN person_id IS NOT NULL AND person_id != 'unknown' THEN person_id
           ELSE 'unknown:' || id::text
         END
       ) as count FROM verkada_events WHERE event_type = 'person_of_interest' AND occurred_at >= $1 AND person_id IS NOT NULL`,
      [todayStart]
    );

    const { rows: uniqueVehicleRows } = await query(
      `SELECT COUNT(DISTINCT vehicle_plate) as count FROM verkada_events WHERE event_type = 'license_plate' AND occurred_at >= $1 AND vehicle_plate IS NOT NULL`,
      [todayStart]
    );

    const { rows: sightingsRows } = await query(
      `SELECT COUNT(*) as count FROM verkada_events WHERE event_type = 'person_of_interest' AND occurred_at >= $1`,
      [todayStart]
    );

    const { rows: totalEventsRows } = await query(
      `SELECT COUNT(*) as count FROM verkada_events WHERE occurred_at >= $1`,
      [todayStart]
    );

    const { rows: hourlyRows } = await query(
      `SELECT
        EXTRACT(HOUR FROM occurred_at AT TIME ZONE 'America/Los_Angeles') as hour,
        COUNT(DISTINCT CASE WHEN event_type = 'person_of_interest' AND person_id IS NOT NULL THEN
          CASE
            WHEN person_label IS NOT NULL AND person_label != '' THEN person_label
            WHEN person_id != 'unknown' THEN person_id
            ELSE 'unknown:' || id::text
          END
        END) as unique_people,
        COUNT(DISTINCT CASE WHEN event_type = 'license_plate' AND vehicle_plate IS NOT NULL THEN vehicle_plate END) as unique_vehicles
      FROM verkada_events
      WHERE occurred_at >= $1
      GROUP BY EXTRACT(HOUR FROM occurred_at AT TIME ZONE 'America/Los_Angeles')
      ORDER BY hour`,
      [todayStart]
    );

    const { rows: perCameraRows } = await query(
      `SELECT
        camera_name,
        COUNT(DISTINCT CASE WHEN person_id IS NOT NULL THEN
          CASE
            WHEN person_label IS NOT NULL AND person_label != '' THEN person_label
            WHEN person_id != 'unknown' THEN person_id
            ELSE 'unknown:' || id::text
          END
        END) as unique_people,
        COUNT(DISTINCT CASE WHEN vehicle_plate IS NOT NULL THEN vehicle_plate END) as unique_vehicles,
        COUNT(*) as total_events
      FROM verkada_events
      WHERE occurred_at >= $1 AND camera_name IS NOT NULL
      GROUP BY camera_name
      ORDER BY total_events DESC`,
      [todayStart]
    );

    const { rows: recentSightings } = await query(
      `SELECT person_id, person_label, camera_name, occurred_at FROM verkada_events WHERE event_type = 'person_of_interest' AND occurred_at >= $1 ORDER BY occurred_at DESC LIMIT 20`,
      [todayStart]
    );

    const hourLabels = (h: number) => {
      const suffix = h >= 12 ? 'PM' : 'AM';
      const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${display} ${suffix}`;
    };

    const hourly = hourlyRows.map((r: any) => ({
      hour: Number(r.hour),
      label: hourLabels(Number(r.hour)),
      people: Number(r.unique_people),
      vehicles: Number(r.unique_vehicles),
    }));

    let peakCount = 0, busiestHour = '';
    for (const h of hourly) {
      const total = h.people + h.vehicles;
      if (total > peakCount) { peakCount = total; busiestHour = h.label; }
    }

    const perCamera = perCameraRows.map((r: any) => ({
      camera_name: r.camera_name,
      unique_people: Number(r.unique_people),
      unique_vehicles: Number(r.unique_vehicles),
      total_events: Number(r.total_events),
    }));

    const cameraMap = await getCameraNameMap();
    const totalCameras = cameraMap.size > 0 ? cameraMap.size : perCamera.length;

    res.json({
      success: true,
      unique_people: Number(uniquePeopleRows[0]?.count || 0),
      unique_vehicles: Number(uniqueVehicleRows[0]?.count || 0),
      sightings: Number(sightingsRows[0]?.count || 0),
      total_events: Number(totalEventsRows[0]?.count || 0),
      total_cameras: totalCameras,
      hourly,
      per_camera: perCamera,
      peak_hour_count: peakCount,
      busiest_hour: busiestHour,
      recent_sightings: recentSightings.map((r: any) => ({
        person_id: r.person_id,
        person_label: r.person_label,
        camera_name: r.camera_name,
        occurred_at: r.occurred_at,
      })),
    });
  } catch (error) {
    console.error('Activity summary error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.get('/webhook-health', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const { rows } = await query<{ occurred_at: string | Date }>(
      `SELECT occurred_at FROM verkada_events ORDER BY occurred_at DESC LIMIT 1`
    );

    const lastEventAt = rows.length > 0 ? new Date(rows[0].occurred_at).getTime() : null;
    const lastWebhookAt = lastWebhookReceivedAt;

    const nowLA = new Date();
    const laHourStr = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(nowLA);
    const laHour = parseInt(laHourStr);
    const isDaytime = laHour >= 7 && laHour < 22;

    const latestTimestamp = Math.max(lastEventAt || 0, lastWebhookAt || 0);
    const minutesSinceLastEvent = latestTimestamp > 0 ? Math.floor((Date.now() - latestTimestamp) / 60000) : null;
    const isHealthy = !isDaytime || (minutesSinceLastEvent !== null && minutesSinceLastEvent < 60);

    res.json({
      success: true,
      last_event_at: lastEventAt ? new Date(lastEventAt).toISOString() : null,
      last_webhook_at: lastWebhookAt ? new Date(lastWebhookAt).toISOString() : null,
      minutes_since_last_event: minutesSinceLastEvent,
      is_daytime: isDaytime,
      is_healthy: isHealthy,
    });
  } catch (error) {
    console.error('Webhook health error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.get('/connection-status', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const apiKeyConfigured = !!process.env.VERKADA_API_KEY;
    const orgIdConfigured = !!process.env.VERKADA_ORG_ID;
    const devDomain = process.env.APP_DOMAIN || process.env.PUBLIC_DOMAIN || null;
    const webhookUrl = devDomain ? `https://${devDomain}/api/verkada/poi-webhook` : null;

    const { rows: eventRows } = await query(
      `SELECT COUNT(*) as count, MAX(occurred_at) as last_event FROM verkada_events WHERE event_type = 'license_plate'`
    );
    const totalLprEvents = Number(eventRows[0]?.count || 0);
    const lastLprEvent = eventRows[0]?.last_event || null;

    const { rows: anyWebhookRows } = await query(
      `SELECT COUNT(*) as count, MAX(occurred_at) as last_event FROM verkada_events`
    );
    const totalWebhookEvents = Number(anyWebhookRows[0]?.count || 0);
    const lastAnyEvent = anyWebhookRows[0]?.last_event || null;

    res.json({
      success: true,
      api_key_configured: apiKeyConfigured,
      org_id_configured: orgIdConfigured,
      webhook_url: webhookUrl,
      last_webhook_received_at: lastWebhookReceivedAt ? new Date(lastWebhookReceivedAt).toISOString() : null,
      total_lpr_events: totalLprEvents,
      last_lpr_event_at: lastLprEvent,
      total_webhook_events: totalWebhookEvents,
      last_any_event_at: lastAnyEvent,
    });
  } catch (error) {
    console.error('Connection status error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.get('/sighting-health', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const laDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const probe = new Date(`${laDateStr}T12:00:00Z`);
    const laHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(probe)
    );
    const offsetMs = (laHour - 12) * 3600000;
    const midnightLA = new Date(`${laDateStr}T00:00:00Z`);
    midnightLA.setTime(midnightLA.getTime() - offsetMs);
    const todayStart = midnightLA.toISOString();

    const { rows: byCameraRows } = await query(
      `SELECT camera_name,
              COUNT(*) as sighting_count,
              COUNT(DISTINCT CASE WHEN person_id IS NOT NULL THEN
                CASE
                  WHEN person_label IS NOT NULL AND person_label != '' THEN person_label
                  WHEN person_id != 'unknown' THEN person_id
                  ELSE 'unknown:' || id::text
                END
              END) as unique_people
       FROM verkada_events
       WHERE event_type = 'person_of_interest' AND occurred_at >= $1 AND camera_name IS NOT NULL
       GROUP BY camera_name
       ORDER BY sighting_count DESC`,
      [todayStart]
    );

    const { rows: byPersonRows } = await query(
      `SELECT
              COALESCE(NULLIF(LOWER(TRIM(person_label)), ''), NULLIF(person_id, 'unknown'), 'unknown') as person_key,
              MIN(person_id) as verkada_person_id,
              MIN(NULLIF(TRIM(person_label), '')) as label,
              COUNT(*) as sighting_count,
              MIN(occurred_at) as first_seen,
              MAX(occurred_at) as last_seen,
              array_agg(DISTINCT camera_name ORDER BY camera_name) as cameras
       FROM verkada_events
       WHERE event_type = 'person_of_interest' AND occurred_at >= $1
       GROUP BY COALESCE(NULLIF(LOWER(TRIM(person_label)), ''), NULLIF(person_id, 'unknown'), 'unknown')
       ORDER BY sighting_count DESC`,
      [todayStart]
    );

    const { rows: totalRows } = await query(
      `SELECT COUNT(*) as total FROM verkada_events WHERE event_type = 'person_of_interest' AND occurred_at >= $1`,
      [todayStart]
    );

    const { rows: uniquePeopleRows } = await query(
      `SELECT COUNT(DISTINCT
         COALESCE(NULLIF(LOWER(TRIM(person_label)), ''), NULLIF(person_id, 'unknown'), 'unknown')
       ) as count
       FROM verkada_events
       WHERE event_type = 'person_of_interest' AND occurred_at >= $1 AND person_id IS NOT NULL`,
      [todayStart]
    );

    const { rows: recentRows } = await query(
      `SELECT person_id as verkada_person_id, person_label as label, occurred_at as seen_at, camera_name
       FROM verkada_events
       WHERE event_type = 'person_of_interest' AND occurred_at >= $1
       ORDER BY occurred_at DESC LIMIT 50`,
      [todayStart]
    );

    // All-time last-seen per person from verkada_events (not poi_profiles — which can lag)
    const { rows: allTimeRows } = await query(
      `SELECT
              COALESCE(NULLIF(LOWER(TRIM(person_label)), ''), NULLIF(person_id, 'unknown'), 'unknown') as person_key,
              MIN(NULLIF(TRIM(person_label), '')) as label,
              MAX(occurred_at) as all_time_last_seen
       FROM verkada_events
       WHERE event_type = 'person_of_interest'
       GROUP BY COALESCE(NULLIF(LOWER(TRIM(person_label)), ''), NULLIF(person_id, 'unknown'), 'unknown')`
    );

    // Total camera count from the cached camera name map (null if Verkada creds not set)
    const cameraMap = await getCameraNameMap();
    const totalCameras = cameraMap.size > 0 ? cameraMap.size : null;

    res.json({
      success: true,
      today_start: todayStart,
      last_webhook_at: lastWebhookReceivedAt ? new Date(lastWebhookReceivedAt).toISOString() : null,
      minutes_since_last_webhook: lastWebhookReceivedAt ? Math.floor((Date.now() - lastWebhookReceivedAt) / 60000) : null,
      total_sightings_today: Number(totalRows[0]?.total || 0),
      unique_people_today: Number(uniquePeopleRows[0]?.count || 0),
      total_cameras: totalCameras,
      by_person: byPersonRows.map((r: any) => ({
        verkada_person_id: r.verkada_person_id,
        label: r.label,
        sighting_count: Number(r.sighting_count),
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        cameras: r.cameras?.filter(Boolean) || [],
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all_time_by_person: allTimeRows.map((r: any) => ({
        person_key: r.person_key,
        label: r.label,
        all_time_last_seen: r.all_time_last_seen,
      })),
      by_camera: byCameraRows.map((r: any) => ({
        camera_name: r.camera_name,
        sighting_count: Number(r.sighting_count),
        unique_people: Number(r.unique_people),
      })),
      recent_sightings: recentRows.map((r: any) => ({
        verkada_person_id: r.verkada_person_id,
        label: r.label,
        seen_at: r.seen_at,
        camera_name: r.camera_name,
      })),
    });
  } catch (error) {
    console.error('Sighting health error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.get('/vehicle-profiles', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT id, plate, label, last_seen_at, last_seen_camera, created_at, updated_at FROM vehicle_profiles ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`
    );
    res.json({ success: true, profiles: rows });
  } catch (error) {
    console.error('Vehicle profiles list error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.post('/vehicle-profiles', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { plate, label } = req.body;
    if (!plate || typeof plate !== 'string') {
      return res.status(400).json({ success: false, error: 'plate is required' });
    }
    const normalizedPlate = plate.trim().toUpperCase();
    const { rows } = await query(
      `INSERT INTO vehicle_profiles (plate, label) VALUES ($1, $2)
       ON CONFLICT (plate) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
       RETURNING id, plate, label, last_seen_at, last_seen_camera, created_at, updated_at`,
      [normalizedPlate, label?.trim() || null]
    );
    res.json({ success: true, profile: rows[0] });
  } catch (error) {
    console.error('Vehicle profile create error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.patch('/vehicle-profiles/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { label } = req.body;
    const { rows } = await query(
      `UPDATE vehicle_profiles SET label = $1, updated_at = now() WHERE id = $2
       RETURNING id, plate, label, last_seen_at, last_seen_camera, created_at, updated_at`,
      [label?.trim() || null, id]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, profile: rows[0] });
  } catch (error) {
    console.error('Vehicle profile update error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.delete('/vehicle-profiles/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { rowCount } = await query(`DELETE FROM vehicle_profiles WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Vehicle profile delete error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

router.get('/vehicle-sightings', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const laDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const probe = new Date(`${laDateStr}T12:00:00Z`);
    const laHour = parseInt(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(probe)
    );
    const offsetMs = (laHour - 12) * 3600000;
    const midnightLA = new Date(`${laDateStr}T00:00:00Z`);
    midnightLA.setTime(midnightLA.getTime() - offsetMs);
    const todayStart = midnightLA.toISOString();

    const filterPlate = typeof req.query.plate === 'string' && req.query.plate.trim()
      ? req.query.plate.trim().toUpperCase()
      : null;

    const plateFilter = filterPlate ? ` AND UPPER(vehicle_plate) = $2` : '';
    const plateParams = (base: unknown[]) => filterPlate ? [...base, filterPlate] : base;

    const { rows: uniquePlateRows } = await query(
      `SELECT COUNT(DISTINCT vehicle_plate) as count FROM verkada_events WHERE event_type = 'license_plate' AND occurred_at >= $1 AND vehicle_plate IS NOT NULL${plateFilter}`,
      plateParams([todayStart])
    );

    const { rows: totalSightingRows } = await query(
      `SELECT COUNT(*) as count FROM verkada_events WHERE event_type = 'license_plate' AND occurred_at >= $1${plateFilter}`,
      plateParams([todayStart])
    );

    const { rows: camerasWithLprRows } = await query(
      `SELECT COUNT(DISTINCT camera_name) as count FROM verkada_events WHERE event_type = 'license_plate' AND occurred_at >= $1 AND camera_name IS NOT NULL${plateFilter}`,
      plateParams([todayStart])
    );

    const { rows: byPlateRows } = await query(
      `SELECT vehicle_plate as plate,
              COUNT(*) as sightings_today,
              MAX(occurred_at) as last_seen_at,
              (array_agg(camera_name ORDER BY occurred_at DESC))[1] as last_seen_camera,
              (array_agg(raw_data->>'_image_url' ORDER BY occurred_at DESC) FILTER (WHERE raw_data->>'_image_url' IS NOT NULL))[1] as image_url
       FROM verkada_events
       WHERE event_type = 'license_plate' AND occurred_at >= $1 AND vehicle_plate IS NOT NULL${plateFilter}
       GROUP BY vehicle_plate
       ORDER BY last_seen_at DESC`,
      plateParams([todayStart])
    );

    const { rows: recentRows } = await query(
      `SELECT vehicle_plate as plate, camera_name, occurred_at, raw_data->>'_image_url' as image_url
       FROM verkada_events
       WHERE event_type = 'license_plate' AND occurred_at >= $1 AND vehicle_plate IS NOT NULL${plateFilter}
       ORDER BY occurred_at DESC LIMIT 50`,
      plateParams([todayStart])
    );

    res.json({
      success: true,
      unique_plates: Number(uniquePlateRows[0]?.count || 0),
      total_sightings: Number(totalSightingRows[0]?.count || 0),
      cameras_with_lpr: Number(camerasWithLprRows[0]?.count || 0),
      plate_filter: filterPlate,
      by_plate: byPlateRows.map((r: any) => ({
        plate: r.plate,
        sightings_today: Number(r.sightings_today),
        last_seen_at: r.last_seen_at,
        last_seen_camera: r.last_seen_camera,
        image_url: r.image_url || null,
      })),
      recent_sightings: recentRows.map((r: any) => ({
        plate: r.plate,
        camera_name: r.camera_name,
        occurred_at: r.occurred_at,
        image_url: r.image_url || null,
      })),
    });
  } catch (error) {
    console.error('Vehicle sightings error:', error);
    res.status(500).json({ success: false, ...safeErrorJson(error) });
  }
});

// Recurring backfill route — called by cron every 4 h to pull the last
// window of Verkada POI alerts and insert any sightings the live webhook
// may have missed (restarts, downtime, dropped deliveries).
// Auth: x-cron-secret header (same pattern as other scheduled routes).
// Returns 200 {success:true, skipped:true} when creds are absent so the
// audit log row stays green.
router.post('/poi-backfill', async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const apiKey = process.env.VERKADA_API_KEY;
  const orgId = process.env.VERKADA_ORG_ID;
  if (!apiKey || !orgId) {
    res.json({ success: true, skipped: true, reason: 'no_credentials' });
    return;
  }

  try {
    const windowHours = 4;
    const windowStart = Math.floor((Date.now() - windowHours * 60 * 60 * 1000) / 1000);
    const windowEnd = Math.floor(Date.now() / 1000);

    const result = await fetchPoiAlerts(apiKey, orgId, windowStart, windowEnd);

    if (!result.ok) {
      const status = result.status;
      console.warn(`[verkada] poi-backfill: alerts API returned ${status} — skipping. body: ${result.body || ''}`);
      logAudit('verkada-poi-backfill', {
        category: 'security', event_type: 'verkada_poi_backfill', severity: 'warning',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: `POI backfill skipped: Verkada alerts API returned ${status}`,
        detail: { skipped: true, reason: `api_${status}`, status, api_response: result.body || '' },
        status: 'success',
      });
      // Return 200 so the cron audit row stays green (same convention as other cron routes)
      res.json({ success: true, skipped: true, reason: `api_${status}`, detail: result.body || '' });
      return;
    }

    let inserted = 0;
    let deduped = 0;

    for (const s of result.sightings) {
      try {
        const evRes = await query(
          `INSERT INTO verkada_events (event_type, person_id, person_label, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dedup_key) DO NOTHING`,
          ['person_of_interest', s.personId, s.label, s.cameraId, s.cameraName, s.occurredAt, s.dedupKey, JSON.stringify(s.raw)]
        );
        if ((evRes.rowCount ?? 0) > 0) inserted++;
        else deduped++;
      } catch (dbErr) { console.error('[verkada] poi-backfill insert error:', dbErr); }

      // Mirror the live webhook + startup catch-up so Janus context, the
      // Automations UI and poi_sightings stay consistent with the event log.
      try {
        await query(
          `INSERT INTO poi_sightings (verkada_person_id, label, seen_at, camera_name, thumbnail_url) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (verkada_person_id, seen_at, camera_name) DO NOTHING`,
          [s.personId, s.label, s.occurredAt, s.cameraName, s.thumbnailUrl]
        );
      } catch (se) { console.error('[verkada] poi-backfill sighting insert error:', se); }

      await upsertPoiProfile(s.personId, s.label, s.thumbnailUrl, s.occurredAt).catch(() => {});
    }

    console.log(`[verkada] poi-backfill: window=${windowHours}h, fetched=${result.fetched}, inserted=${inserted}, deduped=${deduped}`);

    logAudit('verkada-poi-backfill', {
      category: 'security', event_type: 'verkada_poi_backfill', severity: 'info',
      actor_id: 'system', actor_name: 'Cron', channel: 'cron',
      summary: `POI backfill: ${inserted} new sightings in last ${windowHours}h (${deduped} already present)`,
      detail: { inserted, deduped, total_fetched: result.fetched, window_hours: windowHours },
      status: 'success',
    });

    res.json({ success: true, inserted, deduped, total_fetched: result.fetched });
  } catch (err) {
    console.error('[verkada] poi-backfill error:', err);
    res.status(500).json({ success: false, ...safeErrorJson(err) });
  }
});

// Shape of a single record returned by Verkada's GET /cameras/v1/alerts
// endpoint. POI alerts carry `person_label` and `created` (unix seconds) but
// crucially NO person_id, so identity is resolved against the POI roster.
interface VerkadaAlertNotification {
  camera_id?: string;
  device_id?: string;
  camera_name?: string;
  created?: number;
  timestamp?: number;
  detected_at?: number;
  image_url?: string | null;
  thumbnail_url?: string | null;
  notification_type?: string;
  person_label?: string | null;
  label?: string | null;
  name?: string | null;
  video_url?: string | null;
  person_id?: string;
  person_of_interest_id?: string;
  poi_id?: string;
}

interface NormalizedPoiSighting {
  personId: string;
  label: string | null;
  cameraId: string | null;
  cameraName: string;
  thumbnailUrl: string | null;
  occurredAt: string;
  dedupKey: string;
  raw: VerkadaAlertNotification;
}

// Build a case-insensitive label -> verkada_person_id map from the POI roster.
// The alerts endpoint returns no person_id, so this lets us link a sighting's
// label (e.g. "Isla") back to the canonical profile the roster sync populated.
export async function getPoiLabelIdMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const { rows } = await query(
      `SELECT verkada_person_id, label FROM poi_profiles
       WHERE label IS NOT NULL AND TRIM(label) != ''
       ORDER BY last_seen_at DESC NULLS LAST`
    );
    for (const r of rows as { verkada_person_id: string; label: string }[]) {
      const key = r.label.trim().toLowerCase();
      if (!map.has(key)) map.set(key, r.verkada_person_id);
    }
  } catch (e) {
    console.error('[verkada] getPoiLabelIdMap error:', e);
  }
  return map;
}

// Fetch Person-of-Interest alerts from Verkada's documented alerts endpoint
// (GET /cameras/v1/alerts with notification_type=person_of_interest).
//
// NOTE: the older /cameras/v1/video_tagging/person_of_interest/alert path used
// previously returns 403 "Insufficient permissions" for this org and never
// yielded data — it is NOT the correct endpoint. The /cameras/v1/alerts
// response carries `person_label` but no `person_id`, so we resolve identity by
// matching the label against the POI roster (poi_profiles), falling back to a
// stable label-derived key when the person isn't in the roster yet.
// Safety valve: the alerts endpoint returns up to 200 records per page, so 50
// pages = 10k sightings, more than enough to cover even an extremely busy 24h
// catch-up window while guarding against an unbounded loop if the API keeps
// handing back a non-empty next_page_token.
const POI_ALERTS_MAX_PAGES = 50;

export async function fetchPoiAlerts(
  apiKey: string,
  orgId: string,
  windowStart: number,
  windowEnd: number
): Promise<{ ok: boolean; status: number; body?: string; sightings: NormalizedPoiSighting[]; fetched: number }> {
  const cameraMap = await getCameraNameMap();
  const labelMap = await getPoiLabelIdMap();

  // Resolve the token once and reuse it across pages; fall back to raw
  // x-api-key only if the token exchange itself fails.
  let token: string | null = null;
  try {
    token = await getVerkadaToken(apiKey, orgId);
  } catch (tokenErr) {
    console.warn('[verkada] fetchPoiAlerts: token auth failed, falling back to x-api-key:', tokenErr);
  }
  const headers = token ? getVerkadaHeaders(token) : { 'x-api-key': apiKey, 'Content-Type': 'application/json' };

  const sightings: NormalizedPoiSighting[] = [];
  let fetched = 0;
  let pageToken: string | undefined;
  let lastStatus = 200;

  for (let page = 0; page < POI_ALERTS_MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      org_id: orgId,
      start_time: String(windowStart),
      end_time: String(windowEnd),
      notification_type: 'person_of_interest',
      page_size: '200',
    });
    if (pageToken) qs.append('page_token', pageToken);
    const url = `${VERKADA_BASE}/cameras/v1/alerts?${qs}`;

    const alertRes = await fetch(url, { headers });
    lastStatus = alertRes.status;

    if (!alertRes.ok) {
      const body = (await alertRes.text().catch(() => '')).slice(0, 300);
      return { ok: false, status: alertRes.status, body, sightings: [], fetched: 0 };
    }

    const data = (await alertRes.json().catch(() => ({}))) as {
      notifications?: VerkadaAlertNotification[];
      alerts?: VerkadaAlertNotification[];
      events?: VerkadaAlertNotification[];
      next_page_token?: string | null;
    };
    const raw = data.notifications || data.alerts || data.events || [];
    fetched += raw.length;

    for (const n of raw) {
      const ntype = (n.notification_type || '').toLowerCase();
      if (ntype && ntype !== 'person_of_interest') continue;
      const label = n.person_label || n.label || n.name || null;
      const cameraId = n.camera_id || n.device_id || null;
      const ts = n.created ?? n.timestamp ?? n.detected_at;
      const occurredAt = toISO(ts);
      const thumbnailUrl = n.image_url || n.thumbnail_url || null;
      // Resolve person_id: prefer an explicit id (future-proofing), then the
      // roster label match, then a stable label-derived key.
      const rawId = n.person_of_interest_id || n.person_id || n.poi_id;
      const resolvedId = label ? labelMap.get(label.trim().toLowerCase()) : undefined;
      const personId = rawId || resolvedId || (label ? `label:${label.trim().toLowerCase()}` : null);
      if (!personId) continue;
      const cameraName = n.camera_name || (cameraId ? cameraMap.get(cameraId) : null) || cameraId || 'Unknown Camera';
      const dedupKey = `poi_${personId}_${cameraId || 'unknown'}_${ts ?? ''}`;
      sightings.push({ personId, label, cameraId, cameraName, thumbnailUrl, occurredAt, dedupKey, raw: n });
    }

    // Follow the pagination token until the API stops handing one back.
    const nextToken = data.next_page_token;
    if (!nextToken) break;
    pageToken = nextToken;

    if (page === POI_ALERTS_MAX_PAGES - 1) {
      console.warn(
        `[verkada] fetchPoiAlerts: hit page cap (${POI_ALERTS_MAX_PAGES}) with a next_page_token still present — ` +
        'some sightings in this window may not have been captured.'
      );
    }
  }

  return { ok: true, status: lastStatus, sightings, fetched };
}

export async function runPoiRosterSync(): Promise<{ profilesSynced: number; skipped?: boolean }> {
  const apiKey = process.env.VERKADA_API_KEY;
  const orgId = process.env.VERKADA_ORG_ID;
  if (!apiKey || !orgId) {
    console.log('[verkada] POI roster sync skipped — VERKADA_API_KEY or VERKADA_ORG_ID not configured');
    return { profilesSynced: 0, skipped: true };
  }

  const token = await getVerkadaToken(apiKey, orgId);
  const verkadaHeaders = getVerkadaHeaders(token);

  let profilesSynced = 0;
  const poiRes = await fetch(`${VERKADA_BASE}/cameras/v1/people/person_of_interest?org_id=${orgId}`, { headers: verkadaHeaders });
  if (poiRes.ok) {
    const poiData = await poiRes.json() as any;
    for (const person of (poiData.persons_of_interest || poiData.persons || [])) {
      const personId = person.person_id || person.person_of_interest_id;
      if (!personId) continue;
      const label = person.label || person.name || null;
      const thumbnail = person.thumbnail_url || person.image_url || null;
      const lastSeen = person.last_seen ? new Date(person.last_seen > 1e12 ? person.last_seen : person.last_seen * 1000).toISOString() : null;

      await upsertPoiProfile(personId, label, thumbnail, lastSeen);
      profilesSynced++;
    }
  }

  return { profilesSynced };
}

export async function runStartupCatchup(): Promise<void> {
  const apiKey = process.env.VERKADA_API_KEY;
  const orgId = process.env.VERKADA_ORG_ID;
  if (!apiKey || !orgId) {
    console.log('[verkada] Startup catch-up skipped: no API credentials');
    return;
  }

  try {
    const devDomain = process.env.APP_DOMAIN || process.env.PUBLIC_DOMAIN || 'localhost:5000';
    const webhookUrl = `https://${devDomain}/api/verkada/poi-webhook`;
    console.log('[verkada] Running startup catch-up...');
    console.log(`[verkada] Active webhook endpoint: POST ${webhookUrl}`);
    console.log(`[verkada] Webhook signature enforcement: ${process.env.VERKADA_WEBHOOK_SECRET ? 'enabled' : 'DISABLED (no secret set)'}`);

    await runPoiRosterSync();

    // Run explicit SQL-level dedup before deduplicatePoiProfiles() to handle
    // any pre-existing duplicates that may have been created before the unique
    // constraint was in place. Keeps the row with the most recent last_seen_at
    // and best (non-null) thumbnail_url.
    try {
      const { rows: dupCount } = await query(
        `SELECT COUNT(*) as cnt FROM (
           SELECT LOWER(TRIM(label)) FROM poi_profiles
           WHERE label IS NOT NULL AND label != ''
           GROUP BY LOWER(TRIM(label)) HAVING COUNT(*) > 1
         ) dups`
      );
      const duplicates = Number(dupCount[0]?.cnt || 0);
      if (duplicates > 0) {
        console.log(`[verkada] Startup dedup: found ${duplicates} duplicate label group(s) — merging...`);
        await deduplicatePoiProfiles();
        console.log('[verkada] Startup dedup: duplicate POI profiles merged');
      } else {
        console.log('[verkada] Startup dedup: no duplicate POI profiles found');
      }
    } catch (dedupErr) {
      console.error('[verkada] Startup dedup error:', dedupErr);
    }

    const windowStart = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const windowEnd = Math.floor(Date.now() / 1000);
    console.log(`[verkada] Startup catch-up window: last 24 hours (since ${new Date(windowStart * 1000).toISOString()})`);

    const result = await fetchPoiAlerts(apiKey, orgId, windowStart, windowEnd);

    if (!result.ok) {
      console.warn(
        `[verkada] Startup catch-up: alerts API returned ${result.status} (${result.body || ''}) — ` +
        'skipping historical alert sync. Missed webhook events during downtime cannot be recovered. ' +
        'The POI roster sync and deduplication still ran successfully.'
      );
    } else {
      let synced = 0;

      for (const s of result.sightings) {
        try {
          await query(
            `INSERT INTO verkada_events (event_type, person_id, person_label, camera_id, camera_name, occurred_at, dedup_key, raw_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (dedup_key) DO NOTHING`,
            ['person_of_interest', s.personId, s.label, s.cameraId, s.cameraName, s.occurredAt, s.dedupKey, JSON.stringify(s.raw)]
          );
          synced++;
        } catch (dbErr) { console.error('[verkada] Catch-up insert error:', dbErr); }

        await upsertPoiProfile(s.personId, s.label, s.thumbnailUrl, s.occurredAt).catch(() => {});

        let sightingInserted = false;
        try {
          const sr = await query(
            `INSERT INTO poi_sightings (verkada_person_id, label, seen_at, camera_name, thumbnail_url) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (verkada_person_id, seen_at, camera_name) DO NOTHING`,
            [s.personId, s.label, s.occurredAt, s.cameraName, s.thumbnailUrl]
          );
          sightingInserted = (sr.rowCount ?? 0) > 0;
        } catch (se) { console.error('[verkada] Catch-up sighting insert error:', se); }

        if (!sightingInserted) {
          console.debug(`[verkada] Catch-up sighting skipped (duplicate): person=${s.label || s.personId} camera=${s.cameraName} at=${s.occurredAt}`);
        }
      }

      console.log(`[verkada] Startup catch-up: synced ${synced} events from ${result.fetched} alerts`);
    }
  } catch (e) {
    console.error('[verkada] Startup catch-up error:', e);
  }
}

export function getLastWebhookReceivedAt(): number | null {
  return lastWebhookReceivedAt;
}

export default router;
