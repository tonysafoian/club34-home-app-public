/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import type { NextFunction, Response } from "express";

// The traffic route module pulls in auth, the FortiGate lib, db and storage at
// import time. We only want to unit-test the pure aggregateTopTalkersFromSessions
// helper it exports, so stub those deps to no-ops.
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.userRole = "admin";
    next();
  },
}));
class CircuitOpenError extends Error {}
vi.mock("../../lib/fortigate.js", () => ({
  fortigateRequest: vi.fn(async () => ({ results: [] })),
  getSummary: vi.fn(),
  isFortigateConfigured: vi.fn(() => true),
  getFortigateBaseUrl: vi.fn(() => "https://fortigate.test.local"),
  CircuitOpenError,
}));
vi.mock("../../lib/db.js", () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
}));
vi.mock("../../storage", () => ({
  storage: {
    getDeviceOverrides: vi.fn(async () => []),
  },
}));

const { aggregateTopTalkersFromSessions } = await import("../fortigate.js");

describe("aggregateTopTalkersFromSessions", () => {
  it("groups sessions by source IP, sums tx+rx bytes, sorts desc", () => {
    const data = {
      results: [
        { srcip: "10.0.22.10", tx_bytes: 1000, rx_bytes: 2000 },
        { srcip: "10.0.22.10", tx_bytes: 500, rx_bytes: 500 },
        { srcip: "10.0.22.20", tx_bytes: 100, rx_bytes: 100 },
      ],
    };
    const out = aggregateTopTalkersFromSessions(data);
    expect(out).toEqual([
      { ip: "10.0.22.10", bytes: 4000, tx_bytes: 1500, rx_bytes: 2500 },
      { ip: "10.0.22.20", bytes: 200, tx_bytes: 100, rx_bytes: 100 },
    ]);
  });

  it("accepts alternate source-ip and byte field names", () => {
    const data = {
      results: [
        { src: "10.0.22.30", out_bytes: 700, in_bytes: 300 },
        { source_ip: "10.0.22.40", bytes: 5000 },
        { saddr: "192.168.1.10", tx_bytes: 10 },
      ],
    };
    const out = aggregateTopTalkersFromSessions(data);
    // 10.0.22.40 ranks top (5000), then .30 (1000), then .50 (10).
    expect(out.map((t) => t.ip)).toEqual(["10.0.22.40", "10.0.22.30", "192.168.1.10"]);
    // lump-sum bytes attributed to rx so total still ranks.
    expect(out[0]).toMatchObject({ ip: "10.0.22.40", bytes: 5000, tx_bytes: 0, rx_bytes: 5000 });
    expect(out[1]).toMatchObject({ ip: "10.0.22.30", bytes: 1000, tx_bytes: 700, rx_bytes: 300 });
  });

  it("caps the result at the top 20 talkers", () => {
    const results = Array.from({ length: 30 }, (_, i) => ({
      srcip: `10.0.0.${i}`,
      tx_bytes: i + 1,
      rx_bytes: 0,
    }));
    const out = aggregateTopTalkersFromSessions({ results });
    expect(out).toHaveLength(20);
    // Highest byte count first.
    expect(out[0].ip).toBe("10.0.0.29");
  });

  it("skips zero-byte sessions and entries without a source IP", () => {
    const data = {
      results: [
        { srcip: "10.0.22.60", tx_bytes: 0, rx_bytes: 0 },
        { tx_bytes: 999, rx_bytes: 999 },
        { srcip: "10.0.22.70", tx_bytes: 5, rx_bytes: 5 },
      ],
    };
    const out = aggregateTopTalkersFromSessions(data);
    expect(out).toEqual([{ ip: "10.0.22.70", bytes: 10, tx_bytes: 5, rx_bytes: 5 }]);
  });

  it("returns [] for empty, missing, or malformed input", () => {
    expect(aggregateTopTalkersFromSessions(null)).toEqual([]);
    expect(aggregateTopTalkersFromSessions(undefined)).toEqual([]);
    expect(aggregateTopTalkersFromSessions({})).toEqual([]);
    expect(aggregateTopTalkersFromSessions({ results: [] })).toEqual([]);
    expect(aggregateTopTalkersFromSessions({ results: "nope" })).toEqual([]);
    expect(aggregateTopTalkersFromSessions("garbage")).toEqual([]);
  });
});
