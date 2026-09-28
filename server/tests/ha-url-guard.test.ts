/**
 * SSRF regression tests for the Home Assistant URL guard.
 *
 * Run: npx tsx server/tests/ha-url-guard.test.ts
 *
 * The HA settings flow lets members submit a base URL that the SERVER then
 * fetches (test-connection + every proxy call). These tests lock down the
 * guard that keeps that from becoming an SSRF hole:
 *
 *  - Private / loopback / link-local / cloud-metadata IP literals are
 *    rejected, even when explicitly allowlisted.
 *  - Hosts not on the admin allowlist (HA_URL host + HA_ALLOWED_HOSTS) are
 *    rejected; an empty allowlist rejects everything.
 *  - DNS names that resolve to private addresses (e.g. localhost) are
 *    rejected even when allowlisted.
 *  - An allowlisted, publicly-resolving host validates OK.
 *  - callHA never follows redirects: a 302 from the upstream is returned
 *    as-is and the redirect target is never fetched.
 *  - DNS-rebinding defense: callHA's default dispatcher re-vets addresses at
 *    CONNECT time, so a hostname resolving to a private/loopback address is
 *    refused even if it slipped past earlier validation.
 *
 * Exit codes: 0 = pass, 1 = fail (per run-server-tests.ts conventions).
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent } from 'undici';
import { checkHaUrlSync, validateHaUrl, isPrivateOrReservedIp } from '../lib/haUrlGuard.js';
import { guardedLookup } from '../lib/ssrfGuard.js';
import { callHA } from '../routes/homeAssistant.js';

interface Result { test: string; passed: boolean; detail: string }
const results: Result[] = [];

function record(test: string, passed: boolean, detail = ''): void {
  results.push({ test, passed, detail });
}

async function main() {
  // Env injected explicitly so the tests are independent of the real HA_URL.
  const allowAll = { HA_ALLOWED_HOSTS: 'ha.example-tunnel.com,example.com,localhost,169.254.169.254,127.0.0.1,10.0.0.5,[::1]' } as NodeJS.ProcessEnv;
  const emptyEnv = {} as NodeJS.ProcessEnv;

  // --- IP-literal rejection (even when allowlisted) --------------------
  for (const url of [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://127.0.0.1:8080/admin',              // loopback
    'http://10.0.0.5:8123',                     // RFC1918
    'http://192.168.1.1',                       // RFC1918
    'http://172.16.0.1',                        // RFC1918
    'http://100.64.0.1',                        // CGNAT
    'http://0.0.0.0',                           // this-network
    'http://[::1]:8123',                        // IPv6 loopback
    'http://[fe80::1]',                         // IPv6 link-local
    'http://[fd00::1]',                         // IPv6 unique-local
    'http://[::ffff:10.0.0.1]',                 // IPv4-mapped private
  ]) {
    const r = checkHaUrlSync(url, allowAll);
    record(`reject private/reserved IP literal ${url}`, !r.ok, r.ok ? 'ACCEPTED (bad)' : r.reason);
  }

  // --- scheme / credential hygiene --------------------------------------
  record('reject ftp scheme', !checkHaUrlSync('ftp://example.com', allowAll).ok);
  record('reject file scheme', !checkHaUrlSync('file:///etc/passwd', allowAll).ok);
  record('reject embedded credentials', !checkHaUrlSync('https://user:pw@example.com', allowAll).ok);
  record('reject garbage URL', !checkHaUrlSync('not a url', allowAll).ok);

  // --- allowlist enforcement --------------------------------------------
  record('reject host missing from allowlist', !checkHaUrlSync('https://evil.attacker.io', allowAll).ok);
  // With no allowlist configured (dev), the guard falls back to a
  // public-host-only policy: public hosts pass, private targets still fail.
  record('accept public host when no allowlist configured', checkHaUrlSync('https://example.com', emptyEnv).ok);
  record('reject metadata IP even when no allowlist configured', !checkHaUrlSync('http://169.254.169.254/', emptyEnv).ok);
  record('reject loopback even when no allowlist configured', !checkHaUrlSync('http://127.0.0.1/', emptyEnv).ok);
  {
    const viaEnvUrl = checkHaUrlSync('https://my-ha.duckdns.org:8123/path', { HA_URL: 'https://my-ha.duckdns.org:8123' } as NodeJS.ProcessEnv);
    record('accept host derived from HA_URL env', viaEnvUrl.ok, viaEnvUrl.ok ? '' : viaEnvUrl.reason);
  }
  {
    const sync = checkHaUrlSync('https://ha.example-tunnel.com:8123', allowAll);
    record('accept allowlisted public hostname (sync)', sync.ok, sync.ok ? '' : sync.reason);
  }

  // --- DNS resolution check ----------------------------------------------
  {
    // localhost is allowlisted above, but resolves to 127.0.0.1/::1 → reject.
    const r = await validateHaUrl('http://localhost:8123', allowAll);
    record('reject allowlisted DNS name resolving to loopback (localhost)', !r.ok, r.ok ? 'ACCEPTED (bad)' : r.reason);
  }
  {
    // Publicly-resolving allowlisted host should pass end-to-end. Skip the
    // assertion (without failing) if this sandbox has no outbound DNS.
    const r = await validateHaUrl('https://example.com', allowAll);
    if (!r.ok && r.reason.includes('could not be resolved')) {
      record('accept allowlisted publicly-resolving host (example.com)', true, 'SKIPPED: no outbound DNS in this environment');
    } else {
      record('accept allowlisted publicly-resolving host (example.com)', r.ok, r.ok ? '' : r.reason);
    }
  }
  {
    const r = await validateHaUrl('https://definitely-not-a-real-host.invalid', {
      HA_ALLOWED_HOSTS: 'definitely-not-a-real-host.invalid',
    } as NodeJS.ProcessEnv);
    record('reject unresolvable hostname', !r.ok, r.ok ? 'ACCEPTED (bad)' : r.reason);
  }

  // --- isPrivateOrReservedIp sanity ---------------------------------------
  record('8.8.8.8 is public', !isPrivateOrReservedIp('8.8.8.8'));
  record('169.254.169.254 is reserved', isPrivateOrReservedIp('169.254.169.254'));
  record('::1 is reserved', isPrivateOrReservedIp('::1'));
  record('::ffff:a00:1 (hex-mapped 10.0.0.1) is reserved', isPrivateOrReservedIp('::ffff:a00:1'));
  record('2606:4700::1111 is public', !isPrivateOrReservedIp('2606:4700::1111'));

  // --- callHA redirect + connect-time (DNS rebinding) defenses -------------
  {
    let fixtureHits = 0;
    let redirectTargetHit = false;
    const server = createServer((req, res) => {
      fixtureHits++;
      if (req.url === '/secret') {
        redirectTargetHit = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"leaked":true}');
        return;
      }
      res.writeHead(302, { Location: '/secret' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    // Permissive dispatcher so the test can reach its own loopback fixture —
    // production callHA never sets this and goes through guardedFetch.
    const permissive = new Agent();
    try {
      const { status } = await callHA(`http://127.0.0.1:${port}`, 'test-token', 'GET', '/api/', undefined,
        { maxRetries: 1, dispatcher: permissive });
      record('callHA returns 3xx without following redirect', status === 302 && !redirectTargetHit,
        `status=${status}, redirectTargetHit=${redirectTargetHit}`);

      // Rebinding regression: with the DEFAULT dispatcher, a hostname that
      // resolves to loopback must be refused at connect time — even though
      // the fixture server is really there — and the server never hit.
      const hitsBefore = fixtureHits;
      let blocked = false;
      let blockedDetail = '';
      try {
        const r = await callHA(`http://localhost:${port}`, 'test-token', 'GET', '/api/', undefined, { maxRetries: 1 });
        blockedDetail = `unexpectedly got status ${r.status}`;
      } catch (err) {
        blocked = true;
        blockedDetail = err instanceof Error ? err.message : String(err);
      }
      record('callHA default dispatcher refuses privately-resolving hostname at connect time',
        blocked && fixtureHits === hitsBefore,
        `blocked=${blocked}, fixtureHitsDelta=${fixtureHits - hitsBefore}, ${blockedDetail}`);
    } finally {
      await permissive.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  // --- guardedLookup unit checks --------------------------------------------
  {
    const lookupBlocked = await new Promise<boolean>((resolve) => {
      guardedLookup('localhost', {}, (err) => resolve(Boolean(err && (err as NodeJS.ErrnoException).code === 'EBLOCKED')));
    });
    record('guardedLookup blocks localhost with EBLOCKED', lookupBlocked);

    const lookupPublic = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
      guardedLookup('example.com', {}, (err, address) => {
        if (err) {
          // No outbound DNS in this environment — skip rather than fail.
          resolve({ ok: true, detail: `SKIPPED: ${err.message}` });
          return;
        }
        resolve({ ok: typeof address === 'string' && address.length > 0, detail: `address=${String(address)}` });
      });
    });
    record('guardedLookup returns a public address for example.com', lookupPublic.ok, lookupPublic.detail);
  }

  // --- report -------------------------------------------------------------
  let failed = 0;
  for (const r of results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    if (!r.passed) failed++;
    console.log(`[${mark}] ${r.test}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('ha-url-guard.test.ts crashed:', err);
  process.exit(1);
});
