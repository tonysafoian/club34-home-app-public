-- Admin-repositionable irrigation-map zone label badges.
--
-- IrrigationMap.tsx ships hardcoded LABEL_CENTERS [x, y] pixel positions (in
-- SVG viewBox units 900x706) for each zone badge. As zones are renamed to
-- longer friendly names the badges can overflow zone boundaries, so admins
-- need to nudge them. This table persists per-zone overrides keyed by the
-- zone's svgId (e.g. 'clock-1-valve-1'). A missing row falls back to the
-- LABEL_CENTERS default in the frontend.

CREATE TABLE IF NOT EXISTS valve_label_positions (
  svg_id      text PRIMARY KEY,
  x           integer NOT NULL,
  y           integer NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
