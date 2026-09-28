-- Fix grocery_staples schema drift.
--
-- The grocery_staples table was left in a pre-0024 shape in the database even
-- though migration 0024_grocery_helper_cycle.sql was recorded as applied in
-- _app_migrations. The most likely cause is that a `drizzle-kit push` run at
-- some point during PR 2 / PR 3 work reverted the table to the older schema.
--
-- Current (broken) state:  size_label text, last_known_price_cents integer,
--                          last_priced_at timestamptz — missing size, unit_price.
-- Target (schema.ts) state: size text, unit_price numeric(10,2).
--
-- This migration is idempotent: ADD COLUMN IF NOT EXISTS means re-running it
-- is a no-op.
--
-- Legacy columns (size_label, last_known_price_cents, last_priced_at) are LEFT
-- IN PLACE for one deploy cycle as a safety net. See the commented-out DROP
-- statements at the bottom of this file — they should be applied in a follow-up
-- migration after confirming one clean deploy cycle.

BEGIN;

-- Add the new columns if they don't already exist.
ALTER TABLE grocery_staples
  ADD COLUMN IF NOT EXISTS size        text,
  ADD COLUMN IF NOT EXISTS unit_price  numeric(10,2);

-- Backfill from legacy columns if they exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'grocery_staples' AND column_name = 'size_label'
  ) THEN
    EXECUTE 'UPDATE grocery_staples SET size = size_label WHERE size IS NULL AND size_label IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'grocery_staples' AND column_name = 'last_known_price_cents'
  ) THEN
    EXECUTE 'UPDATE grocery_staples SET unit_price = last_known_price_cents / 100.0 WHERE unit_price IS NULL AND last_known_price_cents IS NOT NULL';
  END IF;
END $$;

-- ─── Follow-up: drop legacy columns after one clean deploy cycle ────────────
-- Uncomment and run in a subsequent migration (e.g. 0027_drop_grocery_legacy_cols.sql)
-- once the new columns have been confirmed healthy in production.
--
-- ALTER TABLE grocery_staples
--   DROP COLUMN IF EXISTS size_label,
--   DROP COLUMN IF EXISTS last_known_price_cents,
--   DROP COLUMN IF EXISTS last_priced_at;
-- ────────────────────────────────────────────────────────────────────────────

COMMIT;
