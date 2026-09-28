CREATE TABLE IF NOT EXISTS "report_email_dedup" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "report_type" text NOT NULL,
  "period_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "report_email_dedup_type_period_idx" ON "report_email_dedup" ("report_type", "period_key");
