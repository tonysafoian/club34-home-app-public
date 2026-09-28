-- Single source of truth for admin-editable irrigation zone (valve) names.
--
-- Friendly zone names were duplicated as hardcoded maps in two places —
-- server/lib/irrigationFlow.ts (ZONE_FLOW_CONFIG labels) and
-- src/lib/irrigation/controllers.ts (CLOCK*_ZONE_NAMES) — that had to be kept
-- in sync by hand. This table backs both the server and the frontend with one
-- DB-stored override per zone, keyed by the zone's stable svgId (e.g.
-- 'clock-1-valve-1', the same key used by valve_label_positions). A missing row
-- falls back to the hardcoded default in each codebase, so renaming is purely
-- additive and admins can rename zones from the UI without editing code.

CREATE TABLE IF NOT EXISTS irrigation_zone_names (
  svg_id      text PRIMARY KEY,
  name        text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
