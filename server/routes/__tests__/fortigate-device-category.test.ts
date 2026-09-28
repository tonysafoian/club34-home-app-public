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

// ---- FortiGate lib mock: drive the device-query payload ----
class CircuitOpenError extends Error {}

let fortigateData: Record<string, unknown> = {};
vi.mock("../../lib/fortigate.js", () => ({
  fortigateRequest: vi.fn(async (path: string) => {
    if (path.includes("/user/device/query")) return fortigateData;
    // fortiview/statistics + any others
    return { results: [] };
  }),
  getSummary: vi.fn(),
  isFortigateConfigured: vi.fn(() => true),
  getFortigateBaseUrl: vi.fn(() => "https://fortigate.test.local"),
  CircuitOpenError,
}));

// ---- DB mock: Ruckus observation lookup returns nothing ----
vi.mock("../../lib/db.js", () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));

// ---- Storage mock: drive the override list ----
const storageMock = {
  getDeviceOverrides: vi.fn(),
};
vi.mock("../../storage", () => ({
  storage: {
    getDeviceOverrides: (...a: any[]) => storageMock.getDeviceOverrides(...a),
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

// A locally-administered (randomized) MAC: first byte 0xa2 has the
// locally-administered bit (0x02) set, so the classifier flags it is_random.
const RANDOM_MAC = "a2:bb:cc:dd:ee:01";

beforeEach(() => {
  vi.clearAllMocks();
  // A randomized-MAC device with no hostname → classifier returns
  // Unknown / Uncategorized with needsLabel=true.
  fortigateData = { results: [{ mac: RANDOM_MAC }] };
});

describe("GET /api/fortigate/devices — randomized device triage", () => {
  it("flags a randomized device with no override for labeling (baseline)", async () => {
    storageMock.getDeviceOverrides.mockResolvedValue([]);
    const res = await invoke("GET", "/api/fortigate/devices");
    expect(res.status).toBe(200);
    const dev = res.body.devices.find((d: any) => d.mac === RANDOM_MAC);
    expect(dev).toBeDefined();
    expect(dev.is_random).toBe(true);
    expect(dev.is_overridden).toBe(false);
    expect(dev.needs_label).toBe(true);
  });

  it("keeps needs_label set when a category override anchors an owner-required category but no owner is assigned", async () => {
    storageMock.getDeviceOverrides.mockResolvedValue([
      {
        mac: RANDOM_MAC,
        customName: null,
        customCategory: "People / Personal Devices",
        customSubcategory: null,
        owner: null,
      },
    ]);
    const res = await invoke("GET", "/api/fortigate/devices");
    expect(res.status).toBe(200);
    const dev = res.body.devices.find((d: any) => d.mac === RANDOM_MAC);
    expect(dev).toBeDefined();
    expect(dev.is_overridden).toBe(true);
    expect(dev.category).toBe("People / Personal Devices");
    // Anchoring to a personal category does NOT clear triage until an owner is saved.
    expect(dev.needs_label).toBe(true);
    expect(dev.owner_missing).toBe(true);
  });

  it("clears needs_label only once an owner is assigned to a category override", async () => {
    storageMock.getDeviceOverrides.mockResolvedValue([
      {
        mac: RANDOM_MAC,
        customName: null,
        customCategory: "People / Personal Devices",
        customSubcategory: null,
        owner: "tony",
      },
    ]);
    const res = await invoke("GET", "/api/fortigate/devices");
    expect(res.status).toBe(200);
    const dev = res.body.devices.find((d: any) => d.mac === RANDOM_MAC);
    expect(dev).toBeDefined();
    expect(dev.is_overridden).toBe(true);
    expect(dev.category).toBe("People / Personal Devices");
    expect(dev.owner).toBe("tony");
    expect(dev.needs_label).toBe(false);
    expect(dev.owner_missing).toBe(false);
  });

  it("does NOT treat a name-only override as a category anchor and keeps needs_label until an owner is set", async () => {
    storageMock.getDeviceOverrides.mockResolvedValue([
      {
        mac: RANDOM_MAC,
        customName: "Guest phone",
        customCategory: null,
        customSubcategory: null,
        owner: null,
      },
    ]);
    const res = await invoke("GET", "/api/fortigate/devices");
    expect(res.status).toBe(200);
    const dev = res.body.devices.find((d: any) => d.mac === RANDOM_MAC);
    expect(dev.is_overridden).toBe(true);
    // A name-only override leaves the device uncategorized, so it stays in triage.
    expect(dev.needs_label).toBe(true);
  });

  it("clears needs_label when a name-only override also carries an owner", async () => {
    storageMock.getDeviceOverrides.mockResolvedValue([
      {
        mac: RANDOM_MAC,
        customName: "Guest phone",
        customCategory: null,
        customSubcategory: null,
        owner: "tony",
      },
    ]);
    const res = await invoke("GET", "/api/fortigate/devices");
    expect(res.status).toBe(200);
    const dev = res.body.devices.find((d: any) => d.mac === RANDOM_MAC);
    expect(dev.is_overridden).toBe(true);
    expect(dev.owner).toBe("tony");
    expect(dev.needs_label).toBe(false);
  });
});
