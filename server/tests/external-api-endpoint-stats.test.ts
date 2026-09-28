/**
 * external-api-endpoint-stats.test.ts
 *
 * Regression test for the External API "slowest endpoints" aggregation
 * (storage.getExternalApiEndpointStats), which backs the Live activity panel
 * on Admin → API.
 *
 * Core guarantee under test: stats are aggregated in SQL over the FULL time
 * window, so an old slow/error-prone endpoint is still reported accurately
 * even when more than 5,000 newer calls exist in the same window (a client
 * that only read the newest N rows would miss it entirely).
 *
 * Also verifies:
 *   - tools.invoke rows are keyed per-tool as tools/<tool>/invoke
 *   - middleware pseudo-endpoints (auth/rate_limit/not_found) are excluded
 *   - error counts and avg/p95 durations are computed per endpoint
 *
 * DB-only test: requires DATABASE_URL (no HTTP server needed).
 * Exit codes: 0 = pass, 2 = missing prerequisite, 1 = failure.
 */

import { pool } from "../db";
import { storage } from "../storage";

const MARKER = "TEST endpoint-stats seed (external-api-endpoint-stats.test.ts)";
const FAST_EP = "external_api.stats_test.fast";
const SLOW_EP = "external_api.stats_test.slow";
const TOOL_NAME = "stats_test_tool";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (ok) {
    console.log(`  PASS: ${name}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures++;
    console.error(`  FAIL: ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function cleanup() {
  await pool.query(`DELETE FROM system_audit_log WHERE summary = $1`, [MARKER]);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — skipping.");
    process.exit(2);
  }

  await cleanup();
  try {
    // 5,050 recent fast success calls — more than any single client page.
    await pool.query(
      `INSERT INTO system_audit_log (category, event_type, severity, actor_name, channel, summary, detail, status, created_at)
       SELECT 'external_api', $1::text, 'info', 'external-api', 'api', $2::text,
              jsonb_build_object('source','external_api','duration_ms', 50),
              'success', now() - (i * interval '2 seconds')
       FROM generate_series(1, 5050) i`,
      [FAST_EP, MARKER],
    );
    // 40 OLD slow calls ~23h ago, 10 of them errors. These only surface if the
    // aggregation truly covers the whole window.
    await pool.query(
      `INSERT INTO system_audit_log (category, event_type, severity, actor_name, channel, summary, detail, status, created_at)
       SELECT 'external_api', $1::text, 'info', 'external-api', 'api', $2::text,
              jsonb_build_object('source','external_api','duration_ms', 5000),
              CASE WHEN i <= 10 THEN 'error' ELSE 'success' END,
              now() - interval '23 hours' - (i * interval '10 seconds')
       FROM generate_series(1, 40) i`,
      [SLOW_EP, MARKER],
    );
    // One tools.invoke row → must be keyed per-tool.
    await pool.query(
      `INSERT INTO system_audit_log (category, event_type, severity, actor_name, channel, summary, detail, status, created_at)
       VALUES ('external_api', 'external_api.tools.invoke', 'info', 'external-api', 'api', $1,
               jsonb_build_object('source','external_api','duration_ms', 7000, 'tool', $2::text),
               'success', now() - interval '22 hours')`,
      [MARKER, TOOL_NAME],
    );
    // Middleware pseudo-endpoint rows → must be excluded from stats.
    await pool.query(
      `INSERT INTO system_audit_log (category, event_type, severity, actor_name, channel, summary, detail, status, created_at)
       VALUES
         ('external_api', 'external_api.auth', 'warning', 'external-api', 'api', $1, jsonb_build_object('duration_ms', 99999), 'denied', now() - interval '1 hour'),
         ('external_api', 'external_api.rate_limit', 'warning', 'external-api', 'api', $1, jsonb_build_object('duration_ms', 99999), 'denied', now() - interval '1 hour')`,
      [MARKER],
    );

    // topN large enough that pre-existing dev rows can't push our endpoints out.
    const stats = await storage.getExternalApiEndpointStats(24, 25);
    const byKey = new Map(stats.map((s) => [s.endpoint, s]));

    const slow = byKey.get("stats_test.slow");
    check("old slow endpoint present despite >5000 newer rows in window", !!slow);
    if (slow) {
      check("slow endpoint calls = 40", slow.calls === 40, `calls=${slow.calls}`);
      check("slow endpoint errors = 10", slow.errors === 10, `errors=${slow.errors}`);
      check("slow endpoint avg ≈ 5000ms", Math.abs(slow.avgMs - 5000) < 1, `avgMs=${slow.avgMs}`);
      check("slow endpoint p95 ≈ 5000ms", Math.abs(slow.p95Ms - 5000) < 1, `p95Ms=${slow.p95Ms}`);
      check("numeric fields are numbers, not strings", typeof slow.avgMs === "number" && typeof slow.p95Ms === "number");
    }

    const fast = byKey.get("stats_test.fast");
    check("fast endpoint present", !!fast);
    if (fast) {
      check("fast endpoint calls = 5050 (full window, no row cap)", fast.calls === 5050, `calls=${fast.calls}`);
      check("fast endpoint p95 ≈ 50ms", Math.abs(fast.p95Ms - 50) < 1, `p95Ms=${fast.p95Ms}`);
    }

    const tool = byKey.get(`tools/${TOOL_NAME}/invoke`);
    check("tools.invoke keyed per-tool as tools/<tool>/invoke", !!tool, tool ? `p95Ms=${tool.p95Ms}` : "missing");

    check(
      "middleware pseudo-endpoints excluded",
      !byKey.has("auth") && !byKey.has("rate_limit") && !byKey.has("not_found"),
    );

    const idxSlow = stats.findIndex((s) => s.endpoint === "stats_test.slow");
    const idxFast = stats.findIndex((s) => s.endpoint === "stats_test.fast");
    check(
      "ordering: slow endpoint ranked above fast endpoint (p95 DESC)",
      idxSlow !== -1 && idxFast !== -1 && idxSlow < idxFast,
      `idxSlow=${idxSlow} idxFast=${idxFast}`,
    );
  } finally {
    await cleanup();
    await pool.end().catch(() => {});
  }

  if (failures > 0) {
    console.error(`${failures} FAILURES`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

main().catch(async (err) => {
  console.error("Test crashed:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});
