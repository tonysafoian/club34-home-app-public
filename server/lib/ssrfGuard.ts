import { lookup } from 'node:dns/promises';
import { lookup as lookupCb } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from 'undici';

/**
 * SSRF guard for user-supplied outbound URLs (e.g. the Home Assistant URL a
 * user saves from Settings). The server makes requests to these URLs with a
 * bearer token attached, so they must never point at loopback, private,
 * link-local, CGNAT, or cloud-metadata destinations — otherwise any
 * authenticated user could turn the server into a proxy against internal
 * services (including this app itself on localhost) or the cloud metadata
 * endpoint (169.254.169.254).
 *
 * Note: for cloud deployments that cannot reach local LAN hosts directly,
 * blocking RFC1918 ranges protects internal infrastructure — HA instances
 * are reached via a secure public tunnel URL.
 */

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127 || a === 10) return true;            // unspecified, loopback, private
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 169 && b === 254) return true;                      // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a >= 224) return true;                                    // multicast/reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;           // unspecified, loopback
    if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
        lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local fe80::/10
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;   // unique-local fc00::/7
    if (lower.startsWith('::ffff:')) {
      const mapped = lower.slice('::ffff:'.length);
      if (net.isIPv4(mapped)) return isBlockedIp(mapped);         // v4-mapped
      return true;
    }
    return false;
  }
  // Not a recognizable IP — treat as blocked (caller should have resolved it).
  return true;
}

/**
 * Validates that a URL is http(s) and that its host resolves ONLY to public
 * addresses. Throws an Error with a user-safe message when the URL is not
 * acceptable. Resolves DNS at call time, so callers that re-check shortly
 * before connecting also get (coarse) protection against DNS rebinding.
 */
export async function assertPublicHttpUrl(raw: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('URL is not valid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL must not contain credentials');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('URL host is not allowed');
  }
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('URL host is not allowed');
    return;
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error('URL host could not be resolved');
  }
  if (addrs.length === 0) throw new Error('URL host could not be resolved');
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error('URL host is not allowed');
  }
}

/**
 * Connect-time DNS guard. Validating a URL up front is not enough: an
 * attacker-controlled DNS name can return a public IP during validation and a
 * private/metadata IP when the actual connection resolves it again (DNS
 * rebinding / TOCTOU). This lookup is used by the outbound connection itself,
 * so a blocked address can never be dialed regardless of what any earlier
 * validation saw. TLS hostname/SNI is unaffected — only address selection is
 * filtered.
 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
): void {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    callback(Object.assign(new Error(`Blocked host: ${hostname}`), { code: 'EBLOCKED' }), '', 4);
    return;
  }
  lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '', 4);
      return;
    }
    const list = (addresses as LookupAddress[]).filter(
      (a) => !isBlockedIp(a.address),
    );
    if (list.length === 0) {
      callback(
        Object.assign(new Error(`Blocked host: ${hostname} resolves only to disallowed addresses`), {
          code: 'EBLOCKED',
        }),
        '',
        4,
      );
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
}

const guardedAgent = new Agent({ connect: { lookup: guardedLookup } });

/**
 * fetch() variant whose connections are pinned through guardedLookup — blocked
 * destinations fail at the connection boundary even if DNS answers changed
 * since validation. Use this for ALL outbound requests to hosts that a user
 * can influence (e.g. Home Assistant URLs). A legitimately reachable host is
 * never affected: anything this server can reach must resolve publicly.
 */
export async function guardedFetch(url: string, init?: UndiciRequestInit): Promise<UndiciResponse> {
  // IP-literal hosts skip DNS entirely (net.connect performs no lookup for
  // them), so the dispatcher's guarded lookup never runs — block them here.
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    (net.isIP(hostname) !== 0 && isBlockedIp(hostname))
  ) {
    throw new Error(`Blocked host: ${hostname}`);
  }
  return undiciFetch(url, { ...init, dispatcher: guardedAgent });
}
