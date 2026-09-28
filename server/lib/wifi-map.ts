/**
 * Subnet → friendly SSID label helper.
 *
 * Background: the FortiGate is a flat L2 bridge — internal1-5 are merged
 * into a single hard-switch (`internal`) and there are no per-SSID VLAN
 * interfaces. That means the firewall cannot tell us which Wi-Fi a
 * client is on. The authoritative answer comes from the Ruckus
 * controller: `getClients()` in server/lib/ruckus.ts persists each
 * client's MAC → SSID into `network_devices.ssids`, and the WiFi
 * Networks endpoint reads from there.
 *
 * This module is now only a thin subnet-based fallback for the small
 * set of cases where Ruckus has no observation yet (cold start, wired
 * devices, or a client that has never associated since the last
 * controller reboot). Subnet matching cannot distinguish 34 from 34_AV,
 * so it only labels devices on the trusted 10.0.22.0/23 LAN as "34" and
 * everything else stays unlabeled.
 */

export const DEFAULT_SUBNET_MAP: ReadonlyArray<{ cidr: string; label: string }> = Object.freeze([
  { cidr: '10.0.22.0/23', label: '34' },
]);

// --- CIDR helpers ---------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]); const c = Number(m[3]); const d = Number(m[4]);
  if ([a, b, c, d].some(n => n < 0 || n > 255)) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

interface ParsedCidr { base: number; mask: number; bits: number }

function parseCidr(cidr: string): ParsedCidr | null {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const base = ipv4ToInt(ip || '');
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return { base: (base & mask) >>> 0, mask, bits };
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  const parsed = parseCidr(cidr);
  if (!parsed) return false;
  return ((ipInt & parsed.mask) >>> 0) === parsed.base;
}

/**
 * Subnet-based label fallback. Returns null when the IP doesn't match
 * any seeded CIDR — the caller should bucket those as "Unknown".
 */
export function resolveSubnetLabel(
  ip: string | null | undefined,
  subnetMap: ReadonlyArray<{ cidr: string; label: string }> = DEFAULT_SUBNET_MAP,
): string | null {
  if (!ip) return null;
  for (const { cidr, label } of subnetMap) {
    if (ipInCidr(ip, cidr)) return label;
  }
  return null;
}

/**
 * Resolve a friendly Wi-Fi label for a single device, in precedence
 * order: (1) fresh Ruckus observation by MAC, (2) subnet fallback,
 * (3) Unknown.
 *
 * `ruckusByMac` keys MUST already be normalized (lower-case + colon
 * separators) — call normalizeMac() before building the map. The helper
 * does NOT re-normalize because callers typically loop over many
 * devices and we don't want to pay that cost twice per row.
 */
export interface RuckusObservation {
  ssids: string[];
  expected_ssid: string | null;
  last_seen: string | null;
}

export type WifiSource = 'ruckus' | 'subnet' | null;

export function resolveWifiSource(
  normalizedMac: string | null,
  ip: string | null | undefined,
  ruckusByMac: ReadonlyMap<string, RuckusObservation>,
): { label: string | null; source: WifiSource; ruckus: RuckusObservation | null } {
  const ruckus = normalizedMac ? (ruckusByMac.get(normalizedMac) ?? null) : null;
  const ruckusSsid = ruckus && ruckus.ssids.length > 0 ? ruckus.ssids[0] : null;
  if (ruckusSsid) {
    return { label: ruckusSsid, source: 'ruckus', ruckus };
  }
  const subnetLabel = resolveSubnetLabel(ip);
  if (subnetLabel) {
    return { label: subnetLabel, source: 'subnet', ruckus };
  }
  return { label: null, source: null, ruckus };
}
