/**
 * FortiGate REST API client — direct over Cloudflare Tunnel.
 *
 * Background: this module used to route every call through HA's
 * rest_command.fortigate_proxy because the firewall's REST API was
 * LAN-only. With the new Cloudflare Tunnel at `fortigate.example.com`,
 * the backend can talk to the FortiOS API directly — vastly richer
 * data (live sessions with src MACs, ARP table, DHCP leases, IPS log,
 * web-filter log, policy hit counters, CPU/mem history) and one less
 * moving part.
 *
 * Live-verified against FortiGate-60F running FortiOS v7.2.13 build
 * 1762 (serial FGT60FTK2309AWBR). See
 * /home/user/workspace/fortigate_api_notes.md for the full inventory
 * of endpoints.
 *
 * Auth: static Bearer token. There is no refresh flow — a 401 means
 * the token is bad, full stop. We do not retry on 401 (unlike Ruckus,
 * which has a session cookie that can expire mid-call).
 */

import { breakers, CircuitOpenError } from "./breakers.js";
import { recordObservedDevice } from "./network-devices.js";

const FORTIGATE_BASE_URL = process.env.FORTIGATE_BASE_URL || "https://fortigate.example.com";
const FORTIGATE_API_TOKEN = process.env.FORTIGATE_API_TOKEN || "";

const REQUEST_TIMEOUT_MS = 20_000;

// --- HTTP helper ---------------------------------------------------------

async function fetchT(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Low-level FortiGate REST call. Returns the parsed JSON body. Throws
 * on non-2xx, on auth failure, or on a non-JSON response (which usually
 * means the token was rejected and the firewall served the HTML login
 * page instead). Every call is gated by the fortigate circuit breaker.
 */
export async function fortigateGet(path: string): Promise<Record<string, unknown>> {
  return fortigateRequest(path, "GET");
}

export async function fortigateRequest(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: string,
): Promise<Record<string, unknown>> {
  if (!FORTIGATE_API_TOKEN) {
    throw new Error("FORTIGATE_API_TOKEN secret is not configured");
  }
  return breakers.fortigate.execute(async () => {
    const url = `${FORTIGATE_BASE_URL}${path}`;
    const res = await fetchT(url, {
      method,
      headers: {
        Authorization: `Bearer ${FORTIGATE_API_TOKEN}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `FortiGate authentication failed (HTTP ${res.status}) — check FORTIGATE_API_TOKEN`,
      );
    }
    if (res.status >= 400) {
      throw new Error(`FortiGate ${method} ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    // FortiOS occasionally serves the HTML login page when a token is
    // valid syntactically but lacks permissions — detect and surface it.
    const trimmed = text.trimStart();
    if (trimmed.startsWith("<")) {
      throw new Error("FortiGate returned HTML instead of JSON — token may lack permissions");
    }
    if (!trimmed) return {};
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`Failed to parse FortiGate JSON: ${(err as Error).message}`);
    }
  });
}

/**
 * Keep-alive ping for the Cloudflare Tunnel between this backend and the
 * firewall. Same cold-tunnel problem as the Ruckus controller: the tunnel
 * drops its origin TCP/TLS session after a short idle, so the first real
 * FortiGate poll after a quiet period eats a multi-second cold start (and
 * can fail outright, tripping the circuit breaker). A cheap unauthenticated
 * GET on a tight cadence keeps the socket hot so every real poll stays
 * sub-second.
 *
 * Failures are swallowed on purpose: this is best-effort warming, not a
 * health check. We never log an error or write an audit row — a missed
 * ping just means the next one warms the tunnel instead. It also bypasses
 * the circuit breaker deliberately: a warming ping must never trip (or be
 * blocked by) the breaker that guards real API calls.
 */
export async function pingTunnel(): Promise<void> {
  try {
    // No Authorization header — we only need Cloudflare to establish the
    // origin TCP/TLS session. FortiOS will answer with its login page or
    // a 401; either way the tunnel is warm.
    const res = await fetchT(`${FORTIGATE_BASE_URL}/`, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "text/html" },
    }, 8_000);
    // Drain the body so the connection can be reused from the pool.
    await res.text().catch(() => undefined);
  } catch {
    // Silent by design — see doc comment above.
  }
}

// --- Utilities -----------------------------------------------------------

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function s(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  return String(v);
}

function n(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const num = typeof v === "number" ? v : Number(v);
  return Number.isFinite(num) ? num : undefined;
}

function unwrapResults(payload: Record<string, unknown>): unknown {
  return payload["results"];
}

// --- Types ---------------------------------------------------------------

export interface FortigateSystemStatus {
  model?: string;
  model_number?: string;
  hostname?: string;
  serial?: string;
  version?: string;
  build?: number;
  vdom?: string;
  raw: Record<string, unknown>;
}

export interface FortigateResourceUsage {
  cpu_current?: number;
  cpu_1min_avg?: number;
  cpu_10min_avg?: number;
  cpu_1hour_avg?: number;
  mem_current?: number;
  mem_1min_avg?: number;
  session_count?: number;
  history: {
    cpu_1min: number[];
    cpu_1hour: number[];
    mem_1min: number[];
  };
  raw: Record<string, unknown>;
}

export interface FortigateInterface {
  name: string;
  alias?: string;
  link: boolean;
  speed_mbps?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  rx_packets?: number;
  tx_packets?: number;
  role?: string;
  raw: Record<string, unknown>;
}

export interface FortigateSession {
  proto?: string;
  src_intf?: string;
  src_ip?: string;
  src_port?: number;
  src_mac?: string;
  dst_intf?: string;
  dst_ip?: string;
  dst_port?: number;
  country?: string;
  policy_id?: number;
  duration?: number;
  snaddr?: string;
  raw: Record<string, unknown>;
}

export interface FortigateArpEntry {
  mac?: string;
  ip?: string;
  interface?: string;
  age?: number;
  raw: Record<string, unknown>;
}

export interface FortigateDhcpLease {
  mac?: string;
  ip?: string;
  hostname?: string;
  interface?: string;
  expires_at?: number;
  status?: string;
  raw: Record<string, unknown>;
}

export interface FortigateLogEntry {
  timestamp?: string;
  severity?: string;
  action?: string;
  src_ip?: string;
  dst_ip?: string;
  signature?: string;
  attack_id?: string;
  msg?: string;
  raw: Record<string, unknown>;
}

export interface FortigatePolicyStat {
  policy_id?: number;
  name?: string;
  hits?: number;
  bytes_in?: number;
  bytes_out?: number;
  raw: Record<string, unknown>;
}

export interface FortigateBandwidthConsumer {
  src_ip: string;
  src_mac?: string;
  bytes: number;
  session_count: number;
}

// --- Public API ----------------------------------------------------------

export async function getSystemStatus(): Promise<FortigateSystemStatus> {
  const parsed = await fortigateGet("/api/v2/monitor/system/status");
  const results = obj(unwrapResults(parsed));
  // The status payload also carries top-level fields like `version` /
  // `build` / `serial` outside of results. Merge both.
  const merged: Record<string, unknown> = { ...parsed, ...results };
  return {
    model: s(merged["model"]),
    model_number: s(merged["model_number"]),
    hostname: s(merged["hostname"]),
    serial: s(merged["serial"]),
    version: s(merged["version"]),
    build: n(merged["build"]),
    vdom: s(merged["vdom"]),
    raw: merged,
  };
}

function firstAvg(history: unknown): number | undefined {
  // FortiOS returns history arrays of { current, average, ... } samples
  // — the first element is the most recent. Some firmwares return raw
  // numbers; handle both.
  if (!Array.isArray(history) || history.length === 0) return undefined;
  const first = history[0];
  if (typeof first === "number") return first;
  return n(obj(first)["current"]) ?? n(obj(first)["average"]);
}

function flattenSamples(history: unknown): number[] {
  if (!Array.isArray(history)) return [];
  const out: number[] = [];
  for (const item of history) {
    if (typeof item === "number" && Number.isFinite(item)) {
      out.push(item);
      continue;
    }
    const v = n(obj(item)["current"]) ?? n(obj(item)["average"]);
    if (v != null) out.push(v);
  }
  return out;
}

export async function getResourceUsage(): Promise<FortigateResourceUsage> {
  const parsed = await fortigateGet("/api/v2/monitor/system/resource/usage?scope=global");
  const results = obj(unwrapResults(parsed));
  const cpu1min = results["cpu"];
  const cpu10min = results["cpu10"] ?? results["cpu_10min"];
  const cpu1hr = results["cpu60"] ?? results["cpu_1hour"];
  const mem1min = results["mem"];
  const sessions = results["session"] ?? results["sessions"];
  return {
    cpu_current: firstAvg(cpu1min),
    cpu_1min_avg: firstAvg(cpu1min),
    cpu_10min_avg: firstAvg(cpu10min),
    cpu_1hour_avg: firstAvg(cpu1hr),
    mem_current: firstAvg(mem1min),
    mem_1min_avg: firstAvg(mem1min),
    session_count: firstAvg(sessions),
    history: {
      cpu_1min: flattenSamples(cpu1min),
      cpu_1hour: flattenSamples(cpu1hr),
      mem_1min: flattenSamples(mem1min),
    },
    raw: results,
  };
}

/**
 * Live-verified 2026-05-14 against FortiOS 7.2.13 build 1762:
 *   GET /api/v2/monitor/system/resource/usage?interval=1day
 * returns a 169 KB body with results.{cpu,mem,session}[0].historical
 * keyed by interval ("1-min" / "10-min" / "30-min" / "1-hour"
 * / "12-hour" / "24-hour"). Each interval carries 20 [ts_ms, value]
 * tuples in newest-first order. The "1-min" series covers the last
 * minute; "1-hour" covers the last hour. The widest series (and the
 * one we want for the 24h trend pane) is "24-hour" — but that's only
 * 20 points, so we prefer "1-hour" which covers a 19-hour span at
 * 20 points and looks more like a curve.
 */
export interface FortigateTrendPoint {
  t: number; // unix ms
  v: number;
}
export interface FortigateResourceTrends {
  cpu: FortigateTrendPoint[];
  memory: FortigateTrendPoint[];
  sessions: FortigateTrendPoint[];
  interval: string;
  snapshot_count: number;
}

function extractTrendSeries(
  resources: Record<string, unknown>,
  metricKey: string,
  interval: string,
): FortigateTrendPoint[] {
  const metricArr = resources[metricKey];
  if (!Array.isArray(metricArr) || metricArr.length === 0) return [];
  const metric = obj(metricArr[0]);
  const historical = obj(metric["historical"]);
  const bucket = obj(historical[interval]);
  const values = bucket["values"];
  if (!Array.isArray(values)) return [];
  // Reverse to oldest-first so the chart renders left-to-right.
  return values
    .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([t, v]) => ({ t: Number(t), v: Number(v) }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Get CPU / memory / sessions time series at the requested interval.
 * Pass "1-hour" (default) for a curve that fits the 24h trend panes;
 * "24-hour" for a full-day low-resolution series.
 */
export async function getResourceTrends(interval: string = "1-hour"): Promise<FortigateResourceTrends> {
  const parsed = await fortigateGet("/api/v2/monitor/system/resource/usage?interval=1day");
  const results = obj(unwrapResults(parsed));
  const cpu = extractTrendSeries(results, "cpu", interval);
  const memory = extractTrendSeries(results, "mem", interval);
  const sessions = extractTrendSeries(results, "session", interval);
  const snapshot_count = Math.max(cpu.length, memory.length, sessions.length);
  return { cpu, memory, sessions, interval, snapshot_count };
}

/**
 * IPS threat events from the in-memory log. Returns ONLY rows from
 * the actual log endpoint — never falls back to /monitor/ips/anomaly
 * (the signature registry: tcp_syn_flood, tcp_port_scan, etc.), which
 * is what the previous candidate-path loop was accidentally returning
 * as "threats" when the real log was empty.
 *
 * Live-verified against FortiOS 7.2.13:
 *   GET /api/v2/log/memory/ips?rows=100
 * On a clean firewall this returns results=[]. When IPS fires, each
 * row has: { date, time, eventtime (ns), severity, action, srcip,
 * srccountry, dstip, dstcountry, attackname, attackid, msg, ... }.
 */
export async function getIpsThreats(limit = 100): Promise<FortigateLogEntry[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const parsed = await fortigateGet(`/api/v2/log/memory/ips?rows=${safeLimit}`);
  const results = unwrapResults(parsed);
  if (!Array.isArray(results)) return [];
  return results
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map(mapLogEntryRich);
}

/**
 * Web-filter blocks from the in-memory log. Filters to action ∈
 * { blocked, block, deny } so we don't surface passthrough (allowed)
 * traffic as a block. Live-verified 2026-05-14: on a clean firewall
 * the memory log returns ~100 rows mostly `passthrough` with a few
 * `blocked` entries (`logid=0315012547`, eventtype=urlfilter).
 */
export async function getWebFilterBlocks(limit = 100): Promise<FortigateLogEntry[]> {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const parsed = await fortigateGet(`/api/v2/log/memory/webfilter?rows=${safeLimit}`);
  const results = unwrapResults(parsed);
  if (!Array.isArray(results)) return [];
  return results
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .filter((x) => {
      const a = (s(x["action"]) ?? "").toLowerCase();
      return a === "blocked" || a === "block" || a === "deny";
    })
    .map(mapLogEntryRich);
}

// Richer parser than mapLogEntry (defined later) — keeps src/dst
// country + msg + attack id + numeric event timestamp.
function mapLogEntryRich(entry: Record<string, unknown>): FortigateLogEntry {
  const tsRaw = entry["eventtime"] ?? entry["itime"] ?? entry["logtime"] ?? null;
  let timestamp: string | undefined;
  if (typeof tsRaw === "string" && tsRaw.trim()) timestamp = tsRaw;
  else if (typeof tsRaw === "number") {
    // FortiOS 7.2 eventtime is nanoseconds; older firmware uses
    // seconds. Normalise to ISO.
    const ms = tsRaw > 1e15 ? Math.floor(tsRaw / 1e6) : tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
    timestamp = new Date(ms).toISOString();
  } else {
    // Compose ISO from date + time fields if eventtime is absent.
    const date = s(entry["date"]);
    const time = s(entry["time"]);
    const tz = s(entry["tz"]);
    if (date && time) {
      const iso = tz ? `${date}T${time}${tz.startsWith("-") || tz.startsWith("+") ? tz : "+00:00"}` : `${date}T${time}Z`;
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) timestamp = d.toISOString();
    }
  }
  return {
    timestamp,
    severity: s(entry["severity"]) ?? s(entry["level"]) ?? s(entry["crlevel"]),
    action: s(entry["action"]) ?? s(entry["utmaction"]),
    src_ip: s(entry["srcip"]) ?? s(entry["src"]),
    dst_ip: s(entry["dstip"]) ?? s(entry["dst"]),
    signature: s(entry["attackname"]) ?? s(entry["hostname"]) ?? s(entry["msg"]),
    attack_id: s(entry["attackid"]) ?? s(entry["attack_id"]),
    msg: s(entry["msg"]) ?? s(entry["logdesc"]),
    raw: entry,
  };
}

function deriveRole(iface: Record<string, unknown>): string | undefined {
  const explicit = s(iface["role"]);
  if (explicit) return explicit;
  const name = (s(iface["name"]) ?? "").toLowerCase();
  if (name.startsWith("wan")) return "wan";
  if (name.startsWith("lan") || name.startsWith("internal")) return "internal";
  if (name.startsWith("dmz")) return "dmz";
  return undefined;
}

export async function getInterfaces(): Promise<FortigateInterface[]> {
  const parsed = await fortigateGet("/api/v2/monitor/system/interface/select");
  const results = unwrapResults(parsed);
  // Results may be array-shaped or keyed-object-shaped depending on
  // firmware.
  const items: Record<string, unknown>[] = [];
  if (Array.isArray(results)) {
    for (const r of results) if (r && typeof r === "object") items.push(r as Record<string, unknown>);
  } else if (results && typeof results === "object") {
    for (const [name, value] of Object.entries(results as Record<string, unknown>)) {
      if (value && typeof value === "object") items.push({ name, ...(value as Record<string, unknown>) });
    }
  }
  return items.map((iface): FortigateInterface => ({
    name: s(iface["name"]) ?? "",
    alias: s(iface["alias"]),
    link: iface["link"] === true || iface["link"] === "up",
    speed_mbps: n(iface["speed"]),
    rx_bytes: n(iface["rx_bytes"]),
    tx_bytes: n(iface["tx_bytes"]),
    rx_packets: n(iface["rx_packets"]),
    tx_packets: n(iface["tx_packets"]),
    role: deriveRole(iface),
    raw: iface,
  }));
}

export async function getActiveSessions(limit = 50): Promise<FortigateSession[]> {
  const safeLimit = Math.max(1, Math.min(2000, Math.floor(limit)));
  const parsed = await fortigateGet(`/api/v2/monitor/firewall/session?count=${safeLimit}`);
  const sessions: FortigateSession[] = arr(unwrapResults(parsed))
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map((sess): FortigateSession => ({
      proto: s(sess["proto"]) ?? s(sess["protocol"]),
      src_intf: s(sess["src_intf"]) ?? s(sess["srcintf"]),
      src_ip: s(sess["src"]) ?? s(sess["srcip"]),
      src_port: n(sess["sport"]) ?? n(sess["src_port"]),
      src_mac: s(sess["srcmac"]) ?? s(sess["src_mac"]),
      dst_intf: s(sess["dst_intf"]) ?? s(sess["dstintf"]),
      dst_ip: s(sess["dst"]) ?? s(sess["dstip"]),
      dst_port: n(sess["dport"]) ?? n(sess["dst_port"]),
      country: s(sess["country"]) ?? s(sess["dstcountry"]),
      policy_id: n(sess["policy_id"]) ?? n(sess["policyid"]),
      duration: n(sess["duration"]),
      snaddr: s(sess["snaddr"]) ?? s(sess["nat_src"]),
      raw: sess,
    }));
  // Fire-and-forget ingestion into the person↔device inventory. Sessions
  // carry MAC + src IP, so we get both keys we need to track a device.
  for (const sess of sessions) {
    if (sess.src_mac) {
      recordObservedDevice({ mac: sess.src_mac, ip: sess.src_ip ?? null });
    }
  }
  return sessions;
}

export async function getArpTable(): Promise<FortigateArpEntry[]> {
  const parsed = await fortigateGet("/api/v2/monitor/network/arp");
  const entries: FortigateArpEntry[] = arr(unwrapResults(parsed))
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map((entry): FortigateArpEntry => ({
      mac: s(entry["mac"]),
      ip: s(entry["ip"]),
      interface: s(entry["interface"]),
      age: n(entry["age"]),
      raw: entry,
    }));
  for (const e of entries) {
    if (e.mac) recordObservedDevice({ mac: e.mac, ip: e.ip ?? null });
  }
  return entries;
}

export async function getDhcpLeases(): Promise<FortigateDhcpLease[]> {
  const parsed = await fortigateGet("/api/v2/monitor/system/dhcp?ipv6=false&interface=any");
  // The DHCP endpoint can return either a flat array of leases or an
  // array of pools each carrying a `lease` sub-array. Handle both.
  const out: FortigateDhcpLease[] = [];
  for (const entry of arr(unwrapResults(parsed))) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const sublease = Array.isArray(e["lease"]) ? (e["lease"] as unknown[]) : null;
    if (sublease) {
      const iface = s(e["interface"]);
      for (const l of sublease) {
        if (!l || typeof l !== "object") continue;
        const li = l as Record<string, unknown>;
        out.push({
          mac: s(li["mac"]),
          ip: s(li["ip"]),
          hostname: s(li["hostname"]),
          interface: iface,
          expires_at: n(li["expire_time"]),
          status: s(li["status"]) ?? "active",
          raw: li,
        });
      }
    } else {
      out.push({
        mac: s(e["mac"]),
        ip: s(e["ip"]),
        hostname: s(e["hostname"]),
        interface: s(e["interface"]),
        expires_at: n(e["expire_time"]),
        status: s(e["status"]) ?? "active",
        raw: e,
      });
    }
  }
  // DHCP leases carry the richest signal — MAC + IP + hostname all
  // together. Most reliable feed for the person↔device inventory.
  for (const lease of out) {
    if (lease.mac) {
      recordObservedDevice({
        mac: lease.mac,
        ip: lease.ip ?? null,
        hostname: lease.hostname ?? null,
      });
    }
  }
  return out;
}

function mapLogEntry(entry: Record<string, unknown>): FortigateLogEntry {
  const tsRaw = entry["eventtime"] ?? entry["itime"] ?? entry["logtime"] ?? entry["date"] ?? entry["time"];
  let timestamp: string | undefined;
  if (typeof tsRaw === "string" && tsRaw.trim()) timestamp = tsRaw;
  else if (typeof tsRaw === "number") {
    // FortiOS eventtime is nanoseconds since epoch on newer firmware,
    // seconds on older. Normalise to ISO.
    const ms = tsRaw > 1e15 ? tsRaw / 1e6 : tsRaw > 1e12 ? tsRaw / 1e3 : tsRaw * 1000;
    timestamp = new Date(ms).toISOString();
  }
  return {
    timestamp,
    severity: s(entry["severity"]) ?? s(entry["level"]) ?? s(entry["crlevel"]),
    action: s(entry["action"]) ?? s(entry["utmaction"]),
    src_ip: s(entry["srcip"]) ?? s(entry["src"]),
    dst_ip: s(entry["dstip"]) ?? s(entry["dst"]),
    signature: s(entry["attackname"]) ?? s(entry["signature"]) ?? s(entry["msg"]),
    attack_id: s(entry["attackid"]) ?? s(entry["attack_id"]),
    msg: s(entry["msg"]) ?? s(entry["logdesc"]),
    raw: entry,
  };
}

async function fetchHistoricLog(logtype: "ips" | "webfilter", limit: number, hours: number): Promise<FortigateLogEntry[]> {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  void hours; // FortiOS doesn't filter by hours on this endpoint; UI does it client-side
  const parsed = await fortigateGet(`/api/v2/monitor/log/historic/list?logtype=${logtype}&count=${safeLimit}`);
  return arr(unwrapResults(parsed))
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map(mapLogEntry);
}

export async function getRecentThreats(limit = 100, hours = 24): Promise<FortigateLogEntry[]> {
  return fetchHistoricLog("ips", limit, hours);
}

export async function getRecentWebFilterBlocks(limit = 100, hours = 24): Promise<FortigateLogEntry[]> {
  return fetchHistoricLog("webfilter", limit, hours);
}

export async function getPolicyStats(): Promise<FortigatePolicyStat[]> {
  const parsed = await fortigateGet("/api/v2/monitor/firewall/policy?summary=true");
  return arr(unwrapResults(parsed))
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === "object")
    .map((p): FortigatePolicyStat => ({
      policy_id: n(p["policyid"]) ?? n(p["policy_id"]),
      name: s(p["name"]),
      hits: n(p["hit_count"]) ?? n(p["hits"]),
      bytes_in: n(p["bytes_in"]) ?? n(p["bytes_rcvd"]),
      bytes_out: n(p["bytes_out"]) ?? n(p["bytes_sent"]),
      raw: p,
    }));
}

/**
 * Top bandwidth consumers — aggregate live sessions by src_ip and sum
 * observed bytes. FortiOS doesn't expose a per-source bandwidth feed
 * we can hit from the monitor namespace without a paid FortiAnalyzer,
 * so this is computed from the live session list.
 */
export async function getTopBandwidthConsumers(hours = 1, limit = 10): Promise<FortigateBandwidthConsumer[]> {
  void hours; // session list is "now"; hours is documentary
  const sessions = await getActiveSessions(2000);
  const byIp = new Map<string, FortigateBandwidthConsumer>();
  for (const sess of sessions) {
    const ip = sess.src_ip;
    if (!ip) continue;
    const rxBytes = n(sess.raw["rx_bytes"]) ?? n(sess.raw["bytes_received"]) ?? 0;
    const txBytes = n(sess.raw["tx_bytes"]) ?? n(sess.raw["bytes_sent"]) ?? 0;
    const totalBytes = rxBytes + txBytes;
    const existing = byIp.get(ip);
    if (existing) {
      existing.bytes += totalBytes;
      existing.session_count += 1;
      if (!existing.src_mac && sess.src_mac) existing.src_mac = sess.src_mac;
    } else {
      byIp.set(ip, {
        src_ip: ip,
        src_mac: sess.src_mac,
        bytes: totalBytes,
        session_count: 1,
      });
    }
  }
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return Array.from(byIp.values())
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, safeLimit);
}

export interface FortigateSummary {
  status: FortigateSystemStatus | { error: string };
  resources: FortigateResourceUsage | { error: string };
  interface_wan: FortigateInterface | null;
  session_count: number | null;
  threat_count_24h: number | null;
  dhcp_lease_count: number | null;
  arp_entry_count: number | null;
}

/**
 * Composite call for the Network Command Center overview tile. Issues
 * every underlying call in parallel and tolerates per-section failures
 * so one quirky endpoint doesn't collapse the whole panel.
 */
export async function getSummary(): Promise<FortigateSummary> {
  const [statusR, resourcesR, interfacesR, threatsR, dhcpR, arpR] = await Promise.allSettled([
    getSystemStatus(),
    getResourceUsage(),
    getInterfaces(),
    getRecentThreats(100, 24),
    getDhcpLeases(),
    getArpTable(),
  ]);

  const status = statusR.status === "fulfilled" ? statusR.value : { error: statusR.reason instanceof Error ? statusR.reason.message : String(statusR.reason) };
  const resources = resourcesR.status === "fulfilled" ? resourcesR.value : { error: resourcesR.reason instanceof Error ? resourcesR.reason.message : String(resourcesR.reason) };
  let interface_wan: FortigateInterface | null = null;
  let session_count: number | null = null;
  if (interfacesR.status === "fulfilled") {
    interface_wan = interfacesR.value.find((i) => i.role === "wan") ?? interfacesR.value.find((i) => i.name.toLowerCase().startsWith("wan")) ?? null;
  }
  if (resourcesR.status === "fulfilled") {
    session_count = resourcesR.value.session_count ?? null;
  }
  const threat_count_24h = threatsR.status === "fulfilled" ? threatsR.value.length : null;
  const dhcp_lease_count = dhcpR.status === "fulfilled" ? dhcpR.value.length : null;
  const arp_entry_count = arpR.status === "fulfilled" ? arpR.value.length : null;
  return {
    status,
    resources,
    interface_wan,
    session_count,
    threat_count_24h,
    dhcp_lease_count,
    arp_entry_count,
  };
}

// --- SD-WAN health -------------------------------------------------------

export interface SdwanMember {
  seq: number;
  interface: string;
  label: string;
  status: "alive" | "dead" | "unknown";
  latency_ms: number | null;
  jitter_ms: number | null;
  packet_loss_pct: number | null;
  sla_met: boolean;
  gateway: string | null;
}

export interface SdwanHealth {
  zone: string;
  health_check_name: string | null;
  mode: string;
  members: SdwanMember[];
  sla_latency_threshold_ms: number;
  sla_packet_loss_threshold_pct: number;
}

const SDWAN_INTERFACE_LABELS: Record<string, string> = {
  wan1: "Spectrum",
  wan2: "Starlink",
};

function normalizeSdwanStatus(v: unknown): "alive" | "dead" | "unknown" {
  const str = (typeof v === "string" ? v : "").toLowerCase();
  if (str === "alive" || str === "up" || str === "online") return "alive";
  if (str === "dead" || str === "down" || str === "offline") return "dead";
  return "unknown";
}

/**
 * Fetch SD-WAN health-check member data from FortiOS.
 *
 * Endpoint: GET /api/v2/monitor/virtual-wan/health-check
 *
 * The response `results` is either:
 *   a) A dict keyed by health-check name → { members: [...] }
 *   b) An array of health-check objects each with a `name` and `members`
 *
 * We flatten all members across all health-checks and deduplicate by
 * interface name (keeping the one with the lowest seq-num so WAN1/WAN2
 * appear once each).
 */
export async function getSdwanHealth(): Promise<SdwanHealth> {
  const parsed = await fortigateGet("/api/v2/monitor/virtual-wan/health-check");
  const results = parsed["results"];

  const memberMap = new Map<string, SdwanMember>();
  // The SD-WAN zone is fixed (virtual-wan-link); the per-check name from the
  // health-check response is tracked separately as health_check_name.
  const zoneName = "virtual-wan-link";
  let healthCheckName: string | null = null;

  const processMembers = (members: unknown[]): void => {
    for (const raw of members) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      const iface = s(m["interface"]) ?? s(m["member_name"]) ?? "";
      if (!iface) continue;
      const seq = n(m["seq-num"]) ?? n(m["seq"]) ?? 0;
      const existing = memberMap.get(iface);
      if (existing && existing.seq <= seq) continue;
      memberMap.set(iface, {
        seq,
        interface: iface,
        label: SDWAN_INTERFACE_LABELS[iface.toLowerCase()] ?? iface,
        status: normalizeSdwanStatus(m["status"]),
        latency_ms: n(m["latency"]) ?? n(m["latency_ms"]) ?? null,
        jitter_ms: n(m["jitter"]) ?? n(m["jitter_ms"]) ?? null,
        packet_loss_pct: n(m["packet-loss"]) ?? n(m["packet_loss"]) ?? null,
        sla_met: (n(m["sla-met"]) ?? 0) !== 0 || m["sla_met"] === true,
        gateway: s(m["gateway"]) ?? null,
      });
    }
  };

  if (Array.isArray(results)) {
    for (const hc of results) {
      if (!hc || typeof hc !== "object") continue;
      const hcObj = hc as Record<string, unknown>;
      if (s(hcObj["name"])) healthCheckName = s(hcObj["name"]) ?? healthCheckName;
      const members = arr(hcObj["members"]);
      processMembers(members);
    }
  } else if (results && typeof results === "object") {
    const resultsObj = results as Record<string, unknown>;
    for (const [checkName, checkData] of Object.entries(resultsObj)) {
      healthCheckName = checkName;
      if (!checkData || typeof checkData !== "object") continue;
      const hcObj = checkData as Record<string, unknown>;
      const members = arr(hcObj["members"]);
      processMembers(members);
    }
  }

  const members = Array.from(memberMap.values()).sort((a, b) => a.seq - b.seq);

  return {
    zone: zoneName,
    health_check_name: healthCheckName,
    mode: "load-balance",
    members,
    sla_latency_threshold_ms: 250,
    sla_packet_loss_threshold_pct: 5,
  };
}

// --- Public helpers ------------------------------------------------------

export function isFortigateConfigured(): boolean {
  return Boolean(FORTIGATE_API_TOKEN);
}

export function getFortigateBaseUrl(): string {
  return FORTIGATE_BASE_URL;
}

export { CircuitOpenError };
