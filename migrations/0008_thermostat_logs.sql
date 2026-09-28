CREATE TABLE IF NOT EXISTS "thermostat_logs" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "entity_id" text NOT NULL,
  "friendly_name" text,
  "current_temperature" numeric(6, 2),
  "target_temperature" numeric(6, 2),
  "hvac_mode" text,
  "hvac_action" text,
  "logged_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "thermostat_logs_entity_id_idx" ON "thermostat_logs" ("entity_id");
CREATE INDEX IF NOT EXISTS "thermostat_logs_logged_at_idx" ON "thermostat_logs" ("logged_at" DESC);
