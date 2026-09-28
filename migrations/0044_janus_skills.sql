-- 0044_janus_skills.sql
-- Janus skills framework. Modular SKILL.md files under skills/janus/<slug>/SKILL.md
-- are the source of truth; they are one-way synced (file -> DB) into this table at
-- boot (hash differs -> file wins; the server never writes the repo files).
-- Runtime reads the always-on index + full bodies from here, cached for 5 minutes.
-- See server/utils/janus-skills.ts.
CREATE TABLE IF NOT EXISTS janus_skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  channels    text[] NOT NULL DEFAULT '{}',
  roles       text[] NOT NULL DEFAULT '{}',
  body        text NOT NULL DEFAULT '',
  hash        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
