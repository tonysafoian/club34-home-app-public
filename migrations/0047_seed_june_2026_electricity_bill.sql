-- Add the June 2026 LADWP electric bill to the historical record.
-- Continues the chained series seeded in 0009_electricity_tracking.sql:
-- the prior stored bill ends 2026-04-21, this one picks up exactly there.
--
-- Period 2026-04-21 .. 2026-06-22 (62 days), 18,320 kWh, $6,651.33.
-- Rate context (summer R-1A, zone 1, PAC Tier 3) is captured in raw_bill_data,
-- mirroring the seed-row convention. our_estimate_usd / variance_pct are left
-- NULL on purpose (same as the seed rows): the /comparison endpoint computes the
-- estimate live from the rate model, and that model is not calibrated to this
-- 2026 summer cycle (see commit notes), so a stored estimate would be misleading.
--
-- CREATE TABLE IF NOT EXISTS is defensive: it is a no-op on production (0009
-- already created the table) but lets this migration apply cleanly on a dev DB
-- whose electricity_bills table is absent due to ledger drift.
--
-- Idempotent via WHERE NOT EXISTS: electricity_bills has no unique key on the
-- period columns, so ON CONFLICT DO NOTHING would not actually dedupe a re-run.
-- The migration runner wraps this file in its own transaction (no BEGIN/COMMIT here).

CREATE TABLE IF NOT EXISTS electricity_bills (
  id SERIAL PRIMARY KEY,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  ladwp_kwh NUMERIC(10,2),
  ladwp_total_usd NUMERIC(10,2),
  our_estimate_kwh NUMERIC(10,2),
  our_estimate_usd NUMERIC(10,2),
  variance_pct NUMERIC(6,2),
  raw_bill_data JSONB,
  imported_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO electricity_bills
  (billing_period_start, billing_period_end, ladwp_kwh, ladwp_total_usd,
   our_estimate_kwh, our_estimate_usd, variance_pct, raw_bill_data)
SELECT
  '2026-04-21', '2026-06-22', 18320, 6651.33,
  18320, NULL, NULL,
  '{"source":"pdf_parse","rate_schedule":"R-1A","zone":1,"tier1_rate":0.24361,"tier2_rate":0.30221,"tier3_rate":0.33308,"pac":"Tier 3","days":62}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM electricity_bills
  WHERE billing_period_start = '2026-04-21' AND billing_period_end = '2026-06-22'
);
