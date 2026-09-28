import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getSystemInfo,
  getAccessPoints,
  getClients,
  getSSIDs,
  isRuckusConfigured,
  getRuckusBaseUrl,
  classifyBand,
  CircuitOpenError,
  type RuckusSystemInfo,
  type RuckusAccessPoint,
  type RuckusClient,
  type RuckusSSID,
} from '../lib/ruckus.js';
import { query as dbQuery } from '../lib/db.js';
import { logAudit } from '../lib/auditLog.js';
import {
  buildSnapshotRow,
  detectEvents,
  summarize,
  type SnapshotRowBody,
  type DerivedEvent,
} from '../lib/wirelessSnapshot.js';
import { refreshConnectionMethodCache } from '../lib/connection-refresh.js';

const router = Router();

function requireAdmin(req: AuthenticatedRequest, res: Response, next: () => void): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

function handleError(res: Response, err: unknown, label: string): void {
  if (err instanceof CircuitOpenError) {
    console.warn(`[wireless] ${label}: breaker open for ruckus (retry at ${new Date(err.retryAt).toISOString()})`);
    res.status(503).json({
      error: 'ruckus circuit breaker open',
      service: 'ruckus',
      retry_at: new Date(err.retryAt).toISOString(),
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[wireless] ${label} failed:`, message);
  res.status(502).json({ error: message, source: 'ruckus' });
}

// Per-AP enriched shape returned to the UI. Carries both the canonical
// server fields (status / client_count) and the legacy/frontend-friendly
// aliases (online / numClients) so the existing AdminWirelessContent.tsx
// renders correctly without changes. "joined" is treated as online;
// "disconnected" as offline; "unknown" is reported but NOT painted as a
// hard offline — the UI shows an unknown-state badge instead.
interface EnrichedAccessPoint extends RuckusAccessPoint {
  online: boolean;
  numClients: number;
}

function isOnlineStatus(status: RuckusAccessPoint['status']): boolean {
  // Conservative mapping: only an explicit "joined" counts as online.
  // unknown/disconnected map to false. The full status string is still
  // exposed so the UI can render an "unknown" badge instead of a hard
  // WifiOff icon if it wants to.
  return status === 'joined';
}

function enrichApsWithClients(aps: RuckusAccessPoint[], clients: RuckusClient[]): EnrichedAccessPoint[] {
  const clientsByAp = new Map<string, number>();
  for (const c of clients) {
    const key = c.ap_mac || c.ap_name || '';
    if (!key) continue;
    clientsByAp.set(key, (clientsByAp.get(key) ?? 0) + 1);
  }
  return aps.map((ap) => {
    const client_count = clientsByAp.get(ap.mac) ?? clientsByAp.get(ap.name) ?? 0;
    return {
      ...ap,
      client_count,
      online: isOnlineStatus(ap.status),
      numClients: client_count,
    };
  });
}

// --- Client → AP / SSID grouping ------------------------------------------
//
// The controller already tells us, per client, which AP it is associated
// with (ap_mac / ap_name) and which SSID it joined. The "which device is
// on which AP" breakdown the operator wants is therefore pure aggregation
// over the existing getClients() feed joined against getAccessPoints() —
// no new controller call path. We expose two views of the same data:
//   • by AP   — each AP with the clients currently associated to it
//   • by SSID — each SSID with its clients, each tagged with its AP
// plus an `unassigned` bucket for clients whose AP we can't resolve.

// Trimmed per-client shape for the grouped views. We deliberately drop the
// heavy `raw` blob the full /clients route carries — the grouped breakdown
// is a summary surface, and shipping every client's raw XML object inflates
// the payload for no UI gain.
interface GroupedClient {
  mac: string;
  hostname?: string;
  ip?: string;
  ssid?: string;
  apName?: string;
  apMac?: string;
  signal?: number;
  signalHealth: RuckusClient['signal_health'];
  band?: string;
  vlan?: string | number;
  os?: string;
  firstAssocAt?: number;
}

interface ApGroup {
  apName: string;
  apMac: string;
  model?: string;
  status: RuckusAccessPoint['status'];
  online: boolean;
  clientCount: number;
  clients: GroupedClient[];
}

interface SsidGroup {
  ssid: string;
  clientCount: number;
  /** Distinct APs this SSID is currently served from. */
  apCount: number;
  clients: GroupedClient[];
}

// Band is classified at parse time (`RuckusClient.band`); this remains as a
// fallback for clients whose `band` wasn't set but still carry raw radio attrs.
// Delegates to the shared classifier so the parser and this path agree.
function deriveBand(raw: Record<string, unknown>): string | undefined {
  return classifyBand(raw);
}

function toGroupedClient(c: RuckusClient): GroupedClient {
  return {
    mac: c.mac,
    hostname: c.hostname,
    ip: c.ip,
    ssid: c.ssid,
    apName: c.ap_name,
    apMac: c.ap_mac,
    signal: c.signal,
    signalHealth: c.signal_health,
    band: c.band ?? deriveBand(c.raw ?? {}),
    vlan: c.vlan,
    os: c.dvctype,
    firstAssocAt: c.first_assoc_at,
  };
}

/**
 * Group clients under the APs they're associated with. APs with zero
 * clients are still returned (so the UI shows the full fleet), sorted by
 * client count desc then name. Clients whose ap_mac/ap_name matches no
 * known AP land in `unassigned`.
 */
function groupClientsByAp(
  aps: RuckusAccessPoint[],
  clients: RuckusClient[],
): { accessPoints: ApGroup[]; unassigned: GroupedClient[] } {
  const byMac = new Map<string, ApGroup>();
  const byName = new Map<string, ApGroup>();
  for (const ap of aps) {
    const group: ApGroup = {
      apName: ap.name,
      apMac: ap.mac,
      model: ap.model,
      status: ap.status,
      online: isOnlineStatus(ap.status),
      clientCount: 0,
      clients: [],
    };
    if (ap.mac) byMac.set(ap.mac.toLowerCase(), group);
    if (ap.name) byName.set(ap.name.toLowerCase(), group);
  }

  const unassigned: GroupedClient[] = [];
  for (const c of clients) {
    const gc = toGroupedClient(c);
    const group =
      (c.ap_mac && byMac.get(c.ap_mac.toLowerCase())) ||
      (c.ap_name && byName.get(c.ap_name.toLowerCase())) ||
      null;
    if (group) {
      group.clients.push(gc);
      group.clientCount += 1;
    } else {
      unassigned.push(gc);
    }
  }

  const accessPoints = Array.from(new Set(byMac.size ? byMac.values() : byName.values()));
  accessPoints.sort((a, b) => b.clientCount - a.clientCount || a.apName.localeCompare(b.apName));
  return { accessPoints, unassigned };
}

/**
 * Group clients by the SSID they joined. Each group also reports how many
 * distinct APs currently serve that SSID, so the operator can see at a
 * glance whether a network is concentrated on one AP or spread out.
 */
function groupClientsBySsid(clients: RuckusClient[]): SsidGroup[] {
  const groups = new Map<string, { clients: GroupedClient[]; aps: Set<string> }>();
  for (const c of clients) {
    const key = c.ssid || '(unknown)';
    let g = groups.get(key);
    if (!g) {
      g = { clients: [], aps: new Set() };
      groups.set(key, g);
    }
    g.clients.push(toGroupedClient(c));
    const apKey = c.ap_mac || c.ap_name;
    if (apKey) g.aps.add(apKey.toLowerCase());
  }
  return Array.from(groups.entries())
    .map(([ssid, g]) => ({
      ssid,
      clientCount: g.clients.length,
      apCount: g.aps.size,
      clients: g.clients,
    }))
    .sort((a, b) => b.clientCount - a.clientCount || a.ssid.localeCompare(b.ssid));
}

// --- Last-known-good cache -------------------------------------------------
//
// A single transient Ruckus call shouldn't paint the UI as "0/0 online".
// We keep the most recent successful payload for each section in memory.
// On partial failure we serve the stale section with a `stale: true`
// marker plus the per-section error so the UI can render a "stale,
// last refreshed at" banner instead of an empty list.
//
// In-memory only; restarts start cold. That's intentional — this is a
// 30-second poll, the cache fills again on the very next successful tick.

interface SectionSnapshot<T> {
  value: T;
  fetchedAt: number;
}

const lkg: {
  system: SectionSnapshot<RuckusSystemInfo> | null;
  aps: SectionSnapshot<RuckusAccessPoint[]> | null;
  clients: SectionSnapshot<RuckusClient[]> | null;
  ssids: SectionSnapshot<RuckusSSID[]> | null;
  lastSuccessAt: number | null;
} = {
  system: null,
  aps: null,
  clients: null,
  ssids: null,
  lastSuccessAt: null,
};

/** Test-only — reset cache between cases. */
export function __resetWirelessCacheForTests(): void {
  lkg.system = null;
  lkg.aps = null;
  lkg.clients = null;
  lkg.ssids = null;
  lkg.lastSuccessAt = null;
}

interface SectionResult<T> {
  value: T;
  stale: boolean;
  fetchedAt: number | null;
  error: string | null;
}

function resolveSection<T>(
  settled: PromiseSettledResult<T>,
  cache: SectionSnapshot<T> | null,
  fallback: T,
  setCache: (snap: SectionSnapshot<T>) => void,
  now: number,
): SectionResult<T> {
  if (settled.status === 'fulfilled') {
    setCache({ value: settled.value, fetchedAt: now });
    return { value: settled.value, stale: false, fetchedAt: now, error: null };
  }
  const errMsg = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
  if (cache) {
    return { value: cache.value, stale: true, fetchedAt: cache.fetchedAt, error: errMsg };
  }
  return { value: fallback, stale: false, fetchedAt: null, error: errMsg };
}

router.get('/api/wireless/status', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!isRuckusConfigured()) {
    res.status(503).json({
      error: 'Ruckus controller not configured',
      hint: 'Set the RUCKUS_PASSWORD secret. RUCKUS_BASE_URL defaults to https://ruckus.example.com.',
      baseUrl: getRuckusBaseUrl(),
    });
    return;
  }
  const t0 = Date.now();
  try {
    // Single-pass fan-out: every UI summary the Network Command Center
    // shows needs all four pulls, so we issue them in parallel and
    // tolerate per-section errors so a single Ruckus quirk doesn't
    // collapse the whole status panel.
    const [systemR, apsR, clientsR, ssidsR] = await Promise.allSettled([
      getSystemInfo(),
      getAccessPoints(),
      getClients(),
      getSSIDs(),
    ]);

    const now = Date.now();
    const system = resolveSection<RuckusSystemInfo>(
      systemR,
      lkg.system,
      { raw: {} } as RuckusSystemInfo,
      (s) => { lkg.system = s; },
      now,
    );
    const aps = resolveSection<RuckusAccessPoint[]>(
      apsR,
      lkg.aps,
      [],
      (s) => { lkg.aps = s; },
      now,
    );
    const clients = resolveSection<RuckusClient[]>(
      clientsR,
      lkg.clients,
      [],
      (s) => { lkg.clients = s; },
      now,
    );
    const ssids = resolveSection<RuckusSSID[]>(
      ssidsR,
      lkg.ssids,
      [],
      (s) => { lkg.ssids = s; },
      now,
    );

    const sectionErrors: Record<string, string> = {};
    if (system.error) sectionErrors.system = system.error;
    if (aps.error) sectionErrors.aps = aps.error;
    if (clients.error) sectionErrors.clients = clients.error;
    if (ssids.error) sectionErrors.ssids = ssids.error;

    const anyFulfilled =
      systemR.status === 'fulfilled' ||
      apsR.status === 'fulfilled' ||
      clientsR.status === 'fulfilled' ||
      ssidsR.status === 'fulfilled';
    if (anyFulfilled) lkg.lastSuccessAt = now;

    const stale = aps.stale || clients.stale || system.stale || ssids.stale;
    const apsWithCounts = enrichApsWithClients(aps.value, clients.value);

    const elapsedMs = Date.now() - t0;
    if (Object.keys(sectionErrors).length > 0) {
      console.warn(`[wireless] status partial: ${elapsedMs}ms, errors=${Object.keys(sectionErrors).join(',')}`);
    }

    res.json({
      controller: system.value,
      // Legacy field the existing AdminWirelessContent.tsx reads. Keep
      // it as an alias for `controller` so the frontend keeps working
      // without changes.
      system: system.value,
      ap_count: aps.value.length,
      client_count: clients.value.length,
      aps: apsWithCounts,
      clients: clients.value,
      ssids: ssids.value,
      baseUrl: getRuckusBaseUrl(),
      // Observability metadata so the UI can render "stale at HH:MM"
      // and the operator can diagnose flaps from the response alone.
      generated_at: new Date(now).toISOString(),
      elapsed_ms: elapsedMs,
      source: 'ruckus',
      stale,
      section_errors: sectionErrors,
      section_fetched_at: {
        system: system.fetchedAt ? new Date(system.fetchedAt).toISOString() : null,
        aps: aps.fetchedAt ? new Date(aps.fetchedAt).toISOString() : null,
        clients: clients.fetchedAt ? new Date(clients.fetchedAt).toISOString() : null,
        ssids: ssids.fetchedAt ? new Date(ssids.fetchedAt).toISOString() : null,
      },
      last_success_at: lkg.lastSuccessAt ? new Date(lkg.lastSuccessAt).toISOString() : null,
    });
  } catch (err) {
    handleError(res, err, 'status');
  }
});

router.get('/api/wireless/system', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!isRuckusConfigured()) {
    res.status(503).json({ error: 'Ruckus controller not configured' });
    return;
  }
  try {
    const system = await getSystemInfo();
    res.json(system);
  } catch (err) {
    handleError(res, err, 'system');
  }
});

router.get('/api/wireless/aps', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!isRuckusConfigured()) {
    res.status(503).json({ error: 'Ruckus controller not configured' });
    return;
  }
  try {
    // Join APs with per-AP client counts so the UI doesn't have to issue
    // a second request and do the aggregation client-side.
    const [aps, clients] = await Promise.all([getAccessPoints(), getClients()]);
    const enriched = enrichApsWithClients(aps, clients);
    res.json({ aps: enriched, count: enriched.length });
  } catch (err) {
    handleError(res, err, 'aps');
  }
});

router.get('/api/wireless/clients', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!isRuckusConfigured()) {
    res.status(503).json({ error: 'Ruckus controller not configured' });
    return;
  }
  try {
    const clients = await getClients();
    res.json({ clients, count: clients.length });
  } catch (err) {
    handleError(res, err, 'clients');
  }
});

// Clients grouped by the AP they're associated with (and, secondarily, by
// SSID). Reuses the existing getAccessPoints()/getClients() pulls — both
// already routed through the `ruckus` circuit breaker inside ruckus.ts —
// and aggregates server-side so the UI doesn't re-derive it.
//
// Graceful degradation: if either pull fails (breaker open, tunnel cold,
// auth blip) we return HTTP 200 with empty groups and `reachable: false`
// plus the error string, instead of a 5xx that would blank the panel. The
// UI shows a "controller unreachable" state and keeps its last render.
router.get('/api/wireless/grouped', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!isRuckusConfigured()) {
    res.status(503).json({ error: 'Ruckus controller not configured' });
    return;
  }
  const [apsR, clientsR] = await Promise.allSettled([getAccessPoints(), getClients()]);

  const errors: Record<string, string> = {};
  if (apsR.status === 'rejected') {
    errors.aps = apsR.reason instanceof Error ? apsR.reason.message : String(apsR.reason);
  }
  if (clientsR.status === 'rejected') {
    errors.clients = clientsR.reason instanceof Error ? clientsR.reason.message : String(clientsR.reason);
  }

  const aps = apsR.status === 'fulfilled' ? apsR.value : [];
  const clients = clientsR.status === 'fulfilled' ? clientsR.value : [];
  const reachable = Object.keys(errors).length === 0;

  if (Object.keys(errors).length > 0) {
    console.warn(`[wireless] grouped degraded: ${Object.keys(errors).join(',')}`);
  }

  const byAp = groupClientsByAp(aps, clients);
  const bySsid = groupClientsBySsid(clients);

  res.json({
    accessPoints: byAp.accessPoints,
    unassigned: byAp.unassigned,
    ssids: bySsid,
    ap_count: byAp.accessPoints.length,
    client_count: clients.length,
    reachable,
    errors,
    generated_at: new Date().toISOString(),
    source: 'ruckus',
  });
});

router.get('/api/wireless/ssids', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!isRuckusConfigured()) {
    res.status(503).json({ error: 'Ruckus controller not configured' });
    return;
  }
  try {
    // Roll per-SSID client counts into the response too — same UI win
    // as for /aps. getSSIDs() may fall back to client-derived SSIDs (see
    // ruckus.ts notes); in that case derived_from_clients=true and the
    // count is already populated.
    const [ssids, clients] = await Promise.all([getSSIDs(), getClients()]);
    const clientsBySsid = new Map<string, number>();
    for (const c of clients) {
      if (!c.ssid) continue;
      clientsBySsid.set(c.ssid, (clientsBySsid.get(c.ssid) ?? 0) + 1);
    }
    const enriched = ssids.map((s) => ({
      ...s,
      client_count: s.client_count ?? clientsBySsid.get(s.name) ?? 0,
    }));
    res.json({ ssids: enriched, count: enriched.length });
  } catch (err) {
    handleError(res, err, 'ssids');
  }
});

// Legacy alias — AdminWirelessContent.tsx still uses /api/wireless/wlans.
// Same body as /ssids so the UI works without changes.
router.get('/api/wireless/wlans', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!isRuckusConfigured()) {
    res.status(503).json({ error: 'Ruckus controller not configured' });
    return;
  }
  try {
    const ssids = await getSSIDs();
    res.json({ wlans: ssids, count: ssids.length });
  } catch (err) {
    handleError(res, err, 'wlans');
  }
});

// ─── Observability layer ────────────────────────────────────────────
//
// Every 5 min the cron POSTs /api/wireless-snapshot. That handler:
//   1. fan-outs the same getSystemInfo/getAccessPoints/getClients/getSSIDs
//      pulls that /api/wireless/status uses (no new controller load)
//   2. writes one wireless_snapshots row (counts + per-AP/SSID JSON)
//   3. diffs vs the previous snapshot and writes 0+ wireless_events rows
//   4. enforces 7-day retention with DELETE WHERE captured_at < now() - 7d
//
// /api/wireless/diagnostics (GET, admin) returns the latest snapshot,
// recent events, and a plain-English summary so an operator can answer
// "is this an actual flap or just a telemetry artifact?" without
// scrolling through the audit log.

const RETENTION_DAYS = 7;

interface CronAuthenticatedRequest extends Request {
  // cron passes x-cron-secret, the request never sees AuthenticatedRequest
}

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // In a deployment the secret MUST be set — fail closed. In dev we
    // permit unauthenticated calls so smoke tests work without env setup.
    return process.env.REPLIT_DEPLOYMENT !== '1';
  }
  return req.headers['x-cron-secret'] === secret;
}

async function loadPreviousSnapshot(): Promise<SnapshotRowBody | null> {
  const { rows } = await dbQuery<SnapshotRowBody>(
    `SELECT ap_total, ap_online, ap_offline, ap_unknown, client_total, ssid_total,
            clients_by_ssid, aps_by_mac, stale, section_errors
       FROM wireless_snapshots
      ORDER BY captured_at DESC
      LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ap_total: r.ap_total,
    ap_online: r.ap_online,
    ap_offline: r.ap_offline,
    ap_unknown: r.ap_unknown,
    client_total: r.client_total,
    ssid_total: r.ssid_total,
    clients_by_ssid: r.clients_by_ssid ?? {},
    aps_by_mac: r.aps_by_mac ?? {},
    stale: r.stale,
    section_errors: r.section_errors ?? {},
  };
}

router.post('/api/wireless-snapshot', async (req: Request, res: Response) => {
  if (!isCronAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (!isRuckusConfigured()) {
    res.status(503).json({ error: 'Ruckus controller not configured', skipped: true });
    return;
  }

  const t0 = Date.now();
  try {
    // Mirror the exact resolveSection path /api/wireless/status uses so
    // the snapshot has the same LKG semantics as the live UI. This also
    // updates the in-memory lkg cache, which means the snapshot cron
    // keeps the cache warm even when no UI traffic is hitting /status.
    const [systemR, apsR, clientsR, ssidsR] = await Promise.allSettled([
      getSystemInfo(),
      getAccessPoints(),
      getClients(),
      getSSIDs(),
    ]);
    const now = Date.now();
    const system = resolveSection<RuckusSystemInfo>(
      systemR, lkg.system, { raw: {} } as RuckusSystemInfo,
      (s) => { lkg.system = s; }, now,
    );
    const apsR2 = resolveSection<RuckusAccessPoint[]>(
      apsR, lkg.aps, [], (s) => { lkg.aps = s; }, now,
    );
    const clientsR2 = resolveSection<RuckusClient[]>(
      clientsR, lkg.clients, [], (s) => { lkg.clients = s; }, now,
    );
    const ssidsR2 = resolveSection<RuckusSSID[]>(
      ssidsR, lkg.ssids, [], (s) => { lkg.ssids = s; }, now,
    );
    const anyFulfilled =
      systemR.status === 'fulfilled' || apsR.status === 'fulfilled' ||
      clientsR.status === 'fulfilled' || ssidsR.status === 'fulfilled';
    if (anyFulfilled) lkg.lastSuccessAt = now;

    const sectionErrors: Record<string, string> = {};
    if (system.error) sectionErrors.system = system.error;
    if (apsR2.error) sectionErrors.aps = apsR2.error;
    if (clientsR2.error) sectionErrors.clients = clientsR2.error;
    if (ssidsR2.error) sectionErrors.ssids = ssidsR2.error;

    // Cold-start guard: if the AP section failed and we don't have any
    // last-known-good for it, writing an empty-aps row would poison the
    // next diff (everything looks like ap_new on recovery). Skip
    // entirely — the next 5-min tick will retry. We DO emit an audit
    // line so operators can see why no row landed.
    if (apsR.status === 'rejected' && lkg.aps === null) {
      console.warn('[wireless-snapshot] skipped: aps section failed with no LKG');
      res.json({
        ok: true,
        skipped: true,
        reason: 'cold_start_aps_failure',
        section_errors: sectionErrors,
        elapsed_ms: Date.now() - t0,
      });
      return;
    }

    // `stale` = "we served at least one section from cache", i.e. the
    // operator-visible meaning on the live route. Pure error presence
    // is not enough — a fresh poll that succeeded on every section but
    // had an LKG miss elsewhere is not stale.
    const stale = system.stale || apsR2.stale || clientsR2.stale || ssidsR2.stale;
    const snap = buildSnapshotRow({
      aps: apsR2.value, clients: clientsR2.value, ssids: ssidsR2.value,
      stale, sectionErrors,
    });

    const prev = await loadPreviousSnapshot();
    const events = detectEvents(prev, snap);

    const { rows: insertedRows } = await dbQuery(
      `INSERT INTO wireless_snapshots
        (ap_total, ap_online, ap_offline, ap_unknown, client_total, ssid_total,
         clients_by_ssid, aps_by_mac, stale, section_errors, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        snap.ap_total, snap.ap_online, snap.ap_offline, snap.ap_unknown,
        snap.client_total, snap.ssid_total,
        JSON.stringify(snap.clients_by_ssid), JSON.stringify(snap.aps_by_mac),
        snap.stale, JSON.stringify(snap.section_errors),
        'cron',
      ],
    );
    const snapshotId = insertedRows[0]?.id;

    for (const ev of events) {
      await dbQuery(
        `INSERT INTO wireless_events (event_type, severity, evidence, summary, detail)
         VALUES ($1,$2,$3,$4,$5)`,
        [ev.event_type, ev.severity, ev.evidence, ev.summary, JSON.stringify(ev.detail)],
      );
    }

    // Retention — keep 7 days of both tables
    await dbQuery(
      `DELETE FROM wireless_snapshots WHERE captured_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
    );
    await dbQuery(
      `DELETE FROM wireless_events WHERE detected_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`,
    );

    const elapsed = Date.now() - t0;
    if (events.length > 0 || stale) {
      console.log(
        `[wireless-snapshot] ${elapsed}ms — aps=${snap.ap_online}/${snap.ap_total}, clients=${snap.client_total}, stale=${stale}, events=${events.length}`,
      );
    }
    // Heartbeat audit row so an operator can confirm at a glance that
    // the Ruckus pipeline is actually ingesting (vs. silently skipped
    // by a stuck breaker). Written on EVERY successful poll (every 5 min)
    // rather than throttled, so the downstream watchdog
    // (/api/wireless-snapshot-watchdog, monitoring.ts) can use a tight
    // ~20-min staleness threshold (≈4 missed cycles) without false
    // positives. ~288 rows/day is negligible next to the other 5-min /
    // 30-sec crons that already audit every tick.
    logAudit('wireless-snapshot', {
      category: 'system',
      event_type: 'wireless_snapshot_ok',
      severity: 'info',
      actor_id: 'system',
      actor_name: 'cron',
      channel: 'system',
      summary: `Wireless snapshot ok — ${snap.ap_online}/${snap.ap_total} APs, ${snap.client_total} clients`,
      detail: {
        elapsed_ms: elapsed,
        ap_total: snap.ap_total,
        ap_online: snap.ap_online,
        client_total: snap.client_total,
        ssid_total: snap.ssid_total,
        events_emitted: events.length,
        snapshot_id: snapshotId,
      },
      status: 'success',
      actionable: false,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
    // Refresh the per-MAC connection-method cache now that fresh Ruckus
    // observation data is in the DB. Best-effort: never let it break the
    // snapshot response.
    let connection_cache_updated = 0;
    try {
      connection_cache_updated = await refreshConnectionMethodCache();
    } catch (cacheErr) {
      console.warn('[wireless-snapshot] connection cache refresh failed:', cacheErr instanceof Error ? cacheErr.message : cacheErr);
    }

    res.json({
      ok: true,
      snapshot_id: snapshotId,
      elapsed_ms: elapsed,
      counts: {
        ap_total: snap.ap_total, ap_online: snap.ap_online,
        ap_offline: snap.ap_offline, ap_unknown: snap.ap_unknown,
        client_total: snap.client_total, ssid_total: snap.ssid_total,
      },
      stale,
      section_errors: sectionErrors,
      events_emitted: events.length,
      events,
      connection_cache_updated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[wireless-snapshot] failed:', msg);
    res.status(500).json({ error: msg });
  }
});

router.get('/api/wireless/diagnostics', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const { rows: snapRows } = await dbQuery<SnapshotRowBody & { id: string; captured_at: string }>(
      `SELECT id, captured_at, ap_total, ap_online, ap_offline, ap_unknown,
              client_total, ssid_total, clients_by_ssid, aps_by_mac,
              stale, section_errors
         FROM wireless_snapshots
        ORDER BY captured_at DESC
        LIMIT 1`,
    );
    const { rows: eventRows } = await dbQuery<Record<string, unknown>>(
      `SELECT id, detected_at, event_type, severity, evidence, summary, detail
         FROM wireless_events
        WHERE detected_at > NOW() - INTERVAL '24 hours'
        ORDER BY detected_at DESC
        LIMIT 100`,
    );
    // Separate COUNT so event_count_24h isn't capped by the LIMIT above.
    const { rows: countRows } = await dbQuery(
      `SELECT COUNT(*)::int AS n
         FROM wireless_events
        WHERE detected_at > NOW() - INTERVAL '24 hours'`,
    );
    const eventCount24h = countRows[0]?.n ?? 0;
    const { rows: history } = await dbQuery(
      `SELECT captured_at, ap_online, ap_total, ap_unknown, client_total, stale
         FROM wireless_snapshots
        WHERE captured_at > NOW() - INTERVAL '24 hours'
        ORDER BY captured_at ASC`,
    );

    let summary = 'No wireless snapshots have been recorded yet.';
    let current: SnapshotRowBody | null = null;
    if (snapRows.length > 0) {
      const r = snapRows[0];
      current = {
        ap_total: r.ap_total, ap_online: r.ap_online, ap_offline: r.ap_offline, ap_unknown: r.ap_unknown,
        client_total: r.client_total, ssid_total: r.ssid_total,
        clients_by_ssid: r.clients_by_ssid ?? {}, aps_by_mac: r.aps_by_mac ?? {},
        stale: r.stale, section_errors: r.section_errors ?? {},
      };
      const eventsForSummary: DerivedEvent[] = eventRows.map((e: Record<string, unknown>) => ({
        event_type: e.event_type as DerivedEvent['event_type'],
        severity: e.severity as DerivedEvent['severity'],
        evidence: e.evidence as DerivedEvent['evidence'],
        summary: e.summary as string,
        detail: (e.detail ?? {}) as Record<string, unknown>,
      }));
      summary = summarize(current, eventsForSummary);
    }

    res.json({
      summary,
      current_snapshot: snapRows[0] ?? null,
      lkg: {
        // The in-memory cache the live /status route uses — surfaces
        // whether the next live read will paint stale data.
        system_fetched_at: lkg.system?.fetchedAt ? new Date(lkg.system.fetchedAt).toISOString() : null,
        aps_fetched_at: lkg.aps?.fetchedAt ? new Date(lkg.aps.fetchedAt).toISOString() : null,
        clients_fetched_at: lkg.clients?.fetchedAt ? new Date(lkg.clients.fetchedAt).toISOString() : null,
        ssids_fetched_at: lkg.ssids?.fetchedAt ? new Date(lkg.ssids.fetchedAt).toISOString() : null,
        last_success_at: lkg.lastSuccessAt ? new Date(lkg.lastSuccessAt).toISOString() : null,
      },
      recent_events: eventRows,
      event_count_24h: eventCount24h,
      history,
      retention_days: RETENTION_DAYS,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[wireless] diagnostics failed:', msg);
    res.status(500).json({ error: msg });
  }
});

router.get('/api/wireless/events', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const hours = Math.min(Math.max(parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 500);
    const { rows } = await dbQuery(
      `SELECT id, detected_at, event_type, severity, evidence, summary, detail
         FROM wireless_events
        WHERE detected_at > NOW() - INTERVAL '${hours} hours'
        ORDER BY detected_at DESC
        LIMIT $1`,
      [limit],
    );
    res.json({ events: rows, count: rows.length, window_hours: hours });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
