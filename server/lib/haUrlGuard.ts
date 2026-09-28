/**
 * SSRF guard for user-supplied Home Assistant URLs.
 *
 * Members can save an HA base URL from Settings and the server will fetch it
 * (test-connection, and every subsequent proxy call). Without restrictions
 * that is a classic SSRF hole: any authenticated member could point the
 * server at internal services (cloud metadata endpoints, localhost admin
 * ports, private LAN hosts) and read the responses through the app.
 *
 * Policy (fail closed):
 *  - Only http/https URLs, with no embedded credentials.
 *  - When an admin allowlist is configured (the host of the HA_URL env var
 *    plus any hosts in HA_ALLOWED_HOSTS, comma-separated), the hostname must
 *    be on it. When neither is configured (e.g. dev workspaces with no HA),
 *    any PUBLIC host is accepted — the IP/DNS checks below still apply.
 *  - IP-literal hostnames in private / loopback / link-local / metadata /
 *    otherwise reserved ranges are rejected even if allowlisted.
 *  - For DNS hostnames, every resolved address must be public. Resolution
 *    failure rejects (the URL would be unusable anyway).
 *
 * This is intentionally strict: when cloud deployed or tunneled, the app should
 * reach HA through a public tunnel URL — so there is no legitimate use for
 * private addresses unless self-hosting locally.
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export type HaUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Admin-controlled set of hostnames the HA integration may talk to. */
export function getAllowedHaHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set<string>();
  if (env.HA_URL) {
    try {
      hosts.add(new URL(env.HA_URL).hostname.toLowerCase());
    } catch {
      // Malformed HA_URL env — ignore; it can't be fetched either.
    }
  }
  for (const raw of (env.HA_ALLOWED_HOSTS ?? '').split(',')) {
    const h = raw.trim().toLowerCase();
    if (h) hosts.add(h);
  }
  return hosts;
}

/** True when an IP address (v4 or v6) is private, loopback, link-local, or otherwise reserved. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  // Not a parseable IP — treat as unsafe; callers only pass resolved addresses.
  return true;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||                          // 0.0.0.0/8 "this network"
    a === 10 ||                         // 10.0.0.0/8 private
    a === 127 ||                        // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) ||         // 169.254.0.0/16 link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) ||         // 192.168.0.0/16 private
    (a === 192 && b === 0) ||           // 192.0.0.0/24 IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224                            // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  );
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — judge by the embedded IPv4 address.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  // IPv4-mapped in hex form (::ffff:a00:1) — URL.hostname normalizes to this.
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (lower === '::' || lower === '::1') return true;        // unspecified / loopback
  if (lower.startsWith('fe80:') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique-local
  if (lower.startsWith('64:ff9b:')) return true;             // NAT64 well-known prefix
  return false;
}

/**
 * Synchronous structural check: scheme, credentials, allowlist, IP-literal
 * ranges. No DNS. Used both before saving and as a cheap defense-in-depth
 * check when loading a previously stored URL.
 */
export function checkHaUrlSync(rawUrl: string, env: NodeJS.ProcessEnv = process.env): HaUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'ha_url must be a valid http(s) URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'ha_url must use http or https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'ha_url must not contain embedded credentials' };
  }

  // URL.hostname wraps IPv6 literals in brackets — strip for isIP().
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return { ok: false, reason: 'ha_url must not point at a private, loopback, or reserved address' };
    }
  }

  // Allowlist is enforced only when one is configured. In production HA_URL
  // is always set, so the allowlist is never empty where it matters; an
  // unconfigured environment falls back to the public-host-only policy
  // (private/reserved IPs and private-resolving DNS names stay blocked).
  const allowed = getAllowedHaHosts(env);
  if (allowed.size > 0 && !allowed.has(hostname)) {
    return { ok: false, reason: 'ha_url host is not on the allowed Home Assistant host list' };
  }

  return { ok: true, url: rawUrl };
}

/**
 * Full validation for user-supplied HA URLs: everything in checkHaUrlSync,
 * plus DNS resolution — every address the hostname resolves to must be
 * public. Fails closed on resolution errors.
 */
export async function validateHaUrl(rawUrl: string, env: NodeJS.ProcessEnv = process.env): Promise<HaUrlCheck> {
  const sync = checkHaUrlSync(rawUrl, env);
  if (!sync.ok) return sync;

  const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return sync; // already range-checked above

  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: 'ha_url hostname could not be resolved' };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: 'ha_url hostname could not be resolved' };
  }
  for (const { address } of addrs) {
    if (isPrivateOrReservedIp(address)) {
      return { ok: false, reason: 'ha_url resolves to a private, loopback, or reserved address' };
    }
  }
  return sync;
}
