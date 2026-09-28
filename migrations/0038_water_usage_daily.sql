-- Per-day water usage snapshots (interior + irrigation), the WATER analogue of
-- circuit_energy_daily (electricity). Club34 owns its own copy of daily water
-- usage so monthly cost reports work indefinitely, independent of any upstream
-- purge window.
--
-- Two NON-OVERLAPPING sources:
--   source = 'interior'    → FloLogic whole-property interior gallons (no zone)
--   source = 'irrigation'  → Rain Bird per-zone gallons (zone = HA entity_id)
-- Total property water for a day = interior + sum(irrigation zones).
--
-- A daily cron (~05:15 PT) computes the prior LA-local day and upserts rows.
-- Idempotent: (usage_date, source, zone) is unique so re-runs upsert in place.

CREATE TABLE IF NOT EXISTS "water_usage_daily" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "usage_date" date NOT NULL,                 -- LA-local calendar day
  "source" text NOT NULL,                     -- 'interior' | 'irrigation'
  "zone" text,                                -- irrigation zone HA entity_id; null for interior
  "gallons" numeric(14,2) NOT NULL DEFAULT 0,
  "hcf" numeric(14,4) NOT NULL DEFAULT 0,     -- gallons / 748
  "dollars" numeric(12,2) NOT NULL DEFAULT 0, -- tiered LADWP water cost attributed to this row
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One row per (day, source, zone). Interior has zone NULL, so use COALESCE in
-- the unique index to make NULL zones collide as intended for upserts.
CREATE UNIQUE INDEX IF NOT EXISTS "water_usage_daily_date_source_zone_uniq"
  ON "water_usage_daily" ("usage_date", "source", COALESCE("zone", ''));

CREATE INDEX IF NOT EXISTS "water_usage_daily_usage_date_idx"
  ON "water_usage_daily" ("usage_date" DESC);

CREATE INDEX IF NOT EXISTS "water_usage_daily_source_date_idx"
  ON "water_usage_daily" ("source", "usage_date" DESC);
