/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { NextFunction, Response } from "express";

// ---- Auth middleware mock: role is switchable per test ----
let currentRole = "admin";
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.userRole = currentRole;
    req.userId = "tony";
    next();
  },
}));

// ---- FortiGate lib mock: drive the device-query payload for BOTH paths ----
// The admin refresh path calls fortigateGet(); the /devices slow path calls
// fortigateRequest(). Both must return the same device list so we can prove the
// two paths resolve identical connection labels.
class CircuitOpenError extends Error {}
let fortigateData: Record<string, unknown> = {};
vi.mock("../../lib/fortigate.js", () => ({
  fortigateGet: vi.fn(async (path: string) =>
    path.includes("/user/device/query") ? fortigateData : { results: [] },
  ),
  fortigateRequest: vi.fn(async (path: string) =>
    path.includes("/user/device/query") ? fortigateData : { results: [] },
  ),
  getSummary: vi.fn(),
  getSdwanHealth: vi.fn(),
  isFortigateConfigured: vi.fn(() => true),
  getFortigateBaseUrl: vi.fn(() => "https://fortigate.test.local"),
  CircuitOpenError,
}));

// ---- DB mock: every connection-cache lookup (cache read, Ruckus context,
// freshness, write-through) hits an empty dev DB. An empty cache forces the
// /devices route onto the live (slow) resolver path. ----
vi.mock("../../lib/db.js", () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

// ---- Storage mock: drive the override list shared by both paths ----
const storageMock = { getDeviceOverrides: vi.fn(async () => [] as any[]) };
vi.mock("../../storage", () => ({
  storage: { getDeviceOverrides: () => storageMock.getDeviceOverrides() },
}));

// ---- connection-cache: keep everything real except writeCachedConnections,
// which we spy on to capture the labels the refresh path persists. ----
const writeEntries: Array<{ mac: string; connection: any }> = [];
vi.mock("../../lib/connection-cache.js", async (importActual) => {
  const actual = await importActual<typeof import("../../lib/connection-cache.js")>();
  return {
    ...actual,
    writeCachedConnections: vi.fn(async (entries: Array<{ mac: string; connection: any }>) => {
      for (const e of entries) writeEntries.push(e);
    }),
  };
});

const router = (await import("../fortigate.js")).default;
const { refreshConnectionMethodCache } = await import("../../lib/connection-refresh.js");
const { normalizeMac } = await import("../../lib/network-devices.js");

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

// A spread of device shapes that exercise different rungs of the resolver
// ladder: a wired-leaning printer, a randomized phone, and a plain laptop.
const DEVICES = [
  { mac: "aa:bb:cc:11:22:33", vendor: "HP", device_type: "printer", hostname: "HP-LaserJet", ipv4_address: "10.0.50.5" },
  { mac: "a2:bb:cc:dd:ee:01", os: "iOS", device_type: "phone", ipv4_address: "10.0.22.40" },
  { mac: "00:1c:b3:44:55:66", vendor: "Apple", os: "macOS", hostname: "Tony-MBP", ipv4_address: "10.0.22.41" },
];

beforeEach(() => {
  vi.clearAllMocks();
  writeEntries.length = 0;
  currentRole = "admin";
  storageMock.getDeviceOverrides.mockResolvedValue([]);
  fortigateData = { results: DEVICES };
});

describe("refreshConnectionMethodCache vs /api/fortigate/devices slow path", () => {
  it("persists the exact same connection label per MAC as the live devices endpoint", async () => {
    const updated = await refreshConnectionMethodCache();
    expect(updated).toBe(DEVICES.length);
    // Snapshot the labels the refresh path wrote, keyed by normalized MAC.
    const refreshByMac = new Map(writeEntries.map((e) => [e.mac, e.connection]));
    expect(refreshByMac.size).toBe(DEVICES.length);

    const res = await invoke("GET", "/api/fortigate/devices");
    expect(res.status).toBe(200);

    // Every device the slow path returns must carry the identical resolved
    // connection object the refresh path cached for that MAC.
    for (const dev of res.body.devices) {
      const mac = normalizeMac(dev.mac);
      expect(refreshByMac.has(mac)).toBe(true);
      expect(dev.connection).toEqual(refreshByMac.get(mac));
    }
    expect(res.body.devices).toHaveLength(DEVICES.length);
  });

  it("stays in lockstep when an override changes the effective category", async () => {
    storageMock.getDeviceOverrides.mockResolvedValue([
      { mac: "a2:bb:cc:dd:ee:01", customName: null, customCategory: "Lighting & Switches", customSubcategory: null, owner: null },
    ]);

    await refreshConnectionMethodCache();
    const refreshByMac = new Map(writeEntries.map((e) => [e.mac, e.connection]));

    const res = await invoke("GET", "/api/fortigate/devices");
    for (const dev of res.body.devices) {
      const mac = normalizeMac(dev.mac);
      expect(dev.connection).toEqual(refreshByMac.get(mac));
    }
  });

  it("returns 0 and writes nothing when FortiGate reports no devices", async () => {
    fortigateData = { results: [] };
    const updated = await refreshConnectionMethodCache();
    expect(updated).toBe(0);
    expect(writeEntries).toHaveLength(0);
  });
});

describe("POST /api/fortigate/devices/refresh-connections — admin gate", () => {
  it("rejects a non-admin caller with 403 and never recomputes", async () => {
    currentRole = "user";
    const res = await invoke("POST", "/api/fortigate/devices/refresh-connections");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
    expect(writeEntries).toHaveLength(0);
  });

  it("lets an admin force a refresh and returns { ok, updated, connection_cache }", async () => {
    const res = await invoke("POST", "/api/fortigate/devices/refresh-connections");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.updated).toBe(DEVICES.length);
    // Freshness summary is included; the mocked empty DB yields the empty shape.
    expect(res.body.connection_cache).toEqual({ oldest: null, newest: null, count: 0 });
    // The refresh actually recomputed + persisted labels for every device.
    expect(writeEntries).toHaveLength(DEVICES.length);
  });
});
