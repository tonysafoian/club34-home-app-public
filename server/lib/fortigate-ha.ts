/**
 * FortiGate-from-Home-Assistant readers.
 *
 * The Network Command Center historically read FortiGate state by calling the
 * FortiGate REST API directly through a Cloudflare tunnel + bearer token. That
 * path is fragile (token rotation, tunnel reachability, FortiGate session
 * limits) and is the reason the panels frequently showed "no data".
 *
 * Meanwhile Home Assistant already polls FortiGate and exposes 9 reliable,
 * throttled sensors. This module reads those sensor states from the live HA
 * entity cache (populated by the HA WebSocket connection) so the dashboard can
 * use HA as the PRIMARY source of truth, with the direct tunnel kept only as a
 * fallback for fields HA doesn't expose.
 *
 * All readers return `null` when the sensor is missing/unavailable so callers
 * can cleanly fall back to the direct FortiGate path.
 */
import { getEntityCache, isCacheReady } from './haWebSocket.js';

interface HAEntityLike {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

const UNAVAILABLE = new Set(['unavailable', 'unknown', 'none', '', 'nan']);

function stateOf(entityId: string): { state: string; attributes: Record<string, unknown> } | null {
  if (!isCacheReady()) return null;
  const cache = getEntityCache() as unknown as HAEntityLike[];
  const e = cache.find((x) => x.entity_id === entityId);
  if (!e) return null;
  if (e.state == null || UNAVAILABLE.has(String(e.state).trim().toLowerCase())) return null;
  return { state: e.state, attributes: e.attributes ?? {} };
}

function numOf(entityId: string): number | null {
  const s = stateOf(entityId);
  if (!s) return null;
  const n = parseFloat(s.state);
  return Number.isFinite(n) ? n : null;
}

/** True if HA has at least the core FortiGate sensors populated. */
export function haFortigateAvailable(): boolean {
  return stateOf('sensor.fortigate_wan_status') !== null || numOf('sensor.fortigate_cpu_usage') !== null;
}

/** True if the entity exists in the HA cache, regardless of its state value. */
function entityExists(entityId: string): boolean {
  if (!isCacheReady()) return false;
  const cache = getEntityCache() as unknown as HAEntityLike[];
  return cache.some((x) => x.entity_id === entityId);
}

/**
 * Reports whether the HA FortiView sensors that back the Traffic (top talkers)
 * and Top Sites panels are configured in Home Assistant. Unlike the readers
 * above, this checks the entity's *presence* in the HA cache (it may exist but
 * be temporarily unavailable, or have no data yet) so the UI can distinguish
 * "sensor never set up" from "sensor configured but waiting for data".
 *
 * `has_data` reflects whether the sensor currently exposes a non-empty
 * consumers/sites attribute — i.e. the panels would actually render rows.
 */
export function haFortiViewSensorsPresent(): {
  cache_ready: boolean;
  top_talkers: { present: boolean; has_data: boolean };
  top_sites: { present: boolean; has_data: boolean };
  all_present: boolean;
} {
  const cacheReady = isCacheReady();
  const talkersPresent = entityExists('sensor.fortigate_top_talkers');
  const sitesPresent = entityExists('sensor.fortigate_top_sites');
  return {
    cache_ready: cacheReady,
    top_talkers: { present: talkersPresent, has_data: haTopTalkers() !== null },
    top_sites: { present: sitesPresent, has_data: haTopSites() !== null },
    all_present: talkersPresent && sitesPresent,
  };
}

/** system-health equivalent: { cpu_usage, memory_usage, active_sessions } from HA. */
export function haSystemHealth(): { cpu_usage: number | null; memory_usage: number | null; active_sessions: number | null } | null {
  const cpu = numOf('sensor.fortigate_cpu_usage');
  const mem = numOf('sensor.fortigate_memory_usage');
  if (cpu === null && mem === null) return null;
  return {
    cpu_usage: cpu,
    memory_usage: mem,
    // HA does not currently expose an active-session count sensor.
    active_sessions: numOf('sensor.fortigate_active_sessions'),
  };
}

/** wan-stats equivalent from HA sensors. WAN RX/TX sensors are reported in GB. */
export function haWanStats(): {
  rx_bytes: number | null;
  tx_bytes: number | null;
  rx_gb: number | null;
  tx_gb: number | null;
  link: boolean | null;
  wan_status: string;
  wan_speed: number | null;
} | null {
  const status = stateOf('sensor.fortigate_wan_status');
  const rxGb = numOf('sensor.fortigate_wan_rx');
  const txGb = numOf('sensor.fortigate_wan_tx');
  const speed = numOf('sensor.fortigate_wan_speed');
  if (!status && rxGb === null && txGb === null) return null;

  const link = status ? /up|online|connected/i.test(status.state) : null;
  const gbToBytes = (gb: number | null): number | null =>
    gb !== null ? Math.round(gb * 1073741824) : null;

  return {
    rx_bytes: gbToBytes(rxGb),
    tx_bytes: gbToBytes(txGb),
    rx_gb: rxGb,
    tx_gb: txGb,
    link,
    wan_status: status ? status.state.toLowerCase() : 'unknown',
    wan_speed: speed,
  };
}

/** IPS anomaly count from HA (drives the Threats badge). */
export function haIpsAnomalyCount(): number | null {
  return numOf('sensor.fortigate_ips_anomaly_count');
}

/** Web-filter block count from HA (often unavailable on the FortiGate side). */
export function haWebFilterBlocks(): number | null {
  return numOf('sensor.fortigate_web_filter_blocks');
}

/**
 * Top bandwidth consumers from HA sensor.fortigate_top_talkers.
 * The sensor's `consumers` attribute should be an array of
 * { ip, bytes, tx_bytes, rx_bytes } objects populated via a
 * rest_command.fortigate_proxy call (see docs/fortigate-ha-traffic.yaml).
 * Returns null when the sensor is absent/unavailable.
 */
export function haTopTalkers(): { ip: string; bytes: number; tx_bytes: number; rx_bytes: number }[] | null {
  const s = stateOf('sensor.fortigate_top_talkers');
  if (!s) return null;
  const consumers = s.attributes['consumers'];
  if (!Array.isArray(consumers) || consumers.length === 0) return null;
  const result: { ip: string; bytes: number; tx_bytes: number; rx_bytes: number }[] = [];
  for (const c of consumers) {
    if (c !== null && typeof c === 'object') {
      const entry = c as Record<string, unknown>;
      const ip = typeof entry['ip'] === 'string' ? entry['ip']
        : (typeof entry['srcip'] === 'string' ? entry['srcip']
          : (typeof entry['src'] === 'string' ? entry['src'] : null));
      if (!ip) continue;
      const bytes = typeof entry['bytes'] === 'number' ? entry['bytes'] : (parseFloat(String(entry['bytes'] ?? '0')) || 0);
      const txBytes = typeof entry['tx_bytes'] === 'number' ? entry['tx_bytes'] : (parseFloat(String(entry['tx_bytes'] ?? '0')) || 0);
      const rxBytes = typeof entry['rx_bytes'] === 'number' ? entry['rx_bytes'] : (parseFloat(String(entry['rx_bytes'] ?? '0')) || 0);
      result.push({ ip, bytes, tx_bytes: txBytes, rx_bytes: rxBytes });
    }
  }
  return result.length > 0 ? result : null;
}

/**
 * Top destination sites from HA sensor.fortigate_top_sites.
 * The sensor's `sites` attribute should be an array of
 * { domain, category, hits, bytes } objects populated via a
 * rest_command.fortigate_proxy call (see docs/fortigate-ha-traffic.yaml).
 * Returns null when the sensor is absent/unavailable.
 */
export function haTopSites(): { domain: string; category: string | null; hits: number; bytes: number }[] | null {
  const s = stateOf('sensor.fortigate_top_sites');
  if (!s) return null;
  const sites = s.attributes['sites'];
  if (!Array.isArray(sites) || sites.length === 0) return null;
  const result: { domain: string; category: string | null; hits: number; bytes: number }[] = [];
  for (const site of sites) {
    if (site !== null && typeof site === 'object') {
      const entry = site as Record<string, unknown>;
      const domain = typeof entry['domain'] === 'string' ? entry['domain']
        : (typeof entry['hostname'] === 'string' ? entry['hostname']
          : (typeof entry['dstip'] === 'string' ? entry['dstip']
            : (typeof entry['dst'] === 'string' ? entry['dst'] : null)));
      if (!domain) continue;
      const category = typeof entry['category'] === 'string' ? entry['category']
        : (typeof entry['cat'] === 'string' ? entry['cat'] : null);
      const hits = typeof entry['hits'] === 'number' ? entry['hits']
        : (typeof entry['sessions'] === 'number' ? entry['sessions']
          : (parseFloat(String(entry['hits'] ?? entry['sessions'] ?? '0')) || 0));
      const bytes = typeof entry['bytes'] === 'number' ? entry['bytes']
        : (parseFloat(String(entry['bytes'] ?? '0')) || 0);
      result.push({ domain, category, hits, bytes });
    }
  }
  return result.length > 0 ? result : null;
}
