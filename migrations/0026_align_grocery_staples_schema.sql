-- 0026_align_grocery_staples_schema.sql
--
-- Aligns grocery_staples DB schema with shared/schema.ts after a divergence
-- discovered 2026-05-17 evening.
--
-- ── Background ─────────────────────────────────────────────────────────────
-- Migration 0024 was edited in place between two commits:
--   v1 (4b8e720): ADDed size_label, last_known_price_cents, last_priced_at
--   v2 (4267c41): ADDed size, unit_price, image_url (different names)
-- The migration runner ledger already had a row for 0024 (applied 22:56 UTC
-- under v1), so the v2 ADD COLUMN IF NOT EXISTS statements never re-ran.
-- Result: DB has v1's columns (size_label / last_known_price_cents /
-- last_priced_at), shared/schema.ts declares v2's columns (size / unit_price /
-- image_url), and every code path that does `staple.size` or
-- `staple.unit_price` SELECTs a non-existent column in prod.
--
-- This migration adds the v2 columns (idempotent), backfills them from the
-- v1 columns, and creates the unique index on amazon_asin that v2 wanted.
-- The v1 columns are DELIBERATELY LEFT IN PLACE for now so a rollback is
-- possible if the new columns turn out wrong. A follow-up migration (0027,
-- ~1 week from now) will drop them once we're confident.
--
-- ── Safety ─────────────────────────────────────────────────────────────────
-- - All ALTERs are IF NOT EXISTS / IF EXISTS → idempotent and re-runnable
-- - Backfills are guarded with WHERE … IS NULL → won't overwrite existing data
-- - No DROP COLUMN until 0027
-- - Wrapped in a single transaction → atomic
--
-- ── Verification after running ─────────────────────────────────────────────
--   \d grocery_staples            -- expect BOTH old + new columns present
--   SELECT count(*) FILTER (WHERE size IS NOT NULL),
--          count(*) FILTER (WHERE unit_price IS NOT NULL)
--   FROM grocery_staples;          -- expect counts to match the populated v1 columns
--
-- Schema migration for grocery staples

BEGIN;

-- 1. Add the v2 columns. Idempotent.
ALTER TABLE grocery_staples
  ADD COLUMN IF NOT EXISTS size        text,
  ADD COLUMN IF NOT EXISTS unit_price  numeric(10,2);

-- (image_url already exists per the DB inspection — but keep the line so this
-- migration is correct if applied to a DB without it.)
ALTER TABLE grocery_staples
  ADD COLUMN IF NOT EXISTS image_url   text;

-- 2. Backfill new columns from old. Both UPDATEs are no-ops if the source
--    columns are NULL or the destination is already populated.
UPDATE grocery_staples
SET size = size_label
WHERE size IS NULL
  AND size_label IS NOT NULL;

-- last_known_price_cents is integer cents; unit_price is numeric dollars.
-- 599 cents → 5.99
UPDATE grocery_staples
SET unit_price = last_known_price_cents::numeric / 100
WHERE unit_price IS NULL
  AND last_known_price_cents IS NOT NULL;

-- 3. Ensure the unique index that migration 0024 v2 intended exists.
--    Idempotent. If 0024 v1 already created an equivalent index under a
--    different name, both will coexist harmlessly (Postgres allows
--    duplicate unique indexes on the same columns).
CREATE UNIQUE INDEX IF NOT EXISTS grocery_staples_amazon_asin_idx
  ON grocery_staples (amazon_asin)
  WHERE amazon_asin IS NOT NULL;

-- 4. Sanity check: assert the schema is now consistent enough for the
--    application code to query without errors. The application reads
--    .size and .unit_price; both must exist on the table.
DO $$
DECLARE
  size_col_exists boolean;
  price_col_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'grocery_staples'
      AND column_name = 'size'
  ) INTO size_col_exists;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'grocery_staples'
      AND column_name = 'unit_price'
  ) INTO price_col_exists;

  IF NOT size_col_exists THEN
    RAISE EXCEPTION '0026: grocery_staples.size still missing after migration';
  END IF;
  IF NOT price_col_exists THEN
    RAISE EXCEPTION '0026: grocery_staples.unit_price still missing after migration';
  END IF;
END $$;

COMMIT;
