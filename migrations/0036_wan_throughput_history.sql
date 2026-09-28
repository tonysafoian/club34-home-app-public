-- Rolling WAN throughput history — one row per ~60s sampler cron tick.
--
-- The POST /api/fortigate-wan-snapshot cron inserts the raw cumulative WAN
-- rx/tx GB counters (plus speed/status/link) read from the HA WAN sensors,
-- then prunes rows older than 4 hours on each insert. GET
-- /api/fortigate/wan-history?window=N reads the recent rows to render the
-- WAN History sparkline in the Admin Network → Traffic tab.
--
-- Mirrors the wanThroughputHistory table in shared/schema.ts. Idempotent so
-- it is safe to (re)apply in every environment via the standard runner.

BEGIN;

CREATE TABLE IF NOT EXISTS "wan_throughput_history" (
  "id"          uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "wan_rx_gb"   numeric(14,6),
  "wan_tx_gb"   numeric(14,6),
  "wan_speed"   numeric(10,2),
  "wan_status"  text,
  "wan_link"    boolean
);

CREATE INDEX IF NOT EXISTS "wan_throughput_history_captured_at_idx"
  ON "wan_throughput_history" ("captured_at" DESC);

COMMIT;
