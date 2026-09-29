-- Restore the semantic-memory vector index on janus_memory.embedding.
--
-- Migration 0010_semantic_memory.sql intended to create a vector similarity
-- index on janus_memory.embedding (HNSW, falling back to ivfflat). On both the
-- dev and prod databases that index was found missing (neither
-- janus_memory_embedding_hnsw nor janus_memory_embedding_ivfflat existed), so
-- Janus semantic-memory recall (the `embedding <=> $1::vector` cosine lookup in
-- server/utils/janus-tools.ts) was falling back to a sequential scan over every
-- stored embedding. That is "fine at small scale" but degrades as memory volume
-- grows. This forward-only migration re-creates the index.
--
-- Reuses the same defensive DO block as 0010: HNSW (best, requires
-- pgvector >= 0.5.0) → ivfflat (broadly available) → no index (recall still
-- works via sequential scan). All steps are idempotent (CREATE INDEX IF NOT
-- EXISTS), so re-running is a no-op.
--
-- Chosen index type: HNSW. Both dev and prod run pgvector 0.8.0, which supports
-- HNSW, so the HNSW branch succeeds and janus_memory_embedding_hnsw is created
-- with vector_cosine_ops (matching the cosine-distance `<=>` recall query).

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pgvector extension is not available on this Postgres system (%). Vector index restore skipped.', SQLERRM;
  END;
END $$;

-- Vector index: HNSW → ivfflat → none.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'janus_memory' AND column_name = 'embedding'
  ) THEN
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
  END IF;
END
$$;
