import { describe, it, expect } from "vitest";
import { HnswIndex } from "../hnsw.js";

/** Deterministic PRNG for reproducible vectors. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rng: () => number, dim: number): number[] {
  return Array.from({ length: dim }, () => rng() * 2 - 1);
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function bruteForceTopK(vectors: number[][], query: number[], k: number): number[] {
  return vectors
    .map((v, id) => ({ id, sim: cosineSim(v, query) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, k)
    .map((x) => x.id);
}

describe("HnswIndex", () => {
  it("returns [] on an empty index", () => {
    const index = new HnswIndex(8);
    expect(index.search([1, 0, 0, 0, 0, 0, 0, 0], 5)).toEqual([]);
    expect(index.size).toBe(0);
  });

  it("finds an exact match with similarity ≈ 1", () => {
    const rng = mulberry32(42);
    const index = new HnswIndex(16, { seed: 1 });
    const vectors = Array.from({ length: 50 }, () => randomVector(rng, 16));
    for (const v of vectors) index.add(v);

    const hits = index.search(vectors[17], 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(17);
    expect(hits[0].similarity).toBeGreaterThan(0.999);
  });

  it("caps results at index size when k exceeds it", () => {
    const rng = mulberry32(7);
    const index = new HnswIndex(8, { seed: 1 });
    for (let i = 0; i < 3; i++) index.add(randomVector(rng, 8));
    const hits = index.search(randomVector(rng, 8), 10);
    expect(hits).toHaveLength(3);
    // Best-first ordering.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i].similarity).toBeLessThanOrEqual(hits[i - 1].similarity);
    }
  });

  it("rejects vectors of the wrong dimension", () => {
    const index = new HnswIndex(8);
    expect(() => index.add([1, 2, 3])).toThrow(/expected 8-dim/);
  });

  it("achieves ≥0.9 average recall@5 vs brute force on 500 random vectors", () => {
    const rng = mulberry32(1234);
    const dim = 32;
    const n = 500;
    const vectors = Array.from({ length: n }, () => randomVector(rng, dim));
    const index = new HnswIndex(dim, { seed: 99 });
    for (const v of vectors) index.add(v);

    const queries = 25;
    const k = 5;
    let totalRecall = 0;
    for (let qi = 0; qi < queries; qi++) {
      const q = randomVector(rng, dim);
      const truth = new Set(bruteForceTopK(vectors, q, k));
      const hits = index.search(q, k, 100);
      const found = hits.filter((h) => truth.has(h.id)).length;
      totalRecall += found / k;
    }
    expect(totalRecall / queries).toBeGreaterThanOrEqual(0.9);
  });

  it("returns similarities consistent with brute-force cosine similarity", () => {
    const rng = mulberry32(555);
    const dim = 24;
    const vectors = Array.from({ length: 100 }, () => randomVector(rng, dim));
    const index = new HnswIndex(dim, { seed: 3 });
    for (const v of vectors) index.add(v);

    const q = randomVector(rng, dim);
    const hits = index.search(q, 3, 100);
    for (const h of hits) {
      expect(Math.abs(h.similarity - cosineSim(vectors[h.id], q))).toBeLessThan(1e-4);
    }
  });
});
