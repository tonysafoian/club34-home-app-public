import { describe, it, expect } from "vitest";
import {
  detectHallucination,
  HALLUCINATION_GUARDS,
} from "../hallucination-guards.js";

function tool(name: string, result = "ok"): { name: string; result: string } {
  return { name, result };
}

describe("hallucination-guards registry", () => {
  it("registers all 5 guards with unique names and an override message", () => {
    const names = HALLUCINATION_GUARDS.map((g) => g.name);
    expect(names.sort()).toEqual([
      "calendar_event",
      "cart_add",
      "email_sent",
      "google_file",
      "reminder_set",
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const g of HALLUCINATION_GUARDS) {
      expect(g.overrideMessage).toMatch(/^SYSTEM OVERRIDE:/);
      expect(typeof g.detector).toBe("function");
      expect(g.consoleSummary.length).toBeGreaterThan(0);
    }
  });
});

describe("calendar_event guard", () => {
  it("fires when reply claims a calendar event and no create_calendar_event was called", () => {
    const g = detectHallucination(
      "Done — I created a calendar event for 7pm tomorrow.",
      [],
    );
    expect(g?.name).toBe("calendar_event");
  });

  it("does NOT fire when create_calendar_event was called", () => {
    const g = detectHallucination(
      "Done — I created a calendar event for 7pm tomorrow.",
      [tool("create_calendar_event")],
    );
    expect(g).toBeNull();
  });

  it("does NOT fire on unrelated text", () => {
    expect(detectHallucination("The weather is nice today.", [])).toBeNull();
  });
});

describe("google_file guard", () => {
  it("fires when reply contains a docs.google.com URL and no create_google_file tool was called", () => {
    const g = detectHallucination(
      "Here's the doc: https://docs.google.com/document/d/ABC123_xyz/edit",
      [],
    );
    expect(g?.name).toBe("google_file");
  });

  it("does NOT fire when create_google_file tool was called with a non-error result", () => {
    const g = detectHallucination(
      "Here's the doc: https://docs.google.com/document/d/ABC123_xyz/edit",
      [tool("create_google_file", "✅ Created Google Doc")],
    );
    expect(g).toBeNull();
  });

  it("DOES fire when create_google_file was called but the result was TOOL_ERROR", () => {
    const g = detectHallucination(
      "Here's the doc: https://docs.google.com/document/d/ABC123/edit",
      [tool("create_google_file", "TOOL_ERROR: drive API quota exceeded")],
    );
    expect(g?.name).toBe("google_file");
  });
});

describe("email_sent guard", () => {
  it("fires on 'I sent the email' without send_email tool call", () => {
    const g = detectHallucination("Done — I just sent the email to Tony.", []);
    expect(g?.name).toBe("email_sent");
  });

  it("fires on 'Email sent to alice@example.com'", () => {
    const g = detectHallucination("Email sent to alice@example.com.", []);
    expect(g?.name).toBe("email_sent");
  });

  it("fires on 'I've emailed the team'", () => {
    expect(
      detectHallucination("I've emailed the team about the change.", [])?.name,
    ).toBe("email_sent");
  });

  it("does NOT fire when send_email was actually called", () => {
    const g = detectHallucination(
      "Done — I sent the email to Tony.",
      [tool("send_email")],
    );
    expect(g).toBeNull();
  });

  it("does NOT fire on the offer 'I can email the team if you'd like'", () => {
    expect(
      detectHallucination("I can email the team if you'd like.", []),
    ).toBeNull();
  });

  it("does NOT fire on 'Send me an email'", () => {
    expect(detectHallucination("Send me an email later.", [])).toBeNull();
  });
});

describe("cart_add guard", () => {
  it("fires on 'Added to your cart' without save_to_cart", () => {
    expect(
      detectHallucination("Added that 12-pack to your cart.", [])?.name,
    ).toBe("cart_add");
  });

  it("fires on 'I added X to the cart'", () => {
    expect(
      detectHallucination("I added a gallon of milk to the cart.", [])?.name,
    ).toBe("cart_add");
  });

  it("fires on 'in your Amazon cart'", () => {
    expect(
      detectHallucination("Those headphones are in your Amazon cart now.", [])?.name,
    ).toBe("cart_add");
  });

  it("does NOT fire when save_to_cart was called", () => {
    const g = detectHallucination(
      "Added that 12-pack to your cart.",
      [tool("save_to_cart")],
    );
    expect(g).toBeNull();
  });

  it("does NOT fire on 'Look in your cart'", () => {
    expect(
      detectHallucination("Look in your cart for the receipt.", []),
    ).toBeNull();
  });
});

describe("reminder_set guard", () => {
  it("fires on 'I set a reminder' without set_reminder", () => {
    expect(
      detectHallucination("I set a reminder for 6pm.", [])?.name,
    ).toBe("reminder_set");
  });

  it("fires on \"I'll remind you\"", () => {
    expect(
      detectHallucination("I'll remind you at 6pm to leave.", [])?.name,
    ).toBe("reminder_set");
  });

  it("fires on 'Reminder set'", () => {
    expect(
      detectHallucination("Reminder set — you'll get a ping at 6pm.", [])?.name,
    ).toBe("reminder_set");
  });

  it("does NOT fire when set_reminder was called", () => {
    expect(
      detectHallucination(
        "Reminder set for 6pm.",
        [tool("set_reminder")],
      ),
    ).toBeNull();
  });

  it("does NOT fire on 'Tell me to remind you'", () => {
    expect(
      detectHallucination("Tell me to remind you about the dentist.", []),
    ).toBeNull();
  });
});

describe("first-fire ordering", () => {
  it("returns the first matching guard when multiple verbs appear in the same reply", () => {
    const fired = detectHallucination(
      "I just sent the email AND added it to your cart.",
      [],
    );
    // Both email_sent and cart_add would match. The registry order
    // is calendar, google_file, email, cart, reminder, so email wins.
    expect(fired?.name).toBe("email_sent");
  });
});
