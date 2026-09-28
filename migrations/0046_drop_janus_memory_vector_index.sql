-- Drop the optional pgvector ANN index on janus_memory.embedding.
--
-- WHY: Replit's Publish flow runs a pre-deploy schema diff that introspects the
-- DEV database and replicates new objects onto PROD. drizzle-style introspection
-- CANNOT represent a pgvector HNSW/ivfflat index's required operator class
-- (vector_cosine_ops), so it emits an invalid statement:
--   CREATE INDEX "janus_memory_embedding_hnsw" ON "janus_memory" USING hnsw ("embedding");
-- which fails with: data type vector has no default operator class for access
-- method "hnsw". Because that validation runs BEFORE the deploy's
-- `npm run migrate`, prod could never self-heal and every Publish was blocked
-- whenever DEV had the index but PROD did not.
--
-- The index is OPTIONAL by design (see 0010/0042): semantic-memory recall
-- (`embedding <=> $1::vector` in server/utils/janus-tools.ts) works correctly via
-- a sequential scan, which is exactly how PROD has always run (PROD has never had
-- the index). Dropping it in BOTH environments keeps every future publish-diff
-- EMPTY and eliminates the pgvector/HNSW incompatibility for good.
--
-- On a fresh PROD deploy the runner applies 0045 (creates the index) then this
-- 0046 (drops it) in sequence, netting NO vector ANN index — matching DEV.
-- Idempotent (IF EXISTS), so re-running is a no-op.
--
-- If/when approximate-nearest-neighbour performance is needed at scale,
-- reintroduce the index via a path that is NOT subject to the Replit publish-diff
-- (e.g. an external/dedicated vector store), not a raw migration on this DB.

DROP INDEX IF EXISTS janus_memory_embedding_hnsw;
DROP INDEX IF EXISTS janus_memory_embedding_ivfflat;
