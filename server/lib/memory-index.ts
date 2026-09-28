/**
 * In-process approximate-nearest-neighbour recall over janus_memory
 * embeddings.
 *
 * In-process approximate-nearest-neighbour recall over janus_memory embeddings.
 * Lazily loads a user's embedded memories, builds an in-memory HNSW graph (server/lib/hnsw.ts),
 * and serves sub-millisecond semantic recall without relying on heavy external vector engines.
 *
 * Freshness model:
 * - Per-user cache with a short TTL (60 s) catches out-of-band writes
 *   (other autoscale instances, the embedding backfill script, admin edits).
 * - executeRememberFact invalidates the writer's own cache immediately, so
 *   same-instance remember → recall is never stale.
 * - On ANY failure the caller still gets correct results: we fall back to
 *   the exact pgvector sequential-scan query that has always worked.
 */

import { HnswIndex } from "./hnsw.js";
import { query } from "./db.js";
import { EMBEDDING_DIMENSIONS, toPgVectorLiteral } from "../utils/embeddings.js";

export interface MemoryMatch {
  key: string;
  value: string;
  context: string | null;
  updated_at: string | Date;
  pinned: boolean;
  similarity: number;
}

interface RawMemoryRow {
  key: string;
  value: string;
  context: string | null;
  updated_at: string | Date;
  pinned: boolean;
  embedding: string;
}

interface IndexedRow {
  key: string;
  value: string;
  context: string | null;
  updated_at: string | Date;
  pinned: boolean;
}

interface CachedUserIndex {
  index: HnswIndex;
  rows: IndexedRow[];
  builtAt: number;
}

const INDEX_TTL_MS = 60_000;
const MAX_CACHED_USERS = 32;
/** Layer-0 candidate list size — generous, so recall is near-exact. */
const EF_SEARCH = 100;

const cache = new Map<string, CachedUserIndex>();
const inflight = new Map<string, Promise<CachedUserIndex>>();

/** Drop one user's cached index (or all of them). Call after any write. */
export function invalidateMemoryIndex(userId?: string): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

/** pgvector text format is `[0.1,0.2,…]` — valid JSON. */
function parseEmbedding(text: string): number[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    const arr: unknown[] = parsed;
    if (arr.length !== EMBEDDING_DIMENSIONS) return null;
    const out: number[] = [];
    for (const v of arr) {
      if (typeof v !== "number" || !Number.isFinite(v)) return null;
      out.push(v);
    }
    return out;
  } catch {
    return null;
  }
}

async function buildUserIndex(userId: string): Promise<CachedUserIndex> {
  const { rows } = await query<RawMemoryRow>(
    `SELECT key, value, context, updated_at, pinned, embedding::text AS embedding
       FROM janus_memory
      WHERE user_id = $1 AND embedding IS NOT NULL`,
    [userId],
  );
  const index = new HnswIndex(EMBEDDING_DIMENSIONS);
  const indexed: IndexedRow[] = [];
  for (const row of rows) {
    const vec = parseEmbedding(row.embedding);
    if (!vec) continue;
    index.add(vec); // internal id === indexed.length at this point
    indexed.push({
      key: row.key,
      value: row.value,
      context: row.context,
      updated_at: row.updated_at,
      pinned: row.pinned === true,
    });
  }
  return { index, rows: indexed, builtAt: Date.now() };
}

function evictIfNeeded(): void {
  while (cache.size > MAX_CACHED_USERS) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (v.builtAt < oldestAt) {
        oldestAt = v.builtAt;
        oldestKey = k;
      }
    }
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

async function getUserIndex(userId: string): Promise<CachedUserIndex> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) return cached;
  const pending = inflight.get(userId);
  if (pending) return pending;
  const p = buildUserIndex(userId)
    .then((built) => {
      cache.set(userId, built);
      evictIfNeeded();
      return built;
    })
    .finally(() => {
      inflight.delete(userId);
    });
  inflight.set(userId, p);
  return p;
}

/**
 * Exact fallback: the original pgvector sequential scan. Correct at any
 * scale, just O(N) per query. Used whenever the ANN path fails.
 */
async function seqScanRecall(
  userId: string,
  embedding: number[],
  limit: number,
): Promise<MemoryMatch[]> {
  const { rows } = await query<MemoryMatch>(
    `SELECT key, value, context, updated_at, pinned,
            (1 - (embedding <=> $1::vector)) AS similarity
     FROM janus_memory
     WHERE user_id = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [toPgVectorLiteral(embedding), userId, limit],
  );
  return (rows || []).map((r) => ({
    key: r.key,
    value: r.value,
    context: r.context,
    updated_at: r.updated_at,
    pinned: r.pinned === true,
    similarity: typeof r.similarity === "number" ? r.similarity : Number(r.similarity),
  }));
}

/**
 * Top-`limit` semantic matches for a user's memories, best first.
 * ANN via the cached in-process HNSW index; exact sequential scan on any
 * failure. Similarity is cosine similarity in [-1, 1] — callers apply
 * their own floor.
 */
export async function semanticRecall(
  userId: string,
  embedding: number[],
  limit: number,
): Promise<MemoryMatch[]> {
  if (limit <= 0) return [];
  try {
    const { index, rows } = await getUserIndex(userId);
    if (index.size === 0) return [];
    const hits = index.search(embedding, Math.min(limit, index.size), EF_SEARCH);
    return hits.map((h) => ({ ...rows[h.id], similarity: h.similarity }));
  } catch (e) {
    console.warn(
      `[memory-index] ANN recall failed for ${userId}; falling back to sequential scan: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    invalidateMemoryIndex(userId);
    return seqScanRecall(userId, embedding, limit);
  }
}

/** Test-only visibility into the cache. */
export function getMemoryIndexCacheSize(): number {
  return cache.size;
}
