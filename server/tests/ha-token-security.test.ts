/**
 * Security tests for the Home Assistant settings/token flow (Settings → save,
 * test-connection, proxy credential resolution).
 *
 * Run while `Start application` workflow is up:
 *   npx tsx server/tests/ha-token-security.test.ts
 *
 * Asserts:
 *   - SSRF guard blocks loopback / private / link-local / metadata / CGNAT
 *     destinations and non-http(s) schemes (unit level, assertPublicHttpUrl)
 *   - save-settings rejects internal URLs over HTTP (localhost, 169.254.169.254)
 *   - save-settings accepts a public URL, stores the token ENCRYPTED, and never
 *     echoes the raw token back
 *   - test-connection with a caller-supplied URL and NO explicit token is
 *     rejected — the stored token must never be sent to a different host
 *   - test-connection with an internal URL is rejected even with an explicit token
 *   - home_assistant_settings is NOT reachable through the generic DB proxy
 *     (read or write), so no user can read ciphertext or repoint another
 *     user's ha_url to exfiltrate their token
 *   - get-settings only returns the caller's own row (never another user's,
 *     never encrypted_token); disconnect clears only the caller's token
 *
 * Exit codes: 0 pass, 2 cannot run (server down), 1 failure.
 */

import jwt from 'jsonwebtoken';
import { pool } from '../db';
import { assertPublicHttpUrl, isBlockedIp, guardedLookup, guardedFetch } from '../lib/ssrfGuard';

const PORT = process.env.PORT || 5000;
const BASE = `http://localhost:${PORT}`;
const JWT_SECRET =
  process.env.JWT_SECRET || process.env.SESSION_SECRET || 'janus-dev-secret-change-in-production';

const TEST_USER_ID = 'test-ha-token-security';
const RAW_TOKEN = 'raw-ha-token-should-never-leak';

const token = jwt.sign(
  {
    userId: TEST_USER_ID,
    email: 'ha-security@test.local',
    displayName: 'HA Security Test',
    avatarUrl: null,
    roles: ['admin'],
    approvalStatus: 'approved',
  },
  JWT_SECRET,
  { expiresIn: '10m' },
);

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${name}${ok ? '' : ' — ' + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

async function post(body: unknown): Promise<{ status: number; text: string; data: unknown }> {
  const res = await fetch(`${BASE}/api/home-assistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, text, data };
}

async function main() {
  // Prerequisite: server must be up.
  try {
    const health = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (e) {
    console.log(`SKIP: server not reachable at ${BASE} (${e instanceof Error ? e.message : e})`);
    await pool.end().catch(() => {});
    process.exit(2);
  }

  // --- Unit level: SSRF guard ---
  const blockedIps = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'];
  for (const ip of blockedIps) {
    check(`isBlockedIp blocks ${ip}`, isBlockedIp(ip));
  }
  check('isBlockedIp allows public 8.8.8.8', !isBlockedIp('8.8.8.8'));
  check('isBlockedIp allows public 2001:4860:4860::8888', !isBlockedIp('2001:4860:4860::8888'));

  const blockedUrls = ['http://localhost:8123', 'http://127.0.0.1:5000', 'http://10.0.0.5:8123',
    'http://192.168.1.2', 'http://169.254.169.254/latest/meta-data', 'http://[::1]:8123',
    'ftp://example.com', 'http://user:pass@example.com', 'not-a-url'];
  for (const u of blockedUrls) {
    let threw = false;
    try { await assertPublicHttpUrl(u); } catch { threw = true; }
    check(`assertPublicHttpUrl rejects ${u}`, threw);
  }
  let publicOk = true;
  try { await assertPublicHttpUrl('https://example.com'); } catch (e) {
    publicOk = false;
    console.log(`  note: public-host DNS check failed (${e instanceof Error ? e.message : e})`);
  }
  check('assertPublicHttpUrl allows https://example.com', publicOk);

  // --- Connect-time enforcement (DNS rebinding / TOCTOU regression) ---
  // Even if URL validation was bypassed or DNS answers changed after
  // validation, the connection itself must refuse blocked addresses.

  // guardedLookup rejects a name that resolves to a loopback address.
  const lookupBlocked = await new Promise<boolean>((resolve) => {
    guardedLookup('localhost', { all: false }, (err) => resolve(!!err));
  });
  check('guardedLookup blocks names resolving to loopback', lookupBlocked);

  // The dev server IS listening on localhost:PORT (health check above proved
  // it), yet guardedFetch must fail at the connection boundary — no
  // pre-validation is done here, simulating validation/connection divergence.
  let connectBlocked = false;
  let connectErr = '';
  try {
    await guardedFetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
  } catch (e) {
    connectBlocked = true;
    connectErr = e instanceof Error ? `${e.message} ${(e.cause as Error | undefined)?.message ?? ''}` : String(e);
  }
  check('guardedFetch refuses connection to reachable-but-blocked destination (TOCTOU closed)',
    connectBlocked, connectErr);

  let metadataBlocked = false;
  try {
    await guardedFetch('http://169.254.169.254/latest/meta-data', { signal: AbortSignal.timeout(5000) });
  } catch {
    metadataBlocked = true;
  }
  check('guardedFetch refuses cloud metadata IP at connect time', metadataBlocked);

  // True rebinding simulation: a PUBLIC DNS name that resolves to 127.0.0.1
  // (nip.io wildcard DNS). Validation of such a hostname would depend on what
  // DNS returned at validation time; the connect-time lookup must refuse it
  // regardless. Tolerate resolver failure (no external DNS) as a soft skip.
  const rebind = await new Promise<{ code?: string; err: boolean }>((resolve) => {
    guardedLookup('127.0.0.1.nip.io', { all: false }, (err) =>
      resolve({ err: !!err, code: (err as NodeJS.ErrnoException | null)?.code }),
    );
  });
  if (rebind.code && rebind.code !== 'EBLOCKED') {
    console.log(`  note: rebinding DNS test skipped (resolver error ${rebind.code})`);
  } else {
    check('guardedLookup blocks public DNS name resolving to loopback (rebinding)', rebind.err && rebind.code === 'EBLOCKED');
  }

  // --- HTTP level ---
  await pool.query('DELETE FROM home_assistant_settings WHERE user_id = $1', [TEST_USER_ID]);

  let r = await post({ action: 'save-settings', ha_url: 'http://127.0.0.1:5000', access_token: RAW_TOKEN });
  check('save-settings rejects loopback URL', r.status === 400, r.data);

  r = await post({ action: 'save-settings', ha_url: 'http://169.254.169.254', access_token: RAW_TOKEN });
  check('save-settings rejects metadata IP', r.status === 400, r.data);

  r = await post({ action: 'save-settings', ha_url: 'http://192.168.1.20:8123', access_token: RAW_TOKEN });
  check('save-settings rejects private-range URL', r.status === 400, r.data);

  // The guard also enforces the admin host allowlist (HA_URL /
  // HA_ALLOWED_HOSTS) when configured, so use an allowlisted public host
  // when there is one; with no allowlist any public host is accepted.
  let publicHaUrl = 'https://example.com';
  try {
    if (process.env.HA_URL) publicHaUrl = `https://${new URL(process.env.HA_URL).hostname}`;
  } catch { /* malformed HA_URL env — fall back to example.com */ }

  r = await post({ action: 'save-settings', ha_url: publicHaUrl, access_token: RAW_TOKEN });
  check('save-settings accepts public URL', r.status === 200, r.data);
  check('save-settings response never contains raw token', !r.text.includes(RAW_TOKEN), r.text.slice(0, 200));

  const { rows } = await pool.query(
    'SELECT encrypted_token FROM home_assistant_settings WHERE user_id = $1', [TEST_USER_ID],
  );
  check('token stored encrypted, not raw',
    rows.length === 1 && !!rows[0].encrypted_token && rows[0].encrypted_token !== RAW_TOKEN, rows);

  // Stored token must never be attached to a caller-supplied URL.
  r = await post({ action: 'test-connection', ha_url: 'https://attacker.example.net' });
  check('test-connection refuses caller URL without explicit token (no stored-token exfiltration)',
    r.status === 400, r.data);
  check('refusal response never contains raw token', !r.text.includes(RAW_TOKEN), r.text.slice(0, 200));

  // Even with an explicit token, internal destinations are refused.
  r = await post({ action: 'test-connection', ha_url: 'http://127.0.0.1:5000', access_token: 'whatever' });
  check('test-connection rejects loopback URL even with explicit token', r.status === 400, r.data);

  // --- Authorization: generic DB proxy must not expose the table ---
  for (const role of ['member', 'admin'] as const) {
    const roleToken = jwt.sign(
      {
        userId: `test-ha-dbproxy-${role}`, email: `ha-dbproxy-${role}@test.local`,
        displayName: `HA DBProxy ${role}`, avatarUrl: null, roles: [role], approvalStatus: 'approved',
      },
      JWT_SECRET, { expiresIn: '10m' },
    );
    const q = await fetch(`${BASE}/api/db/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${roleToken}` },
      body: JSON.stringify({ table: 'home_assistant_settings', select: '*', limit: 5 }),
    });
    check(`db proxy read of home_assistant_settings blocked for ${role} (got ${q.status})`, q.status === 400);
    const qBody = await q.text();
    check(`db proxy read refusal never contains token (${role})`, !qBody.includes(RAW_TOKEN));

    const u = await fetch(`${BASE}/api/db/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${roleToken}` },
      body: JSON.stringify({
        table: 'home_assistant_settings',
        data: { ha_url: 'https://attacker.example.net' },
        filters: [{ column: 'user_id', op: 'eq', value: TEST_USER_ID }],
      }),
    });
    check(`db proxy write to home_assistant_settings blocked for ${role} (got ${u.status})`, u.status === 400);
  }
  const { rows: afterAttack } = await pool.query(
    'SELECT ha_url FROM home_assistant_settings WHERE user_id = $1', [TEST_USER_ID],
  );
  check('victim ha_url unchanged after blocked cross-user update attempt',
    afterAttack.length === 1 && afterAttack[0].ha_url !== 'https://attacker.example.net', afterAttack);

  // --- Ownership: get-settings only returns the caller's own row ---
  const otherToken = jwt.sign(
    {
      userId: 'test-ha-other-user', email: 'ha-other@test.local',
      displayName: 'HA Other User', avatarUrl: null, roles: ['admin'], approvalStatus: 'approved',
    },
    JWT_SECRET, { expiresIn: '10m' },
  );
  const otherGet = await fetch(`${BASE}/api/home-assistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherToken}` },
    body: JSON.stringify({ action: 'get-settings' }),
  });
  const otherGetBody = (await otherGet.json()) as { settings: { ha_url?: string } | null };
  check('get-settings for another user does NOT return the victim row',
    otherGet.status === 200 && otherGetBody.settings === null, otherGetBody);

  r = await post({ action: 'get-settings' });
  const own = (r.data as { settings: Record<string, unknown> | null }).settings;
  check('get-settings returns own row with has_token, without encrypted_token',
    r.status === 200 && !!own && own.has_token === true && !('encrypted_token' in (own ?? {}))
      && !r.text.includes(RAW_TOKEN), r.data);

  // --- disconnect clears only the caller's token ---
  r = await post({ action: 'disconnect' });
  check('disconnect succeeds', r.status === 200, r.data);
  const { rows: afterDisc } = await pool.query(
    'SELECT encrypted_token, is_connected FROM home_assistant_settings WHERE user_id = $1', [TEST_USER_ID],
  );
  check('disconnect cleared stored token',
    afterDisc.length === 1 && afterDisc[0].encrypted_token === null && afterDisc[0].is_connected === false,
    afterDisc);

  await pool.query('DELETE FROM home_assistant_settings WHERE user_id = $1', [TEST_USER_ID]);
  await pool.end();

  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});
