import { describe, test, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("../../../lib/auditLog.js", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import {
  enforceBrowseWebsiteQuota,
  __resetBrowseWebsiteGuardForTests,
} from "../browse-website-guard";
import { logAudit } from "../../../lib/auditLog.js";

const realDateNow = Date.now;

function freezeTime(ms: number): void {
  Date.now = () => ms;
  vi.setSystemTime(new Date(ms));
}

describe("browse-website cost guard (CT #126)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    freezeTime(new Date("2026-05-17T18:00:00Z").getTime());
    __resetBrowseWebsiteGuardForTests();
    (logAudit as ReturnType<typeof vi.fn>).mockClear();
  });

  test("first call is allowed and audited as cost-tracked", async () => {
    const r = await enforceBrowseWebsiteQuota({ source: "chat", userId: "u1", url: "https://a.com", instruction: "x" });
    expect(r.allowed).toBe(true);
    expect(logAudit).toHaveBeenCalledTimes(1);
    const [edgeFn, entry] = (logAudit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(edgeFn).toBe("browse_website_guard");
    expect(entry.tool).toBe("browse_website");
    expect(entry.category).toBe("cost-tracked");
    expect(entry.action).toBe("allowed");
  });

  test("second call within 30s is rejected with spacing message", async () => {
    await enforceBrowseWebsiteQuota({ source: "chat" });
    freezeTime(Date.now() + 5_000);
    const r = await enforceBrowseWebsiteQuota({ source: "chat" });
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/wait \d+ seconds before browsing again/);
  });

  test("call after 30s spacing is allowed", async () => {
    await enforceBrowseWebsiteQuota({ source: "chat" });
    freezeTime(Date.now() + 31_000);
    const r = await enforceBrowseWebsiteQuota({ source: "chat" });
    expect(r.allowed).toBe(true);
  });

  test("30 allowed calls in one day; 31st is rejected with daily-cap message", async () => {
    for (let i = 0; i < 30; i++) {
      freezeTime(Date.now() + 31_000);
      const r = await enforceBrowseWebsiteQuota({ source: "chat" });
      expect(r.allowed).toBe(true);
    }
    freezeTime(Date.now() + 31_000);
    const blocked = await enforceBrowseWebsiteQuota({ source: "chat" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.message).toMatch(/daily browser-use cap \(30\/day\)/);
  });

  test("counter resets when the LA-timezone day rolls over", async () => {
    // 30 calls on day 1.
    for (let i = 0; i < 30; i++) {
      freezeTime(Date.now() + 31_000);
      await enforceBrowseWebsiteQuota({ source: "chat" });
    }
    // Jump to the next LA day (>= 24h forward).
    freezeTime(new Date("2026-05-19T18:00:00Z").getTime());
    const r = await enforceBrowseWebsiteQuota({ source: "chat" });
    expect(r.allowed).toBe(true);
  });

  test("blocked spacing call does NOT advance the counter", async () => {
    await enforceBrowseWebsiteQuota({ source: "chat" }); // count = 1
    for (let i = 0; i < 5; i++) {
      freezeTime(Date.now() + 1_000);
      await enforceBrowseWebsiteQuota({ source: "chat" }); // rejected
    }
    freezeTime(Date.now() + 31_000);
    await enforceBrowseWebsiteQuota({ source: "chat" }); // count = 2
    // Audit log should have: 1 allowed + 5 blocked_spacing + 1 allowed = 7
    expect(logAudit).toHaveBeenCalledTimes(7);
    const actions = (logAudit as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[1].action,
    );
    expect(actions.filter((a) => a === "allowed").length).toBe(2);
    expect(actions.filter((a) => a === "blocked_spacing").length).toBe(5);
  });

  test("omitted guardCtx is still enforced via source=unknown fallback (executeBrowseWebsite path)", async () => {
    // Call the guard directly the way executeBrowseWebsite does when no ctx
    // was passed: source=unknown.
    const r1 = await enforceBrowseWebsiteQuota({ source: "unknown", url: "https://x", instruction: "y" });
    expect(r1.allowed).toBe(true);
    freezeTime(Date.now() + 5_000);
    const r2 = await enforceBrowseWebsiteQuota({ source: "unknown" });
    expect(r2.allowed).toBe(false);
    // Confirm the source is propagated into the audit entry.
    const calls = (logAudit as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every((c) => c[1].source === "unknown")).toBe(true);
  });

  test("audit-log failures do not block tool execution", async () => {
    (logAudit as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    const r = await enforceBrowseWebsiteQuota({ source: "chat" });
    expect(r.allowed).toBe(true);
  });
});

afterAll(() => {
  Date.now = realDateNow;
  vi.useRealTimers();
});
