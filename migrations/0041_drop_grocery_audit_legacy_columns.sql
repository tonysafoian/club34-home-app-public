-- migrations/0041_drop_grocery_audit_legacy_columns.sql
--
-- grocery_order_item_audit accumulated two overlapping column sets:
--   * Legacy set (only ever existed on prod / pre-0024 DBs):
--       actor_id, actor_name, qty_before, qty_after, staple_id, amazon_asin, name
--   * Canonical set (added by 0039 to match writeItemAudit + Drizzle schema):
--       actor_user_id, old_qty, new_qty, detail
--
-- Nothing in the codebase writes or reads the legacy columns anymore:
--   * writeItemAudit() inserts only the canonical columns.
--   * Every SELECT is `SELECT *` mapped onto GroceryAuditRow, which references
--     only action / actor_user_id / old_qty / new_qty / detail / created_at.
-- 0040 already dropped the NOT NULL on `name`. This migration removes the
-- orphaned columns so the table matches shared/schema.ts.
--
-- This migration is idempotent: DROP COLUMN IF EXISTS is a no-op on DBs
-- (e.g. fresh dev) that never had the legacy columns.

BEGIN;

ALTER TABLE grocery_order_item_audit
  DROP COLUMN IF EXISTS actor_id,
  DROP COLUMN IF EXISTS actor_name,
  DROP COLUMN IF EXISTS qty_before,
  DROP COLUMN IF EXISTS qty_after,
  DROP COLUMN IF EXISTS staple_id,
  DROP COLUMN IF EXISTS amazon_asin,
  DROP COLUMN IF EXISTS name;

COMMIT;
