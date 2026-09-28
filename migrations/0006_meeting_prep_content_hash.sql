ALTER TABLE "meeting_prep_dedup" ADD COLUMN IF NOT EXISTS "content_hash" text;

CREATE UNIQUE INDEX IF NOT EXISTS "meeting_prep_dedup_content_hash_idx" ON "meeting_prep_dedup" ("content_hash") WHERE "content_hash" IS NOT NULL;
