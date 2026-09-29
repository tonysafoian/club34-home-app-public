-- migrations/0042_reconcile_remaining_migration_drift.sql
--
-- Companion to 0041. While resolving the 0024/0025 grocery checksum drift, two
-- OTHER applied migrations were found to have been edited in place after being
-- recorded in the `_app_migrations` ledger, producing the same harmless-but-
-- noisy checksum-drift WARN on every `npm run migrate`:
--
--   0010_semantic_memory.sql
--     Edited by commit 28331509 ("defensive pgvector index"). The original
--     created `janus_memory_embedding_hnsw` directly; the edit wraps the SAME
--     idempotent `CREATE INDEX IF NOT EXISTS` in a HNSW → ivfflat → none
--     fallback DO block so prod (whose pgvector lacked HNSW) could publish.
--     No schema-contract divergence: the table columns (embedding, pinned) are
--     unchanged, and the vector index is explicitly optional by the migration's
--     own design ("no vector index created … fine at small scale").
--
--   0017_ball_pickup_games.sql
--     Edited by commit ae82d9b6 ("Fix outdated comment"). A pure SQL-comment
--     change (4-player → 6-player wording). Zero schema/data impact.
--
-- Neither has any real, unreconciled divergence, so — per DEPLOY_SAFETY.md
-- Rule 2 (do not edit applied files; use a forward-only migration) — this
-- migration re-stamps their ledger checksums to the canonical on-disk content
-- so future `npm run migrate` runs are clean. Same approach and safety as 0041.
--
-- Author: Computer, 2026-06-04

BEGIN;

-- 1. Verify the real schema contract of each edited migration is intact before
--    re-stamping. If anything is missing we ABORT and the drift warning
--    correctly remains rather than masking a genuinely diverged database.
DO $$
DECLARE
  missing text := '';
BEGIN
  -- 0010: janus_memory must carry the semantic-memory columns (if pgvector is available).
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'vector') THEN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='janus_memory' AND column_name='embedding'
    ) THEN missing := missing || ' janus_memory.embedding'; END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='janus_memory' AND column_name='pinned'
  ) THEN missing := missing || ' janus_memory.pinned'; END IF;
  -- (The HNSW/ivfflat vector index is intentionally optional by 0010's own
  --  defensive design, so its absence is NOT treated as divergence.)

  -- 0017: the ball pickup tables must exist.
  IF to_regclass('public.ball_players') IS NULL THEN missing := missing || ' ball_players'; END IF;
  IF to_regclass('public.ball_games')   IS NULL THEN missing := missing || ' ball_games';   END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION
      '0042: refusing to re-stamp 0010/0017 — schema not reconciled, missing:%', missing;
  END IF;
END $$;

-- 2. Re-stamp the ledger to the canonical on-disk checksums. Idempotent: a
--    no-op where the ledger already matches disk (e.g. prod, which applied the
--    defensive 0010 directly after its publish failure), and harmless where the
--    rows are absent (a fresh DB applies the current files and records the
--    canonical checksum directly).
UPDATE _app_migrations
SET checksum_sha256 = 'fcb60980bab4408c29c6917edfabe790edbf4e2c4c52e383eefee501e5ed432b'
WHERE filename = '0010_semantic_memory.sql';

UPDATE _app_migrations
SET checksum_sha256 = 'a5d2891f89b23c29e28e4a3fc0615f45bd0895bd046ec2dc0395f9cc42fc58e6'
WHERE filename = '0017_ball_pickup_games.sql';

COMMIT;
