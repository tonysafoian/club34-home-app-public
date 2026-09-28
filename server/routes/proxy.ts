import type { Request, Response } from "express";
import { Router } from "express";
import { requireAuth } from "../auth";
import { getServiceClient } from "../utils/supabase";

const router = Router();

const SENSITIVE_TABLES = new Set([
  "google_tokens",
  "platform_credentials",
  "user_platform_credentials",
  "system_prompts",
  "janus_system_prompts",
  "tesla_tokens",
]);

function isAdmin(req: Request): boolean {
  return !!(req as any).user?.roles?.includes("admin");
}

function checkTableAccess(table: string, req: Request, res: Response): boolean {
  if (SENSITIVE_TABLES.has(table) && !isAdmin(req)) {
    res.status(403).json({ error: `Access to table '${table}' requires admin privileges` });
    return false;
  }
  return true;
}

const ALLOWED_TABLES = new Set([
  "profiles",
  "user_roles",
  "notion_sync_config",
  "notion_cached_pages",
  "notion_webhook_events",
  "system_updates",
  "activity_events",
  "system_audit_log",
  "janus_projects",
  "janus_project_artifacts",
  "poi_profiles",
  "poi_sightings",
  // home_assistant_settings intentionally NOT allowed: it stores each user's
  // encrypted HA token, and generic read/write access would let any user read
  // ciphertext or repoint another user's ha_url to exfiltrate their token.
  // All access goes through /api/home-assistant (get-settings / save-settings /
  // disconnect), scoped to the authenticated user.
  "amazon_settings",
  "amazon_order_requests",
  "trips",
  "suggestions",
  "failed_jobs",
  "invited_emails",
  "entertainment_events",
  "household_members",
  "janus_notifications",
  "janus_chat_logs",
  "email_logs",
  "family_automations",
  "family_automation_logs",
  "google_tokens",
  "hw_calendar_config",
  "hw_school_calendars",
  "janus_access_rules",
  "janus_group_configs",
  "janus_skills",
  "janus_system_prompts",
  "platform_credentials",
  "tesla_battery_alerts",
  "tesla_tokens",
  "enter_exit_log",
  "outsider_interaction_logs",
  "janus_project_shares",
  "system_prompts",
  "tesla_activity_logs",
  "user_platform_credentials",
  "media_items",
  "janus_health_logs",
  "speed_tests",
  "thermostat_logs",
]);

router.post("/api/db/query", requireAuth, async (req, res) => {
  try {
    const { table, select, filters, order, limit, offset, single } = req.body;

    if (!table || !ALLOWED_TABLES.has(table)) {
      res.status(400).json({ error: `Table '${table}' is not allowed` });
      return;
    }

    if (!checkTableAccess(table, req, res)) return;

    if (table === 'entertainment_events') {
      console.log(`[DB Proxy] entertainment_events query - filters: ${JSON.stringify(filters)}, order: ${JSON.stringify(order)}, limit: ${limit}`);
    }

    const supabase = getServiceClient();
    let query = supabase.from(table).select(select || "*");

    if (filters && Array.isArray(filters)) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
        else if (f.op === "neq") query = query.neq(f.column, f.value);
        else if (f.op === "gt") query = query.gt(f.column, f.value);
        else if (f.op === "gte") query = query.gte(f.column, f.value);
        else if (f.op === "lt") query = query.lt(f.column, f.value);
        else if (f.op === "lte") query = query.lte(f.column, f.value);
        else if (f.op === "like") query = query.like(f.column, f.value);
        else if (f.op === "ilike") query = query.ilike(f.column, f.value);
        else if (f.op === "is") query = query.is(f.column, f.value);
        else if (f.op === "in") query = query.in(f.column, f.value);
        else if (f.op === "contains") query = query.contains(f.column, f.value);
        else if (f.op === "containedBy") query = query.containedBy(f.column, f.value);
      }
    }

    if (order) {
      if (Array.isArray(order)) {
        for (const o of order) {
          query = query.order(o.column, { ascending: o.ascending ?? true, nullsFirst: o.nullsFirst });
        }
      } else {
        query = query.order(order.column, { ascending: order.ascending ?? true, nullsFirst: order.nullsFirst });
      }
    }

    if (limit) query = query.limit(limit);
    if (typeof offset === 'number' && limit) {
      query = query.range(offset, offset + limit - 1);
    }

    if (single) {
      const { data, error } = await query.single();
      if (error) {
        res.status(error.code === "PGRST116" ? 404 : 400).json({ error: error.message });
        return;
      }
      res.json({ data });
    } else {
      const result = req.body.count
        ? await (query as any).select(select || "*", { count: "exact", head: req.body.head })
        : await query;

      if (result.error) {
        res.status(400).json({ error: result.error.message });
        return;
      }
      res.json({ data: result.data, count: (result as any).count });
    }
  } catch (err: any) {
    console.error("[DB Proxy] query error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.post("/api/db/count", requireAuth, async (req, res) => {
  try {
    const { table, filters } = req.body;

    if (!table || !ALLOWED_TABLES.has(table)) {
      res.status(400).json({ error: `Table '${table}' is not allowed` });
      return;
    }

    if (!checkTableAccess(table, req, res)) return;

    const supabase = getServiceClient();
    let query = supabase.from(table).select("*", { count: "exact", head: true });

    if (filters && Array.isArray(filters)) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
        else if (f.op === "in") query = query.in(f.column, f.value);
        else if (f.op === "gte") query = query.gte(f.column, f.value);
        else if (f.op === "lte") query = query.lte(f.column, f.value);
        else if (f.op === "is") query = query.is(f.column, f.value);
      }
    }

    const { count, error } = await query;
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ count: count ?? 0 });
  } catch (err: any) {
    console.error("[DB Proxy] count error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.post("/api/db/insert", requireAuth, async (req, res) => {
  try {
    const { table, data: insertData, returnData } = req.body;

    if (!table || !ALLOWED_TABLES.has(table)) {
      res.status(400).json({ error: `Table '${table}' is not allowed` });
      return;
    }

    if (!checkTableAccess(table, req, res)) return;

    const supabase = getServiceClient();
    let query = supabase.from(table).insert(insertData);

    if (returnData !== false) {
      query = query.select();
    }

    const { data, error } = await query;
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ data });
  } catch (err: any) {
    console.error("[DB Proxy] insert error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.post("/api/db/update", requireAuth, async (req, res) => {
  try {
    const { table, data: updateData, filters } = req.body;

    if (!table || !ALLOWED_TABLES.has(table)) {
      res.status(400).json({ error: `Table '${table}' is not allowed` });
      return;
    }

    if (!checkTableAccess(table, req, res)) return;

    // Field-level guard: family_automations.config drives automation behavior
    // (e.g. the light-timer exclusion lists) and is admin-editable only.
    // Members may still toggle is_active (vacation mode) through this proxy;
    // config writes go through scoped admin routes like PUT /api/energy/exclusions.
    if (
      table === "family_automations" &&
      updateData && typeof updateData === "object" && !Array.isArray(updateData) &&
      Object.prototype.hasOwnProperty.call(updateData, "config") &&
      !isAdmin(req)
    ) {
      res.status(403).json({ error: "Updating family_automations.config requires admin privileges" });
      return;
    }

    const supabase = getServiceClient();
    let query = supabase.from(table).update(updateData);

    if (filters && Array.isArray(filters)) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
        else if (f.op === "in") query = query.in(f.column, f.value);
      }
    }

    const { error } = await query;
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("[DB Proxy] update error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.post("/api/db/delete", requireAuth, async (req, res) => {
  try {
    const { table, filters } = req.body;

    if (!table || !ALLOWED_TABLES.has(table)) {
      res.status(400).json({ error: `Table '${table}' is not allowed` });
      return;
    }

    if (!checkTableAccess(table, req, res)) return;

    const supabase = getServiceClient();
    let query = supabase.from(table).delete();

    if (filters && Array.isArray(filters)) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
      }
    }

    const { error } = await query;
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error("[DB Proxy] delete error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

router.post("/api/db/maybeSingle", requireAuth, async (req, res) => {
  try {
    const { table, select, filters, order, limit } = req.body;

    if (!table || !ALLOWED_TABLES.has(table)) {
      res.status(400).json({ error: `Table '${table}' is not allowed` });
      return;
    }

    if (!checkTableAccess(table, req, res)) return;

    const supabase = getServiceClient();
    let query = supabase.from(table).select(select || "*");

    if (filters && Array.isArray(filters)) {
      for (const f of filters) {
        if (f.op === "eq") query = query.eq(f.column, f.value);
        else if (f.op === "in") query = query.in(f.column, f.value);
        else if (f.op === "is") query = query.is(f.column, f.value);
      }
    }

    if (order) {
      query = query.order(order.column, { ascending: order.ascending ?? true });
    }

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query.maybeSingle();
    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json({ data });
  } catch (err: any) {
    console.error("[DB Proxy] maybeSingle error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

const LOCAL_FUNCTION_MAP: Record<string, string> = {
  'home-assistant-proxy': '/api/home-assistant',
  'verkada-proxy': '/api/verkada',
  'iaqualink-proxy': '/api/pool',
  'tesla-proxy': '/api/tesla',
  'tesla-setup': '/api/tesla/setup',
  'generac-proxy': '/api/generac',
};

router.post("/api/functions/invoke", requireAuth, async (req, res) => {
  try {
    const { functionName, body: fnBody } = req.body;
    if (!functionName) {
      res.status(400).json({ error: "functionName is required" });
      return;
    }

    const localPath = LOCAL_FUNCTION_MAP[functionName];
    if (localPath) {
      const protocol = req.protocol;
      const host = req.get('host');
      const localUrl = `${protocol}://${host}${localPath}`;
      const token = req.headers.authorization;
      const localRes = await fetch(localUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: token } : {}),
        },
        body: JSON.stringify(fnBody || {}),
      });
      const data = await localRes.json();
      res.status(localRes.status).json(data);
      return;
    }

    const supabase = getServiceClient();
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: fnBody || {},
    });

    if (error) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.json(data);
  } catch (err: any) {
    console.error("[DB Proxy] functions.invoke error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

export default router;
