-- migrations/0040_fix_grocery_audit_name_nullable.sql
--
-- The production grocery_order_item_audit table has a `name NOT NULL` column
-- that was present in the original schema before 0024 was applied.  Canonical
-- migration history (0024) never created a `name` column, so fresh dev envs
-- don't have it.  Only prod (and any DB that pre-dated 0024) has the column
-- and the NOT NULL constraint.
--
-- writeItemAudit does not supply a name value (it stores it in detail jsonb),
-- so the constraint must be dropped where the column exists.  On DBs where
-- the column was never added this block is a no-op.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   information_schema.columns
    WHERE  table_name  = 'grocery_order_item_audit'
    AND    column_name = 'name'
    AND    is_nullable = 'NO'
  ) THEN
    ALTER TABLE grocery_order_item_audit ALTER COLUMN name DROP NOT NULL;
  END IF;
END $$;

COMMIT;
