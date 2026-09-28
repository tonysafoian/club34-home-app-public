-- Fix grocery_order_items schema drift.
--
-- The grocery_order_items table is missing three columns that the Drizzle
-- schema (shared/schema.ts) and server/routes/grocery.ts require:
--   size text, unit_price numeric(10,2), added_by_user_id text
--
-- The likely cause is that migration 0024_grocery_helper_cycle.sql's
-- CREATE TABLE IF NOT EXISTS was a no-op against the pre-existing table,
-- leaving the older schema in place (with legacy columns size_label,
-- unit_price_cents, added_by instead).
--
-- This causes every add/upsert/patch in the grocery cart to fail with
-- Postgres error 42703 (undefined column), showing "Could not update
-- quantity" in the UI.
--
-- This migration is idempotent: ADD COLUMN IF NOT EXISTS means re-running
-- it is a no-op.
--
-- Legacy columns (size_label, unit_price_cents, added_by, last_edited_by,
-- platform, amazon_url, notes) are LEFT IN PLACE as a safety net.
-- See the commented-out DROP statements at the bottom — they should be
-- applied in a follow-up migration after confirming one clean deploy cycle.

BEGIN;

-- Add the new columns if they don't already exist.
ALTER TABLE grocery_order_items
  ADD COLUMN IF NOT EXISTS size               text,
  ADD COLUMN IF NOT EXISTS unit_price         numeric(10,2),
  ADD COLUMN IF NOT EXISTS added_by_user_id   text;

-- Backfill size from size_label for rows where size is NULL and size_label is populated.
UPDATE grocery_order_items
SET size = size_label
WHERE size IS NULL
  AND size_label IS NOT NULL;

-- Backfill unit_price from unit_price_cents (cents → dollars) for rows
-- where unit_price is NULL and unit_price_cents is populated.
UPDATE grocery_order_items
SET unit_price = unit_price_cents / 100.0
WHERE unit_price IS NULL
  AND unit_price_cents IS NOT NULL;

-- Backfill added_by_user_id from added_by for rows where added_by_user_id
-- is NULL and added_by is populated.
UPDATE grocery_order_items
SET added_by_user_id = added_by
WHERE added_by_user_id IS NULL
  AND added_by IS NOT NULL;

-- ─── Follow-up: drop legacy columns after one clean deploy cycle ────────────
-- Uncomment and run in a subsequent migration (e.g. 0036_drop_grocery_order_items_legacy_cols.sql)
-- once the new columns have been confirmed healthy in production.
--
-- ALTER TABLE grocery_order_items
--   DROP COLUMN IF EXISTS size_label,
--   DROP COLUMN IF EXISTS unit_price_cents,
--   DROP COLUMN IF EXISTS added_by,
--   DROP COLUMN IF EXISTS last_edited_by,
--   DROP COLUMN IF EXISTS platform,
--   DROP COLUMN IF EXISTS amazon_url,
--   DROP COLUMN IF EXISTS notes;
-- ────────────────────────────────────────────────────────────────────────────

COMMIT;
