ALTER TABLE circuit_energy_daily
  ADD COLUMN IF NOT EXISTS source_complete boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN circuit_energy_daily.source_complete IS
  'True only when Home Assistant returned a real statistics point for this circuit/day; legacy zero-filled rows remain false until a trustworthy backfill replaces them.';