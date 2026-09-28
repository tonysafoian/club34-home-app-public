/**
 * Compatibility guard for the token encryption used for saved Home Assistant
 * tokens (server/lib/encryption.ts).
 *
 * Tokens saved today must remain decryptable forever, so this suite pins down
 * the two things that would silently break them if changed:
 *
 *  1. Key derivation: SHA-256(ENCRYPTION_KEY || SESSION_SECRET) imported as a
 *     raw AES-256-GCM key. Verified both against an independent node:crypto
 *     re-implementation and a golden fixture ciphertext.
 *  2. Wire format: base64( 12-byte IV ‖ ciphertext+16-byte GCM tag ).
 *
 * If any test here fails after touching encryption.ts, the change is NOT
 * backwards compatible — previously saved tokens would become unreadable.
 * Do not "fix" the test; add a migration/versioned format instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, createDecipheriv } from "node:crypto";
import { encryptToken, decryptToken } from "../encryption.js";

const TYPICAL_KEY = "a-typical-encryption-key-with-plenty-of-entropy-0123456789";
// A realistic Home Assistant long-lived access token (JWT-ish, ~180 chars).
const TYPICAL_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  "eyJpc3MiOiJhYmNkZWYwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OSIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoyMDAwMDAwMDAwfQ." +
  "3q2-7wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEY", TYPICAL_KEY);
  vi.stubEnv("SESSION_SECRET", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Decrypt using ONLY the documented contract (node:crypto, no webcrypto,
 * nothing shared with the implementation). If encryption.ts drifts from the
 * documented derivation or wire format, this fails even though the module's
 * own round-trip might still pass. */
function decryptPerDocumentedContract(encrypted: string, keySource: string): string {
  const key = createHash("sha256").update(keySource, "utf8").digest(); // 32 bytes
  const combined = Buffer.from(encrypted, "base64");
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(12, combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

describe("encryptToken / decryptToken round-trip", () => {
  it("round-trips a typical Home Assistant long-lived token", async () => {
    const encrypted = await encryptToken(TYPICAL_TOKEN);
    expect(encrypted).not.toBe(TYPICAL_TOKEN);
    await expect(decryptToken(encrypted)).resolves.toBe(TYPICAL_TOKEN);
  });

  it("round-trips with SHORT key material (< 32 bytes) thanks to SHA-256 derivation", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "abc"); // AES-GCM alone would reject a 3-byte key
    const encrypted = await encryptToken(TYPICAL_TOKEN);
    await expect(decryptToken(encrypted)).resolves.toBe(TYPICAL_TOKEN);
  });

  it("round-trips short and unicode plaintexts", async () => {
    for (const plaintext of ["x", "short-token", "τσιμπούκι-🔐-токен"]) {
      const encrypted = await encryptToken(plaintext);
      await expect(decryptToken(encrypted)).resolves.toBe(plaintext);
    }
  });

  it("uses a fresh random IV per call (same plaintext ⇒ different ciphertexts)", async () => {
    const a = await encryptToken(TYPICAL_TOKEN);
    const b = await encryptToken(TYPICAL_TOKEN);
    expect(a).not.toBe(b);
    const ivA = Buffer.from(a, "base64").subarray(0, 12);
    const ivB = Buffer.from(b, "base64").subarray(0, 12);
    expect(ivA.equals(ivB)).toBe(false);
    await expect(decryptToken(a)).resolves.toBe(TYPICAL_TOKEN);
    await expect(decryptToken(b)).resolves.toBe(TYPICAL_TOKEN);
  });
});

describe("wire format: base64( 12-byte IV ‖ ciphertext + 16-byte GCM tag )", () => {
  it("output is valid base64 with length 12 + plaintextBytes + 16", async () => {
    const plaintext = "0123456789"; // 10 utf-8 bytes
    const encrypted = await encryptToken(plaintext);
    const combined = Buffer.from(encrypted, "base64");
    // Round-tripping through base64 proves it was canonical base64.
    expect(combined.toString("base64")).toBe(encrypted);
    expect(combined.length).toBe(12 + 10 + 16);
  });

  it("is decryptable by an independent implementation of the documented contract", async () => {
    const encrypted = await encryptToken(TYPICAL_TOKEN);
    expect(decryptPerDocumentedContract(encrypted, TYPICAL_KEY)).toBe(TYPICAL_TOKEN);
  });

  it("rejects tampered ciphertext (GCM auth) instead of returning garbage", async () => {
    const encrypted = await encryptToken(TYPICAL_TOKEN);
    const combined = Buffer.from(encrypted, "base64");
    combined[combined.length - 1] ^= 0xff; // corrupt the auth tag
    await expect(decryptToken(combined.toString("base64"))).rejects.toThrow();
  });
});

describe("key derivation compatibility (golden fixture)", () => {
  // Generated once with the current implementation and ENCRYPTION_KEY below.
  // If decrypting this ever fails, the key derivation or wire format changed
  // incompatibly and ALL previously saved tokens are unreadable.
  const FIXTURE_KEY = "vitest-fixture-key";
  const FIXTURE_PLAINTEXT = "ha-token-fixture-plaintext";
  const FIXTURE_CIPHERTEXT =
    "FXbb590hufXejxwvMwqZKWhvwtwNZ8HOf334oRS08MQ1Y+6WyR+d7Mc7b+z3YCsnrPmIy/fp";

  it("still decrypts a ciphertext produced by the original implementation", async () => {
    vi.stubEnv("ENCRYPTION_KEY", FIXTURE_KEY);
    await expect(decryptToken(FIXTURE_CIPHERTEXT)).resolves.toBe(FIXTURE_PLAINTEXT);
  });

  it("prefers ENCRYPTION_KEY over SESSION_SECRET", async () => {
    vi.stubEnv("ENCRYPTION_KEY", FIXTURE_KEY);
    vi.stubEnv("SESSION_SECRET", "some-other-session-secret");
    await expect(decryptToken(FIXTURE_CIPHERTEXT)).resolves.toBe(FIXTURE_PLAINTEXT);
  });

  it("falls back to SESSION_SECRET when ENCRYPTION_KEY is unset", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("SESSION_SECRET", FIXTURE_KEY);
    await expect(decryptToken(FIXTURE_CIPHERTEXT)).resolves.toBe(FIXTURE_PLAINTEXT);
  });

  it("fails (rather than returning garbage) when decrypting under a different key", async () => {
    const encrypted = await encryptToken(TYPICAL_TOKEN);
    vi.stubEnv("ENCRYPTION_KEY", "a-completely-different-key");
    await expect(decryptToken(encrypted)).rejects.toThrow();
  });

  it("throws a clear error when no key material is configured", async () => {
    vi.stubEnv("ENCRYPTION_KEY", "");
    vi.stubEnv("SESSION_SECRET", "");
    await expect(encryptToken("anything")).rejects.toThrow(/ENCRYPTION_KEY/);
  });
});
