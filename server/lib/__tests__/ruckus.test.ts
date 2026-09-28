/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const ORIGINAL_FETCH = globalThis.fetch;

// Set the controller env at module scope (runs before any hook) so the very
// first import of ruckus.ts captures the test values, regardless of which
// test/hook triggers that import first.
process.env.RUCKUS_BASE_URL = "https://ruckus.test.local";
process.env.RUCKUS_USERNAME = "admin";
process.env.RUCKUS_PASSWORD = "p4ssw0rd";

// Pre-warm the dynamic import once, in a hook that uses the longer hook timeout
// rather than the 5000ms per-test timeout. The first cold import transforms the
// whole module graph; under full-suite CPU contention that cost previously blew
// past the per-test timeout and made the first test flap/time out every run.
beforeAll(async () => {
  await import("../ruckus.js");
});

beforeEach(() => {
  // Pin the env so each test has the same understanding of the controller.
  process.env.RUCKUS_BASE_URL = "https://ruckus.test.local";
  process.env.RUCKUS_USERNAME = "admin";
  process.env.RUCKUS_PASSWORD = "p4ssw0rd";
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

/**
 * Helpers to build minimal Response stand-ins. We construct real Response
 * objects so headers.get() works the way the SUT expects.
 */
function jsonHeaders(initHeaders: Record<string, string | string[]> = {}, cookies: string[] = []): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(initHeaders)) {
    if (Array.isArray(v)) {
      for (const item of v) h.append(k, item);
    } else {
      h.set(k, v);
    }
  }
  for (const c of cookies) h.append("set-cookie", c);
  return h;
}

function makeResponse(
  body: string,
  init: { status?: number; headers?: Headers } = {},
): Response {
  // The SUT only cares about text() + status + headers — not stream APIs.
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

const SAMPLE_APS_XML = `
<ajax-response>
  <response>
    <ap mac="AA:BB:CC:DD:EE:01" ap-name="Front Yard WAP" model="R750" ip="10.0.22.21" state="join" gateway="10.0.22.1" hw-version="V01" build-version="200.14.6.1" mgmt-vlan-id="1" 11ax="true" 11ac="true" max-client="100"/>
    <ap mac="AA:BB:CC:DD:EE:02" ap-name="Kitchen WAP"   model="R650" ip="10.0.22.22" state="disconnect" 11ax="false" 11ac="true"/>
  </response>
</ajax-response>`.trim();

const SAMPLE_CLIENTS_XML = `
<ajax-response>
  <response>
    <client mac="11:22:33:44:55:66" ssid="34_AV" ap-name="Front Yard WAP" ap-mac="AA:BB:CC:DD:EE:01" vlan="1" rssi="3" received-signal-strength="-67" hostname="iPad" ip="192.168.1.15" dvctype="iOS Device" wlan-id="1"/>
    <client mac="11:22:33:44:55:77" ssid="34_AV" ap-name="Kitchen WAP" ap-mac="AA:BB:CC:DD:EE:02" vlan="1" rssi="5" received-signal-strength="-45" hostname="Kindle"/>
    <client mac="11:22:33:44:55:88" ssid="34_Guest" ap-name="Front Yard WAP" ap-mac="AA:BB:CC:DD:EE:01" received-signal-strength="-78"/>
  </response>
</ajax-response>`.trim();

// Real firmware 200.14.6.1 nests the AP/client lists under an
// <apstamgr-stat> wrapper (verified live against the controller).
const SAMPLE_APS_WRAPPED_XML = `
<ajax-response>
  <response type="object" id="aps">
    <apstamgr-stat>
      <ap mac="2c:ab:46:09:96:f0" ap-name="RuckusAP" model="t350se" ip="10.0.22.90" state="1" gateway="10.0.22.1" hardware-version="33.0.0" build-version="203" mgmt-vlan-id="1" support-11ax="true" support-11ac="true" max-client="100"/>
      <ap mac="c0:c7:0a:24:93:c0" ap-name="Master Wap" model="r750" ip="10.0.22.106" state="1" support-11ax="true"/>
    </apstamgr-stat>
  </response>
</ajax-response>`.trim();

const SAMPLE_CLIENTS_WRAPPED_XML = `
<ajax-response>
  <response type="object" id="client-info-stats">
    <apstamgr-stat>
      <client mac="00:9b:08:ef:39:f1" ssid="34_AV" ap-name="Garage Wap" ap="80:f0:cf:09:b6:30" vlan="1" received-signal-strength="-33" hostname="Tonys-iPad" ip="10.0.22.170" dvctype="Tablet" model="Amazon Kindle" wlan-id="3"/>
      <client mac="62:e2:47:16:0a:d7" ssid="34" ap-name="Glam WAP" received-signal-strength="-63"/>
    </apstamgr-stat>
  </response>
</ajax-response>`.trim();

const SAMPLE_SYSTEM_XML = `
<ajax-response>
  <response>
    <sysinfo model="R750" version="200.14.6.1 build 203" mac="70:47:77:18:E9:60" serial="ABC123" uptime="123456" cpu_busy="18" cpu_total="4" mem_total="2097152" mem_free="1300000" max_ap="25"/>
  </response>
</ajax-response>`.trim();

// Stub the fetch sequence (seed GET -> login POST -> cmdstat POST) so a
// test only has to supply the cmdstat XML body it wants to parse.
function stubFetchForCmdstat(cmdstatXml: string): void {
  let calls = 0;
  globalThis.fetch = (vi.fn(async () => {
    calls++;
    // Build fresh Headers per call so set-cookie / csrf values aren't
    // drained by a prior consumer.
    if (calls === 1) {
      return makeResponse("", { status: 200, headers: jsonHeaders({}, ["-ejs-session-=SEED_VALUE; Path=/"]) });
    }
    if (calls === 2) {
      return makeResponse("", {
        status: 302,
        headers: jsonHeaders({ http_x_csrf_token: "abcdefghij" }, ["-ejs-session-=SESSION_VALUE; Path=/; HttpOnly; Secure"]),
      });
    }
    return makeResponse(cmdstatXml, { status: 200 });
  }) as unknown) as typeof fetch;
}

const SAMPLE_LOGIN_HEADERS = jsonHeaders(
  { http_x_csrf_token: "abcdefghij" },
  ["-ejs-session-=SESSION_VALUE; Path=/; HttpOnly; Secure"],
);
const SAMPLE_SEED_HEADERS = jsonHeaders({}, ["-ejs-session-=SEED_VALUE; Path=/"]);

describe("signalHealthFromRssi", () => {
  it("buckets RSSI integer dBm into excellent/good/fair/poor", async () => {
    const { signalHealthFromRssi } = await import("../ruckus.js");
    expect(signalHealthFromRssi(-40)).toBe("excellent");
    expect(signalHealthFromRssi(-50)).toBe("good"); // exactly at the boundary; > -50 is excellent so -50 falls into good
    expect(signalHealthFromRssi(-60)).toBe("good");
    expect(signalHealthFromRssi(-70)).toBe("fair");
    expect(signalHealthFromRssi(-80)).toBe("poor");
    expect(signalHealthFromRssi(undefined)).toBe("unknown");
    expect(signalHealthFromRssi(NaN)).toBe("unknown");
  });
});

describe("ruckus login flow", () => {
  it("captures the -ejs-session- cookie and http_x_csrf_token from the POST response", async () => {
    const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === undefined || init.method === "GET") {
        // seed GET
        expect(url).toBe("https://ruckus.test.local/admin/login.jsp");
        return makeResponse("<html>login</html>", { status: 200, headers: SAMPLE_SEED_HEADERS });
      }
      if (init?.method === "POST" && url.endsWith("/admin/login.jsp")) {
        expect(String(init.body)).toMatch(/username=admin/);
        expect(String(init.body)).toMatch(/password=p4ssw0rd/);
        expect(String(init.body)).toMatch(/ok=Log\+In/);
        // The POST receives a Referer + the seed cookie.
        const headers = init.headers as Record<string, string>;
        expect(headers.Referer).toBe("https://ruckus.test.local/admin/login.jsp");
        expect(headers.Cookie).toContain("-ejs-session-=SEED_VALUE");
        return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      }
      if (init?.method === "POST" && url.endsWith("/admin/_cmdstat.jsp")) {
        // For the AP test below.
        return makeResponse(SAMPLE_APS_XML, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${init?.method} ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { __resetSessionForTests, getAccessPoints } = await import("../ruckus.js");
    __resetSessionForTests();

    const aps = await getAccessPoints();
    expect(aps).toHaveLength(2);

    // Verify the data POST carried the new cookie and CSRF.
    const cmdstatCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("_cmdstat.jsp"));
    expect(cmdstatCall).toBeDefined();
    const headers = (cmdstatCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-CSRF-Token"]).toBe("abcdefghij");
    expect(headers.Cookie).toBe("-ejs-session-=SESSION_VALUE");
    expect(headers["Content-Type"]).toBe("text/xml");
  });

  it("throws when no CSRF token is returned", async () => {
    const headersNoCsrf = jsonHeaders({}, ["-ejs-session-=X; Path=/"]);
    globalThis.fetch = (vi.fn(async (_u: any, init?: RequestInit) =>
      makeResponse("", {
        status: init?.method === "POST" ? 302 : 200,
        headers: init?.method === "POST" ? headersNoCsrf : jsonHeaders({}, ["-ejs-session-=S; Path=/"]),
      }),
    ) as unknown) as typeof fetch;

    const { __resetSessionForTests, getAccessPoints } = await import("../ruckus.js");
    __resetSessionForTests();
    await expect(getAccessPoints()).rejects.toThrow(/no CSRF token/i);
  });

  it("throws a clear error when RUCKUS_PASSWORD is empty", async () => {
    // The constant is captured at module-load, so we have to reset the
    // module registry to pick up the empty env.
    vi.resetModules();
    process.env.RUCKUS_PASSWORD = "";
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
    const { __resetSessionForTests, getSystemInfo } = await import("../ruckus.js");
    __resetSessionForTests();
    await expect(getSystemInfo()).rejects.toThrow(/RUCKUS_PASSWORD/);
    // Restore for following tests by re-importing under the real value.
    vi.resetModules();
    process.env.RUCKUS_PASSWORD = "p4ssw0rd";
  });
});

describe("AP parser", () => {
  it("turns the sample XML into the expected JSON shape", async () => {
    let calls = 0;
    globalThis.fetch = (vi.fn(async (_u: any, init?: RequestInit) => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      return makeResponse(SAMPLE_APS_XML, { status: 200 });
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getAccessPoints } = await import("../ruckus.js");
    __resetSessionForTests();
    const aps = await getAccessPoints();
    expect(aps).toEqual([
      expect.objectContaining({
        mac: "AA:BB:CC:DD:EE:01",
        name: "Front Yard WAP",
        model: "R750",
        ip: "10.0.22.21",
        status: "joined",
        gateway: "10.0.22.1",
        hw_version: "V01",
        build_version: "200.14.6.1",
        supports_11ax: true,
        supports_11ac: true,
        max_clients: 100,
      }),
      expect.objectContaining({
        mac: "AA:BB:CC:DD:EE:02",
        name: "Kitchen WAP",
        status: "disconnected",
        supports_11ax: false,
        supports_11ac: true,
      }),
    ]);
  });
});

describe("Client parser + signal_health", () => {
  it("parses clients with signal/RSSI fields and derives signal_health from the integer dBm", async () => {
    let calls = 0;
    globalThis.fetch = (vi.fn(async (_u: any, init?: RequestInit) => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      return makeResponse(SAMPLE_CLIENTS_XML, { status: 200 });
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getClients } = await import("../ruckus.js");
    __resetSessionForTests();
    const clients = await getClients();
    expect(clients).toHaveLength(3);
    expect(clients[0]).toMatchObject({
      mac: "11:22:33:44:55:66",
      ssid: "34_AV",
      ap_name: "Front Yard WAP",
      ap_mac: "AA:BB:CC:DD:EE:01",
      rssi_dbm: 3,
      signal: -67,
      signal_health: "fair",
      hostname: "iPad",
    });
    expect(clients[1]).toMatchObject({
      signal: -45,
      signal_health: "excellent",
    });
    expect(clients[2]).toMatchObject({
      signal: -78,
      signal_health: "poor",
    });
  });
});

describe("Client parser — alternate firmware attribute names", () => {
  it("populates signal and ip from alternate attribute names (recv-signal-strength / host-ipaddr)", async () => {
    const altClientsXml = `
<ajax-response>
  <response>
    <client mac="aa:aa:aa:aa:aa:01" ssid="34_AV" ap-name="Den WAP" ap-mac="AA:BB:CC:DD:EE:09" recv-signal-strength="-52" host-ipaddr="10.0.22.201" hostname="AltPhone"/>
    <client mac="aa:aa:aa:aa:aa:02" ssid="34" ap-name="Den WAP" last-rssi="-71" ipv4="10.0.22.202"/>
  </response>
</ajax-response>`.trim();
    let calls = 0;
    globalThis.fetch = (vi.fn(async () => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      return makeResponse(altClientsXml, { status: 200 });
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getClients } = await import("../ruckus.js");
    __resetSessionForTests();
    const clients = await getClients();
    expect(clients).toHaveLength(2);
    expect(clients[0]).toMatchObject({
      mac: "aa:aa:aa:aa:aa:01",
      signal: -52,
      signal_health: "good",
      ip: "10.0.22.201",
    });
    expect(clients[1]).toMatchObject({
      signal: -71,
      signal_health: "fair",
      ip: "10.0.22.202",
    });
  });

  it("classifies band at parse time from radio-band / channel / radio-type", async () => {
    const bandClientsXml = `
<ajax-response>
  <response>
    <client mac="bb:bb:bb:bb:bb:01" ssid="34" ap-name="Den WAP" radio-band="2.4g" channel="1" ieee80211-radio-type="g/n"/>
    <client mac="bb:bb:bb:bb:bb:02" ssid="34" ap-name="Den WAP" radio-band="5G"/>
    <client mac="bb:bb:bb:bb:bb:03" ssid="34" ap-name="Den WAP" channel="149"/>
    <client mac="bb:bb:bb:bb:bb:04" ssid="34" ap-name="Den WAP" ieee80211-radio-type="11ac"/>
    <client mac="bb:bb:bb:bb:bb:05" ssid="34" ap-name="Den WAP"/>
  </response>
</ajax-response>`.trim();
    let calls = 0;
    globalThis.fetch = (vi.fn(async () => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      return makeResponse(bandClientsXml, { status: 200 });
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getClients } = await import("../ruckus.js");
    __resetSessionForTests();
    const clients = await getClients();
    expect(clients).toHaveLength(5);
    // radio-band wins even with a competing channel.
    expect(clients[0].band).toBe("2.4GHz");
    expect(clients[1].band).toBe("5GHz"); // "5G" case-insensitive
    expect(clients[2].band).toBe("5GHz"); // channel 149 fallback
    expect(clients[3].band).toBe("5GHz"); // radio-type "11ac"
    expect(clients[4].band).toBeUndefined(); // no hint → null by design
  });
});

describe("classifyBand helper", () => {
  it("maps radio-band, channel, and radio-type to a band or undefined", async () => {
    const { classifyBand } = await import("../ruckus.js");
    expect(classifyBand({ "radio-band": "2.4g" })).toBe("2.4GHz");
    expect(classifyBand({ "radio-band": "5G" })).toBe("5GHz");
    expect(classifyBand({ "radio-band": "6g" })).toBe("6GHz");
    // explicit band beats a conflicting channel
    expect(classifyBand({ "radio-band": "2.4g", channel: 149 })).toBe("2.4GHz");
    expect(classifyBand({ channel: 6 })).toBe("2.4GHz");
    expect(classifyBand({ channel: 149 })).toBe("5GHz");
    expect(classifyBand({ "ieee80211-radio-type": "g/n" })).toBe("2.4GHz");
    expect(classifyBand({ "radio-type-text": "11ac" })).toBe("5GHz");
    expect(classifyBand({})).toBeUndefined();
  });
});

describe("AP/client parser — real firmware apstamgr-stat wrapper", () => {
  it("unwraps <apstamgr-stat> for APs (firmware 200.14.6.1 shape)", async () => {
    let calls = 0;
    globalThis.fetch = (vi.fn(async () => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      return makeResponse(SAMPLE_APS_WRAPPED_XML, { status: 200 });
    }) as unknown) as typeof fetch;
    const { __resetSessionForTests, getAccessPoints } = await import("../ruckus.js");
    __resetSessionForTests();
    const aps = await getAccessPoints();
    expect(aps).toHaveLength(2);
    expect(aps[0].mac).toBe("2c:ab:46:09:96:f0");
    expect(aps[0].name).toBe("RuckusAP");
    expect(aps[0].model).toBe("t350se");
    expect(aps[0].status).toBe("joined"); // state="1"
    expect(aps[0].hw_version).toBe("33.0.0");
    expect(aps[0].supports_11ax).toBe(true);
  });

  it("unwraps <apstamgr-stat> for clients and derives SSIDs", async () => {
    stubFetchForCmdstat(SAMPLE_CLIENTS_WRAPPED_XML);
    const { __resetSessionForTests, getClients } = await import("../ruckus.js");
    __resetSessionForTests();
    const clients = await getClients();
    expect(clients).toHaveLength(2);
    expect(clients[0].mac).toBe("00:9b:08:ef:39:f1");
    expect(clients[0].ssid).toBe("34_AV");
    expect(clients[0].hostname).toBe("Tonys-iPad");
    expect(clients[0].ip).toBe("10.0.22.170");
    expect(clients[0].signal).toBe(-33);
    expect(clients[1].ssid).toBe("34");
  });
});

describe("System info parser", () => {
  it("parses sysinfo XML into the expected JSON shape", async () => {
    let calls = 0;
    globalThis.fetch = (vi.fn(async () => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      return makeResponse(SAMPLE_SYSTEM_XML, { status: 200 });
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getSystemInfo } = await import("../ruckus.js");
    __resetSessionForTests();
    const sys = await getSystemInfo();
    expect(sys).toMatchObject({
      model: "R750",
      version: "200.14.6.1 build 203",
      mac: "70:47:77:18:E9:60",
      serial: "ABC123",
      uptime_sec: 123456,
      cpu_busy_pct: 18,
      cpu_total: 4,
      mem_total_kb: 2097152,
      mem_free_kb: 1300000,
      max_ap: 25,
    });
  });
});

describe("SSID fallback derives from clients", () => {
  it("falls back to deriving SSIDs from observed clients when every SSID query returns empty", async () => {
    let calls = 0;
    // Seed + login = 2, then 3 SSID queries (each empty), then 1 clients call.
    globalThis.fetch = (vi.fn(async (_u: any, init?: RequestInit) => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      // Empty XML for every SSID-shape attempt; valid XML so it parses cleanly.
      const body = String(init?.body || "");
      if (body.includes("wlansvc")) {
        return makeResponse(`<ajax-response><response></response></ajax-response>`, { status: 200 });
      }
      // The clients call.
      if (body.includes("client-info-stats")) {
        return makeResponse(SAMPLE_CLIENTS_XML, { status: 200 });
      }
      return makeResponse("", { status: 200 });
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getSSIDs } = await import("../ruckus.js");
    __resetSessionForTests();
    const ssids = await getSSIDs();
    const names = ssids.map((s) => s.name).sort();
    expect(names).toEqual(["34_AV", "34_Guest"]);
    expect(ssids.every((s) => s.derived_from_clients === true)).toBe(true);
    // 34_AV has 2 clients, 34_Guest has 1 in the sample.
    const counts = Object.fromEntries(ssids.map((s) => [s.name, s.client_count]));
    expect(counts["34_AV"]).toBe(2);
    expect(counts["34_Guest"]).toBe(1);
  });
});

describe("Re-auth on 401", () => {
  it("invalidates the cache, re-logins exactly once, and retries the request", async () => {
    let calls = 0;
    let postLogins = 0;
    globalThis.fetch = (vi.fn(async (_u: any, init?: RequestInit) => {
      const url = String(_u);
      calls++;
      if (url.endsWith("/admin/login.jsp") && (!init?.method || init.method === "GET")) {
        return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      }
      if (url.endsWith("/admin/login.jsp") && init?.method === "POST") {
        postLogins++;
        return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      }
      if (url.endsWith("/_cmdstat.jsp")) {
        // First data call → 401. Second data call → real XML.
        const isRetry = calls >= 5;
        if (!isRetry) return makeResponse("", { status: 401 });
        return makeResponse(SAMPLE_APS_XML, { status: 200 });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getAccessPoints } = await import("../ruckus.js");
    __resetSessionForTests();

    const aps = await getAccessPoints();
    expect(aps).toHaveLength(2);
    expect(postLogins).toBe(2); // one initial login + one re-login after 401
  });
});

describe("Breaker integration", () => {
  it("threads ruckus calls through the named breaker (state is closed after a successful call)", async () => {
    let calls = 0;
    globalThis.fetch = (vi.fn(async () => {
      calls++;
      if (calls === 1) return makeResponse("", { status: 200, headers: SAMPLE_SEED_HEADERS });
      if (calls === 2) return makeResponse("", { status: 302, headers: SAMPLE_LOGIN_HEADERS });
      return makeResponse(SAMPLE_SYSTEM_XML, { status: 200 });
    }) as unknown) as typeof fetch;

    const { __resetSessionForTests, getSystemInfo } = await import("../ruckus.js");
    const { getCircuitState } = await import("../circuit-breaker.js");
    __resetSessionForTests();
    await getSystemInfo();
    expect(getCircuitState("ruckus")).toBe("closed");
  });
});
