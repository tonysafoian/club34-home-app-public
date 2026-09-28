/**
 * Regression test for the light-timer exclusion list
 * (server/routes/energySavings.ts).
 *
 * Enzo's bathroom used to be excluded from the 15-minute bathroom timer by a
 * hardcoded name check; it is now driven by an admin-editable
 * `config.excluded_terms` list on each timer's family_automations row
 * (seeded by migrations/0052_light_timer_exclusions.sql).
 *
 * Run:
 *   npx tsx server/tests/light-timer-exclusions.test.ts
 *
 * Pure-function assertions need nothing; the seeded-DB assertion needs
 * DATABASE_URL, and the authorization assertions need the HTTP server on
 * localhost:$PORT plus JWT_SECRET/SESSION_SECRET to mint test tokens
 * (exit 2 when a prerequisite is missing).
 *
 * Asserts:
 *   - excludedTerms() normalizes valid configs and tolerates malformed ones
 *   - isExcluded() matches entity_id and friendly name, case-insensitively
 *   - classification is unchanged (enzo bathroom IS a bathroom again —
 *     exclusion happens via config, not classification)
 *   - the Bathroom Light Timer row in the DB carries the seeded "enzo" term,
 *     so current behavior is preserved on deploy
 *   - PUT /api/energy/exclusions is truly admin-only: 401 unauthenticated,
 *     403 for a member, 200 for an admin (normalized, other config keys kept)
 *   - the generic /api/db/update proxy rejects non-admin
 *     family_automations.config writes but still allows a member to toggle
 *     is_active (vacation mode)
 *   - the scoped endpoint validates automationName and excludedTerms shape
 */

import {
  excludedTerms,
  isExcluded,
  isBathroom,
  isCloset,
  isPrimaryBath,
  type LightState,
} from "../routes/energySavings.js";
import type { AutomationConfigRow } from "../../shared/dbRows.js";

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];
function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

function light(entityId: string, friendlyName: string): LightState {
  return { entity_id: entityId, state: "on", friendly_name: friendlyName, last_changed: new Date().toISOString() };
}

function row(config: unknown): AutomationConfigRow {
  return { id: "test", is_active: true, config: config as AutomationConfigRow["config"] };
}

async function main() {
  // ── excludedTerms() parsing ──
  record(
    "valid config is normalized (trim/lowercase, empties dropped)",
    JSON.stringify(excludedTerms(row({ excluded_terms: [" Enzo ", "GUEST bath", "", "   "] }))) ===
      JSON.stringify(["enzo", "guest bath"]),
    JSON.stringify(excludedTerms(row({ excluded_terms: [" Enzo ", "GUEST bath", "", "   "] }))),
  );
  const malformed: Array<[string, AutomationConfigRow | null]> = [
    ["null automation row", null],
    ["null config", row(null)],
    ["empty config", row({})],
    ["non-array excluded_terms", row({ excluded_terms: "enzo" })],
    ["array config (not an object)", row(["enzo"])],
    ["non-string entries", row({ excluded_terms: [42, null, { a: 1 }] })],
  ];
  for (const [label, r] of malformed) {
    const terms = excludedTerms(r);
    record(`malformed config yields [] (${label})`, Array.isArray(terms) && terms.length === 0, JSON.stringify(terms));
  }

  // ── isExcluded() matching ──
  const enzoBath = light("light.enzo_bathroom", "Enzo's Bathroom");
  record("matches entity_id substring", isExcluded(enzoBath, ["enzo"]), "term=enzo");
  record("matches friendly name substring", isExcluded(light("light.kids_1", "Enzo Bathroom"), ["enzo"]), "term=enzo");
  record("no match → not excluded", !isExcluded(light("light.primary_bath", "Primary Bath"), ["enzo"]), "term=enzo");
  record("empty term list → nothing excluded", !isExcluded(enzoBath, []), "terms=[]");

  // ── classification unchanged (exclusion moved out of isBathroom) ──
  record("enzo bathroom classifies as a bathroom", isBathroom(enzoBath), "isBathroom(enzo_bathroom)");
  record("water closet is a bathroom, not a closet", isBathroom(light("light.water_closet", "Water Closet")) && !isCloset(light("light.water_closet", "Water Closet")), "water_closet");
  record("primary bath detected", isPrimaryBath(light("light.primary_bathroom", "Primary Bathroom")), "primary_bathroom");
  record("plain closet is a closet", isCloset(light("light.hall_closet", "Hall Closet")), "hall_closet");

  // ── seeded DB row preserves current behavior ──
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — cannot check the seeded exclusion row. Skipping.");
    process.exit(2);
  }
  const { query } = await import("../lib/db.js");
  const { rows } = await query<AutomationConfigRow>(
    `SELECT id, is_active, config FROM family_automations WHERE name = 'Bathroom Light Timer' LIMIT 1`,
  );
  const seededTerms = excludedTerms(rows[0] ?? null);
  record(
    'Bathroom Light Timer row carries the seeded "enzo" exclusion',
    seededTerms.includes("enzo"),
    `config.excluded_terms=${JSON.stringify(seededTerms)}`,
  );
  record(
    "seeded enzo bathroom is skipped by the bathroom timer",
    isBathroom(enzoBath) && isExcluded(enzoBath, seededTerms),
    `terms=${JSON.stringify(seededTerms)}`,
  );

  // ── authorization: the exclusion editor must be admin-only server-side ──
  const PORT = process.env.PORT || 5000;
  const BASE = `http://localhost:${PORT}`;
  try {
    const health = await fetch(`${BASE}/api/health`);
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch {
    console.error(`No HTTP server on localhost:${PORT} — cannot run authorization checks. Skipping.`);
    process.exit(2);
  }
  const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    console.error("JWT_SECRET/SESSION_SECRET not set — cannot mint test tokens. Skipping.");
    process.exit(2);
  }
  const { default: jwt } = await import("jsonwebtoken");
  const mint = (roles: string[]) =>
    jwt.sign(
      { userId: `exclusion-test-${roles[0]}`, email: `${roles[0]}@test.local`, displayName: `Test ${roles[0]}`, avatarUrl: null, roles, approvalStatus: "approved" },
      secret,
      { expiresIn: "10m" },
    );
  const adminH = { "content-type": "application/json", authorization: `Bearer ${mint(["admin"])}` };
  const memberH = { "content-type": "application/json", authorization: `Bearer ${mint(["member"])}` };
  const putExclusions = (headers: Record<string, string>, body: unknown) =>
    fetch(`${BASE}/api/energy/exclusions`, { method: "PUT", headers, body: JSON.stringify(body) });

  // Exercise against the Closet Light Timer row; save + restore its config.
  const TARGET = "Closet Light Timer";
  const { rows: targetRows } = await query<AutomationConfigRow>(
    `SELECT id, is_active, config FROM family_automations WHERE name = $1 LIMIT 1`, [TARGET],
  );
  if (targetRows.length === 0) {
    console.error(`"${TARGET}" row missing from family_automations — cannot run authorization checks. Skipping.`);
    process.exit(2);
  }
  const original = targetRows[0];
  try {
    // Plant a sentinel key so we can prove unrelated config keys survive.
    await query(
      `UPDATE family_automations SET config = COALESCE(config, '{}'::jsonb) || '{"test_sentinel": true}'::jsonb WHERE id = $1`,
      [original.id],
    );

    const anon = await putExclusions({ "content-type": "application/json" }, { automationName: TARGET, excludedTerms: ["x"] });
    record("unauthenticated PUT /api/energy/exclusions → 401", anon.status === 401, `status=${anon.status}`);

    const member = await putExclusions(memberH, { automationName: TARGET, excludedTerms: ["x"] });
    record("member PUT /api/energy/exclusions → 403", member.status === 403, `status=${member.status}`);

    const memberProxy = await fetch(`${BASE}/api/db/update`, {
      method: "POST", headers: memberH,
      body: JSON.stringify({ table: "family_automations", data: { config: { excluded_terms: ["x"] } }, filters: [{ column: "id", op: "eq", value: original.id }] }),
    });
    record("member config write via /api/db/update → 403", memberProxy.status === 403, `status=${memberProxy.status}`);

    const memberVacation = await fetch(`${BASE}/api/db/update`, {
      method: "POST", headers: memberH,
      body: JSON.stringify({ table: "family_automations", data: { is_active: original.is_active }, filters: [{ column: "id", op: "eq", value: original.id }] }),
    });
    record("member is_active (vacation) write via /api/db/update still allowed", memberVacation.ok, `status=${memberVacation.status}`);

    const adminPut = await putExclusions(adminH, { automationName: TARGET, excludedTerms: [" Enzo ", "GUEST BATH", "", "enzo"] });
    const adminBody = adminPut.ok ? await adminPut.json() : null;
    record(
      "admin PUT normalizes and saves the list",
      adminPut.status === 200 && JSON.stringify(adminBody?.excluded_terms) === JSON.stringify(["enzo", "guest bath"]),
      `status=${adminPut.status} terms=${JSON.stringify(adminBody?.excluded_terms)}`,
    );

    const { rows: afterRows } = await query<AutomationConfigRow>(
      `SELECT id, is_active, config FROM family_automations WHERE id = $1`, [original.id],
    );
    const afterCfg = (afterRows[0]?.config ?? {}) as Record<string, unknown>;
    record(
      "admin PUT only touches excluded_terms (sentinel key survives)",
      JSON.stringify(afterCfg.excluded_terms) === JSON.stringify(["enzo", "guest bath"]) && afterCfg.test_sentinel === true,
      `config=${JSON.stringify(afterCfg)}`,
    );

    const badName = await putExclusions(adminH, { automationName: "Fountains Off at 9 PM", excludedTerms: ["x"] });
    record("admin PUT with unsupported automationName → 400", badName.status === 400, `status=${badName.status}`);

    const badTerms = await putExclusions(adminH, { automationName: TARGET, excludedTerms: "enzo" });
    record("admin PUT with non-array excludedTerms → 400", badTerms.status === 400, `status=${badTerms.status}`);
  } finally {
    await query(
      `UPDATE family_automations SET config = $1::jsonb, is_active = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(original.config ?? {}), original.is_active, original.id],
    );
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.passed ? "PASS" : "FAIL"}  ${r.test}  (${r.detail})`);
    if (!r.passed) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test crashed:", err);
  process.exit(1);
});
