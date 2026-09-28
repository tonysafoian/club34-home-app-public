import { describe, it, expect } from "vitest";
import { classifyForwardedEmail, splitForwardedBody } from "../forwardedEmailGuard.js";

describe("classifyForwardedEmail — should SUPPRESS reply", () => {
  it("the Tony appointment-confirmation case (Fwd:, no ask, transactional body)", () => {
    const result = classifyForwardedEmail({
      subject: "Fwd: Your In-home Appointment Confirmation  // 30630380",
      body: [
        "",
        "---------- Forwarded message ----------",
        "From: ServicePro <noreply@servicepro.com>",
        "Date: Mon, May 11, 2026 at 9:00 AM",
        "Subject: Your In-home Appointment Confirmation // 30630380",
        "To: admin@example.com",
        "",
        "Your appointment has been scheduled for Wednesday at 2pm.",
        "Order number: 30630380.",
      ].join("\n"),
    });
    expect(result.isForwardedTransactional).toBe(true);
    expect(result.reason).toMatch(/forwarded-message block/i);
  });

  it("Re: Fwd: chain with transactional content", () => {
    const result = classifyForwardedEmail({
      subject: "Re: Fwd: Order shipped — tracking 1Z999AA10123456784",
      body: [
        "(forwarded for filing)",
        "",
        "Begin forwarded message:",
        "Your order has shipped. Tracking number: 1Z999AA10123456784",
      ].join("\n"),
    });
    expect(result.isForwardedTransactional).toBe(true);
  });

  it("Outlook-style forwarded headers without explicit marker", () => {
    const result = classifyForwardedEmail({
      subject: "FW: Receipt for your order",
      body: [
        "",
        "From: store@example.com",
        "Sent: Monday, May 11, 2026 9:00 AM",
        "To: admin@example.com",
        "Subject: Receipt for your order",
        "",
        "Thanks for your purchase! Your invoice is attached.",
      ].join("\n"),
    });
    expect(result.isForwardedTransactional).toBe(true);
  });

  it("transactional body with no forwarded block but Fwd: subject", () => {
    const result = classifyForwardedEmail({
      subject: "Fwd: appointment confirmation",
      body: "Hi Tony, your appointment is confirmed for Friday at 10am.",
    });
    expect(result.isForwardedTransactional).toBe(true);
  });
});

describe("classifyForwardedEmail — should NOT suppress (real ask)", () => {
  it("forwarder asks a question above the forwarded block", () => {
    const result = classifyForwardedEmail({
      subject: "Fwd: Your appointment confirmation",
      body: [
        "Can you add this to my calendar?",
        "",
        "---------- Forwarded message ----------",
        "From: vendor@example.com",
        "Subject: Your appointment confirmation",
        "",
        "Confirmed for Tuesday 3pm.",
      ].join("\n"),
    });
    expect(result.isForwardedTransactional).toBe(false);
    expect(result.reason).toMatch(/ask/);
  });

  it("forwarder uses 'please' as a polite imperative", () => {
    const result = classifyForwardedEmail({
      subject: "Fwd: order shipped",
      body: [
        "Janus please file this under household.",
        "",
        "---------- Forwarded message ----------",
        "Your order has shipped.",
      ].join("\n"),
    });
    expect(result.isForwardedTransactional).toBe(false);
  });

  it("forwarder @mentions Janus", () => {
    const result = classifyForwardedEmail({
      subject: "Fwd: Receipt",
      body: [
        "@janus log this expense",
        "",
        "---------- Forwarded message ----------",
        "Receipt for $42 from store.",
      ].join("\n"),
    });
    expect(result.isForwardedTransactional).toBe(false);
  });

  it("non-forwarded email passes through (no Fwd: prefix)", () => {
    const result = classifyForwardedEmail({
      subject: "Question about the pool heater",
      body: "Hey Janus, why is the pool heater off this morning?",
    });
    expect(result.isForwardedTransactional).toBe(false);
    expect(result.reason).toMatch(/does not start with a forwarding marker/);
  });

  it("Fwd: subject but body is just chitchat, no transactional content", () => {
    const result = classifyForwardedEmail({
      subject: "Fwd: lunch idea",
      body: "Thought you'd like this place.",
    });
    expect(result.isForwardedTransactional).toBe(false);
    expect(result.reason).toMatch(/no forwarded-message block/);
  });

  it("question mark in forwarder portion blocks suppression even on otherwise-transactional bodies", () => {
    const result = classifyForwardedEmail({
      subject: "Fwd: appointment confirmation",
      body: [
        "did we already pay for this?",
        "",
        "---------- Forwarded message ----------",
        "Your appointment is confirmed.",
      ].join("\n"),
    });
    expect(result.isForwardedTransactional).toBe(false);
  });
});

describe("splitForwardedBody", () => {
  it("splits on Gmail-style forwarded marker", () => {
    const { forwarder, forwarded } = splitForwardedBody(
      "filing this\n\n---------- Forwarded message ----------\nfrom vendor",
    );
    expect(forwarder).toBe("filing this");
    expect(forwarded).toMatch(/Forwarded message/);
  });

  it("returns whole body as forwarder when no marker present", () => {
    const { forwarder, forwarded } = splitForwardedBody("just regular text");
    expect(forwarder).toBe("just regular text");
    expect(forwarded).toBe("");
  });
});
