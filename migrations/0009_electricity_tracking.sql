-- Electricity tracking tables for LADWP cost intelligence system
-- Created: 2026-04-30

-- Stores imported LADWP bill data for reconciliation
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

-- Stores hourly/daily energy snapshots pulled from HA
CREATE TABLE IF NOT EXISTS electricity_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_at TIMESTAMPTZ NOT NULL,
  period TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kwh NUMERIC(10,4) NOT NULL,
  cost_usd NUMERIC(10,4),
  tier INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI-generated savings recommendations
CREATE TABLE IF NOT EXISTS electricity_recommendations (
  id SERIAL PRIMARY KEY,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  category TEXT,
  circuit_entity_id TEXT,
  headline TEXT NOT NULL,
  detail TEXT,
  potential_savings_usd_month NUMERIC(8,2),
  dismissed_at TIMESTAMPTZ
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_electricity_snapshots_at ON electricity_snapshots (snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_electricity_snapshots_entity ON electricity_snapshots (entity_id, snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_electricity_bills_period ON electricity_bills (billing_period_start DESC);

-- Seed the 4 known historical bills from parsed PDFs
INSERT INTO electricity_bills (billing_period_start, billing_period_end, ladwp_kwh, ladwp_total_usd, our_estimate_kwh, our_estimate_usd, variance_pct, raw_bill_data)
VALUES
  ('2025-08-18', '2025-10-21', 25840, 10141.10, 25840, NULL, NULL, '{"source":"pdf_parse","rate_schedule":"R-1A","zone":1,"tier1_rate":0.24404,"tier2_rate":0.30263,"tier3_rate":0.36109,"pac":"Tier 3","days":64}'),
  ('2025-10-21', '2025-12-22', 20240, 6793.20, 20240, NULL, NULL, '{"source":"pdf_parse","rate_schedule":"R-1A","zone":1,"tier1_rate":0.24606,"tier2_rate":0.30463,"tier3_rate":0.30463,"pac":"Tier 3","days":62}'),
  ('2025-12-22', '2026-02-23', 19360, 6528.50, 19360, NULL, NULL, '{"source":"pdf_parse","rate_schedule":"R-1A","zone":1,"tier1_rate":0.24747,"tier2_rate":0.30606,"tier3_rate":0.30606,"pac":"Tier 3","days":63}'),
  ('2026-02-23', '2026-04-21', 18400, 6179.36, 18400, NULL, NULL, '{"source":"pdf_parse","rate_schedule":"R-1A","zone":1,"tier1_rate":0.24620,"tier2_rate":0.30479,"tier3_rate":0.30479,"pac":"Tier 3","days":57}')
ON CONFLICT DO NOTHING;
