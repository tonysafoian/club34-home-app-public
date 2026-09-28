import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  fortigateRequest as fortigateDirect,
  getSummary,
  getSdwanHealth,
  isFortigateConfigured,
  getFortigateBaseUrl,
  CircuitOpenError,
} from '../lib/fortigate.js';
import { classifyDevice, buildCategoryTree, isOwnerRequiredCategory, UNCATEGORIZED_CATEGORY } from '../deviceClassifier.js';
import { storage } from '../storage';
import {
  DEFAULT_SUBNET_MAP,
  resolveWifiSource,
  type RuckusObservation,
} from '../lib/wifi-map.js';
import { adviseWrongNetwork } from '../lib/wifi-classifier.js';
import { query as dbQuery } from '../lib/db.js';
import { normalizeMac, getDevicesByIps } from '../lib/network-devices.js';
import type { ConnectionMethod, ConnectionResolverContext } from '../lib/connection-resolver.js';
import type { DeviceOverride } from '../../shared/schema';
import {
  extractIpAddress,
  resolveDeviceConnection,
} from '../lib/device-connection.js';
import {
  CONNECTION_CACHE_TTL_MS,
  loadRuckusContext,
  getRuckusFeedHealthy,
  getConnectionCacheFreshness,
  readCachedConnections,
  writeCachedConnections,
  invalidateConnectionCache,
} from '../lib/connection-cache.js';
import { refreshConnectionMethodCache } from '../lib/connection-refresh.js';
import {
  haSystemHealth,
  haWanStats,
  haIpsAnomalyCount,
  haTopTalkers,
  haTopSites,
  haFortiViewSensorsPresent,
} from '../lib/fortigate-ha.js';

const router = Router();

const FORTIGATE_BASE_URL = getFortigateBaseUrl();

interface FortiCmdbInterface {
  name: string;
  ip?: string;
  mask?: string;
  type?: string;
  vlanid?: number;
  status?: string;
  speed?: number;
  description?: string;
}

interface FortiMonitorInterface {
  name?: string;
  link?: boolean;
  rx_bytes?: number;
  tx_bytes?: number;
  rx_packets?: number;
  tx_packets?: number;
}

interface FortiHaPeer {
  hostname?: string;
  role?: string;
  priority?: number;
  serial_no?: string;
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: () => void): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

/**
 * Backwards-compatible wrapper around the new direct-tunnel client.
 * Existing route handlers below expect a { status, data } envelope; the
 * direct client just throws on failure. We catch and translate so the
 * handlers don't need to change shape.
 */
export async function fortigateRequest(
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: string,
): Promise<{ status: number; data: unknown }> {
  try {
    const data = await fortigateDirect(path, method, body);
    return { status: 200, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Match HTTP status from the underlying error so existing handlers
    // can distinguish 401/403 from "unreachable".
    const httpMatch = /HTTP (\d{3})/.exec(message);
    if (httpMatch) {
      const status = parseInt(httpMatch[1], 10);
      return { status, data: { error: message } };
    }
    if (message.includes('authentication failed')) {
      return { status: 401, data: { error: message } };
    }
    if (message.includes('HTML instead of JSON')) {
      return { status: 502, data: { error: message, html: true } };
    }
    if (err instanceof CircuitOpenError) {
      return { status: 503, data: { error: message, circuit_breaker: 'open' } };
    }
    return { status: 503, data: { error: message } };
  }
}

console.log(`[FortiGate] direct-tunnel mode — requests go to ${FORTIGATE_BASE_URL}`);

function toNumber(val: unknown): number | undefined {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

function toBoolean(val: unknown): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val === 'true' || val === '1' || val === 'yes' || val === 'up';
  if (typeof val === 'number') return val !== 0;
  return false;
}

function extractCmdbInterfaces(data: unknown): Record<string, FortiCmdbInterface> {
  const result: Record<string, FortiCmdbInterface> = {};
  if (data === null || typeof data !== 'object') return result;
  const obj = data as Record<string, unknown>;
  const results = obj['results'];
  if (!Array.isArray(results)) return result;
  for (const item of results) {
    if (item !== null && typeof item === 'object') {
      const iface = item as Record<string, unknown>;
      const name = typeof iface['name'] === 'string' ? iface['name'] : undefined;
      if (name) {
        result[name] = {
          name,
          ip: typeof iface['ip'] === 'string' ? iface['ip'] : undefined,
          mask: typeof iface['mask'] === 'string' ? iface['mask'] : undefined,
          type: typeof iface['type'] === 'string' ? iface['type'] : undefined,
          vlanid: toNumber(iface['vlanid']),
          status: typeof iface['status'] === 'string' ? iface['status'] : undefined,
          speed: toNumber(iface['speed']),
          description: typeof iface['description'] === 'string' ? iface['description'] : undefined,
        };
      }
    }
  }
  return result;
}

function parseMonitorEntry(name: string, iface: Record<string, unknown>): FortiMonitorInterface {
  return {
    name,
    link: toBoolean(iface['link']),
    rx_bytes: toNumber(iface['rx_bytes']),
    tx_bytes: toNumber(iface['tx_bytes']),
    rx_packets: toNumber(iface['rx_packets']),
    tx_packets: toNumber(iface['tx_packets']),
  };
}

function extractMonitorInterfaces(data: unknown): Record<string, FortiMonitorInterface> {
  const result: Record<string, FortiMonitorInterface> = {};
  if (data === null || typeof data !== 'object') return result;
  const obj = data as Record<string, unknown>;
  const results = obj['results'];
  if (results === null || results === undefined) return result;

  if (Array.isArray(results)) {
    for (const item of results) {
      if (item !== null && typeof item === 'object') {
        const iface = item as Record<string, unknown>;
        const name = typeof iface['name'] === 'string' ? iface['name'] : undefined;
        if (name) {
          result[name] = parseMonitorEntry(name, iface);
        }
      }
    }
  } else if (typeof results === 'object') {
    for (const [name, item] of Object.entries(results as Record<string, unknown>)) {
      if (item !== null && typeof item === 'object') {
        result[name] = parseMonitorEntry(name, item as Record<string, unknown>);
      }
    }
  }

  return result;
}

function extractHaPeers(data: unknown): FortiHaPeer[] {
  if (data === null || typeof data !== 'object') return [];
  const obj = data as Record<string, unknown>;
  const results = obj['results'];
  if (!Array.isArray(results)) return [];
  return results
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      hostname: typeof item['hostname'] === 'string' ? item['hostname'] : undefined,
      role: typeof item['role'] === 'string' ? item['role'] : undefined,
      priority: toNumber(item['priority']),
      serial_no: typeof item['serial_no'] === 'string' ? item['serial_no'] : undefined,
    }));
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

export interface TopTalker {
  ip: string;
  bytes: number;
  tx_bytes: number;
  rx_bytes: number;
}

/**
 * Aggregate top bandwidth talkers from a FortiOS firewall-session monitor
 * response (`/api/v2/monitor/firewall/session`). Sessions are grouped by
 * source IP, summing tx+rx bytes, then sorted desc and capped at 20.
 *
 * Defensive by design: tolerates the several field-name shapes FortiOS uses
 * for the source address (`srcip`, `src`, `source_ip`, `saddr`) and byte
 * counters, and returns [] for empty / malformed input so callers can fall
 * through to the next data source without a 5xx.
 */
export function aggregateTopTalkersFromSessions(sessionData: unknown): TopTalker[] {
  if (sessionData === null || typeof sessionData !== 'object') return [];
  const results = (sessionData as Record<string, unknown>)['results'];
  const sessions: unknown[] = Array.isArray(results) ? results : [];
  if (sessions.length === 0) return [];

  const byIp = new Map<string, { tx: number; rx: number }>();
  for (const sRaw of sessions) {
    if (sRaw === null || typeof sRaw !== 'object') continue;
    const session = sRaw as Record<string, unknown>;
    const ip =
      (typeof session['srcip'] === 'string' && session['srcip']) ||
      (typeof session['src'] === 'string' && session['src']) ||
      (typeof session['source_ip'] === 'string' && session['source_ip']) ||
      (typeof session['saddr'] === 'string' && session['saddr']) ||
      null;
    if (!ip) continue;
    // Bytes may arrive split into tx/rx or as a single total. Cover both.
    const tx = toNumber(session['tx_bytes']) ?? toNumber(session['out_bytes']) ?? 0;
    const rx = toNumber(session['rx_bytes']) ?? toNumber(session['in_bytes']) ?? 0;
    const txAdd = tx;
    let rxAdd = rx;
    if (tx === 0 && rx === 0) {
      const total = toNumber(session['bytes']) ?? 0;
      // Attribute the lump sum to rx so it still ranks; tx stays 0.
      rxAdd = total;
    }
    if (txAdd === 0 && rxAdd === 0) continue;
    const acc = byIp.get(ip) ?? { tx: 0, rx: 0 };
    acc.tx += txAdd;
    acc.rx += rxAdd;
    byIp.set(ip, acc);
  }

  return Array.from(byIp.entries())
    .map(([ip, v]) => ({ ip, bytes: v.tx + v.rx, tx_bytes: v.tx, rx_bytes: v.rx }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20);
}

function getFortiErrorMessage(data: unknown, fallback: string): string {
  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj['error'] === 'string' && obj['error']) return obj['error'];
    if (typeof obj['message'] === 'string' && obj['message']) return obj['message'];
    if (typeof obj['cli_error'] === 'string' && obj['cli_error']) return obj['cli_error'];
    if (typeof obj['status'] === 'string' && obj['status']) return obj['status'];
  }
  return fallback;
}

function isHtmlResponse(data: unknown): boolean {
  if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return obj['html'] === true;
  }
  return false;
}

router.get('/api/fortigate/interfaces', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [cmdbResult, monitorResult] = await Promise.allSettled([
      fortigateRequest('/api/v2/cmdb/system/interface?format=name%7Cip%7Cmask%7Ctype%7Cvlanid%7Cstatus%7Cspeed%7Cdescription%7Callowaccess%7Cmtu'),
      fortigateRequest('/api/v2/monitor/system/interface'),
    ]);

    const cmdbData = cmdbResult.status === 'fulfilled' ? cmdbResult.value : null;
    const monitorData = monitorResult.status === 'fulfilled' ? monitorResult.value : null;

    const cmdbOk = cmdbData !== null && isSuccessStatus(cmdbData.status);
    const monitorOk = monitorData !== null && isSuccessStatus(monitorData.status);

    if (!cmdbOk && !monitorOk) {
      if (cmdbData && !isSuccessStatus(cmdbData.status)) {
        const detail = getFortiErrorMessage(cmdbData.data, `HTTP ${cmdbData.status}`);
        const httpStatus = isHtmlResponse(cmdbData.data) ? 502
          : (cmdbData.status === 401 || cmdbData.status === 403 ? cmdbData.status : 503);
        res.status(httpStatus).json({ error: detail });
      } else {
        const reason = cmdbResult.status === 'rejected'
          ? (cmdbResult.reason instanceof Error ? cmdbResult.reason.message : 'Connection failed')
          : 'Could not connect to firewall API';
        res.status(503).json({ error: 'FortiGate unreachable', details: reason });
      }
      return;
    }

    const cmdbInterfaces = cmdbOk ? extractCmdbInterfaces(cmdbData.data) : {};
    const monitorInterfaces = monitorOk ? extractMonitorInterfaces(monitorData.data) : {};

    const allNames = new Set([...Object.keys(cmdbInterfaces), ...Object.keys(monitorInterfaces)]);
    const interfaces = Array.from(allNames).map(name => {
      const cmdb = cmdbInterfaces[name] ?? {};
      const mon = monitorInterfaces[name] ?? {};
      return {
        name,
        ip: cmdb.ip ?? '',
        mask: cmdb.mask ?? '',
        type: cmdb.type ?? 'physical',
        vlanid: cmdb.vlanid ?? 0,
        status: cmdb.status ?? 'unknown',
        speed: cmdb.speed ?? 0,
        description: cmdb.description ?? '',
        link: mon.link ?? false,
        rx_bytes: mon.rx_bytes ?? null,
        tx_bytes: mon.tx_bytes ?? null,
        rx_packets: mon.rx_packets ?? null,
        tx_packets: mon.tx_packets ?? null,
      };
    });

    res.json({ interfaces });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] interfaces error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

function extractResourceValue(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseFloat(val);
    return isNaN(n) ? null : n;
  }
  if (Array.isArray(val)) {
    return extractResourceValue(val[0] ?? null);
  }
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if ('current' in obj) return extractResourceValue(obj['current']);
    if ('cpu' in obj) return extractResourceValue(obj['cpu']);
  }
  return null;
}

router.get('/api/fortigate/system-health', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // PRIMARY: read from the reliable HA FortiGate sensors. Fall back to the
    // direct FortiGate tunnel only if HA doesn't have the data.
    const fromHa = haSystemHealth();
    if (fromHa) {
      res.json({ ...fromHa, source: 'home_assistant' });
      return;
    }
    const result = await fortigateRequest('/api/v2/monitor/system/resource/usage?scope=global');
    if (!isSuccessStatus(result.status)) {
      const detail = getFortiErrorMessage(result.data, `HTTP ${result.status}`);
      res.status(isHtmlResponse(result.data) ? 502 : (result.status === 401 || result.status === 403 ? result.status : 503))
        .json({ error: detail });
      return;
    }
    const data = result.data as Record<string, unknown>;
    const results = data['results'] as Record<string, unknown> | undefined;
    console.log('[FortiGate] system-health raw results shape:', JSON.stringify(results)?.slice(0, 500));
    const cpu = extractResourceValue(results?.['cpu'] ?? null);
    const mem = extractResourceValue(results?.['mem'] ?? null);
    const sessions = extractResourceValue(results?.['session'] ?? null);
    res.json({
      cpu_usage: cpu ?? null,
      memory_usage: mem ?? null,
      active_sessions: sessions ?? null,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] system-health error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

router.get('/api/fortigate/system-status', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await fortigateRequest('/api/v2/monitor/system/status');
    if (!isSuccessStatus(result.status)) {
      const detail = getFortiErrorMessage(result.data, `HTTP ${result.status}`);
      res.status(isHtmlResponse(result.data) ? 502 : (result.status === 401 || result.status === 403 ? result.status : 503))
        .json({ error: detail });
      return;
    }
    const data = result.data as Record<string, unknown>;
    const results = data['results'] as Record<string, unknown> | undefined;
    console.log('[FortiGate] system-status raw results keys:', results ? Object.keys(results).join(', ') : 'undefined');

    const uptimeRaw = results?.['uptime'] ?? results?.['up_time'] ?? results?.['system_time'] ?? null;
    const uptime = uptimeRaw !== null && uptimeRaw !== undefined ? (toNumber(uptimeRaw) ?? null) : null;

    const firmwareRaw = results?.['version'] ?? results?.['firmware_version'] ?? results?.['os_version'] ?? results?.['build'] ?? null;
    const firmware_version = typeof firmwareRaw === 'string' ? firmwareRaw : (firmwareRaw !== null ? String(firmwareRaw) : null);

    const hostnameRaw = results?.['hostname'] ?? results?.['host_name'] ?? null;
    const hostname = typeof hostnameRaw === 'string' ? hostnameRaw : null;

    const serialRaw = results?.['serial'] ?? results?.['serial_number'] ?? results?.['serial_no'] ?? null;
    const serial_number = typeof serialRaw === 'string' ? serialRaw : null;

    res.json({ uptime, firmware_version, hostname, serial_number });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] system-status error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

router.get('/api/fortigate/devices', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [deviceRes, fortiviewRes] = await Promise.allSettled([
      fortigateRequest('/api/v2/monitor/user/device/query?with_forticlient=false'),
      fortigateRequest('/api/v2/monitor/fortiview/statistics?filter=srcip&count=100&sort_by=bytes&realtime=false'),
    ]);

    if (deviceRes.status === 'rejected' || !isSuccessStatus(deviceRes.value.status)) {
      const errData = deviceRes.status === 'fulfilled' ? deviceRes.value.data : null;
      const errStatus = deviceRes.status === 'fulfilled' ? deviceRes.value.status : 503;
      const detail = getFortiErrorMessage(errData, `HTTP ${errStatus}`);
      res.status(isHtmlResponse(errData) ? 502 : (errStatus === 401 || errStatus === 403 ? errStatus : 503))
        .json({ error: detail });
      return;
    }

    // Build IP -> traffic map from FortiView
    const ipTrafficMap = new Map<string, { tx_bytes: number; rx_bytes: number; bytes: number }>();
    if (fortiviewRes.status === 'fulfilled' && isSuccessStatus(fortiviewRes.value.status)) {
      const fvData = fortiviewRes.value.data as Record<string, unknown>;
      const fvResults = fvData['results'];
      const entries: unknown[] = Array.isArray(fvResults) ? fvResults : [];
      for (const e of entries) {
        if (e !== null && typeof e === 'object') {
          const entry = e as Record<string, unknown>;
          const ip = typeof entry['srcip'] === 'string' ? entry['srcip'] : (typeof entry['src'] === 'string' ? entry['src'] : null);
          if (ip) {
            const bytes = toNumber(entry['bytes']) ?? toNumber(entry['bandwidth']) ?? 0;
            const txBytes = toNumber(entry['tx_bytes']) ?? toNumber(entry['egress_bytes']) ?? 0;
            const rxBytes = toNumber(entry['rx_bytes']) ?? toNumber(entry['ingress_bytes']) ?? 0;
            ipTrafficMap.set(ip, { tx_bytes: txBytes, rx_bytes: rxBytes, bytes });
          }
        }
      }
    }

    // Load Ruckus observations from network_devices for the 4-tier connection resolver.
    // A single query covering the longer recent window is sufficient — buildRuckusMaps
    // partitions the rows into live / recent buckets using timestamps.
    //
    // Feed health is derived from wireless_snapshots.captured_at (the Ruckus-specific
    // cron timestamp) rather than network_devices.last_seen, which is bumped by
    // FortiGate DHCP/ARP ingestion too and would falsely signal a live Ruckus feed
    // when the controller is actually offline.
    const data = deviceRes.value.data as Record<string, unknown>;
    const results = data['results'];
    const devices: Record<string, unknown>[] = (Array.isArray(results) ? results : [])
      .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object');

    const overridesList: DeviceOverride[] = await storage.getDeviceOverrides().catch(() => []);
    const overridesMap = new Map(overridesList.map(o => [o.mac, o]));

    // ── Connection-method cache ──────────────────────────────────────
    // The resolved Wired/WiFi label per MAC is cached in network_devices
    // (refreshed every 5 min by the Ruckus snapshot cron). Read the cache
    // first; only fall back to the slow path (Ruckus history scan +
    // per-device ladder) for MACs whose cached label is missing or stale.
    const macList = devices
      .map(d => (typeof d['mac'] === 'string' ? normalizeMac(d['mac']) : null))
      .filter((m): m is string => !!m);
    const cacheByMac = await readCachedConnections(macList).catch(() => new Map());
    const nowMs = Date.now();
    const freshCached = (normMac: string | null): ConnectionMethod | null => {
      if (!normMac) return null;
      const hit = cacheByMac.get(normMac);
      return hit && (nowMs - hit.resolvedAt) <= CONNECTION_CACHE_TTL_MS ? hit.connection : null;
    };

    // Only pay for the Ruckus history scan + maps if at least one MAC'd
    // device misses the cache. (MAC-less devices resolve via the heuristic/
    // subnet tiers, which need no Ruckus context.)
    const needLive = devices.some(d => {
      const normMac = typeof d['mac'] === 'string' ? normalizeMac(d['mac']) : null;
      return normMac !== null && freshCached(normMac) === null;
    });

    let ctx: ConnectionResolverContext;
    let ruckusFeedHealthy: boolean;
    if (needLive) {
      ctx = await loadRuckusContext();
      ruckusFeedHealthy = ctx.ruckusFeedHealthy;
    } else {
      // Warm path: skip the scan, but still report feed health cheaply.
      ruckusFeedHealthy = await getRuckusFeedHealthy();
      ctx = { liveRuckusByMac: new Map(), recentRuckusByMac: new Map(), ruckusFeedHealthy };
    }

    // Collect freshly-computed labels to write back to the cache so the
    // next request hits the warm path for these MACs too.
    const writeThrough: Array<{ mac: string; connection: ConnectionMethod }> = [];

    const mapped = devices
      .map(d => {
        const override = typeof d['mac'] === 'string' ? overridesMap.get(d['mac']) : null;
        const resolved = resolveDeviceConnection(d, override, ctx);
        const { fields, normalizedMac, classification } = resolved;
        const { hw_vendor, dev_type, os_type: os_t, hostname: host, mac, ip } = fields;

        // Prefer a fresh cached label; otherwise use the just-computed live
        // result and write it back so the next request is a cache hit.
        const cached = freshCached(normalizedMac);
        const connection: ConnectionMethod = cached ?? resolved.connection;
        if (!cached && normalizedMac) {
          writeThrough.push({ mac: normalizedMac, connection });
        }

        // Correlate TX/RX from FortiView top talkers if device's own values are null/zero
        const fortiviewTraffic = ip ? ipTrafficMap.get(ip) : null;
        const rawTx = toNumber(d['tx_bytes']) ?? null;
        const rawRx = toNumber(d['rx_bytes']) ?? null;
        const tx_bytes = (rawTx !== null && rawTx > 0) ? rawTx : (fortiviewTraffic ? fortiviewTraffic.tx_bytes : 0);
        const rx_bytes = (rawRx !== null && rawRx > 0) ? rawRx : (fortiviewTraffic ? fortiviewTraffic.rx_bytes : 0);

        const is_overridden = !!(override && (override.customName || override.customCategory));

        const effectiveCategory = override?.customCategory ?? classification.category;
        const effectiveSubcategory = override?.customSubcategory ?? classification.subcategory;
        const hasOwner = !!override?.owner;
        // ownerRequired is computed off the EFFECTIVE (post-override) category so
        // that a device an admin anchored into "People / Personal Devices" still
        // counts as needing an owner.
        const ownerRequiredEffective = isOwnerRequiredCategory(effectiveCategory);
        // needs_label: device stays in the triage queue when it has no owner AND
        //   - the classifier flagged it as needsLabel (Unknown/Uncategorized, random+no-hostname), OR
        //   - its effective category expects an owner identity.
        // Crucially this still fires after a category/name override: anchoring a
        // randomized device to a personal category does NOT clear it from triage
        // until an owner label is actually saved.
        const wantsLabel = (classification.needsLabel ?? false) || ownerRequiredEffective;
        const needsLabel = !hasOwner && wantsLabel;
        // owner_missing: the "anchored but unattributed" case — the device already
        // has a concrete owner-required category (e.g. People / Personal Devices)
        // but no owner has been assigned yet. Excludes the still-uncategorized
        // bucket, which is surfaced by needs_label's labeling badge instead.
        const ownerMissing = ownerRequiredEffective
          && effectiveCategory !== UNCATEGORIZED_CATEGORY
          && !hasOwner;

        return {
          hostname: override?.customName ?? host,
          original_hostname: host,
          ip,
          mac,
          interface: typeof d['interface'] === 'string' ? d['interface'] : (typeof d['vdom'] === 'string' ? d['vdom'] : null),
          last_seen: typeof d['last_seen'] === 'number' ? d['last_seen'] : null,
          os_type: os_t,
          hardware_vendor: hw_vendor,
          device_type: dev_type,
          tx_bytes,
          rx_bytes,
          category: effectiveCategory,
          subcategory: effectiveSubcategory,
          vendor: classification.vendor,
          is_overridden,
          is_random: classification.isRandom ?? false,
          needs_label: needsLabel,
          owner_missing: ownerMissing,
          owner: override?.owner ?? null,
          connection,
        };
      });

    // Best-effort write-through so freshly-computed labels warm the cache for
    // the next request. Never block or fail the response on a cache write.
    if (writeThrough.length > 0) {
      writeCachedConnections(writeThrough).catch(e =>
        console.warn('[FortiGate] devices: connection cache write-through failed:', e instanceof Error ? e.message : e),
      );
    }

    // Surface connection-label cache freshness so the UI can show "labels last
    // refreshed N min ago" and warn when the warming cron has stalled.
    const connectionCache = await getConnectionCacheFreshness().catch(() => ({ oldest: null, newest: null, count: 0 }));

    const groupBy = req.query['groupBy'];
    if (groupBy === 'category') {
      const tree = buildCategoryTree(mapped);
      res.json({ devices: mapped, total: mapped.length, categoryTree: tree, ruckus_feed_healthy: ruckusFeedHealthy, connection_cache: connectionCache });
      return;
    }

    res.json({ devices: mapped, total: mapped.length, ruckus_feed_healthy: ruckusFeedHealthy, connection_cache: connectionCache });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] devices error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

// Admin-only: force a recompute of the per-device connection-method cache. The
// cache is normally warmed every 5 min by the Ruckus snapshot cron; this lets an
// admin refresh it on demand (e.g. right after re-cabling a device) instead of
// waiting for the next tick. Reuses the exact same logic as the cron path.
router.post('/api/fortigate/devices/refresh-connections', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = await refreshConnectionMethodCache();
    const connectionCache = await getConnectionCacheFreshness().catch(() => ({ oldest: null, newest: null, count: 0 }));
    res.json({ ok: true, updated, connection_cache: connectionCache });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] refresh-connections error:', message);
    res.status(503).json({ error: 'Failed to refresh connection labels', details: message });
  }
});

router.get('/api/fortigate/device-overrides', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const overrides = await storage.getDeviceOverrides();
    res.json({ overrides });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to fetch device overrides', details: message });
  }
});

router.put('/api/fortigate/device-overrides/:mac', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const macParam = req.params['mac'];
    const mac = Array.isArray(macParam) ? macParam[0] : macParam;
    const { custom_name, custom_category, custom_subcategory, original_hostname, owner } = req.body as {
      custom_name?: string | null;
      custom_category?: string | null;
      custom_subcategory?: string | null;
      original_hostname?: string | null;
      owner?: string | null;
    };

    if (!mac) {
      res.status(400).json({ error: 'MAC address is required' });
      return;
    }

    // Merge with the existing override: only fields present in the request
    // body are changed (explicit null still clears). This lets partial
    // editors — e.g. the Traffic tab's inline rename / category picker —
    // write one field without clobbering the others.
    const has = (key: string): boolean =>
      req.body !== null && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, key);
    const existing = await storage.getDeviceOverrideByMac(mac);

    const override = await storage.upsertDeviceOverride({
      mac,
      customName: has('custom_name') ? custom_name ?? null : existing?.customName ?? null,
      customCategory: has('custom_category') ? custom_category ?? null : existing?.customCategory ?? null,
      customSubcategory: has('custom_subcategory') ? custom_subcategory ?? null : existing?.customSubcategory ?? null,
      originalHostname: has('original_hostname') ? original_hostname ?? null : existing?.originalHostname ?? null,
      owner: has('owner') ? owner ?? null : existing?.owner ?? null,
    });

    // A category override can flip the Tier-3 connection heuristic, so drop
    // the cached label and let the next read recompute it.
    invalidateConnectionCache([normalizeMac(mac)]).catch(() => {});

    res.json({ override });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to save device override', details: message });
  }
});

router.delete('/api/fortigate/device-overrides/:mac', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const mac = String(req.params.mac);
    await storage.deleteDeviceOverride(mac);
    // Removing an override reverts to auto-classification, which can change the
    // Tier-3 heuristic; drop the cached label so the next read recomputes it.
    invalidateConnectionCache([normalizeMac(mac)]).catch(() => {});
    res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to delete device override', details: message });
  }
});

router.get('/api/fortigate/traffic', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // Top talkers. Source priority on this FGT60F / FortiOS 7.2.13:
    //   1. HA sensor.fortigate_top_talkers (when configured)
    //   2. firewall-session aggregation by source IP (the working live path —
    //      the device-query feed is a device inventory and usually carries no
    //      per-device byte counters, so it returned []). We try the session
    //      monitor with summary first, then without, then fall back to the
    //      legacy device-query byte aggregation as a last resort.
    // The FortiView statistics endpoint (fortiview/statistics?filter=srcip) is
    // dead on this firmware and always returns empty, so it's not used here.
    let topTalkers: TopTalker[] = [];
    let topTalkersSource: 'ha' | 'session-aggregate' | 'device-query' | 'none' = 'none';
    // Map of IP -> { hostname, mac } sourced from the FortiGate device query, used to
    // label top-talker entries with friendly device names instead of bare IPs.
    const ipDeviceMap = new Map<string, { hostname: string | null; mac: string | null }>();
    const haConsumers = haTopTalkers();
    if (haConsumers && haConsumers.length > 0) {
      topTalkers = haConsumers;
      topTalkersSource = 'ha';
    } else {
      // firewall-session aggregation — try summary variant first, then raw.
      const sessionCandidates = [
        '/api/v2/monitor/firewall/session?count=1000&sub_type=user&summary=true',
        '/api/v2/monitor/firewall/session?count=1000',
      ];
      for (const path of sessionCandidates) {
        try {
          const sessRes = await fortigateRequest(path);
          if (!isSuccessStatus(sessRes.status)) continue;
          const aggregated = aggregateTopTalkersFromSessions(sessRes.data);
          if (aggregated.length > 0) {
            topTalkers = aggregated;
            topTalkersSource = 'session-aggregate';
            break;
          }
        } catch (_ignored) { /* best-effort; try the next candidate */ }
      }

      // Last resort: legacy device-query byte aggregation (kept for firmwares
      // that DO populate tx_bytes/rx_bytes on the device feed).
      if (topTalkers.length === 0) {
        try {
          const deviceRes = await fortigateRequest('/api/v2/monitor/user/device/query?with_forticlient=false');
          if (isSuccessStatus(deviceRes.status)) {
            const dData = deviceRes.data as Record<string, unknown>;
            const dResults = dData['results'];
            const entries: unknown[] = Array.isArray(dResults) ? dResults : [];
            for (const d of entries) {
              if (d !== null && typeof d === 'object') {
                const entry = d as Record<string, unknown>;
                const ip = extractIpAddress(entry);
                if (ip) {
                  const host = typeof entry['hostname'] === 'string' ? entry['hostname'] : (typeof entry['name'] === 'string' ? entry['name'] : null);
                  const mac = typeof entry['mac'] === 'string' ? entry['mac'] : null;
                  ipDeviceMap.set(ip, { hostname: host, mac });
                }
                const txBytes = toNumber(entry['tx_bytes']) ?? 0;
                const rxBytes = toNumber(entry['rx_bytes']) ?? 0;
                const bytes = txBytes + rxBytes;
                if (ip && bytes > 0) topTalkers.push({ ip, bytes, tx_bytes: txBytes, rx_bytes: rxBytes });
              }
            }
            topTalkers.sort((a, b) => b.bytes - a.bytes);
            topTalkers = topTalkers.slice(0, 20);
            if (topTalkers.length > 0) topTalkersSource = 'device-query';
          }
        } catch (_ignored) { /* best-effort; return empty array below */ }
      }
    }
    console.info(`[FortiGate] traffic: top_talkers source=${topTalkersSource}, count=${topTalkers.length}`);

    // If top talkers came from HA or the session aggregation (neither carries
    // device metadata), do a best-effort device query purely to build the
    // IP -> hostname/mac map for labeling.
    if (topTalkers.length > 0 && ipDeviceMap.size === 0) {
      try {
        const deviceRes = await fortigateRequest('/api/v2/monitor/user/device/query?with_forticlient=false');
        if (isSuccessStatus(deviceRes.status)) {
          const dData = deviceRes.data as Record<string, unknown>;
          const dResults = dData['results'];
          const entries: unknown[] = Array.isArray(dResults) ? dResults : [];
          for (const d of entries) {
            if (d !== null && typeof d === 'object') {
              const entry = d as Record<string, unknown>;
              const ip = extractIpAddress(entry);
              if (ip) {
                const host = typeof entry['hostname'] === 'string' ? entry['hostname'] : (typeof entry['name'] === 'string' ? entry['name'] : null);
                const mac = typeof entry['mac'] === 'string' ? entry['mac'] : null;
                ipDeviceMap.set(ip, { hostname: host, mac });
              }
            }
          }
        }
      } catch (_ignored) { /* best-effort; labels just fall back to IP */ }
    }

    // Enrich top talkers with friendly device names. Priority, most authoritative first:
    //   1. device_overrides custom name (admin-set, keyed by MAC)
    //   2. network_devices.label (admin-set friendly name, keyed by IP→MAC)
    //   3. live FortiGate device-query hostname
    //   4. network_devices observed hostname (last seen)
    //   5. raw IP (frontend fallback)
    const overridesList: DeviceOverride[] = await storage.getDeviceOverrides().catch(() => []);
    const overridesByMac = new Map(overridesList.map(o => [normalizeMac(o.mac), o]));
    const ndByIp = await getDevicesByIps(topTalkers.map(t => t.ip)).catch(() => new Map());
    const enrichedTopTalkers = topTalkers.map(t => {
      const dev = ipDeviceMap.get(t.ip);
      const nd = ndByIp.get(t.ip);
      const mac = dev?.mac ?? nd?.mac ?? null;
      const override = mac ? overridesByMac.get(normalizeMac(mac)) : null;
      const hostname = override?.customName ?? nd?.label ?? dev?.hostname ?? nd?.hostname ?? null;
      // Admin-set category override (device_overrides.custom_category); the
      // Traffic tab shows it on the row and pre-fills the inline picker.
      const category = override?.customCategory ?? null;
      return { ...t, hostname, mac, category };
    });

    // Interface bandwidth and WAN current throughput from direct API (best-effort)
    type TrafficHistoryPoint = { t: number; rx: number; tx: number };
    const wanThroughputHistory: TrafficHistoryPoint[] = [];
    let wanRxCurrent: number | null = null;
    let wanTxCurrent: number | null = null;
    const interfaceBandwidth: { name: string; rx_bytes: number; tx_bytes: number; link: boolean }[] = [];

    // Try HA WAN stats for current throughput first
    const haWan = haWanStats();
    if (haWan) {
      wanRxCurrent = haWan.rx_bytes;
      wanTxCurrent = haWan.tx_bytes;
    }

    // Attempt direct traffic-history + interface monitor (best-effort)
    try {
      const [trafficHistRes, ifaceMonRes] = await Promise.allSettled([
        fortigateRequest('/api/v2/monitor/system/traffic-history/interface?interface=wan1&time_period=hour'),
        fortigateRequest('/api/v2/monitor/system/interface'),
      ]);

      const trafficHistOk = trafficHistRes.status === 'fulfilled' && isSuccessStatus(trafficHistRes.value.status);
      const ifaceMonOk = ifaceMonRes.status === 'fulfilled' && isSuccessStatus(ifaceMonRes.value.status);

      if (trafficHistOk) {
        const thData = trafficHistRes.value.data as Record<string, unknown>;
        const thResults = thData['results'];
        if (thResults !== null && typeof thResults === 'object' && !Array.isArray(thResults)) {
          const r = thResults as Record<string, unknown>;
          const rxHistory = Array.isArray(r['rx_bytes']) ? r['rx_bytes'] as number[] : [];
          const txHistory = Array.isArray(r['tx_bytes']) ? r['tx_bytes'] as number[] : [];
          const timestamps = Array.isArray(r['timestamps']) ? r['timestamps'] as number[] : [];
          const len = Math.min(rxHistory.length, txHistory.length, timestamps.length || rxHistory.length);
          for (let i = 0; i < len; i++) {
            wanThroughputHistory.push({ t: timestamps[i] ?? 0, rx: rxHistory[i] ?? 0, tx: txHistory[i] ?? 0 });
          }
        } else if (Array.isArray(thResults)) {
          for (const item of thResults) {
            if (item !== null && typeof item === 'object') {
              const pt = item as Record<string, unknown>;
              wanThroughputHistory.push({
                t: toNumber(pt['timestamp']) ?? toNumber(pt['t']) ?? 0,
                rx: toNumber(pt['rx_bytes']) ?? toNumber(pt['rx']) ?? 0,
                tx: toNumber(pt['tx_bytes']) ?? toNumber(pt['tx']) ?? 0,
              });
            }
          }
        }
        if (wanThroughputHistory.length > 0 && wanRxCurrent === null) {
          const last = wanThroughputHistory[wanThroughputHistory.length - 1];
          wanRxCurrent = last.rx;
          wanTxCurrent = last.tx;
        }
      }

      if (ifaceMonOk) {
        const monInterfaces = extractMonitorInterfaces(ifaceMonRes.value.data);
        for (const [name, iface] of Object.entries(monInterfaces)) {
          interfaceBandwidth.push({ name, rx_bytes: iface.rx_bytes ?? 0, tx_bytes: iface.tx_bytes ?? 0, link: iface.link ?? false });
        }
        interfaceBandwidth.sort((a, b) => (b.rx_bytes + b.tx_bytes) - (a.rx_bytes + a.tx_bytes));
        if (wanRxCurrent === null) {
          for (const name of ['wan1', 'wan2', 'WAN1', 'WAN2']) {
            const iface = interfaceBandwidth.find(i => i.name === name);
            if (iface) { wanRxCurrent = iface.rx_bytes; wanTxCurrent = iface.tx_bytes; break; }
          }
        }
      }
    } catch (_ignored) { /* interface data is optional */ }

    // Always return 200 — empty arrays are the "pending" state, not an error.
    res.json({
      top_talkers: enrichedTopTalkers,
      interface_bandwidth: interfaceBandwidth,
      wan_throughput: {
        rx_bytes: wanRxCurrent,
        tx_bytes: wanTxCurrent,
        history: wanThroughputHistory.slice(-60),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] traffic error:', message);
    // Still return 200 with empty payload so the UI shows pending states
    res.json({ top_talkers: [], interface_bandwidth: [], wan_throughput: { rx_bytes: null, tx_bytes: null, history: [] } });
  }
});

router.get('/api/fortigate/top-sites', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    // Prefer HA sensor; fall back to the web-filter memory log (same source as dns-dhcp, verified working).
    // The FortiView statistics endpoint (fortiview/statistics?filter=dstip) is dead on this FortiGate/FortiOS
    // and always returns empty — so we aggregate over the web-filter log instead.
    const haSites = haTopSites();
    if (haSites && haSites.length > 0) {
      res.json({ sites: haSites, total: haSites.length });
      return;
    }

    // Best-effort webfilter log path — return empty-but-200 if unreachable.
    let sites: { domain: string; category: string | null; hits: number; bytes: number }[] = [];
    const webfilterCandidates = [
      '/api/v2/log/memory/webfilter?rows=500&start=0',
      '/api/v2/log/disk/webfilter?rows=500&start=0',
      '/api/v2/log/memory/utm/webfilter?rows=500&start=0',
      '/api/v2/log/disk/utm/webfilter?rows=500&start=0',
    ];

    for (const path of webfilterCandidates) {
      try {
        const result = await fortigateRequest(path);
        if (!isSuccessStatus(result.status)) continue;
        const wfData = result.data as Record<string, unknown>;
        const wfResults = wfData['results'];
        const entries: unknown[] = Array.isArray(wfResults) ? wfResults : [];
        if (entries.length === 0) continue;

        // Aggregate by hostname/domain — group hits and sum bytes
        const siteMap = new Map<string, { category: string | null; hits: number; bytes: number }>();
        for (const e of entries) {
          if (e === null || typeof e !== 'object') continue;
          const entry = e as Record<string, unknown>;
          // Pick the best domain field available
          const rawDomain =
            (typeof entry['hostname'] === 'string' && entry['hostname'].trim()) ||
            (typeof entry['url'] === 'string' && entry['url'].trim()) ||
            (typeof entry['domain'] === 'string' && entry['domain'].trim()) ||
            (typeof entry['dstip'] === 'string' && entry['dstip'].trim()) || null;
          if (!rawDomain) continue;
          // Normalize: strip path/query so we group by hostname only
          const key = rawDomain.split('/')[0].toLowerCase().replace(/^www\./, '');
          const category =
            (typeof entry['catdesc'] === 'string' ? entry['catdesc'] : null) ??
            (typeof entry['category'] === 'string' ? entry['category'] : null) ??
            (typeof entry['cat'] === 'string' ? entry['cat'] : null);
          const entryBytes =
            toNumber(entry['sentbyte']) ?? toNumber(entry['rcvdbyte']) ?? toNumber(entry['bytes']) ?? 0;
          const existing = siteMap.get(key);
          if (existing) {
            existing.hits++;
            existing.bytes += entryBytes;
            if (!existing.category && category) existing.category = category;
          } else {
            siteMap.set(key, { category, hits: 1, bytes: entryBytes });
          }
        }

        sites = Array.from(siteMap.entries())
          .map(([domain, v]) => ({ domain, ...v }))
          .sort((a, b) => b.hits - a.hits || b.bytes - a.bytes)
          .slice(0, 20);

        console.info(`[FortiGate] top-sites: ${path} → ${entries.length} entries → ${sites.length} unique domains`);
        break; // Successfully parsed — stop trying other paths
      } catch (_ignored) { /* try next path */ }
    }

    // Always 200 — empty array is the "no data yet" state.
    res.json({ sites, total: sites.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] top-sites error:', message);
    res.json({ sites: [], total: 0 });
  }
});

// ── WAN Throughput History ────────────────────────────────────────────────────

/**
 * POST /api/fortigate-wan-snapshot
 * Cron-triggered (every 60s) — reads live HA WAN sensors and inserts one row
 * into wan_throughput_history. Skips gracefully when HA data is unavailable.
 * Enforces a 4-hour rolling window by deleting older rows on each insert.
 */
router.post('/api/fortigate-wan-snapshot', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const wan = haWanStats();
    if (!wan) {
      res.json({ skipped: true, reason: 'HA WAN sensors unavailable' });
      return;
    }

    try {
      await dbQuery(
        `INSERT INTO wan_throughput_history (wan_rx_gb, wan_tx_gb, wan_speed, wan_status, wan_link)
         VALUES ($1, $2, $3, $4, $5)`,
        [wan.rx_gb, wan.tx_gb, wan.wan_speed, wan.wan_status, wan.link],
      );

      // Prune rows older than 4 hours
      await dbQuery(`DELETE FROM wan_throughput_history WHERE captured_at < NOW() - INTERVAL '4 hours'`, []);
    } catch (dbErr: unknown) {
      const dbMsg = dbErr instanceof Error ? dbErr.message : 'Unknown DB error';
      if (dbMsg.toLowerCase().includes('relation') && dbMsg.toLowerCase().includes('does not exist')) {
        console.error(
          '[FortiGate] wan-snapshot: wan_throughput_history table is missing in this environment. ' +
          'The schema migration has not been applied yet — a Publish is required to create this table in production. ' +
          'Skipping insert until the table exists.',
        );
        res.json({ skipped: true, reason: 'Table wan_throughput_history not found — schema migration pending (Publish required)' });
        return;
      }
      throw dbErr;
    }

    res.json({ ok: true, rx_gb: wan.rx_gb, tx_gb: wan.tx_gb });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] wan-snapshot error:', message);
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/fortigate/wan-history?window=60
 * Returns WAN throughput history points from the last `window` minutes (default 60).
 * Always returns 200 with an empty `points` array when no data is available yet.
 * Points are ordered ascending by captured_at so the chart renders left→right.
 *
 * The stored wan_rx_gb / wan_tx_gb columns are cumulative GB counters (total-since-reset
 * from HA), so plotting them directly produces a flat line. We instead compute the delta
 * between consecutive samples and convert it to throughput in MB/s.
 * Each point: { ts: unix-ms, rx: rx_gb (cumulative), tx: tx_gb (cumulative),
 *               rx_mbps: number, tx_mbps: number }
 */
router.get('/api/fortigate/wan-history', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const windowMinutes = Math.min(Math.max(parseInt(String(req.query['window'] ?? '60'), 10) || 60, 1), 1440);

    // Fetch one extra sample just before the window so the first in-window point
    // has a previous reading to delta against.
    const { rows } = await dbQuery(
      `WITH windowed AS (
         SELECT captured_at, wan_rx_gb, wan_tx_gb
         FROM wan_throughput_history
         WHERE captured_at >= NOW() - ($1 || ' minutes')::INTERVAL
       ),
       prior AS (
         SELECT captured_at, wan_rx_gb, wan_tx_gb
         FROM wan_throughput_history
         WHERE captured_at < NOW() - ($1 || ' minutes')::INTERVAL
         ORDER BY captured_at DESC
         LIMIT 1
       )
       SELECT * FROM prior
       UNION ALL
       SELECT * FROM windowed
       ORDER BY captured_at ASC`,
      [windowMinutes],
    );

    const windowStart = Date.now() - windowMinutes * 60 * 1000;

    const points: {
      ts: number;
      rx: number;
      tx: number;
      rx_mbps: number;
      tx_mbps: number;
    }[] = [];

    let prev: { ts: number; rx: number; tx: number } | null = null;
    for (const r of rows as Record<string, unknown>[]) {
      const ts = new Date(r['captured_at'] as string).getTime();
      const rx = parseFloat(String(r['wan_rx_gb'] ?? '0')) || 0;
      const tx = parseFloat(String(r['wan_tx_gb'] ?? '0')) || 0;

      let rxMbps = 0;
      let txMbps = 0;
      if (prev) {
        const dtSeconds = (ts - prev.ts) / 1000;
        if (dtSeconds > 0) {
          // Cumulative counters can reset (HA reload / counter wrap); clamp negatives to 0.
          const dRxGb = Math.max(rx - prev.rx, 0);
          const dTxGb = Math.max(tx - prev.tx, 0);
          // GB → MB is ×1024, divided by elapsed seconds → MB/s.
          rxMbps = (dRxGb * 1024) / dtSeconds;
          txMbps = (dTxGb * 1024) / dtSeconds;
        }
      }

      prev = { ts, rx, tx };

      // Drop the synthetic prior sample (it only exists to seed the first delta).
      if (ts < windowStart) continue;

      points.push({ ts, rx, tx, rx_mbps: rxMbps, tx_mbps: txMbps });
    }

    res.json({ points, windowMinutes });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] wan-history error:', message);
    res.json({ points: [], windowMinutes: 60 });
  }
});

router.get('/api/fortigate/devices/:identifier/traffic', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const identifier = String(req.params.identifier);
  const srcip = req.query['srcip'] as string | undefined;

  if (!srcip) {
    res.status(400).json({ error: 'srcip query parameter is required' });
    return;
  }

  try {
    const encodedIp = encodeURIComponent(srcip);
    const [fortiviewRes, trafficLogRes, deviceQueryRes] = await Promise.allSettled([
      fortigateRequest(`/api/v2/monitor/fortiview/statistics?filter=srcip&srcip=${encodedIp}&count=50&sort_by=bytes&realtime=false`),
      fortigateRequest(`/api/v2/log/disk/traffic?filter=srcip%3D%3D${encodedIp}&rows=50&start=0`),
      // Best-effort: live device-query supplies the FortiGate hostname/MAC
      // tier of the friendly-name chain (same source as /api/fortigate/traffic).
      fortigateRequest('/api/v2/monitor/user/device/query?with_forticlient=false'),
    ]);

    // Parse FortiView statistics — top destinations for this device
    const destinations: { domain: string; category: string | null; hits: number; bytes: number; tx_bytes: number; rx_bytes: number }[] = [];
    let totalTx = 0;
    let totalRx = 0;
    let totalBytes = 0;

    if (fortiviewRes.status === 'fulfilled' && isSuccessStatus(fortiviewRes.value.status)) {
      const fvData = fortiviewRes.value.data as Record<string, unknown>;
      const fvResults = fvData['results'];
      const entries: unknown[] = Array.isArray(fvResults) ? fvResults : [];
      for (const e of entries) {
        if (e !== null && typeof e === 'object') {
          const entry = e as Record<string, unknown>;
          const domain = typeof entry['domain'] === 'string' ? entry['domain']
            : (typeof entry['hostname'] === 'string' ? entry['hostname']
              : (typeof entry['dstip'] === 'string' ? entry['dstip']
                : (typeof entry['dst'] === 'string' ? entry['dst'] : null)));
          if (!domain) continue;
          const category = typeof entry['category'] === 'string' ? entry['category'] : (typeof entry['cat'] === 'string' ? entry['cat'] : null);
          const hits = toNumber(entry['sessions']) ?? toNumber(entry['hits']) ?? toNumber(entry['count']) ?? 0;
          const bytes = toNumber(entry['bytes']) ?? toNumber(entry['bandwidth']) ?? 0;
          const txBytes = toNumber(entry['tx_bytes']) ?? toNumber(entry['egress_bytes']) ?? 0;
          const rxBytes = toNumber(entry['rx_bytes']) ?? toNumber(entry['ingress_bytes']) ?? 0;
          destinations.push({ domain, category, hits, bytes, tx_bytes: txBytes, rx_bytes: rxBytes });
          totalTx += txBytes;
          totalRx += rxBytes;
          totalBytes += bytes;
        }
      }
    }

    // Parse traffic log — may have timestamps for richer history
    type TrafficLogEntry = { timestamp: string | null; dst: string | null; bytes: number; tx_bytes: number; rx_bytes: number };
    const trafficLog: TrafficLogEntry[] = [];
    if (trafficLogRes.status === 'fulfilled' && isSuccessStatus(trafficLogRes.value.status)) {
      const logData = trafficLogRes.value.data as Record<string, unknown>;
      const logResults = logData['results'];
      const logEntries: unknown[] = Array.isArray(logResults) ? logResults : [];
      for (const e of logEntries) {
        if (e !== null && typeof e === 'object') {
          const entry = e as Record<string, unknown>;
          const dst = typeof entry['dstip'] === 'string' ? entry['dstip'] : (typeof entry['hostname'] === 'string' ? entry['hostname'] : null);
          const bytes = toNumber(entry['sentbyte']) ?? toNumber(entry['rcvdbyte']) ?? toNumber(entry['bytes']) ?? 0;
          const txBytes = toNumber(entry['sentbyte']) ?? 0;
          const rxBytes = toNumber(entry['rcvdbyte']) ?? 0;
          let timestamp: string | null = null;
          const tsVal = entry['eventtime'] ?? entry['itime'] ?? entry['logtime'] ?? entry['date'];
          if (typeof tsVal === 'string') timestamp = tsVal;
          else if (typeof tsVal === 'number') {
            timestamp = tsVal > 1e12 ? new Date(tsVal / 1000).toISOString() : new Date(tsVal * 1000).toISOString();
          }
          trafficLog.push({ timestamp, dst, bytes, tx_bytes: txBytes, rx_bytes: rxBytes });
        }
      }
    }

    // ── Friendly-name enrichment ─────────────────────────────────────
    // Same priority chain as /api/fortigate/traffic top talkers:
    //   1. device_overrides custom name (admin-set, keyed by MAC)
    //   2. network_devices.label (admin-set friendly name, keyed by IP→MAC)
    //   3. live FortiGate device-query hostname
    //   4. network_devices observed hostname (last seen)
    //   5. raw IP (frontend fallback — hostname stays null)
    let fgtHostname: string | null = null;
    let fgtMac: string | null = null;
    if (deviceQueryRes.status === 'fulfilled' && isSuccessStatus(deviceQueryRes.value.status)) {
      const dqData = deviceQueryRes.value.data as Record<string, unknown>;
      const dqResults = dqData['results'];
      const dqEntries: unknown[] = Array.isArray(dqResults) ? dqResults : [];
      for (const d of dqEntries) {
        if (d !== null && typeof d === 'object') {
          const entry = d as Record<string, unknown>;
          if (extractIpAddress(entry) === srcip) {
            fgtHostname = typeof entry['hostname'] === 'string' ? entry['hostname'] : (typeof entry['name'] === 'string' ? entry['name'] : null);
            fgtMac = typeof entry['mac'] === 'string' ? entry['mac'] : null;
            break;
          }
        }
      }
    }

    const ndByIp = await getDevicesByIps([srcip]).catch(() => new Map<string, never>());
    const nd = ndByIp.get(srcip) ?? null;

    // The path :identifier is the device MAC when opened from the Devices tab
    // (and the IP when opened from the Traffic tab) — a MAC-shaped identifier
    // is the most authoritative MAC source for the override lookup.
    const identifierMac = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(identifier) ? normalizeMac(identifier) : null;
    const mac = identifierMac ?? fgtMac ?? nd?.mac ?? null;

    const overridesList = await storage.getDeviceOverrides().catch((): DeviceOverride[] => []);
    const override = mac
      ? overridesList.find(o => normalizeMac(o.mac) === normalizeMac(mac)) ?? null
      : null;
    const hostname = override?.customName ?? nd?.label ?? fgtHostname ?? nd?.hostname ?? null;
    const category = override?.customCategory ?? null;

    res.json({
      srcip,
      hostname,
      mac,
      category,
      total_tx_bytes: totalTx,
      total_rx_bytes: totalRx,
      total_bytes: totalBytes,
      destinations,
      traffic_log: trafficLog,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] device traffic error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

// Threat events from the IPS log. Prior implementation tried 11
// candidate paths and accepted the first non-empty response — which
// on FortiOS 7.2.13 caused it to fall through to
// /api/v2/monitor/ips/anomaly (the IPS *signature registry*:
// tcp_syn_flood, tcp_port_scan, etc.) and render 18 firewall
// CAPABILITIES as "threat events". Live probe of /api/v2/log/memory/ips
// shows 0 real events; the UI's empty state is correct.
//
// New implementation: read only /api/v2/log/memory/ips via
// getIpsThreats(), translate to the existing { threats, total } shape
// the Security tab already consumes.
router.get('/api/fortigate/threats', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { getIpsThreats } = await import('../lib/fortigate.js');
    const limit = parseInt(String(req.query['limit'] ?? '100'), 10) || 100;
    const events = await getIpsThreats(limit);
    const threats = events.map((e) => {
      const raw = e.raw as Record<string, unknown>;
      return {
        severity: e.severity ?? 'info',
        src_ip: e.src_ip ?? null,
        dst_ip: e.dst_ip ?? null,
        attack: e.signature ?? 'Unknown',
        action: e.action ?? null,
        timestamp: e.timestamp ?? null,
        protocol: typeof raw['proto'] === 'string' ? raw['proto'] : (typeof raw['proto'] === 'number' ? String(raw['proto']) : null),
        service: typeof raw['service'] === 'string' ? raw['service'] : null,
        src_country: typeof raw['srccountry'] === 'string' ? raw['srccountry'] : null,
        dst_country: typeof raw['dstcountry'] === 'string' ? raw['dstcountry'] : null,
        sent_bytes: typeof raw['sentbyte'] === 'number' ? raw['sentbyte'] : null,
        rcvd_bytes: typeof raw['rcvdbyte'] === 'number' ? raw['rcvdbyte'] : null,
        policy_id: typeof raw['policyid'] === 'number' ? String(raw['policyid']) : null,
        reference: typeof raw['ref'] === 'string' ? raw['ref'] : null,
      };
    });
    // If the detailed IPS log came back empty but HA reports anomalies,
    // surface the HA count so the Threats badge reflects reality (was
    // showing 0 while HA reported ips_anomaly_count = 18).
    const haAnomalies = haIpsAnomalyCount();
    const total = threats.length > 0 ? threats.length : (haAnomalies ?? 0);
    res.json({
      threats,
      total,
      ...(threats.length === 0 && haAnomalies ? { anomaly_count: haAnomalies, source: 'home_assistant' } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[FortiGate] threats failed:', message);
    // Detailed log unavailable — fall back to the HA IPS anomaly count so the
    // Threats badge still reflects reality instead of showing 0.
    const haAnomalies = haIpsAnomalyCount();
    res.json({
      threats: [],
      total: haAnomalies ?? 0,
      ...(haAnomalies ? { anomaly_count: haAnomalies, source: 'home_assistant' } : {}),
      error: message,
    });
  }
});


router.get('/api/fortigate/vpn', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [sslResult, ipsecResult] = await Promise.allSettled([
      fortigateRequest('/api/v2/monitor/vpn/ssl'),
      fortigateRequest('/api/v2/monitor/vpn/ipsec'),
    ]);

    const sslOk = sslResult.status === 'fulfilled' && isSuccessStatus(sslResult.value.status);
    const ipsecOk = ipsecResult.status === 'fulfilled' && isSuccessStatus(ipsecResult.value.status);

    if (!sslOk && !ipsecOk) {
      if (sslResult.status === 'fulfilled' && !isSuccessStatus(sslResult.value.status)) {
        const detail = getFortiErrorMessage(sslResult.value.data, `HTTP ${sslResult.value.status}`);
        const httpStatus = isHtmlResponse(sslResult.value.data) ? 502 : 503;
        res.status(httpStatus).json({ error: detail });
      } else {
        const reason = sslResult.status === 'rejected'
          ? (sslResult.reason instanceof Error ? sslResult.reason.message : 'VPN query failed')
          : `FortiGate VPN API returned HTTP ${sslResult.status === 'fulfilled' ? sslResult.value.status : 'unknown'}`;
        res.status(503).json({ error: 'FortiGate VPN unreachable', details: reason });
      }
      return;
    }

    const sslData = sslOk ? sslResult.value.data as Record<string, unknown> : null;
    const ipsecData = ipsecOk ? ipsecResult.value.data as Record<string, unknown> : null;

    const sslResults: unknown[] = sslData && Array.isArray(sslData['results']) ? sslData['results'] : [];
    const ipsecResults: unknown[] = ipsecData && Array.isArray(ipsecData['results']) ? ipsecData['results'] : [];

    const sslSessions = sslResults
      .filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
      .map(s => ({
        type: 'ssl' as const,
        user: typeof s['user_name'] === 'string' ? s['user_name'] : (typeof s['username'] === 'string' ? s['username'] : 'Unknown'),
        src_ip: typeof s['remote_host'] === 'string' ? s['remote_host'] : null,
        connected_at: typeof s['login_time'] === 'number' ? new Date(s['login_time'] * 1000).toISOString() : null,
        duration_seconds: typeof s['duration'] === 'number' ? s['duration'] : null,
        vpn_ip: typeof s['tunnel_ip'] === 'string' ? s['tunnel_ip'] : null,
      }));

    const ipsecTunnels = ipsecResults
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
      .map(t => ({
        type: 'ipsec' as const,
        user: typeof t['name'] === 'string' ? t['name'] : 'Tunnel',
        src_ip: typeof t['rgwy'] === 'string' ? t['rgwy'] : null,
        connected_at: null,
        duration_seconds: null,
        vpn_ip: null,
        status: typeof t['tun_stat'] === 'string' ? t['tun_stat'] : (typeof t['proxyid'] !== 'undefined' ? 'up' : 'unknown'),
      }));

    const sessions = [...sslSessions, ...ipsecTunnels];
    res.json({ sessions, ssl_count: sslSessions.length, ipsec_count: ipsecTunnels.length, total: sessions.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] vpn error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

router.get('/api/fortigate/ha-status', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await fortigateRequest('/api/v2/monitor/system/ha-peer');
    if (isSuccessStatus(result.status)) {
      const peers = extractHaPeers(result.data);
      res.json({ ha: true, peers });
    } else if (result.status === 404) {
      res.json({ ha: false, peers: [] });
    } else if (result.status === 401 || result.status === 403) {
      const detail = getFortiErrorMessage(result.data, `HTTP ${result.status}`);
      res.status(result.status).json({ error: detail });
    } else {
      const detail = getFortiErrorMessage(result.data, `HTTP ${result.status}`);
      res.status(503).json({ error: detail });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] ha-status error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

router.get('/api/fortigate/wan-stats', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  const bytesToGb = (bytes: number | null | undefined): number | null =>
    bytes != null ? Math.round((bytes / 1073741824) * 100) / 100 : null;

  function buildLinkStats(iface: FortiMonitorInterface | undefined) {
    if (!iface) return null;
    const rx = iface.rx_bytes ?? null;
    const tx = iface.tx_bytes ?? null;
    const link = iface.link ?? null;
    return {
      rx_bytes: rx,
      tx_bytes: tx,
      rx_gb: bytesToGb(rx),
      tx_gb: bytesToGb(tx),
      link,
      wan_status: link === true ? 'up' : link === false ? 'down' : 'unknown',
    };
  }

  // Always attempt the direct interface monitor for the per-link wan1/wan2
  // breakdown — HA aggregate sensors don't expose a per-link split, so the
  // SD-WAN dual-WAN view (esp. WAN2/Starlink) depends on this path even when
  // HA data is present. Failures here are non-fatal: we fall back to HA below.
  let wan1Stats: ReturnType<typeof buildLinkStats> = null;
  let wan2Stats: ReturnType<typeof buildLinkStats> = null;
  let directOk = false;
  let directErrorResponse: { status: number; detail: string } | null = null;

  try {
    const result = await fortigateRequest('/api/v2/monitor/system/interface');
    if (isSuccessStatus(result.status)) {
      const monitorInterfaces = extractMonitorInterfaces(result.data);
      wan1Stats = buildLinkStats(monitorInterfaces['wan1'] ?? monitorInterfaces['WAN1']);
      wan2Stats = buildLinkStats(monitorInterfaces['wan2'] ?? monitorInterfaces['WAN2']);
      directOk = true;
    } else {
      const detail = getFortiErrorMessage(result.data, `HTTP ${result.status}`);
      directErrorResponse = {
        status: isHtmlResponse(result.data) ? 502 : (result.status === 401 || result.status === 403 ? result.status : 503),
        detail,
      };
    }
  } catch (err: unknown) {
    directErrorResponse = {
      status: 503,
      detail: err instanceof Error ? err.message : 'FortiGate unreachable',
    };
  }

  // PRIMARY (back-compat): HA WAN sensors drive the top-level aggregate
  // fields. We merge the direct per-link breakdown on top so WAN2 throughput
  // is surfaced in the common HA-enabled operating mode.
  const fromHa = haWanStats();
  if (fromHa) {
    res.json({
      ...fromHa,
      source: directOk ? 'home_assistant+fortigate_direct' : 'home_assistant',
      wan1: wan1Stats ?? {
        rx_bytes: fromHa.rx_bytes,
        tx_bytes: fromHa.tx_bytes,
        rx_gb: fromHa.rx_gb,
        tx_gb: fromHa.tx_gb,
        link: fromHa.link,
        wan_status: fromHa.wan_status,
        wan_speed: fromHa.wan_speed,
      },
      wan2: wan2Stats,
    });
    return;
  }

  // No HA data — require the direct path.
  if (!directOk) {
    const fallback = directErrorResponse ?? { status: 503, detail: 'FortiGate unreachable' };
    console.error('[FortiGate] wan-stats error:', fallback.detail);
    res.status(fallback.status).json({ error: fallback.detail });
    return;
  }

  // Top-level fields remain WAN1-scoped for backward compatibility with
  // existing consumers (SpectrumCard, health snapshot cron, etc.)
  const primary = wan1Stats ?? wan2Stats;
  const rxBytes = primary?.rx_bytes ?? null;
  const txBytes = primary?.tx_bytes ?? null;
  const link = primary?.link ?? null;

  res.json({
    rx_bytes: rxBytes,
    tx_bytes: txBytes,
    rx_gb: bytesToGb(rxBytes),
    tx_gb: bytesToGb(txBytes),
    link,
    wan_status: link === true ? 'up' : link === false ? 'down' : 'unknown',
    source: 'fortigate_direct',
    wan1: wan1Stats,
    wan2: wan2Stats,
  });
});

router.get('/api/fortigate/sdwan-health', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const health = await getSdwanHealth();
    res.json(health);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] sdwan-health error:', message);
    if (message.includes('authentication failed') || message.includes('HTTP 401') || message.includes('HTTP 403')) {
      res.status(401).json({ error: message });
      return;
    }
    if (message.includes('circuit') || message.includes('ECONNREFUSED') || message.includes('unreachable')) {
      res.status(503).json({ error: 'FortiGate unreachable', details: message });
      return;
    }
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

router.get('/api/fortigate/sdwan-health', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const health = await getSdwanHealth();
    res.json(health);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] sdwan-health error:', message);
    if (message.includes('authentication failed') || message.includes('HTTP 401') || message.includes('HTTP 403')) {
      res.status(401).json({ error: message });
      return;
    }
    if (message.includes('circuit') || message.includes('ECONNREFUSED') || message.includes('unreachable')) {
      res.status(503).json({ error: 'FortiGate unreachable', details: message });
      return;
    }
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

router.get('/api/fortigate/dns-dhcp', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  const dnsCandidates = [
    '/api/v2/log/disk/dns?rows=100&start=0',
    '/api/v2/log/memory/dns?rows=100&start=0',
    '/api/v2/log/disk/utm/dns?rows=100&start=0',
    '/api/v2/log/memory/utm/dns?rows=100&start=0',
  ];

  const webfilterCandidates = [
    '/api/v2/log/disk/utm/webfilter?rows=100&start=0',
    '/api/v2/log/memory/utm/webfilter?rows=100&start=0',
    '/api/v2/log/disk/webfilter?rows=100&start=0',
    '/api/v2/log/memory/webfilter?rows=100&start=0',
  ];

  function pickStr(e: Record<string, unknown>, ...keys: string[]): string | null {
    for (const k of keys) {
      if (typeof e[k] === 'string' && (e[k] as string).trim() !== '') return e[k] as string;
      if (typeof e[k] === 'number') return String(e[k]);
    }
    return null;
  }

  function resolveTs(e: Record<string, unknown>): string | null {
    for (const k of ['date', 'eventtime', 'itime', 'logtime', 'timestamp']) {
      const v = e[k];
      if (typeof v === 'string' && v.trim() !== '') return v;
      if (typeof v === 'number') return new Date(v * 1000).toISOString();
    }
    return null;
  }

  async function tryPaths(paths: string[]): Promise<{ entries: Record<string, unknown>[]; source: string } | null> {
    for (const path of paths) {
      try {
        const result = await fortigateRequest(path);
        if (!isSuccessStatus(result.status)) {
          console.warn(`[FortiGate] dns-dhcp path ${path} returned ${result.status}`);
          continue;
        }
        const data = result.data as Record<string, unknown>;
        const results = data['results'];
        const entries = Array.isArray(results)
          ? results.filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
          : [];
        if (entries.length === 0) {
          console.info(`[FortiGate] dns-dhcp path ${path} returned 0 entries, trying next`);
          continue;
        }
        console.info(`[FortiGate] dns-dhcp path ${path} success — ${entries.length} entries`);
        return { entries, source: path };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown';
        console.warn(`[FortiGate] dns-dhcp path ${path} threw: ${msg}`);
      }
    }
    return null;
  }

  try {
    const [dnsResult, webfilterResult, dhcpResult] = await Promise.allSettled([
      tryPaths(dnsCandidates),
      tryPaths(webfilterCandidates),
      fortigateRequest('/api/v2/monitor/system/dhcp?ipv6=false&interface=any'),
    ]);

    // --- DNS queries ---
    interface DnsEntry {
      domain: string;
      query_type: string | null;
      action: string;
      category: string | null;
      src_ip: string | null;
      timestamp: string | null;
    }
    const dnsQueries: DnsEntry[] = [];

    if (dnsResult.status === 'fulfilled' && dnsResult.value) {
      for (const e of dnsResult.value.entries) {
        dnsQueries.push({
          domain: pickStr(e, 'qname', 'domain', 'hostname', 'url', 'name') ?? 'Unknown',
          query_type: pickStr(e, 'qtype', 'query_type', 'type'),
          action: pickStr(e, 'action', 'status') ?? 'allowed',
          category: pickStr(e, 'catdesc', 'category', 'cat'),
          src_ip: pickStr(e, 'srcip', 'src_ip', 'src'),
          timestamp: resolveTs(e),
        });
      }
    }

    // --- Blocked domains (web filter) ---
    interface BlockedEntry {
      domain: string;
      category: string | null;
      action: string;
      src_ip: string | null;
      timestamp: string | null;
    }
    const blockedDomains: BlockedEntry[] = [];

    if (webfilterResult.status === 'fulfilled' && webfilterResult.value) {
      for (const e of webfilterResult.value.entries) {
        const action = pickStr(e, 'action', 'status') ?? '';
        if (!['blocked', 'block', 'deny', 'filtered', 'override_deny'].includes(action.toLowerCase())) continue;
        blockedDomains.push({
          domain: pickStr(e, 'hostname', 'url', 'domain', 'dstip') ?? 'Unknown',
          category: pickStr(e, 'catdesc', 'category', 'cat'),
          action,
          src_ip: pickStr(e, 'srcip', 'src_ip', 'src'),
          timestamp: resolveTs(e),
        });
      }
    }

    // Count blocked by domain
    const blockedMap = new Map<string, { domain: string; category: string | null; count: number; latest: string | null }>();
    for (const b of blockedDomains) {
      const existing = blockedMap.get(b.domain);
      if (existing) {
        existing.count++;
        if (b.timestamp && (!existing.latest || b.timestamp > existing.latest)) existing.latest = b.timestamp;
      } else {
        blockedMap.set(b.domain, { domain: b.domain, category: b.category, count: 1, latest: b.timestamp });
      }
    }
    const blockedSummary = Array.from(blockedMap.values()).sort((a, b) => b.count - a.count);

    // Top queried domains from DNS log
    const domainCountMap = new Map<string, number>();
    for (const q of dnsQueries) {
      domainCountMap.set(q.domain, (domainCountMap.get(q.domain) ?? 0) + 1);
    }
    const topDomains = Array.from(domainCountMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([domain, count]) => ({ domain, count }));

    // --- DHCP leases ---
    interface DhcpLease {
      hostname: string | null;
      ip: string | null;
      mac: string | null;
      interface: string | null;
      lease_start: string | null;
      lease_end: string | null;
      status: string | null;
    }
    const dhcpLeases: DhcpLease[] = [];

    if (dhcpResult.status === 'fulfilled' && isSuccessStatus(dhcpResult.value.status)) {
      const dhcpData = dhcpResult.value.data as Record<string, unknown>;
      const dhcpResults = dhcpData['results'];
      const entries: unknown[] = Array.isArray(dhcpResults) ? dhcpResults : [];
      for (const e of entries) {
        if (e === null || typeof e !== 'object') continue;
        const lease = e as Record<string, unknown>;
        // Results may be an array of pools each containing a 'lease' sub-array
        const leaseArr = Array.isArray(lease['lease']) ? lease['lease'] : null;
        if (leaseArr) {
          const iface = typeof lease['interface'] === 'string' ? lease['interface'] : null;
          for (const l of leaseArr) {
            if (l === null || typeof l !== 'object') continue;
            const li = l as Record<string, unknown>;
            const expireTs = typeof li['expire_time'] === 'number' ? new Date(li['expire_time'] * 1000).toISOString()
              : (typeof li['expire_time'] === 'string' ? li['expire_time'] : null);
            const startTs = typeof li['vci'] === 'string' ? null : null; // start not always available
            dhcpLeases.push({
              hostname: typeof li['hostname'] === 'string' ? li['hostname'] : null,
              ip: typeof li['ip'] === 'string' ? li['ip'] : null,
              mac: typeof li['mac'] === 'string' ? li['mac'] : null,
              interface: iface,
              lease_start: startTs,
              lease_end: expireTs,
              status: typeof li['status'] === 'string' ? li['status'] : 'active',
            });
          }
        } else {
          // Flat lease entry
          const expireTs = typeof lease['expire_time'] === 'number' ? new Date(lease['expire_time'] * 1000).toISOString()
            : (typeof lease['expire_time'] === 'string' ? lease['expire_time'] : null);
          dhcpLeases.push({
            hostname: typeof lease['hostname'] === 'string' ? lease['hostname'] : null,
            ip: typeof lease['ip'] === 'string' ? lease['ip'] : null,
            mac: typeof lease['mac'] === 'string' ? lease['mac'] : null,
            interface: typeof lease['interface'] === 'string' ? lease['interface'] : null,
            lease_start: null,
            lease_end: expireTs,
            status: typeof lease['status'] === 'string' ? lease['status'] : 'active',
          });
        }
      }
    } else if (dhcpResult.status === 'fulfilled' && !isSuccessStatus(dhcpResult.value.status)) {
      console.warn(`[FortiGate] DHCP monitor returned ${dhcpResult.value.status}`);
    }

    const totalBlocked = blockedSummary.reduce((sum, b) => sum + b.count, 0);

    res.json({
      dns_queries: dnsQueries.slice(0, 100),
      top_domains: topDomains,
      blocked_domains: blockedSummary,
      total_blocked: totalBlocked,
      dhcp_leases: dhcpLeases,
      dns_available: dnsResult.status === 'fulfilled' && dnsResult.value !== null,
      webfilter_available: webfilterResult.status === 'fulfilled' && webfilterResult.value !== null,
      dhcp_available: dhcpResult.status === 'fulfilled' && isSuccessStatus(dhcpResult.value.status),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] dns-dhcp error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

router.put('/api/fortigate/interfaces/:name/toggle', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const name = String(req.params.name);
  const body = req.body as Record<string, unknown>;
  const enable = body['enable'];

  if (typeof enable !== 'boolean') {
    res.status(400).json({ error: 'Missing required field: enable (boolean)' });
    return;
  }

  if (!name || !/^[\w.-]+$/.test(name)) {
    res.status(400).json({ error: 'Invalid interface name' });
    return;
  }

  try {
    const payload = JSON.stringify({ status: enable ? 'up' : 'down' });
    const encodedName = encodeURIComponent(name);
    const result = await fortigateRequest(
      `/api/v2/cmdb/system/interface/${encodedName}`,
      'PUT',
      payload,
    );

    if (isSuccessStatus(result.status)) {
      res.json({ success: true, name, enabled: enable });
    } else {
      const errMessage = getFortiErrorMessage(result.data, `FortiGate returned ${result.status}`);
      res.status(result.status).json({ error: errMessage });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] toggle error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

/**
 * WiFi Networks — groups FortiGate-observed devices by the SSID the
 * Ruckus controller actually saw them on.
 *
 * Background: the FortiGate is a flat L2 bridge (internal1-5 merged into
 * one hard-switch), so the firewall cannot distinguish SSIDs by
 * interface. The real source of truth is the Ruckus controller, which
 * reports each client's SSID directly. `getClients()` in
 * server/lib/ruckus.ts persists every (MAC → SSID) it sees into
 * network_devices.ssids (most recent first) on every wireless poll
 * (live admin views + the 5-min snapshot cron). This handler joins
 * those Ruckus observations onto the FortiGate device list by MAC.
 *
 * Resolution order per device:
 *   1. network_devices.ssids[0] — most recent SSID observed by Ruckus.
 *   2. resolveSubnetLabel(ip) — fallback for wired devices or cold-start
 *      cases where Ruckus has no observation yet.
 *   3. Unknown — bucketed as "Unknown" with a hint that Ruckus has not
 *      observed the device.
 */
router.get('/api/fortigate/wifi-networks', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const devRes = await fortigateRequest('/api/v2/monitor/user/device/query?with_forticlient=false');
    if (!isSuccessStatus(devRes.status)) {
      const detail = getFortiErrorMessage(devRes.data, `HTTP ${devRes.status}`);
      res.status(isHtmlResponse(devRes.data) ? 502 : (devRes.status === 401 || devRes.status === 403 ? devRes.status : 503))
        .json({ error: detail });
      return;
    }

    const data = devRes.data as Record<string, unknown>;
    const results = data['results'];
    const rawDevices: unknown[] = Array.isArray(results) ? results : [];

    // Pull every (mac → ssids/expected_ssid) the Ruckus ingest has
    // accumulated. Lower-case MAC keys to match normalizeMac() in
    // server/lib/network-devices.ts. A DB error here is non-fatal —
    // we just lose Ruckus enrichment and fall through to subnet.
    const ruckusByMac = new Map<string, RuckusObservation>();
    try {
      // Bound the lookup to recently-seen rows. The Ruckus snapshot cron
      // runs every 5 minutes and live admin views poll on demand, so a
      // 20-minute window covers ~4 sync cycles — enough to absorb one
      // missed cron tick without re-attributing a stale SSID to a device
      // that has since gone wired or disconnected. Anything older falls
      // through to subnet/Unknown so the operator sees the truth.
      const { rows } = await dbQuery(
        `SELECT mac_address, ssids, expected_ssid, last_seen
           FROM network_devices
          WHERE ssids IS NOT NULL
            AND jsonb_array_length(ssids) > 0
            AND last_seen >= NOW() - INTERVAL '20 minutes'`,
      );
      for (const r of rows as Array<Record<string, unknown>>) {
        const mac = typeof r.mac_address === 'string' ? normalizeMac(r.mac_address) : '';
        if (!mac) continue;
        const ssids = Array.isArray(r.ssids) ? (r.ssids as string[]) : [];
        ruckusByMac.set(mac, {
          ssids,
          expected_ssid: r.expected_ssid == null ? null : String(r.expected_ssid),
          last_seen: r.last_seen instanceof Date ? r.last_seen.toISOString() : (r.last_seen == null ? null : String(r.last_seen)),
        });
      }
    } catch (e) {
      console.warn('[FortiGate] wifi-networks: network_devices lookup failed:', e instanceof Error ? e.message : e);
    }

    const nowSec = Date.now() / 1000;
    const ACTIVE_THRESHOLD = 300;

    const devices = rawDevices
      .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object')
      .map(d => {
        const hw_vendor = typeof d['vendor'] === 'string' ? d['vendor'] : (typeof d['hardware_vendor'] === 'string' ? d['hardware_vendor'] : null);
        const dev_type = typeof d['dev_type'] === 'string' ? d['dev_type'] : (typeof d['device_type'] === 'string' ? d['device_type'] : null);
        const os_t = typeof d['os'] === 'string' ? d['os'] : (typeof d['os_type'] === 'string' ? d['os_type'] : null);
        const host = typeof d['hostname'] === 'string' ? d['hostname'] : (typeof d['name'] === 'string' ? d['name'] : null);
        const mac = typeof d['mac'] === 'string' ? d['mac'] : null;
        const iface = typeof d['interface'] === 'string' ? d['interface'] : null;
        const classification = classifyDevice(hw_vendor, dev_type, os_t, host, mac);
        const last_seen = typeof d['last_seen'] === 'number' ? d['last_seen'] : null;
        const ip = extractIpAddress(d);

        // Resolve in precedence order: fresh Ruckus observation by MAC
        // (authoritative) → subnet fallback (10.0.22.0/23 only) →
        // Unknown. Both sides of the MAC key must go through
        // normalizeMac() so FortiGate's hyphen-separated MACs match the
        // colon-separated ingest rows.
        const normalized = mac ? normalizeMac(mac) : null;
        const { label: wifi_label, source: wifi_source, ruckus } =
          resolveWifiSource(normalized, ip, ruckusByMac);

        const advice = adviseWrongNetwork(
          {
            hostname: host,
            device_type: dev_type,
            os_type: os_t,
            hardware_vendor: hw_vendor,
            category: classification.category,
            subcategory: classification.subcategory,
          },
          wifi_label,
        );

        return {
          hostname: host,
          ip,
          mac,
          interface: iface,
          last_seen,
          os_type: os_t,
          hardware_vendor: hw_vendor,
          device_type: dev_type,
          tx_bytes: toNumber(d['tx_bytes']) ?? null,
          rx_bytes: toNumber(d['rx_bytes']) ?? null,
          category: classification.category,
          subcategory: classification.subcategory,
          vendor: classification.vendor,
          active: last_seen !== null && (nowSec - last_seen) < ACTIVE_THRESHOLD,
          wifi_label,
          wifi_source,
          // Operator override stored on network_devices — takes precedence
          // over the keyword-based classifier hint when set.
          expected_wifi: ruckus?.expected_ssid ?? advice.expected,
          wifi_status: advice.status,
          wifi_advice: advice.reason,
        };
      });

    type MappedDevice = typeof devices[number];

    const networkGroups = new Map<string, MappedDevice[]>();
    const UNKNOWN_GROUP = '__unknown__';

    for (const device of devices) {
      const networkName: string = device.wifi_label ?? UNKNOWN_GROUP;
      if (!networkGroups.has(networkName)) networkGroups.set(networkName, []);
      networkGroups.get(networkName)!.push(device);
    }

    const networks = Array.from(networkGroups.entries()).map(([name, devs]) => {
      // Group source = 'ruckus' if any member came from Ruckus, otherwise
      // 'subnet'. For the unknown bucket, leave source null.
      const fromRuckus = devs.some(d => d.wifi_source === 'ruckus');
      const fromSubnet = devs.some(d => d.wifi_source === 'subnet');
      const source: 'ruckus' | 'subnet' | null =
        name === UNKNOWN_GROUP ? null : (fromRuckus ? 'ruckus' : (fromSubnet ? 'subnet' : null));
      return {
        name,
        label: name === UNKNOWN_GROUP ? 'Unknown (not seen by Ruckus)' : name,
        source,
        total: devs.length,
        active: devs.filter(d => d.active).length,
        devices: devs,
      };
    });

    networks.sort((a, b) => {
      if (a.name === UNKNOWN_GROUP) return 1;
      if (b.name === UNKNOWN_GROUP) return -1;
      return b.total - a.total;
    });

    // Stats so the UI can show "join coverage" — how many devices got a
    // real SSID vs. fell through to subnet vs. ended up Unknown.
    const stats = {
      total: devices.length,
      from_ruckus: devices.filter(d => d.wifi_source === 'ruckus').length,
      from_subnet: devices.filter(d => d.wifi_source === 'subnet').length,
      unknown: devices.filter(d => d.wifi_source === null).length,
      ruckus_observations: ruckusByMac.size,
    };

    res.json({
      networks,
      stats,
      subnet_defaults: DEFAULT_SUBNET_MAP,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[FortiGate] wifi-networks error:', message);
    res.status(503).json({ error: 'FortiGate unreachable', details: message });
  }
});

// --- Direct-tunnel typed endpoints --------------------------------------
//
// These thin wrappers expose the new server/lib/fortigate.ts getters
// over HTTP. They live alongside the older shape-specific endpoints
// (system-health, dns-dhcp, etc.) that AdminNetworkContent.tsx still
// relies on; that surface is preserved so the UI keeps working through
// this transition.

function handleLibError(res: Response, err: unknown, label: string): void {
  if (err instanceof CircuitOpenError) {
    console.warn(`[FortiGate] ${label}: breaker open (retry at ${new Date(err.retryAt).toISOString()})`);
    res.status(503).json({
      error: 'fortigate circuit breaker open',
      service: 'fortigate',
      retry_at: new Date(err.retryAt).toISOString(),
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[FortiGate] ${label} failed:`, message);
  res.status(502).json({ error: message, source: 'fortigate' });
}

function requireConfigured(res: Response): boolean {
  if (isFortigateConfigured()) return true;
  res.status(503).json({
    error: 'FortiGate not configured',
    hint: 'Set FORTIGATE_API_TOKEN in Replit Secrets. FORTIGATE_BASE_URL defaults to https://fortigate.example.com.',
    baseUrl: FORTIGATE_BASE_URL,
  });
  return false;
}

router.get('/api/fortigate/status', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const { getSystemStatus } = await import('../lib/fortigate.js');
    const data = await getSystemStatus();
    res.json(data);
  } catch (err) {
    handleLibError(res, err, 'status');
  }
});

// Reports whether the HA FortiView sensors that back the Traffic (top talkers)
// and Top Sites panels are configured. Drives the in-app setup callouts that
// point the operator at docs/fortigate-ha-traffic.yaml. Does not require the
// direct FortiGate tunnel — it reads only the HA entity cache.
router.get('/api/fortigate/fortiview-status', requireAuth, requireAdmin, (_req: AuthenticatedRequest, res: Response) => {
  res.json(haFortiViewSensorsPresent());
});

router.get('/api/fortigate/resources', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const { getResourceUsage } = await import('../lib/fortigate.js');
    const data = await getResourceUsage();
    res.json(data);
  } catch (err) {
    handleLibError(res, err, 'resources');
  }
});

router.get('/api/fortigate/sessions', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const limit = parseInt(String(req.query['limit'] ?? '50'), 10) || 50;
    const { getActiveSessions } = await import('../lib/fortigate.js');
    const sessions = await getActiveSessions(limit);
    res.json({ sessions, count: sessions.length });
  } catch (err) {
    handleLibError(res, err, 'sessions');
  }
});

router.get('/api/fortigate/arp', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const { getArpTable } = await import('../lib/fortigate.js');
    const arp = await getArpTable();
    res.json({ arp, count: arp.length });
  } catch (err) {
    handleLibError(res, err, 'arp');
  }
});

router.get('/api/fortigate/dhcp', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const { getDhcpLeases } = await import('../lib/fortigate.js');
    const leases = await getDhcpLeases();
    res.json({ leases, count: leases.length });
  } catch (err) {
    handleLibError(res, err, 'dhcp');
  }
});

router.get('/api/fortigate/web-filter', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const limit = parseInt(String(req.query['limit'] ?? '100'), 10) || 100;
    const hours = parseInt(String(req.query['hours'] ?? '24'), 10) || 24;
    const { getRecentWebFilterBlocks } = await import('../lib/fortigate.js');
    const blocks = await getRecentWebFilterBlocks(limit, hours);
    res.json({ blocks, count: blocks.length });
  } catch (err) {
    handleLibError(res, err, 'web-filter');
  }
});

router.get('/api/fortigate/policies', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const { getPolicyStats } = await import('../lib/fortigate.js');
    const policies = await getPolicyStats();
    res.json({ policies, count: policies.length });
  } catch (err) {
    handleLibError(res, err, 'policies');
  }
});

router.get('/api/fortigate/top-bandwidth', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const hours = parseInt(String(req.query['hours'] ?? '1'), 10) || 1;
    const limit = parseInt(String(req.query['limit'] ?? '10'), 10) || 10;
    const { getTopBandwidthConsumers } = await import('../lib/fortigate.js');
    const consumers = await getTopBandwidthConsumers(hours, limit);
    res.json({ consumers, count: consumers.length });
  } catch (err) {
    handleLibError(res, err, 'top-bandwidth');
  }
});

router.get('/api/fortigate/summary', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const summary = await getSummary();
    res.json(summary);
  } catch (err) {
    handleLibError(res, err, 'summary');
  }
});

// CPU / memory / sessions 24h time-series for the Network Command
// Center Health Trends panes. The old panes were reading from the
// local network_health_snapshots table populated by a periodic
// /api/fortigate-health-snapshot capture cron — that capture path
// went stale during the HA-proxy era, so the table is sparse or
// empty in dev and the chart bodies render blank. This endpoint
// goes straight to the FortiGate's native time series so the panes
// have data on every page load, regardless of the snapshot cron.
//
// Default interval is "1-hour" which covers ~19 hours at 20 points
// (the historical buckets are fixed-length per FortiOS) and gives a
// readable curve. Pass ?interval=24-hour for the lowest-resolution
// full-day series, or any of: 1-min, 10-min, 30-min, 1-hour,
// 12-hour, 24-hour.
router.get('/api/fortigate/health-trends', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const interval = typeof req.query['interval'] === 'string' ? (req.query['interval'] as string) : '1-hour';
    const { getResourceTrends } = await import('../lib/fortigate.js');
    const trends = await getResourceTrends(interval);
    res.json(trends);
  } catch (err) {
    handleLibError(res, err, 'health-trends');
  }
});

// Web-filter blocked-domain log for the Network Command Center
// Security panel. Backed by /api/v2/log/memory/webfilter, filtered
// to action ∈ {blocked, block, deny} — passthrough (allowed) traffic
// is dropped. Returns { events, blocked_count } where each event has
// timestamp, domain, src_ip, action, category.
router.get('/api/fortigate/dns-blocks', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  if (!requireConfigured(res)) return;
  try {
    const limit = parseInt(String(req.query['limit'] ?? '100'), 10) || 100;
    const { getWebFilterBlocks } = await import('../lib/fortigate.js');
    const blocks = await getWebFilterBlocks(limit);
    const events = blocks.map((b) => {
      const raw = b.raw as Record<string, unknown>;
      return {
        timestamp: b.timestamp ?? null,
        action: b.action ?? null,
        src_ip: b.src_ip ?? null,
        domain: typeof raw['hostname'] === 'string' ? raw['hostname'] : (typeof raw['url'] === 'string' ? raw['url'] : (b.signature ?? null)),
        category: typeof raw['catdesc'] === 'string' ? raw['catdesc'] : (typeof raw['category'] === 'string' ? raw['category'] : null),
        dst_ip: b.dst_ip ?? null,
        msg: b.msg ?? null,
      };
    });
    res.json({ events, blocked_count: events.length });
  } catch (err) {
    handleLibError(res, err, 'dns-blocks');
  }
});

export default router;
