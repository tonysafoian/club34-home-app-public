CREATE TABLE IF NOT EXISTS "meeting_prep_dedup" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "calendar_event_id" text NOT NULL,
  "event_date" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "meeting_prep_dedup_event_date_idx" ON "meeting_prep_dedup" ("calendar_event_id", "event_date");
