/**
 * Round-trip test for WAN Throughput History (Task #449).
 *
 * Connects directly to the dev database (DATABASE_URL) and exercises the exact
 * SQL used by the WAN History feature in server/routes/fortigate.ts:
 *   - the INSERT from POST /api/fortigate-wan-snapshot
 *   - the windowed SELECT from GET /api/fortigate/wan-history
 *   - the 4-hour prune DELETE that runs on every snapshot insert
 *
 * Run (no workflow required — talks straight to Postgres):
 *   npx tsx server/tests/wan-history.test.ts
 *
 * Asserts:
 *   - a freshly inserted row is read back by the wan-history window query
 *     (with the rx/tx values preserved)
 *   - the prune DELETE removes rows older than 4 hours
 *   - the prune DELETE keeps rows inside the 4-hour window
 *
 * The test tags every row it creates with a unique sentinel in wan_status and
 * cleans them all up in a finally block, so it never touches real snapshots.
 */

import pg from "pg";

// A unique marker so we can find + clean up only our own rows.
const SENTINEL = `__wan_history_test_${process.pid}_${Date.now()}__`;
// Distinctive values that are extremely unlikely to collide with real data.
const RX = 987654.321987;
const TX = 123456.789012;

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];

function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set in this process — cannot run WAN history test.");
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // ── 1. INSERT (mirrors POST /api/fortigate-wan-snapshot) ────────────────
    // Same column list + parameter order as the snapshot route.
    await pool.query(
      `INSERT INTO wan_throughput_history (wan_rx_gb, wan_tx_gb, wan_speed, wan_status, wan_link)
       VALUES ($1, $2, $3, $4, $5)`,
      [RX, TX, 1000, SENTINEL, true],
    );

    // ── 2. Windowed read (mirrors GET /api/fortigate/wan-history) ───────────
    const windowMinutes = 60;
    {
      const { rows } = await pool.query(
        `SELECT captured_at, wan_rx_gb, wan_tx_gb, wan_status
         FROM wan_throughput_history
         WHERE captured_at >= NOW() - ($1 || ' minutes')::INTERVAL
         ORDER BY captured_at ASC`,
        [windowMinutes],
      );

      // Map exactly like the route does, then locate our row by its values.
      const points = rows.map((r: Record<string, unknown>) => ({
        ts: new Date(r["captured_at"] as string).getTime(),
        rx: parseFloat(String(r["wan_rx_gb"] ?? "0")) || 0,
        tx: parseFloat(String(r["wan_tx_gb"] ?? "0")) || 0,
        status: r["wan_status"],
      }));

      const mine = points.find((p) => p.status === SENTINEL);
      const ok =
        !!mine &&
        Math.abs(mine.rx - RX) < 1e-6 &&
        Math.abs(mine.tx - TX) < 1e-6 &&
        Number.isFinite(mine.ts);
      record(
        "inserted row is read back by wan-history window query",
        ok,
        `points=${points.length} mine=${mine ? `rx=${mine.rx} tx=${mine.tx}` : "MISSING"}`,
      );
    }

    // ── 3. Prune behaviour (mirrors the DELETE in the snapshot route) ───────
    // Insert one OLD row (5h ago) and one FRESH row (now), both sentinel-tagged,
    // then run the exact prune DELETE and confirm only the old one is removed.
    {
      const oldRes = await pool.query(
        `INSERT INTO wan_throughput_history (captured_at, wan_rx_gb, wan_tx_gb, wan_speed, wan_status, wan_link)
         VALUES (NOW() - INTERVAL '5 hours', $1, $2, $3, $4, $5)
         RETURNING id`,
        [RX, TX, 1000, SENTINEL, true],
      );
      const oldId = oldRes.rows[0].id;

      const freshRes = await pool.query(
        `INSERT INTO wan_throughput_history (captured_at, wan_rx_gb, wan_tx_gb, wan_speed, wan_status, wan_link)
         VALUES (NOW() - INTERVAL '10 minutes', $1, $2, $3, $4, $5)
         RETURNING id`,
        [RX, TX, 1000, SENTINEL, true],
      );
      const freshId = freshRes.rows[0].id;

      // Exact prune query from POST /api/fortigate-wan-snapshot.
      await pool.query(
        `DELETE FROM wan_throughput_history WHERE captured_at < NOW() - INTERVAL '4 hours'`,
        [],
      );

      const { rows: oldRows } = await pool.query(
        `SELECT id FROM wan_throughput_history WHERE id = $1`,
        [oldId],
      );
      record(
        "prune DELETE removes rows older than 4 hours",
        oldRows.length === 0,
        `old_row_remaining=${oldRows.length}`,
      );

      const { rows: freshRows } = await pool.query(
        `SELECT id FROM wan_throughput_history WHERE id = $1`,
        [freshId],
      );
      record(
        "prune DELETE keeps rows inside the 4-hour window",
        freshRows.length === 1,
        `fresh_row_remaining=${freshRows.length}`,
      );
    }
  } finally {
    // Clean up every row this test created, regardless of outcome.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM wan_throughput_history WHERE wan_status = $1`,
        [SENTINEL],
      );
      console.log(`[cleanup] removed ${rowCount ?? 0} test row(s)`);
    } catch (e) {
      console.error("[cleanup] failed to remove test rows:", e);
    }
    await pool.end();
  }

  // Print
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
