-- Seed initial time-tracking work categories
-- Migration 0051
-- Ensures workers have categories to log time against on day one.
-- Idempotent: existing categories with the same name are left untouched.

INSERT INTO tt_categories (name, sort_order) VALUES
  ('Club 34 Maintenance', 1),
  ('TigerDen', 2),
  ('Club34 Errands + Childcare', 3)
ON CONFLICT (name) DO NOTHING;
