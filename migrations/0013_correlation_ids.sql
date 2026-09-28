-- Correlation IDs end-to-end. The dormant server/lib/correlation.ts utility
-- now threads a uuid (or the inbound X-Correlation-Id header) through
-- every request, every tool call, every failed-job row, and every chat
-- log so a single SQL query can answer "what did Janus do during request
-- X". system_audit_log.correlation_id already exists (added with the
-- original schema); this migration covers the two remaining write paths
-- and adds partial indexes for fast point lookups.

ALTER TABLE failed_jobs      ADD COLUMN IF NOT EXISTS correlation_id text;
ALTER TABLE janus_chat_logs  ADD COLUMN IF NOT EXISTS correlation_id text;

-- Partial indexes — we only ever query "WHERE correlation_id = ?" so
-- there's no value in indexing the NULL backfill of historical rows.
CREATE INDEX IF NOT EXISTS audit_correlation_idx
  ON system_audit_log (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS failed_jobs_correlation_idx
  ON failed_jobs (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_logs_correlation_idx
  ON janus_chat_logs (correlation_id) WHERE correlation_id IS NOT NULL;
