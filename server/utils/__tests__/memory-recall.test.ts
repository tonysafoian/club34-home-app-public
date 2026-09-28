/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the dynamic-import targets used by executeRememberFact / executeRecallFacts.
// vi.mock is hoisted, so these declarations must precede any import of the SUT.
const embedTextMock = vi.fn();
const queryMock = vi.fn();
const semanticRecallMock = vi.fn();
const invalidateMemoryIndexMock = vi.fn();

vi.mock("../embeddings.js", () => ({
  embedText: embedTextMock,
  toPgVectorLiteral: (v: number[]) => `[${v.join(",")}]`,
  EMBEDDING_DIMENSIONS: 768,
}));

vi.mock("../../lib/db.js", () => ({
  query: queryMock,
}));

// Semantic recall now goes through the in-process ANN index module
// (server/lib/memory-index.ts) instead of issuing SQL directly.
vi.mock("../../lib/memory-index.js", () => ({
  semanticRecall: semanticRecallMock,
  invalidateMemoryIndex: invalidateMemoryIndexMock,
}));

// Import after the mocks are registered. Use a dynamic import so the SUT
// resolves the mocked module references.
const { executeRecallFacts, executeRememberFact } = await import("../janus-tools.js");

/**
 * Build a chainable Supabase-style stub. Every chainable method returns
 * `self`; terminal verbs are awaited and return the configured payload.
 *
 * Configure with `stub.__queue(...payloads)`. Each terminal await consumes
 * one queue entry. `stub.__calls` records the (op, args) trail for assertions.
 */
type QueueEntry = { data?: any; error?: any; count?: number };
type Stub = {
  __calls: Array<{ op: string; args: any[] }>;
  __queue: (...entries: QueueEntry[]) => void;
  __pending: QueueEntry[];
  from: (table: string) => any;
};

function makeStub(): Stub {
  const stub: Stub = {
    __calls: [],
    __pending: [],
    __queue: (...entries) => stub.__pending.push(...entries),
    from(table: string) {
      stub.__calls.push({ op: "from", args: [table] });
      const builder: any = {};
      const passthroughs = [
        "select",
        "eq",
        "ilike",
        "order",
        "limit",
        "in",
        "upsert",
        "insert",
        "delete",
        "update",
      ];
      for (const m of passthroughs) {
        builder[m] = (...args: any[]) => {
          stub.__calls.push({ op: m, args });
          return builder;
        };
      }
      // Make the builder thenable so `await query` consumes one queue entry.
      builder.then = (resolve: (v: any) => any, reject?: (e: any) => any) => {
        const next = stub.__pending.shift();
        try {
          const value = next ?? { data: [], error: null };
          return Promise.resolve(value).then(resolve, reject);
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
      };
      return builder;
    },
  };
  return stub;
}

describe("executeRecallFacts — keyword path", () => {
  beforeEach(() => {
    embedTextMock.mockReset();
    queryMock.mockReset();
    semanticRecallMock.mockReset();
    invalidateMemoryIndexMock.mockReset();
  });

  it("returns keyword hits and never calls the embedding API", async () => {
    const stub = makeStub();
    stub.__queue({
      data: [{ key: "isla_food_allergies", value: "peanut, sesame", context: "", updated_at: "2026-05-01", pinned: false }],
      error: null,
    });

    const result = await executeRecallFacts(stub as any, "user-1", "isla");
    const parsed = JSON.parse(result);
    expect(parsed.path).toBe("keyword");
    expect(parsed.count).toBe(1);
    expect(parsed.facts[0].key).toBe("isla_food_allergies");
    expect(embedTextMock).not.toHaveBeenCalled();
    expect(semanticRecallMock).not.toHaveBeenCalled();
  });
});

describe("executeRecallFacts — semantic fallback", () => {
  beforeEach(() => {
    embedTextMock.mockReset();
    queryMock.mockReset();
    semanticRecallMock.mockReset();
    invalidateMemoryIndexMock.mockReset();
  });

  it("triggers semantic path when keyword returns empty and similarity passes the floor", async () => {
    const stub = makeStub();
    stub.__queue({ data: [], error: null });
    const queryEmbedding = Array(768).fill(0.1);
    embedTextMock.mockResolvedValueOnce(queryEmbedding);
    semanticRecallMock.mockResolvedValueOnce([
      { key: "isla_food_allergies", value: "peanut, sesame", context: null, updated_at: "2026-05-01", pinned: true, similarity: 0.82 },
      { key: "tony_birthday", value: "1975-04-12", context: null, updated_at: "2026-05-02", pinned: false, similarity: 0.40 },
    ]);

    const result = await executeRecallFacts(stub as any, "user-1", "isla allergy");
    const parsed = JSON.parse(result);
    expect(parsed.path).toBe("semantic");
    expect(parsed.count).toBe(1);
    expect(parsed.facts[0].key).toBe("isla_food_allergies");
    expect(parsed.facts[0].similarity).toBe(0.82);
    expect(parsed.facts[0].note).toBe("[via semantic match]");
    expect(embedTextMock).toHaveBeenCalledTimes(1);
    expect(semanticRecallMock).toHaveBeenCalledTimes(1);
    expect(semanticRecallMock).toHaveBeenCalledWith("user-1", queryEmbedding, 5);
  });

  it("returns empty-state message when both paths miss", async () => {
    const stub = makeStub();
    stub.__queue({ data: [], error: null });
    embedTextMock.mockResolvedValueOnce(Array(768).fill(0));
    semanticRecallMock.mockResolvedValueOnce([
      { key: "x", value: "y", context: null, updated_at: "", pinned: false, similarity: 0.10 },
    ]);

    const result = await executeRecallFacts(stub as any, "user-1", "weather on mars");
    expect(result).toBe('No memories found matching "weather on mars".');
  });

  it("falls through gracefully if the embedding call returns null", async () => {
    const stub = makeStub();
    stub.__queue({ data: [], error: null });
    embedTextMock.mockResolvedValueOnce(null);

    const result = await executeRecallFacts(stub as any, "user-1", "anything");
    expect(result).toBe('No memories found matching "anything".');
    expect(semanticRecallMock).not.toHaveBeenCalled();
  });

  it("returns the empty-state message when semantic recall throws", async () => {
    const stub = makeStub();
    stub.__queue({ data: [], error: null });
    embedTextMock.mockResolvedValueOnce(Array(768).fill(0.1));
    semanticRecallMock.mockRejectedValueOnce(new Error("index exploded"));

    const result = await executeRecallFacts(stub as any, "user-1", "anything");
    expect(result).toBe('No memories found matching "anything".');
  });
});

describe("executeRememberFact — pinned-aware FIFO eviction", () => {
  beforeEach(() => {
    embedTextMock.mockReset();
    queryMock.mockReset();
    semanticRecallMock.mockReset();
    invalidateMemoryIndexMock.mockReset();
  });

  it("does not delete pinned rows when the unpinned count exceeds the cap", async () => {
    const stub = makeStub();
    // Upsert.
    stub.__queue({ data: null, error: null });
    // Count of unpinned rows — over the 200 cap by 1.
    stub.__queue({ data: null, error: null, count: 201 });
    // Oldest unpinned rows query — returns the 1 row to delete.
    stub.__queue({ data: [{ id: "row-evict" }], error: null });
    // Delete call.
    stub.__queue({ data: null, error: null });

    embedTextMock.mockResolvedValueOnce(Array(768).fill(0.2));
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await executeRememberFact(
      stub as any,
      "user-1",
      "new_fact",
      "new value",
      undefined,
      false,
    );
    expect(result).toBe("Remembered: new_fact = new value");

    const opsAfterCount = stub.__calls.slice();
    // Verify the count query was filtered to pinned=false.
    const countCall = opsAfterCount.findIndex(
      (c, i) =>
        c.op === "eq" &&
        c.args[0] === "pinned" &&
        c.args[1] === false &&
        opsAfterCount[i - 1]?.op === "eq" &&
        opsAfterCount[i - 1].args[0] === "user_id",
    );
    expect(countCall).toBeGreaterThan(-1);

    // Verify the oldest-rows query was also filtered to pinned=false.
    const pinnedFilterCount = opsAfterCount.filter(
      (c) => c.op === "eq" && c.args[0] === "pinned" && c.args[1] === false,
    ).length;
    // Once on the count query, once on the oldest-rows query.
    expect(pinnedFilterCount).toBeGreaterThanOrEqual(2);

    // Verify delete was issued by id of the unpinned row.
    const deleteCall = opsAfterCount.find((c) => c.op === "delete");
    expect(deleteCall).toBeDefined();
    const inCall = opsAfterCount.find(
      (c) => c.op === "in" && c.args[0] === "id" && Array.isArray(c.args[1]) && c.args[1].includes("row-evict"),
    );
    expect(inCall).toBeDefined();

    // The ANN recall cache must be dropped after the write.
    expect(invalidateMemoryIndexMock).toHaveBeenCalledWith("user-1");
  });

  it("forwards pinned=true to the upsert payload and includes (pinned) in the response", async () => {
    const stub = makeStub();
    stub.__queue({ data: null, error: null });
    stub.__queue({ data: null, error: null, count: 0 });

    embedTextMock.mockResolvedValueOnce(Array(768).fill(0.3));
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await executeRememberFact(
      stub as any,
      "user-1",
      "alarm_code",
      "1234",
      "main entry keypad",
      true,
    );
    expect(result).toBe("Remembered: alarm_code = 1234 (pinned)");

    const upsertCall = stub.__calls.find((c) => c.op === "upsert");
    expect(upsertCall).toBeDefined();
    expect(upsertCall!.args[0].pinned).toBe(true);
  });

  it("still upserts the row when the embedding call fails", async () => {
    const stub = makeStub();
    stub.__queue({ data: null, error: null });
    stub.__queue({ data: null, error: null, count: 0 });

    embedTextMock.mockResolvedValueOnce(null);

    const result = await executeRememberFact(
      stub as any,
      "user-1",
      "k",
      "v",
      undefined,
      false,
    );
    expect(result).toBe("Remembered: k = v");
    // No UPDATE for the embedding column should have fired.
    expect(queryMock).not.toHaveBeenCalled();
    // Cache invalidation still happens — the row itself changed.
    expect(invalidateMemoryIndexMock).toHaveBeenCalledWith("user-1");
  });
});
