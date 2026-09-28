-- Person ↔ device mapping foundation.
--
-- Builds an inventory of every device observed on the network and ties
-- each one (by MAC) to a person, role, and label so the rest of the
-- network section can stop talking in MAC addresses and start talking
-- in "Tony's iPhone".
--
-- Populated three ways:
--   1. Auto-ingest from FortiGate + Ruckus data calls (best-effort,
--      non-blocking — see server/lib/network-devices.ts).
--   2. Admin labeling via /api/network-devices/:mac.
--   3. Janus learning via the wifi_label_device chat tool.
--
-- The existing device_overrides table (PR earlier) is a narrower thing
-- — it just renames + recategorises devices for the network UI. This
-- table is the canonical identity store: who, role, expected_ssid,
-- trust, history.

CREATE TABLE IF NOT EXISTS network_devices (
  mac_address     text PRIMARY KEY,
  label           text,
  owner_person_id text,
  owner_role      text,
  device_type     text,
  device_vendor   text,
  device_model    text,
  hostnames       jsonb,
  ip_addresses    jsonb,
  ssids           jsonb,
  expected_ssid   text,
  trusted         boolean NOT NULL DEFAULT false,
  notes           text,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  last_labeled_by text,
  last_labeled_at timestamptz
);

CREATE INDEX IF NOT EXISTS network_devices_owner_idx
  ON network_devices (owner_person_id, owner_role);

CREATE INDEX IF NOT EXISTS network_devices_trusted_idx
  ON network_devices (trusted, last_seen DESC);

CREATE INDEX IF NOT EXISTS network_devices_last_seen_idx
  ON network_devices (last_seen DESC);
