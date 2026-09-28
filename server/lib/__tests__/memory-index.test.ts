import { describe, it, expect, beforeEach, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../db.js", () => ({
  query: queryMock,
}));

const { semanticRecall, invalidateMemoryIndex, getMemoryIndexCacheSize } =
  await import("../memory-index.js");
const { EMBEDDING_DIMENSIONS } = await import("../../utils/embeddings.js");

/** 768-dim unit-ish vector with weight concentrated at `axis`. */
function axisVector(axis: number, dim = EMBEDDING_DIMENSIONS): number[] {
  const v = new Array<number>(dim).fill(0.001);
  v[axis] = 1;
  return v;
}

function toPgText(v: number[]): string {
  return `[${v.join(",")}]`;
}

interface RowSpec {
  key: string;
  value: string;
  embedding: number[];
  pinned?: boolean;
  context?: string | null;
}

function dbRows(specs: RowSpec[]) {
  return {
    rows: specs.map((s) => ({
      key: s.key,
      value: s.value,
      context: s.context ?? null,
      updated_at: "2026-08-01T00:00:00Z",
      pinned: s.pinned === true,
      embedding: toPgText(s.embedding),
    })),
    rowCount: specs.length,
  };
}

describe("semanticRecall — ANN path", () => {
  beforeEach(() => {
    queryMock.mockReset();
    invalidateMemoryIndex();
  });

  it("returns closest memories best-first with cosine similarity", async () => {
    queryMock.mockResolvedValueOnce(
      dbRows([
        { key: "dog_name", value: "Rex", embedding: axisVector(0) },
        { key: "cat_name", value: "Momo", embedding: axisVector(1), pinned: true },
        { key: "wifi_pass", value: "hunter2", embedding: axisVector(2) },
      ]),
    );

    const matches = await semanticRecall("user-1", axisVector(1), 2);
    expect(matches).toHaveLength(2);
    expect(matches[0].key).toBe("cat_name");
    expect(matches[0].pinned).toBe(true);
    expect(matches[0].similarity).toBeGreaterThan(0.99);
    expect(matches[1].similarity).toBeLessThan(matches[0].similarity);
    // Only the index-build query ran — no per-recall SQL.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(String(queryMock.mock.calls[0][0])).toContain("embedding::text");
  });

  it("reuses the cached index within the TTL", async () => {
    queryMock.mockResolvedValueOnce(
      dbRows([{ key: "a", value: "1", embedding: axisVector(0) }]),
    );
    await semanticRecall("user-1", axisVector(0), 1);
    await semanticRecall("user-1", axisVector(0), 1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(getMemoryIndexCacheSize()).toBe(1);
  });

  it("rebuilds after invalidateMemoryIndex(userId)", async () => {
    queryMock.mockResolvedValue(
      dbRows([{ key: "a", value: "1", embedding: axisVector(0) }]),
    );
    await semanticRecall("user-1", axisVector(0), 1);
    invalidateMemoryIndex("user-1");
    await semanticRecall("user-1", axisVector(0), 1);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("caches per user independently", async () => {
    queryMock.mockResolvedValue(
      dbRows([{ key: "a", value: "1", embedding: axisVector(0) }]),
    );
    await semanticRecall("user-1", axisVector(0), 1);
    await semanticRecall("user-2", axisVector(0), 1);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(getMemoryIndexCacheSize()).toBe(2);
  });

  it("returns [] when the user has no embedded memories", async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const matches = await semanticRecall("user-1", axisVector(0), 5);
    expect(matches).toEqual([]);
  });

  it("skips rows with malformed or wrong-dimension embeddings", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { key: "good", value: "v", context: null, updated_at: "", pinned: false, embedding: toPgText(axisVector(0)) },
        { key: "short", value: "v", context: null, updated_at: "", pinned: false, embedding: "[1,2,3]" },
        { key: "junk", value: "v", context: null, updated_at: "", pinned: false, embedding: "not-json" },
      ],
      rowCount: 3,
    });
    const matches = await semanticRecall("user-1", axisVector(0), 5);
    expect(matches.map((m) => m.key)).toEqual(["good"]);
  });
});

describe("semanticRecall — sequential-scan fallback", () => {
  beforeEach(() => {
    queryMock.mockReset();
    invalidateMemoryIndex();
  });

  it("falls back to the exact pgvector query when the index build fails", async () => {
    queryMock.mockRejectedValueOnce(new Error("db down"));
    queryMock.mockResolvedValueOnce({
      rows: [
        { key: "a", value: "1", context: null, updated_at: "", pinned: false, similarity: 0.91 },
      ],
      rowCount: 1,
    });

    const matches = await semanticRecall("user-1", axisVector(0), 5);
    expect(matches).toHaveLength(1);
    expect(matches[0].key).toBe("a");
    expect(matches[0].similarity).toBe(0.91);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(String(queryMock.mock.calls[1][0])).toContain("embedding <=> $1::vector");
  });

  it("propagates the error when the fallback also fails", async () => {
    queryMock.mockRejectedValue(new Error("db really down"));
    await expect(semanticRecall("user-1", axisVector(0), 5)).rejects.toThrow(
      "db really down",
    );
  });
});
