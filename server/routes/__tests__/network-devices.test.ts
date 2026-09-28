/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import type { NextFunction, Request, Response } from "express";

// ---- Auth middleware mock: drive userRole via a module-level setter ----

let currentRole: "admin" | "member" | "guest" = "admin";
let currentUserId: string | undefined = "tony";

vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.userRole = currentRole;
    req.userId = currentUserId;
    next();
  },
}));

// ---- network-devices lib mock ----

const libMock = {
  getDevice: vi.fn(),
  listDevices: vi.fn(),
  labelDevice: vi.fn(),
  unknownDevices: vi.fn(),
  deleteDevice: vi.fn(),
  inferVendorFromMac: vi.fn((_mac: string | null | undefined) => "Apple"),
};

vi.mock("../../lib/network-devices.js", () => ({
  getDevice: (...a: any[]) => libMock.getDevice(...a),
  listDevices: (...a: any[]) => libMock.listDevices(...a),
  labelDevice: (...a: any[]) => libMock.labelDevice(...a),
  unknownDevices: (...a: any[]) => libMock.unknownDevices(...a),
  deleteDevice: (...a: any[]) => libMock.deleteDevice(...a),
  inferVendorFromMac: (mac: string | null | undefined) => libMock.inferVendorFromMac(mac),
}));

// ---- Tiny fetch-via-router helper (no supertest) ----------------------

const router = (await import("../network-devices.js")).default;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

interface MockResp {
  status: number;
  body: any;
}

function invoke(method: string, path: string, body?: any): Promise<MockResp> {
  return new Promise((resolve, reject) => {
    const app = makeApp();
    const req: any = {
      method,
      url: path,
      originalUrl: path,
      path: path.split("?")[0],
      query: parseQuery(path),
      params: {},
      headers: { "content-type": body ? "application/json" : undefined },
      body: body ?? {},
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
      // Express routers have a .handle(req, res, next) method.
      (app as any).handle(req, resp, (err: any) => {
        if (err) reject(err);
        else if (!resp.headersSent) resolve({ status: 404, body: { error: "not matched" } });
      });
    } catch (err) {
      reject(err);
    }
  });
}

function parseQuery(url: string): Record<string, string> {
  const q: Record<string, string> = {};
  const idx = url.indexOf("?");
  if (idx === -1) return q;
  const search = url.slice(idx + 1);
  for (const part of search.split("&")) {
    const [k, v] = part.split("=");
    if (k) q[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = "admin";
  currentUserId = "tony";
});

describe("/api/network-devices auth gate", () => {
  it("returns 403 for non-admin role", async () => {
    currentRole = "member";
    libMock.listDevices.mockResolvedValue({ devices: [], total: 0 });
    const res = await invoke("GET", "/api/network-devices");
    expect(res.status).toBe(403);
  });

  it("allows admin through", async () => {
    libMock.listDevices.mockResolvedValue({ devices: [], total: 0 });
    const res = await invoke("GET", "/api/network-devices");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });
});

describe("GET /api/network-devices list with filters", () => {
  it("forwards owner_role / trusted / unlabeled_only filters to the lib", async () => {
    libMock.listDevices.mockResolvedValue({
      devices: [{ mac_address: "aa:bb:cc:dd:ee:ff", label: "Tony's iPhone", owner_role: "family", trusted: true, hostnames: null, ip_addresses: null, ssids: null, device_type: "phone", device_vendor: "Apple", device_model: null, owner_person_id: "tony", expected_ssid: null, notes: null, first_seen: "", last_seen: "", last_labeled_by: "tony", last_labeled_at: null }],
      total: 1,
    });
    const res = await invoke("GET", "/api/network-devices?owner_role=family&trusted=true&unlabeled_only=false");
    expect(res.status).toBe(200);
    expect(libMock.listDevices).toHaveBeenCalledWith(expect.objectContaining({
      owner_role: "family",
      trusted: true,
      unlabeled_only: false,
    }));
    expect(res.body.total).toBe(1);
  });
});

describe("PUT /api/network-devices/:mac labels correctly", () => {
  it("forwards the patch + userId to the lib", async () => {
    libMock.labelDevice.mockResolvedValue({
      mac_address: "aa:bb:cc:dd:ee:ff",
      label: "Lana's iPad",
      owner_person_id: "lana",
      owner_role: "family",
      trusted: false,
      device_type: "tablet",
      device_vendor: null,
      device_model: null,
      hostnames: null, ip_addresses: null, ssids: null,
      expected_ssid: null, notes: null,
      first_seen: "", last_seen: "",
      last_labeled_by: "tony", last_labeled_at: "now",
    });
    const res = await invoke("PUT", "/api/network-devices/aa:bb:cc:dd:ee:ff", {
      label: "Lana's iPad",
      owner_person_id: "lana",
      owner_role: "family",
      device_type: "tablet",
    });
    expect(res.status).toBe(200);
    expect(libMock.labelDevice).toHaveBeenCalledWith(
      "aa:bb:cc:dd:ee:ff",
      expect.objectContaining({
        label: "Lana's iPad",
        owner_person_id: "lana",
        owner_role: "family",
        device_type: "tablet",
      }),
      "tony",
    );
    expect(res.body.label).toBe("Lana's iPad");
  });
});

describe("GET /api/network-devices/unknowns", () => {
  it("enriches each row with vendor_hint", async () => {
    libMock.unknownDevices.mockResolvedValue([{
      mac_address: "00:9b:08:ef:39:f1",
      label: null, owner_person_id: null, owner_role: null,
      device_type: null, device_vendor: null, device_model: null,
      hostnames: ["Kindle"], ip_addresses: ["10.0.22.145"], ssids: ["34_AV"],
      expected_ssid: null, trusted: false, notes: null,
      first_seen: "", last_seen: "", last_labeled_by: null, last_labeled_at: null,
    }]);
    const res = await invoke("GET", "/api/network-devices/unknowns?window_hours=12");
    expect(res.status).toBe(200);
    expect(libMock.unknownDevices).toHaveBeenCalledWith(12);
    expect(res.body.devices[0].vendor_hint).toBeDefined();
  });
});
