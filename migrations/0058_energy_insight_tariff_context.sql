ALTER TABLE energy_insight_investigations
  ADD COLUMN IF NOT EXISTS tariff_tier integer;