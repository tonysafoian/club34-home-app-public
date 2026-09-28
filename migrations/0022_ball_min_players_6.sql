-- Change ball_games min_players column default from 4 to 6.
-- Also bumps any existing future-scheduled games that still have
-- min_players = 4 so the new threshold applies to the June 2026 games.

ALTER TABLE ball_games ALTER COLUMN min_players SET DEFAULT 6;

UPDATE ball_games
SET    min_players = 6,
       updated_at  = now()
WHERE  status      = 'scheduled'
  AND  game_date   >= current_date
  AND  min_players = 4;
