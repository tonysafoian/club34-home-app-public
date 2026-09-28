-- Club34 Ball — click-through liability waiver
--
-- One row per (player, waiver_version) per signing. Active waivers are
-- those with revoked_at IS NULL. The partial unique index ensures at
-- most one active waiver per player per version so the gate logic in
-- POST /api/ball/rsvp can do a simple "active waiver exists?" check.
--
-- Tony (the host) is backfilled at the bottom so the host never has
-- to click anything on /ball/p/:token.

CREATE TABLE IF NOT EXISTS ball_waivers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id       uuid NOT NULL REFERENCES ball_players(id) ON DELETE CASCADE,
  waiver_version  text NOT NULL,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  ip              text,
  user_agent      text,
  revoked_at      timestamptz
);

-- Only one ACTIVE waiver per (player, version). Re-signing after a
-- revoke creates a new row that satisfies this index (the revoked
-- row no longer counts toward the partial constraint).
CREATE UNIQUE INDEX IF NOT EXISTS one_active_waiver
  ON ball_waivers (player_id, waiver_version)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ball_waivers_player_active
  ON ball_waivers (player_id)
  WHERE revoked_at IS NULL;

-- Host backfill — Tony is auto-signed so the host UI never shows the
-- waiver gate. ON CONFLICT DO NOTHING in case this migration is
-- re-applied or Tony already has a row.
-- Host backfill — only insert if Tony exists and doesn't already have an
-- active v1 waiver. NOT EXISTS instead of ON CONFLICT because the unique
-- constraint is a partial index, which can't be named in ON CONFLICT.
INSERT INTO ball_waivers (player_id, waiver_version, ip, user_agent)
SELECT id, 'v1', '0.0.0.0', 'host-backfill'
FROM ball_players p
WHERE p.is_host = true
  AND NOT EXISTS (
    SELECT 1 FROM ball_waivers w
    WHERE w.player_id = p.id
      AND w.waiver_version = 'v1'
      AND w.revoked_at IS NULL
  );
