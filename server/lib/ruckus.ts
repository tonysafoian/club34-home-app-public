/**
 * Ruckus Unleashed controller client — direct over Cloudflare Tunnel.
 *
 * Background: this module used to route every call through HA's
 * rest_command.ruckus_login / ruckus_call services because the
 * controller was LAN-only. With the new Cloudflare Tunnel at
 * `ruckus.example.com`, the backend can call the controller directly
 * — faster, fewer moving parts, and no HA-side configuration to
 * babysit.
 *
 * Tested against Ruckus Unleashed 200.14.6.1 build 203 on an R750
 * master AP (see /home/user/workspace/ruckus_api_notes.md for the
 * full live-verified API notes).
 *
 * Auth flow:
 *   1. GET  /admin/login.jsp                       → initial cookie
 *   2. POST /admin/login.jsp  body=username&password&ok=Log+In
 *      Response headers carry:
 *        Set-Cookie: -ejs-session-=<token>; ...
 *        http_x_csrf_token: <10-char token>
 *   3. Every data call: POST /admin/_cmdstat.jsp with the XML envelope,
 *      Cookie header, and X-CSRF-Token header.
 *
 * Session is cached for 10 minutes; on 401/403/302-to-login we
 * invalidate and re-login exactly once before failing.
 */

import { XMLParser } from "fast-xml-parser";
import { breakers, CircuitOpenError } from "./breakers.js";
import { recordObservedDevice } from "./network-devices.js";

const RUCKUS_BASE_URL = process.env.RUCKUS_BASE_URL || "https://ruckus.example.com";
const RUCKUS_USERNAME = process.env.RUCKUS_USERNAME || "admin";
const RUCKUS_PASSWORD = process.env.RUCKUS_PASSWORD || "";

const SESSION_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;

interface RuckusSession {
  cookie: string;
  csrfToken: string;
  loggedInAt: number;
}

let cachedSession: RuckusSession | null = null;
let inflightLogin: Promise<RuckusSession> | null = null;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
  parseAttributeValue: true,
  trimValues: true,
});

// --- HTTP helpers ---------------------------------------------------------

function getAllSetCookies(headers: Headers): string[] {
  // Node 22+ exposes Headers.getSetCookie(). Older Node falls through to
  // splitting the merged header value on `, ` boundaries that aren't inside
  // an Expires=... attribute. We try the standards-compliant path first.
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    try {
      const arr = anyHeaders.getSetCookie();
      if (Array.isArray(arr)) return arr;
    } catch {
      // fall through
    }
  }
  const merged = headers.get("set-cookie");
  if (!merged) return [];
  // Split on commas that are followed by what looks like a cookie name=value
  // (avoid the Expires= comma that sits inside cookie attributes).
  return merged.split(/,(?=\s*[a-zA-Z0-9_!#$%&'*+./~^`|-]+=)/g).map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract the `-ejs-session-` cookie value from a list of Set-Cookie lines.
 * Returns the `name=value` cookie pair (no attributes) or null.
 */
function extractSessionCookie(setCookies: string[]): string | null {
  for (const line of setCookies) {
    const m = /(^-ejs-session-=[^;]+)/i.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}

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

// --- Auth -----------------------------------------------------------------

async function performLogin(): Promise<RuckusSession> {
  if (!RUCKUS_PASSWORD) {
    throw new Error("RUCKUS_PASSWORD secret is not configured");
  }

  // Step 1 — GET /admin/login.jsp to seed an initial session cookie.
  const seedRes = await fetchT(`${RUCKUS_BASE_URL}/admin/login.jsp`, {
    method: "GET",
    redirect: "manual",
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  const seedCookies = getAllSetCookies(seedRes.headers);
  const seedCookie = extractSessionCookie(seedCookies);

  // Step 2 — POST credentials. Body shape per Ruckus Unleashed:
  //   username=<u>&password=<p>&ok=Log+In
  const body = new URLSearchParams({
    username: RUCKUS_USERNAME,
    password: RUCKUS_PASSWORD,
    ok: "Log In",
  }).toString();

  const loginRes = await fetchT(`${RUCKUS_BASE_URL}/admin/login.jsp`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${RUCKUS_BASE_URL}/admin/login.jsp`,
      ...(seedCookie ? { Cookie: seedCookie } : {}),
    },
    body,
  });

  // A successful login responds 302 → /admin/dashboard.jsp with a fresh
  // Set-Cookie and the http_x_csrf_token header. Some firmware variants
  // return 200 — we accept both as long as we get the cookie + CSRF.
  if (loginRes.status >= 400) {
    throw new Error(`Ruckus login failed (HTTP ${loginRes.status})`);
  }

  const respCookies = getAllSetCookies(loginRes.headers);
  const sessionCookie = extractSessionCookie(respCookies) ?? seedCookie;
  if (!sessionCookie) {
    throw new Error("Ruckus login succeeded but no -ejs-session- cookie returned");
  }
  // CSRF header is reported case-insensitively as http_x_csrf_token. We
  // also tolerate x-csrf-token in case the firmware renames it later.
  const csrfToken =
    loginRes.headers.get("http_x_csrf_token") ??
    loginRes.headers.get("x-csrf-token") ??
    "";
  if (!csrfToken) {
    throw new Error("Ruckus login succeeded but no CSRF token returned");
  }

  const session: RuckusSession = {
    cookie: sessionCookie,
    csrfToken,
    loggedInAt: Date.now(),
  };
  cachedSession = session;
  return session;
}

function login(): Promise<RuckusSession> {
  if (inflightLogin) return inflightLogin;
  inflightLogin = performLogin().finally(() => {
    inflightLogin = null;
  });
  return inflightLogin;
}

async function getSession(forceRenew = false): Promise<RuckusSession> {
  if (!forceRenew && cachedSession && Date.now() - cachedSession.loggedInAt < SESSION_TTL_MS) {
    return cachedSession;
  }
  return login();
}

function looksUnauthenticated(status: number, body: string, location: string | null): boolean {
  if (status === 401 || status === 403) return true;
  // The controller redirects unauth'd requests back to /admin/login.jsp.
  if (status >= 300 && status < 400 && location && /login\.jsp/i.test(location)) return true;
  // Some Ruckus firmwares return 200 with a JSP login fragment in the body.
  if (status === 200 && (body.includes("login.jsp") || body.includes("<login-redir"))) return true;
  return false;
}

// --- XML call -------------------------------------------------------------

async function callCmdstatRaw(xml: string, session: RuckusSession): Promise<{ status: number; body: string; location: string | null }> {
  // Cloudflare Tunnel between this backend and the controller drops its
  // origin TCP connection after a short idle. The first request after
  // idle often fails with a bare "fetch failed" 10-12s in (CF returns
  // 502 / closes the socket while warming the tunnel). One quick retry
  // turns that cold-start race into a transparent recoverable blip
  // instead of a breaker-tripping failure.
  const doFetch = () =>
    fetchT(`${RUCKUS_BASE_URL}/admin/_cmdstat.jsp`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "text/xml",
        "X-CSRF-Token": session.csrfToken,
        Cookie: session.cookie,
        Referer: `${RUCKUS_BASE_URL}/admin/dashboard.jsp`,
      },
      body: xml,
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[ruckus] cmdstat fetch failed once (${msg}); retrying after 500ms`);
    await new Promise((r) => setTimeout(r, 500));
    res = await doFetch();
  }
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get("location") };
}

async function ajax(xml: string): Promise<unknown> {
  return breakers.ruckus.execute(async () => {
    let session = await getSession();
    let result = await callCmdstatRaw(xml, session);

    if (looksUnauthenticated(result.status, result.body, result.location)) {
      // Invalidate the cache so the renewal doesn't keep using the dead
      // cookie and re-login exactly once.
      if (cachedSession?.cookie === session.cookie) cachedSession = null;
      session = await getSession(true);
      result = await callCmdstatRaw(xml, session);
      if (looksUnauthenticated(result.status, result.body, result.location)) {
        throw new Error("Ruckus authentication failed after re-login (check RUCKUS_USERNAME / RUCKUS_PASSWORD)");
      }
    }
    if (result.status >= 400) {
      throw new Error(`Ruckus call failed (HTTP ${result.status}): ${result.body.slice(0, 200)}`);
    }
    if (!result.body || !result.body.trim()) return {};
    try {
      return xmlParser.parse(result.body);
    } catch (err) {
      throw new Error(`Failed to parse Ruckus XML: ${(err as Error).message}`);
    }
  });
}

// --- Utilities ------------------------------------------------------------

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function obj(v: unknown): Record<string, unknown> {
  return (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
}

function s(v: unknown): string | undefined {
  if (v == null) return undefined;
  return String(v);
}

function n(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const num = Number(v);
  return Number.isFinite(num) ? num : undefined;
}

function b(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Map an integer RSSI (dBm) to a coarse health bucket the UI uses.
 * Bins from the api notes: > -50 excellent, -50..-65 good, -65..-75 fair,
 * worse than -75 poor. Returns 'unknown' for missing input.
 */
export type SignalHealth = "excellent" | "good" | "fair" | "poor" | "unknown";
export function signalHealthFromRssi(rssi: number | undefined | null): SignalHealth {
  if (rssi == null || !Number.isFinite(rssi)) return "unknown";
  if (rssi > -50) return "excellent";
  if (rssi > -65) return "good";
  if (rssi > -75) return "fair";
  return "poor";
}

/**
 * Classify a client's radio band from the raw controller attributes. Reads
 * `radio-band` ("2.4g"/"5g"/"6g") first, then channel number, then radio-type
 * text. Returns undefined only when none are present (UI shows "—"); never
 * guesses. Shared by the parser (first-class `band` field) and the route's
 * grouping fallback so both classify identically.
 */
export function classifyBand(raw: Record<string, unknown>): string | undefined {
  // 1. Explicit band field — the controller's cleanest signal.
  const band = String(raw["radio-band"] ?? raw["band"] ?? "").trim().toLowerCase();
  if (band) {
    if (band.includes("2.4") || band.startsWith("2g")) return "2.4GHz";
    if (band.includes("6")) return "6GHz";
    if (band.includes("5")) return "5GHz";
  }

  // 2. Channel number: 1-14 is 2.4GHz; 36-165 is 5GHz. (6GHz reuses low
  // channel numbers, so only `radio-band` above can name it reliably.)
  const ch = Number(raw["channel"] ?? raw["radio-channel"] ?? raw["wlan-channel"] ?? raw["ch"]);
  if (Number.isFinite(ch) && ch > 0) {
    if (ch <= 14) return "2.4GHz";
    if (ch >= 36 && ch <= 165) return "5GHz";
  }

  // 3. Radio-type text heuristics (e.g. "11ng"/"g/n" → 2.4GHz, "11ac"/"ax" → 5GHz).
  const radio = String(
    raw["ieee80211-radio-type"] ??
      raw["radio-type-text"] ??
      raw["radio-type"] ??
      raw["radio"] ??
      raw["wlan-radio"] ??
      raw["wlan-radio-type"] ??
      raw["rx-radio-mode"] ??
      raw["radio-mode"] ??
      raw["phy-mode"] ??
      raw["channel-width-band"] ??
      "",
  ).toLowerCase();
  if (radio) {
    if (radio.includes("2.4") || radio.includes("ng") || radio === "bg" || radio === "g" || radio === "g/n")
      return "2.4GHz";
    if (radio.includes("6")) return "6GHz";
    if (
      radio.includes("5") ||
      radio.includes("na") ||
      radio.includes("ac") ||
      radio.includes("ax") ||
      radio === "a" ||
      radio === "a/n"
    )
      return "5GHz";
  }

  return undefined;
}

// --- Types ----------------------------------------------------------------

export interface RuckusSystemInfo {
  model?: string;
  version?: string;
  mac?: string;
  serial?: string;
  uptime_sec?: number;
  cpu_busy_pct?: number;
  cpu_total?: number;
  mem_total_kb?: number;
  mem_free_kb?: number;
  max_ap?: number;
  raw: Record<string, unknown>;
}

export interface RuckusAccessPoint {
  mac: string;
  name: string;
  model?: string;
  ip?: string;
  state?: string;
  status: "joined" | "disconnected" | "unknown";
  gateway?: string;
  hw_version?: string;
  build_version?: string;
  mgmt_vlan?: string | number;
  supports_11ax?: boolean;
  supports_11ac?: boolean;
  max_clients?: number;
  client_count?: number;
  raw: Record<string, unknown>;
}

export interface RuckusClient {
  mac: string;
  ssid?: string;
  ap_name?: string;
  ap_mac?: string;
  vlan?: string | number;
  rssi_dbm?: number;
  signal?: number; // received-signal-strength integer dBm
  signal_health: SignalHealth;
  band?: string; // '2.4GHz' | '5GHz' | '6GHz', classified from raw radio attrs
  hostname?: string;
  ip?: string;
  dvctype?: string;
  model?: string;
  role_id?: string;
  auth_method?: string;
  encryption?: string;
  first_assoc_at?: number;
  wlan_id?: string;
  raw: Record<string, unknown>;
}

export interface RuckusSSID {
  name: string;
  bss_count?: number;
  client_count?: number;
  encryption?: string;
  /** True when this entry was reconstructed from observed client traffic
   *  instead of returned by the controller's SSID API. */
  derived_from_clients?: boolean;
  raw?: Record<string, unknown>;
}

// --- Public API -----------------------------------------------------------

/**
 * Lightweight per-call timing wrapper. We instrument every public Ruckus
 * getter so the operator can correlate UI "flap" reports against actual
 * timing/error data in the logs without having to add ad-hoc tracing
 * every time someone asks. Logs are emitted on the same `[ruckus]`
 * channel the rest of this module uses.
 */
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - start;
    if (ms > 5_000) {
      console.warn(`[ruckus] ${label} slow: ${ms}ms`);
    } else {
      console.debug?.(`[ruckus] ${label} ok ${ms}ms`);
    }
    return out;
  } catch (err) {
    const ms = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ruckus] ${label} failed in ${ms}ms: ${message}`);
    throw err;
  }
}

/**
 * Keep-alive ping for the Cloudflare Tunnel between this backend and the
 * controller. The tunnel drops its origin TCP/TLS session after a short
 * idle, so the first real poll after a quiet period eats a 10-12s cold
 * start (and often fails outright, tripping the circuit breaker). A cheap
 * unauthenticated GET to /admin/login.jsp on a tight cadence keeps the
 * socket hot so every real poll stays sub-second.
 *
 * Failures are swallowed on purpose: this is best-effort warming, not a
 * health check. We never log an error or write an audit row — a missed
 * ping just means the next one (or the real poll's one-shot retry) warms
 * the tunnel instead.
 */
export async function pingTunnel(): Promise<void> {
  try {
    const res = await fetchT(`${RUCKUS_BASE_URL}/admin/login.jsp`, {
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

export async function getSystemInfo(): Promise<RuckusSystemInfo> {
  return timed("getSystemInfo", () => _getSystemInfo());
}

async function _getSystemInfo(): Promise<RuckusSystemInfo> {
  const xml = `<ajax-request action='getstat' comp='system'><sysinfo LEVEL='1'/></ajax-request>`;
  const parsed = obj((obj(await ajax(xml)) as { "ajax-response"?: unknown })["ajax-response"]);
  const response = obj(parsed.response);
  const sysinfo = obj(response.sysinfo ?? response["system"] ?? response);
  return {
    model: s(sysinfo.model),
    version: s(sysinfo.version ?? sysinfo["system-version"]),
    mac: s(sysinfo.mac),
    serial: s(sysinfo.serial),
    uptime_sec: n(sysinfo.uptime),
    cpu_busy_pct: n(sysinfo.cpu_busy ?? sysinfo["cpu-busy"]),
    cpu_total: n(sysinfo.cpu_total ?? sysinfo["cpu-total"]),
    mem_total_kb: n(sysinfo.mem_total ?? sysinfo["mem-total"]),
    mem_free_kb: n(sysinfo.mem_free ?? sysinfo["mem-free"]),
    max_ap: n(sysinfo.max_ap ?? sysinfo["max-ap"]),
    raw: sysinfo,
  };
}

function deriveApStatus(state: string | undefined): "joined" | "disconnected" | "unknown" {
  if (!state) return "unknown";
  const lower = state.toLowerCase();
  // Firmware 200.14.6.1 reports AP connection state as a numeric string:
  // "1" = joined/online, "0" = disconnected (verified live). Older/other
  // shapes use word states or "2", so accept all.
  if (lower === "join" || lower === "joined" || lower === "connect" || lower === "connected" || lower === "online" || lower === "1" || lower === "2") {
    return "joined";
  }
  if (lower === "disconnect" || lower === "disconnected" || lower === "offline" || lower === "0") {
    return "disconnected";
  }
  return "unknown";
}

export async function getAccessPoints(): Promise<RuckusAccessPoint[]> {
  return timed("getAccessPoints", () => _getAccessPoints());
}

async function _getAccessPoints(): Promise<RuckusAccessPoint[]> {
  const xml = `<ajax-request action='getstat' updater='aps' comp='stamgr'><ap LEVEL='1'/></ajax-request>`;
  const parsed = obj((obj(await ajax(xml)) as { "ajax-response"?: unknown })["ajax-response"]);
  const response = obj(parsed.response);
  // Firmware 200.14.6.1 nests the AP list under an <apstamgr-stat> wrapper:
  //   <ajax-response><response id="aps"><apstamgr-stat><ap .../><ap .../></apstamgr-stat></response>
  // Older/other shapes put <ap> directly under <response> (or <aps>), so we
  // check the wrapper first and fall back to the flat shapes.
  const stat = obj(response["apstamgr-stat"]);
  const apList = asArray<unknown>(stat.ap ?? response.ap ?? obj(response.aps).ap);

  return apList.map((apRaw): RuckusAccessPoint => {
    const ap = obj(apRaw);
    const state = s(ap.state ?? ap.status);
    return {
      mac: s(ap.mac) ?? "",
      name: s(ap["ap-name"] ?? ap["device-name"] ?? ap.name) ?? s(ap.mac) ?? "Unknown",
      model: s(ap.model),
      ip: s(ap.ip),
      state,
      status: deriveApStatus(state),
      gateway: s(ap.gateway),
      hw_version: s(ap["hardware-version"] ?? ap["hw-version"] ?? ap.hwversion),
      build_version: s(ap["build-version"] ?? ap.buildversion ?? ap.firmware),
      mgmt_vlan: s(ap["mgmt-vlan-id"]) ?? n(ap["mgmt-vlan-id"]),
      supports_11ax: b(ap["support-11ax"] ?? ap["11ax"]),
      supports_11ac: b(ap["support-11ac"] ?? ap["11ac"]),
      max_clients: n(ap["max-client"] ?? ap["max-clients"]),
      raw: ap,
    };
  });
}

export async function getClients(): Promise<RuckusClient[]> {
  return timed("getClients", () => _getClients());
}

async function _getClients(): Promise<RuckusClient[]> {
  const xml = `<ajax-request action='getstat' updater='client-info-stats' comp='stamgr'><client LEVEL='1'/></ajax-request>`;
  const parsed = obj((obj(await ajax(xml)) as { "ajax-response"?: unknown })["ajax-response"]);
  const response = obj(parsed.response);
  // Firmware 200.14.6.1 nests clients under <apstamgr-stat> as well.
  const stat = obj(response["apstamgr-stat"]);
  const list = asArray<unknown>(stat.client ?? response.client);

  const clients = list.map((cRaw): RuckusClient => {
    const c = obj(cRaw);
    // received-signal-strength is a small integer dBm and is what we
    // bucket into the health bins. rssi-level (1..5) is for displaying
    // signal bars and we keep it under rssi_dbm despite the name.
    // The dBm value surfaces under several attribute names across Unleashed
    // firmware revisions; accept the known variants so a rename doesn't blank
    // the per-client signal in the grouped view.
    const signal = n(
      c["received-signal-strength"] ??
        c["signal-strength"] ??
        c["recv-signal-strength"] ??
        c["last-rssi"] ??
        c["rssi-dbm"] ??
        c.signal,
    );
    const rssiLevel = n(c.rssi ?? c["rssi-level"]);
    return {
      mac: s(c.mac) ?? "",
      ssid: s(c.ssid ?? c.wlan),
      ap_name: s(c["ap-name"]),
      ap_mac: s(c["ap-mac"] ?? c.ap),
      vlan: s(c.vlan) ?? n(c.vlan),
      rssi_dbm: rssiLevel,
      signal,
      signal_health: signalHealthFromRssi(signal),
      // Classify band at parse time from the raw attrs in scope (radio-band
      // first, then channel, then radio-type). Carrying it as a first-class
      // field means band survives to the grouping layer even if `raw` is not.
      band: classifyBand(c),
      hostname: s(c.hostname ?? c["user-name"]),
      // IP likewise moves between attribute names depending on firmware
      // (ip / host-ipaddr / ipv4 / ip-addr / ip_address). Accept all so the
      // client IP isn't dropped on a feed that uses a non-default name.
      ip: s(c.ip ?? c["host-ipaddr"] ?? c.ipv4 ?? c["ip-addr"] ?? c["ip_address"]),
      dvctype: s(c.dvctype ?? c["device-type"]),
      model: s(c.model),
      role_id: s(c["role-id"]),
      auth_method: s(c["auth-method"]),
      encryption: s(c.encryption),
      first_assoc_at: n(c["first-assoc"] ?? c["first-assoc-time"]),
      wlan_id: s(c["wlan-id"]),
      raw: c,
    };
  });
  // Fire-and-forget ingestion. Ruckus clients are the only feed that
  // also gives us SSID and a hostname for free.
  for (const c of clients) {
    if (c.mac) {
      recordObservedDevice({
        mac: c.mac,
        ip: c.ip ?? null,
        hostname: c.hostname ?? null,
        ssid: c.ssid ?? null,
      });
    }
  }
  return clients;
}

/**
 * Try several SSID queries until one returns data. As of 2026-05-13 the
 * controller doesn't respond to any of the obvious shapes (see
 * ruckus_api_notes.md). If all queries return empty, derive the SSID list
 * from the unique values observed in getClients(). TODO: revisit when we
 * find a working SSID query and remove the fallback path.
 */
const SSID_QUERY_SHAPES: string[] = [
  `<ajax-request action='getconf' comp='wlansvc'/>`,
  `<ajax-request action='getstat' comp='wlansvc-info'><wlansvc LEVEL='1'/></ajax-request>`,
  `<ajax-request action='getstat' updater='wlansvc' comp='stamgr'><wlansvc LEVEL='1'/></ajax-request>`,
];

function extractSsidsFromResponse(parsed: unknown): RuckusSSID[] {
  const root = obj((obj(parsed) as { "ajax-response"?: unknown })["ajax-response"]);
  const response = obj(root.response);
  // The controller could nest this under wlansvc-list, wlansvc, or response.
  const candidate =
    asArray<unknown>(obj(response["wlansvc-list"]).wlansvc) .concat(
    asArray<unknown>(response.wlansvc),
    asArray<unknown>(obj(response.wlansvc as unknown as Record<string, unknown>)),
  );
  const seen = new Set<string>();
  const out: RuckusSSID[] = [];
  for (const w of candidate) {
    const wObj = obj(w);
    const name = s(wObj.ssid ?? wObj.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      bss_count: n(wObj["bss-count"]),
      encryption: s(wObj.encryption ?? wObj.auth),
      raw: wObj,
    });
  }
  return out;
}

export async function getSSIDs(): Promise<RuckusSSID[]> {
  return timed("getSSIDs", () => _getSSIDs());
}

async function _getSSIDs(): Promise<RuckusSSID[]> {
  for (const xml of SSID_QUERY_SHAPES) {
    try {
      const parsed = await ajax(xml);
      const ssids = extractSsidsFromResponse(parsed);
      if (ssids.length > 0) return ssids;
    } catch (err) {
      // A single shape failing shouldn't block the next attempt. Log and
      // move on.
      console.warn(`[ruckus] SSID query failed for "${xml.slice(0, 80)}…": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fallback — derive SSID list from observed clients. Better than
  // returning empty for a UI that ships today; revisit when we find
  // the working query.
  const clients = await getClients().catch(() => [] as RuckusClient[]);
  const ssidCounts = new Map<string, number>();
  for (const c of clients) {
    if (!c.ssid) continue;
    ssidCounts.set(c.ssid, (ssidCounts.get(c.ssid) ?? 0) + 1);
  }
  const derived: RuckusSSID[] = Array.from(ssidCounts.entries()).map(([name, client_count]) => ({
    name,
    client_count,
    derived_from_clients: true,
  }));
  return derived;
}

// --- Public helpers -------------------------------------------------------

export function isRuckusConfigured(): boolean {
  return Boolean(RUCKUS_PASSWORD);
}

export function getRuckusBaseUrl(): string {
  return RUCKUS_BASE_URL;
}

/** Test-only — reset session state between cases. */
export function __resetSessionForTests(): void {
  cachedSession = null;
  inflightLogin = null;
}

export { CircuitOpenError };
