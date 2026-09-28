/**
 * DB-layer round-trip test for the device-connection cache (Task #428 / #518).
 *
 * The pure resolution logic has unit tests
 * (server/__tests__/device-connection.test.ts), but the DB access layer in
 * server/lib/connection-cache.ts is otherwise only exercised live. This test
 * drives the real functions (writeCachedConnections / readCachedConnections /
 * invalidateConnectionCache) against the real dev DB and locks down the
 * invariants that a future change could silently break.
 *
 * Run (no workflow required — talks straight to Postgres):
 *   npx tsx server/tests/connection-cache.test.ts
 *
 * Asserts:
 *   - writeCachedConnections upserts a label on a brand-new MAC.
 *   - A SECOND write to an existing row updates the cache columns but does NOT
 *     bump network_devices.last_seen — this protects Ruckus recency
 *     (see .agents/memory/network-devices-recency.md).
 *   - readCachedConnections returns only rows that have BOTH a non-null
 *     resolved_connection and resolved_connection_at, and round-trips the
 *     exact jsonb ConnectionMethod shape.
 *   - invalidateConnectionCache nulls resolved_connection_at so the row is no
 *     longer returned by readCachedConnections (but keeps resolved_connection).
 *
 * Every row this test creates is tagged with a unique sentinel MAC prefix and
 * removed in a finally block, so it never touches real devices.
 */

import pg from "pg";
import {
  writeCachedConnections,
  readCachedConnections,
  invalidateConnectionCache,
} from "../lib/connection-cache.js";
import type { ConnectionMethod } from "../lib/connection-resolver.js";

// Unique sentinel prefix so we only ever read/clean up our own rows.
const TAG = `__cc_test_${process.pid}_${Date.now()}`;
const MAC_A = `${TAG}_a`;
const MAC_B = `${TAG}_b`;

const LABEL_A1: ConnectionMethod = {
  method: "wifi",
  ssid: "ClubTestNet",
  source: "ruckus_live",
  confidence: "confirmed",
  ssid_certain: true,
};
const LABEL_A2: ConnectionMethod = {
  method: "wired",
  ssid: null,
  source: "heuristic",
  confidence: "inferred",
  ssid_certain: false,
};
const LABEL_B: ConnectionMethod = {
  method: "wifi",
  ssid: "ClubTestNet5G",
  source: "ruckus_recent",
  confidence: "recent",
  ssid_certain: false,
};

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];
function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

function sameLabel(a: ConnectionMethod | null | undefined, b: ConnectionMethod): boolean {
  return !!a &&
    a.method === b.method &&
    a.ssid === b.ssid &&
    a.source === b.source &&
    a.confidence === b.confidence &&
    a.ssid_certain === b.ssid_certain;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set in this process — cannot run connection-cache test.");
    process.exit(2);
  }

  // Independent pool used only for setup/verification reads + cleanup, so the
  // assertions don't depend on the module-under-test for ground truth.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // ── 1. First write upserts a brand-new row ──────────────────────────────
    await writeCachedConnections([{ mac: MAC_A, connection: LABEL_A1 }]);
    {
      const { rows } = await pool.query(
        `SELECT resolved_connection, resolved_connection_at, last_seen
           FROM network_devices WHERE mac_address = $1`,
        [MAC_A],
      );
      const row = rows[0];
      const stored = row?.resolved_connection as ConnectionMethod | null;
      const hasAt = !!row?.resolved_connection_at;
      record(
        "writeCachedConnections inserts a new row with label + timestamp",
        !!row && sameLabel(stored, LABEL_A1) && hasAt,
        row ? `label_ok=${sameLabel(stored, LABEL_A1)} has_at=${hasAt}` : "ROW MISSING",
      );
    }

    // ── 2. Second write must NOT bump last_seen ─────────────────────────────
    // Backdate last_seen to a known value, then re-write the cache for the same
    // MAC. The ON CONFLICT update must leave last_seen untouched.
    let backdated: number;
    {
      const { rows } = await pool.query(
        `UPDATE network_devices
            SET last_seen = NOW() - INTERVAL '2 hours'
          WHERE mac_address = $1
        RETURNING last_seen`,
        [MAC_A],
      );
      backdated = new Date(rows[0].last_seen).getTime();
    }

    await writeCachedConnections([{ mac: MAC_A, connection: LABEL_A2 }]);
    {
      const { rows } = await pool.query(
        `SELECT resolved_connection, resolved_connection_at, last_seen
           FROM network_devices WHERE mac_address = $1`,
        [MAC_A],
      );
      const row = rows[0];
      const afterLastSeen = new Date(row.last_seen).getTime();
      const stored = row?.resolved_connection as ConnectionMethod | null;
      const labelUpdated = sameLabel(stored, LABEL_A2);
      const lastSeenUnchanged = afterLastSeen === backdated;
      record(
        "second write updates the label but does NOT bump last_seen",
        labelUpdated && lastSeenUnchanged,
        `label_updated=${labelUpdated} last_seen_unchanged=${lastSeenUnchanged} ` +
          `(backdated=${backdated} after=${afterLastSeen})`,
      );
    }

    // ── 3. readCachedConnections filters NULL-timestamp rows + round-trips ───
    // MAC_B has a label but a NULL resolved_connection_at — it must be excluded.
    await pool.query(
      `INSERT INTO network_devices (mac_address, resolved_connection, resolved_connection_at, first_seen, last_seen)
       VALUES ($1, $2::jsonb, NULL, NOW(), NOW())
       ON CONFLICT (mac_address) DO UPDATE
         SET resolved_connection = EXCLUDED.resolved_connection,
             resolved_connection_at = NULL`,
      [MAC_B, JSON.stringify(LABEL_B)],
    );
    {
      const map = await readCachedConnections([MAC_A, MAC_B]);
      const a = map.get(MAC_A);
      const roundTrips = sameLabel(a?.connection, LABEL_A2) &&
        typeof a?.resolvedAt === "number" && Number.isFinite(a.resolvedAt);
      const excludesNullAt = !map.has(MAC_B);
      record(
        "readCachedConnections returns only fully-cached rows and round-trips the jsonb shape",
        roundTrips && excludesNullAt,
        `round_trips_A=${roundTrips} excludes_null_at_B=${excludesNullAt} size=${map.size}`,
      );
    }

    // ── 4. invalidateConnectionCache nulls resolved_connection_at ───────────
    await invalidateConnectionCache([MAC_A]);
    {
      const map = await readCachedConnections([MAC_A]);
      const noLongerReturned = !map.has(MAC_A);

      const { rows } = await pool.query(
        `SELECT resolved_connection, resolved_connection_at
           FROM network_devices WHERE mac_address = $1`,
        [MAC_A],
      );
      const row = rows[0];
      const atCleared = row && row.resolved_connection_at === null;
      const labelRetained = sameLabel(row?.resolved_connection as ConnectionMethod | null, LABEL_A2);
      record(
        "invalidateConnectionCache nulls resolved_connection_at so the row drops out of reads",
        noLongerReturned && atCleared && labelRetained,
        `not_returned=${noLongerReturned} at_cleared=${atCleared} label_retained=${labelRetained}`,
      );
    }
  } finally {
    // Remove every row this test created, regardless of outcome.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM network_devices WHERE mac_address LIKE $1`,
        [`${TAG}%`],
      );
      console.log(`[cleanup] removed ${rowCount ?? 0} test row(s)`);
    } catch (e) {
      console.error("[cleanup] failed to remove test rows:", e);
    }
    await pool.end();
  }

  let allPassed = true;
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    if (!r.passed) allPassed = false;
    console.log(`[${status}] ${r.test} — ${r.detail}`);
  }
  if (!allPassed) {
    console.error(`\n${results.filter((r) => !r.passed).length} test(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} tests passed.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
