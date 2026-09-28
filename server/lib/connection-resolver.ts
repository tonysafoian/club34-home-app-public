/**
 * 4-tier connection-method resolver.
 *
 * Resolves each FortiGate device's physical connection method (Wired /
 * WiFi / Unknown) using the following precedence:
 *
 *   Tier 1 — Live Ruckus (confirmed)
 *     Feed healthy (observations in the last 6 min) + MAC in live set
 *     → WiFi + exact SSID.
 *     Feed healthy + MAC absent from live set
 *     → Wired (wired-by-absence).
 *
 *   Tier 2 — Recent Ruckus history (recent)
 *     Feed not healthy/fresh, but MAC has a Ruckus observation in the
 *     last 4 hours → WiFi + last-known SSID.
 *
 *   Tier 3 — Device-type heuristics (inferred)
 *     No Ruckus data. Classify from device category / subcategory /
 *     hostname / vendor using the same keyword rules as the wifi-classifier.
 *
 *   Tier 4 — Subnet / Unknown (unknown)
 *     Last resort.
 */

import { expectedSsidFor, type DeviceLike } from './wifi-classifier.js';

export interface ConnectionMethod {
  method: 'wired' | 'wifi' | 'unknown';
  ssid: string | null;
  source: 'ruckus_live' | 'ruckus_recent' | 'heuristic' | 'subnet' | 'unknown';
  confidence: 'confirmed' | 'recent' | 'inferred' | 'unknown';
  ssid_certain: boolean;
}

export interface LiveRuckusEntry {
  ssids: string[];
}

export interface RecentRuckusEntry {
  ssids: string[];
  last_seen: string | null;
}

export interface ConnectionResolverContext {
  liveRuckusByMac: ReadonlyMap<string, LiveRuckusEntry>;
  recentRuckusByMac: ReadonlyMap<string, RecentRuckusEntry>;
  ruckusFeedHealthy: boolean;
}

const WIRED_CATEGORIES = new Set([
  'Network Infrastructure',
  'Printers',
  'Virtual Machines',
]);

const WIRED_KEYWORDS = [
  'nas', 'desktop', 'esxi', 'proxmox', 'truenas', 'synology', 'qnap',
  'printer', 'switch', 'router', 'gateway', 'access-point', 'unifi',
  'fortigate', 'ruckus', 'pfsense',
];

const WIFI_AV_CATEGORIES = new Set([
  'Smart TVs & Streaming',
  'Smart Speakers',
  'Security Cameras',
  'Lighting & Switches',
  'Thermostats',
  'Electricity Monitoring',
]);

const MOBILE_CATEGORIES = new Set([
  'Mobile Phones & Tablets',
]);

const PERSONAL_CATEGORIES = new Set([
  'Computers & Laptops',
]);

function deviceBag(d: DeviceLike): string {
  return ` ${[d.hostname, d.device_type, d.os_type, d.hardware_vendor, d.category, d.subcategory]
    .filter(Boolean).join(' ').toLowerCase()} `;
}

function inferFromHeuristic(device: DeviceLike): ConnectionMethod {
  const hay = deviceBag(device);
  const cat = (device.category ?? '').trim();

  for (const kw of WIRED_KEYWORDS) {
    if (hay.includes(kw)) {
      return { method: 'wired', ssid: null, source: 'heuristic', confidence: 'inferred', ssid_certain: false };
    }
  }
  if (WIRED_CATEGORIES.has(cat)) {
    return { method: 'wired', ssid: null, source: 'heuristic', confidence: 'inferred', ssid_certain: false };
  }
  if (cat === 'Cars') {
    return { method: 'wifi', ssid: '34', source: 'heuristic', confidence: 'inferred', ssid_certain: false };
  }
  if (WIFI_AV_CATEGORIES.has(cat)) {
    const { expected } = expectedSsidFor(device);
    const guessedSsid = expected ?? '34_AV';
    return { method: 'wifi', ssid: guessedSsid, source: 'heuristic', confidence: 'inferred', ssid_certain: false };
  }
  if (MOBILE_CATEGORIES.has(cat)) {
    return { method: 'wifi', ssid: '34', source: 'heuristic', confidence: 'inferred', ssid_certain: false };
  }
  if (PERSONAL_CATEGORIES.has(cat)) {
    return { method: 'wifi', ssid: '34', source: 'heuristic', confidence: 'inferred', ssid_certain: false };
  }

  const { expected } = expectedSsidFor(device);
  if (expected !== null) {
    return { method: 'wifi', ssid: expected, source: 'heuristic', confidence: 'inferred', ssid_certain: false };
  }

  return { method: 'unknown', ssid: null, source: 'unknown', confidence: 'unknown', ssid_certain: false };
}

/**
 * Resolve the connection method for a single device.
 *
 * @param normalizedMac - Lower-case colon-separated MAC (already normalized).
 *   Pass null when the device has no MAC — it will fall to Tier 3/4.
 * @param device - Enough info to run the device-type heuristic (Tier 3).
 * @param subnetLabel - Pre-computed subnet label (e.g. "34") from
 *   resolveSubnetLabel(); null means no subnet match.
 * @param ctx - The Ruckus observation maps + feed-health flag.
 */
export function resolveConnectionMethod(
  normalizedMac: string | null,
  device: DeviceLike,
  subnetLabel: string | null,
  ctx: ConnectionResolverContext,
): ConnectionMethod {
  const { liveRuckusByMac, recentRuckusByMac, ruckusFeedHealthy } = ctx;

  if (normalizedMac) {
    const liveEntry = liveRuckusByMac.get(normalizedMac);
    if (liveEntry) {
      const ssid = liveEntry.ssids[0] ?? null;
      return { method: 'wifi', ssid, source: 'ruckus_live', confidence: 'confirmed', ssid_certain: true };
    }
    if (ruckusFeedHealthy) {
      return { method: 'wired', ssid: null, source: 'ruckus_live', confidence: 'confirmed', ssid_certain: false };
    }

    const recentEntry = recentRuckusByMac.get(normalizedMac);
    if (recentEntry) {
      const ssid = recentEntry.ssids[0] ?? null;
      return { method: 'wifi', ssid, source: 'ruckus_recent', confidence: 'recent', ssid_certain: !!ssid };
    }
  }

  const heuristic = inferFromHeuristic(device);
  if (heuristic.method !== 'unknown') return heuristic;

  if (subnetLabel) {
    return { method: 'wifi', ssid: subnetLabel, source: 'subnet', confidence: 'unknown', ssid_certain: false };
  }

  return { method: 'unknown', ssid: null, source: 'unknown', confidence: 'unknown', ssid_certain: false };
}

/**
 * Build both Ruckus observation maps from a flat DB result set.
 * Rows must include: mac_address, ssids (jsonb), last_seen.
 *
 * @param rows - Rows from network_devices with SSID history.
 * @param ruckusFeedHealthyOverride - When provided, this value is used as
 *   the feed-health signal instead of counting live MACs.  Callers should
 *   derive this from the `wireless_snapshots` table (MAX(captured_at) within
 *   LIVE_WINDOW_MS) so that FortiGate DHCP updates to `network_devices.last_seen`
 *   cannot masquerade as a live Ruckus observation.
 *
 * Returns { liveRuckusByMac, recentRuckusByMac, ruckusFeedHealthy }.
 *
 * "Live" = observed within LIVE_WINDOW_MS (6 min, covering one missed
 * 5-min cron tick).  "Recent" = within RECENT_WINDOW_MS (4 h).
 * ruckusFeedHealthy controls wired-by-absence: true means that a device
 * NOT in the live set is almost certainly wired.
 */
export const LIVE_WINDOW_MS = 6 * 60 * 1000;
export const RECENT_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface RuckusDbRow {
  mac_address: string;
  ssids: string[] | null;
  last_seen: Date | string | null;
}

export function buildRuckusMaps(rows: RuckusDbRow[], ruckusFeedHealthyOverride?: boolean): {
  liveRuckusByMac: Map<string, LiveRuckusEntry>;
  recentRuckusByMac: Map<string, RecentRuckusEntry>;
  ruckusFeedHealthy: boolean;
} {
  const now = Date.now();
  const liveRuckusByMac = new Map<string, LiveRuckusEntry>();
  const recentRuckusByMac = new Map<string, RecentRuckusEntry>();

  for (const r of rows) {
    if (!r.mac_address) continue;
    const mac = r.mac_address.toLowerCase().replace(/-/g, ':').trim();
    const ssids = Array.isArray(r.ssids) ? (r.ssids as string[]) : [];
    if (ssids.length === 0) continue;

    const lastSeenMs = r.last_seen instanceof Date
      ? r.last_seen.getTime()
      : r.last_seen != null
        ? new Date(String(r.last_seen)).getTime()
        : 0;

    const ageMs = now - lastSeenMs;
    const entry = { ssids, last_seen: r.last_seen instanceof Date ? r.last_seen.toISOString() : (r.last_seen != null ? String(r.last_seen) : null) };

    if (ageMs <= LIVE_WINDOW_MS) {
      liveRuckusByMac.set(mac, { ssids });
    }
    if (ageMs <= RECENT_WINDOW_MS) {
      recentRuckusByMac.set(mac, entry);
    }
  }

  // Prefer the caller-supplied override (derived from wireless_snapshots so
  // that FortiGate DHCP bumps to last_seen don't fake a live Ruckus feed).
  // Fall back to "any live MAC in the map" only when no override is given
  // (e.g. unit tests, legacy callers).
  const ruckusFeedHealthy = ruckusFeedHealthyOverride !== undefined
    ? ruckusFeedHealthyOverride
    : liveRuckusByMac.size > 0;

  return { liveRuckusByMac, recentRuckusByMac, ruckusFeedHealthy };
}
