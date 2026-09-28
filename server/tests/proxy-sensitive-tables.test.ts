/**
 * Focused test for the DB proxy sensitive-table access gate.
 *
 * Run while `Start application` workflow is up:
 *   npx tsx server/tests/proxy-sensitive-tables.test.ts
 *
 * Asserts:
 *   - member token → 403 on every sensitive table (google_tokens, platform_credentials,
 *     user_platform_credentials, system_prompts, janus_system_prompts, tesla_tokens)
 *   - member token → NOT 403 on a normal table (janus_notifications)
 *   - admin token → NOT 403 on a sensitive table (google_tokens)
 *   - disallowed table → 400 regardless of role
 */

import jwt from "jsonwebtoken";

const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET =
  process.env.JWT_SECRET || process.env.SESSION_SECRET || "club34-dev-secret-change-in-production";

const SENSITIVE_TABLES = [
  "google_tokens",
  "platform_credentials",
  "user_platform_credentials",
  "system_prompts",
  "janus_system_prompts",
  "tesla_tokens",
];

function makeToken(role: "admin" | "member"): string {
  return jwt.sign(
    {
      userId: `test-${role}`,
      email: `${role}@test.local`,
      displayName: `Test ${role}`,
      avatarUrl: null,
      roles: [role],
      approvalStatus: "approved",
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];

function record(test: string, passed: boolean, detail: string) {
  results.push({ test, passed, detail });
}

async function queryTable(token: string, table: string): Promise<number> {
  const r = await fetch(`${BASE}/api/db/query`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ table, select: "id", limit: 1 }),
  });
  return r.status;
}

async function main() {
  const memberToken = makeToken("member");
  const adminToken = makeToken("admin");

  for (const table of SENSITIVE_TABLES) {
    const status = await queryTable(memberToken, table);
    record(
      `member → sensitive table '${table}' → 403`,
      status === 403,
      `status=${status}`
    );
  }

  {
    const status = await queryTable(memberToken, "janus_notifications");
    record(
      "member → normal table 'janus_notifications' → not 403",
      status !== 403,
      `status=${status} (400/200 both acceptable — table may be empty or DB unavailable)`
    );
  }

  {
    const status = await queryTable(adminToken, "google_tokens");
    record(
      "admin → sensitive table 'google_tokens' → not 403",
      status !== 403,
      `status=${status}`
    );
  }

  {
    const status = await queryTable(memberToken, "nonexistent_table_xyz");
    record(
      "disallowed table → 400 regardless of role",
      status === 400,
      `status=${status}`
    );
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log("\n── DB Proxy Sensitive-Table Access Test ──\n");
  for (const r of results) {
    const icon = r.passed ? "✓" : "✗";
    console.log(`  ${icon} ${r.test}`);
    if (!r.passed) console.log(`      detail: ${r.detail}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
