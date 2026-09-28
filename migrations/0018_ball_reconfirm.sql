-- Club34 Ball — multi-game RSVP + Wednesday-morning hard re-confirm
--
-- Adds:
--   - reconfirm_sent_at on ball_games   (Wed 9am blast — game-day morning)
--   - reconfirmed_at on ball_rsvps      (when dad re-clicked "still in")
--   - Allow rsvp.status = 'pending_reconfirm' (a previously-IN dad
--     whose Wednesday morning email hasn't been re-confirmed yet)
--
-- Flow:
--   1. Month invite: dad RSVPs 'in' for some Wednesdays
--   2. Wed 9am: anyone IN for tonight gets a hard re-confirm email and
--      is flipped to 'pending_reconfirm' until they click
--   3. Re-click flips them back to 'in' and stamps reconfirmed_at
--   4. Wed 2pm decide(): only 'in' counts; pending_reconfirm = not playing
--   5. Wed 3pm GoAccess sync: only re-confirmed dads go on the gate list
--
-- Backward-compatible: no DROPs, all NULLABLE, existing rows keep working.

ALTER TABLE ball_games
  ADD COLUMN IF NOT EXISTS reconfirm_sent_at timestamptz;

ALTER TABLE ball_rsvps
  ADD COLUMN IF NOT EXISTS reconfirmed_at timestamptz;

-- We don't enforce a CHECK constraint on status (it's text, not an enum)
-- so 'pending_reconfirm' is implicitly allowed already.
