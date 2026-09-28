import { Router } from "express";
import { requireAuth, requireRole } from "../auth";
import { storage } from "../storage";
import { logAudit } from "../lib/auditLog.js";

const router = Router();

const COLUMN_ALLOWLIST = /^[a-z_][a-z0-9_]*$/;

const ALLOWED_PROXY_TABLES = [
  "email_logs", "poi_sightings", "poi_profiles", "system_updates",
  "profiles", "user_roles", "invited_emails", "system_prompts",
  "janus_project_shares", "trips",
  "suggestions", "household_members", "notification_group_configs",
  "failed_jobs", "speed_tests", "entertainment_events", "media_items",
  "verkada_alert_log", "system_audit_log", "activity_events",
  "janus_chat_logs", "janus_projects", "janus_project_artifacts",
  "outsider_activity_logs", "amazon_order_requests", "amazon_settings",
  "notion_sync_config", "notion_cached_pages", "tesla_battery_logs",
  "whatsapp_dedup", "shopping_cart_items", "hw_calendar_config",
  "hw_school_calendars", "notion_webhook_events", "voice_replies",
  "grocery_order_requests", "tesla_activity_logs", "tesla_battery_alerts",
  "janus_group_configs", "janus_health_logs", "janus_functional_test_logs",
  // home_assistant_settings deliberately excluded — holds per-user encrypted
  // HA tokens; use the scoped /api/home-assistant actions instead.
  "family_automations", "family_automation_logs",
  "janus_chat_summaries", "janus_memory", "janus_notifications",
  "janus_reminders",
];

router.get("/api/data/email-logs", requireAuth, async (req, res) => {
  try {
    const logs = await storage.getEmailLogs(100);
    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/poi-sightings", requireAuth, async (req, res) => {
  try {
    const logs = await storage.getVerkadaAlertLogs(200);
    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/poi-profiles", requireAuth, async (req, res) => {
  try {
    const q = (storage as any).query;
    const { rows } = await q("SELECT * FROM poi_profiles ORDER BY label ASC");
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/system-updates", requireAuth, async (req, res) => {
  try {
    const updates = await storage.getSystemUpdates(50);
    res.json(updates);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/data/system-updates", requireRole("admin"), async (req: any, res) => {
  try {
    const update = await storage.createSystemUpdate(req.body);
    logAudit("data-admin", {
      category: "config", event_type: "system_update_created", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin created system update: "${req.body.title || 'untitled'}"`,
      detail: { title: req.body.title, version: req.body.version }, status: "success",
    });
    res.json(update);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/system-updates/:id", requireRole("admin"), async (req: any, res) => {
  try {
    const q = (storage as any).query;
    const fields = req.body;
    const setClauses: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      setClauses.push(`${key} = $${i}`);
      values.push(val);
      i++;
    }
    values.push(req.params.id);
    await q(`UPDATE system_updates SET ${setClauses.join(", ")} WHERE id = $${i}`, values);
    logAudit("data-admin", {
      category: "config", event_type: "system_update_edited", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin edited system update #${req.params.id}`,
      detail: { id: req.params.id, fields: Object.keys(fields) }, status: "success",
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/system-updates/:id", requireRole("admin"), async (req: any, res) => {
  try {
    await storage.deleteSystemUpdate(req.params.id);
    logAudit("data-admin", {
      category: "config", event_type: "system_update_deleted", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin deleted system update #${req.params.id}`,
      detail: { id: req.params.id }, status: "success",
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/users", requireRole("admin"), async (req, res) => {
  try {
    const q = (storage as any).query;
    const [{ rows: profiles }, { rows: roles }] = await Promise.all([
      q("SELECT id, user_id, display_name, avatar_url, approval_status, created_at FROM profiles ORDER BY created_at DESC LIMIT 200"),
      q("SELECT user_id, role FROM user_roles"),
    ]);
    const usersWithRoles = profiles.map((p: any) => ({
      ...p,
      role: roles.find((r: any) => r.user_id === p.user_id)?.role,
    }));
    res.json(usersWithRoles);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/users/:userId/approval", requireRole("admin"), async (req: any, res) => {
  try {
    await storage.updateProfile(req.params.userId, { approvalStatus: req.body.approval_status });
    logAudit("data-admin", {
      category: "config", event_type: "user_approval_updated", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin set user ${req.params.userId} approval to "${req.body.approval_status}"`,
      detail: { target_user_id: req.params.userId, approval_status: req.body.approval_status }, status: "success",
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/invited-emails", requireRole("admin"), async (req, res) => {
  try {
    const q = (storage as any).query;
    const { rows } = await q("SELECT * FROM invited_emails ORDER BY created_at DESC");
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/data/invited-emails", requireRole("admin"), async (req: any, res) => {
  try {
    const result = await storage.createInvitedEmail({
      email: req.body.email,
      invitedBy: req.user?.userId || "unknown",
      phoneNumber: req.body.phone_number || null,
    });
    logAudit("data-admin", {
      category: "config", event_type: "user_invited", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin invited ${req.body.email} to Janus`,
      detail: { email: req.body.email }, status: "success",
    });
    res.json(result);
  } catch (e: any) {
    if (e.message?.includes("duplicate")) {
      res.status(409).json({ error: "This email has already been invited." });
    } else {
      res.status(500).json({ error: e.message });
    }
  }
});

router.delete("/api/data/invited-emails/:id", requireRole("admin"), async (req: any, res) => {
  try {
    const q = (storage as any).query;
    await q("DELETE FROM invited_emails WHERE id = $1", [req.params.id]);
    logAudit("data-admin", {
      category: "config", event_type: "invite_removed", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin removed invited email #${req.params.id}`,
      detail: { id: req.params.id }, status: "success",
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/system-prompts", requireAuth, async (req, res) => {
  try {
    const prompts = await storage.getAllSystemPrompts();
    res.json(prompts);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/data/system-prompts", requireRole("admin"), async (req: any, res) => {
  try {
    const prompt = await storage.upsertSystemPrompt(req.body);
    logAudit("data-admin", {
      category: "config", event_type: "system_prompt_upserted", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin updated system prompt: "${req.body.name || req.body.context_key || 'unknown'}"`,
      detail: { name: req.body.name, context_key: req.body.context_key, content_length: req.body.content?.length }, status: "success",
    });
    res.json(prompt);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/system-prompts/:id", requireRole("admin"), async (req: any, res) => {
  try {
    const q = (storage as any).query;
    const fields = req.body;
    const setClauses: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      setClauses.push(`${key} = $${i}`);
      values.push(val);
      i++;
    }
    values.push(req.params.id);
    await q(`UPDATE system_prompts SET ${setClauses.join(", ")}, updated_at = NOW() WHERE id = $${i}`, values);
    logAudit("data-admin", {
      category: "config", event_type: "system_prompt_edited", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin edited system prompt #${req.params.id}`,
      detail: { id: req.params.id, context_key: fields.context_key, fields: Object.keys(fields) }, status: "success",
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/system-prompts/:id", requireRole("admin"), async (req: any, res) => {
  try {
    const q = (storage as any).query;
    await q("DELETE FROM system_prompts WHERE id = $1", [req.params.id]);
    logAudit("data-admin", {
      category: "config", event_type: "system_prompt_deleted", severity: "warn",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin deleted system prompt #${req.params.id}`,
      detail: { id: req.params.id }, status: "success",
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/suggestions", requireAuth, async (req, res) => {
  try {
    const suggestions = await storage.getSuggestions();
    res.json(suggestions);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/suggestions/mine", requireAuth, async (req, res) => {
  try {
    const q = (storage as any).query;
    const { rows } = await q("SELECT * FROM suggestions WHERE user_id = $1 ORDER BY created_at DESC", [req.user!.userId]);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/suggestions/:id", requireRole("admin"), async (req, res) => {
  try {
    const result = await storage.updateSuggestion(String(req.params.id), req.body);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/platform-credentials", requireAuth, async (req, res) => {
  try {
    const creds = await storage.getUserPlatformCredentials(req.user!.userId);
    res.json(creds);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/platform-credentials/:id", requireAuth, async (req, res) => {
  try {
    await storage.deleteUserPlatformCredential(String(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/trips", requireAuth, async (req, res) => {
  try {
    const q = (storage as any).query;
    const { rows } = await q("SELECT * FROM trips WHERE deleted_at IS NULL ORDER BY departure_date ASC NULLS LAST");
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/trips/:id", requireAuth, async (req, res) => {
  try {
    const result = await storage.updateTrip(String(req.params.id), req.body);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/trips/:id", requireAuth, async (req, res) => {
  try {
    await storage.deleteTrip(String(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/project-shares/:projectId", requireAuth, async (req, res) => {
  try {
    const q = (storage as any).query;
    const [{ rows: users }, { rows: shares }] = await Promise.all([
      q("SELECT user_id, display_name FROM profiles WHERE approval_status = 'approved'"),
      q("SELECT id, shared_with_user_id FROM janus_project_shares WHERE project_id = $1", [req.params.projectId]),
    ]);
    const enrichedShares = shares.map((s: any) => ({
      ...s,
      display_name: users.find((u: any) => u.user_id === s.shared_with_user_id)?.display_name || "Unknown",
    }));
    res.json({ users, shares: enrichedShares });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/data/project-shares/:projectId", requireAuth, async (req, res) => {
  try {
    await storage.createJanusProjectShare({
      projectId: String(req.params.projectId),
      sharedWithUserId: req.body.shared_with_user_id,
      sharedByUserId: req.user!.userId,
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/project-shares/revoke/:id", requireAuth, async (req, res) => {
  try {
    await storage.deleteJanusProjectShare(String(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/failed-jobs", requireRole("admin"), async (req, res) => {
  try {
    const status = (req.query.status as string) || undefined;
    const jobs = await storage.getFailedJobs(status);
    res.json(jobs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/failed-jobs/:id", requireRole("admin"), async (req, res) => {
  try {
    const result = await storage.updateFailedJob(String(req.params.id), req.body);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/failed-jobs/:id", requireRole("admin"), async (req, res) => {
  try {
    await storage.deleteFailedJob(String(req.params.id));
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/household-members", requireAuth, async (req, res) => {
  try {
    const members = await storage.getHouseholdMembers();
    res.json(members);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/data/household-members", requireRole("admin"), async (req: any, res) => {
  try {
    const member = await storage.createHouseholdMember(req.body);
    logAudit("data-admin", {
      category: "home", event_type: "household_member_created", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin added household member: "${req.body.name || req.body.display_name || 'unknown'}"`,
      detail: { name: req.body.name || req.body.display_name, email: req.body.email }, status: "success",
    });
    res.json(member);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/household-members/:id", requireRole("admin"), async (req: any, res) => {
  try {
    const result = await storage.updateHouseholdMember(req.params.id, req.body);
    logAudit("data-admin", {
      category: "home", event_type: "household_member_updated", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin updated household member #${req.params.id}`,
      detail: { id: req.params.id, changes: Object.keys(req.body) }, status: "success",
    });
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/household-members/:id", requireRole("admin"), async (req: any, res) => {
  try {
    await storage.deleteHouseholdMember(req.params.id);
    logAudit("data-admin", {
      category: "home", event_type: "household_member_deleted", severity: "info",
      actor_id: req.user?.userId || "UNKNOWN", actor_name: req.user?.displayName || req.user?.email || "UNKNOWN", actor_role: "admin",
      channel: "web", summary: `Admin removed household member #${req.params.id}`,
      detail: { id: req.params.id }, status: "success",
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/group-configs", requireAuth, async (req, res) => {
  try {
    const q = (storage as any).query;
    const { rows } = await q("SELECT * FROM notification_group_configs ORDER BY group_name ASC");
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/data/group-configs", requireRole("admin"), async (req, res) => {
  try {
    const q = (storage as any).query;
    const { rows } = await q(
      "INSERT INTO notification_group_configs (group_name, description, channel_preferences, members) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.body.group_name, req.body.description, JSON.stringify(req.body.channel_preferences || {}), JSON.stringify(req.body.members || [])]
    );
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/group-configs/:id", requireRole("admin"), async (req, res) => {
  try {
    const q = (storage as any).query;
    const fields = req.body;
    const setClauses: string[] = [];
    const values: any[] = [];
    let i = 1;
    for (const [key, val] of Object.entries(fields)) {
      setClauses.push(`${key} = $${i}`);
      values.push(typeof val === "object" ? JSON.stringify(val) : val);
      i++;
    }
    values.push(req.params.id);
    const { rows } = await q(`UPDATE notification_group_configs SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, values);
    res.json(rows[0]);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.delete("/api/data/group-configs/:id", requireRole("admin"), async (req, res) => {
  try {
    const q = (storage as any).query;
    await q("DELETE FROM notification_group_configs WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/activity-events", requireAuth, async (req, res) => {
  try {
    const events = await storage.getActivityEvents(Number(req.query.limit) || 100);
    res.json(events);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/speed-tests", requireAuth, async (req, res) => {
  try {
    const tests = await storage.getSpeedTests(Number(req.query.limit) || 50);
    res.json(tests);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/entertainment-events", requireAuth, async (req, res) => {
  try {
    const events = await storage.getEntertainmentEvents();
    res.json(events);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/media-items", requireAuth, async (req, res) => {
  try {
    const items = await storage.getMediaItems();
    res.json(items);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/verkada-alert-logs", requireAuth, async (req, res) => {
  try {
    const logs = await storage.getVerkadaAlertLogs(Number(req.query.limit) || 100);
    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/system-audit-logs", requireRole("admin"), async (req, res) => {
  try {
    const logs = await storage.getSystemAuditLogs(Number(req.query.limit) || 100);
    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/api/data/system-audit-logs/query", requireRole("admin"), async (req, res) => {
  try {
    const { category, severity, since, search, limit = 50, offset = 0 } = req.body;
    console.log(`[audit-logs] POST /api/data/system-audit-logs/query user=${req.user?.email || 'unknown'} category=${category} severity=${severity} limit=${limit} offset=${offset}`);
    const result = await storage.querySystemAuditLogs({ category, severity, since, search, limit, offset });
    console.log(`[audit-logs] Returning ${result.rows.length} rows, total=${result.count}`);
    res.json(result);
  } catch (e: any) {
    console.error(`[audit-logs] Error:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Per-endpoint External API latency stats (avg/p95/calls/errors), aggregated
// in SQL over the full window so high call volumes can't skew the numbers.
router.get("/api/data/external-api/endpoint-stats", requireRole("admin"), async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
    const topN = Math.min(Math.max(Number(req.query.top) || 5, 1), 25);
    const stats = await storage.getExternalApiEndpointStats(hours, topN);
    res.json({ hours, stats });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get("/api/data/janus-chat-logs", requireAuth, async (req, res) => {
  try {
    const logs = await storage.getJanusChatLogs(req.user!.userId, Number(req.query.limit) || 50);
    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/profiles/me", requireAuth, async (req, res) => {
  try {
    const profile = await storage.getProfileByUserId(req.user!.userId);
    res.json(profile || null);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.patch("/api/data/profiles/me", requireAuth, async (req, res) => {
  try {
    const result = await storage.updateProfile(req.user!.userId, req.body);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/api/data/query", requireAuth, async (req, res) => {
  const table = req.query.table as string;
  const limit = Number(req.query.limit) || 100;
  const orderBy = (req.query.orderBy as string) || "created_at";
  const orderDir = (req.query.orderDir as string) || "DESC";

  const allowedTables = ALLOWED_PROXY_TABLES;

  if (!table || !allowedTables.includes(table)) {
    res.status(400).json({ error: "Invalid table" });
    return;
  }

  const validOrder = ["ASC", "DESC"].includes(orderDir.toUpperCase()) ? orderDir.toUpperCase() : "DESC";
  const safeOrderBy = COLUMN_ALLOWLIST.test(orderBy) ? orderBy : "created_at";
  try {
    const q = (storage as any).query;
    const { rows } = await q(`SELECT * FROM ${table} ORDER BY ${safeOrderBy} ${validOrder} LIMIT $1`, [limit]);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});



router.post("/api/data/proxy", requireAuth, async (req, res) => {
  const { table, method, columns, filters, orderColumn, orderAsc, orderNullsFirst, limit, single, body: payload } = req.body;

  if (!table || !ALLOWED_PROXY_TABLES.includes(table)) {
    res.status(400).json({ error: "Invalid table" });
    return;
  }

  const q = (storage as any).query;

  try {
    if (method === "select") {
      let safeColumns = "*";
      if (columns && columns !== "*") {
        safeColumns = columns.split(",").map((c: string) => c.trim()).filter((c: string) => COLUMN_ALLOWLIST.test(c)).join(", ") || "*";
      }
      let sql = `SELECT ${safeColumns} FROM ${table}`;
      const params: any[] = [];
      let paramIdx = 1;

      if (filters && filters.length > 0) {
        const whereClauses: string[] = [];
        for (const f of filters) {
          if (!COLUMN_ALLOWLIST.test(f.column)) continue;
          if (f.op === "eq") {
            whereClauses.push(`${f.column} = $${paramIdx}`);
            params.push(f.value);
            paramIdx++;
          } else if (f.op === "neq") {
            whereClauses.push(`${f.column} != $${paramIdx}`);
            params.push(f.value);
            paramIdx++;
          } else if (f.op === "gt") {
            whereClauses.push(`${f.column} > $${paramIdx}`);
            params.push(f.value);
            paramIdx++;
          } else if (f.op === "gte") {
            whereClauses.push(`${f.column} >= $${paramIdx}`);
            params.push(f.value);
            paramIdx++;
          } else if (f.op === "lt") {
            whereClauses.push(`${f.column} < $${paramIdx}`);
            params.push(f.value);
            paramIdx++;
          } else if (f.op === "lte") {
            whereClauses.push(`${f.column} <= $${paramIdx}`);
            params.push(f.value);
            paramIdx++;
          } else if (f.op === "is") {
            if (f.value === null) {
              whereClauses.push(`${f.column} IS NULL`);
            } else {
              whereClauses.push(`${f.column} IS $${paramIdx}`);
              params.push(f.value);
              paramIdx++;
            }
          } else if (f.op === "in") {
            const placeholders = f.value.map((_: any, idx: number) => `$${paramIdx + idx}`);
            whereClauses.push(`${f.column} IN (${placeholders.join(", ")})`);
            params.push(...f.value);
            paramIdx += f.value.length;
          } else if (f.op === "ilike") {
            whereClauses.push(`${f.column} ILIKE $${paramIdx}`);
            params.push(f.value);
            paramIdx++;
          } else if (f.op === "contains") {
            whereClauses.push(`${f.column} @> $${paramIdx}`);
            params.push(JSON.stringify(f.value));
            paramIdx++;
          }
        }
        if (whereClauses.length > 0) {
          sql += ` WHERE ${whereClauses.join(" AND ")}`;
        }
      }

      if (orderColumn && COLUMN_ALLOWLIST.test(orderColumn)) {
        const dir = orderAsc ? "ASC" : "DESC";
        const nulls = orderNullsFirst === true ? "NULLS FIRST" : orderNullsFirst === false ? "NULLS LAST" : "";
        sql += ` ORDER BY ${orderColumn} ${dir} ${nulls}`.trim();
      }

      if (limit) {
        sql += ` LIMIT $${paramIdx}`;
        params.push(limit);
      }

      const { rows } = await q(sql, params);
      res.json(rows);
    } else if (method === "insert") {
      const data = Array.isArray(payload) ? payload[0] : payload;
      const keys = Object.keys(data).filter(k => COLUMN_ALLOWLIST.test(k));
      const values = keys.map(k => data[k]);
      const placeholders = keys.map((_, i) => `$${i + 1}`);
      const { rows } = await q(
        `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`,
        values
      );
      res.json(rows);
    } else if (method === "update") {
      const data = payload;
      const dataKeys = Object.keys(data).filter(k => COLUMN_ALLOWLIST.test(k));
      const setClauses: string[] = [];
      const params: any[] = [];
      let idx = 1;
      for (const key of dataKeys) {
        setClauses.push(`${key} = $${idx}`);
        params.push(data[key]);
        idx++;
      }

      let sql = `UPDATE ${table} SET ${setClauses.join(", ")}`;

      if (filters && filters.length > 0) {
        const whereClauses: string[] = [];
        for (const f of filters) {
          if (!COLUMN_ALLOWLIST.test(f.column)) continue;
          if (f.op === "eq") {
            whereClauses.push(`${f.column} = $${idx}`);
            params.push(f.value);
            idx++;
          }
        }
        if (whereClauses.length > 0) {
          sql += ` WHERE ${whereClauses.join(" AND ")}`;
        }
      }

      sql += " RETURNING *";
      const { rows } = await q(sql, params);
      res.json(rows);
    } else if (method === "upsert") {
      const data = Array.isArray(payload) ? payload[0] : payload;
      const keys = Object.keys(data).filter(k => COLUMN_ALLOWLIST.test(k));
      const values = keys.map(k => data[k]);
      const placeholders = keys.map((_, i) => `$${i + 1}`);
      const nonIdKeys = keys.filter(k => k !== "id");
      const updateClauses = nonIdKeys.map(k => `${k} = EXCLUDED.${k}`);
      const conflictCol = keys.includes("id") ? "id" : keys[0];
      const { rows } = await q(
        `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT (${conflictCol}) DO UPDATE SET ${updateClauses.join(", ")} RETURNING *`,
        values
      );
      res.json(rows);
    } else if (method === "delete") {
      let sql = `DELETE FROM ${table}`;
      const params: any[] = [];
      let idx = 1;

      if (filters && filters.length > 0) {
        const whereClauses: string[] = [];
        for (const f of filters) {
          if (!COLUMN_ALLOWLIST.test(f.column)) continue;
          if (f.op === "eq") {
            whereClauses.push(`${f.column} = $${idx}`);
            params.push(f.value);
            idx++;
          }
        }
        if (whereClauses.length > 0) {
          sql += ` WHERE ${whereClauses.join(" AND ")}`;
        }
      }

      sql += " RETURNING *";
      const { rows } = await q(sql, params);
      res.json(rows);
    } else {
      res.status(400).json({ error: "Invalid method" });
    }
  } catch (e: any) {
    console.error(`[DATA PROXY] Error on ${table}.${method}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
