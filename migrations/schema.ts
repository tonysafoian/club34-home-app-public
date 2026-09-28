import { pgTable, uuid, text, jsonb, timestamp, boolean, integer, uniqueIndex, foreignKey, numeric, unique, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const activityEventType = pgEnum("activity_event_type", ['motion', 'access', 'alarm', 'camera', 'system'])
export const activitySeverity = pgEnum("activity_severity", ['info', 'warning', 'alert'])
export const appRole = pgEnum("app_role", ['admin', 'member', 'guest'])
export const approvalStatus = pgEnum("approval_status", ['pending', 'approved', 'rejected'])


export const activityEvents = pgTable("activity_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	eventType: activityEventType("event_type").notNull(),
	severity: activitySeverity().default('info').notNull(),
	source: text().notNull(),
	description: text().notNull(),
	zone: text(),
	metadata: jsonb(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const amazonOrderRequests = pgTable("amazon_order_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	searchQuery: text("search_query").notNull(),
	status: text().default('pending').notNull(),
	autoOrder: boolean("auto_order").default(false).notNull(),
	cartSummary: jsonb("cart_summary"),
	axiomRunId: text("axiom_run_id"),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const amazonSettings = pgTable("amazon_settings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	amazonEmail: text("amazon_email").notNull(),
	encryptedPassword: text("encrypted_password").notNull(),
	configuredBy: text("configured_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const emailLogs = pgTable("email_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	subject: text().notNull(),
	recipients: text().array().notNull(),
	htmlBody: text("html_body").notNull(),
	textBody: text("text_body"),
	status: text().default('sent').notNull(),
	emailType: text("email_type").default('transactional').notNull(),
	errorMessage: text("error_message"),
	metadata: jsonb(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const entertainmentEvents = pgTable("entertainment_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	category: text().notNull(),
	eventDate: timestamp("event_date", { withTimezone: true, mode: 'string' }).notNull(),
	eventEnd: timestamp("event_end", { withTimezone: true, mode: 'string' }),
	venue: text(),
	location: text(),
	imageUrl: text("image_url"),
	ticketUrl: text("ticket_url"),
	source: text().default('manual').notNull(),
	seasonYear: integer("season_year"),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const failedJobs = pgTable("failed_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	functionName: text("function_name").notNull(),
	payload: jsonb().default({}),
	errorMessage: text("error_message").notNull(),
	errorDetail: jsonb("error_detail"),
	attempts: integer().default(1).notNull(),
	maxAttempts: integer("max_attempts").default(3).notNull(),
	status: text().default('pending').notNull(),
	nextRetryAt: timestamp("next_retry_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
});

export const googleTokens = pgTable("google_tokens", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token").notNull(),
	refreshToken: text("refresh_token").notNull(),
	tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	scopes: text().array().notNull(),
	googleEmail: text("google_email"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const homeAssistantSettings = pgTable("home_assistant_settings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	haUrl: text("ha_url"),
	encryptedToken: text("encrypted_token"),
	isConnected: boolean("is_connected").default(false),
	lastConnectedAt: timestamp("last_connected_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const familyAutomations = pgTable("family_automations", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	description: text(),
	automationType: text("automation_type").default('custom').notNull(),
	config: jsonb().default({}).notNull(),
	schedule: text(),
	isActive: boolean("is_active").default(true).notNull(),
	lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const householdMembers = pgTable("household_members", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	displayName: text("display_name").notNull(),
	email: text(),
	role: text().default('member').notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	supabaseUuid: text("supabase_uuid"),
	notionUuid: text("notion_uuid"),
	whatsappNumber: text("whatsapp_number"),
	aliases: text().array(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const hwCalendarConfig = pgTable("hw_calendar_config", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	childName: text("child_name").notNull(),
	email: text().notNull(),
	schoolYear: text("school_year").notNull(),
	grade: integer().notNull(),
	campus: text().default('lower').notNull(),
	syncedAt: timestamp("synced_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("hw_calendar_config_email_school_year_idx").using("btree", table.email.asc().nullsLast().op("text_ops"), table.schoolYear.asc().nullsLast().op("text_ops")),
]);

export const hwSchoolCalendars = pgTable("hw_school_calendars", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	schoolYear: text("school_year").notNull(),
	campus: text().default('lower').notNull(),
	events: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("hw_school_calendars_school_year_campus_idx").using("btree", table.schoolYear.asc().nullsLast().op("text_ops"), table.campus.asc().nullsLast().op("text_ops")),
]);

export const invitedEmails = pgTable("invited_emails", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	invitedBy: text("invited_by").notNull(),
	phoneNumber: text("phone_number"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const janusChatLogs = pgTable("janus_chat_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	userMessage: text("user_message").notNull(),
	assistantResponse: text("assistant_response"),
	channel: text().default('web').notNull(),
	userDisplayName: text("user_display_name"),
	userRole: text("user_role").default('member').notNull(),
	groupId: text("group_id"),
	mediaType: text("media_type"),
	toolCalls: jsonb("tool_calls"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const janusChatSummaries = pgTable("janus_chat_summaries", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	summary: text().default(').notNull(),
	messageCount: integer("message_count").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("janus_chat_summaries_user_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
]);

export const janusFunctionalTestLogs = pgTable("janus_functional_test_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	overallStatus: text("overall_status").default('unknown').notNull(),
	passed: integer().default(0).notNull(),
	failed: integer().default(0).notNull(),
	totalMs: integer("total_ms").default(0).notNull(),
	results: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const janusGroupConfigs = pgTable("janus_group_configs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	groupId: text("group_id").notNull(),
	groupName: text("group_name"),
	channel: text().default('whatsapp').notNull(),
	tier: text().default('standard').notNull(),
	messageCount: integer("message_count").default(0).notNull(),
	trustedPhones: text("trusted_phones").array(),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const janusHealthLogs = pgTable("janus_health_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	overallStatus: text("overall_status").default('unknown').notNull(),
	totalMs: integer("total_ms").default(0).notNull(),
	results: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const janusMemory = pgTable("janus_memory", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	key: text().notNull(),
	value: text().notNull(),
	context: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	uniqueIndex("janus_memory_user_key_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.key.asc().nullsLast().op("text_ops")),
]);

export const janusNotifications = pgTable("janus_notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	type: text().notNull(),
	message: text().notNull(),
	mediaUrl: text("media_url"),
	seen: boolean().default(false),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
});

export const janusProjectShares = pgTable("janus_project_shares", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	sharedByUserId: text("shared_by_user_id").notNull(),
	sharedWithUserId: text("shared_with_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [janusProjects.id],
			name: "janus_project_shares_project_id_janus_projects_id_fk"
		}),
]);

export const janusProjectArtifacts = pgTable("janus_project_artifacts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	title: text().default(').notNull(),
	content: text().default(').notNull(),
	artifactType: text("artifact_type").default('text').notNull(),
	metadata: jsonb(),
	savedByUserId: text("saved_by_user_id"),
	savedByDisplayName: text("saved_by_display_name"),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [janusProjects.id],
			name: "janus_project_artifacts_project_id_janus_projects_id_fk"
		}),
]);

export const janusReminders = pgTable("janus_reminders", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	userEmail: text("user_email").notNull(),
	reminderText: text("reminder_text").notNull(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }).notNull(),
	firedAt: timestamp("fired_at", { withTimezone: true, mode: 'string' }),
	channel: text().default('web').notNull(),
	whatsappNumber: text("whatsapp_number"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const mediaItems = pgTable("media_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	category: text().notNull(),
	source: text().default('manual').notNull(),
	description: text(),
	posterUrl: text("poster_url"),
	rating: text(),
	score: numeric(),
	rank: integer(),
	releaseDate: text("release_date"),
	streamingPlatform: text("streaming_platform"),
	lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true, mode: 'string' }),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const notionWebhookEvents = pgTable("notion_webhook_events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventType: text("event_type").notNull(),
	notionPageId: text("notion_page_id"),
	notionDatabaseId: text("notion_database_id"),
	payload: jsonb().default({}).notNull(),
	processed: boolean().default(false).notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const poiProfiles = pgTable("poi_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	verkadaPersonId: text("verkada_person_id").notNull(),
	label: text(),
	organization: text(),
	thumbnailUrl: text("thumbnail_url"),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	unique("poi_profiles_verkada_person_id_unique").on(table.verkadaPersonId),
]);

export const janusProjects = pgTable("janus_projects", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	name: text().default('Untitled').notNull(),
	status: text().default('active').notNull(),
	notionPageId: text("notion_page_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const notionSyncConfig = pgTable("notion_sync_config", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	notionDatabaseId: text("notion_database_id").notNull(),
	databaseName: text("database_name"),
	syncDirection: text("sync_direction").default('pull').notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const poiSightings = pgTable("poi_sightings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	verkadaPersonId: text("verkada_person_id").notNull(),
	seenAt: timestamp("seen_at", { withTimezone: true, mode: 'string' }).notNull(),
	cameraName: text("camera_name"),
	siteName: text("site_name"),
	confidence: numeric(),
	thumbnailUrl: text("thumbnail_url"),
	clipUrl: text("clip_url"),
	label: text(),
	organization: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const profiles = pgTable("profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	displayName: text("display_name"),
	avatarUrl: text("avatar_url"),
	phoneNumber: text("phone_number"),
	approvalStatus: approvalStatus("approval_status").default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("profiles_user_id_unique").on(table.userId),
]);

export const shoppingCartItems = pgTable("shopping_cart_items", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	productName: text("product_name").notNull(),
	platform: text().notNull(),
	quantity: integer().default(1).notNull(),
	price: text(),
	productUrl: text("product_url"),
	notes: text(),
	status: text().default('pending').notNull(),
	addedBy: text("added_by").default('user').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const speedTests = pgTable("speed_tests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	provider: text().default('spectrum').notNull(),
	downloadMbps: numeric("download_mbps", { precision: 10, scale:  2 }).notNull(),
	uploadMbps: numeric("upload_mbps", { precision: 10, scale:  2 }).notNull(),
	latencyMs: numeric("latency_ms", { precision: 8, scale:  2 }).notNull(),
	jitterMs: numeric("jitter_ms", { precision: 8, scale:  2 }),
	serverName: text("server_name"),
	testedAt: timestamp("tested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const suggestions = pgTable("suggestions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	userEmail: text("user_email").notNull(),
	userDisplayName: text("user_display_name"),
	content: text().notNull(),
	status: text().default('pending').notNull(),
	adminNote: text("admin_note"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const systemAuditLog = pgTable("system_audit_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	category: text().notNull(),
	eventType: text("event_type").notNull(),
	severity: text().default('info').notNull(),
	actorId: text("actor_id"),
	actorName: text("actor_name"),
	actorRole: text("actor_role"),
	channel: text(),
	summary: text().notNull(),
	detail: jsonb().default({}),
	durationMs: integer("duration_ms"),
	status: text().default('success').notNull(),
	edgeFunction: text("edge_function"),
	correlationId: text("correlation_id"),
});

export const systemConfigs = pgTable("system_configs", {
	key: text().primaryKey().notNull(),
	value: text().notNull(),
	description: text(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

export const systemPrompts = pgTable("system_prompts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: text().notNull(),
	label: text().notNull(),
	content: text().default(').notNull(),
	description: text(),
	updatedBy: text("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("system_prompts_slug_unique").on(table.slug),
]);

export const systemUpdates = pgTable("system_updates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	title: text().notNull(),
	description: text().default(').notNull(),
	version: text().notNull(),
	updateType: text("update_type").default('feature').notNull(),
	accessHint: text("access_hint"),
	suggestedBy: text("suggested_by"),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const teslaActivityLogs = pgTable("tesla_activity_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	vehicleId: text("vehicle_id").notNull(),
	vehicleName: text("vehicle_name"),
	eventType: text("event_type").notNull(),
	details: jsonb().default({}).notNull(),
	occurredAt: timestamp("occurred_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const teslaBatteryAlerts = pgTable("tesla_battery_alerts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	vehicleId: text("vehicle_id").notNull(),
	vehicleName: text("vehicle_name"),
	alertActive: boolean("alert_active").default(false),
	lastAlertedAt: timestamp("last_alerted_at", { withTimezone: true, mode: 'string' }),
	lastRangeMiles: numeric("last_range_miles"),
	lastWaAlertedRange: numeric("last_wa_alerted_range"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const teslaConfig = pgTable("tesla_config", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	publicKeyPem: text("public_key_pem").notNull(),
	privateKeyPem: text("private_key_pem").notNull(),
	region: text().default('na').notNull(),
	partnerRegistered: boolean("partner_registered").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const teslaTokens = pgTable("tesla_tokens", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token").notNull(),
	refreshToken: text("refresh_token").notNull(),
	tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const trips = pgTable("trips", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tripName: text("trip_name").notNull(),
	destination: text(),
	departureDate: timestamp("departure_date", { withTimezone: true, mode: 'string' }),
	returnDate: timestamp("return_date", { withTimezone: true, mode: 'string' }),
	status: text().default('upcoming').notNull(),
	flights: jsonb(),
	hotels: jsonb(),
	transfers: jsonb().default([]).notNull(),
	itinerary: jsonb(),
	notes: text(),
	travelers: text().array(),
	sourceEmailIds: text("source_email_ids").array(),
	lastScannedAt: timestamp("last_scanned_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const userPlatformCredentials = pgTable("user_platform_credentials", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	platform: text().notNull(),
	credentialLabel: text("credential_label").default('default').notNull(),
	encryptedUsername: text("encrypted_username").notNull(),
	encryptedPassword: text("encrypted_password").notNull(),
	metadata: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const userRoles = pgTable("user_roles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	role: appRole().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const verkadaAlertLog = pgTable("verkada_alert_log", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	verkadaAlertId: text("verkada_alert_id").notNull(),
	alertType: text("alert_type"),
	cameraName: text("camera_name"),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("verkada_alert_log_verkada_alert_id_unique").on(table.verkadaAlertId),
]);

export const voiceReplies = pgTable("voice_replies", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: text("user_id").notNull(),
	messageId: text("message_id"),
	audioUrl: text("audio_url"),
	transcript: text(),
	status: text().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const whatsappDedup = pgTable("whatsapp_dedup", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	messageId: text("message_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("whatsapp_dedup_message_id_unique").on(table.messageId),
]);

export const familyAutomationLogs = pgTable("family_automation_logs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	automationId: uuid("automation_id").notNull(),
	status: text().default('running').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
	errorMessage: text("error_message"),
	output: jsonb(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [familyAutomations.id],
			name: "family_automation_logs_automation_id_family_automations_id_fk"
		}),
]);

export const notionCachedPages = pgTable("notion_cached_pages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	syncConfigId: uuid("sync_config_id").notNull(),
	notionPageId: text("notion_page_id").notNull(),
	title: text(),
	contentPreview: text("content_preview"),
	properties: jsonb(),
	notionUrl: text("notion_url"),
	lastEditedAt: timestamp("last_edited_at", { withTimezone: true, mode: 'string' }),
	cachedAt: timestamp("cached_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.syncConfigId],
			foreignColumns: [notionSyncConfig.id],
			name: "notion_cached_pages_sync_config_id_notion_sync_config_id_fk"
		}),
]);
