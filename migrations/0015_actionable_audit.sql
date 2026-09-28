-- Make the long-orphan `actionable` column official + add a partial
-- index for the new admin follow-up queue endpoint.
--
-- The column already exists in prod (boolean NOT NULL DEFAULT false)
-- but the schema declaration didn't reflect it, no code wrote `true`,
-- and no endpoint exposed it. After this migration:
--   - Schema declares it (shared/schema.ts).
--   - logAudit / logAudit-helpers accept an `actionable` flag.
--   - Specific high-signal events (circuit breaker → OPEN, token
--     expiry warnings, hallucination-guard fires, exhausted failed
--     jobs) flag themselves as actionable.
--   - GET /api/admin/actionable-audit + POST .../resolve let the
--     human work the queue.
--
-- ADD COLUMN IF NOT EXISTS is defensive — for any environment that
-- doesn't already have the column. Prod has it; dev clones from prod
-- usually do too.

ALTER TABLE system_audit_log
  ADD COLUMN IF NOT EXISTS actionable boolean NOT NULL DEFAULT false;

-- Partial index: only the (eventually small) set of actionable=true
-- rows gets indexed. The follow-up queue query is always
-- `WHERE actionable = true ORDER BY created_at DESC` so this hits
-- the index cleanly without bloating it with millions of "false" rows.
CREATE INDEX IF NOT EXISTS audit_actionable_idx
  ON system_audit_log (actionable, created_at DESC)
  WHERE actionable = true;
