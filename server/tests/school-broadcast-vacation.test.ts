/**
 * Test: Vacation mode pauses the school morning broadcast (Task #463).
 *
 * Run while the `Start application` workflow is up:
 *   npx tsx server/tests/school-broadcast-vacation.test.ts
 *
 * Asserts:
 *   - When the "Getting Girls to School on Time" automation is OFF
 *     (is_active=false), POST /api/broadcast/school-morning returns
 *     skipped with reason=vacation_mode and never enters the TTS/HA
 *     broadcast path.
 *   - Fail-open: a MISSING automation row (and a present, active row) does
 *     NOT vacation-skip — the handler proceeds to the normal broadcast logic.
 *
 * Safety: the fail-open assertions call the endpoint WITHOUT the
 * `_test_force_slot` override, so a real broadcast can only fire during the
 * live 6:50-7:42 AM PT weekday window. If the test happens to run inside that
 * window it records the fail-open checks as skipped (so it never blasts the
 * real bedroom speakers). The vacation-skip assertions are always safe because
 * the handler returns before any broadcast work.
 *
 * The test snapshots and restores the automation row's original state, so it
 * leaves the database exactly as it found it.
 */
import { Pool } from "pg";

const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}/api/broadcast`;
const AUTOMATION_NAME = "Getting Girls to School on Time";
// Unique per run so a stray pre-existing row can never collide with our
// temporary rename and survive the restore.
const TMP_NAME = `${AUTOMATION_NAME}__vac_test_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

interface Result { test: string; passed: boolean; skipped?: boolean; detail: string }
const results: Result[] = [];
function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}
function recordSkip(test: string, detail: string) {
  results.push({ test, passed: true, skipped: true, detail });
}

// Mirror getLADate()/the broadcast-window guards in broadcast.ts so we know
// when a live broadcast could actually fire and avoid triggering it.
function inLiveBroadcastWindow(): boolean {
  const la = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
  );
  const dow = la.getDay();
  if (dow === 0 || dow === 6) return false; // weekend -> weekend-skip, safe
  const hour = la.getHours();
  const minute = la.getMinutes();
  const slot650 = (hour === 6 && minute >= 50) || (hour === 7 && minute < 10);
  const slot730 = hour === 7 && minute >= 25 && minute <= 42;
  return slot650 || slot730;
}

async function postSchoolMorning(): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}/school-morning`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

function isVacationSkip(body: any): boolean {
  return body?.skipped === true && body?.reason === "vacation_mode";
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — cannot run test.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Snapshot existing row(s) so we can restore exactly what we found.
  const { rows: existing } = await pool.query(
    "SELECT id, is_active FROM family_automations WHERE name = $1",
    [AUTOMATION_NAME],
  );
  let seededId: string | null = null;

  try {
    // Ensure a row exists so the test is runnable on a fresh database.
    if (existing.length === 0) {
      const ins = await pool.query(
        "INSERT INTO family_automations (name, is_active) VALUES ($1, true) RETURNING id",
        [AUTOMATION_NAME],
      );
      seededId = ins.rows[0].id as string;
    }

    // --- TEST 1: vacation ON -> skipped vacation_mode, no broadcast ---
    await pool.query(
      "UPDATE family_automations SET is_active = false WHERE name = $1",
      [AUTOMATION_NAME],
    );
    {
      const { status, body } = await postSchoolMorning();
      const skipped = isVacationSkip(body);
      const noBroadcast =
        body?.ttsMethod === undefined &&
        body?.test === undefined &&
        body?.errors === undefined;
      record(
        "vacation ON -> 200 skipped reason=vacation_mode",
        status === 200 && skipped,
        `status=${status} body=${JSON.stringify(body).slice(0, 140)}`,
      );
      record(
        "vacation skip performs no TTS/HA broadcast",
        skipped && noBroadcast,
        `ttsMethod=${body?.ttsMethod} test=${body?.test} errors=${JSON.stringify(body?.errors)}`,
      );
    }

    // --- TEST 2 & 3: fail-open -> handler must NOT vacation-skip ---
    if (inLiveBroadcastWindow()) {
      const note = "inside live broadcast window — not calling to avoid a real broadcast";
      recordSkip("fail-open: missing row proceeds (not vacation_mode)", note);
      recordSkip("fail-open: active row proceeds (not vacation_mode)", note);
    } else {
      // 2: missing row — rename so the name lookup returns zero rows.
      await pool.query(
        "UPDATE family_automations SET name = $2 WHERE name = $1",
        [AUTOMATION_NAME, TMP_NAME],
      );
      try {
        const { status, body } = await postSchoolMorning();
        record(
          "fail-open: missing row proceeds (not vacation_mode)",
          status === 200 && !isVacationSkip(body),
          `status=${status} reason=${body?.reason} test=${body?.test}`,
        );
      } finally {
        await pool.query(
          "UPDATE family_automations SET name = $2 WHERE name = $1",
          [TMP_NAME, AUTOMATION_NAME],
        );
      }

      // 3: present + active row — also must not vacation-skip.
      await pool.query(
        "UPDATE family_automations SET is_active = true WHERE name = $1",
        [AUTOMATION_NAME],
      );
      {
        const { status, body } = await postSchoolMorning();
        record(
          "fail-open: active row proceeds (not vacation_mode)",
          status === 200 && !isVacationSkip(body),
          `status=${status} reason=${body?.reason} test=${body?.test}`,
        );
      }
    }
  } finally {
    // Restore the database to exactly its pre-test state.
    try {
      // Undo a half-applied rename if the test threw mid-flight.
      await pool.query(
        "UPDATE family_automations SET name = $2 WHERE name = $1",
        [TMP_NAME, AUTOMATION_NAME],
      );
      if (seededId) {
        await pool.query("DELETE FROM family_automations WHERE id = $1", [seededId]);
      } else {
        for (const row of existing) {
          await pool.query(
            "UPDATE family_automations SET is_active = $2 WHERE id = $1",
            [row.id, row.is_active],
          );
        }
      }
    } finally {
      await pool.end();
    }
  }

  let allPassed = true;
  for (const r of results) {
    const status = r.skipped ? "SKIP" : r.passed ? "PASS" : "FAIL";
    if (!r.passed) allPassed = false;
    console.log(`[${status}] ${r.test} — ${r.detail}`);
  }
  const skippedCount = results.filter((r) => r.skipped).length;
  const ranCount = results.length - skippedCount;
  if (!allPassed) {
    console.error(`\n${results.filter((r) => !r.passed).length} test(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${ranCount} tests passed${skippedCount ? ` (${skippedCount} skipped)` : ""}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
