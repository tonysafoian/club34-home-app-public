-- Club34 Ball — capture jersey size at first-waiver sign-up.
--
-- When a dad signs the click-through waiver for the first time, the
-- player UI also asks them to pick a jersey size so Tony has the
-- info on hand for swag / pinnies. The column is nullable so existing
-- already-signed players don't get retroactively forced to pick, but
-- the backend now refuses the first waiver sign without a size.

ALTER TABLE ball_players
  ADD COLUMN IF NOT EXISTS jersey_size text;

-- Whitelist the allowed sizes. The check tolerates NULL (legacy rows)
-- and is the same set the picker renders on the frontend.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ball_players_jersey_size_check'
  ) THEN
    ALTER TABLE ball_players
      ADD CONSTRAINT ball_players_jersey_size_check
      CHECK (jersey_size IS NULL OR jersey_size IN ('S','M','L','XL','XXL','XXXL'));
  END IF;
END$$;
