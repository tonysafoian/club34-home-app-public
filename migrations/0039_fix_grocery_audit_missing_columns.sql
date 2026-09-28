-- migrations/0039_fix_grocery_audit_missing_columns.sql
--
-- The production grocery_order_item_audit table was created before
-- writeItemAudit was refactored to use actor_user_id / old_qty / new_qty / detail.
-- CREATE TABLE IF NOT EXISTS in 0024 never adds columns to an already-existing
-- table, so production is missing these four columns and every audit insert
-- (and therefore every quantity update) throws a 500.
--
-- This migration is idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.

BEGIN;

ALTER TABLE grocery_order_item_audit
  ADD COLUMN IF NOT EXISTS actor_user_id text,
  ADD COLUMN IF NOT EXISTS old_qty       integer,
  ADD COLUMN IF NOT EXISTS new_qty       integer,
  ADD COLUMN IF NOT EXISTS detail        jsonb;

COMMIT;
