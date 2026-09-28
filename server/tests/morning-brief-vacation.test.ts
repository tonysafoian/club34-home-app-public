/**
 * Test: Vacation mode pauses the Morning Brief Email (Task #468).
 *
 * Run while the `Start application` workflow is up:
 *   npx tsx server/tests/morning-brief-vacation.test.ts
 *
 * Asserts (mirrors server/tests/school-broadcast-vacation.test.ts):
 *   - When the "Morning Brief Email" automation is OFF (is_active=false),
 *     POST /api/reports/morning-weather returns skipped with
 *     reason=vacation_mode, sends no email, and reserves NO dedup row
 *     (the vacation gate runs BEFORE the dedup insert).
 *   - Fail-open: a MISSING automation row (and a present, active row) does
 *     NOT vacation-skip — the handler proceeds PAST the vacation gate.
 *
 * Safety: the handler has no time-window guard, so a non-vacation run would
 * generate and send a real brief email (OpenRouter + Gmail). To prove the
 * fail-open path proceeds past the vacation gate WITHOUT sending anything,
 * we pre-insert the day's dedup row first; the handler then short-circuits
 * at the dedup check with reason=already_sent_today. That reason proves the
 * vacation gate was passed (it would have returned vacation_mode otherwise)
 * while guaranteeing no email is generated or sent.
 *
 * The morning-weather route is behind requireAuth; we authenticate with the
 * same x-cron-secret header the cron scheduler uses.
 *
 * The test snapshots and restores both the automation row state and the
 * day's dedup row, so it leaves the database exactly as it found it.
 */
import { Pool } from "pg";

const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}/api/reports`;
const AUTOMATION_NAME = "Morning Brief Email";
const REPORT_TYPE = "morning-weather";
// Unique per run so a stray pre-existing row can never collide with our
// temporary rename and survive the restore.
const TMP_NAME = `${AUTOMATION_NAME}__vac_test_tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Same LA-local date key the handler computes for the dedup period.
const PERIOD_KEY = new Date().toLocaleDateString("en-CA", {
  timeZone: "America/Los_Angeles",
});

const CRON_SECRET = process.env.CRON_SECRET || "";

interface Result { test: string; passed: boolean; skipped?: boolean; detail: string }
const results: Result[] = [];
function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

async function postMorningWeather(): Promise<{ status: number; body: any }> {
  const r = await fetch(`${BASE}/morning-weather`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-cron-secret": CRON_SECRET,
    },
    body: "{}",
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

function isVacationSkip(body: any): boolean {
  return body?.skipped === true && body?.reason === "vacation_mode";
}

async function dedupExists(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM report_email_dedup WHERE report_type = $1 AND period_key = $2",
    [REPORT_TYPE, PERIOD_KEY],
  );
  return rows.length > 0;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — cannot run test.");
    process.exit(2);
  }
  if (!CRON_SECRET) {
    console.error("CRON_SECRET not set — cannot authenticate to the route.");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Snapshot existing state so we can restore exactly what we found.
  const { rows: existing } = await pool.query(
    "SELECT id, is_active FROM family_automations WHERE name = $1",
    [AUTOMATION_NAME],
  );
  const dedupExistedBefore = await dedupExists(pool);
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

    // --- TEST 1: vacation ON -> skipped vacation_mode, no email, no dedup row ---
    // Clear any dedup row first so we can prove the gate runs BEFORE dedup and
    // reserves nothing.
    await pool.query(
      "DELETE FROM report_email_dedup WHERE report_type = $1 AND period_key = $2",
      [REPORT_TYPE, PERIOD_KEY],
    );
    await pool.query(
      "UPDATE family_automations SET is_active = false WHERE name = $1",
      [AUTOMATION_NAME],
    );
    {
      const { status, body } = await postMorningWeather();
      const skipped = isVacationSkip(body);
      record(
        "vacation ON -> 200 skipped reason=vacation_mode",
        status === 200 && skipped,
        `status=${status} body=${JSON.stringify(body).slice(0, 140)}`,
      );

      const reservedDedup = await dedupExists(pool);
      record(
        "vacation skip reserves no dedup row",
        skipped && !reservedDedup,
        `dedupRowPresent=${reservedDedup}`,
      );
    }

    // --- TEST 2 & 3: fail-open -> handler must NOT vacation-skip ---
    // Pre-insert the day's dedup row so a proceeding handler short-circuits at
    // the dedup check (reason=already_sent_today) instead of sending an email.
    await pool.query(
      `INSERT INTO report_email_dedup (report_type, period_key)
       VALUES ($1, $2)
       ON CONFLICT (report_type, period_key) DO NOTHING`,
      [REPORT_TYPE, PERIOD_KEY],
    );

    // 2: missing row — rename so the name lookup returns zero rows.
    await pool.query(
      "UPDATE family_automations SET name = $2 WHERE name = $1",
      [AUTOMATION_NAME, TMP_NAME],
    );
    try {
      const { status, body } = await postMorningWeather();
      record(
        "fail-open: missing row proceeds (not vacation_mode)",
        status === 200 && body?.skipped === true && !isVacationSkip(body),
        `status=${status} reason=${body?.reason}`,
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
      const { status, body } = await postMorningWeather();
      record(
        "fail-open: active row proceeds (not vacation_mode)",
        status === 200 && body?.skipped === true && !isVacationSkip(body),
        `status=${status} reason=${body?.reason}`,
      );
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
      // Restore the dedup row to its pre-test presence.
      if (!dedupExistedBefore) {
        await pool.query(
          "DELETE FROM report_email_dedup WHERE report_type = $1 AND period_key = $2",
          [REPORT_TYPE, PERIOD_KEY],
        );
      } else {
        await pool.query(
          `INSERT INTO report_email_dedup (report_type, period_key)
           VALUES ($1, $2)
           ON CONFLICT (report_type, period_key) DO NOTHING`,
          [REPORT_TYPE, PERIOD_KEY],
        );
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
