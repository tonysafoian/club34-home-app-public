/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";

// getConnectionCacheFreshness() summarises MIN/MAX/COUNT over
// network_devices.resolved_connection_at — the numbers behind the admin
// "labels refreshed N min ago" indicator. We mock the raw db.query layer and
// drive its result rows so we can assert the timestamp coercion and the
// fail-soft empty summary without touching Postgres.

const queryMock = vi.fn();
vi.mock("../db.js", () => ({
  query: (...args: any[]) => queryMock(...args),
}));

const { getConnectionCacheFreshness } = await import("../connection-cache.js");

beforeEach(() => {
  queryMock.mockReset();
});

describe("getConnectionCacheFreshness", () => {
  it("returns oldest/newest epoch-ms and count from Date columns", async () => {
    const oldest = new Date("2026-06-19T10:00:00.000Z");
    const newest = new Date("2026-06-19T10:25:00.000Z");
    queryMock.mockResolvedValue({ rows: [{ oldest, newest, cnt: 7 }], rowCount: 1 });

    const out = await getConnectionCacheFreshness();
    expect(out).toEqual({
      oldest: oldest.getTime(),
      newest: newest.getTime(),
      count: 7,
    });
  });

  it("coerces string timestamps and a string count", async () => {
    queryMock.mockResolvedValue({
      rows: [
        {
          oldest: "2026-06-19T10:00:00.000Z",
          newest: "2026-06-19T10:25:00.000Z",
          cnt: "12",
        },
      ],
      rowCount: 1,
    });

    const out = await getConnectionCacheFreshness();
    expect(out.oldest).toBe(new Date("2026-06-19T10:00:00.000Z").getTime());
    expect(out.newest).toBe(new Date("2026-06-19T10:25:00.000Z").getTime());
    expect(out.count).toBe(12);
  });

  it("queries resolved_connection_at on network_devices", async () => {
    queryMock.mockResolvedValue({ rows: [{ oldest: null, newest: null, cnt: 0 }], rowCount: 1 });
    await getConnectionCacheFreshness();
    const sql = String(queryMock.mock.calls[0]?.[0] ?? "").toLowerCase();
    expect(sql).toContain("resolved_connection_at");
    expect(sql).toContain("from network_devices");
    expect(sql).toContain("min(");
    expect(sql).toContain("max(");
  });

  it("returns an empty summary when the cache has no rows (all NULL aggregates)", async () => {
    queryMock.mockResolvedValue({ rows: [{ oldest: null, newest: null, cnt: 0 }], rowCount: 1 });
    expect(await getConnectionCacheFreshness()).toEqual({ oldest: null, newest: null, count: 0 });
  });

  it("returns an empty summary when the result set has no row at all", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await getConnectionCacheFreshness()).toEqual({ oldest: null, newest: null, count: 0 });
  });

  it("nulls out an unparseable timestamp rather than emitting NaN", async () => {
    queryMock.mockResolvedValue({
      rows: [{ oldest: "not-a-date", newest: new Date("2026-06-19T10:25:00.000Z"), cnt: 3 }],
      rowCount: 1,
    });
    const out = await getConnectionCacheFreshness();
    expect(out.oldest).toBeNull();
    expect(out.newest).toBe(new Date("2026-06-19T10:25:00.000Z").getTime());
    expect(out.count).toBe(3);
  });

  it("returns an empty summary (never throws) when the DB query fails", async () => {
    queryMock.mockRejectedValue(new Error("connection terminated unexpectedly"));
    expect(await getConnectionCacheFreshness()).toEqual({ oldest: null, newest: null, count: 0 });
  });
});
