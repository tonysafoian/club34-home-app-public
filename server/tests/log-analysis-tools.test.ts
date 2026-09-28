/**
 * Coverage for the read-only diagnostics Janus tools.
 *
 * Exercises the diagnostics tools in server/utils/tools/research-admin.ts:
 *   - executeSearchSystemEvents — reads system_audit_log via the supabase shim
 *   - executeGetNetworkHistory  — reads network_health_snapshots via direct SQL
 *   - executeQueryActivityLog   — reads activity_events via the supabase shim
 *   - executeQuerySystemHealth  — reads janus_health_logs + system_audit_log
 *   - executeQuerySystemUpdates — reads system_updates via the supabase shim
 *
 * All talk straight to Postgres (the server-side supabase shim in
 * server/utils/supabase.ts runs SQL directly), so this test only needs
 * DATABASE_URL — no running HTTP server required.
 *
 * Run:
 *   npx tsx server/tests/log-analysis-tools.test.ts
 *
 * Asserts, for each tool, that it:
 *   1. executes without throwing
 *   2. returns a non-empty string
 *   3. does NOT return a TOOL_ERROR string (i.e. the underlying DB query ran)
 *
 * A "no rows" response (e.g. "No system events found…") is a valid PASS — it
 * still proves the query executed against the dev DB. Only a thrown error or a
 * "TOOL_ERROR:" prefix counts as a failure.
 */

import { getServiceClient } from "../utils/janus-tools.js";
import {
  executeSearchSystemEvents,
  executeGetNetworkHistory,
  executeQueryActivityLog,
  executeQuerySystemHealth,
  executeQuerySystemUpdates,
} from "../utils/tools/research-admin.js";

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];

function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

function assertGoodResult(label: string, out: unknown) {
  const isString = typeof out === "string";
  const str = isString ? (out as string) : "";
  const nonEmpty = str.trim().length > 0;
  const notError = !str.startsWith("TOOL_ERROR");
  record(
    label,
    isString && nonEmpty && notError,
    `type=${typeof out} len=${str.length} preview=${JSON.stringify(str.slice(0, 80))}`,
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set in this process — cannot run log-analysis tools test.");
    process.exit(2);
  }

  const svc = getServiceClient();

  // ── executeSearchSystemEvents ──────────────────────────────────────────────
  // Default call (last 24h, no filters).
  {
    const out = await executeSearchSystemEvents(undefined, undefined, undefined, undefined, svc);
    assertGoodResult("executeSearchSystemEvents (defaults) returns real string", out);
  }

  // Wide window + a search term — exercises the post-query text filter path.
  {
    const out = await executeSearchSystemEvents(168, undefined, undefined, "cron", svc);
    assertGoodResult("executeSearchSystemEvents (window+search) returns real string", out);
  }

  // ── executeGetNetworkHistory ───────────────────────────────────────────────
  // Default call (last 6h).
  {
    const out = await executeGetNetworkHistory(undefined);
    assertGoodResult("executeGetNetworkHistory (defaults) returns real string", out);
  }

  // Wider window — exercises the hours-clamp + aggregation path.
  {
    const out = await executeGetNetworkHistory(48);
    assertGoodResult("executeGetNetworkHistory (48h) returns real string", out);
  }

  // ── executeQueryActivityLog ────────────────────────────────────────────────
  // Reads activity_events. Default window (24h), no type filter.
  {
    const out = await executeQueryActivityLog(undefined, undefined, svc);
    assertGoodResult("executeQueryActivityLog (defaults) returns real string", out);
  }

  // Wider window + an event-type filter — exercises the .eq() filter path.
  {
    const out = await executeQueryActivityLog("system", 168, svc);
    assertGoodResult("executeQueryActivityLog (window+type) returns real string", out);
  }

  // ── executeQuerySystemHealth ───────────────────────────────────────────────
  // Reads janus_health_logs + system_audit_log.
  {
    const out = await executeQuerySystemHealth(svc);
    assertGoodResult("executeQuerySystemHealth returns real string", out);
  }

  // ── executeQuerySystemUpdates ──────────────────────────────────────────────
  // Reads system_updates. Default limit.
  {
    const out = await executeQuerySystemUpdates(undefined, svc);
    assertGoodResult("executeQuerySystemUpdates (defaults) returns real string", out);
  }

  // Explicit limit — exercises the limit path.
  {
    const out = await executeQuerySystemUpdates(10, svc);
    assertGoodResult("executeQuerySystemUpdates (limit) returns real string", out);
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
