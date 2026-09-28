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

// ---- FortiGate lib mock: drive the device-query payload used to resolve the
//      FortiGate hostname/MAC tier. FortiView + traffic-log responses stay
//      empty — this suite only cares about the friendly-name enrichment.
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

// ---- HA readers: unused by this endpoint; all null/empty. ----
vi.mock("../../lib/fortigate-ha.js", () => ({
  haSystemHealth: vi.fn(() => null),
  haWanStats: vi.fn(() => null),
  haIpsAnomalyCount: vi.fn(() => null),
  haTopTalkers: vi.fn(() => []),
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
      // Express's query middleware skips req.query when it is already set,
      // so parse the query string here.
      query: Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? "")),
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

function deviceTraffic(identifier: string, srcip: string): Promise<MockResp> {
  return invoke(
    "GET",
    `/api/fortigate/devices/${encodeURIComponent(identifier)}/traffic?srcip=${encodeURIComponent(srcip)}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  fortigateDeviceResults = [];
  ndRows = [];
  overrides = [];
});

describe("GET /api/fortigate/devices/:identifier/traffic — device-name enrichment", () => {
  it("tier 1: device_overrides custom name wins over every other source", async () => {
    fortigateDeviceResults = [
      { ip: "10.0.22.11", mac: "aa:bb:cc:00:00:11", hostname: "fgt-ignored-11" },
    ];
    ndRows = [
      { mac_address: "aa:bb:cc:00:00:11", label: "ND Label 11", hostnames: ["nd-host-11"], ip_addresses: ["10.0.22.11"], last_seen: new Date() },
    ];
    overrides = [
      { mac: "aa:bb:cc:00:00:11", customName: "Pool Controller", customCategory: "IoT Devices", customSubcategory: null, owner: null },
    ];

    const res = await deviceTraffic("aa:bb:cc:00:00:11", "10.0.22.11");
    expect(res.status).toBe(200);
    expect(res.body.hostname).toBe("Pool Controller");
    expect(res.body.mac).toBe("aa:bb:cc:00:00:11");
    expect(res.body.category).toBe("IoT Devices");
  });

  it("tier 2: network_devices.label beats the FortiGate hostname and observed hostname", async () => {
    fortigateDeviceResults = [
      { ip: "10.0.22.12", mac: "aa:bb:cc:00:00:12", hostname: "DESKTOP-XYZ" },
    ];
    ndRows = [
      { mac_address: "aa:bb:cc:00:00:12", label: "Tony's MacBook", hostnames: ["mbp"], ip_addresses: ["10.0.22.12"], last_seen: new Date() },
    ];

    const res = await deviceTraffic("10.0.22.12", "10.0.22.12");
    expect(res.status).toBe(200);
    expect(res.body.hostname).toBe("Tony's MacBook");
  });

  it("tier 3: falls back to the live FortiGate device-query hostname", async () => {
    fortigateDeviceResults = [
      { ip: "10.0.22.13", mac: "aa:bb:cc:00:00:13", hostname: "fgt-host-13" },
    ];

    const res = await deviceTraffic("10.0.22.13", "10.0.22.13");
    expect(res.status).toBe(200);
    expect(res.body.hostname).toBe("fgt-host-13");
    expect(res.body.mac).toBe("aa:bb:cc:00:00:13");
  });

  it("tier 4: falls back to the network_devices observed hostname when no label exists", async () => {
    ndRows = [
      { mac_address: "aa:bb:cc:00:00:14", label: null, hostnames: ["living-room-tv"], ip_addresses: ["10.0.22.14"], last_seen: new Date() },
    ];

    const res = await deviceTraffic("10.0.22.14", "10.0.22.14");
    expect(res.status).toBe(200);
    expect(res.body.hostname).toBe("living-room-tv");
    expect(res.body.mac).toBe("aa:bb:cc:00:00:14");
  });

  it("tier 5: hostname is null (raw-IP fallback) when nothing is known", async () => {
    const res = await deviceTraffic("10.0.22.15", "10.0.22.15");
    expect(res.status).toBe(200);
    expect(res.body.hostname).toBeNull();
    expect(res.body.mac).toBeNull();
    expect(res.body.category).toBeNull();
    expect(res.body.srcip).toBe("10.0.22.15");
  });

  it("uses a MAC-shaped :identifier for the override lookup even when FortiGate/nd have no MAC", async () => {
    // Devices tab passes the MAC as :identifier; no live device-query row and
    // no network_devices row exist, yet the override must still match.
    overrides = [
      { mac: "AA-BB-CC-00-00-16", customName: "Garage Door Hub", customCategory: null, customSubcategory: null, owner: null },
    ];

    const res = await deviceTraffic("AA:BB:CC:00:00:16", "10.0.22.16");
    expect(res.status).toBe(200);
    expect(res.body.hostname).toBe("Garage Door Hub");
    expect(res.body.mac).toBe("aa:bb:cc:00:00:16");
  });

  it("stays resilient when the network_devices lookup throws (db failure is non-fatal)", async () => {
    const db = await import("../../lib/db.js");
    (db.query as any).mockRejectedValueOnce(new Error("db blip"));
    fortigateDeviceResults = [
      { ip: "10.0.22.30", mac: "aa:bb:cc:00:00:30", hostname: "fgt-host-30" },
    ];

    const res = await deviceTraffic("10.0.22.30", "10.0.22.30");
    expect(res.status).toBe(200);
    // getDevicesByIps threw -> treated as "no enrichment"; the FortiGate
    // device hostname still labels the response.
    expect(res.body.hostname).toBe("fgt-host-30");
  });
});
