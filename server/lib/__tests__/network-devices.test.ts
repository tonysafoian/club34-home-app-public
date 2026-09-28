/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";

// We mock the raw query layer the lib uses. The lib reads from
// network_devices via parameterised SQL; we capture the calls and
// drive their results from a small in-memory mock.

interface MockRow {
  mac_address: string;
  label: string | null;
  owner_person_id: string | null;
  owner_role: string | null;
  device_type: string | null;
  device_vendor: string | null;
  device_model: string | null;
  hostnames: string[] | null;
  ip_addresses: string[] | null;
  ssids: string[] | null;
  expected_ssid: string | null;
  trusted: boolean;
  notes: string | null;
  first_seen: Date;
  last_seen: Date;
  last_labeled_by: string | null;
  last_labeled_at: Date | null;
}

const rows = new Map<string, MockRow>();

function emptyRow(mac: string): MockRow {
  return {
    mac_address: mac,
    label: null,
    owner_person_id: null,
    owner_role: null,
    device_type: null,
    device_vendor: null,
    device_model: null,
    hostnames: null,
    ip_addresses: null,
    ssids: null,
    expected_ssid: null,
    trusted: false,
    notes: null,
    first_seen: new Date(),
    last_seen: new Date(),
    last_labeled_by: null,
    last_labeled_at: null,
  };
}

const queryMock = vi.fn(async (sql: string, params?: any[]) => {
  const lower = sql.toLowerCase();
  // SELECT hostnames, ip_addresses, ssids FROM network_devices WHERE mac_address = $1
  if (lower.includes("select hostnames, ip_addresses, ssids")) {
    const mac = params?.[0] as string;
    const row = rows.get(mac);
    return row
      ? { rows: [{ hostnames: row.hostnames, ip_addresses: row.ip_addresses, ssids: row.ssids }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  // INSERT ... ON CONFLICT (mac_address) DO UPDATE
  if (lower.includes("insert into network_devices") && lower.includes("on conflict")) {
    const [mac, vendor, hostnamesJson, ipsJson, ssidsJson] = params ?? [];
    const existing = rows.get(mac as string) ?? emptyRow(mac as string);
    existing.hostnames = hostnamesJson ? JSON.parse(hostnamesJson as string) : existing.hostnames;
    existing.ip_addresses = ipsJson ? JSON.parse(ipsJson as string) : existing.ip_addresses;
    existing.ssids = ssidsJson ? JSON.parse(ssidsJson as string) : existing.ssids;
    if (vendor && !existing.device_vendor) existing.device_vendor = vendor as string;
    existing.last_seen = new Date();
    rows.set(mac as string, existing);
    return { rows: [], rowCount: 1 };
  }
  // Stub insert for labelDevice (INSERT ... DO NOTHING)
  if (lower.includes("insert into network_devices") && lower.includes("do nothing")) {
    const mac = params?.[0] as string;
    if (!rows.has(mac)) rows.set(mac, emptyRow(mac));
    return { rows: [], rowCount: 1 };
  }
  // UPDATE network_devices SET ... — manually parse the SET pairs.
  if (lower.startsWith("update network_devices set")) {
    const mac = params?.[params.length - 1] as string;
    const row = rows.get(mac);
    if (!row) return { rows: [], rowCount: 0 };
    // Walk the SET clause: 'col1 = $1, col2 = $2, ..., last_labeled_at = now()'
    const setClause = sql.slice(sql.toLowerCase().indexOf("set ") + 4, sql.toLowerCase().indexOf(" where"));
    const assignments = setClause.split(",").map((s) => s.trim());
    for (const a of assignments) {
      const m = /^(\w+)\s*=\s*\$(\d+)/.exec(a);
      if (m) {
        const col = m[1];
        const idx = parseInt(m[2], 10) - 1;
        (row as any)[col] = params?.[idx];
      } else if (/last_labeled_at\s*=\s*now\(\)/.test(a)) {
        row.last_labeled_at = new Date();
      }
    }
    return { rows: [], rowCount: 1 };
  }
  // getDevicesByIps: SELECT mac_address, label, hostnames, ip_addresses, last_seen
  //   FROM network_devices WHERE ip_addresses ?| $1::text[] ORDER BY last_seen DESC
  if (lower.includes("from network_devices") && lower.includes("ip_addresses ?|")) {
    const ips = (params?.[0] as string[] | undefined) ?? [];
    const candidates = Array.from(rows.values()).filter(
      (r) => Array.isArray(r.ip_addresses) && r.ip_addresses.some((ip) => ips.includes(ip)),
    );
    candidates.sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime());
    return {
      rows: candidates.map((r) => ({
        mac_address: r.mac_address,
        label: r.label,
        hostnames: r.hostnames,
        ip_addresses: r.ip_addresses,
        last_seen: r.last_seen,
      })),
      rowCount: candidates.length,
    };
  }
  // SELECT * FROM network_devices WHERE mac_address = $1
  if (lower.includes("select * from network_devices") && lower.includes("mac_address = $1") && !lower.includes("count(")) {
    const mac = params?.[0] as string;
    const row = rows.get(mac);
    return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  // SELECT COUNT(*) for listDevices
  if (lower.includes("select count(*)")) {
    let candidates = Array.from(rows.values());
    // Reuse the same WHERE parsing from list query below
    candidates = filterListCandidates(sql, params ?? [], candidates);
    return { rows: [{ c: candidates.length }], rowCount: 1 };
  }
  // SELECT * FROM network_devices [WHERE …] ORDER BY last_seen DESC LIMIT/OFFSET
  if (lower.startsWith("select * from network_devices")) {
    let candidates = Array.from(rows.values());
    if (lower.includes("label is null and owner_person_id is null and trusted = false")) {
      // unknownDevices
      candidates = candidates.filter((r) => r.label == null && r.owner_person_id == null && !r.trusted);
    } else {
      candidates = filterListCandidates(sql, params ?? [], candidates);
    }
    candidates.sort((a, b) => b.last_seen.getTime() - a.last_seen.getTime());
    return { rows: candidates, rowCount: candidates.length };
  }
  // DELETE
  if (lower.startsWith("delete from network_devices")) {
    const mac = params?.[0] as string;
    const had = rows.delete(mac);
    return { rows: [], rowCount: had ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
});

function filterListCandidates(sql: string, params: any[], rs: MockRow[]): MockRow[] {
  let out = rs;
  // Strip everything after the WHERE through end-of-query / ORDER / LIMIT.
  const lowered = sql.toLowerCase();
  const whereIdx = lowered.indexOf("where ");
  if (whereIdx === -1) return out;
  let clause = sql.slice(whereIdx + 6);
  const stopMatch = /\b(order|limit|offset)\b/i.exec(clause);
  if (stopMatch) clause = clause.slice(0, stopMatch.index);
  const parts = clause.split(/\s+and\s+/i);
  for (const part of parts) {
    const m = /(\w+)\s*=\s*\$(\d+)/.exec(part);
    if (!m) continue;
    const col = m[1];
    const idx = parseInt(m[2], 10) - 1;
    const value = params[idx];
    out = out.filter((r) => (r as any)[col] === value);
  }
  return out;
}

vi.mock("../db.js", () => ({
  query: (...args: any[]) => queryMock(args[0], args[1]),
}));

const {
  upsertObservedDevice,
  getDevice,
  getDevicesByIps,
  listDevices,
  unknownDevices,
  labelDevice,
  inferVendorFromMac,
  deleteDevice,
  macFromDeviceTrackerId,
  backfillFromDeviceTrackers,
} = await import("../network-devices.js");

beforeEach(() => {
  rows.clear();
  queryMock.mockClear();
});

describe("inferVendorFromMac", () => {
  it("returns Apple for an Apple-OUI MAC", () => {
    expect(inferVendorFromMac("00:1c:b3:aa:bb:cc")).toBe("Apple");
    expect(inferVendorFromMac("3C:22:FB:11:22:33")).toBe("Apple");
  });
  it("returns Amazon for a Kindle/Echo OUI", () => {
    expect(inferVendorFromMac("00:9b:08:ef:39:f1")).toBe("Amazon");
  });
  it("returns Google for a Nest/Chromecast OUI", () => {
    expect(inferVendorFromMac("f4:f5:e8:00:00:01")).toBe("Google");
  });
  it("returns null for an unknown OUI", () => {
    expect(inferVendorFromMac("aa:bb:cc:dd:ee:ff")).toBeNull();
  });
  it("handles null / short / dash-separated input gracefully", () => {
    expect(inferVendorFromMac(null)).toBeNull();
    expect(inferVendorFromMac("")).toBeNull();
    expect(inferVendorFromMac("00-1c-b3-aa-bb-cc")).toBe("Apple");
  });
});

describe("upsertObservedDevice", () => {
  it("inserts a new device with the inferred vendor", async () => {
    await upsertObservedDevice({
      mac: "00:1c:b3:aa:bb:cc",
      ip: "192.168.1.10",
      hostname: "iPad",
      ssid: "34",
    });
    const dev = await getDevice("00:1c:b3:aa:bb:cc");
    expect(dev).not.toBeNull();
    expect(dev!.device_vendor).toBe("Apple");
    expect(dev!.hostnames).toContain("iPad");
    expect(dev!.ip_addresses).toContain("192.168.1.10");
    expect(dev!.ssids).toContain("34");
  });

  it("accumulates new hostnames / IPs / SSIDs without duplicating", async () => {
    await upsertObservedDevice({ mac: "00:1c:b3:01:02:03", ip: "192.168.1.10", hostname: "iPad", ssid: "34" });
    await upsertObservedDevice({ mac: "00:1c:b3:01:02:03", ip: "192.168.1.10", hostname: "iPad", ssid: "34" });
    await upsertObservedDevice({ mac: "00:1c:b3:01:02:03", ip: "10.0.22.99", hostname: "iPad-2", ssid: "34_AV" });
    const dev = await getDevice("00:1c:b3:01:02:03");
    expect(dev!.hostnames!.sort()).toEqual(["iPad", "iPad-2"]);
    expect(dev!.ip_addresses!.sort()).toEqual(["10.0.22.99", "192.168.1.10"]);
    expect(dev!.ssids!.sort()).toEqual(["34", "34_AV"]);
  });

  it("normalises the MAC to lowercase with colon separators", async () => {
    await upsertObservedDevice({ mac: "00-1C-B3-AA-BB-CC", ip: "192.168.1.10" });
    expect(await getDevice("00:1c:b3:aa:bb:cc")).not.toBeNull();
  });

  it("never overwrites a non-null device_vendor", async () => {
    await upsertObservedDevice({ mac: "aa:bb:cc:dd:ee:ff", ip: "10.0.22.10" });
    await labelDevice("aa:bb:cc:dd:ee:ff", { device_vendor: "Custom Co" }, "tony");
    await upsertObservedDevice({ mac: "aa:bb:cc:dd:ee:ff", ip: "10.0.22.11" });
    const dev = await getDevice("aa:bb:cc:dd:ee:ff");
    expect(dev!.device_vendor).toBe("Custom Co");
  });
});

describe("labelDevice", () => {
  it("creates the row if missing and applies the patch", async () => {
    const updated = await labelDevice(
      "11:22:33:44:55:66",
      { label: "Lana's iPad", owner_person_id: "lana", owner_role: "family", device_type: "tablet" },
      "tony",
    );
    expect(updated).not.toBeNull();
    expect(updated!.label).toBe("Lana's iPad");
    expect(updated!.owner_person_id).toBe("lana");
    expect(updated!.last_labeled_by).toBe("tony");
    expect(updated!.last_labeled_at).not.toBeNull();
  });

  it("preserves unrelated fields when patching a subset", async () => {
    await labelDevice("11:22:33:44:55:66", { label: "Old Label", owner_role: "family" }, "tony");
    await labelDevice("11:22:33:44:55:66", { trusted: true }, "janus");
    const dev = await getDevice("11:22:33:44:55:66");
    expect(dev!.label).toBe("Old Label");
    expect(dev!.owner_role).toBe("family");
    expect(dev!.trusted).toBe(true);
    expect(dev!.last_labeled_by).toBe("janus");
  });
});

describe("unknownDevices", () => {
  it("returns only rows with no label, no owner, not trusted", async () => {
    // Set up: one labeled, one trusted, one true unknown.
    await upsertObservedDevice({ mac: "aa:00:00:00:00:01" });
    await labelDevice("aa:00:00:00:00:01", { label: "Labeled" }, "tony");

    await upsertObservedDevice({ mac: "aa:00:00:00:00:02" });
    await labelDevice("aa:00:00:00:00:02", { trusted: true }, "tony");

    await upsertObservedDevice({ mac: "aa:00:00:00:00:03" });

    const unknowns = await unknownDevices(24);
    const macs = unknowns.map((d) => d.mac_address);
    expect(macs).toContain("aa:00:00:00:00:03");
    expect(macs).not.toContain("aa:00:00:00:00:01");
    expect(macs).not.toContain("aa:00:00:00:00:02");
  });
});

describe("listDevices filters", () => {
  beforeEach(async () => {
    await upsertObservedDevice({ mac: "ff:00:00:00:00:01" });
    await labelDevice("ff:00:00:00:00:01", { owner_role: "family", trusted: true, device_type: "phone" }, "tony");
    await upsertObservedDevice({ mac: "ff:00:00:00:00:02" });
    await labelDevice("ff:00:00:00:00:02", { owner_role: "iot", trusted: true, device_type: "speaker" }, "tony");
    await upsertObservedDevice({ mac: "ff:00:00:00:00:03" });
    await labelDevice("ff:00:00:00:00:03", { owner_role: "family", trusted: false, device_type: "tablet" }, "tony");
  });

  it("filters by owner_role", async () => {
    const r = await listDevices({ owner_role: "family" });
    expect(r.total).toBe(2);
  });

  it("filters by trusted", async () => {
    const r = await listDevices({ trusted: true });
    expect(r.total).toBe(2);
  });

  it("filters by device_type", async () => {
    const r = await listDevices({ device_type: "speaker" });
    expect(r.total).toBe(1);
  });
});

describe("macFromDeviceTrackerId", () => {
  it("parses a MAC-based device_tracker entity_id", () => {
    expect(macFromDeviceTrackerId("device_tracker.00_e6_3a_29_d5_a0")).toBe("00:e6:3a:29:d5:a0");
  });
  it("returns null for named (non-MAC) trackers", () => {
    expect(macFromDeviceTrackerId("device_tracker.alarm")).toBeNull();
    expect(macFromDeviceTrackerId("device_tracker.flologic70e76b")).toBeNull();
  });
});

describe("backfillFromDeviceTrackers", () => {
  it("upserts MAC-based trackers and skips named ones", async () => {
    const result = await backfillFromDeviceTrackers([
      { entity_id: "device_tracker.00_e6_3a_29_d5_a0", state: "not_home", attributes: { friendly_name: "00_e6_3a_29_d5_a0" } },
      { entity_id: "device_tracker.alarm", state: "not_home", attributes: { friendly_name: "ALARM" } },
      { entity_id: "device_tracker.aa_bb_cc_dd_ee_ff", state: "home", attributes: { friendly_name: "Tony iPhone" } },
    ]);
    expect(result.scanned).toBe(3);
    expect(result.mac_based).toBe(2);
    expect(result.upserted).toBe(2);
    expect(result.named_skipped).toBe(1);
    expect(rows.has("aa:bb:cc:dd:ee:ff")).toBe(true);
  });
});

describe("deleteDevice", () => {
  it("removes the row and returns true", async () => {
    await upsertObservedDevice({ mac: "de:ad:be:ef:00:01" });
    expect(await deleteDevice("de:ad:be:ef:00:01")).toBe(true);
    expect(await getDevice("de:ad:be:ef:00:01")).toBeNull();
  });
  it("returns false when the row never existed", async () => {
    expect(await deleteDevice("de:ad:be:ef:99:99")).toBe(false);
  });
});

describe("getDevicesByIps", () => {
  function seedRow(partial: Partial<MockRow> & { mac_address: string }): void {
    const row = emptyRow(partial.mac_address);
    Object.assign(row, partial);
    rows.set(row.mac_address, row);
  }

  it("short-circuits on empty / whitespace-only input without querying the DB", async () => {
    const a = await getDevicesByIps([]);
    expect(a.size).toBe(0);
    const b = await getDevicesByIps(["", "   "]);
    expect(b.size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("resolves a batch of IPs to label + hostname + mac in one query", async () => {
    seedRow({
      mac_address: "aa:bb:cc:00:00:01",
      label: "Tony's iPhone",
      hostnames: ["iPhone"],
      ip_addresses: ["10.0.22.10"],
    });
    seedRow({
      mac_address: "aa:bb:cc:00:00:02",
      label: null,
      hostnames: ["kindle-fire"],
      ip_addresses: ["10.0.22.20"],
    });

    const map = await getDevicesByIps(["10.0.22.10", "10.0.22.20"]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(map.get("10.0.22.10")).toEqual({
      mac: "aa:bb:cc:00:00:01",
      label: "Tony's iPhone",
      hostname: "iPhone",
    });
    expect(map.get("10.0.22.20")).toEqual({
      mac: "aa:bb:cc:00:00:02",
      label: null,
      hostname: "kindle-fire",
    });
  });

  it("matches an IP held in a multi-IP jsonb ip_addresses array", async () => {
    seedRow({
      mac_address: "aa:bb:cc:00:00:03",
      label: "Office iMac",
      hostnames: ["imac"],
      ip_addresses: ["10.0.22.30", "10.0.23.30"],
    });
    const map = await getDevicesByIps(["10.0.23.30"]);
    expect(map.get("10.0.23.30")?.mac).toBe("aa:bb:cc:00:00:03");
    expect(map.get("10.0.23.30")?.label).toBe("Office iMac");
  });

  it("most-recently-seen device wins when two devices share a reused (DHCP) IP", async () => {
    seedRow({
      mac_address: "aa:bb:cc:00:00:04",
      label: "Old Tenant Laptop",
      hostnames: ["old-laptop"],
      ip_addresses: ["10.0.22.40"],
      last_seen: new Date("2026-01-01T00:00:00Z"),
    });
    seedRow({
      mac_address: "aa:bb:cc:00:00:05",
      label: "New Tenant Laptop",
      hostnames: ["new-laptop"],
      ip_addresses: ["10.0.22.40"],
      last_seen: new Date("2026-06-01T00:00:00Z"),
    });
    const map = await getDevicesByIps(["10.0.22.40"]);
    expect(map.get("10.0.22.40")?.mac).toBe("aa:bb:cc:00:00:05");
    expect(map.get("10.0.22.40")?.label).toBe("New Tenant Laptop");
  });

  it("omits IPs with no matching device (caller falls back to the raw IP)", async () => {
    seedRow({
      mac_address: "aa:bb:cc:00:00:06",
      label: "Known",
      ip_addresses: ["192.168.1.10"],
    });
    const map = await getDevicesByIps(["192.168.1.10", "10.0.22.99"]);
    expect(map.has("192.168.1.10")).toBe(true);
    expect(map.has("10.0.22.99")).toBe(false);
  });

  it("returns a null hostname when the device has no observed hostnames", async () => {
    seedRow({
      mac_address: "aa:bb:cc:00:00:07",
      label: "Labeled but unobserved",
      hostnames: null,
      ip_addresses: ["10.0.22.60"],
    });
    const map = await getDevicesByIps(["10.0.22.60"]);
    expect(map.get("10.0.22.60")?.hostname).toBeNull();
    expect(map.get("10.0.22.60")?.label).toBe("Labeled but unobserved");
  });
});
