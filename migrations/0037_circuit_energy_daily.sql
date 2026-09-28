-- Per-circuit daily energy snapshots.
-- Club34 owns its own copy of every Emporia circuit's daily kWh so monthly
-- reports work indefinitely, independent of HA's recorder purge window.
-- A daily cron (05:10 PT) backfills the prior LA day for all ENERGY_CIRCUITS.
-- Idempotent: (entity_id, usage_date) is unique so re-runs upsert in place.

CREATE TABLE IF NOT EXISTS "circuit_energy_daily" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "usage_date" date NOT NULL,            -- LA-local calendar day the kWh was consumed
  "entity_id" text NOT NULL,             -- HA energy statistic id, e.g. sensor.balance_energy_today_2
  "label" text NOT NULL,                 -- human label at snapshot time
  "category" text NOT NULL,              -- Panels / HVAC / Vehicles / Outdoor / Kitchen / Lighting / Other
  "kwh" numeric(12,4) NOT NULL DEFAULT 0,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "circuit_energy_daily_entity_date_uniq" UNIQUE ("entity_id", "usage_date")
);

CREATE INDEX IF NOT EXISTS "circuit_energy_daily_usage_date_idx"
  ON "circuit_energy_daily" ("usage_date" DESC);

CREATE INDEX IF NOT EXISTS "circuit_energy_daily_category_date_idx"
  ON "circuit_energy_daily" ("category", "usage_date" DESC);
