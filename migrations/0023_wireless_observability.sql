-- Wireless observability — durable history for the Ruckus controller.
--
-- Every 5 min the /api/wireless-snapshot cron writes one wireless_snapshots
-- row (current AP/SSID/client counts + per-AP and per-SSID JSON breakdowns)
-- and the snapshot writer diffs vs the previous snapshot to emit zero or
-- more wireless_events rows. Both tables are pruned to 7 days inside the
-- writer (DELETE WHERE captured_at < now() - 7d) so they stay tiny —
-- ~288 snapshot rows/day at the 5 min cadence is fine for postgres.
--
-- evidence on wireless_events distinguishes WHY we're alerting:
--   controller — the Ruckus controller itself reported a state change
--                (AP joined/disconnected/unknown)
--   client     — derived from a client-count delta on an SSID, not from
--                anything the controller said directly
--   telemetry  — the change is in our own poll quality (we started
--                serving last-known-good), not in the wireless plane

CREATE TABLE IF NOT EXISTS wireless_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at     timestamptz NOT NULL DEFAULT now(),
  ap_total        integer     NOT NULL,
  ap_online       integer     NOT NULL,
  ap_offline      integer     NOT NULL,
  ap_unknown      integer     NOT NULL,
  client_total    integer     NOT NULL,
  ssid_total      integer     NOT NULL,
  clients_by_ssid jsonb,
  aps_by_mac      jsonb,
  stale           boolean     NOT NULL DEFAULT false,
  section_errors  jsonb,
  source          text        NOT NULL DEFAULT 'cron'
);

CREATE INDEX IF NOT EXISTS wireless_snapshots_captured_at_idx
  ON wireless_snapshots (captured_at DESC);

CREATE TABLE IF NOT EXISTS wireless_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at  timestamptz NOT NULL DEFAULT now(),
  event_type   text        NOT NULL,
  severity     text        NOT NULL DEFAULT 'info',
  evidence     text        NOT NULL,
  summary      text        NOT NULL,
  detail       jsonb
);

CREATE INDEX IF NOT EXISTS wireless_events_detected_at_idx
  ON wireless_events (detected_at DESC);

CREATE INDEX IF NOT EXISTS wireless_events_type_idx
  ON wireless_events (event_type, detected_at DESC);
