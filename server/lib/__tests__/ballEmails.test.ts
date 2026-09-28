import { describe, it, expect } from "vitest";
import {
  buildInviteEmail,
  buildDecisionOnEmail,
  buildDecisionOffEmail,
  buildReminderEmail,
} from "../ballEmails.js";

const base = {
  gameId: "game-1",
  playerName: "Brian Recker",
  playerToken: "br3k8m1p",
  gameDateIso: "2026-06-03",
  gameStart: "18:00",
  gameEnd: "20:00",
};

describe("ballEmails", () => {
  describe("buildInviteEmail", () => {
    it("includes the player's first name in greeting", () => {
      const e = buildInviteEmail(base);
      expect(e.text).toContain("Hey Brian");
    });

    it("includes both RSVP links with correct token", () => {
      const e = buildInviteEmail(base);
      expect(e.html).toContain("/ball/p/br3k8m1p?r=in");
      expect(e.html).toContain("/ball/p/br3k8m1p?r=out");
      expect(e.text).toContain("/ball/p/br3k8m1p?r=in");
    });

    it("has a subject mentioning the game date and time", () => {
      const e = buildInviteEmail(base);
      expect(e.subject).toMatch(/Wednesday/);
      expect(e.subject).toMatch(/6.*8pm/i);
    });

    it("escapes name HTML to prevent XSS", () => {
      const e = buildInviteEmail({ ...base, playerName: "<script>alert(1)</script>" });
      expect(e.html).not.toContain("<script>alert(1)</script>");
      expect(e.html).toContain("&lt;script&gt;");
    });
  });

  describe("buildDecisionOnEmail", () => {
    it("lists all confirmed names", () => {
      const e = buildDecisionOnEmail({
        ...base,
        confirmedCount: 3,
        confirmedNames: ["Alex Sample", "Brian Recker", "Chris Jones"],
      });
      expect(e.text).toContain("Alex Sample");
      expect(e.text).toContain("Brian Recker");
      expect(e.text).toContain("Chris Jones");
      expect(e.html).toContain("Alex Sample");
    });

    it("subject signals game is on", () => {
      const e = buildDecisionOnEmail({
        ...base,
        confirmedCount: 4,
        confirmedNames: ["A", "B", "C", "D"],
      });
      expect(e.subject).toMatch(/ON/i);
    });
  });

  describe("buildDecisionOffEmail", () => {
    it("subject signals game is off", () => {
      const e = buildDecisionOffEmail(base);
      expect(e.subject).toMatch(/off/i);
      expect(e.text).toContain("See you next Wednesday");
    });
  });

  describe("buildReminderEmail", () => {
    it("mentions 1 hour and the gate auto-approval", () => {
      const e = buildReminderEmail(base);
      expect(e.subject).toContain("1 hour");
      expect(e.html).toMatch(/gate is auto-approved/i);
    });
  });
});
