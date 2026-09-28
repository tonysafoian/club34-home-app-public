/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../auditLog.js", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../db.js", () => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.FORTIGATE_BASE_URL = "https://fortigate.test.local";
  process.env.FORTIGATE_API_TOKEN = "test-bearer-token";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- Sample fixtures (shaped from fortigate_api_notes.md) ---------------

const SAMPLE_STATUS = {
  http_method: "GET",
  results: {
    model: "FortiGate",
    model_number: "60F",
    hostname: "FortiGate-60F-34BevPark",
    serial: "FGT60FTK2309AWBR",
    version: "v7.2.13",
    build: 1762,
    vdom: "root",
  },
  status: "success",
};

const SAMPLE_RESOURCE = {
  results: {
    cpu: [{ current: 18, average: 17 }, { current: 22, average: 19 }],
    cpu60: [{ current: 20, average: 19 }],
    mem: [{ current: 41, average: 40 }, { current: 42, average: 41 }],
    session: [{ current: 348, average: 350 }],
  },
};

const SAMPLE_INTERFACES = {
  results: [
    { name: "wan1", link: true, speed: 1000, rx_bytes: 12345, tx_bytes: 67890, rx_packets: 100, tx_packets: 110, role: "wan" },
    { name: "internal", link: true, speed: 1000, rx_bytes: 555, tx_bytes: 666, role: "lan" },
    { name: "wan2", link: false, speed: 0 },
  ],
};

const SAMPLE_SESSIONS = {
  results: [
    { proto: "udp", srcintf: "internal", src: "10.0.22.32", sport: 59916, srcmac: "ac:80:0a:b4:a1:67", dstintf: "wan1", dst: "74.125.103.70", dport: 443, country: "United States", policy_id: 1, duration: 59, snaddr: "142.129.117.139", rx_bytes: 1024, tx_bytes: 2048 },
    { proto: "tcp", srcintf: "internal", src: "192.168.1.10", sport: 443, dstintf: "wan1", dst: "1.2.3.4", dport: 443, policy_id: 1, duration: 12 },
  ],
};

const SAMPLE_ARP = {
  results: [
    { mac: "aa:bb:cc:dd:ee:01", ip: "192.168.1.1", interface: "internal", age: 30 },
    { mac: "aa:bb:cc:dd:ee:02", ip: "10.0.22.6", interface: "internal", age: 5 },
  ],
};

const SAMPLE_DHCP = {
  results: [
    {
      interface: "internal",
      lease: [
        { mac: "aa:bb:cc:dd:ee:01", ip: "10.0.22.21", hostname: "iPad", expire_time: 1715000000, status: "leased" },
        { mac: "aa:bb:cc:dd:ee:02", ip: "10.0.22.22", hostname: "Kindle", expire_time: 1715001000, status: "leased" },
      ],
    },
  ],
};

const SAMPLE_THREATS = {
  results: [
    { eventtime: 1715000000, severity: "high", action: "blocked", srcip: "1.2.3.4", dstip: "192.168.1.1", attackname: "SQL.Injection", attackid: "12345", msg: "SQLi attempt blocked" },
  ],
};

const SAMPLE_WEBFILTER = {
  results: [
    { eventtime: 1715000000, action: "blocked", srcip: "10.0.22.32", hostname: "malicious.example.com", msg: "URL blocked by category filter" },
  ],
};

const SAMPLE_POLICIES = {
  results: [
    { policyid: 1, name: "allow-internal-out", hit_count: 1234, bytes_in: 1000000, bytes_out: 2000000 },
    { policyid: 2, name: "deny-default", hit_count: 5 },
  ],
};

// --- Tests --------------------------------------------------------------

describe("FORTIGATE_API_TOKEN guard", () => {
  it("throws a clear error when FORTIGATE_API_TOKEN is empty", async () => {
    vi.resetModules();
    process.env.FORTIGATE_API_TOKEN = "";
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { getSystemStatus } = await import("../fortigate.js");
    await expect(getSystemStatus()).rejects.toThrow(/FORTIGATE_API_TOKEN/);
    vi.resetModules();
    process.env.FORTIGATE_API_TOKEN = "test-bearer-token";
  });
});

describe("Bearer token header", () => {
  it("sends Authorization: Bearer <token> on every request", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async (_u: any, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-bearer-token");
      return jsonResponse(SAMPLE_STATUS);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getSystemStatus } = await import("../fortigate.js");
    await getSystemStatus();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("getSystemStatus", () => {
  it("parses the FortiGate-60F status payload into the documented shape", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toBe("https://fortigate.test.local/api/v2/monitor/system/status");
      return jsonResponse(SAMPLE_STATUS);
    }) as unknown) as typeof fetch;
    const { getSystemStatus } = await import("../fortigate.js");
    const status = await getSystemStatus();
    expect(status).toMatchObject({
      model: "FortiGate",
      model_number: "60F",
      hostname: "FortiGate-60F-34BevPark",
      serial: "FGT60FTK2309AWBR",
      version: "v7.2.13",
      build: 1762,
      vdom: "root",
    });
  });
});

describe("getResourceUsage", () => {
  it("extracts CPU + memory + session count from the resource history payload", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () => jsonResponse(SAMPLE_RESOURCE)) as unknown) as typeof fetch;
    const { getResourceUsage } = await import("../fortigate.js");
    const r = await getResourceUsage();
    expect(r.cpu_current).toBe(18);
    expect(r.cpu_1hour_avg).toBe(20);
    expect(r.mem_current).toBe(41);
    expect(r.session_count).toBe(348);
    expect(r.history.cpu_1min).toEqual([18, 22]);
    expect(r.history.mem_1min).toEqual([41, 42]);
  });
});

describe("getInterfaces", () => {
  it("returns one entry per interface with role inferred from the name when not provided", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () => jsonResponse(SAMPLE_INTERFACES)) as unknown) as typeof fetch;
    const { getInterfaces } = await import("../fortigate.js");
    const ifaces = await getInterfaces();
    expect(ifaces).toHaveLength(3);
    expect(ifaces[0]).toMatchObject({
      name: "wan1",
      link: true,
      speed_mbps: 1000,
      rx_bytes: 12345,
      tx_bytes: 67890,
      role: "wan",
    });
    // internal: role explicitly "lan" so inference doesn't override
    expect(ifaces[1].role).toBe("lan");
    // wan2: link=false, role inferred from name
    expect(ifaces[2].link).toBe(false);
    expect(ifaces[2].role).toBe("wan");
  });
});

describe("getActiveSessions", () => {
  it("parses live sessions with src MAC, dst country, and NAT addr", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toContain("/api/v2/monitor/firewall/session?count=5");
      return jsonResponse(SAMPLE_SESSIONS);
    }) as unknown) as typeof fetch;
    const { getActiveSessions } = await import("../fortigate.js");
    const sessions = await getActiveSessions(5);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      proto: "udp",
      src_intf: "internal",
      src_ip: "10.0.22.32",
      src_port: 59916,
      src_mac: "ac:80:0a:b4:a1:67",
      dst_intf: "wan1",
      dst_ip: "74.125.103.70",
      dst_port: 443,
      country: "United States",
      policy_id: 1,
      duration: 59,
      snaddr: "142.129.117.139",
    });
  });
});

describe("getArpTable + getDhcpLeases", () => {
  it("parses the ARP table into mac/ip/interface tuples", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () => jsonResponse(SAMPLE_ARP)) as unknown) as typeof fetch;
    const { getArpTable } = await import("../fortigate.js");
    const arp = await getArpTable();
    expect(arp).toEqual([
      expect.objectContaining({ mac: "aa:bb:cc:dd:ee:01", ip: "192.168.1.1", interface: "internal", age: 30 }),
      expect.objectContaining({ mac: "aa:bb:cc:dd:ee:02", ip: "10.0.22.6", interface: "internal", age: 5 }),
    ]);
  });

  it("flattens DHCP pool->lease arrays into a list of leases per device", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () => jsonResponse(SAMPLE_DHCP)) as unknown) as typeof fetch;
    const { getDhcpLeases } = await import("../fortigate.js");
    const leases = await getDhcpLeases();
    expect(leases).toHaveLength(2);
    expect(leases[0]).toMatchObject({
      mac: "aa:bb:cc:dd:ee:01",
      ip: "10.0.22.21",
      hostname: "iPad",
      interface: "internal",
      expires_at: 1715000000,
      status: "leased",
    });
  });
});

describe("getRecentThreats + getRecentWebFilterBlocks", () => {
  it("parses an IPS log entry into the structured shape", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toContain("logtype=ips");
      return jsonResponse(SAMPLE_THREATS);
    }) as unknown) as typeof fetch;
    const { getRecentThreats } = await import("../fortigate.js");
    const threats = await getRecentThreats(10, 1);
    expect(threats).toHaveLength(1);
    expect(threats[0]).toMatchObject({
      severity: "high",
      action: "blocked",
      src_ip: "1.2.3.4",
      dst_ip: "192.168.1.1",
      signature: "SQL.Injection",
      attack_id: "12345",
    });
    expect(threats[0].timestamp).toBeDefined();
  });

  it("parses webfilter blocks", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toContain("logtype=webfilter");
      return jsonResponse(SAMPLE_WEBFILTER);
    }) as unknown) as typeof fetch;
    const { getRecentWebFilterBlocks } = await import("../fortigate.js");
    const blocks = await getRecentWebFilterBlocks(10, 1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].action).toBe("blocked");
    expect(blocks[0].src_ip).toBe("10.0.22.32");
  });
});

describe("getPolicyStats", () => {
  it("maps FortiOS field names into the documented shape", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toContain("summary=true");
      return jsonResponse(SAMPLE_POLICIES);
    }) as unknown) as typeof fetch;
    const { getPolicyStats } = await import("../fortigate.js");
    const policies = await getPolicyStats();
    expect(policies).toEqual([
      expect.objectContaining({ policy_id: 1, name: "allow-internal-out", hits: 1234, bytes_in: 1000000, bytes_out: 2000000 }),
      expect.objectContaining({ policy_id: 2, name: "deny-default", hits: 5 }),
    ]);
  });
});

describe("getTopBandwidthConsumers", () => {
  it("aggregates sessions by src_ip and returns sorted bandwidth consumers", async () => {
    vi.resetModules();
    const heavySessions = {
      results: [
        { src: "10.0.22.32", srcmac: "ac:80:0a:b4:a1:67", rx_bytes: 5000, tx_bytes: 5000 },
        { src: "10.0.22.32", rx_bytes: 1000, tx_bytes: 1000 },
        { src: "192.168.1.10", rx_bytes: 100, tx_bytes: 100 },
      ],
    };
    globalThis.fetch = (vi.fn(async () => jsonResponse(heavySessions)) as unknown) as typeof fetch;
    const { getTopBandwidthConsumers } = await import("../fortigate.js");
    const top = await getTopBandwidthConsumers(1, 5);
    expect(top[0].src_ip).toBe("10.0.22.32");
    expect(top[0].bytes).toBe(12000);
    expect(top[0].session_count).toBe(2);
    expect(top[0].src_mac).toBe("ac:80:0a:b4:a1:67");
    expect(top[1].src_ip).toBe("192.168.1.10");
  });
});

describe("401 handling", () => {
  it("surfaces a clear authentication error on 401 — no retry (static token)", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () =>
      new Response("Unauthorized", { status: 401 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { getSystemStatus } = await import("../fortigate.js");
    await expect(getSystemStatus()).rejects.toThrow(/FORTIGATE_API_TOKEN|authentication failed/i);
    // No retry — the static token is the static token.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an HTML response (login redirect) as a token-permissions failure", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () =>
      new Response("<html><body>login</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    ) as unknown) as typeof fetch;
    const { getSystemStatus } = await import("../fortigate.js");
    await expect(getSystemStatus()).rejects.toThrow(/HTML instead of JSON/);
  });
});

describe("Breaker integration", () => {
  it("threads calls through the named breaker (state closed after success)", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () => jsonResponse(SAMPLE_STATUS)) as unknown) as typeof fetch;
    const { getSystemStatus } = await import("../fortigate.js");
    const { getCircuitState } = await import("../circuit-breaker.js");
    await getSystemStatus();
    expect(getCircuitState("fortigate")).toBe("closed");
  });
});

describe("getSummary", () => {
  it("tolerates one underlying call failing and returns the rest", async () => {
    vi.resetModules();
    // status OK, resources OK, interfaces OK, threats OK, dhcp 500, arp OK
    let call = 0;
    globalThis.fetch = (vi.fn(async (u: any) => {
      call++;
      const url = String(u);
      if (url.includes("/system/status")) return jsonResponse(SAMPLE_STATUS);
      if (url.includes("/resource/usage")) return jsonResponse(SAMPLE_RESOURCE);
      if (url.includes("/interface/select")) return jsonResponse(SAMPLE_INTERFACES);
      if (url.includes("logtype=ips")) return jsonResponse(SAMPLE_THREATS);
      if (url.includes("/system/dhcp")) return new Response("server error", { status: 500 });
      if (url.includes("/network/arp")) return jsonResponse(SAMPLE_ARP);
      throw new Error(`unexpected fetch[${call}]: ${url}`);
    }) as unknown) as typeof fetch;

    const { getSummary } = await import("../fortigate.js");
    const summary = await getSummary();

    // status / resources / interface_wan / threats / arp succeeded
    expect((summary.status as any).hostname).toBe("FortiGate-60F-34BevPark");
    expect((summary.resources as any).cpu_current).toBe(18);
    expect(summary.interface_wan?.name).toBe("wan1");
    expect(summary.threat_count_24h).toBe(1);
    expect(summary.arp_entry_count).toBe(2);
    // dhcp failed → null
    expect(summary.dhcp_lease_count).toBeNull();
  });
});

// --- New PR: trends + threats + dns-blocks ---------------------------

// Trimmed real-world shape (FortiOS 7.2.13 returns 20 points per
// interval; we use 3 here so the assertions are easy to read).
const SAMPLE_RESOURCE_USAGE_TRENDS = {
  results: {
    cpu: [{
      current: 0,
      historical: {
        "1-min": { values: [[1778767464000, 0], [1778767461000, 1], [1778767458000, 0]] },
        "1-hour": { values: [[1778767000000, 3], [1778763400000, 5], [1778759800000, 4]] },
        "24-hour": { values: [[1778767000000, 4], [1778680600000, 6]] },
      },
    }],
    mem: [{
      current: 63,
      historical: {
        "1-min": { values: [[1778767464000, 63], [1778767461000, 63]] },
        "1-hour": { values: [[1778767000000, 63], [1778763400000, 62], [1778759800000, 61]] },
      },
    }],
    session: [{
      current: 3663,
      historical: {
        "1-min": { values: [[1778767464000, 3663]] },
        "1-hour": { values: [[1778767000000, 3650], [1778763400000, 3500], [1778759800000, 3400]] },
      },
    }],
  },
};

const SAMPLE_IPS_LOG_EMPTY = { results: [] };

const SAMPLE_IPS_LOG_WITH_EVENT = {
  results: [
    {
      date: "2026-05-14",
      time: "07:04:29",
      eventtime: 1778767469190143700, // nanoseconds (FortiOS 7.2)
      tz: "-0700",
      severity: "high",
      action: "blocked",
      srcip: "1.2.3.4",
      srccountry: "Russia",
      dstip: "192.168.1.1",
      dstcountry: "Reserved",
      attackname: "Generic.HTTP.Probe",
      attackid: "12345",
      msg: "Suspicious HTTP probe blocked",
      proto: 6,
      service: "HTTPS",
    },
  ],
};

const SAMPLE_WEBFILTER_LOG = {
  results: [
    // passthrough — must be filtered out
    { action: "passthrough", hostname: "github.com", srcip: "192.168.1.10", date: "2026-05-14", time: "07:04:00" },
    // blocked — kept
    {
      action: "blocked",
      eventtype: "urlfilter",
      hostname: "tracker.example.com",
      srcip: "10.0.22.120",
      dstip: "185.125.190.100",
      catdesc: "Web Tracker",
      date: "2026-05-14",
      time: "07:04:21",
      eventtime: 1778767461373934580,
      tz: "-0700",
      msg: "URL blocked by category filter",
    },
  ],
};

describe("getResourceTrends", () => {
  it("extracts cpu / memory / sessions arrays at the 1-hour interval and sorts oldest-first", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toContain("/api/v2/monitor/system/resource/usage");
      return jsonResponse(SAMPLE_RESOURCE_USAGE_TRENDS);
    }) as unknown) as typeof fetch;
    const { getResourceTrends } = await import("../fortigate.js");
    const trends = await getResourceTrends("1-hour");
    expect(trends.interval).toBe("1-hour");
    expect(trends.cpu).toEqual([
      { t: 1778759800000, v: 4 },
      { t: 1778763400000, v: 5 },
      { t: 1778767000000, v: 3 },
    ]);
    expect(trends.memory).toHaveLength(3);
    expect(trends.sessions[0].v).toBe(3400);
    expect(trends.snapshot_count).toBe(3);
  });

  it("returns empty arrays when the requested interval is missing", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () => jsonResponse(SAMPLE_RESOURCE_USAGE_TRENDS)) as unknown) as typeof fetch;
    const { getResourceTrends } = await import("../fortigate.js");
    const trends = await getResourceTrends("nonexistent-interval");
    expect(trends.cpu).toEqual([]);
    expect(trends.memory).toEqual([]);
    expect(trends.sessions).toEqual([]);
    expect(trends.snapshot_count).toBe(0);
  });
});

describe("getIpsThreats", () => {
  it("returns an empty array when the IPS log is empty (does NOT fall back to the signature registry)", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toContain("/api/v2/log/memory/ips");
      return jsonResponse(SAMPLE_IPS_LOG_EMPTY);
    }) as unknown) as typeof fetch;
    const { getIpsThreats } = await import("../fortigate.js");
    const threats = await getIpsThreats(50);
    expect(threats).toEqual([]);
  });

  it("parses a real IPS event with nanosecond eventtime + countries + attack id", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async () => jsonResponse(SAMPLE_IPS_LOG_WITH_EVENT)) as unknown) as typeof fetch;
    const { getIpsThreats } = await import("../fortigate.js");
    const threats = await getIpsThreats(50);
    expect(threats).toHaveLength(1);
    const t = threats[0];
    expect(t.severity).toBe("high");
    expect(t.action).toBe("blocked");
    expect(t.src_ip).toBe("1.2.3.4");
    expect(t.dst_ip).toBe("192.168.1.1");
    expect(t.signature).toBe("Generic.HTTP.Probe");
    expect(t.attack_id).toBe("12345");
    expect(t.timestamp).toBeDefined();
    // ISO from nanosecond eventtime should land in 2026.
    expect(t.timestamp!.startsWith("2026-")).toBe(true);
  });
});

describe("getWebFilterBlocks", () => {
  it("filters out passthrough and only returns blocked rows", async () => {
    vi.resetModules();
    globalThis.fetch = (vi.fn(async (u: any) => {
      expect(String(u)).toContain("/api/v2/log/memory/webfilter");
      return jsonResponse(SAMPLE_WEBFILTER_LOG);
    }) as unknown) as typeof fetch;
    const { getWebFilterBlocks } = await import("../fortigate.js");
    const blocks = await getWebFilterBlocks(100);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].action).toBe("blocked");
    expect(blocks[0].src_ip).toBe("10.0.22.120");
    // hostname surfaces as the signature for the route layer to pick
    // up as `domain`.
    expect(blocks[0].signature).toBe("tracker.example.com");
  });
});
