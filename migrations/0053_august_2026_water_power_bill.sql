-- Ingest the 2026-06-22 .. 2026-08-19 LADWP bill.
--
-- The PDF contains both electricity and water. Electricity continues the
-- existing electricity_bills series. Water gets its own actual-bill table so
-- modeled daily telemetry can be reconciled against the meter and bill-level
-- year-over-year trends can drive Water Intelligence suggestions.

CREATE TABLE IF NOT EXISTS water_bills (
  id SERIAL PRIMARY KEY,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  ladwp_hcf NUMERIC(10,2) NOT NULL,
  ladwp_gallons NUMERIC(14,2) NOT NULL,
  water_usd NUMERIC(10,2) NOT NULL,
  sewer_usd NUMERIC(10,2),
  solid_waste_usd NUMERIC(10,2),
  total_new_charges_usd NUMERIC(10,2),
  prior_year_hcf NUMERIC(10,2),
  prior_year_days INTEGER,
  raw_bill_data JSONB,
  imported_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_water_bills_period_unique
  ON water_bills (billing_period_start, billing_period_end);
CREATE INDEX IF NOT EXISTS idx_water_bills_period
  ON water_bills (billing_period_start DESC);

INSERT INTO electricity_bills
  (billing_period_start, billing_period_end, ladwp_kwh, ladwp_total_usd,
   our_estimate_kwh, our_estimate_usd, variance_pct, raw_bill_data)
SELECT
  '2026-06-22', '2026-08-19', 22720, 9978.86,
  22720, NULL, NULL,
  '{
    "source":"pdf_parse",
    "bill_date":"2026-08-19",
    "rate_schedule":"R-1A",
    "zone":1,
    "days":58,
    "prior_year_kwh":19680,
    "prior_year_days":59,
    "tier1_kwh":700,
    "tier1_rate":0.26126,
    "tier2_kwh":1400,
    "tier2_rate":0.31985,
    "tier3_kwh":20620,
    "tier3_rate":0.40686,
    "power_access_charge":45.40,
    "utility_tax":906.55,
    "state_surcharge":6.82
  }'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM electricity_bills
  WHERE billing_period_start = '2026-06-22'
    AND billing_period_end = '2026-08-19'
);

INSERT INTO water_bills
  (billing_period_start, billing_period_end, ladwp_hcf, ladwp_gallons,
   water_usd, sewer_usd, solid_waste_usd, total_new_charges_usd,
   prior_year_hcf, prior_year_days, raw_bill_data)
VALUES
  (
    '2026-06-22', '2026-08-19', 217, 162316,
    3179.32, 884.73, 414.07, 14456.98,
    211, 59,
    '{
      "source":"pdf_parse",
      "bill_date":"2026-08-19",
      "days":58,
      "rate_schedule":"Schedule A Single-Dwelling",
      "temperature_zone":"MEDIUM",
      "tier1_hcf":16,
      "tier1_rate":11.89,
      "tier2_hcf":62,
      "tier2_rate":14.33355,
      "tier3_hcf":124,
      "tier3_rate":15.07952,
      "tier4_hcf":15,
      "tier4_rate":15.36933,
      "extra_capacity_refuse_usd":188.92
    }'::jsonb
  )
ON CONFLICT (billing_period_start, billing_period_end) DO NOTHING;