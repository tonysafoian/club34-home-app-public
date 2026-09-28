import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub the auditLog module so importing breakers.ts doesn't try to
// reach Postgres for the state-transition handler. The handler is
// registered as a side effect on module load — we silence it here.
vi.mock("../auditLog.js", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

// Mock the db layer in case anything transitively touches it.
vi.mock("../db.js", () => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));

const { __resetForTests, getCircuitSnapshot, recordFailure, recordSuccess, getCircuitState } = await import("../circuit-breaker.js");
const { breakers, BREAKER_NAMES, UNDERLYING_BREAKER_NAMES, toolErrorForOpenCircuit, CircuitOpenError } = await import("../breakers.js");

beforeEach(() => {
  __resetForTests();
});

describe("named breakers", () => {
  it("exposes ha / tesla / notion / gmail", () => {
    expect(BREAKER_NAMES).toEqual(["ha", "tesla", "notion", "gmail", "ruckus", "fortigate"]);
    for (const name of BREAKER_NAMES) {
      expect(breakers[name]).toBeDefined();
      expect(typeof breakers[name].execute).toBe("function");
    }
  });

  it("tesla maps to the legacy 'tesla-api' underlying name so it shares state with existing call sites", () => {
    expect(breakers.tesla.underlyingName).toBe("tesla-api");
    expect(UNDERLYING_BREAKER_NAMES).toContain("tesla-api");
    expect(UNDERLYING_BREAKER_NAMES).toContain("ha");
    expect(UNDERLYING_BREAKER_NAMES).toContain("notion");
    expect(UNDERLYING_BREAKER_NAMES).toContain("gmail");
  });

  it("execute() routes through the underlying name (tesla success records under tesla-api)", async () => {
    await breakers.tesla.execute(async () => 1);
    // Tesla shares state with the legacy 'tesla-api' breaker name.
    expect(getCircuitState("tesla-api")).toBe("closed");
  });

  it("breakers.ha.execute runs the function and returns its result", async () => {
    const result = await breakers.ha.execute(async () => "ok");
    expect(result).toBe("ok");
  });

  it("a failure on one breaker doesn't affect siblings", async () => {
    // We can't easily provoke breakers.ha.execute to fail without
    // mocking fetch, but we can drive failures directly via the
    // underlying name and verify only that breaker's state changes.
    recordFailure("ha");
    recordFailure("ha");
    recordFailure("ha");
    recordFailure("ha");
    recordFailure("ha");
    expect(getCircuitState("ha")).toBe("open");
    expect(getCircuitState("tesla-api")).toBe("closed");
    expect(getCircuitState("notion")).toBe("closed");
    expect(getCircuitState("gmail")).toBe("closed");
    expect(getCircuitState("ruckus")).toBe("closed");
    expect(getCircuitState("fortigate")).toBe("closed");
  });

  it("a snapshot of a named breaker includes the configured failureThreshold default", () => {
    recordSuccess("ha");
    const s = getCircuitSnapshot("ha");
    // 5 is the documented default for HA (less strict than tesla/gmail).
    expect(s.config.failureThreshold).toBe(5);
  });
});

describe("toolErrorForOpenCircuit", () => {
  it("returns a TOOL_ERROR-prefixed string with the service name and retry timestamp", () => {
    const e = new CircuitOpenError("ha", Date.now() + 60_000);
    const msg = toolErrorForOpenCircuit(e);
    expect(msg.startsWith("TOOL_ERROR:")).toBe(true);
    expect(msg).toContain("ha");
    expect(msg).toContain("Auto-retry at");
  });
});
