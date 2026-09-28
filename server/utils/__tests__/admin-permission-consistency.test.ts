import { describe, test, expect } from "vitest";
import {
  ALL_TOOLS as CHAT_TOOLS,
  ADMIN_ONLY_TOOLS as CHAT_ADMIN,
  OUTSIDER_BLOCKED_TOOLS as CHAT_OUTSIDER_BLOCKED,
} from "../../handlers/chat";
import {
  ALL_TOOLS as EMAIL_TOOLS,
  ADMIN_ONLY_TOOLS as EMAIL_ADMIN,
} from "../../handlers/email-poll";
import {
  ALL_TOOLS as WA_TOOLS,
  ADMIN_ONLY_TOOLS as WA_ADMIN,
  OUTSIDER_BLOCKED_TOOLS as WA_OUTSIDER_BLOCKED,
} from "../../handlers/whatsapp";

type Tool = { type: string; function: { name: string; description: string } };

function adminOnlyNamesFromDescriptions(tools: readonly Tool[]): string[] {
  return tools
    .filter((t) => /\badmin\s*only\b/i.test(t.function.description))
    .map((t) => t.function.name);
}

describe("admin permission consistency — tools whose description says \"ADMIN ONLY\" must be in ADMIN_ONLY_TOOLS", () => {
  test("chat.ts", () => {
    const flagged = adminOnlyNamesFromDescriptions(CHAT_TOOLS as Tool[]);
    expect(flagged.length).toBeGreaterThan(0);
    for (const name of flagged) {
      expect(CHAT_ADMIN.has(name)).toBe(true);
    }
  });

  test("email-poll.ts", () => {
    const flagged = adminOnlyNamesFromDescriptions(EMAIL_TOOLS as Tool[]);
    expect(flagged.length).toBeGreaterThan(0);
    for (const name of flagged) {
      expect(EMAIL_ADMIN.has(name)).toBe(true);
    }
  });

  test("whatsapp.ts", () => {
    const flagged = adminOnlyNamesFromDescriptions(WA_TOOLS as Tool[]);
    expect(flagged.length).toBeGreaterThan(0);
    for (const name of flagged) {
      expect(WA_ADMIN.has(name)).toBe(true);
    }
  });
});

describe("delete_calendar_event — admin gate (regression test for CT issue #125)", () => {
  test("chat.ts ADMIN_ONLY_TOOLS contains delete_calendar_event", () => {
    expect(CHAT_ADMIN.has("delete_calendar_event")).toBe(true);
  });

  test("email-poll.ts ADMIN_ONLY_TOOLS contains delete_calendar_event", () => {
    expect(EMAIL_ADMIN.has("delete_calendar_event")).toBe(true);
  });

  test("whatsapp.ts ADMIN_ONLY_TOOLS contains delete_calendar_event", () => {
    expect(WA_ADMIN.has("delete_calendar_event")).toBe(true);
  });

  test("chat.ts OUTSIDER_BLOCKED_TOOLS still contains delete_calendar_event (defense in depth)", () => {
    expect(CHAT_OUTSIDER_BLOCKED.has("delete_calendar_event")).toBe(true);
  });

  test("whatsapp.ts OUTSIDER_BLOCKED_TOOLS still contains delete_calendar_event (defense in depth)", () => {
    expect(WA_OUTSIDER_BLOCKED.has("delete_calendar_event")).toBe(true);
  });
});
