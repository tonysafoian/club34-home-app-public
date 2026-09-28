import { describe, it, expect } from "vitest";
import { decodeMimeHeader, encodeMimeHeader } from "../mimeHeaders.js";

describe("decodeMimeHeader", () => {
  it("returns empty string for empty input", () => {
    expect(decodeMimeHeader("")).toBe("");
  });

  it("passes pure-ASCII through unchanged", () => {
    expect(decodeMimeHeader("Re: Order confirmation #30630380")).toBe(
      "Re: Order confirmation #30630380",
    );
  });

  it("decodes UTF-8 B-encoded words (e.g. emoji subject)", () => {
    // "Hello 🌍" base64-encoded as UTF-8: SGVsbG8g8J+MjQ==
    const enc = "=?UTF-8?B?SGVsbG8g8J+MjQ==?=";
    expect(decodeMimeHeader(enc)).toBe("Hello 🌍");
  });

  it("decodes UTF-8 Q-encoded words with underscore-as-space", () => {
    // "Café résumé" → spaces as underscores, accents as =XX
    const enc = "=?UTF-8?Q?Caf=C3=A9_r=C3=A9sum=C3=A9?=";
    expect(decodeMimeHeader(enc)).toBe("Café résumé");
  });

  it("reproduces the Tony bug input → clean output (the appointment confirmation case)", () => {
    // The real Gmail header was something like:
    //   Subject: =?UTF-8?B?WW91ciBJbi1ob21lIEFwcG9pbnRtZW50IENvbmZpcm1hdGlvbsKgwqAvLyAzMDYzMDM4MA==?=
    // which decodes to "Your In-home Appointment Confirmation\u00a0\u00a0// 30630380"
    // (the \u00a0 NBSPs are what eventually rendered as "Ã,Â Ã,Â" when not decoded).
    const enc =
      "=?UTF-8?B?WW91ciBJbi1ob21lIEFwcG9pbnRtZW50IENvbmZpcm1hdGlvbsKgwqAvLyAzMDYzMDM4MA==?=";
    const decoded = decodeMimeHeader(enc);
    expect(decoded).toBe(
      "Your In-home Appointment Confirmation\u00a0\u00a0// 30630380",
    );
    // Crucially: no mojibake substring.
    expect(decoded).not.toMatch(/Ã/);
    expect(decoded).not.toMatch(/Â/);
  });

  it("collapses whitespace between adjacent encoded-words (RFC 2047 §6.2)", () => {
    // Two B-encoded words separated by whitespace should join without a space.
    const enc = "=?UTF-8?B?SGVsbG8=?= =?UTF-8?B?V29ybGQ=?=";
    expect(decodeMimeHeader(enc)).toBe("HelloWorld");
  });

  it("preserves space between an encoded-word and an unencoded word", () => {
    const enc = "Hello =?UTF-8?B?V29ybGQ=?=";
    expect(decodeMimeHeader(enc)).toBe("Hello World");
  });

  it("is idempotent on already-decoded text", () => {
    const plain = "Your In-home Appointment Confirmation\u00a0\u00a0// 30630380";
    expect(decodeMimeHeader(plain)).toBe(plain);
  });

  it("leaves unrecognized fragments alone on malformed input", () => {
    // Missing closing ?= → not a valid encoded-word → return as-is.
    const bad = "=?UTF-8?B?SGVsbG8";
    expect(decodeMimeHeader(bad)).toBe(bad);
  });

  it("falls back gracefully for unsupported charsets without throwing", () => {
    // Charset we don't natively handle (Big5). Should not throw.
    const enc = "=?Big5?B?pmSm/A==?=";
    expect(() => decodeMimeHeader(enc)).not.toThrow();
  });
});

describe("encodeMimeHeader", () => {
  it("returns empty string for empty input", () => {
    expect(encodeMimeHeader("")).toBe("");
  });

  it("leaves pure-ASCII unchanged", () => {
    expect(encodeMimeHeader("Re: Order confirmation #30630380")).toBe(
      "Re: Order confirmation #30630380",
    );
  });

  it("wraps non-ASCII into a UTF-8 B-encoded word", () => {
    const input = "Café résumé";
    const out = encodeMimeHeader(input);
    expect(out).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    // Round-trip must reproduce the input exactly.
    expect(decodeMimeHeader(out)).toBe(input);
  });

  it("round-trips emoji subjects", () => {
    const input = "Reminder 🚗 Tesla service Tuesday";
    expect(decodeMimeHeader(encodeMimeHeader(input))).toBe(input);
  });

  it("round-trips the NBSP-containing subject without producing mojibake", () => {
    const input = "Re: Your In-home Appointment Confirmation\u00a0\u00a0// 30630380";
    const encoded = encodeMimeHeader(input);
    // Must not put raw UTF-8 bytes on the wire — encoded form is ASCII only.
    expect(encoded).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeMimeHeader(encoded)).toBe(input);
  });

  it("encodes em-dash subjects (common in marketing headers)", () => {
    const input = "Janus — meeting prep";
    const encoded = encodeMimeHeader(input);
    expect(encoded).not.toBe(input); // must encode
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    expect(decodeMimeHeader(encoded)).toBe(input);
  });
});
