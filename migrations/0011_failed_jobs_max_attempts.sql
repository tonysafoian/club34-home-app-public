-- Align failed_jobs.max_attempts default with the retry worker's live behavior.
--
-- server/routes/admin.ts hardcodes MAX_ATTEMPTS = 5 with a backoff schedule
-- of [5, 10, 20, 40, 80] minutes. The original schema set the column default
-- to 3, so any row inserted via INSERT ... DEFAULT (i.e. without an explicit
-- max_attempts) was immediately marked dead after 3 retries from the column's
-- perspective even though the worker would have given it 5. The worker wins
-- because that's the live behavior; this migration brings the schema in line.

ALTER TABLE failed_jobs ALTER COLUMN max_attempts SET DEFAULT 5;

-- Backfill existing rows that were created with the old default of 3 and
-- haven't exhausted retries yet, so they get the full retry budget the
-- worker already intends to give them. Rows that already failed 3+ times
-- and were marked dead under the old budget are left alone.
UPDATE failed_jobs
SET max_attempts = 5
WHERE max_attempts = 3
  AND attempts < 5
  AND status IN ('pending', 'retrying');
