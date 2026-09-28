/**
 * DB-backed cache for resolved connection-method labels.
 *
 * Resolving each device's Wired/WiFi label requires the Ruckus observation
 * maps (a scan of network_devices) plus the 4-tier ladder per device. The
 * Ruckus snapshot cron already has fresh controller data every 5 min, so it
 * recomputes the label for every FortiGate device and persists it into
 * network_devices.resolved_connection. The devices endpoint then reads that
 * cached value instead of re-running the scan + ladder on every request.
 *
 * Staleness: a cache entry is trusted for CONNECTION_CACHE_TTL_MS. That is a
 * little longer than the 5-min cron cadence so one missed tick doesn't force
 * the endpoint back onto the slow path, but short enough that if the cron
 * stops entirely the endpoint self-heals onto live computation.
 *
 * This module owns all DB access so connection-resolver.ts stays pure
 * (and trivially unit-testable).
 */

import { query as dbQuery } from './db.js';
import {
  buildRuckusMaps,
  RECENT_WINDOW_MS,
  LIVE_WINDOW_MS,
  type ConnectionMethod,
  type ConnectionResolverContext,
} from './connection-resolver.js';

// Trust a cached label for slightly longer than the 5-min cron cadence so a
// single missed tick doesn't drop the endpoint onto the slow path.
export const CONNECTION_CACHE_TTL_MS = 10 * 60 * 1000;

export interface CachedConnection {
  connection: ConnectionMethod;
  /** Epoch ms when the label was last (re)computed. */
  resolvedAt: number;
}

interface RuckusDbRow {
  mac_address: string;
  ssids: string[] | null;
  last_seen: Date | string | null;
}

/**
 * Compute the Ruckus feed-health flag from wireless_snapshots — the
 * Ruckus-specific cron timestamp. (network_devices.last_seen is also bumped
 * by FortiGate DHCP/ARP ingestion, so it cannot be used to judge whether the
 * Ruckus controller itself is actually reporting.)
 */
export async function getRuckusFeedHealthy(): Promise<boolean> {
  try {
    const { rows } = await dbQuery(`SELECT MAX(captured_at) AS last_snap FROM wireless_snapshots`, []);
    const lastSnap = (rows[0] as { last_snap: Date | string | null } | undefined)?.last_snap;
    if (!lastSnap) return false;
    const snapMs = lastSnap instanceof Date ? lastSnap.getTime() : new Date(String(lastSnap)).getTime();
    return !isNaN(snapMs) && (Date.now() - snapMs) <= LIVE_WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Load the live ladder inputs (Ruckus observation maps + feed-health flag)
 * from the DB. This is the work the cache lets us skip on the hot path.
 */
export async function loadRuckusContext(): Promise<ConnectionResolverContext> {
  let ruckusRows: RuckusDbRow[] = [];
  let ruckusFeedHealthy = false;
  try {
    const recentWindowInterval = `${Math.ceil(RECENT_WINDOW_MS / 60000)} minutes`;
    const [ndRes, snapRes] = await Promise.all([
      dbQuery<RuckusDbRow>(
        `SELECT mac_address, ssids, last_seen
           FROM network_devices
          WHERE ssids IS NOT NULL
            AND jsonb_array_length(ssids) > 0
            AND last_seen >= NOW() - $1::interval`,
        [recentWindowInterval],
      ),
      dbQuery(`SELECT MAX(captured_at) AS last_snap FROM wireless_snapshots`, [])
        .catch(() => ({ rows: [] as Array<{ last_snap: Date | string | null }> })),
    ]);
    ruckusRows = ndRes.rows;

    const snapRow = (snapRes.rows as Array<{ last_snap: Date | string | null }>)[0];
    if (snapRow?.last_snap) {
      const snapMs = snapRow.last_snap instanceof Date
        ? snapRow.last_snap.getTime()
        : new Date(String(snapRow.last_snap)).getTime();
      ruckusFeedHealthy = !isNaN(snapMs) && (Date.now() - snapMs) <= LIVE_WINDOW_MS;
    }
  } catch (e) {
    console.warn('[connection-cache] Ruckus observation lookup failed:', e instanceof Error ? e.message : e);
  }
  const { liveRuckusByMac, recentRuckusByMac } = buildRuckusMaps(ruckusRows, ruckusFeedHealthy);
  return { liveRuckusByMac, recentRuckusByMac, ruckusFeedHealthy };
}

/**
 * Batch-read cached connection labels for a set of normalized MACs. Only
 * rows that actually have a cached value are returned; the caller applies
 * the TTL freshness check.
 */
export async function readCachedConnections(macs: string[]): Promise<Map<string, CachedConnection>> {
  const out = new Map<string, CachedConnection>();
  const unique = Array.from(new Set(macs.filter((m): m is string => typeof m === 'string' && m.length > 0)));
  if (unique.length === 0) return out;

  const res = await dbQuery(
    `SELECT mac_address, resolved_connection, resolved_connection_at
       FROM network_devices
      WHERE mac_address = ANY($1::text[])
        AND resolved_connection IS NOT NULL
        AND resolved_connection_at IS NOT NULL`,
    [unique],
  );

  for (const raw of res.rows as Array<Record<string, unknown>>) {
    const mac = String(raw.mac_address ?? '');
    if (!mac) continue;
    const atRaw = raw.resolved_connection_at;
    const at = atRaw instanceof Date ? atRaw.getTime() : new Date(String(atRaw)).getTime();
    if (isNaN(at)) continue;
    const conn = raw.resolved_connection as ConnectionMethod | null;
    if (!conn) continue;
    out.set(mac, { connection: conn, resolvedAt: at });
  }
  return out;
}

/**
 * Persist resolved connection labels for a batch of devices. Upserts so a
 * FortiGate device that isn't in network_devices yet still gets cached; on
 * conflict only the cache columns are touched (last_seen is NOT bumped, so
 * Ruckus recency semantics are unaffected).
 */
export async function writeCachedConnections(
  entries: Array<{ mac: string; connection: ConnectionMethod }>,
): Promise<void> {
  if (entries.length === 0) return;
  const macs: string[] = [];
  const jsons: string[] = [];
  for (const e of entries) {
    if (!e.mac) continue;
    macs.push(e.mac);
    jsons.push(JSON.stringify(e.connection));
  }
  if (macs.length === 0) return;

  await dbQuery(
    `INSERT INTO network_devices (mac_address, resolved_connection, resolved_connection_at, first_seen, last_seen)
     SELECT m, j::jsonb, NOW(), NOW(), NOW()
       FROM unnest($1::text[], $2::text[]) AS t(m, j)
     ON CONFLICT (mac_address) DO UPDATE
       SET resolved_connection    = EXCLUDED.resolved_connection,
           resolved_connection_at = EXCLUDED.resolved_connection_at`,
    [macs, jsons],
  );
}

/** Freshness summary of the connection-method cache, for observability. */
export interface ConnectionCacheFreshness {
  /** Epoch ms of the oldest cached label (MIN resolved_connection_at), or null when empty. */
  oldest: number | null;
  /** Epoch ms of the newest cached label (MAX resolved_connection_at), or null when empty. */
  newest: number | null;
  /** Number of devices with a cached label. */
  count: number;
}

/**
 * Summarize how stale the cached connection labels are. The newest timestamp
 * answers "labels last refreshed N min ago" for the admin UI; the oldest flags
 * devices the cron hasn't touched in a while. Best-effort: returns an empty
 * summary on any DB error so it can never break the devices endpoint.
 */
export async function getConnectionCacheFreshness(): Promise<ConnectionCacheFreshness> {
  try {
    const { rows } = await dbQuery(
      `SELECT MIN(resolved_connection_at) AS oldest,
              MAX(resolved_connection_at) AS newest,
              COUNT(*)::int               AS cnt
         FROM network_devices
        WHERE resolved_connection_at IS NOT NULL`,
      [],
    );
    const row = rows[0] as { oldest: Date | string | null; newest: Date | string | null; cnt: number | string } | undefined;
    const toMs = (v: Date | string | null): number | null => {
      if (!v) return null;
      const ms = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
      return isNaN(ms) ? null : ms;
    };
    return {
      oldest: toMs(row?.oldest ?? null),
      newest: toMs(row?.newest ?? null),
      count: Number(row?.cnt ?? 0) || 0,
    };
  } catch (e) {
    console.warn('[connection-cache] freshness lookup failed:', e instanceof Error ? e.message : e);
    return { oldest: null, newest: null, count: 0 };
  }
}

/**
 * Invalidate cached labels for the given MACs (e.g. after an admin changes a
 * device's category override, which can flip the Tier-3 heuristic). Clearing
 * resolved_connection_at forces the endpoint to recompute live + write-through.
 */
export async function invalidateConnectionCache(macs: string[]): Promise<void> {
  const unique = Array.from(new Set(macs.filter((m): m is string => typeof m === 'string' && m.length > 0)));
  if (unique.length === 0) return;
  await dbQuery(
    `UPDATE network_devices SET resolved_connection_at = NULL WHERE mac_address = ANY($1::text[])`,
    [unique],
  );
}
