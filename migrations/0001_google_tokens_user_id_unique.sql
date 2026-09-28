-- Add unique constraint on google_tokens.user_id so upsert ON CONFLICT (user_id) works
-- Handle existing duplicate user_ids by keeping exactly one row per user_id (most recent
-- by updated_at, with ctid as a deterministic tie-breaker for equal or null timestamps).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'google_tokens_user_id_unique'
      AND conrelid = 'google_tokens'::regclass
  ) THEN
    DELETE FROM google_tokens
    WHERE ctid NOT IN (
      SELECT DISTINCT ON (user_id) ctid
      FROM google_tokens
      ORDER BY user_id, updated_at DESC NULLS LAST, ctid DESC
    );

    ALTER TABLE google_tokens ADD CONSTRAINT google_tokens_user_id_unique UNIQUE (user_id);
  END IF;
END $$;
