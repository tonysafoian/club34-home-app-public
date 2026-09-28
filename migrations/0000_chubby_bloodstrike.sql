-- Current sql file was generated after introspecting the database
-- If you want to run this migration please uncomment this code before executing migrations
CREATE TYPE "public"."activity_event_type" AS ENUM('motion', 'access', 'alarm', 'camera', 'system');--> statement-breakpoint
CREATE TYPE "public"."activity_severity" AS ENUM('info', 'warning', 'alert');--> statement-breakpoint
CREATE TYPE "public"."app_role" AS ENUM('admin', 'member', 'guest');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"event_type" "activity_event_type" NOT NULL,
	"severity" "activity_severity" DEFAULT 'info' NOT NULL,
	"source" text NOT NULL,
	"description" text NOT NULL,
	"zone" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amazon_order_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"search_query" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"auto_order" boolean DEFAULT false NOT NULL,
	"cart_summary" jsonb,
	"axiom_run_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "amazon_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"amazon_email" text NOT NULL,
	"encrypted_password" text NOT NULL,
	"configured_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"recipients" text[] NOT NULL,
	"html_body" text NOT NULL,
	"text_body" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"email_type" text DEFAULT 'transactional' NOT NULL,
	"error_message" text,
	"metadata" jsonb,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entertainment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"event_date" timestamp with time zone NOT NULL,
	"event_end" timestamp with time zone,
	"venue" text,
	"location" text,
	"image_url" text,
	"ticket_url" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"season_year" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "failed_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"function_name" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"error_message" text NOT NULL,
	"error_detail" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "google_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"scopes" text[] NOT NULL,
	"google_email" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "home_assistant_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"ha_url" text,
	"encrypted_token" text,
	"is_connected" boolean DEFAULT false,
	"last_connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "family_automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"automation_type" text DEFAULT 'custom' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schedule" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"role" text DEFAULT 'member' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"supabase_uuid" text,
	"notion_uuid" text,
	"whatsapp_number" text,
	"aliases" text[],
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "hw_calendar_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"child_name" text NOT NULL,
	"email" text NOT NULL,
	"school_year" text NOT NULL,
	"grade" integer NOT NULL,
	"campus" text DEFAULT 'lower' NOT NULL,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hw_school_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"school_year" text NOT NULL,
	"campus" text DEFAULT 'lower' NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invited_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"invited_by" text NOT NULL,
	"phone_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_chat_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"user_message" text NOT NULL,
	"assistant_response" text,
	"channel" text DEFAULT 'web' NOT NULL,
	"user_display_name" text,
	"user_role" text DEFAULT 'member' NOT NULL,
	"group_id" text,
	"media_type" text,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_chat_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_functional_test_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"overall_status" text DEFAULT 'unknown' NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"total_ms" integer DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_group_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"group_name" text,
	"channel" text DEFAULT 'whatsapp' NOT NULL,
	"tier" text DEFAULT 'standard' NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"trusted_phones" text[],
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_health_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"overall_status" text DEFAULT 'unknown' NOT NULL,
	"total_ms" integer DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"context" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "janus_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"media_url" text,
	"seen" boolean DEFAULT false,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "janus_project_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"shared_by_user_id" text NOT NULL,
	"shared_with_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_project_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"artifact_type" text DEFAULT 'text' NOT NULL,
	"metadata" jsonb,
	"saved_by_user_id" text,
	"saved_by_display_name" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "janus_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"user_email" text NOT NULL,
	"reminder_text" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"channel" text DEFAULT 'web' NOT NULL,
	"whatsapp_number" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "media_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"description" text,
	"poster_url" text,
	"rating" text,
	"score" numeric,
	"rank" integer,
	"release_date" text,
	"streaming_platform" text,
	"last_fetched_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notion_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_type" text NOT NULL,
	"notion_page_id" text,
	"notion_database_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poi_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verkada_person_id" text NOT NULL,
	"label" text,
	"organization" text,
	"thumbnail_url" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "poi_profiles_verkada_person_id_unique" UNIQUE("verkada_person_id")
);
--> statement-breakpoint
CREATE TABLE "janus_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text DEFAULT 'Untitled' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notion_page_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notion_sync_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"notion_database_id" text NOT NULL,
	"database_name" text,
	"sync_direction" text DEFAULT 'pull' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poi_sightings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verkada_person_id" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"camera_name" text,
	"site_name" text,
	"confidence" numeric,
	"thumbnail_url" text,
	"clip_url" text,
	"label" text,
	"organization" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"phone_number" text,
	"approval_status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "shopping_cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"product_name" text NOT NULL,
	"platform" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"price" text,
	"product_url" text,
	"notes" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"added_by" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speed_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'spectrum' NOT NULL,
	"download_mbps" numeric(10, 2) NOT NULL,
	"upload_mbps" numeric(10, 2) NOT NULL,
	"latency_ms" numeric(8, 2) NOT NULL,
	"jitter_ms" numeric(8, 2),
	"server_name" text,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"user_email" text NOT NULL,
	"user_display_name" text,
	"content" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"category" text NOT NULL,
	"event_type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"actor_id" text,
	"actor_name" text,
	"actor_role" text,
	"channel" text,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb,
	"duration_ms" integer,
	"status" text DEFAULT 'success' NOT NULL,
	"edge_function" text,
	"correlation_id" text
);
--> statement-breakpoint
CREATE TABLE "system_configs" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "system_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"description" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_prompts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "system_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"version" text NOT NULL,
	"update_type" text DEFAULT 'feature' NOT NULL,
	"access_hint" text,
	"suggested_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tesla_activity_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" text NOT NULL,
	"vehicle_name" text,
	"event_type" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tesla_battery_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_id" text NOT NULL,
	"vehicle_name" text,
	"alert_active" boolean DEFAULT false,
	"last_alerted_at" timestamp with time zone,
	"last_range_miles" numeric,
	"last_wa_alerted_range" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tesla_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_key_pem" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"region" text DEFAULT 'na' NOT NULL,
	"partner_registered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tesla_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_name" text NOT NULL,
	"destination" text,
	"departure_date" timestamp with time zone,
	"return_date" timestamp with time zone,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"flights" jsonb,
	"hotels" jsonb,
	"transfers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"itinerary" jsonb,
	"notes" text,
	"travelers" text[],
	"source_email_ids" text[],
	"last_scanned_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_platform_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"credential_label" text DEFAULT 'default' NOT NULL,
	"encrypted_username" text NOT NULL,
	"encrypted_password" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"role" "app_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verkada_alert_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"verkada_alert_id" text NOT NULL,
	"alert_type" text,
	"camera_name" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verkada_alert_log_verkada_alert_id_unique" UNIQUE("verkada_alert_id")
);
--> statement-breakpoint
CREATE TABLE "voice_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"message_id" text,
	"audio_url" text,
	"transcript" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_dedup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_dedup_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "family_automation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"output" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notion_cached_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sync_config_id" uuid NOT NULL,
	"notion_page_id" text NOT NULL,
	"title" text,
	"content_preview" text,
	"properties" jsonb,
	"notion_url" text,
	"last_edited_at" timestamp with time zone,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "janus_project_shares" ADD CONSTRAINT "janus_project_shares_project_id_janus_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."janus_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "janus_project_artifacts" ADD CONSTRAINT "janus_project_artifacts_project_id_janus_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."janus_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_automation_logs" ADD CONSTRAINT "family_automation_logs_automation_id_family_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."family_automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notion_cached_pages" ADD CONSTRAINT "notion_cached_pages_sync_config_id_notion_sync_config_id_fk" FOREIGN KEY ("sync_config_id") REFERENCES "public"."notion_sync_config"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hw_calendar_config_email_school_year_idx" ON "hw_calendar_config" USING btree ("email" text_ops,"school_year" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "hw_school_calendars_school_year_campus_idx" ON "hw_school_calendars" USING btree ("school_year" text_ops,"campus" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "janus_chat_summaries_user_idx" ON "janus_chat_summaries" USING btree ("user_id" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "janus_memory_user_key_idx" ON "janus_memory" USING btree ("user_id" text_ops,"key" text_ops);
