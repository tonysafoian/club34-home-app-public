/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db.js", () => ({ query: queryMock }));

const { logAudit: libLogAudit } = await import("../auditLog.js");
const { logAudit: utilsLogAudit } = await import("../../utils/janus-tools.js");

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  delete process.env.PROD_DATABASE_URL;
});

function lastInsertArgs(): { sql: string; values: any[] } {
  const [sql, values] = queryMock.mock.calls.at(-1) as [string, any[]];
  return { sql, values };
}

describe("lib/auditLog.logAudit — actionable column passthrough", () => {
  it("writes actionable=true when caller passes it", async () => {
    await libLogAudit("test-fn", {
      category: "system",
      event_type: "circuit_breaker_state",
      severity: "warn",
      summary: "Circuit ha → open",
      actionable: true,
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).toMatch(/INSERT INTO system_audit_log/);
    expect(sql).toContain("actionable");
    expect(values).toContain(true);
  });

  it("omits actionable when caller doesn't pass it (column default kicks in)", async () => {
    await libLogAudit("test-fn", {
      category: "system",
      event_type: "cron_route_triggered",
      severity: "info",
      summary: "Cron tick",
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).not.toContain("actionable");
    expect(values).not.toContain(true);
  });

  it("preserves explicit actionable=false instead of stripping it", async () => {
    await libLogAudit("test-fn", {
      category: "system",
      event_type: "circuit_breaker_state",
      severity: "info",
      summary: "Circuit ha → closed",
      actionable: false,
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).toContain("actionable");
    // The forwarded column carries the literal false.
    expect(values).toContain(false);
  });
});

describe("utils/janus-tools.logAudit — actionable column passthrough", () => {
  it("writes actionable=true when caller passes it (allowlisted)", async () => {
    await utilsLogAudit("janus-test", {
      category: "janus",
      event_type: "hallucination_guard",
      severity: "warn",
      summary: "Guard fired",
      actionable: true,
    });
    const { sql, values } = lastInsertArgs();
    expect(sql).toMatch(/INSERT INTO system_audit_log/);
    expect(sql).toContain("actionable");
    expect(values).toContain(true);
  });

  it("omits actionable when not passed", async () => {
    await utilsLogAudit("janus-test", {
      category: "janus",
      event_type: "chat_response",
      severity: "info",
      summary: "Chat completed",
    });
    const { sql } = lastInsertArgs();
    expect(sql).not.toContain("actionable");
  });

  it("filters unknown columns but keeps actionable (regression — allowlist must include it)", async () => {
    await utilsLogAudit("janus-test", {
      category: "janus",
      event_type: "chat_response",
      severity: "info",
      summary: "with extras",
      not_a_column: "should be dropped",
      actionable: true,
    } as Record<string, unknown>);
    const { sql, values } = lastInsertArgs();
    expect(sql).toContain("actionable");
    expect(sql).not.toContain("not_a_column");
    expect(values).toContain(true);
    expect(values).not.toContain("should be dropped");
  });
});
