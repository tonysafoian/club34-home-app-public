/**
 * Test: Janus Skills framework (Skills Index + load_skill + boot sync).
 *
 * Run while the `Start application` workflow is up (only needs DATABASE_URL):
 *   npx tsx server/tests/janus-skills.test.ts
 *
 * Asserts (pure-function level against the dev DB the boot sync populated):
 *   - syncJanusSkills() is idempotent and reports the 3 repo skills.
 *   - getSkillsIndexBlock() is role/channel filtered: admin/member on any
 *     channel see all 3 skills; an outsider (role not in [admin,member]) sees
 *     an empty block; an unsupported channel hides the skill.
 *   - executeLoadSkill() returns the full body for a visible skill (slug is
 *     case-insensitive), gates a skill the role/channel can't see, and reports
 *     an unknown slug with the list of valid slugs.
 *
 * Read-only against janus_skills (sync is one-way file->DB and idempotent);
 * the only writes are append-only system_audit_log rows from successful loads.
 */
import {
  syncJanusSkills,
  getSkillsIndexBlock,
  executeLoadSkill,
  invalidateSkillsCache,
  type SkillChannel,
} from "../utils/janus-skills.js";

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];
function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

const EXPECTED = ["home-automation", "notion-tasks", "activity-awareness"];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set — cannot run test.");
    process.exit(2);
  }

  // --- sync: idempotent, reports the 3 repo skills ---
  const sync = await syncJanusSkills();
  record(
    "syncJanusSkills reports 3 repo skills",
    sync.total === 3,
    `total=${sync.total} synced=${sync.synced}`,
  );
  invalidateSkillsCache();

  // --- index: admin on chat sees all 3 ---
  const adminChat = await getSkillsIndexBlock("admin", "chat");
  record(
    "admin/chat index lists all 3 skills",
    EXPECTED.every((s) => adminChat.includes(s)) && adminChat.includes("JANUS SKILLS"),
    `len=${adminChat.length} hasAll=${EXPECTED.every((s) => adminChat.includes(s))}`,
  );

  // --- index: member on whatsapp also sees all 3 (default roles include member) ---
  const memberWa = await getSkillsIndexBlock("member", "whatsapp");
  record(
    "member/whatsapp index lists all 3 skills",
    EXPECTED.every((s) => memberWa.includes(s)),
    `len=${memberWa.length}`,
  );

  // --- index: outsider sees nothing (empty block, nothing added to prompt) ---
  const outsider = await getSkillsIndexBlock("outsider", "chat");
  record(
    "outsider index is empty (role-gated)",
    outsider === "",
    `len=${outsider.length}`,
  );

  // --- index: unsupported channel hides skills (none target 'sms') ---
  const sms = await getSkillsIndexBlock("admin", "sms" as unknown as SkillChannel);
  record(
    "unsupported channel index is empty (channel-gated)",
    sms === "",
    `len=${sms.length}`,
  );

  // --- load_skill: visible skill returns full body, slug case-insensitive ---
  const loaded = await executeLoadSkill("Home-Automation", "admin", "chat");
  record(
    "load_skill returns body for visible skill (case-insensitive slug)",
    loaded.startsWith("# Skill: Home Automation") && loaded.length > 200,
    `len=${loaded.length} head=${JSON.stringify(loaded.slice(0, 40))}`,
  );

  // --- load_skill: role-gated skill returns a gated message, not the body ---
  const gatedRole = await executeLoadSkill("home-automation", "outsider", "chat");
  record(
    "load_skill gates role that can't see the skill",
    !gatedRole.startsWith("# Skill:") && /isn't available/i.test(gatedRole),
    `msg=${JSON.stringify(gatedRole.slice(0, 80))}`,
  );

  // --- load_skill: channel-gated returns a gated message, not the body ---
  const gatedChannel = await executeLoadSkill("home-automation", "admin", "sms" as unknown as SkillChannel);
  record(
    "load_skill gates channel that can't see the skill",
    !gatedChannel.startsWith("# Skill:") && /isn't available/i.test(gatedChannel),
    `msg=${JSON.stringify(gatedChannel.slice(0, 80))}`,
  );

  // --- load_skill: unknown slug reports the valid set ---
  const unknown = await executeLoadSkill("does-not-exist", "admin", "chat");
  record(
    "load_skill rejects unknown slug and lists valid skills",
    /No skill named/i.test(unknown) && EXPECTED.every((s) => unknown.includes(s)),
    `msg=${JSON.stringify(unknown.slice(0, 100))}`,
  );

  let allPassed = true;
  for (const r of results) {
    if (!r.passed) allPassed = false;
    console.log(`[${r.passed ? "PASS" : "FAIL"}] ${r.test} — ${r.detail}`);
  }
  if (!allPassed) {
    console.error(`\n${results.filter((r) => !r.passed).length} test(s) FAILED.`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} tests passed.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
