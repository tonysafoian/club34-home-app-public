/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Response } from "express";

// verkada.ts pulls in auth, db, the pg pool and the socket layer at import time.
// We only want to exercise the POI alert parsing logic, so stub those deps and
// mock the network/db boundaries (global fetch + the db `query` used by
// getPoiLabelIdMap to read the poi_profiles roster).
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.userRole = "admin";
    next();
  },
  optionalAuth: (_req: any, _res: Response, next: NextFunction) => next(),
}));
vi.mock("../../auth.js", () => ({ getAuthUser: vi.fn(async () => null) }));
vi.mock("../../lib/auditLog.js", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../../socket.js", () => ({ emitToAll: vi.fn() }));

const queryMock = vi.fn(async (
  _sql: string,
  _params?: unknown[],
): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> => ({ rows: [], rowCount: 0 }));
vi.mock("../../lib/db.js", () => ({
  query: (...args: Parameters<typeof queryMock>) => queryMock(...args),
}));

const { fetchPoiAlerts } = await import("../verkada.js");

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

// Roster: "Isla" maps to a canonical verkada_person_id; "Tony" present too.
const ROSTER_ROWS = [
  { verkada_person_id: "PID_ISLA", label: "Isla" },
  { verkada_person_id: "PID_TONY", label: "Tony" },
];

function installFetch(notifications: any[]) {
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes("/token")) return jsonResponse({ token: "test-token" });
    if (u.includes("/cameras/v1/devices")) {
      return jsonResponse({ cameras: [{ camera_id: "cam-front", name: "Front Door" }] });
    }
    if (u.includes("/cameras/v1/alerts")) return jsonResponse({ notifications });
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: ROSTER_ROWS, rowCount: ROSTER_ROWS.length });
  process.env.VERKADA_API_KEY = "test-key";
  process.env.VERKADA_ORG_ID = "test-org";
});

describe("fetchPoiAlerts parsing", () => {
  it("resolves a person_label with no person_id to the roster person_id", async () => {
    installFetch([
      {
        notification_type: "person_of_interest",
        person_label: "Isla",
        camera_id: "cam-front",
        created: 1700000000,
      },
    ]);

    const result = await fetchPoiAlerts("test-key", "test-org", 1699990000, 1700001000);

    expect(result.ok).toBe(true);
    expect(result.sightings).toHaveLength(1);
    const s = result.sightings[0];
    expect(s.personId).toBe("PID_ISLA");
    expect(s.label).toBe("Isla");
    expect(s.cameraName).toBe("Front Door");
  });

  it("matches the roster label case-insensitively", async () => {
    installFetch([
      {
        notification_type: "person_of_interest",
        person_label: "  iSLA ",
        camera_id: "cam-front",
        created: 1700000123,
      },
    ]);

    const result = await fetchPoiAlerts("test-key", "test-org", 1699990000, 1700001000);
    expect(result.sightings[0].personId).toBe("PID_ISLA");
  });

  it("falls back to a label:<label> key when the label is not in the roster", async () => {
    installFetch([
      {
        notification_type: "person_of_interest",
        person_label: "Unknown Visitor",
        camera_id: "cam-front",
        created: 1700000200,
      },
    ]);

    const result = await fetchPoiAlerts("test-key", "test-org", 1699990000, 1700001000);
    expect(result.sightings).toHaveLength(1);
    expect(result.sightings[0].personId).toBe("label:unknown visitor");
  });

  it("prefers an explicit person_id over the roster label match", async () => {
    installFetch([
      {
        notification_type: "person_of_interest",
        person_label: "Isla",
        person_id: "EXPLICIT_ID",
        camera_id: "cam-front",
        created: 1700000300,
      },
    ]);

    const result = await fetchPoiAlerts("test-key", "test-org", 1699990000, 1700001000);
    expect(result.sightings[0].personId).toBe("EXPLICIT_ID");
  });

  it("keeps only person_of_interest notifications, dropping other types", async () => {
    installFetch([
      { notification_type: "person_of_interest", person_label: "Isla", camera_id: "cam-front", created: 1700000400 },
      { notification_type: "motion", person_label: "Isla", camera_id: "cam-front", created: 1700000401 },
      { notification_type: "tamper", camera_id: "cam-front", created: 1700000402 },
      { notification_type: "crowd", camera_id: "cam-front", created: 1700000403 },
    ]);

    const result = await fetchPoiAlerts("test-key", "test-org", 1699990000, 1700001000);
    // fetched counts every raw record, but only the POI sighting is normalized.
    expect(result.fetched).toBe(4);
    expect(result.sightings).toHaveLength(1);
    expect(result.sightings[0].personId).toBe("PID_ISLA");
  });

  it("produces a stable dedup_key of poi_<personId>_<cameraId>_<ts>", async () => {
    installFetch([
      {
        notification_type: "person_of_interest",
        person_label: "Isla",
        camera_id: "cam-front",
        created: 1700000500,
      },
      {
        notification_type: "person_of_interest",
        person_label: "Walk-in",
        camera_id: "cam-front",
        created: 1700000600,
      },
    ]);

    const result = await fetchPoiAlerts("test-key", "test-org", 1699990000, 1700001000);
    expect(result.sightings[0].dedupKey).toBe("poi_PID_ISLA_cam-front_1700000500");
    // unmatched label falls back to the label key inside the same dedup shape.
    expect(result.sightings[1].dedupKey).toBe("poi_label:walk-in_cam-front_1700000600");
  });

  it("returns ok:false with the upstream status when the alerts call fails", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/token")) return jsonResponse({ token: "test-token" });
      if (u.includes("/cameras/v1/devices")) return jsonResponse({ cameras: [] });
      if (u.includes("/cameras/v1/alerts")) return jsonResponse({ error: "forbidden" }, 403);
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchPoiAlerts("test-key", "test-org", 1699990000, 1700001000);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.sightings).toHaveLength(0);
  });
});
