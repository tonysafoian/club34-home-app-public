/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../../lib/db.js", () => ({ query: queryMock }));

// Both auditLog modules import lib/db.js dynamically (or statically) —
// our mock intercepts either path.
const { logAudit: libLogAudit } = await import("../../lib/auditLog.js");
const { logAudit: utilsLogAudit, enqueueFailedJob } = await import("../janus-tools.js");
const { runWithCorrelation } = await import("../../lib/correlation.js");

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  // Force the lib/auditLog path to use the local query, not a prod pool.
  delete process.env.PROD_DATABASE_URL;
});

function lastInsertArgs(): { sql: string; values: any[] } {
  const [sql, values] = queryMock.mock.calls.at(-1) as [string, any[]];
  return { sql, values };
}

describe("lib/auditLog.logAudit auto-stamps correlation_id from ALS", () => {
  it("includes correlation_id when called inside runWithCorrelation", async () => {
    await runWithCorrelation("trace-001", async () => {
      await libLogAudit("test-fn", {
        category: "system",
        event_type: "test",
        severity: "info",
        summary: "test row",
      });
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).toMatch(/INSERT INTO system_audit_log/);
    expect(sql).toContain("correlation_id");
    expect(values).toContain("trace-001");
  });

  it("omits correlation_id when called outside any context", async () => {
    await libLogAudit("test-fn", {
      category: "system",
      event_type: "test",
      severity: "info",
      summary: "no-ctx row",
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).not.toContain("correlation_id");
    // sanity — none of the inserted values matches a uuid-shaped string
    expect(values.some((v) => typeof v === "string" && /^[0-9a-f-]{30,}$/.test(v))).toBe(false);
  });

  it("explicit correlation_id passed by the caller wins over the ALS-bound one", async () => {
    await runWithCorrelation("trace-als", async () => {
      await libLogAudit("test-fn", {
        category: "system",
        event_type: "test",
        severity: "info",
        summary: "explicit override",
        correlation_id: "trace-explicit",
      });
    });
    const { values } = lastInsertArgs();
    expect(values).toContain("trace-explicit");
    expect(values).not.toContain("trace-als");
  });
});

describe("utils/janus-tools.logAudit auto-stamps correlation_id", () => {
  it("stamps the ALS id when in context", async () => {
    await runWithCorrelation("trace-tools", async () => {
      await utilsLogAudit("janus-test", {
        category: "janus",
        event_type: "test_event",
        severity: "info",
        summary: "tools-side",
      });
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).toMatch(/INSERT INTO system_audit_log/);
    expect(sql).toContain("correlation_id");
    expect(values).toContain("trace-tools");
  });

  it("omits correlation_id outside any context", async () => {
    await utilsLogAudit("janus-test", {
      category: "janus",
      event_type: "test_event",
      severity: "info",
      summary: "no-ctx",
    });
    const { sql } = lastInsertArgs();
    expect(sql).not.toContain("correlation_id");
  });
});

describe("enqueueFailedJob auto-stamps correlation_id", () => {
  it("includes the ALS id in the failed_jobs INSERT when in context", async () => {
    await runWithCorrelation("trace-job", async () => {
      await enqueueFailedJob("test-fn", new Error("kaboom"), { foo: "bar" });
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).toMatch(/INSERT INTO failed_jobs/);
    expect(values).toContain("trace-job");
  });

  it("passes NULL when outside any context", async () => {
    await enqueueFailedJob("test-fn", new Error("kaboom"));
    const { values } = lastInsertArgs();
    // null is the last positional param under the new schema
    expect(values[values.length - 1]).toBeNull();
  });
});
