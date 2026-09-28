-- Example Seed Script: Pickup Basketball Roster
--
-- Copy or adapt this script to populate sample players for the Ball module.
-- Run against your PostgreSQL database after applying schema migrations.

INSERT INTO ball_players (name, email, token, active, is_host, notes) VALUES
  ('Alex Sample',   'alex@example.com',   'al1x9k2a', true,  true,  'host — organizer'),
  ('Jordan Smith',  'jordan@example.com', 'js3k8m1p', true,  false, 'Regular player'),
  ('Taylor Brown',  'taylor@example.com', 'tb5q4w2r', true,  false, 'Regular player'),
  ('Chris Green',   'chris@example.com',  'cg8t6y3u', true,  false, 'Substitute');
