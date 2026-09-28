// DATABASE_URL is set to a dummy in server/test/setup.ts before this file
// loads, so the handler's transitive import of server/db.ts doesn't throw
// at module-load time. Every external call in the run path is injected
// via the deps object — no real DB or network is opened.
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  runTokenExpirationWarnings,
  type HandlerDeps,
} from "../token-expiration-warnings.js";

function inHours(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}

describe("runTokenExpirationWarnings", () => {
  let selectTokens: ReturnType<typeof vi.fn>;
  let isDeduped: ReturnType<typeof vi.fn>;
  let recordAlert: ReturnType<typeof vi.fn>;
  let sendAlert: ReturnType<typeof vi.fn>;
  let getAlertPhone: ReturnType<typeof vi.fn>;
  let audit: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    selectTokens = vi.fn();
    isDeduped = vi.fn().mockResolvedValue(false);
    recordAlert = vi.fn().mockResolvedValue(undefined);
    sendAlert = vi.fn().mockResolvedValue(undefined);
    getAlertPhone = vi.fn().mockResolvedValue("13105550100");
    audit = vi.fn().mockResolvedValue(undefined);
    enqueue = vi.fn().mockResolvedValue(undefined);
  });

  const deps = () => ({
    selectTokens,
    isDeduped,
    recordAlert,
    sendAlert,
    getAlertPhone,
    audit,
    enqueue,
  }) as unknown as HandlerDeps;

  it("sends WhatsApp + records dedup row + writes audit for an expiring tesla token", async () => {
    const expires = inHours(6);
    selectTokens.mockResolvedValueOnce([
      { user_id: "tony", kind: "tesla", token_expires_at: expires, google_email: null },
    ]);

    const { outcomes } = await runTokenExpirationWarnings(deps());
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("sent");
    expect(outcomes[0].kind).toBe("tesla");
    expect(outcomes[0].hours_to_expiry).toBeGreaterThanOrEqual(5);

    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][0]).toBe("13105550100");
    expect(sendAlert.mock.calls[0][1]).toContain("tesla token for tony");

    expect(recordAlert).toHaveBeenCalledWith("tony", "tesla", expires);

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][1].event_type).toBe("token_expiry_warning");
    expect(audit.mock.calls[0][1].status).toBe("success");
    expect(audit.mock.calls[0][1].severity).toBe("warn");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("uses google_email instead of user_id in the message when present", async () => {
    selectTokens.mockResolvedValueOnce([
      { user_id: "tony", kind: "google", token_expires_at: inHours(12), google_email: "admin@example.com" },
    ]);

    await runTokenExpirationWarnings(deps());
    expect(sendAlert.mock.calls[0][1]).toContain("google token for admin@example.com");
  });

  it("skips a row when dedup says it was already alerted in the last 24h", async () => {
    selectTokens.mockResolvedValueOnce([
      { user_id: "tony", kind: "google", token_expires_at: inHours(20), google_email: null },
    ]);
    isDeduped.mockResolvedValueOnce(true);

    const { outcomes } = await runTokenExpirationWarnings(deps());
    expect(outcomes[0].status).toBe("skipped_duplicate");
    expect(sendAlert).not.toHaveBeenCalled();
    expect(recordAlert).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0][1].detail.deduped).toBe(true);
    expect(audit.mock.calls[0][1].severity).toBe("info");
  });

  it("enqueues a failed_jobs row and writes an error audit when WhatsApp send fails", async () => {
    selectTokens.mockResolvedValueOnce([
      { user_id: "tony", kind: "tesla", token_expires_at: inHours(3), google_email: null },
    ]);
    sendAlert.mockRejectedValueOnce(new Error("WATI 503: upstream down"));

    const { outcomes } = await runTokenExpirationWarnings(deps());
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error).toMatch(/WATI 503/);

    expect(recordAlert).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe("janus/token-expiration-warnings");
    expect(enqueue.mock.calls[0][2]).toMatchObject({
      user_id: "tony",
      kind: "tesla",
    });
    expect(audit.mock.calls[0][1].status).toBe("error");
    expect(audit.mock.calls[0][1].severity).toBe("error");
  });

  it("returns an empty result and never resolves the alert phone when no tokens are expiring", async () => {
    selectTokens.mockResolvedValueOnce([]);
    const { outcomes } = await runTokenExpirationWarnings(deps());
    expect(outcomes).toEqual([]);
    expect(getAlertPhone).not.toHaveBeenCalled();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("marks every row failed when the alert phone cannot be resolved", async () => {
    selectTokens.mockResolvedValueOnce([
      { user_id: "tony", kind: "tesla", token_expires_at: inHours(4), google_email: null },
      { user_id: "tony", kind: "google", token_expires_at: inHours(6), google_email: "admin@example.com" },
    ]);
    getAlertPhone.mockRejectedValueOnce(new Error("system_configs unreachable"));

    const { outcomes } = await runTokenExpirationWarnings(deps());
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === "failed")).toBe(true);
    expect(outcomes[0].error).toBe("alert phone unresolved");
    expect(sendAlert).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("processes a tesla + google mix independently — one can succeed while the other dedupes", async () => {
    selectTokens.mockResolvedValueOnce([
      { user_id: "tony", kind: "tesla", token_expires_at: inHours(2), google_email: null },
      { user_id: "tony", kind: "google", token_expires_at: inHours(8), google_email: "admin@example.com" },
    ]);
    isDeduped.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const { outcomes } = await runTokenExpirationWarnings(deps());
    const byKind = Object.fromEntries(outcomes.map((o) => [o.kind, o.status]));
    expect(byKind.tesla).toBe("skipped_duplicate");
    expect(byKind.google).toBe("sent");
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(recordAlert).toHaveBeenCalledTimes(1);
    expect(recordAlert).toHaveBeenCalledWith("tony", "google", expect.any(String));
  });
});
