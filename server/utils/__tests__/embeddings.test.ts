/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { embedText, toPgVectorLiteral, EMBEDDING_DIMENSIONS } from "../embeddings.js";

const ORIGINAL_FETCH = globalThis.fetch;

describe("embeddings.embedText", () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("returns a 768-dim vector on success", async () => {
    const values = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 1000);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values } }),
    }) as unknown as typeof fetch;

    const result = await embedText("hello world");
    expect(result).not.toBeNull();
    expect(result).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result?.[1]).toBeCloseTo(0.001);
  });

  it("returns null on 401 without throwing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    }) as unknown as typeof fetch;

    const result = await embedText("hello");
    expect(result).toBeNull();
  });

  it("returns null when the network call throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const result = await embedText("hello");
    expect(result).toBeNull();
  });

  it("returns null when the embedding shape is wrong", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    }) as unknown as typeof fetch;

    const result = await embedText("hello");
    expect(result).toBeNull();
  });

  it("returns null when no API key is configured", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await embedText("hello");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null on empty input without hitting the network", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const result = await embedText("   ");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("truncates inputs longer than 10000 chars before calling the API", async () => {
    let capturedBody: string | null = null;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = (init as any)?.body ?? null;
      return {
        ok: true,
        json: async () => ({
          embedding: { values: Array(EMBEDDING_DIMENSIONS).fill(0) },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const huge = "a".repeat(15_000);
    await embedText(huge);
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.content.parts[0].text).toHaveLength(10_000);
  });
});

describe("embeddings.toPgVectorLiteral", () => {
  it("formats the array as the pgvector string literal", () => {
    expect(toPgVectorLiteral([1, 2, 3])).toBe("[1,2,3]");
  });

  it("handles an empty array", () => {
    expect(toPgVectorLiteral([])).toBe("[]");
  });
});
