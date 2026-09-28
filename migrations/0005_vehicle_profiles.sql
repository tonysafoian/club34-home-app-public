CREATE TABLE IF NOT EXISTS "vehicle_profiles" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "plate" text NOT NULL,
  "label" text,
  "last_seen_at" timestamp with time zone,
  "last_seen_camera" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "vehicle_profiles_plate_unique" ON "vehicle_profiles" ("plate");
