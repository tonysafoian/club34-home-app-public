-- Grocery Helper Weekly Cycle — schema extensions.
--
-- Extends grocery_staples with product metadata (brand, size, ASIN, image, price),
-- extends grocery_order_runs with cycle tracking columns, and adds two new tables:
-- grocery_order_items (per-item cart rows with attribution) and
-- grocery_order_item_audit (immutable add/change/remove trail).
--
-- Cycle cadence: Saturday 00:00 PT → Friday 23:59 PT. Lock + submit at Fri 16:00 PT.
-- Delivery target: Monday of the following week.
--
-- All columns use IF NOT EXISTS / CREATE TABLE IF NOT EXISTS so this migration
-- is safe to re-run on a DB that already had some of these changes applied.

BEGIN;

-- ─── Extend grocery_staples ────────────────────────────────────────────────
ALTER TABLE grocery_staples
  ADD COLUMN IF NOT EXISTS brand       text,
  ADD COLUMN IF NOT EXISTS size        text,
  ADD COLUMN IF NOT EXISTS amazon_asin text,
  ADD COLUMN IF NOT EXISTS image_url   text,
  ADD COLUMN IF NOT EXISTS unit_price  numeric(10,2);

-- Unique index on amazon_asin (used by seed ON CONFLICT clause).
-- Partial so NULL values (items without an ASIN) are excluded from the unique constraint.
CREATE UNIQUE INDEX IF NOT EXISTS grocery_staples_amazon_asin_idx
  ON grocery_staples (amazon_asin)
  WHERE amazon_asin IS NOT NULL;

-- ─── Extend grocery_order_runs ─────────────────────────────────────────────
ALTER TABLE grocery_order_runs
  ADD COLUMN IF NOT EXISTS cycle_start_at     timestamptz,
  ADD COLUMN IF NOT EXISTS cycle_lock_at      timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_date      date,
  ADD COLUMN IF NOT EXISTS locked_at          timestamptz,
  ADD COLUMN IF NOT EXISTS submitted_at       timestamptz,
  ADD COLUMN IF NOT EXISTS submission_log     jsonb,
  ADD COLUMN IF NOT EXISTS created_by_user_id text;

-- Backfill legacy run rows: set cycle_start_at to the start of the ISO week
-- (Monday) in PT converted to UTC for rows that predate this migration.
-- This is best-effort — the legacy rows didn't track cycles.
UPDATE grocery_order_runs
SET cycle_start_at = (
  date_trunc('week', created_at AT TIME ZONE 'America/Los_Angeles')
  AT TIME ZONE 'America/Los_Angeles'
)
WHERE cycle_start_at IS NULL;

-- Partial unique index: at most one non-cancelled run per cycle start timestamp.
-- This is the guard that openCycleIfMissing uses to stay idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS grocery_order_runs_cycle_start_unique_idx
  ON grocery_order_runs (cycle_start_at)
  WHERE status <> 'cancelled';

-- ─── grocery_order_items ───────────────────────────────────────────────────
-- One row per item in a grocery order run.
-- staple_id is set when the item comes from the staples catalog;
-- NULL for ad-hoc one-offs (deduped within the run by amazon_asin instead).
-- Fields are snapshotted from the staple at add-time so the audit trail is
-- self-contained even if the staple is later edited or deleted.
CREATE TABLE IF NOT EXISTS grocery_order_items (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid         NOT NULL REFERENCES grocery_order_runs(id) ON DELETE CASCADE,
  staple_id        uuid         REFERENCES grocery_staples(id) ON DELETE SET NULL,
  amazon_asin      text,
  name             text         NOT NULL,
  category         text         NOT NULL DEFAULT 'general',
  brand            text,
  size             text,
  image_url        text,
  unit_price       numeric(10,2),
  quantity         integer      NOT NULL DEFAULT 1,
  added_by_user_id text,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now()
);

-- One entry per (run, staple) for catalog-backed items.
CREATE UNIQUE INDEX IF NOT EXISTS grocery_order_items_run_staple_idx
  ON grocery_order_items (run_id, staple_id)
  WHERE staple_id IS NOT NULL;

-- One entry per (run, asin) for ad-hoc one-off items (no staple_id).
CREATE UNIQUE INDEX IF NOT EXISTS grocery_order_items_run_asin_idx
  ON grocery_order_items (run_id, amazon_asin)
  WHERE staple_id IS NULL AND amazon_asin IS NOT NULL;

CREATE INDEX IF NOT EXISTS grocery_order_items_run_id_idx
  ON grocery_order_items (run_id);

-- ─── grocery_order_item_audit ──────────────────────────────────────────────
-- Immutable audit trail for every add/qty_changed/removed action.
-- item_id is nullable (SET NULL on cascade) so audit rows survive item deletion.
CREATE TABLE IF NOT EXISTS grocery_order_item_audit (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid        REFERENCES grocery_order_items(id) ON DELETE SET NULL,
  run_id        uuid        NOT NULL REFERENCES grocery_order_runs(id) ON DELETE CASCADE,
  action        text        NOT NULL,   -- added | qty_changed | removed
  actor_user_id text,
  old_qty       integer,
  new_qty       integer,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grocery_order_item_audit_run_id_idx
  ON grocery_order_item_audit (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS grocery_order_item_audit_item_id_idx
  ON grocery_order_item_audit (item_id)
  WHERE item_id IS NOT NULL;

COMMIT;
