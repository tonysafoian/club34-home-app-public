import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  serial,
  jsonb,
  numeric,
  pgEnum,
  uniqueIndex,
  index,
  customType,
  date,
} from "drizzle-orm/pg-core";

// pgvector column type — stored as `vector(768)` on the server and surfaced
// to Drizzle as `number[] | null`. Serializes the array to the pgvector
// `[a,b,c,...]` literal on insert/update; the raw read path uses SQL anyway,
// so the parsed shape on select is best-effort.
const vector768 = customType<{ data: number[]; driverData: string | number[] }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string | number[]): number[] {
    if (Array.isArray(value)) return value;
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      return value.slice(1, -1).split(",").map(Number);
    }
    return [];
  },
});
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// drizzle-zod 0.8.x uses zod/v4 types internally which differ from z.infer<>'s ZodType<any,any,any> constraint.
// Zinfer extracts the output type directly from _output to avoid the constraint mismatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Zinfer<T> = T extends { _output: infer O } ? O : any;

export const activityEventTypeEnum = pgEnum("activity_event_type", [
  "motion",
  "access",
  "alarm",
  "camera",
  "system",
]);

export const activitySeverityEnum = pgEnum("activity_severity", [
  "info",
  "warning",
  "alert",
]);

export const appRoleEnum = pgEnum("app_role", ["admin", "member", "guest", "worker"]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
]);

export const profiles = pgTable("profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().unique(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  phoneNumber: text("phone_number"),
  approvalStatus: approvalStatusEnum("approval_status")
    .default("pending")
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const userRoles = pgTable("user_roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  role: appRoleEnum("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const invitedEmails = pgTable("invited_emails", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  invitedBy: text("invited_by").notNull(),
  phoneNumber: text("phone_number"),
  role: text("role").default("member").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const householdMembers = pgTable("household_members", {
  id: uuid("id").defaultRandom().primaryKey(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  role: text("role").default("member").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  supabaseUuid: text("supabase_uuid"),
  notionUuid: text("notion_uuid"),
  whatsappNumber: text("whatsapp_number"),
  aliases: text("aliases").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const systemAuditLog = pgTable("system_audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  category: text("category").notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity").default("info").notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  actorRole: text("actor_role"),
  channel: text("channel"),
  summary: text("summary").notNull(),
  detail: jsonb("detail").default({}),
  durationMs: integer("duration_ms"),
  status: text("status").default("success").notNull(),
  edgeFunction: text("edge_function"),
  correlationId: text("correlation_id"),
  // `true` means a human should look at this row and either fix the
  // underlying problem or POST /api/admin/actionable-audit/:id/resolve
  // to clear it. Only a small set of event types ever set this true —
  // circuit_breaker_state transitions to "open", token_expiry_warning,
  // hallucination_guard fires, and failed_jobs that exhaust their retry
  // budget. Everything else stays false.
  actionable: boolean("actionable").default(false).notNull(),
});

export const systemConfigs = pgTable("system_configs", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const systemPrompts = pgTable("system_prompts", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  label: text("label").notNull(),
  content: text("content").default("").notNull(),
  description: text("description"),
  updatedBy: text("updated_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Janus skills framework. Modular SKILL.md files under skills/janus/<slug>/ are
// the source of truth; they are one-way synced (file → DB) into this table at
// boot. Runtime reads the lightweight index + bodies from here (cached).
export const janusSkills = pgTable("janus_skills", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").default("").notNull(),
  channels: text("channels").array().notNull(),
  roles: text("roles").array().notNull(),
  body: text("body").default("").notNull(),
  hash: text("hash").default("").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
export type JanusSkill = typeof janusSkills.$inferSelect;

export const systemUpdates = pgTable("system_updates", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  description: text("description").default("").notNull(),
  version: text("version").notNull(),
  updateType: text("update_type").default("feature").notNull(),
  accessHint: text("access_hint"),
  suggestedBy: text("suggested_by"),
  publishedAt: timestamp("published_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const failedJobs = pgTable("failed_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  functionName: text("function_name").notNull(),
  payload: jsonb("payload").default({}),
  errorMessage: text("error_message").notNull(),
  errorDetail: jsonb("error_detail"),
  attempts: integer("attempts").default(1).notNull(),
  maxAttempts: integer("max_attempts").default(5).notNull(),
  status: text("status").default("pending").notNull(),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  correlationId: text("correlation_id"),
});

export const speedTests = pgTable("speed_tests", {
  id: uuid("id").defaultRandom().primaryKey(),
  provider: text("provider").default("spectrum").notNull(),
  downloadMbps: numeric("download_mbps", { mode: "number", precision: 10, scale: 2 }).notNull(),
  uploadMbps: numeric("upload_mbps", { mode: "number", precision: 10, scale: 2 }).notNull(),
  latencyMs: numeric("latency_ms", { mode: "number", precision: 8, scale: 2 }).notNull(),
  jitterMs: numeric("jitter_ms", { mode: "number", precision: 8, scale: 2 }),
  serverName: text("server_name"),
  testedAt: timestamp("tested_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const networkHealthSnapshots = pgTable("network_health_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  cpuUsage: numeric("cpu_usage", { mode: "number", precision: 5, scale: 2 }),
  memoryUsage: numeric("memory_usage", { mode: "number", precision: 5, scale: 2 }),
  activeSessions: integer("active_sessions"),
  wanStatus: text("wan_status"),
  wanLink: boolean("wan_link"),
  threatCount: integer("threat_count"),
  activeDevices: integer("active_devices"),
});

// Rolling WAN throughput history — one row per ~60s sampler cron tick.
// Kept for 4 hours; older rows pruned by the sampler on each insert.
// rx_gb / tx_gb are the raw cumulative GB counters from HA WAN sensors.
export const wanThroughputHistory = pgTable("wan_throughput_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  wanRxGb: numeric("wan_rx_gb", { mode: "number", precision: 14, scale: 6 }),
  wanTxGb: numeric("wan_tx_gb", { mode: "number", precision: 14, scale: 6 }),
  wanSpeed: numeric("wan_speed", { mode: "number", precision: 10, scale: 2 }),
  wanStatus: text("wan_status"),
  wanLink: boolean("wan_link"),
});

// Wireless observability — every 5 min cron writes one snapshot row
// (current AP/SSID/client counts + per-AP and per-SSID breakdowns) and
// the snapshot writer diffs vs previous to emit wireless_events rows.
// 7-day retention enforced inside the writer (DELETE WHERE captured_at < now() - 7d).
export const wirelessSnapshots = pgTable("wireless_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
  apTotal: integer("ap_total").notNull(),
  apOnline: integer("ap_online").notNull(),
  apOffline: integer("ap_offline").notNull(),
  apUnknown: integer("ap_unknown").notNull(),
  clientTotal: integer("client_total").notNull(),
  ssidTotal: integer("ssid_total").notNull(),
  // {ssidName: clientCount}
  clientsBySsid: jsonb("clients_by_ssid"),
  // {apMac: {name, status, client_count}}
  apsByMac: jsonb("aps_by_mac"),
  stale: boolean("stale").default(false).notNull(),
  sectionErrors: jsonb("section_errors"),
  source: text("source").default("cron").notNull(),
});

// Derived events: ap_joined | ap_disconnected | ap_unknown | ssid_clients_drop
// | telemetry_stale. evidence is the *kind* of signal — controller (the
// Ruckus controller itself reported a state change), client (we inferred
// from a client-count delta), telemetry (the change is in our own poll
// quality, not in the wireless plane).
export const wirelessEvents = pgTable("wireless_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).defaultNow().notNull(),
  eventType: text("event_type").notNull(),
  severity: text("severity").default("info").notNull(),
  evidence: text("evidence").notNull(),
  summary: text("summary").notNull(),
  detail: jsonb("detail"),
});

export const thermostatLogs = pgTable("thermostat_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  entityId: text("entity_id").notNull(),
  friendlyName: text("friendly_name"),
  currentTemperature: numeric("current_temperature", { mode: "number", precision: 6, scale: 2 }),
  targetTemperature: numeric("target_temperature", { mode: "number", precision: 6, scale: 2 }),
  hvacMode: text("hvac_mode"),
  hvacAction: text("hvac_action"),
  loggedAt: timestamp("logged_at", { withTimezone: true }).defaultNow().notNull(),
});

export const janusProjects = pgTable("janus_projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").default("Untitled").notNull(),
  status: text("status").default("active").notNull(),
  notionPageId: text("notion_page_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const janusProjectArtifacts = pgTable("janus_project_artifacts", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => janusProjects.id),
  title: text("title").default("").notNull(),
  content: text("content").default("").notNull(),
  artifactType: text("artifact_type").default("text").notNull(),
  metadata: jsonb("metadata"),
  savedByUserId: text("saved_by_user_id"),
  savedByDisplayName: text("saved_by_display_name"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const janusProjectShares = pgTable("janus_project_shares", {
  id: uuid("id").defaultRandom().primaryKey(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => janusProjects.id),
  sharedByUserId: text("shared_by_user_id").notNull(),
  sharedWithUserId: text("shared_with_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const janusChatLogs = pgTable("janus_chat_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  userMessage: text("user_message").notNull(),
  assistantResponse: text("assistant_response"),
  channel: text("channel").default("web").notNull(),
  userDisplayName: text("user_display_name"),
  userRole: text("user_role").default("member").notNull(),
  groupId: text("group_id"),
  mediaType: text("media_type"),
  toolCalls: jsonb("tool_calls"),
  correlationId: text("correlation_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const janusMemory = pgTable("janus_memory", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  context: text("context"),
  embedding: vector768("embedding"),
  pinned: boolean("pinned").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("janus_memory_user_key_idx").on(table.userId, table.key),
]);

export const janusChatSummaries = pgTable("janus_chat_summaries", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  summary: text("summary").default("").notNull(),
  messageCount: integer("message_count").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => [
  uniqueIndex("janus_chat_summaries_user_idx").on(table.userId),
]);

export const janusNotifications = pgTable("janus_notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  message: text("message").notNull(),
  mediaUrl: text("media_url"),
  seen: boolean("seen").default(false),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
});

export const janusReminders = pgTable("janus_reminders", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  userEmail: text("user_email").notNull(),
  reminderText: text("reminder_text").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true }),
  channel: text("channel").default("web").notNull(),
  whatsappNumber: text("whatsapp_number"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const janusFunctionalTestLogs = pgTable("janus_functional_test_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  overallStatus: text("overall_status").default("unknown").notNull(),
  passed: integer("passed").default(0).notNull(),
  failed: integer("failed").default(0).notNull(),
  totalMs: integer("total_ms").default(0).notNull(),
  results: jsonb("results").default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const janusGroupConfigs = pgTable("janus_group_configs", {
  id: uuid("id").defaultRandom().primaryKey(),
  groupId: text("group_id").notNull(),
  groupName: text("group_name"),
  channel: text("channel").default("whatsapp").notNull(),
  tier: text("tier").default("standard").notNull(),
  messageCount: integer("message_count").default(0).notNull(),
  trustedPhones: text("trusted_phones").array(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const janusHealthLogs = pgTable("janus_health_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  overallStatus: text("overall_status").default("unknown").notNull(),
  totalMs: integer("total_ms").default(0).notNull(),
  results: jsonb("results").default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Per-completion LLM usage capture. One row per OpenRouter completion
// (chat, summarize, tool-round retry, research, …) so we can later
// aggregate "Janus cost this week, by user / channel / model / tier"
// without estimating from log counts.
export const janusLlmUsage = pgTable("janus_llm_usage", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  userId: text("user_id"),
  channel: text("channel"),
  model: text("model").notNull(),
  tier: text("tier"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  costUsd: numeric("cost_usd", { mode: "number", precision: 10, scale: 6 }),
  correlationId: text("correlation_id"),
  durationMs: integer("duration_ms"),
  requestType: text("request_type"),
});

export const familyAutomations = pgTable("family_automations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  automationType: text("automation_type").default("custom").notNull(),
  config: jsonb("config").default({}).notNull(),
  schedule: text("schedule"),
  isActive: boolean("is_active").default(true).notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const familyAutomationLogs = pgTable("family_automation_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  automationId: uuid("automation_id")
    .notNull()
    .references(() => familyAutomations.id),
  status: text("status").default("running").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  output: jsonb("output"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const googleTokens = pgTable("google_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").array().notNull(),
  googleEmail: text("google_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const teslaTokens = pgTable("tesla_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull().unique(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const teslaConfig = pgTable("tesla_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  publicKeyPem: text("public_key_pem").notNull(),
  privateKeyPem: text("private_key_pem").notNull(),
  region: text("region").default("na").notNull(),
  partnerRegistered: boolean("partner_registered").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const teslaActivityLogs = pgTable("tesla_activity_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: text("vehicle_id").notNull(),
  vehicleName: text("vehicle_name"),
  eventType: text("event_type").notNull(),
  details: jsonb("details").default({}).notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const teslaBatteryAlerts = pgTable("tesla_battery_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  vehicleId: text("vehicle_id").notNull().unique(),
  vehicleName: text("vehicle_name"),
  alertActive: boolean("alert_active").default(false),
  lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true }),
  lastRangeMiles: numeric("last_range_miles", { mode: "number" }),
  lastWaAlertedRange: numeric("last_wa_alerted_range", { mode: "number" }),
  details: jsonb("details").default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const homeAssistantSettings = pgTable("home_assistant_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  haUrl: text("ha_url"),
  encryptedToken: text("encrypted_token"),
  isConnected: boolean("is_connected").default(false),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const poiProfiles = pgTable("poi_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  verkadaPersonId: text("verkada_person_id").notNull().unique(),
  label: text("label"),
  organization: text("organization"),
  thumbnailUrl: text("thumbnail_url"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const poiSightings = pgTable("poi_sightings", {
  id: uuid("id").defaultRandom().primaryKey(),
  verkadaPersonId: text("verkada_person_id").notNull(),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
  cameraName: text("camera_name"),
  siteName: text("site_name"),
  confidence: numeric("confidence", { mode: "number" }),
  thumbnailUrl: text("thumbnail_url"),
  clipUrl: text("clip_url"),
  label: text("label"),
  organization: text("organization"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => ({
  uniqPersonTimeCam: uniqueIndex("poi_sightings_person_time_cam_idx").on(t.verkadaPersonId, t.seenAt, t.cameraName),
}));

export const trips = pgTable("trips", {
  id: uuid("id").defaultRandom().primaryKey(),
  tripName: text("trip_name").notNull(),
  destination: text("destination"),
  departureDate: timestamp("departure_date", { withTimezone: true }),
  returnDate: timestamp("return_date", { withTimezone: true }),
  status: text("status").default("upcoming").notNull(),
  flights: jsonb("flights"),
  hotels: jsonb("hotels"),
  transfers: jsonb("transfers").default([]).notNull(),
  itinerary: jsonb("itinerary"),
  notes: text("notes"),
  travelers: text("travelers").array(),
  sourceEmailIds: text("source_email_ids").array(),
  lastScannedAt: timestamp("last_scanned_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const shoppingCartItems = pgTable("shopping_cart_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  productName: text("product_name").notNull(),
  platform: text("platform").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  price: text("price"),
  productUrl: text("product_url"),
  imageUrl: text("image_url"),
  notes: text("notes"),
  status: text("status").default("pending").notNull(),
  addedBy: text("added_by").default("user").notNull(),
  runId: uuid("run_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const amazonOrderRequests = pgTable("amazon_order_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  searchQuery: text("search_query").notNull(),
  status: text("status").default("pending").notNull(),
  autoOrder: boolean("auto_order").default(false).notNull(),
  cartSummary: jsonb("cart_summary"),
  axiomRunId: text("axiom_run_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const amazonSettings = pgTable("amazon_settings", {
  id: uuid("id").defaultRandom().primaryKey(),
  amazonEmail: text("amazon_email").notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
  configuredBy: text("configured_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const entertainmentEvents = pgTable("entertainment_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  eventDate: timestamp("event_date", { withTimezone: true }).notNull(),
  eventEnd: timestamp("event_end", { withTimezone: true }),
  venue: text("venue"),
  location: text("location"),
  imageUrl: text("image_url"),
  ticketUrl: text("ticket_url"),
  source: text("source").default("manual").notNull(),
  seasonYear: integer("season_year"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const emailLogs = pgTable("email_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  subject: text("subject").notNull(),
  recipients: text("recipients").array().notNull(),
  htmlBody: text("html_body").notNull(),
  textBody: text("text_body"),
  status: text("status").default("sent").notNull(),
  emailType: text("email_type").default("transactional").notNull(),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const whatsappDedup = pgTable("whatsapp_dedup", {
  id: uuid("id").defaultRandom().primaryKey(),
  messageId: text("message_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const meetingPrepDedup = pgTable("meeting_prep_dedup", {
  id: uuid("id").defaultRandom().primaryKey(),
  calendarEventId: text("calendar_event_id").notNull(),
  eventDate: text("event_date").notNull(),
  contentHash: text("content_hash"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, (table) => [
  uniqueIndex("meeting_prep_dedup_event_date_idx").on(table.calendarEventId, table.eventDate),
]);

export const voiceReplies = pgTable("voice_replies", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  messageId: text("message_id"),
  audioUrl: text("audio_url"),
  transcript: text("transcript"),
  status: text("status").default("pending").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const notionWebhookEvents = pgTable("notion_webhook_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventType: text("event_type").notNull(),
  notionPageId: text("notion_page_id"),
  notionDatabaseId: text("notion_database_id"),
  payload: jsonb("payload").default({}).notNull(),
  processed: boolean("processed").default(false).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const notionSyncConfig = pgTable("notion_sync_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  notionDatabaseId: text("notion_database_id").notNull(),
  databaseName: text("database_name"),
  syncDirection: text("sync_direction").default("pull").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const notionCachedPages = pgTable("notion_cached_pages", {
  id: uuid("id").defaultRandom().primaryKey(),
  syncConfigId: uuid("sync_config_id")
    .notNull()
    .references(() => notionSyncConfig.id),
  notionPageId: text("notion_page_id").notNull(),
  title: text("title"),
  contentPreview: text("content_preview"),
  properties: jsonb("properties"),
  notionUrl: text("notion_url"),
  lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
  cachedAt: timestamp("cached_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const hwCalendarConfig = pgTable(
  "hw_calendar_config",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    childName: text("child_name").notNull(),
    email: text("email").notNull(),
    schoolYear: text("school_year").notNull(),
    grade: integer("grade").notNull(),
    campus: text("campus").default("lower").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("hw_calendar_config_email_school_year_idx").on(table.email, table.schoolYear)],
);

export const hwSchoolCalendars = pgTable(
  "hw_school_calendars",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    schoolYear: text("school_year").notNull(),
    campus: text("campus").default("lower").notNull(),
    events: jsonb("events").default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("hw_school_calendars_school_year_campus_idx").on(table.schoolYear, table.campus)],
);

export const activityEvents = pgTable("activity_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  eventType: activityEventTypeEnum("event_type").notNull(),
  severity: activitySeverityEnum("severity").default("info").notNull(),
  source: text("source").notNull(),
  description: text("description").notNull(),
  zone: text("zone"),
  metadata: jsonb("metadata"),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const mediaItems = pgTable("media_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  source: text("source").default("manual").notNull(),
  description: text("description"),
  posterUrl: text("poster_url"),
  rating: text("rating"),
  score: numeric("score", { mode: "number" }),
  rank: integer("rank"),
  releaseDate: text("release_date"),
  streamingPlatform: text("streaming_platform"),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const suggestions = pgTable("suggestions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  userEmail: text("user_email").notNull(),
  userDisplayName: text("user_display_name"),
  content: text("content").notNull(),
  status: text("status").default("pending").notNull(),
  adminNote: text("admin_note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const userPlatformCredentials = pgTable("user_platform_credentials", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  platform: text("platform").notNull(),
  credentialLabel: text("credential_label").default("default").notNull(),
  encryptedUsername: text("encrypted_username").notNull(),
  encryptedPassword: text("encrypted_password").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const verkadaAlertLog = pgTable("verkada_alert_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  verkadaAlertId: text("verkada_alert_id").notNull().unique(),
  alertType: text("alert_type"),
  cameraName: text("camera_name"),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const verkadaEvents = pgTable("verkada_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventType: text("event_type").notNull(),
  personId: text("person_id"),
  personLabel: text("person_label"),
  vehiclePlate: text("vehicle_plate"),
  cameraId: text("camera_id"),
  cameraName: text("camera_name"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  dedupKey: text("dedup_key").unique(),
  isArrival: boolean("is_arrival"),
  isDeparture: boolean("is_departure"),
  rawData: jsonb("raw_data"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const vehicleProfiles = pgTable("vehicle_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  plate: text("plate").notNull().unique(),
  label: text("label"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  lastSeenCamera: text("last_seen_camera"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertProfileSchema = createInsertSchema(profiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertUserRoleSchema = createInsertSchema(userRoles).omit({
  id: true,
  createdAt: true,
});
export const insertInvitedEmailSchema = createInsertSchema(invitedEmails).omit({
  id: true,
  createdAt: true,
});
export const insertHouseholdMemberSchema = createInsertSchema(householdMembers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertSystemAuditLogSchema = createInsertSchema(systemAuditLog).omit({
  id: true,
  createdAt: true,
});
export const insertSystemConfigSchema = createInsertSchema(systemConfigs).omit({
  updatedAt: true,
});
export const insertSystemPromptSchema = createInsertSchema(systemPrompts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertJanusSkillSchema = createInsertSchema(janusSkills).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJanusSkill = Zinfer<typeof insertJanusSkillSchema>;
export const insertSystemUpdateSchema = createInsertSchema(systemUpdates).omit({
  id: true,
  createdAt: true,
});
export const insertFailedJobSchema = createInsertSchema(failedJobs).omit({
  id: true,
  createdAt: true,
});
export const insertSpeedTestSchema = createInsertSchema(speedTests).omit({
  id: true,
});
export const insertThermostatLogSchema = createInsertSchema(thermostatLogs).omit({
  id: true,
});
export const insertJanusProjectSchema = createInsertSchema(janusProjects).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertJanusProjectArtifactSchema = createInsertSchema(janusProjectArtifacts).omit({
  id: true,
  createdAt: true,
});
export const insertJanusProjectShareSchema = createInsertSchema(janusProjectShares).omit({
  id: true,
  createdAt: true,
});
export const insertJanusChatLogSchema = createInsertSchema(janusChatLogs).omit({
  id: true,
  createdAt: true,
});
export const insertJanusMemorySchema = createInsertSchema(janusMemory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertJanusChatSummarySchema = createInsertSchema(janusChatSummaries).omit({
  id: true,
});
export const insertJanusNotificationSchema = createInsertSchema(janusNotifications).omit({
  id: true,
});
export const insertJanusReminderSchema = createInsertSchema(janusReminders).omit({
  id: true,
  createdAt: true,
});
export const insertJanusFunctionalTestLogSchema = createInsertSchema(janusFunctionalTestLogs).omit({
  id: true,
  createdAt: true,
});
export const insertJanusGroupConfigSchema = createInsertSchema(janusGroupConfigs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertJanusHealthLogSchema = createInsertSchema(janusHealthLogs).omit({
  id: true,
  createdAt: true,
});
export const insertFamilyAutomationSchema = createInsertSchema(familyAutomations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertFamilyAutomationLogSchema = createInsertSchema(familyAutomationLogs).omit({
  id: true,
  createdAt: true,
});
export const insertGoogleTokenSchema = createInsertSchema(googleTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTeslaTokenSchema = createInsertSchema(teslaTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTeslaConfigSchema = createInsertSchema(teslaConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertTeslaActivityLogSchema = createInsertSchema(teslaActivityLogs).omit({
  id: true,
  createdAt: true,
});
export const insertTeslaBatteryAlertSchema = createInsertSchema(teslaBatteryAlerts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertHomeAssistantSettingSchema = createInsertSchema(homeAssistantSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPoiProfileSchema = createInsertSchema(poiProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertVehicleProfileSchema = createInsertSchema(vehicleProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPoiSightingSchema = createInsertSchema(poiSightings).omit({
  id: true,
  createdAt: true,
});
export const insertTripSchema = createInsertSchema(trips).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertShoppingCartItemSchema = createInsertSchema(shoppingCartItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const groceryStaples = pgTable("grocery_staples", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  // defaultQuantity is now a UI hint only — the per-cycle quantity lives in grocery_order_items.
  defaultQuantity: integer("default_quantity").default(1).notNull(),
  category: text("category").default("general").notNull(),
  platform: text("platform").default("amazon-fresh").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  addedByUserId: text("added_by_user_id"),
  // Product metadata added in migration 0024
  brand: text("brand"),
  size: text("size"),
  amazonAsin: text("amazon_asin"),
  amazonUrl: text("amazon_url"),
  imageUrl: text("image_url"),
  unitPrice: numeric("unit_price", { mode: "number", precision: 10, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const groceryOrderRuns = pgTable("grocery_order_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Status lifecycle: open → locked → submitted | skipped | cancelled
  status: text("status").default("open").notNull(),
  cartSnapshot: jsonb("cart_snapshot"),
  whatsappNotifiedAt: timestamp("whatsapp_notified_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  orderedAt: timestamp("ordered_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  autoOrdered: boolean("auto_ordered").default(false).notNull(),
  itemCount: integer("item_count").default(0).notNull(),
  // Cycle tracking columns added in migration 0024
  cycleStartAt: timestamp("cycle_start_at", { withTimezone: true }),
  cycleLockAt: timestamp("cycle_lock_at", { withTimezone: true }),
  deliveryDate: text("delivery_date"),  // YYYY-MM-DD
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  submissionLog: jsonb("submission_log"),
  createdByUserId: text("created_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Per-item rows in a grocery order run. Fields are snapshotted from the staple
// at add-time so the audit trail is self-contained even if the staple is later edited.
export const groceryOrderItems = pgTable("grocery_order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => groceryOrderRuns.id, { onDelete: "cascade" }),
  stapleId: uuid("staple_id").references(() => groceryStaples.id, { onDelete: "set null" }),
  amazonAsin: text("amazon_asin"),
  name: text("name").notNull(),
  category: text("category").default("general").notNull(),
  brand: text("brand"),
  size: text("size"),
  imageUrl: text("image_url"),
  unitPrice: numeric("unit_price", { mode: "number", precision: 10, scale: 2 }),
  quantity: integer("quantity").default(1).notNull(),
  addedByUserId: text("added_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Immutable audit trail for every add/qty_changed/removed action on grocery_order_items.
// item_id nullable: audit rows survive item deletion (ON DELETE SET NULL).
export const groceryOrderItemAudit = pgTable("grocery_order_item_audit", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemId: uuid("item_id").references(() => groceryOrderItems.id, { onDelete: "set null" }),
  runId: uuid("run_id").notNull().references(() => groceryOrderRuns.id, { onDelete: "cascade" }),
  action: text("action").notNull(),  // added | qty_changed | removed
  actorUserId: text("actor_user_id"),
  oldQty: integer("old_qty"),
  newQty: integer("new_qty"),
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// device_overrides is the authoritative owner/override store for the UI.
// network_devices is the identity/inventory store for wifi_who_is_online etc.
// When both tables have a row for a MAC, device_overrides wins for display.
export const deviceOverrides = pgTable("device_overrides", {
  id: uuid("id").defaultRandom().primaryKey(),
  mac: text("mac").notNull().unique(),
  customName: text("custom_name"),
  customCategory: text("custom_category"),
  customSubcategory: text("custom_subcategory"),
  originalHostname: text("original_hostname"),
  // owner: free-text label (e.g. "Tony's iPhone", "Guest — Jane"). Set from
  // the edit popover; used to clear the needs_label triage flag.
  owner: text("owner"),
  // trusted: admin-confirmed device that belongs to the household.
  trusted: boolean("trusted").notNull().default(false),
  // isRandom: persisted flag for devices with randomized MACs at time of first
  // admin review. Stored so queries can identify personal-device rows without
  // re-running the MAC-bit check on a possibly-new MAC for the same person.
  isRandom: boolean("is_random").notNull().default(false),
  // firstSeen / lastSeen: when this MAC was first and most recently observed
  // on the network. Populated by the devices route on first save.
  firstSeen: timestamp("first_seen", { withTimezone: true }),
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertDeviceOverrideSchema = createInsertSchema(deviceOverrides).omit({
  id: true,
  updatedAt: true,
});

export type InsertDeviceOverride = Zinfer<typeof insertDeviceOverrideSchema>;
export type DeviceOverride = typeof deviceOverrides.$inferSelect;

// Canonical list of device categories recognised by the classifier.
// Seeded idempotently on server start. Admins may not add rows, but this
// table gives external tools a stable schema to query.
export const deviceCategories = pgTable("device_categories", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().default(0),
  description: text("description"),
});

export const insertDeviceCategorySchema = createInsertSchema(deviceCategories).omit({ id: true });
export type InsertDeviceCategory = Zinfer<typeof insertDeviceCategorySchema>;
export type DeviceCategory = typeof deviceCategories.$inferSelect;

// Vendor → category mapping used by the classifier.
// A row matches when the FortiGate hardware_vendor string OR the device_type
// string contains the matchKeyword (case-insensitive).
// Higher priority rows win (lower number = checked first).
export const vendorCategoryRules = pgTable("vendor_category_rules", {
  id: serial("id").primaryKey(),
  matchKeyword: text("match_keyword").notNull(),
  category: text("category").notNull(),
  subcategory: text("subcategory"),
  vendorLabel: text("vendor_label"),
  priority: integer("priority").notNull().default(100),
  notes: text("notes"),
});

export const insertVendorCategoryRuleSchema = createInsertSchema(vendorCategoryRules).omit({ id: true });
export type InsertVendorCategoryRule = Zinfer<typeof insertVendorCategoryRuleSchema>;
export type VendorCategoryRule = typeof vendorCategoryRules.$inferSelect;

// Admin-repositionable irrigation-map zone label badges. svgId is the zone's
// stable identifier (e.g. 'clock-1-valve-1'); x/y are pixel positions in the
// SVG viewBox 900x706 coordinate space. A missing row falls back to the
// hardcoded LABEL_CENTERS default in IrrigationMap.tsx. See task: longer
// friendly zone names can overflow zone boundaries, so admins drag badges.
export const valveLabelPositions = pgTable("valve_label_positions", {
  svgId: text("svg_id").primaryKey(),
  x: integer("x").notNull(),
  y: integer("y").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertValveLabelPositionSchema = createInsertSchema(valveLabelPositions).omit({
  updatedAt: true,
});
export type InsertValveLabelPosition = Zinfer<typeof insertValveLabelPositionSchema>;
export type ValveLabelPosition = typeof valveLabelPositions.$inferSelect;

// Single source of truth for admin-editable irrigation zone (valve) names.
// Keyed by the zone's stable svgId (e.g. 'clock-1-valve-1') — the same key
// used by valve_label_positions. A missing row falls back to the hardcoded
// defaults in src/lib/irrigation/controllers.ts (frontend) and
// server/lib/irrigationFlow.ts (server), so renaming is purely additive.
export const irrigationZoneNames = pgTable("irrigation_zone_names", {
  svgId: text("svg_id").primaryKey(),
  name: text("name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const insertIrrigationZoneNameSchema = createInsertSchema(irrigationZoneNames).omit({
  updatedAt: true,
});
export type InsertIrrigationZoneName = Zinfer<typeof insertIrrigationZoneNameSchema>;
export type IrrigationZoneName = typeof irrigationZoneNames.$inferSelect;

// Canonical person↔device mapping. See migrations/0016_network_device_owners.sql.
// device_overrides above is the narrower UI rename store; this is the
// identity-aware inventory that powers the wifi_who_is_online tool and
// the "unknown device on guest SSID" alerts. hostnames / ip_addresses
// / ssids are jsonb arrays so we can accumulate observed values
// without exploding into a side-table per attribute.
export const networkDevices = pgTable("network_devices", {
  macAddress: text("mac_address").primaryKey(),
  label: text("label"),
  ownerPersonId: text("owner_person_id"),
  ownerRole: text("owner_role"),
  deviceType: text("device_type"),
  deviceVendor: text("device_vendor"),
  deviceModel: text("device_model"),
  hostnames: jsonb("hostnames").$type<string[] | null>(),
  ipAddresses: jsonb("ip_addresses").$type<string[] | null>(),
  ssids: jsonb("ssids").$type<string[] | null>(),
  expectedSsid: text("expected_ssid"),
  trusted: boolean("trusted").notNull().default(false),
  notes: text("notes"),
  firstSeen: timestamp("first_seen", { withTimezone: true }).defaultNow().notNull(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).defaultNow().notNull(),
  lastLabeledBy: text("last_labeled_by"),
  lastLabeledAt: timestamp("last_labeled_at", { withTimezone: true }),
  // Cached connection-method label (Wired/WiFi + SSID + source/confidence).
  // Refreshed by the 5-min Ruckus snapshot cron and write-through-updated by
  // the devices endpoint on a cache miss. resolvedConnectionAt drives the TTL
  // freshness check; setting it NULL invalidates the entry. See
  // server/lib/connection-cache.ts.
  resolvedConnection: jsonb("resolved_connection").$type<{
    method: 'wired' | 'wifi' | 'unknown';
    ssid: string | null;
    source: 'ruckus_live' | 'ruckus_recent' | 'heuristic' | 'subnet' | 'unknown';
    confidence: 'confirmed' | 'recent' | 'inferred' | 'unknown';
    ssid_certain: boolean;
  } | null>(),
  resolvedConnectionAt: timestamp("resolved_connection_at", { withTimezone: true }),
});

export const insertNetworkDeviceSchema = createInsertSchema(networkDevices).omit({
  firstSeen: true,
  lastSeen: true,
});
export type InsertNetworkDevice = Zinfer<typeof insertNetworkDeviceSchema>;
export type NetworkDevice = typeof networkDevices.$inferSelect;

export const insertGroceryStapleSchema = createInsertSchema(groceryStaples).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertGroceryOrderRunSchema = createInsertSchema(groceryOrderRuns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertGroceryOrderItemSchema = createInsertSchema(groceryOrderItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertGroceryOrderItemAuditSchema = createInsertSchema(groceryOrderItemAudit).omit({
  id: true,
  createdAt: true,
});
export const insertAmazonOrderRequestSchema = createInsertSchema(amazonOrderRequests).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertAmazonSettingSchema = createInsertSchema(amazonSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEntertainmentEventSchema = createInsertSchema(entertainmentEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertEmailLogSchema = createInsertSchema(emailLogs).omit({
  id: true,
  createdAt: true,
});
export const insertWhatsappDedupSchema = createInsertSchema(whatsappDedup).omit({
  id: true,
  createdAt: true,
});
export const insertVoiceReplySchema = createInsertSchema(voiceReplies).omit({
  id: true,
  createdAt: true,
});
export const insertNotionWebhookEventSchema = createInsertSchema(notionWebhookEvents).omit({
  id: true,
  createdAt: true,
});
export const insertNotionSyncConfigSchema = createInsertSchema(notionSyncConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertNotionCachedPageSchema = createInsertSchema(notionCachedPages).omit({
  id: true,
});
export const insertHwCalendarConfigSchema = createInsertSchema(hwCalendarConfig).omit({
  id: true,
  createdAt: true,
});
export const insertHwSchoolCalendarSchema = createInsertSchema(hwSchoolCalendars).omit({
  id: true,
  createdAt: true,
});
export const insertActivityEventSchema = createInsertSchema(activityEvents).omit({
  id: true,
  createdAt: true,
});
export const insertMediaItemSchema = createInsertSchema(mediaItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertSuggestionSchema = createInsertSchema(suggestions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertUserPlatformCredentialSchema = createInsertSchema(userPlatformCredentials).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertVerkadaAlertLogSchema = createInsertSchema(verkadaAlertLog).omit({
  id: true,
  createdAt: true,
});

export type InsertProfile = Zinfer<typeof insertProfileSchema>;
export type Profile = typeof profiles.$inferSelect;
export type InsertUserRole = Zinfer<typeof insertUserRoleSchema>;
export type UserRole = typeof userRoles.$inferSelect;
export type InsertInvitedEmail = Zinfer<typeof insertInvitedEmailSchema>;
export type InvitedEmail = typeof invitedEmails.$inferSelect;
export type InsertHouseholdMember = Zinfer<typeof insertHouseholdMemberSchema>;
export type HouseholdMember = typeof householdMembers.$inferSelect;
export type InsertSystemAuditLog = Zinfer<typeof insertSystemAuditLogSchema>;
export type SystemAuditLog = typeof systemAuditLog.$inferSelect;
export type InsertSystemConfig = Zinfer<typeof insertSystemConfigSchema>;
export type SystemConfig = typeof systemConfigs.$inferSelect;
export type InsertSystemPrompt = Zinfer<typeof insertSystemPromptSchema>;
export type SystemPrompt = typeof systemPrompts.$inferSelect;
export type InsertSystemUpdate = Zinfer<typeof insertSystemUpdateSchema>;
export type SystemUpdate = typeof systemUpdates.$inferSelect;
export type InsertFailedJob = Zinfer<typeof insertFailedJobSchema>;
export type FailedJob = typeof failedJobs.$inferSelect;
export type InsertSpeedTest = Zinfer<typeof insertSpeedTestSchema>;
export type SpeedTest = typeof speedTests.$inferSelect;
export type InsertThermostatLog = Zinfer<typeof insertThermostatLogSchema>;
export type ThermostatLog = typeof thermostatLogs.$inferSelect;
export type InsertJanusProject = Zinfer<typeof insertJanusProjectSchema>;
export type JanusProject = typeof janusProjects.$inferSelect;
export type InsertJanusProjectArtifact = Zinfer<typeof insertJanusProjectArtifactSchema>;
export type JanusProjectArtifact = typeof janusProjectArtifacts.$inferSelect;
export type InsertJanusProjectShare = Zinfer<typeof insertJanusProjectShareSchema>;
export type JanusProjectShare = typeof janusProjectShares.$inferSelect;
export type InsertJanusChatLog = Zinfer<typeof insertJanusChatLogSchema>;
export type JanusChatLog = typeof janusChatLogs.$inferSelect;
export type InsertJanusMemory = Zinfer<typeof insertJanusMemorySchema>;
export type JanusMemory = typeof janusMemory.$inferSelect;
export type InsertJanusChatSummary = Zinfer<typeof insertJanusChatSummarySchema>;
export type JanusChatSummary = typeof janusChatSummaries.$inferSelect;
export type InsertJanusNotification = Zinfer<typeof insertJanusNotificationSchema>;
export type JanusNotification = typeof janusNotifications.$inferSelect;
export type InsertJanusReminder = Zinfer<typeof insertJanusReminderSchema>;
export type JanusReminder = typeof janusReminders.$inferSelect;
export type InsertJanusFunctionalTestLog = Zinfer<typeof insertJanusFunctionalTestLogSchema>;
export type JanusFunctionalTestLog = typeof janusFunctionalTestLogs.$inferSelect;
export type InsertJanusGroupConfig = Zinfer<typeof insertJanusGroupConfigSchema>;
export type JanusGroupConfig = typeof janusGroupConfigs.$inferSelect;
export type InsertJanusHealthLog = Zinfer<typeof insertJanusHealthLogSchema>;
export type JanusHealthLog = typeof janusHealthLogs.$inferSelect;
export type InsertFamilyAutomation = Zinfer<typeof insertFamilyAutomationSchema>;
export type FamilyAutomation = typeof familyAutomations.$inferSelect;
export type InsertFamilyAutomationLog = Zinfer<typeof insertFamilyAutomationLogSchema>;
export type FamilyAutomationLog = typeof familyAutomationLogs.$inferSelect;
export type InsertGoogleToken = Zinfer<typeof insertGoogleTokenSchema>;
export type GoogleToken = typeof googleTokens.$inferSelect;
export type InsertTeslaToken = Zinfer<typeof insertTeslaTokenSchema>;
export type TeslaToken = typeof teslaTokens.$inferSelect;
export type InsertTeslaConfig = Zinfer<typeof insertTeslaConfigSchema>;
export type TeslaConfig = typeof teslaConfig.$inferSelect;
export type InsertTeslaActivityLog = Zinfer<typeof insertTeslaActivityLogSchema>;
export type TeslaActivityLog = typeof teslaActivityLogs.$inferSelect;
export type InsertTeslaBatteryAlert = Zinfer<typeof insertTeslaBatteryAlertSchema>;
export type TeslaBatteryAlert = typeof teslaBatteryAlerts.$inferSelect;
export type InsertHomeAssistantSetting = Zinfer<typeof insertHomeAssistantSettingSchema>;
export type HomeAssistantSetting = typeof homeAssistantSettings.$inferSelect;
export type InsertPoiProfile = Zinfer<typeof insertPoiProfileSchema>;
export type PoiProfile = typeof poiProfiles.$inferSelect;
export type InsertVehicleProfile = Zinfer<typeof insertVehicleProfileSchema>;
export type VehicleProfile = typeof vehicleProfiles.$inferSelect;
export type InsertPoiSighting = Zinfer<typeof insertPoiSightingSchema>;
export type PoiSighting = typeof poiSightings.$inferSelect;
export type InsertTrip = Zinfer<typeof insertTripSchema>;
export type Trip = typeof trips.$inferSelect;
export type InsertShoppingCartItem = Zinfer<typeof insertShoppingCartItemSchema>;
export type ShoppingCartItem = typeof shoppingCartItems.$inferSelect;
export type InsertAmazonOrderRequest = Zinfer<typeof insertAmazonOrderRequestSchema>;
export type AmazonOrderRequest = typeof amazonOrderRequests.$inferSelect;
export type InsertAmazonSetting = Zinfer<typeof insertAmazonSettingSchema>;
export type AmazonSetting = typeof amazonSettings.$inferSelect;
export type InsertEntertainmentEvent = Zinfer<typeof insertEntertainmentEventSchema>;
export type EntertainmentEvent = typeof entertainmentEvents.$inferSelect;
export type InsertEmailLog = Zinfer<typeof insertEmailLogSchema>;
export type EmailLog = typeof emailLogs.$inferSelect;
export type InsertWhatsappDedup = Zinfer<typeof insertWhatsappDedupSchema>;
export type WhatsappDedup = typeof whatsappDedup.$inferSelect;
export type InsertVoiceReply = Zinfer<typeof insertVoiceReplySchema>;
export type VoiceReply = typeof voiceReplies.$inferSelect;
export type InsertNotionWebhookEvent = Zinfer<typeof insertNotionWebhookEventSchema>;
export type NotionWebhookEvent = typeof notionWebhookEvents.$inferSelect;
export type InsertNotionSyncConfig = Zinfer<typeof insertNotionSyncConfigSchema>;
export type NotionSyncConfig = typeof notionSyncConfig.$inferSelect;
export type InsertNotionCachedPage = Zinfer<typeof insertNotionCachedPageSchema>;
export type NotionCachedPage = typeof notionCachedPages.$inferSelect;
export type InsertHwCalendarConfig = Zinfer<typeof insertHwCalendarConfigSchema>;
export type HwCalendarConfig = typeof hwCalendarConfig.$inferSelect;
export type InsertHwSchoolCalendar = Zinfer<typeof insertHwSchoolCalendarSchema>;
export type HwSchoolCalendar = typeof hwSchoolCalendars.$inferSelect;
export type InsertActivityEvent = Zinfer<typeof insertActivityEventSchema>;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type InsertMediaItem = Zinfer<typeof insertMediaItemSchema>;
export type MediaItem = typeof mediaItems.$inferSelect;
export type InsertSuggestion = Zinfer<typeof insertSuggestionSchema>;
export type Suggestion = typeof suggestions.$inferSelect;
export type InsertUserPlatformCredential = Zinfer<typeof insertUserPlatformCredentialSchema>;
export type UserPlatformCredential = typeof userPlatformCredentials.$inferSelect;
export type InsertVerkadaAlertLog = Zinfer<typeof insertVerkadaAlertLogSchema>;
export type VerkadaAlertLog = typeof verkadaAlertLog.$inferSelect;
export type InsertGroceryStaple = Zinfer<typeof insertGroceryStapleSchema>;
export type GroceryStaple = typeof groceryStaples.$inferSelect;
export type InsertGroceryOrderRun = Zinfer<typeof insertGroceryOrderRunSchema>;
export type GroceryOrderRun = typeof groceryOrderRuns.$inferSelect;
export type InsertGroceryOrderItem = Zinfer<typeof insertGroceryOrderItemSchema>;
export type GroceryOrderItem = typeof groceryOrderItems.$inferSelect;
export type InsertGroceryOrderItemAudit = Zinfer<typeof insertGroceryOrderItemAuditSchema>;
export type GroceryOrderItemAudit = typeof groceryOrderItemAudit.$inferSelect;

export const goaccessCheckins = pgTable("goaccess_checkins", {
  id: uuid("id").defaultRandom().primaryKey(),
  guestName: text("guest_name").notNull(),
  companyName: text("company_name"),
  checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull(),
  rawEmailSubject: text("raw_email_subject"),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const insertGoaccessCheckinSchema = createInsertSchema(goaccessCheckins).omit({ id: true, createdAt: true });
export type InsertGoaccessCheckin = Zinfer<typeof insertGoaccessCheckinSchema>;
export type GoaccessCheckin = typeof goaccessCheckins.$inferSelect;

export const goaccessPollState = pgTable("goaccess_poll_state", {
  id: integer("id").primaryKey().default(1),
  lastPollAt: timestamp("last_poll_at", { withTimezone: true }),
  lastMessageId: text("last_message_id"),
});

export const reportEmailDedup = pgTable("report_email_dedup", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportType: text("report_type").notNull(),
  periodKey: text("period_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("report_email_dedup_type_period_idx").on(table.reportType, table.periodKey),
]);

export const tokenExpiryAlertDedup = pgTable("token_expiry_alert_dedup", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  alertedAt: timestamp("alerted_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ─── Club34 Ball — Wednesday Night Pickup Basketball ─────────────────────
//
// Half-court pickup games. Roster of ~47 dads, public landing at /ball,
// admin at /admin?section=ball. Token-based personal RSVP links, no auth.

export const ballPlayers = pgTable("ball_players", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  phone: text("phone"),
  token: text("token").notNull().unique(),
  active: boolean("active").default(true).notNull(),
  // is_host = Tony. Auto-confirmed IN, skipped on email blasts.
  isHost: boolean("is_host").default(false).notNull(),
  notes: text("notes"),
  // Captured at first waiver sign-up via the player Ball page. One of
  // S | M | L | XL | XXL | XXXL (CHECK constraint in migration 0021).
  // Nullable so existing already-signed players aren't forced to
  // backfill; the backend only requires it on the *first* waiver sign.
  jerseySize: text("jersey_size"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ballGames = pgTable("ball_games", {
  id: uuid("id").defaultRandom().primaryKey(),
  gameDate: text("game_date").notNull().unique(), // ISO YYYY-MM-DD
  startTime: text("start_time").default("18:00").notNull(),
  endTime: text("end_time").default("20:00").notNull(),
  status: text("status").default("scheduled").notNull(), // scheduled | on | off | done
  minPlayers: integer("min_players").default(6).notNull(),
  notes: text("notes"),
  decisionSentAt: timestamp("decision_sent_at", { withTimezone: true }),
  inviteSentAt: timestamp("invite_sent_at", { withTimezone: true }),
  reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
  // Wed 9am day-of hard re-confirm blast — see migration 0018
  reconfirmSentAt: timestamp("reconfirm_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ballRsvps = pgTable("ball_rsvps", {
  id: uuid("id").defaultRandom().primaryKey(),
  gameId: uuid("game_id").notNull().references(() => ballGames.id, { onDelete: "cascade" }),
  playerId: uuid("player_id").notNull().references(() => ballPlayers.id, { onDelete: "cascade" }),
  // in | out | maybe | pending_reconfirm
  // pending_reconfirm = was IN, got the Wed 9am email, hasn't re-tapped yet.
  // Wed 2pm decide() treats this as NOT playing.
  status: text("status").notNull(),
  // Set when the dad re-confirms via Tuesday email link. Resets to NULL
  // when status changes back to 'in' fresh (e.g. mid-week toggle).
  reconfirmedAt: timestamp("reconfirmed_at", { withTimezone: true }),
  showedUp: boolean("showed_up"),
  source: text("source").default("web").notNull(), // web | email-link | admin | sms
  // GoAccess Control gate sync — see migration 0017 for details
  goaccessRegisteredAt: timestamp("goaccess_registered_at", { withTimezone: true }),
  goaccessVisitorId: text("goaccess_visitor_id"),
  goaccessSyncError: text("goaccess_sync_error"),
  respondedAt: timestamp("responded_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ball_rsvps_game_player_idx").on(table.gameId, table.playerId),
]);

// Click-through liability waiver — see migration 0020.
// One active waiver per (player_id, waiver_version) enforced by a
// partial unique index in SQL (revoked_at IS NULL). Drizzle's
// uniqueIndex helper doesn't model `WHERE` clauses, so the index is
// declared in the migration only.
export const ballWaivers = pgTable("ball_waivers", {
  id: uuid("id").defaultRandom().primaryKey(),
  playerId: uuid("player_id").notNull().references(() => ballPlayers.id, { onDelete: "cascade" }),
  waiverVersion: text("waiver_version").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).defaultNow().notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const insertBallPlayerSchema = createInsertSchema(ballPlayers).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBallGameSchema = createInsertSchema(ballGames).omit({ id: true, createdAt: true, updatedAt: true });
export const insertBallRsvpSchema = createInsertSchema(ballRsvps).omit({ id: true, respondedAt: true, updatedAt: true });
export const insertBallWaiverSchema = createInsertSchema(ballWaivers).omit({ id: true, signedAt: true });
export type InsertBallPlayer = Zinfer<typeof insertBallPlayerSchema>;
export type BallPlayer = typeof ballPlayers.$inferSelect;
export type InsertBallGame = Zinfer<typeof insertBallGameSchema>;
export type BallGame = typeof ballGames.$inferSelect;
export type InsertBallRsvp = Zinfer<typeof insertBallRsvpSchema>;
export type BallRsvp = typeof ballRsvps.$inferSelect;
export type InsertBallWaiver = Zinfer<typeof insertBallWaiverSchema>;
export type BallWaiver = typeof ballWaivers.$inferSelect;

// ─── Club34 Ball — email engagement tracking ─────────────────────────────
//
// One row per email sent (per dad, per game, per template). Tracks full
// lifecycle: created → sent → delivered/bounced → opened → clicked.
//
// 'opened' is unreliable for Apple Mail users (Apple Mail Privacy
// Protection auto-fetches tracking pixels). 'clicked' is the trustworthy
// engagement signal.

export const ballEmailSends = pgTable("ball_email_sends", {
  id: uuid("id").defaultRandom().primaryKey(),
  playerId: uuid("player_id").notNull().references(() => ballPlayers.id, { onDelete: "cascade" }),
  gameId: uuid("game_id").references(() => ballGames.id, { onDelete: "cascade" }),
  template: text("template").notNull(), // month-invite | reconfirm | decision-on | decision-off | reminder | other
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  bouncedAt: timestamp("bounced_at", { withTimezone: true }),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  openCount: integer("open_count").default(0).notNull(),
  firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
  clickCount: integer("click_count").default(0).notNull(),
  lastClickLink: text("last_click_link"),
  sendError: text("send_error"),
  bounceReason: text("bounce_reason"),
  userAgentFirstOpen: text("user_agent_first_open"),
  ipFirstOpen: text("ip_first_open"),
  userAgentFirstClick: text("user_agent_first_click"),
});

export type BallEmailSend = typeof ballEmailSends.$inferSelect;
export type InsertBallEmailSend = typeof ballEmailSends.$inferInsert;

// Per-circuit daily energy snapshots (see migration 0037). Club34-owned copy
// of every Emporia circuit's daily kWh so monthly reports work indefinitely,
// independent of Home Assistant's recorder purge window.
export const circuitEnergyDaily = pgTable("circuit_energy_daily", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  usageDate: date("usage_date").notNull(),
  entityId: text("entity_id").notNull(),
  label: text("label").notNull(),
  category: text("category").notNull(),
  kwh: numeric("kwh", { mode: "number", precision: 12, scale: 4 }).default(0).notNull(),
  sourceComplete: boolean("source_complete").default(false).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("circuit_energy_daily_entity_date_uniq").on(table.entityId, table.usageDate),
  index("circuit_energy_daily_usage_date_idx").on(table.usageDate.desc()),
  index("circuit_energy_daily_category_date_idx").on(table.category, table.usageDate.desc()),
]);

export type CircuitEnergyDaily = typeof circuitEnergyDaily.$inferSelect;
export type InsertCircuitEnergyDaily = typeof circuitEnergyDaily.$inferInsert;

// Per-day water usage snapshots (see migration 0038). The WATER analogue of
// circuit_energy_daily. Two non-overlapping sources: 'interior' (FloLogic
// whole-property gallons, zone null) and 'irrigation' (Rain Bird per-zone
// gallons, zone = HA entity_id). Total day water = interior + sum(irrigation).
// NOTE: the live uniqueness constraint is on (usage_date, source,
// COALESCE(zone,'')) — see the SQL migration; Drizzle can't express the
// COALESCE so the index below describes the column set only.
export const waterUsageDaily = pgTable("water_usage_daily", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  usageDate: date("usage_date").notNull(),
  source: text("source").notNull(),               // 'interior' | 'irrigation'
  zone: text("zone"),                              // irrigation zone HA entity_id; null for interior
  gallons: numeric("gallons", { mode: "number", precision: 14, scale: 2 }).default(0).notNull(),
  hcf: numeric("hcf", { mode: "number", precision: 14, scale: 4 }).default(0).notNull(),
  dollars: numeric("dollars", { mode: "number", precision: 12, scale: 2 }).default(0).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("water_usage_daily_date_source_zone_uniq").on(table.usageDate, table.source, table.zone),
  index("water_usage_daily_usage_date_idx").on(table.usageDate.desc()),
  index("water_usage_daily_source_date_idx").on(table.source, table.usageDate.desc()),
]);

export type WaterUsageDaily = typeof waterUsageDaily.$inferSelect;
export type InsertWaterUsageDaily = typeof waterUsageDaily.$inferInsert;

// Actual LADWP water bills used to reconcile modeled usage and drive
// bill-over-bill / year-over-year Water Intelligence findings (migration 0053).
export const waterBills = pgTable("water_bills", {
  id: serial("id").primaryKey(),
  billingPeriodStart: date("billing_period_start").notNull(),
  billingPeriodEnd: date("billing_period_end").notNull(),
  ladwpHcf: numeric("ladwp_hcf", { mode: "number", precision: 10, scale: 2 }).notNull(),
  ladwpGallons: numeric("ladwp_gallons", { mode: "number", precision: 14, scale: 2 }).notNull(),
  waterUsd: numeric("water_usd", { mode: "number", precision: 10, scale: 2 }).notNull(),
  sewerUsd: numeric("sewer_usd", { mode: "number", precision: 10, scale: 2 }),
  solidWasteUsd: numeric("solid_waste_usd", { mode: "number", precision: 10, scale: 2 }),
  totalNewChargesUsd: numeric("total_new_charges_usd", { mode: "number", precision: 10, scale: 2 }),
  priorYearHcf: numeric("prior_year_hcf", { mode: "number", precision: 10, scale: 2 }),
  priorYearDays: integer("prior_year_days"),
  rawBillData: jsonb("raw_bill_data").$type<Record<string, unknown>>(),
  importedAt: timestamp("imported_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex("idx_water_bills_period_unique").on(table.billingPeriodStart, table.billingPeriodEnd),
  index("idx_water_bills_period").on(table.billingPeriodStart.desc()),
]);

export type WaterBill = typeof waterBills.$inferSelect;
export type InsertWaterBill = typeof waterBills.$inferInsert;

// ── Club34 Time Tracking (T&M Contractor) ─────────────────────────────────

export const ttStatusEnum = pgEnum("tt_status", ["pending", "approved", "rejected", "paid"]);

export const ttCategories = pgTable("tt_categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ttWorkers = pgTable("tt_workers", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id"),
  fullName: text("full_name").notNull(),
  email: text("email").notNull().unique(),
  mobile: text("mobile"),
  zelleHandle: text("zelle_handle"),
  canAddExpenses: boolean("can_add_expenses").notNull().default(false),
  defaultCategoryId: uuid("default_category_id").references(() => ttCategories.id),
  active: boolean("active").notNull().default(true),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
});

export const ttRateHistory = pgTable("tt_rate_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  workerId: uuid("worker_id").notNull().references(() => ttWorkers.id),
  hourlyRateCents: integer("hourly_rate_cents").notNull(),
  effectiveFrom: date("effective_from").notNull(),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const ttWorkerCategories = pgTable("tt_worker_categories", {
  workerId: uuid("worker_id").notNull().references(() => ttWorkers.id),
  categoryId: uuid("category_id").notNull().references(() => ttCategories.id),
}, (t) => [
  uniqueIndex("tt_worker_categories_pk").on(t.workerId, t.categoryId),
]);

export const ttPayments = pgTable("tt_payments", {
  id: uuid("id").defaultRandom().primaryKey(),
  workerId: uuid("worker_id").notNull().references(() => ttWorkers.id),
  weekStart: date("week_start").notNull(),
  hoursTotal: numeric("hours_total", { mode: "number", precision: 7, scale: 2 }).notNull(),
  laborCents: integer("labor_cents").notNull(),
  expensesCents: integer("expenses_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull(),
  method: text("method").notNull().default("zelle_manual"),
  confirmationRef: text("confirmation_ref"),
  note: text("note"),
  paidAt: timestamp("paid_at", { withTimezone: true }).defaultNow().notNull(),
  paidBy: uuid("paid_by").notNull(),
});

export const ttTimeEntries = pgTable("tt_time_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  workerId: uuid("worker_id").notNull().references(() => ttWorkers.id),
  workDate: date("work_date").notNull(),
  categoryId: uuid("category_id").notNull().references(() => ttCategories.id),
  hours: numeric("hours", { mode: "number", precision: 5, scale: 2 }).notNull(),
  note: text("note"),
  rateCents: integer("rate_cents").notNull(),
  status: ttStatusEnum("status").notNull().default("pending"),
  rejectedReason: text("rejected_reason"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by"),
  paymentId: uuid("payment_id").references(() => ttPayments.id),
  isAdjustment: boolean("is_adjustment").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
});

export const ttExpenses = pgTable("tt_expenses", {
  id: uuid("id").defaultRandom().primaryKey(),
  workerId: uuid("worker_id").notNull().references(() => ttWorkers.id),
  expenseDate: date("expense_date").notNull(),
  amountCents: integer("amount_cents").notNull(),
  note: text("note").notNull(),
  receiptUrl: text("receipt_url"),
  categoryId: uuid("category_id").references(() => ttCategories.id),
  status: ttStatusEnum("status").notNull().default("pending"),
  rejectedReason: text("rejected_reason"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: uuid("approved_by"),
  paymentId: uuid("payment_id").references(() => ttPayments.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type TtCategory = typeof ttCategories.$inferSelect;
export type InsertTtCategory = typeof ttCategories.$inferInsert;
export type TtWorker = typeof ttWorkers.$inferSelect;
export type InsertTtWorker = typeof ttWorkers.$inferInsert;
export type TtRateHistory = typeof ttRateHistory.$inferSelect;
export type InsertTtRateHistory = typeof ttRateHistory.$inferInsert;
export type TtWorkerCategory = typeof ttWorkerCategories.$inferSelect;
export type TtPayment = typeof ttPayments.$inferSelect;
export type InsertTtPayment = typeof ttPayments.$inferInsert;
export type TtTimeEntry = typeof ttTimeEntries.$inferSelect;
export type InsertTtTimeEntry = typeof ttTimeEntries.$inferInsert;
export type TtExpense = typeof ttExpenses.$inferSelect;
export type InsertTtExpense = typeof ttExpenses.$inferInsert;
