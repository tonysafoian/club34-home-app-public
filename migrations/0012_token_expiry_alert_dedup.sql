-- Dedup table for the proactive token-expiration warning cron.
--
-- The cron runs daily at 9:00 AM PT and fans out one WhatsApp per
-- (user_id, kind) that's within 24h of token expiry. Without dedup,
-- transient cron retries / multiple HEAD-of-cron evaluations could
-- double-message Tony in the morning. Keyed by (user_id, kind) — same
-- (user_id, kind, day) collapses to one alert.

CREATE TABLE IF NOT EXISTS token_expiry_alert_dedup (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text        NOT NULL,
  kind        text        NOT NULL,
  alerted_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  UNIQUE (user_id, kind, alerted_at)
);

-- Lookup index for the "have we alerted this (user, kind) in the last 24h?" query.
CREATE INDEX IF NOT EXISTS token_expiry_alert_dedup_user_kind_idx
  ON token_expiry_alert_dedup (user_id, kind, alerted_at DESC);
