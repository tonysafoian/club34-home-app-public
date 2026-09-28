-- Club34 Ball — email engagement tracking
--
-- One row per email sent (per dad, per game, per email template).
-- Captures full lifecycle: created → sent → delivered/bounced → opened → clicked.
--
-- Privacy note: 'opened' is unreliable for Apple Mail users due to Apple
-- Mail Privacy Protection auto-fetching tracking pixels. Treat 'clicked'
-- as the only fully trustworthy engagement signal.

CREATE TABLE IF NOT EXISTS ball_email_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who & what
  player_id     uuid NOT NULL REFERENCES ball_players(id) ON DELETE CASCADE,
  game_id       uuid REFERENCES ball_games(id) ON DELETE CASCADE,
  template      text NOT NULL,        -- month-invite | reconfirm | decision-on | decision-off | reminder | other
  to_email      text NOT NULL,
  subject       text NOT NULL,
  -- Lifecycle timestamps
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,           -- when Gmail API accepted it
  delivered_at  timestamptz,           -- if we get delivery confirmation (rare)
  bounced_at    timestamptz,           -- if Gmail returned a 4xx/5xx
  opened_at     timestamptz,           -- first tracking-pixel hit
  open_count    integer NOT NULL DEFAULT 0,
  first_clicked_at timestamptz,
  click_count   integer NOT NULL DEFAULT 0,
  last_click_link text,                -- 'in' | 'out' | 'page' | etc.
  -- Errors
  send_error    text,                  -- Gmail API error message if send_at is null
  bounce_reason text,
  -- Metadata
  user_agent_first_open text,          -- helps identify Apple Mail vs real opens
  ip_first_open text,
  user_agent_first_click text
);

CREATE INDEX IF NOT EXISTS ball_email_sends_player_idx
  ON ball_email_sends (player_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ball_email_sends_game_idx
  ON ball_email_sends (game_id, template);

CREATE INDEX IF NOT EXISTS ball_email_sends_template_idx
  ON ball_email_sends (template, created_at DESC);
