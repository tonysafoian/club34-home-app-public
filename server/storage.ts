import { eq, desc, and, sql, gte, ilike, count as countFn, type SQL } from "drizzle-orm";
import { db, pool } from "./db";
import * as schema from "@shared/schema";

// All audit logs are stored in the primary PostgreSQL database (`DATABASE_URL`).
import type {
  Profile, InsertProfile,
  UserRole, InsertUserRole,
  InvitedEmail, InsertInvitedEmail,
  HouseholdMember, InsertHouseholdMember,
  SystemAuditLog, InsertSystemAuditLog,
  SystemConfig, InsertSystemConfig,
  SystemPrompt, InsertSystemPrompt,
  SystemUpdate, InsertSystemUpdate,
  FailedJob, InsertFailedJob,
  SpeedTest, InsertSpeedTest,
  JanusProject, InsertJanusProject,
  JanusProjectArtifact, InsertJanusProjectArtifact,
  JanusProjectShare, InsertJanusProjectShare,
  JanusChatLog, InsertJanusChatLog,
  JanusMemory, InsertJanusMemory,
  JanusChatSummary, InsertJanusChatSummary,
  JanusNotification, InsertJanusNotification,
  JanusReminder, InsertJanusReminder,
  JanusFunctionalTestLog, InsertJanusFunctionalTestLog,
  JanusGroupConfig, InsertJanusGroupConfig,
  JanusHealthLog, InsertJanusHealthLog,
  FamilyAutomation, InsertFamilyAutomation,
  FamilyAutomationLog, InsertFamilyAutomationLog,
  GoogleToken, InsertGoogleToken,
  TeslaToken, InsertTeslaToken,
  TeslaConfig, InsertTeslaConfig,
  TeslaActivityLog, InsertTeslaActivityLog,
  TeslaBatteryAlert, InsertTeslaBatteryAlert,
  HomeAssistantSetting, InsertHomeAssistantSetting,
  PoiProfile, InsertPoiProfile,
  PoiSighting, InsertPoiSighting,
  Trip, InsertTrip,
  ShoppingCartItem, InsertShoppingCartItem,
  AmazonOrderRequest, InsertAmazonOrderRequest,
  AmazonSetting, InsertAmazonSetting,
  EntertainmentEvent, InsertEntertainmentEvent,
  EmailLog, InsertEmailLog,
  WhatsappDedup, InsertWhatsappDedup,
  VoiceReply, InsertVoiceReply,
  NotionWebhookEvent, InsertNotionWebhookEvent,
  NotionSyncConfig, InsertNotionSyncConfig,
  NotionCachedPage, InsertNotionCachedPage,
  HwCalendarConfig, InsertHwCalendarConfig,
  HwSchoolCalendar, InsertHwSchoolCalendar,
  ActivityEvent, InsertActivityEvent,
  MediaItem, InsertMediaItem,
  Suggestion, InsertSuggestion,
  UserPlatformCredential, InsertUserPlatformCredential,
  VerkadaAlertLog, InsertVerkadaAlertLog,
  DeviceOverride, InsertDeviceOverride,
  ValveLabelPosition, InsertValveLabelPosition,
  IrrigationZoneName, InsertIrrigationZoneName,
} from "@shared/schema";

export interface ExternalApiEndpointStat {
  endpoint: string;
  calls: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
}

export interface IStorage {
  getProfileByUserId(userId: string): Promise<Profile | undefined>;
  createProfile(data: InsertProfile): Promise<Profile>;
  updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined>;
  deleteProfile(userId: string): Promise<void>;

  getUserRoles(userId: string): Promise<UserRole[]>;
  createUserRole(data: InsertUserRole): Promise<UserRole>;
  deleteUserRole(id: string): Promise<void>;
  hasRole(userId: string, role: "admin" | "member" | "guest"): Promise<boolean>;
  countUserRoles(): Promise<number>;

  getInvitedEmail(email: string): Promise<InvitedEmail | undefined>;
  createInvitedEmail(data: InsertInvitedEmail): Promise<InvitedEmail>;
  deleteInvitedEmail(email: string): Promise<void>;

  getHouseholdMembers(): Promise<HouseholdMember[]>;
  createHouseholdMember(data: InsertHouseholdMember): Promise<HouseholdMember>;
  updateHouseholdMember(id: string, data: Partial<InsertHouseholdMember>): Promise<HouseholdMember | undefined>;
  deleteHouseholdMember(id: string): Promise<void>;

  createSystemAuditLog(data: InsertSystemAuditLog): Promise<SystemAuditLog>;
  getSystemAuditLogs(limit?: number): Promise<SystemAuditLog[]>;
  querySystemAuditLogs(params: {
    category?: string;
    severity?: string;
    since?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ rows: SystemAuditLog[]; count: number }>;

  getExternalApiEndpointStats(hours?: number, topN?: number): Promise<ExternalApiEndpointStat[]>;

  getSystemConfig(key: string): Promise<SystemConfig | undefined>;
  upsertSystemConfig(data: InsertSystemConfig): Promise<SystemConfig>;
  deleteSystemConfig(key: string): Promise<void>;

  getSystemPromptBySlug(slug: string): Promise<SystemPrompt | undefined>;
  getAllSystemPrompts(): Promise<SystemPrompt[]>;
  upsertSystemPrompt(data: InsertSystemPrompt): Promise<SystemPrompt>;
  deleteSystemPrompt(slug: string): Promise<void>;

  getSystemUpdates(limit?: number): Promise<SystemUpdate[]>;
  createSystemUpdate(data: InsertSystemUpdate): Promise<SystemUpdate>;
  createSystemUpdatesAtomic(updates: InsertSystemUpdate[], cursor: InsertSystemConfig): Promise<SystemUpdate[]>;
  deleteSystemUpdate(id: string): Promise<void>;

  getFailedJobs(status?: string): Promise<FailedJob[]>;
  createFailedJob(data: InsertFailedJob): Promise<FailedJob>;
  updateFailedJob(id: string, data: Partial<InsertFailedJob>): Promise<FailedJob | undefined>;
  deleteFailedJob(id: string): Promise<void>;

  createSpeedTest(data: InsertSpeedTest): Promise<SpeedTest>;
  getSpeedTests(limit?: number): Promise<SpeedTest[]>;

  getJanusProject(id: string): Promise<JanusProject | undefined>;
  getJanusProjectsByUser(userId: string): Promise<JanusProject[]>;
  createJanusProject(data: InsertJanusProject): Promise<JanusProject>;
  updateJanusProject(id: string, data: Partial<InsertJanusProject>): Promise<JanusProject | undefined>;
  deleteJanusProject(id: string): Promise<void>;

  getJanusProjectArtifacts(projectId: string): Promise<JanusProjectArtifact[]>;
  createJanusProjectArtifact(data: InsertJanusProjectArtifact): Promise<JanusProjectArtifact>;
  deleteJanusProjectArtifact(id: string): Promise<void>;

  createJanusProjectShare(data: InsertJanusProjectShare): Promise<JanusProjectShare>;
  deleteJanusProjectShare(id: string): Promise<void>;

  getJanusChatLogs(userId: string, limit?: number): Promise<JanusChatLog[]>;
  createJanusChatLog(data: InsertJanusChatLog): Promise<JanusChatLog>;
  deleteJanusChatLog(id: string): Promise<void>;

  getJanusMemory(userId: string): Promise<JanusMemory[]>;
  upsertJanusMemory(data: InsertJanusMemory): Promise<JanusMemory>;
  deleteJanusMemory(id: string): Promise<void>;

  getJanusChatSummary(userId: string): Promise<JanusChatSummary | undefined>;
  upsertJanusChatSummary(data: InsertJanusChatSummary): Promise<JanusChatSummary>;
  deleteJanusChatSummary(userId: string): Promise<void>;

  getJanusNotifications(userId: string): Promise<JanusNotification[]>;
  createJanusNotification(data: InsertJanusNotification): Promise<JanusNotification>;
  updateJanusNotification(id: string, data: Partial<InsertJanusNotification>): Promise<JanusNotification | undefined>;
  deleteJanusNotification(id: string): Promise<void>;

  getJanusReminders(userId: string): Promise<JanusReminder[]>;
  createJanusReminder(data: InsertJanusReminder): Promise<JanusReminder>;
  updateJanusReminder(id: string, data: Partial<InsertJanusReminder>): Promise<JanusReminder | undefined>;
  deleteJanusReminder(id: string): Promise<void>;

  getJanusFunctionalTestLogs(limit?: number): Promise<JanusFunctionalTestLog[]>;
  createJanusFunctionalTestLog(data: InsertJanusFunctionalTestLog): Promise<JanusFunctionalTestLog>;

  getJanusGroupConfigs(): Promise<JanusGroupConfig[]>;
  createJanusGroupConfig(data: InsertJanusGroupConfig): Promise<JanusGroupConfig>;
  updateJanusGroupConfig(id: string, data: Partial<InsertJanusGroupConfig>): Promise<JanusGroupConfig | undefined>;
  deleteJanusGroupConfig(id: string): Promise<void>;

  getJanusHealthLogs(limit?: number): Promise<JanusHealthLog[]>;
  createJanusHealthLog(data: InsertJanusHealthLog): Promise<JanusHealthLog>;

  getFamilyAutomations(): Promise<FamilyAutomation[]>;
  createFamilyAutomation(data: InsertFamilyAutomation): Promise<FamilyAutomation>;
  updateFamilyAutomation(id: string, data: Partial<InsertFamilyAutomation>): Promise<FamilyAutomation | undefined>;
  deleteFamilyAutomation(id: string): Promise<void>;

  createFamilyAutomationLog(data: InsertFamilyAutomationLog): Promise<FamilyAutomationLog>;

  getGoogleToken(userId: string): Promise<GoogleToken | undefined>;
  upsertGoogleToken(data: InsertGoogleToken): Promise<GoogleToken>;
  deleteGoogleToken(userId: string): Promise<void>;

  getTeslaToken(userId: string): Promise<TeslaToken | undefined>;
  upsertTeslaToken(data: InsertTeslaToken): Promise<TeslaToken>;
  deleteTeslaToken(userId: string): Promise<void>;

  getTeslaConfig(): Promise<TeslaConfig | undefined>;
  createTeslaConfig(data: InsertTeslaConfig): Promise<TeslaConfig>;
  updateTeslaConfig(id: string, data: Partial<InsertTeslaConfig>): Promise<TeslaConfig | undefined>;

  getTeslaActivityLogs(limit?: number): Promise<TeslaActivityLog[]>;
  createTeslaActivityLog(data: InsertTeslaActivityLog): Promise<TeslaActivityLog>;

  getTeslaBatteryAlerts(): Promise<TeslaBatteryAlert[]>;
  createTeslaBatteryAlert(data: InsertTeslaBatteryAlert): Promise<TeslaBatteryAlert>;
  updateTeslaBatteryAlert(vehicleId: string, data: Partial<InsertTeslaBatteryAlert>): Promise<TeslaBatteryAlert | undefined>;
  deleteTeslaBatteryAlert(id: string): Promise<void>;

  getHomeAssistantSettings(userId: string): Promise<HomeAssistantSetting | undefined>;
  upsertHomeAssistantSettings(data: InsertHomeAssistantSetting): Promise<HomeAssistantSetting>;
  deleteHomeAssistantSettings(userId: string): Promise<void>;

  getPoiProfiles(): Promise<PoiProfile[]>;
  createPoiProfile(data: InsertPoiProfile): Promise<PoiProfile>;
  updatePoiProfile(id: string, data: Partial<InsertPoiProfile>): Promise<PoiProfile | undefined>;
  deletePoiProfile(id: string): Promise<void>;

  createPoiSighting(data: InsertPoiSighting): Promise<PoiSighting>;
  getPoiSightings(verkadaPersonId: string): Promise<PoiSighting[]>;

  getTrips(): Promise<Trip[]>;
  createTrip(data: InsertTrip): Promise<Trip>;
  updateTrip(id: string, data: Partial<InsertTrip>): Promise<Trip | undefined>;
  deleteTrip(id: string): Promise<void>;

  getShoppingCartItems(userId: string): Promise<ShoppingCartItem[]>;
  createShoppingCartItem(data: InsertShoppingCartItem): Promise<ShoppingCartItem>;
  updateShoppingCartItem(id: string, data: Partial<InsertShoppingCartItem>): Promise<ShoppingCartItem | undefined>;
  deleteShoppingCartItem(id: string): Promise<void>;

  createAmazonOrderRequest(data: InsertAmazonOrderRequest): Promise<AmazonOrderRequest>;
  getAmazonOrderRequests(userId: string): Promise<AmazonOrderRequest[]>;
  updateAmazonOrderRequest(id: string, data: Partial<InsertAmazonOrderRequest>): Promise<AmazonOrderRequest | undefined>;

  getAmazonSettings(): Promise<AmazonSetting | undefined>;

  getEntertainmentEvents(): Promise<EntertainmentEvent[]>;
  createEntertainmentEvent(data: InsertEntertainmentEvent): Promise<EntertainmentEvent>;
  updateEntertainmentEvent(id: string, data: Partial<InsertEntertainmentEvent>): Promise<EntertainmentEvent | undefined>;
  deleteEntertainmentEvent(id: string): Promise<void>;

  createEmailLog(data: InsertEmailLog): Promise<EmailLog>;
  getEmailLogs(limit?: number): Promise<EmailLog[]>;

  createWhatsappDedup(data: InsertWhatsappDedup): Promise<WhatsappDedup>;

  createVoiceReply(data: InsertVoiceReply): Promise<VoiceReply>;

  createNotionWebhookEvent(data: InsertNotionWebhookEvent): Promise<NotionWebhookEvent>;

  getNotionSyncConfigs(userId: string): Promise<NotionSyncConfig[]>;
  createNotionSyncConfig(data: InsertNotionSyncConfig): Promise<NotionSyncConfig>;
  updateNotionSyncConfig(id: string, data: Partial<InsertNotionSyncConfig>): Promise<NotionSyncConfig | undefined>;
  deleteNotionSyncConfig(id: string): Promise<void>;

  getNotionCachedPages(): Promise<NotionCachedPage[]>;
  createNotionCachedPage(data: InsertNotionCachedPage): Promise<NotionCachedPage>;
  deleteNotionCachedPage(id: string): Promise<void>;

  getHwCalendarConfigs(): Promise<HwCalendarConfig[]>;
  createHwCalendarConfig(data: InsertHwCalendarConfig): Promise<HwCalendarConfig>;
  updateHwCalendarConfig(id: string, data: Partial<InsertHwCalendarConfig>): Promise<HwCalendarConfig | undefined>;
  deleteHwCalendarConfig(id: string): Promise<void>;

  getHwSchoolCalendars(): Promise<HwSchoolCalendar[]>;
  createHwSchoolCalendar(data: InsertHwSchoolCalendar): Promise<HwSchoolCalendar>;
  deleteHwSchoolCalendar(id: string): Promise<void>;

  createActivityEvent(data: InsertActivityEvent): Promise<ActivityEvent>;
  getActivityEvents(limit?: number): Promise<ActivityEvent[]>;

  getMediaItems(): Promise<MediaItem[]>;
  createMediaItem(data: InsertMediaItem): Promise<MediaItem>;
  updateMediaItem(id: string, data: Partial<InsertMediaItem>): Promise<MediaItem | undefined>;
  deleteMediaItem(id: string): Promise<void>;

  getSuggestions(): Promise<Suggestion[]>;
  createSuggestion(data: InsertSuggestion): Promise<Suggestion>;
  updateSuggestion(id: string, data: Partial<InsertSuggestion>): Promise<Suggestion | undefined>;
  deleteSuggestion(id: string): Promise<void>;

  getUserPlatformCredentials(userId: string): Promise<UserPlatformCredential[]>;
  createUserPlatformCredential(data: InsertUserPlatformCredential): Promise<UserPlatformCredential>;
  updateUserPlatformCredential(id: string, data: Partial<InsertUserPlatformCredential>): Promise<UserPlatformCredential | undefined>;
  deleteUserPlatformCredential(id: string): Promise<void>;

  getVerkadaAlertLogs(limit?: number): Promise<VerkadaAlertLog[]>;
  createVerkadaAlertLog(data: InsertVerkadaAlertLog): Promise<VerkadaAlertLog>;

  getDeviceOverrides(): Promise<DeviceOverride[]>;
  getDeviceOverrideByMac(mac: string): Promise<DeviceOverride | undefined>;
  upsertDeviceOverride(data: InsertDeviceOverride): Promise<DeviceOverride>;
  deleteDeviceOverride(mac: string): Promise<void>;

  getValveLabelPositions(): Promise<ValveLabelPosition[]>;
  upsertValveLabelPosition(data: InsertValveLabelPosition): Promise<ValveLabelPosition>;
  deleteValveLabelPosition(svgId: string): Promise<void>;
  getIrrigationZoneNames(): Promise<IrrigationZoneName[]>;
  upsertIrrigationZoneName(data: InsertIrrigationZoneName): Promise<IrrigationZoneName>;
  deleteIrrigationZoneName(svgId: string): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getProfileByUserId(userId: string): Promise<Profile | undefined> {
    const [profile] = await db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId))
      .limit(1);
    return profile;
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const [profile] = await db.insert(schema.profiles).values(data).returning();
    return profile;
  }

  async updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined> {
    const [profile] = await db
      .update(schema.profiles)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.profiles.userId, userId))
      .returning();
    return profile;
  }

  async deleteProfile(userId: string): Promise<void> {
    await db.delete(schema.profiles).where(eq(schema.profiles.userId, userId));
  }

  async getUserRoles(userId: string): Promise<UserRole[]> {
    return db.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  }

  async createUserRole(data: InsertUserRole): Promise<UserRole> {
    const [role] = await db.insert(schema.userRoles).values(data).returning();
    return role;
  }

  async deleteUserRole(id: string): Promise<void> {
    await db.delete(schema.userRoles).where(eq(schema.userRoles.id, id));
  }

  async hasRole(userId: string, role: "admin" | "member" | "guest"): Promise<boolean> {
    const [result] = await db
      .select()
      .from(schema.userRoles)
      .where(and(eq(schema.userRoles.userId, userId), eq(schema.userRoles.role, role)))
      .limit(1);
    return !!result;
  }

  async countUserRoles(): Promise<number> {
    const [result] = await db.select({ count: sql<number>`count(*)` }).from(schema.userRoles);
    return Number(result.count);
  }

  async getInvitedEmail(email: string): Promise<InvitedEmail | undefined> {
    const [invite] = await db
      .select()
      .from(schema.invitedEmails)
      .where(eq(schema.invitedEmails.email, email))
      .limit(1);
    return invite;
  }

  async createInvitedEmail(data: InsertInvitedEmail): Promise<InvitedEmail> {
    const [invite] = await db.insert(schema.invitedEmails).values(data).returning();
    return invite;
  }

  async deleteInvitedEmail(email: string): Promise<void> {
    await db.delete(schema.invitedEmails).where(eq(schema.invitedEmails.email, email));
  }

  async getHouseholdMembers(): Promise<HouseholdMember[]> {
    return db.select().from(schema.householdMembers);
  }

  async createHouseholdMember(data: InsertHouseholdMember): Promise<HouseholdMember> {
    const [member] = await db.insert(schema.householdMembers).values(data).returning();
    return member;
  }

  async updateHouseholdMember(id: string, data: Partial<InsertHouseholdMember>): Promise<HouseholdMember | undefined> {
    const [member] = await db.update(schema.householdMembers).set({ ...data, updatedAt: new Date() }).where(eq(schema.householdMembers.id, id)).returning();
    return member;
  }

  async deleteHouseholdMember(id: string): Promise<void> {
    await db.delete(schema.householdMembers).where(eq(schema.householdMembers.id, id));
  }

  async createSystemAuditLog(data: InsertSystemAuditLog): Promise<SystemAuditLog> {
    const [log] = await db.insert(schema.systemAuditLog).values(data).returning();
    return log;
  }

  async getSystemAuditLogs(limit = 100): Promise<SystemAuditLog[]> {
    return db.select().from(schema.systemAuditLog).orderBy(desc(schema.systemAuditLog.createdAt)).limit(limit);
  }

  async querySystemAuditLogs(params: {
    category?: string;
    severity?: string;
    since?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ rows: SystemAuditLog[]; count: number }> {
    const buildWhereAndValues = () => {
      const whereClauses: string[] = [];
      const values: unknown[] = [];
      let idx = 1;
      if (params.category && params.category !== 'all') {
        whereClauses.push(`category = $${idx++}`);
        values.push(params.category);
      }
      if (params.severity && params.severity !== 'all') {
        const sev = params.severity;
        const normSev = sev === 'warn' ? ['warn', 'warning'] : sev === 'warning' ? ['warn', 'warning'] : [sev];
        if (normSev.length === 1) {
          whereClauses.push(`severity = $${idx++}`);
          values.push(normSev[0]);
        } else {
          whereClauses.push(`severity = ANY($${idx++}::text[])`);
          values.push(normSev);
        }
      }
      if (params.since) {
        whereClauses.push(`created_at >= $${idx++}`);
        values.push(new Date(params.since));
      }
      if (params.search) {
        whereClauses.push(`summary ILIKE $${idx++}`);
        values.push(`%${params.search}%`);
      }
      const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
      return { whereClause, values, idx };
    };

    const conditions: SQL[] = [];
    if (params.category && params.category !== 'all') {
      conditions.push(eq(schema.systemAuditLog.category, params.category));
    }
    if (params.severity && params.severity !== 'all') {
      const sev = params.severity;
      if (sev === 'warn' || sev === 'warning') {
        conditions.push(
          sql`${schema.systemAuditLog.severity} IN ('warn', 'warning')`
        );
      } else {
        conditions.push(eq(schema.systemAuditLog.severity, sev));
      }
    }
    if (params.since) {
      conditions.push(gte(schema.systemAuditLog.createdAt, new Date(params.since)));
    }
    if (params.search) {
      conditions.push(ilike(schema.systemAuditLog.summary, `%${params.search}%`));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const [rows, [{ total }]] = await Promise.all([
      db.select()
        .from(schema.systemAuditLog)
        .where(where)
        .orderBy(desc(schema.systemAuditLog.createdAt))
        .limit(params.limit ?? 50)
        .offset(params.offset ?? 0),
      db.select({ total: countFn() })
        .from(schema.systemAuditLog)
        .where(where),
    ]);

    console.log(`[querySystemAuditLogs] source=local rows=${rows.length} total=${total}`);
    return { rows, count: Number(total) };
  }

  /**
   * Per-endpoint latency stats for External API calls, aggregated in SQL over
   * the full time window (so the numbers stay accurate regardless of call
   * volume — no client-side row caps). Endpoint keys mirror the frontend's
   * derivation: `external_api.` prefix stripped, and tools.invoke rows keyed
   * per-tool as `tools/<tool>/invoke`. Middleware pseudo-endpoints (auth,
   * rate_limit, not_found) are excluded, as are endpoints with no recorded
   * durations.
   */
  async getExternalApiEndpointStats(hours = 24, topN = 5): Promise<ExternalApiEndpointStat[]> {
    const { rows } = await pool.query(
      `SELECT
         CASE WHEN event_type = 'external_api.tools.invoke' AND detail->>'tool' IS NOT NULL
              THEN 'tools/' || (detail->>'tool') || '/invoke'
              ELSE substring(event_type from 14) END AS endpoint,
         COUNT(*)::int AS calls,
         (COUNT(*) FILTER (WHERE status <> 'success'))::int AS errors,
         AVG((detail->>'duration_ms')::numeric)
           FILTER (WHERE detail->>'duration_ms' ~ '^[0-9]+(\\.[0-9]+)?$') AS avg_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY (detail->>'duration_ms')::numeric)
           FILTER (WHERE detail->>'duration_ms' ~ '^[0-9]+(\\.[0-9]+)?$') AS p95_ms
       FROM system_audit_log
       WHERE category = 'external_api'
         AND created_at >= now() - make_interval(hours => $1::int)
         AND event_type NOT IN ('external_api.auth', 'external_api.rate_limit', 'external_api.not_found')
       GROUP BY 1
       HAVING COUNT(*) FILTER (WHERE detail->>'duration_ms' ~ '^[0-9]+(\\.[0-9]+)?$') > 0
       ORDER BY p95_ms DESC NULLS LAST
       LIMIT $2`,
      [hours, topN],
    );
    // node-postgres returns numeric aggregates as strings — coerce before the UI does math.
    return rows.map((r: Record<string, unknown>) => ({
      endpoint: String(r.endpoint),
      calls: Number(r.calls),
      errors: Number(r.errors),
      avgMs: Number(r.avg_ms),
      p95Ms: Number(r.p95_ms),
    }));
  }

  async getSystemConfig(key: string): Promise<SystemConfig | undefined> {
    const [config] = await db
      .select()
      .from(schema.systemConfigs)
      .where(eq(schema.systemConfigs.key, key))
      .limit(1);
    return config;
  }

  async upsertSystemConfig(data: InsertSystemConfig): Promise<SystemConfig> {
    const [config] = await db
      .insert(schema.systemConfigs)
      .values(data)
      .onConflictDoUpdate({
        target: schema.systemConfigs.key,
        set: { value: data.value, description: data.description, updatedAt: new Date() },
      })
      .returning();
    return config;
  }

  async deleteSystemConfig(key: string): Promise<void> {
    await db.delete(schema.systemConfigs).where(eq(schema.systemConfigs.key, key));
  }

  async getSystemPromptBySlug(slug: string): Promise<SystemPrompt | undefined> {
    const [prompt] = await db
      .select()
      .from(schema.systemPrompts)
      .where(eq(schema.systemPrompts.slug, slug))
      .limit(1);
    return prompt;
  }

  async getAllSystemPrompts(): Promise<SystemPrompt[]> {
    return db.select().from(schema.systemPrompts);
  }

  async upsertSystemPrompt(data: InsertSystemPrompt): Promise<SystemPrompt> {
    const [prompt] = await db
      .insert(schema.systemPrompts)
      .values(data)
      .onConflictDoUpdate({
        target: schema.systemPrompts.slug,
        set: { content: data.content, label: data.label, description: data.description, updatedAt: new Date() },
      })
      .returning();
    return prompt;
  }

  async deleteSystemPrompt(slug: string): Promise<void> {
    await db.delete(schema.systemPrompts).where(eq(schema.systemPrompts.slug, slug));
  }

  async getSystemUpdates(limit = 50): Promise<SystemUpdate[]> {
    return db.select().from(schema.systemUpdates).orderBy(desc(schema.systemUpdates.publishedAt)).limit(limit);
  }

  async createSystemUpdate(data: InsertSystemUpdate): Promise<SystemUpdate> {
    const [update] = await db.insert(schema.systemUpdates).values(data).returning();
    return update;
  }

  // Atomically insert a batch of system_updates rows AND advance a system_configs
  // cursor in a single transaction. Either every row is published and the cursor
  // moves forward together, or nothing changes — so a mid-batch failure can never
  // leave published entries with a stale cursor (which would re-publish them next run).
  async createSystemUpdatesAtomic(
    updates: InsertSystemUpdate[],
    cursor: InsertSystemConfig,
  ): Promise<SystemUpdate[]> {
    return db.transaction(async (tx) => {
      const rows: SystemUpdate[] = [];
      for (const u of updates) {
        const [row] = await tx.insert(schema.systemUpdates).values(u).returning();
        rows.push(row);
      }
      await tx
        .insert(schema.systemConfigs)
        .values(cursor)
        .onConflictDoUpdate({
          target: schema.systemConfigs.key,
          set: { value: cursor.value, description: cursor.description, updatedAt: new Date() },
        });
      return rows;
    });
  }

  async deleteSystemUpdate(id: string): Promise<void> {
    await db.delete(schema.systemUpdates).where(eq(schema.systemUpdates.id, id));
  }

  async getFailedJobs(status?: string): Promise<FailedJob[]> {
    if (status) {
      return db.select().from(schema.failedJobs).where(eq(schema.failedJobs.status, status)).orderBy(desc(schema.failedJobs.createdAt));
    }
    return db.select().from(schema.failedJobs).orderBy(desc(schema.failedJobs.createdAt));
  }

  async createFailedJob(data: InsertFailedJob): Promise<FailedJob> {
    const [job] = await db.insert(schema.failedJobs).values(data).returning();
    return job;
  }

  async updateFailedJob(id: string, data: Partial<InsertFailedJob>): Promise<FailedJob | undefined> {
    const [job] = await db.update(schema.failedJobs).set(data).where(eq(schema.failedJobs.id, id)).returning();
    return job;
  }

  async deleteFailedJob(id: string): Promise<void> {
    await db.delete(schema.failedJobs).where(eq(schema.failedJobs.id, id));
  }

  async createSpeedTest(data: InsertSpeedTest): Promise<SpeedTest> {
    const [test] = await db.insert(schema.speedTests).values(data).returning();
    return test;
  }

  async getSpeedTests(limit = 50): Promise<SpeedTest[]> {
    return db.select().from(schema.speedTests).orderBy(desc(schema.speedTests.testedAt)).limit(limit);
  }

  async getJanusProject(id: string): Promise<JanusProject | undefined> {
    const [project] = await db
      .select()
      .from(schema.janusProjects)
      .where(eq(schema.janusProjects.id, id))
      .limit(1);
    return project;
  }

  async getJanusProjectsByUser(userId: string): Promise<JanusProject[]> {
    return db.select().from(schema.janusProjects).where(eq(schema.janusProjects.userId, userId)).orderBy(desc(schema.janusProjects.updatedAt));
  }

  async createJanusProject(data: InsertJanusProject): Promise<JanusProject> {
    const [project] = await db.insert(schema.janusProjects).values(data).returning();
    return project;
  }

  async updateJanusProject(id: string, data: Partial<InsertJanusProject>): Promise<JanusProject | undefined> {
    const [project] = await db.update(schema.janusProjects).set({ ...data, updatedAt: new Date() }).where(eq(schema.janusProjects.id, id)).returning();
    return project;
  }

  async deleteJanusProject(id: string): Promise<void> {
    await db.delete(schema.janusProjects).where(eq(schema.janusProjects.id, id));
  }

  async getJanusProjectArtifacts(projectId: string): Promise<JanusProjectArtifact[]> {
    return db.select().from(schema.janusProjectArtifacts).where(eq(schema.janusProjectArtifacts.projectId, projectId));
  }

  async createJanusProjectArtifact(data: InsertJanusProjectArtifact): Promise<JanusProjectArtifact> {
    const [artifact] = await db.insert(schema.janusProjectArtifacts).values(data).returning();
    return artifact;
  }

  async deleteJanusProjectArtifact(id: string): Promise<void> {
    await db.delete(schema.janusProjectArtifacts).where(eq(schema.janusProjectArtifacts.id, id));
  }

  async createJanusProjectShare(data: InsertJanusProjectShare): Promise<JanusProjectShare> {
    const [share] = await db.insert(schema.janusProjectShares).values(data).returning();
    return share;
  }

  async deleteJanusProjectShare(id: string): Promise<void> {
    await db.delete(schema.janusProjectShares).where(eq(schema.janusProjectShares.id, id));
  }

  async getJanusChatLogs(userId: string, limit = 50): Promise<JanusChatLog[]> {
    return db.select().from(schema.janusChatLogs).where(eq(schema.janusChatLogs.userId, userId)).orderBy(desc(schema.janusChatLogs.createdAt)).limit(limit);
  }

  async createJanusChatLog(data: InsertJanusChatLog): Promise<JanusChatLog> {
    const [log] = await db.insert(schema.janusChatLogs).values(data).returning();
    return log;
  }

  async deleteJanusChatLog(id: string): Promise<void> {
    await db.delete(schema.janusChatLogs).where(eq(schema.janusChatLogs.id, id));
  }

  async getJanusMemory(userId: string): Promise<JanusMemory[]> {
    return db.select().from(schema.janusMemory).where(eq(schema.janusMemory.userId, userId));
  }

  async upsertJanusMemory(data: InsertJanusMemory): Promise<JanusMemory> {
    const [memory] = await db
      .insert(schema.janusMemory)
      .values(data as unknown as typeof schema.janusMemory.$inferInsert)
      .onConflictDoUpdate({
        target: [schema.janusMemory.userId, schema.janusMemory.key],
        set: { value: data.value, context: data.context, updatedAt: new Date() },
      })
      .returning();
    return memory;
  }

  async deleteJanusMemory(id: string): Promise<void> {
    await db.delete(schema.janusMemory).where(eq(schema.janusMemory.id, id));
  }

  async getJanusChatSummary(userId: string): Promise<JanusChatSummary | undefined> {
    const [summary] = await db
      .select()
      .from(schema.janusChatSummaries)
      .where(eq(schema.janusChatSummaries.userId, userId))
      .limit(1);
    return summary;
  }

  async upsertJanusChatSummary(data: InsertJanusChatSummary): Promise<JanusChatSummary> {
    const [summary] = await db
      .insert(schema.janusChatSummaries)
      .values(data)
      .onConflictDoUpdate({
        target: schema.janusChatSummaries.userId,
        set: { summary: data.summary, messageCount: data.messageCount, updatedAt: new Date() },
      })
      .returning();
    return summary;
  }

  async deleteJanusChatSummary(userId: string): Promise<void> {
    await db.delete(schema.janusChatSummaries).where(eq(schema.janusChatSummaries.userId, userId));
  }

  async getJanusNotifications(userId: string): Promise<JanusNotification[]> {
    return db.select().from(schema.janusNotifications).where(eq(schema.janusNotifications.userId, userId));
  }

  async createJanusNotification(data: InsertJanusNotification): Promise<JanusNotification> {
    const [notification] = await db.insert(schema.janusNotifications).values(data).returning();
    return notification;
  }

  async updateJanusNotification(id: string, data: Partial<InsertJanusNotification>): Promise<JanusNotification | undefined> {
    const [notification] = await db.update(schema.janusNotifications).set(data).where(eq(schema.janusNotifications.id, id)).returning();
    return notification;
  }

  async deleteJanusNotification(id: string): Promise<void> {
    await db.delete(schema.janusNotifications).where(eq(schema.janusNotifications.id, id));
  }

  async getJanusReminders(userId: string): Promise<JanusReminder[]> {
    return db.select().from(schema.janusReminders).where(eq(schema.janusReminders.userId, userId));
  }

  async createJanusReminder(data: InsertJanusReminder): Promise<JanusReminder> {
    const [reminder] = await db.insert(schema.janusReminders).values(data).returning();
    return reminder;
  }

  async updateJanusReminder(id: string, data: Partial<InsertJanusReminder>): Promise<JanusReminder | undefined> {
    const [reminder] = await db.update(schema.janusReminders).set(data).where(eq(schema.janusReminders.id, id)).returning();
    return reminder;
  }

  async deleteJanusReminder(id: string): Promise<void> {
    await db.delete(schema.janusReminders).where(eq(schema.janusReminders.id, id));
  }

  async getJanusFunctionalTestLogs(limit = 50): Promise<JanusFunctionalTestLog[]> {
    return db.select().from(schema.janusFunctionalTestLogs).orderBy(desc(schema.janusFunctionalTestLogs.createdAt)).limit(limit);
  }

  async createJanusFunctionalTestLog(data: InsertJanusFunctionalTestLog): Promise<JanusFunctionalTestLog> {
    const [log] = await db.insert(schema.janusFunctionalTestLogs).values(data).returning();
    return log;
  }

  async getJanusGroupConfigs(): Promise<JanusGroupConfig[]> {
    return db.select().from(schema.janusGroupConfigs);
  }

  async createJanusGroupConfig(data: InsertJanusGroupConfig): Promise<JanusGroupConfig> {
    const [config] = await db.insert(schema.janusGroupConfigs).values(data).returning();
    return config;
  }

  async updateJanusGroupConfig(id: string, data: Partial<InsertJanusGroupConfig>): Promise<JanusGroupConfig | undefined> {
    const [config] = await db.update(schema.janusGroupConfigs).set({ ...data, updatedAt: new Date() }).where(eq(schema.janusGroupConfigs.id, id)).returning();
    return config;
  }

  async deleteJanusGroupConfig(id: string): Promise<void> {
    await db.delete(schema.janusGroupConfigs).where(eq(schema.janusGroupConfigs.id, id));
  }

  async getJanusHealthLogs(limit = 50): Promise<JanusHealthLog[]> {
    return db.select().from(schema.janusHealthLogs).orderBy(desc(schema.janusHealthLogs.createdAt)).limit(limit);
  }

  async createJanusHealthLog(data: InsertJanusHealthLog): Promise<JanusHealthLog> {
    const [log] = await db.insert(schema.janusHealthLogs).values(data).returning();
    return log;
  }

  async getFamilyAutomations(): Promise<FamilyAutomation[]> {
    return db.select().from(schema.familyAutomations);
  }

  async createFamilyAutomation(data: InsertFamilyAutomation): Promise<FamilyAutomation> {
    const [automation] = await db.insert(schema.familyAutomations).values(data).returning();
    return automation;
  }

  async updateFamilyAutomation(id: string, data: Partial<InsertFamilyAutomation>): Promise<FamilyAutomation | undefined> {
    const [automation] = await db.update(schema.familyAutomations).set({ ...data, updatedAt: new Date() }).where(eq(schema.familyAutomations.id, id)).returning();
    return automation;
  }

  async deleteFamilyAutomation(id: string): Promise<void> {
    await db.delete(schema.familyAutomations).where(eq(schema.familyAutomations.id, id));
  }

  async createFamilyAutomationLog(data: InsertFamilyAutomationLog): Promise<FamilyAutomationLog> {
    const [log] = await db.insert(schema.familyAutomationLogs).values(data).returning();
    return log;
  }

  async getGoogleToken(userId: string): Promise<GoogleToken | undefined> {
    const [token] = await db
      .select()
      .from(schema.googleTokens)
      .where(eq(schema.googleTokens.userId, userId))
      .limit(1);
    return token;
  }

  async upsertGoogleToken(data: InsertGoogleToken): Promise<GoogleToken> {
    const existing = await this.getGoogleToken(data.userId);
    if (existing) {
      const [token] = await db
        .update(schema.googleTokens)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.googleTokens.userId, data.userId))
        .returning();
      return token;
    }
    const [token] = await db.insert(schema.googleTokens).values(data).returning();
    return token;
  }

  async deleteGoogleToken(userId: string): Promise<void> {
    await db.delete(schema.googleTokens).where(eq(schema.googleTokens.userId, userId));
  }

  async getTeslaToken(userId: string): Promise<TeslaToken | undefined> {
    const [token] = await db
      .select()
      .from(schema.teslaTokens)
      .where(eq(schema.teslaTokens.userId, userId))
      .limit(1);
    return token;
  }

  async upsertTeslaToken(data: InsertTeslaToken): Promise<TeslaToken> {
    const existing = await this.getTeslaToken(data.userId);
    if (existing) {
      const [token] = await db
        .update(schema.teslaTokens)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.teslaTokens.userId, data.userId))
        .returning();
      return token;
    }
    const [token] = await db.insert(schema.teslaTokens).values(data).returning();
    return token;
  }

  async deleteTeslaToken(userId: string): Promise<void> {
    await db.delete(schema.teslaTokens).where(eq(schema.teslaTokens.userId, userId));
  }

  async getTeslaConfig(): Promise<TeslaConfig | undefined> {
    const [config] = await db.select().from(schema.teslaConfig).limit(1);
    return config;
  }

  async createTeslaConfig(data: InsertTeslaConfig): Promise<TeslaConfig> {
    const [config] = await db.insert(schema.teslaConfig).values(data).returning();
    return config;
  }

  async updateTeslaConfig(id: string, data: Partial<InsertTeslaConfig>): Promise<TeslaConfig | undefined> {
    const [config] = await db.update(schema.teslaConfig).set({ ...data, updatedAt: new Date() }).where(eq(schema.teslaConfig.id, id)).returning();
    return config;
  }

  async getTeslaActivityLogs(limit = 100): Promise<TeslaActivityLog[]> {
    return db.select().from(schema.teslaActivityLogs).orderBy(desc(schema.teslaActivityLogs.occurredAt)).limit(limit);
  }

  async createTeslaActivityLog(data: InsertTeslaActivityLog): Promise<TeslaActivityLog> {
    const [log] = await db.insert(schema.teslaActivityLogs).values(data).returning();
    return log;
  }

  async getTeslaBatteryAlerts(): Promise<TeslaBatteryAlert[]> {
    return db.select().from(schema.teslaBatteryAlerts);
  }

  async createTeslaBatteryAlert(data: InsertTeslaBatteryAlert): Promise<TeslaBatteryAlert> {
    const [alert] = await db.insert(schema.teslaBatteryAlerts).values(data).returning();
    return alert;
  }

  async updateTeslaBatteryAlert(vehicleId: string, data: Partial<InsertTeslaBatteryAlert>): Promise<TeslaBatteryAlert | undefined> {
    const [alert] = await db
      .update(schema.teslaBatteryAlerts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(schema.teslaBatteryAlerts.vehicleId, vehicleId))
      .returning();
    return alert;
  }

  async deleteTeslaBatteryAlert(id: string): Promise<void> {
    await db.delete(schema.teslaBatteryAlerts).where(eq(schema.teslaBatteryAlerts.id, id));
  }

  async getHomeAssistantSettings(userId: string): Promise<HomeAssistantSetting | undefined> {
    const [settings] = await db
      .select()
      .from(schema.homeAssistantSettings)
      .where(eq(schema.homeAssistantSettings.userId, userId))
      .limit(1);
    return settings;
  }

  async upsertHomeAssistantSettings(data: InsertHomeAssistantSetting): Promise<HomeAssistantSetting> {
    const existing = await this.getHomeAssistantSettings(data.userId);
    if (existing) {
      const [settings] = await db
        .update(schema.homeAssistantSettings)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(schema.homeAssistantSettings.userId, data.userId))
        .returning();
      return settings;
    }
    const [settings] = await db.insert(schema.homeAssistantSettings).values(data).returning();
    return settings;
  }

  async deleteHomeAssistantSettings(userId: string): Promise<void> {
    await db.delete(schema.homeAssistantSettings).where(eq(schema.homeAssistantSettings.userId, userId));
  }

  async getPoiProfiles(): Promise<PoiProfile[]> {
    return db.select().from(schema.poiProfiles);
  }

  async createPoiProfile(data: InsertPoiProfile): Promise<PoiProfile> {
    const [profile] = await db.insert(schema.poiProfiles).values(data).returning();
    return profile;
  }

  async updatePoiProfile(id: string, data: Partial<InsertPoiProfile>): Promise<PoiProfile | undefined> {
    const [profile] = await db.update(schema.poiProfiles).set({ ...data, updatedAt: new Date() }).where(eq(schema.poiProfiles.id, id)).returning();
    return profile;
  }

  async deletePoiProfile(id: string): Promise<void> {
    await db.delete(schema.poiProfiles).where(eq(schema.poiProfiles.id, id));
  }

  async createPoiSighting(data: InsertPoiSighting): Promise<PoiSighting> {
    const [sighting] = await db.insert(schema.poiSightings).values(data).returning();
    return sighting;
  }

  async getPoiSightings(verkadaPersonId: string): Promise<PoiSighting[]> {
    return db.select().from(schema.poiSightings).where(eq(schema.poiSightings.verkadaPersonId, verkadaPersonId)).orderBy(desc(schema.poiSightings.seenAt));
  }

  async getTrips(): Promise<Trip[]> {
    return db.select().from(schema.trips).orderBy(desc(schema.trips.departureDate));
  }

  async createTrip(data: InsertTrip): Promise<Trip> {
    const [trip] = await db.insert(schema.trips).values(data).returning();
    return trip;
  }

  async updateTrip(id: string, data: Partial<InsertTrip>): Promise<Trip | undefined> {
    const [trip] = await db.update(schema.trips).set({ ...data, updatedAt: new Date() }).where(eq(schema.trips.id, id)).returning();
    return trip;
  }

  async deleteTrip(id: string): Promise<void> {
    await db.delete(schema.trips).where(eq(schema.trips.id, id));
  }

  async getShoppingCartItems(userId: string): Promise<ShoppingCartItem[]> {
    return db.select().from(schema.shoppingCartItems).where(eq(schema.shoppingCartItems.userId, userId));
  }

  async createShoppingCartItem(data: InsertShoppingCartItem): Promise<ShoppingCartItem> {
    const [item] = await db.insert(schema.shoppingCartItems).values(data).returning();
    return item;
  }

  async updateShoppingCartItem(id: string, data: Partial<InsertShoppingCartItem>): Promise<ShoppingCartItem | undefined> {
    const [item] = await db.update(schema.shoppingCartItems).set(data).where(eq(schema.shoppingCartItems.id, id)).returning();
    return item;
  }

  async deleteShoppingCartItem(id: string): Promise<void> {
    await db.delete(schema.shoppingCartItems).where(eq(schema.shoppingCartItems.id, id));
  }

  async createAmazonOrderRequest(data: InsertAmazonOrderRequest): Promise<AmazonOrderRequest> {
    const [request] = await db.insert(schema.amazonOrderRequests).values(data).returning();
    return request;
  }

  async getAmazonOrderRequests(userId: string): Promise<AmazonOrderRequest[]> {
    return db.select().from(schema.amazonOrderRequests).where(eq(schema.amazonOrderRequests.userId, userId)).orderBy(desc(schema.amazonOrderRequests.createdAt));
  }

  async updateAmazonOrderRequest(id: string, data: Partial<InsertAmazonOrderRequest>): Promise<AmazonOrderRequest | undefined> {
    const [request] = await db.update(schema.amazonOrderRequests).set(data).where(eq(schema.amazonOrderRequests.id, id)).returning();
    return request;
  }

  async getAmazonSettings(): Promise<AmazonSetting | undefined> {
    const [settings] = await db.select().from(schema.amazonSettings).limit(1);
    return settings;
  }

  async getEntertainmentEvents(): Promise<EntertainmentEvent[]> {
    return db.select().from(schema.entertainmentEvents).orderBy(desc(schema.entertainmentEvents.eventDate));
  }

  async createEntertainmentEvent(data: InsertEntertainmentEvent): Promise<EntertainmentEvent> {
    const [event] = await db.insert(schema.entertainmentEvents).values(data).returning();
    return event;
  }

  async updateEntertainmentEvent(id: string, data: Partial<InsertEntertainmentEvent>): Promise<EntertainmentEvent | undefined> {
    const [event] = await db.update(schema.entertainmentEvents).set({ ...data, updatedAt: new Date() }).where(eq(schema.entertainmentEvents.id, id)).returning();
    return event;
  }

  async deleteEntertainmentEvent(id: string): Promise<void> {
    await db.delete(schema.entertainmentEvents).where(eq(schema.entertainmentEvents.id, id));
  }

  async createEmailLog(data: InsertEmailLog): Promise<EmailLog> {
    const [log] = await db.insert(schema.emailLogs).values(data).returning();
    return log;
  }

  async getEmailLogs(limit = 100): Promise<EmailLog[]> {
    return db.select().from(schema.emailLogs).orderBy(desc(schema.emailLogs.sentAt)).limit(limit);
  }

  async createWhatsappDedup(data: InsertWhatsappDedup): Promise<WhatsappDedup> {
    const [dedup] = await db.insert(schema.whatsappDedup).values(data).returning();
    return dedup;
  }

  async createVoiceReply(data: InsertVoiceReply): Promise<VoiceReply> {
    const [reply] = await db.insert(schema.voiceReplies).values(data).returning();
    return reply;
  }

  async createNotionWebhookEvent(data: InsertNotionWebhookEvent): Promise<NotionWebhookEvent> {
    const [event] = await db.insert(schema.notionWebhookEvents).values(data).returning();
    return event;
  }

  async getNotionSyncConfigs(userId: string): Promise<NotionSyncConfig[]> {
    return db.select().from(schema.notionSyncConfig).where(eq(schema.notionSyncConfig.userId, userId));
  }

  async createNotionSyncConfig(data: InsertNotionSyncConfig): Promise<NotionSyncConfig> {
    const [config] = await db.insert(schema.notionSyncConfig).values(data).returning();
    return config;
  }

  async updateNotionSyncConfig(id: string, data: Partial<InsertNotionSyncConfig>): Promise<NotionSyncConfig | undefined> {
    const [config] = await db.update(schema.notionSyncConfig).set({ ...data, updatedAt: new Date() }).where(eq(schema.notionSyncConfig.id, id)).returning();
    return config;
  }

  async deleteNotionSyncConfig(id: string): Promise<void> {
    await db.delete(schema.notionSyncConfig).where(eq(schema.notionSyncConfig.id, id));
  }

  async getNotionCachedPages(): Promise<NotionCachedPage[]> {
    return db.select().from(schema.notionCachedPages);
  }

  async createNotionCachedPage(data: InsertNotionCachedPage): Promise<NotionCachedPage> {
    const [page] = await db.insert(schema.notionCachedPages).values(data).returning();
    return page;
  }

  async deleteNotionCachedPage(id: string): Promise<void> {
    await db.delete(schema.notionCachedPages).where(eq(schema.notionCachedPages.id, id));
  }

  async getHwCalendarConfigs(): Promise<HwCalendarConfig[]> {
    return db.select().from(schema.hwCalendarConfig);
  }

  async createHwCalendarConfig(data: InsertHwCalendarConfig): Promise<HwCalendarConfig> {
    const [config] = await db.insert(schema.hwCalendarConfig).values(data).returning();
    return config;
  }

  async updateHwCalendarConfig(id: string, data: Partial<InsertHwCalendarConfig>): Promise<HwCalendarConfig | undefined> {
    const update = { ...data, updatedAt: new Date() } as unknown as Partial<typeof schema.hwCalendarConfig.$inferInsert>;
    const [config] = await db.update(schema.hwCalendarConfig).set(update).where(eq(schema.hwCalendarConfig.id, id)).returning();
    return config;
  }

  async deleteHwCalendarConfig(id: string): Promise<void> {
    await db.delete(schema.hwCalendarConfig).where(eq(schema.hwCalendarConfig.id, id));
  }

  async getHwSchoolCalendars(): Promise<HwSchoolCalendar[]> {
    return db.select().from(schema.hwSchoolCalendars);
  }

  async createHwSchoolCalendar(data: InsertHwSchoolCalendar): Promise<HwSchoolCalendar> {
    const [calendar] = await db.insert(schema.hwSchoolCalendars).values(data).returning();
    return calendar;
  }

  async deleteHwSchoolCalendar(id: string): Promise<void> {
    await db.delete(schema.hwSchoolCalendars).where(eq(schema.hwSchoolCalendars.id, id));
  }

  async createActivityEvent(data: InsertActivityEvent): Promise<ActivityEvent> {
    const [event] = await db.insert(schema.activityEvents).values(data).returning();
    return event;
  }

  async getActivityEvents(limit = 100): Promise<ActivityEvent[]> {
    return db.select().from(schema.activityEvents).orderBy(desc(schema.activityEvents.occurredAt)).limit(limit);
  }

  async getMediaItems(): Promise<MediaItem[]> {
    return db.select().from(schema.mediaItems);
  }

  async createMediaItem(data: InsertMediaItem): Promise<MediaItem> {
    const [item] = await db.insert(schema.mediaItems).values(data).returning();
    return item;
  }

  async updateMediaItem(id: string, data: Partial<InsertMediaItem>): Promise<MediaItem | undefined> {
    const [item] = await db.update(schema.mediaItems).set(data).where(eq(schema.mediaItems.id, id)).returning();
    return item;
  }

  async deleteMediaItem(id: string): Promise<void> {
    await db.delete(schema.mediaItems).where(eq(schema.mediaItems.id, id));
  }

  async getSuggestions(): Promise<Suggestion[]> {
    return db.select().from(schema.suggestions).orderBy(desc(schema.suggestions.createdAt));
  }

  async createSuggestion(data: InsertSuggestion): Promise<Suggestion> {
    const [suggestion] = await db.insert(schema.suggestions).values(data).returning();
    return suggestion;
  }

  async updateSuggestion(id: string, data: Partial<InsertSuggestion>): Promise<Suggestion | undefined> {
    const [suggestion] = await db.update(schema.suggestions).set(data).where(eq(schema.suggestions.id, id)).returning();
    return suggestion;
  }

  async deleteSuggestion(id: string): Promise<void> {
    await db.delete(schema.suggestions).where(eq(schema.suggestions.id, id));
  }

  async getUserPlatformCredentials(userId: string): Promise<UserPlatformCredential[]> {
    return db.select().from(schema.userPlatformCredentials).where(eq(schema.userPlatformCredentials.userId, userId));
  }

  async createUserPlatformCredential(data: InsertUserPlatformCredential): Promise<UserPlatformCredential> {
    const [credential] = await db.insert(schema.userPlatformCredentials).values(data).returning();
    return credential;
  }

  async updateUserPlatformCredential(id: string, data: Partial<InsertUserPlatformCredential>): Promise<UserPlatformCredential | undefined> {
    const [credential] = await db.update(schema.userPlatformCredentials).set({ ...data, updatedAt: new Date() }).where(eq(schema.userPlatformCredentials.id, id)).returning();
    return credential;
  }

  async deleteUserPlatformCredential(id: string): Promise<void> {
    await db.delete(schema.userPlatformCredentials).where(eq(schema.userPlatformCredentials.id, id));
  }

  async getVerkadaAlertLogs(limit = 100): Promise<VerkadaAlertLog[]> {
    return db.select().from(schema.verkadaAlertLog).orderBy(desc(schema.verkadaAlertLog.sentAt)).limit(limit);
  }

  async createVerkadaAlertLog(data: InsertVerkadaAlertLog): Promise<VerkadaAlertLog> {
    const [log] = await db.insert(schema.verkadaAlertLog).values(data).returning();
    return log;
  }

  async getDeviceOverrides(): Promise<DeviceOverride[]> {
    return db.select().from(schema.deviceOverrides);
  }

  async getDeviceOverrideByMac(mac: string): Promise<DeviceOverride | undefined> {
    const [row] = await db.select().from(schema.deviceOverrides).where(eq(schema.deviceOverrides.mac, mac)).limit(1);
    return row;
  }

  async upsertDeviceOverride(data: InsertDeviceOverride): Promise<DeviceOverride> {
    const [row] = await db
      .insert(schema.deviceOverrides)
      .values({ ...data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.deviceOverrides.mac,
        set: {
          customName: data.customName,
          customCategory: data.customCategory,
          customSubcategory: data.customSubcategory,
          originalHostname: data.originalHostname,
          owner: data.owner,
          trusted: data.trusted,
          isRandom: data.isRandom,
          lastSeen: data.lastSeen,
          notes: data.notes,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async deleteDeviceOverride(mac: string): Promise<void> {
    await db.delete(schema.deviceOverrides).where(eq(schema.deviceOverrides.mac, mac));
  }

  async getValveLabelPositions(): Promise<ValveLabelPosition[]> {
    return db.select().from(schema.valveLabelPositions);
  }

  async upsertValveLabelPosition(data: InsertValveLabelPosition): Promise<ValveLabelPosition> {
    const [row] = await db
      .insert(schema.valveLabelPositions)
      .values({ ...data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.valveLabelPositions.svgId,
        set: { x: data.x, y: data.y, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async deleteValveLabelPosition(svgId: string): Promise<void> {
    await db.delete(schema.valveLabelPositions).where(eq(schema.valveLabelPositions.svgId, svgId));
  }

  async getIrrigationZoneNames(): Promise<IrrigationZoneName[]> {
    return db.select().from(schema.irrigationZoneNames);
  }

  async upsertIrrigationZoneName(data: InsertIrrigationZoneName): Promise<IrrigationZoneName> {
    const [row] = await db
      .insert(schema.irrigationZoneNames)
      .values({ ...data, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.irrigationZoneNames.svgId,
        set: { name: data.name, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  async deleteIrrigationZoneName(svgId: string): Promise<void> {
    await db.delete(schema.irrigationZoneNames).where(eq(schema.irrigationZoneNames.svgId, svgId));
  }
}

export const storage = new DatabaseStorage() as DatabaseStorage & {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount: number | null }>;
};

(storage as any).query = async (text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }> => {
  const result = await pool.query(text, params);
  return { rows: result.rows, rowCount: result.rowCount };
};
