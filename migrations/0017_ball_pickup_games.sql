-- Club34 Ball — Wednesday Night Pickup Basketball
--
-- Half-court pickup games at Club34, Wednesdays 6–8pm.
-- Roster of ~47 dads from school + neighborhood. Minimum 4 to play.
-- Winners stay, rotation as more show. No auth — token-based personal
-- RSVP links sent via email. Public landing at /ball with name picker
-- fallback. Host admin at /admin?section=ball.
--
-- Three tables:
--   ball_players — pre-loaded roster, one token per dad for one-tap RSVP
--   ball_games   — scheduled game nights (June 2026 = 4 Wednesdays)
--   ball_rsvps   — one row per (game, player) once they respond

CREATE TABLE IF NOT EXISTS ball_players (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  phone         text,
  token         text NOT NULL UNIQUE,
  active        boolean NOT NULL DEFAULT true,
  -- is_host = Tony. Auto-confirmed IN for every game, skipped on all
  -- email blasts (invites, decisions, reminders). Counts toward the
  -- 6-player minimum since he's always playing.
  is_host       boolean NOT NULL DEFAULT false,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ball_players_active_idx
  ON ball_players (active, name);

CREATE TABLE IF NOT EXISTS ball_games (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_date       date NOT NULL UNIQUE,
  start_time      text NOT NULL DEFAULT '18:00',  -- 6pm
  end_time        text NOT NULL DEFAULT '20:00',  -- 8pm
  -- scheduled = future, on = confirmed (>=4 in), off = cancelled, done = past
  status          text NOT NULL DEFAULT 'scheduled',
  min_players     integer NOT NULL DEFAULT 4,
  notes           text,
  decision_sent_at timestamptz,                   -- Wed 2pm ON/OFF blast
  invite_sent_at  timestamptz,                    -- Monday invite blast
  reminder_sent_at timestamptz,                   -- Wed 5:30pm reminder
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ball_games_date_idx
  ON ball_games (game_date DESC);

CREATE INDEX IF NOT EXISTS ball_games_status_idx
  ON ball_games (status, game_date);

CREATE TABLE IF NOT EXISTS ball_rsvps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       uuid NOT NULL REFERENCES ball_games(id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES ball_players(id) ON DELETE CASCADE,
  -- in = playing, out = declined, maybe = tentative
  status        text NOT NULL,
  showed_up     boolean,                         -- post-game attendance mark (host)
  source        text NOT NULL DEFAULT 'web',     -- web | email-link | admin | sms
  -- GoAccess Control gate sync. When a dad RSVPs 'in', a worker pushes
  -- his name to GoAccess for the game date so the gate auto-admits him.
  -- If he switches to 'out', the entry gets removed. NULL = not yet synced.
  goaccess_registered_at  timestamptz,
  goaccess_visitor_id     text,                  -- ID returned by GoAccess for delete-on-cancel
  goaccess_sync_error     text,                  -- last sync error, if any
  responded_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS ball_rsvps_game_status_idx
  ON ball_rsvps (game_id, status);

CREATE INDEX IF NOT EXISTS ball_rsvps_player_idx
  ON ball_rsvps (player_id, responded_at DESC);
