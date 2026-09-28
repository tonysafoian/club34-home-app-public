-- Semantic memory + pinned facts for Janus.
--
-- Adds Gemini text-embedding-004 vector (768 dim) and a pinned flag to
-- janus_memory. Pinned rows survive the 200-row FIFO eviction in
-- executeRememberFact.
--
-- pgvector must be enabled on the target Postgres instance. Replit Postgres
-- 16 ships with the extension available; this migration enables it.
--
-- The vector index is created via a defensive DO block that tries HNSW
-- (best, requires pgvector >= 0.5.0) → ivfflat (broadly available) → no
-- index (semantic recall still works via sequential scan; fine at our
-- ~1K rows/user scale). This was added after a 2026-05-12 production
-- publish failure where the prod Postgres pgvector version did not
-- support HNSW.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE janus_memory
  ADD COLUMN IF NOT EXISTS embedding vector(768),
  ADD COLUMN IF NOT EXISTS pinned    boolean NOT NULL DEFAULT false;

-- Vector index: HNSW → ivfflat → none.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS janus_memory_embedding_hnsw ON janus_memory USING hnsw (embedding vector_cosine_ops)';
    RAISE NOTICE 'janus_memory: HNSW index created';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'janus_memory: HNSW unsupported (%), trying ivfflat', SQLERRM;
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS janus_memory_embedding_ivfflat ON janus_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)';
      RAISE NOTICE 'janus_memory: ivfflat index created';
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'janus_memory: no vector index created (%); recall will fall back to sequential scan. Fine at small scale.', SQLERRM;
    END;
  END;
END
$$;

-- Speeds up the read path (last 25 updated per user) and the pinned-aware
-- FIFO eviction query that scans oldest unpinned rows per user.
CREATE INDEX IF NOT EXISTS janus_memory_user_updated_idx
  ON janus_memory (user_id, updated_at DESC);
