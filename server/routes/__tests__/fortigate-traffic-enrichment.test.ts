/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { NextFunction, Response } from "express";

// ---- Auth middleware mock: always admin ----
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.userRole = "admin";
    req.userId = "tony";
    next();
  },
}));

// ---- FortiGate lib mock: drive the device-query payload used to build the
//      IP -> { hostname, mac } label map. Everything else is best-effort and
//      can return empty results.
class CircuitOpenError extends Error {}

let fortigateDeviceResults: unknown[] = [];
vi.mock("../../lib/fortigate.js", () => ({
  // The route wraps this lib call and adds { status, data } itself, so the
  // lib must return the RAW FortiGate payload here.
  fortigateRequest: vi.fn(async (path: string) => {
    if (path.includes("/user/device/query")) {
      return { results: fortigateDeviceResults };
    }
    return { results: [] };
  }),
  getSummary: vi.fn(),
  getSdwanHealth: vi.fn(async () => null),
  isFortigateConfigured: vi.fn(() => true),
  getFortigateBaseUrl: vi.fn(() => "https://fortigate.test.local"),
  CircuitOpenError,
}));

// ---- HA readers: drive the top-talker list (source = "ha"), everything else
//      null so the route takes the direct/empty fallbacks.
let haTopTalkersList: { ip: string; bytes: number; tx_bytes: number; rx_bytes: number }[] = [];
vi.mock("../../lib/fortigate-ha.js", () => ({
  haSystemHealth: vi.fn(() => null),
  haWanStats: vi.fn(() => null),
  haIpsAnomalyCount: vi.fn(() => null),
  haTopTalkers: vi.fn(() => haTopTalkersList),
  haTopSites: vi.fn(() => null),
  haFortiViewSensorsPresent: vi.fn(() => false),
}));

// ---- DB mock: only the getDevicesByIps lookup matters here. It matches the
//      jsonb `ip_addresses ?| $1::text[]` query the real lib runs.
interface NdRow {
  mac_address: string;
  label: string | null;
  hostnames: string[] | null;
  ip_addresses: string[];
  last_seen: Date;
}
let ndRows: NdRow[] = [];
vi.mock("../../lib/db.js", () => ({
  query: vi.fn(async (sql: string, params?: any[]) => {
    const lower = sql.toLowerCase();
    if (lower.includes("from network_devices") && lower.includes("ip_addresses ?|")) {
      const ips = (params?.[0] as string[] | undefined) ?? [];
      const matched = ndRows
        .filter((r) => r.ip_addresses.some((ip) => ips.includes(ip)))
        .sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime());
      return { rows: matched, rowCount: matched.length };
    }
    return { rows: [], rowCount: 0 };
  }),
}));

// ---- Storage mock: drive device_overrides (keyed by MAC) ----
let overrides: any[] = [];
vi.mock("../../storage", () => ({
  storage: {
    getDeviceOverrides: vi.fn(async () => overrides),
  },
}));

const router = (await import("../fortigate.js")).default;

interface MockResp {
  status: number;
  body: any;
}

function invoke(method: string, path: string): Promise<MockResp> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    const req: any = {
      method,
      url: path,
      originalUrl: path,
      path: path.split("?")[0],
      query: {},
      params: {},
      headers: {},
      body: {},
      app,
      get(name: string) { return this.headers[name.toLowerCase()]; },
      header(name: string) { return this.headers[name.toLowerCase()]; },
    };
    const resp: any = {
      statusCode: 200,
      headersSent: false,
      _body: undefined,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { this._body = payload; this.headersSent = true; resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() { return this; },
      end() { if (!this.headersSent) resolve({ status: this.statusCode, body: this._body }); },
    };
    try {
      (app as any).handle(req, resp, (err: any) => {
        if (err) reject(err);
        else if (!resp.headersSent) resolve({ status: 404, body: { error: "not matched" } });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function hostnameFor(body: any, ip: string): string | null | undefined {
  return body.top_talkers.find((t: any) => t.ip === ip)?.hostname;
}

beforeEach(() => {
  vi.clearAllMocks();
  fortigateDeviceResults = [];
  haTopTalkersList = [];
  ndRows = [];
  overrides = [];
});

describe("GET /api/fortigate/traffic — device-name enrichment", () => {
  it("applies the full priority chain: override > nd.label > FortiGate hostname > nd.hostname > raw IP", async () => {
    haTopTalkersList = [
      { ip: "10.0.22.11", bytes: 500, tx_bytes: 250, rx_bytes: 250 }, // override wins
      { ip: "10.0.22.12", bytes: 400, tx_bytes: 200, rx_bytes: 200 }, // nd.label wins
      { ip: "10.0.22.13", bytes: 300, tx_bytes: 150, rx_bytes: 150 }, // FortiGate hostname wins
      { ip: "10.0.22.14", bytes: 200, tx_bytes: 100, rx_bytes: 100 }, // nd.hostname wins
      { ip: "10.0.22.15", bytes: 100, tx_bytes: 50, rx_bytes: 50 },   // nothing known -> null
    ];

    // FortiGate device query: supplies mac for .11 (so the override can match)
    // and a hostname for .13.
    fortigateDeviceResults = [
      { ip: "10.0.22.11", mac: "aa:bb:cc:00:00:11", hostname: "fgt-ignored-11" },
      { ip: "10.0.22.13", mac: "aa:bb:cc:00:00:13", hostname: "fgt-host-13" },
    ];

    // network_devices: label for .12, observed hostname (no label) for .14.
    ndRows = [
      { mac_address: "aa:bb:cc:00:00:12", label: "Tony's MacBook", hostnames: ["mbp"], ip_addresses: ["10.0.22.12"], last_seen: new Date() },
      { mac_address: "aa:bb:cc:00:00:14", label: null, hostnames: ["living-room-tv"], ip_addresses: ["10.0.22.14"], last_seen: new Date() },
    ];

    // device_overrides: custom name for .11's MAC.
    overrides = [
      { mac: "aa:bb:cc:00:00:11", customName: "Pool Controller", customCategory: null, customSubcategory: null, owner: null },
    ];

    const res = await invoke("GET", "/api/fortigate/traffic");
    expect(res.status).toBe(200);

    expect(hostnameFor(res.body, "10.0.22.11")).toBe("Pool Controller");   // override
    expect(hostnameFor(res.body, "10.0.22.12")).toBe("Tony's MacBook");    // nd.label
    expect(hostnameFor(res.body, "10.0.22.13")).toBe("fgt-host-13");       // FortiGate hostname
    expect(hostnameFor(res.body, "10.0.22.14")).toBe("living-room-tv");    // nd.hostname
    expect(hostnameFor(res.body, "10.0.22.15")).toBeNull();               // raw-IP fallback
  });

  it("prefers nd.label over a competing FortiGate hostname for the same IP", async () => {
    haTopTalkersList = [{ ip: "10.0.22.20", bytes: 100, tx_bytes: 50, rx_bytes: 50 }];
    fortigateDeviceResults = [{ ip: "10.0.22.20", mac: "aa:bb:cc:00:00:20", hostname: "DESKTOP-XYZ" }];
    ndRows = [{ mac_address: "aa:bb:cc:00:00:20", label: "Kids iPad", hostnames: ["ipad"], ip_addresses: ["10.0.22.20"], last_seen: new Date() }];

    const res = await invoke("GET", "/api/fortigate/traffic");
    expect(res.status).toBe(200);
    expect(hostnameFor(res.body, "10.0.22.20")).toBe("Kids iPad");
  });

  it("falls back to the raw IP (null hostname) when no name source resolves", async () => {
    haTopTalkersList = [{ ip: "10.0.22.99", bytes: 100, tx_bytes: 50, rx_bytes: 50 }];

    const res = await invoke("GET", "/api/fortigate/traffic");
    expect(res.status).toBe(200);
    const row = res.body.top_talkers.find((t: any) => t.ip === "10.0.22.99");
    expect(row).toBeDefined();
    expect(row.hostname).toBeNull();
    expect(row.mac).toBeNull();
  });

  it("stays resilient and returns raw IPs when the network_devices lookup throws", async () => {
    const db = await import("../../lib/db.js");
    (db.query as any).mockRejectedValueOnce(new Error("db blip"));
    haTopTalkersList = [{ ip: "10.0.22.30", bytes: 100, tx_bytes: 50, rx_bytes: 50 }];
    fortigateDeviceResults = [{ ip: "10.0.22.30", mac: "aa:bb:cc:00:00:30", hostname: "fgt-host-30" }];

    const res = await invoke("GET", "/api/fortigate/traffic");
    expect(res.status).toBe(200);
    // getDevicesByIps threw -> caller treats it as "no enrichment", so the
    // FortiGate-device hostname still labels the row (db failure is non-fatal).
    expect(hostnameFor(res.body, "10.0.22.30")).toBe("fgt-host-30");
  });
});
