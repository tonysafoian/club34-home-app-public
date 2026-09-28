-- Club34 Time Tracking (T&M Contractor) schema
-- Migration 0050
-- Adds:
--   - 'worker' value to app_role enum
--   - role column to invited_emails
--   - tt_status enum
--   - tt_workers, tt_rate_history, tt_categories, tt_worker_categories,
--     tt_time_entries, tt_expenses, tt_payments tables

-- ── 1. Extend app_role enum ───────────────────────────────────────────────
ALTER TYPE app_role ADD VALUE IF NOT EXISTS 'worker';

-- ── 2. Add role column to invited_emails ──────────────────────────────────
ALTER TABLE invited_emails
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

-- ── 3. tt_status enum ─────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE tt_status AS ENUM ('pending', 'approved', 'rejected', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. tt_categories ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 5. tt_workers ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_workers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID,
  full_name           TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  mobile              TEXT,
  zelle_handle        TEXT,
  can_add_expenses    BOOLEAN NOT NULL DEFAULT false,
  default_category_id UUID REFERENCES tt_categories(id),
  active              BOOLEAN NOT NULL DEFAULT true,
  deactivated_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          UUID
);

CREATE INDEX IF NOT EXISTS tt_workers_email_idx ON tt_workers(email);
CREATE INDEX IF NOT EXISTS tt_workers_active_idx ON tt_workers(active);

-- ── 6. tt_rate_history ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_rate_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id         UUID NOT NULL REFERENCES tt_workers(id),
  hourly_rate_cents INTEGER NOT NULL CHECK (hourly_rate_cents > 0),
  effective_from    DATE NOT NULL,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, effective_from)
);

CREATE INDEX IF NOT EXISTS tt_rate_history_worker_idx ON tt_rate_history(worker_id, effective_from DESC);

-- ── 7. tt_worker_categories ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_worker_categories (
  worker_id   UUID NOT NULL REFERENCES tt_workers(id),
  category_id UUID NOT NULL REFERENCES tt_categories(id),
  PRIMARY KEY (worker_id, category_id)
);

-- ── 8. tt_payments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id        UUID NOT NULL REFERENCES tt_workers(id),
  week_start       DATE NOT NULL,
  hours_total      NUMERIC(7,2) NOT NULL,
  labor_cents      INTEGER NOT NULL,
  expenses_cents   INTEGER NOT NULL DEFAULT 0,
  total_cents      INTEGER NOT NULL,
  method           TEXT NOT NULL DEFAULT 'zelle_manual',
  confirmation_ref TEXT,
  note             TEXT,
  paid_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_by          UUID NOT NULL,
  UNIQUE (worker_id, week_start)
);

CREATE INDEX IF NOT EXISTS tt_payments_worker_week_idx ON tt_payments(worker_id, week_start);

-- ── 9. tt_time_entries ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_time_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       UUID NOT NULL REFERENCES tt_workers(id),
  work_date       DATE NOT NULL,
  category_id     UUID NOT NULL REFERENCES tt_categories(id),
  hours           NUMERIC(5,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  note            TEXT,
  rate_cents      INTEGER NOT NULL,
  status          tt_status NOT NULL DEFAULT 'pending',
  rejected_reason TEXT,
  approved_at     TIMESTAMPTZ,
  approved_by     UUID,
  payment_id      UUID REFERENCES tt_payments(id),
  is_adjustment   BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID
);

CREATE INDEX IF NOT EXISTS tt_time_entries_worker_date_idx ON tt_time_entries(worker_id, work_date);
CREATE INDEX IF NOT EXISTS tt_time_entries_status_idx ON tt_time_entries(status);
CREATE INDEX IF NOT EXISTS tt_time_entries_work_date_idx ON tt_time_entries(work_date);

-- ── 10. tt_expenses ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tt_expenses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id       UUID NOT NULL REFERENCES tt_workers(id),
  expense_date    DATE NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  note            TEXT NOT NULL,
  receipt_url     TEXT,
  category_id     UUID REFERENCES tt_categories(id),
  status          tt_status NOT NULL DEFAULT 'pending',
  rejected_reason TEXT,
  approved_at     TIMESTAMPTZ,
  approved_by     UUID,
  payment_id      UUID REFERENCES tt_payments(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tt_expenses_worker_date_idx ON tt_expenses(worker_id, expense_date);
CREATE INDEX IF NOT EXISTS tt_expenses_status_idx ON tt_expenses(status);
