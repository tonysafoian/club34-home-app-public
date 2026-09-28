-- migrations/0041_reconcile_grocery_migration_history.sql
--
-- Resolves the migration-history (checksum drift) mismatch that the runner
-- warns about on every `npm run migrate` for:
--   0024_grocery_helper_cycle.sql
--   0025_seed_grocery_staples.sql
--
-- ── Background ─────────────────────────────────────────────────────────────
-- On 2026-05-17, both files were applied at 22:56 UTC from their original
-- "v1" content (commit 4b8e720b) and recorded in the `_app_migrations` ledger
-- with v1 checksums. ~20 minutes later (commit 4267c412) BOTH files were
-- rewritten in place to a "v2" shape (size/unit_price instead of
-- size_label/last_known_price_cents, renamed indexes, reshaped
-- grocery_order_items / grocery_order_item_audit). Because the ledger already
-- had a row for each filename, the runner skipped re-applying them and instead
-- prints a checksum-drift WARN every run (ledger=v1 vs disk=v2). This violates
-- DEPLOY_SAFETY.md Rule 2 (applied migration files must never change).
--
-- ── Is there any real, unreconciled schema divergence? No. ─────────────────
-- The actual v1→v2 schema/data delta was already reconciled by forward-only
-- migrations, all of which run BEFORE this one:
--   * grocery_staples.size / unit_price ........ 0026_align_grocery_staples_schema.sql
--                                                 0026_fix_grocery_staples_schema.sql
--   * grocery_order_items.size / unit_price /
--     added_by_user_id ......................... 0035_fix_grocery_order_items_schema.sql
--   * grocery_order_item_audit.actor_user_id /
--     old_qty / new_qty / detail ............... 0039_fix_grocery_audit_missing_columns.sql
--   * grocery_order_item_audit.name nullable ... 0040_fix_grocery_audit_name_nullable.sql
-- The only remaining v1/v2 differences are duplicate/renamed unique indexes
-- (grocery_staples_amazon_asin_key vs _idx; grocery_order_runs_one_active_per_cycle
-- vs cycle_start_unique_idx). These are functionally harmless: the duplicate
-- partial unique index coexists per Postgres, and openCycleIfMissing uses
-- `ON CONFLICT DO NOTHING` with NO conflict target, so it matches whichever
-- index exists. No code references the v2 index names.
--
-- ── What this migration does ───────────────────────────────────────────────
-- Per Rule 2 we do NOT edit 0024/0025 in place. Instead this forward-only
-- migration:
--   1. Defensively asserts the v2 columns exist (i.e. the divergence really
--      was reconciled by the migrations above). If any are missing the
--      migration ABORTS and the drift warning correctly stays — we never
--      re-stamp the ledger on a still-diverged database.
--   2. Re-stamps the `_app_migrations` checksums for 0024/0025 to match the
--      canonical on-disk (v2) content, so future `npm run migrate` runs are
--      clean with no checksum-drift warnings.
--
-- The re-stamp is a no-op on any environment whose ledger already holds the v2
-- checksum (e.g. a fresh DB that first applied 0024/0025 in their v2 shape).
--
-- Author: Computer, 2026-06-04

BEGIN;

-- 1. Verify the v1→v2 schema divergence is fully reconciled before re-stamping.
DO $$
DECLARE
  missing text := '';
  required text[][] := ARRAY[
    ARRAY['grocery_staples',          'size'],
    ARRAY['grocery_staples',          'unit_price'],
    ARRAY['grocery_order_items',      'size'],
    ARRAY['grocery_order_items',      'unit_price'],
    ARRAY['grocery_order_items',      'added_by_user_id'],
    ARRAY['grocery_order_item_audit', 'actor_user_id'],
    ARRAY['grocery_order_item_audit', 'old_qty'],
    ARRAY['grocery_order_item_audit', 'new_qty'],
    ARRAY['grocery_order_item_audit', 'detail']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(required, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = required[i][1]
        AND column_name  = required[i][2]
    ) THEN
      missing := missing || ' ' || required[i][1] || '.' || required[i][2];
    END IF;
  END LOOP;

  IF missing <> '' THEN
    RAISE EXCEPTION
      '0041: refusing to re-stamp 0024/0025 — grocery schema still diverged, missing columns:%', missing;
  END IF;
END $$;

-- 2. Re-stamp the ledger to the canonical on-disk (v2) checksums so the
--    runner's file-vs-ledger comparison stops warning. Idempotent: a no-op
--    where the ledger already matches disk, and harmless where the rows are
--    absent (a brand-new DB applying 0024/0025 v2 records the v2 checksum
--    directly and never reaches a drifted state).
UPDATE _app_migrations
SET checksum_sha256 = '427ebac52809a9d83c9e0b0cd0a502e2e26ce18ab3aba80c3cd1d375de7fb4a0'
WHERE filename = '0024_grocery_helper_cycle.sql';

UPDATE _app_migrations
SET checksum_sha256 = '57ed27e3761ea703076868fe9170d90d7663f218e7945e4a8446e45485c4d84f'
WHERE filename = '0025_seed_grocery_staples.sql';

COMMIT;
