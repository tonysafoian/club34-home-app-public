/**
 * Minimal in-process HNSW (Hierarchical Navigable Small World) index for
 * cosine similarity over dense embeddings.
 *
 * WHY THIS EXISTS: Replit's Publish pre-deploy schema diff cannot represent
 * a pgvector ANN index's operator class (vector_cosine_ops), so keeping an
 * HNSW/ivfflat index in the database blocks every production Publish (see
 * migrations/0046_drop_janus_memory_vector_index.sql). This module restores
 * sub-linear approximate-nearest-neighbour recall entirely in process
 * memory — the database schema stays untouched, so the publish-diff stays
 * empty.
 *
 * Design notes:
 * - Vectors are L2-normalised at insert/query time, so cosine distance
 *   reduces to `1 - dot(a, b)`.
 * - Level assignment uses a seeded deterministic RNG (mulberry32) so index
 *   builds are reproducible in tests.
 * - Insert-only: janus_memory rows are capped (~200 unpinned/user with FIFO
 *   eviction), and the owning cache rebuilds the whole index on any write,
 *   so per-node deletion is deliberately not implemented.
 */

export interface HnswSearchHit {
  /** Insertion-order id returned by add(). */
  id: number;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  similarity: number;
}

export interface HnswOptions {
  /** Max bidirectional links per node per layer (level 0 allows 2×M). */
  M?: number;
  /** Candidate-list size during construction. */
  efConstruction?: number;
  /** RNG seed for deterministic level assignment. */
  seed?: number;
}

interface HeapItem {
  id: number;
  dist: number;
}

/** Small binary heap; `before(a, b)` true when `a` should pop first. */
class BinaryHeap {
  private a: HeapItem[] = [];
  constructor(private before: (x: HeapItem, y: HeapItem) => boolean) {}

  get size(): number {
    return this.a.length;
  }

  peek(): HeapItem | undefined {
    return this.a[0];
  }

  push(item: HeapItem): void {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.before(a[i], a[p])) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else break;
    }
  }

  pop(): HeapItem | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.before(a[l], a[m])) m = l;
        if (r < a.length && this.before(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }

  toArray(): HeapItem[] {
    return this.a.slice();
  }
}

/** Deterministic PRNG (mulberry32). */
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

export class HnswIndex {
  private readonly dim: number;
  private readonly M: number;
  private readonly Mmax0: number;
  private readonly efConstruction: number;
  private readonly levelMult: number;
  private readonly rng: () => number;

  private vectors: Float32Array[] = [];
  /** links[id][level] = neighbour ids at that level. */
  private links: number[][][] = [];
  private entryPoint = -1;
  private maxLevel = -1;

  constructor(dim: number, opts: HnswOptions = {}) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`HnswIndex: invalid dimension ${dim}`);
    }
    this.dim = dim;
    this.M = opts.M ?? 16;
    this.Mmax0 = this.M * 2;
    this.efConstruction = opts.efConstruction ?? 200;
    this.levelMult = 1 / Math.log(this.M);
    this.rng = mulberry32(opts.seed ?? 0x9e3779b9);
  }

  get size(): number {
    return this.vectors.length;
  }

  /** Insert a vector; returns its insertion-order id (0, 1, 2, …). */
  add(vector: ArrayLike<number>): number {
    const vec = this.normalize(vector);
    const id = this.vectors.length;
    const level = Math.floor(
      -Math.log(Math.max(this.rng(), Number.MIN_VALUE)) * this.levelMult,
    );
    this.vectors.push(vec);
    this.links.push(Array.from({ length: level + 1 }, () => [] as number[]));

    if (this.entryPoint === -1) {
      this.entryPoint = id;
      this.maxLevel = level;
      return id;
    }

    // Greedy descend through layers above the new node's level.
    let ep = this.entryPoint;
    for (let lc = this.maxLevel; lc > level; lc--) {
      ep = this.greedyClosest(vec, ep, lc);
    }

    // Insert into each layer from min(level, maxLevel) down to 0.
    let eps = [ep];
    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const w = this.searchLayer(vec, eps, this.efConstruction, lc);
      const maxLinks = lc === 0 ? this.Mmax0 : this.M;
      const neighbors = w.slice(0, this.M);
      this.links[id][lc] = neighbors.map((n) => n.id);
      for (const n of neighbors) {
        const nl = this.links[n.id][lc];
        nl.push(id);
        if (nl.length > maxLinks) this.pruneNeighbors(n.id, lc, maxLinks);
      }
      eps = w.map((x) => x.id);
    }

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = id;
    }
    return id;
  }

  /**
   * Return the k approximate nearest neighbours by cosine similarity,
   * best first. `ef` bounds the layer-0 candidate list (recall knob).
   */
  search(vector: ArrayLike<number>, k: number, ef = 100): HnswSearchHit[] {
    if (this.entryPoint === -1 || k <= 0) return [];
    const q = this.normalize(vector);
    let ep = this.entryPoint;
    for (let lc = this.maxLevel; lc > 0; lc--) {
      ep = this.greedyClosest(q, ep, lc);
    }
    const w = this.searchLayer(q, [ep], Math.max(ef, k), 0);
    return w.slice(0, k).map((x) => ({ id: x.id, similarity: 1 - x.dist }));
  }

  private normalize(v: ArrayLike<number>): Float32Array {
    if (v.length !== this.dim) {
      throw new Error(
        `HnswIndex: expected ${this.dim}-dim vector, got ${v.length}`,
      );
    }
    const out = new Float32Array(this.dim);
    let norm = 0;
    for (let i = 0; i < this.dim; i++) {
      const x = v[i];
      out[i] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) out[i] /= norm;
    }
    return out;
  }

  /** Cosine distance between two already-normalised vectors. */
  private dist(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < this.dim; i++) dot += a[i] * b[i];
    return 1 - dot;
  }

  private greedyClosest(q: Float32Array, ep: number, level: number): number {
    let cur = ep;
    let curDist = this.dist(q, this.vectors[cur]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const nb of this.links[cur][level]) {
        const d = this.dist(q, this.vectors[nb]);
        if (d < curDist) {
          cur = nb;
          curDist = d;
          changed = true;
        }
      }
    }
    return cur;
  }

  /** Best-first search on one layer; returns up to ef items sorted by dist. */
  private searchLayer(
    q: Float32Array,
    eps: number[],
    ef: number,
    level: number,
  ): HeapItem[] {
    const visited = new Set<number>(eps);
    const candidates = new BinaryHeap((x, y) => x.dist < y.dist); // min-heap
    const results = new BinaryHeap((x, y) => x.dist > y.dist); // max-heap

    for (const ep of eps) {
      const d = this.dist(q, this.vectors[ep]);
      candidates.push({ id: ep, dist: d });
      results.push({ id: ep, dist: d });
    }
    while (results.size > ef) results.pop();

    let c = candidates.pop();
    while (c !== undefined) {
      const worst = results.peek();
      if (results.size >= ef && worst !== undefined && c.dist > worst.dist) {
        break;
      }
      for (const nb of this.links[c.id][level]) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const d = this.dist(q, this.vectors[nb]);
        const w = results.peek();
        if (results.size < ef || (w !== undefined && d < w.dist)) {
          candidates.push({ id: nb, dist: d });
          results.push({ id: nb, dist: d });
          if (results.size > ef) results.pop();
        }
      }
      c = candidates.pop();
    }
    return results.toArray().sort((x, y) => x.dist - y.dist);
  }

  private pruneNeighbors(id: number, level: number, maxLinks: number): void {
    const v = this.vectors[id];
    const scored = this.links[id][level].map((nb) => ({
      id: nb,
      dist: this.dist(v, this.vectors[nb]),
    }));
    scored.sort((a, b) => a.dist - b.dist);
    this.links[id][level] = scored.slice(0, maxLinks).map((s) => s.id);
  }
}
