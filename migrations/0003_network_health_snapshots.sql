CREATE TABLE IF NOT EXISTS "network_health_snapshots" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cpu_usage" numeric(5,2),
  "memory_usage" numeric(5,2),
  "active_sessions" integer,
  "wan_status" text,
  "wan_link" boolean,
  "threat_count" integer,
  "active_devices" integer
);

CREATE INDEX IF NOT EXISTS "network_health_snapshots_captured_at_idx" ON "network_health_snapshots" ("captured_at" DESC);
