import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import Ajv, { type ErrorObject } from "ajv";
import { logAudit } from "../lib/auditLog.js";
import { checkRateLimit } from "../lib/rateLimiter.js";
import { storage } from "../storage.js";
import { getServiceClient } from "../utils/supabase.js";
import {
  callHAProxy,
  executeHAGetStates,
  executeHAGetState,
  executeHACallService,
  executeHAGetLogbook,
  executeCheckTeslaStatus,
  executeCheckVerkadaSecurity,
  executeCheckGeneratorStatus,
} from "../utils/tools/home-automation.js";
import {
  callCalendarProxy,
  executeGetCalendarEvents,
  executeCreateCalendarEvent,
  executeDeleteCalendarEvent,
} from "../utils/tools/calendar-maps.js";
import {
  sendGmailRaw,
  getSaKey,
  sendWhatsAppTo,
  getBroadcastFallbackPhone,
} from "../lib/helpers.js";
import { ALL_TOOLS, executeTool } from "../handlers/chat.js";
import { getMorningSpeakers } from "./broadcast.js";
import { getZoneFlow } from "../lib/irrigationFlow.js";
import type { RequestContext } from "../utils/tools/media-trips.js";
import { fortigateRequest } from "./fortigate.js";
import { getIaqualinkSession, iaqualinkSimpleGet } from "./pool.js";

const router = Router();

const SOURCE = "external_api";
const CHANNEL = "external_api";
const ACTOR_ID = "external_api";
const RATE_LIMIT = { maxRequests: 60, windowMs: 60_000 };
const MAX_AUDIT_PAYLOAD_BYTES = 4_000;

const SECRET_FIELDS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "id_token",
  "token",
  "secret",
  "password",
  "encrypted_value",
  "encrypted_password",
  "client_secret",
  "private_key",
  "service_account_key",
  "ha_token",
  "wati_access_token",
  "credentials",
  "x-api-key",
]);

function sanitize<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitize) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELDS.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = sanitize(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

function truncatePayload(value: unknown): unknown {
  try {
    const json = JSON.stringify(sanitize(value));
    if (!json) return value;
    if (json.length <= MAX_AUDIT_PAYLOAD_BYTES) return JSON.parse(json);
    return { _truncated: true, _bytes: json.length, preview: json.slice(0, MAX_AUDIT_PAYLOAD_BYTES) };
  } catch {
    return "[unserializable]";
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function clientIp(req: Request): string {
  const fwd = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return fwd || req.ip || "unknown";
}

interface AuditOpts {
  endpoint: string;
  status: "success" | "error" | "denied";
  detail?: Record<string, unknown>;
  severity?: "info" | "warning" | "error";
  durationMs?: number;
  requestPayload?: unknown;
  responsePreview?: unknown;
}

function audit(req: Request, opts: AuditOpts) {
  const { endpoint, status, detail = {}, severity = "info", durationMs, requestPayload, responsePreview } = opts;
  const baseDetail: Record<string, unknown> = {
    source: SOURCE,
    endpoint,
    method: req.method,
    path: req.originalUrl,
    ip: clientIp(req),
    duration_ms: durationMs ?? null,
    ...detail,
  };
  if (req.query && Object.keys(req.query).length) {
    baseDetail.query = req.query;
  }
  if (requestPayload !== undefined) {
    baseDetail.request = truncatePayload(requestPayload);
  }
  if (responsePreview !== undefined) {
    baseDetail.response_preview = truncatePayload(responsePreview);
  }
  logAudit("external-api", {
    category: "external_api",
    event_type: `external_api.${endpoint}`,
    severity,
    actor_id: ACTOR_ID,
    actor_name: SOURCE,
    channel: CHANNEL,
    summary: `${req.method} ${req.originalUrl} → ${status}${durationMs != null ? ` (${durationMs}ms)` : ""}`,
    detail: sanitize(baseDetail),
    status,
  }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
}

function requireExternalApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.EXTERNAL_API_KEY;
  if (!expected) {
    res.status(503).json({ error: "External API not configured" });
    return;
  }
  const provided = (req.headers["x-api-key"] || "").toString();
  if (!provided || !timingSafeEqualStr(provided, expected)) {
    audit(req, { endpoint: "auth", status: "denied", detail: { reason: "invalid_api_key" }, severity: "warning" });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const { allowed, retryAfterMs } = checkRateLimit(SOURCE, "external_api", RATE_LIMIT);
  if (!allowed) {
    res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000).toString());
    audit(req, { endpoint: "rate_limit", status: "denied", detail: { retryAfterMs }, severity: "warning" });
    res.status(429).json({ error: "Rate limit exceeded", retry_after_ms: retryAfterMs });
    return;
  }
  next();
}

router.use(requireExternalApiKey);
router.use(rateLimit);

function ok(res: Response, data: unknown) {
  // res.req.correlationId is set by correlationMiddleware; echoing it
  // in the body lets external callers stitch their traces to ours
  // without parsing response headers.
  const cid = res.req?.correlationId;
  res.json({ success: true, data: sanitize(data), ...(cid ? { correlation_id: cid } : {}) });
}

function fail(res: Response, status: number, error: string, detail?: unknown) {
  const cid = res.req?.correlationId;
  res.status(status).json({ success: false, error, detail: detail ? sanitize(detail) : undefined, ...(cid ? { correlation_id: cid } : {}) });
}

function asyncH(
  endpoint: string,
  handler: (req: Request, res: Response) => Promise<unknown>,
) {
  return async (req: Request, res: Response) => {
    const start = Date.now();
    const requestPayload =
      req.method === "GET" || req.method === "DELETE"
        ? undefined
        : req.body ?? null;
    try {
      const result = await handler(req, res);
      const durationMs = Date.now() - start;
      if (!res.headersSent) {
        ok(res, result);
      }
      audit(req, {
        endpoint,
        status: "success",
        durationMs,
        requestPayload,
        responsePreview: result,
      });
    } catch (e) {
      const durationMs = Date.now() - start;
      const msg = e instanceof Error ? e.message : "Unknown error";
      audit(req, {
        endpoint,
        status: "error",
        detail: { error: msg },
        severity: "error",
        durationMs,
        requestPayload,
      });
      if (!res.headersSent) fail(res, 500, msg);
    }
  };
}

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true, coerceTypes: false });

function validateAgainstSchema(schema: unknown, data: unknown): { ok: boolean; errors: ErrorObject[] | null } {
  if (!schema || typeof schema !== "object") return { ok: true, errors: null };
  try {
    const validate = ajv.compile(schema as object);
    const valid = validate(data);
    if (valid) return { ok: true, errors: null };
    return { ok: false, errors: validate.errors || null };
  } catch {
    return { ok: true, errors: null };
  }
}

interface EndpointDef {
  method: string;
  path: string;
  description: string;
  query?: Record<string, { type: string; required?: boolean; description?: string }>;
  body?: {
    type: "object";
    required?: string[];
    // Cross-field requirement: at least one of each listed group must be
    // present (rendered as JSON-Schema anyOf/required).
    anyOfRequired?: string[][];
    properties: Record<string, { type: string; description?: string }>;
  };
}

const READ_ENDPOINTS: EndpointDef[] = [
  { method: "GET", path: "/capabilities", description: "List of all endpoints (with parameter shapes) and tools available" },
  { method: "GET", path: "/tools", description: "List of generic invokable tools (with JSON schemas)" },
  { method: "POST", path: "/tools/:name/invoke", description: "Invoke a tool by name. Body is validated against the tool's parameters schema." },
  { method: "GET", path: "/home/states", description: "All Home Assistant entity states", query: { domain: { type: "string", description: "Filter to a single domain (e.g. 'light')" } } },
  { method: "GET", path: "/home/state/:entity_id", description: "Single Home Assistant entity state" },
  { method: "GET", path: "/home/logbook", description: "Recent Home Assistant logbook entries", query: { hours: { type: "number" }, entity_id: { type: "string" } } },
  { method: "GET", path: "/tesla/status", description: "Tesla vehicle status" },
  { method: "GET", path: "/verkada/status", description: "Verkada cameras + recent alerts" },
  { method: "GET", path: "/generator/status", description: "Generac generator status" },
  { method: "GET", path: "/pool/status", description: "iAqualink pool / spa device status (list of devices and their attributes)" },
  { method: "GET", path: "/network/status", description: "Network / internet status — FortiGate device + WAN interface health" },
  { method: "GET", path: "/weather", description: "Current weather, 7-day forecast, AQI, pollen, public alerts for the household location (cached 5 min)" },
  { method: "GET", path: "/calendar/events", description: "Upcoming calendar events", query: { calendar_id: { type: "string" }, time_min: { type: "string" }, time_max: { type: "string" }, max_results: { type: "number" } } },
  { method: "GET", path: "/calendars", description: "List of accessible Google calendars" },
  { method: "GET", path: "/notion/database/:id", description: "Notion database schema" },
  { method: "GET", path: "/memory", description: "Janus long-term memory facts", query: { user_id: { type: "string" } } },
  { method: "GET", path: "/reminders", description: "Janus reminders for a user", query: { user_id: { type: "string" } } },
  { method: "GET", path: "/trips", description: "All saved trips" },
  { method: "GET", path: "/entertainment", description: "Upcoming entertainment events" },
  { method: "GET", path: "/household", description: "Household members" },
  { method: "GET", path: "/automations", description: "Family automations" },
  { method: "GET", path: "/audit-log", description: "Recent system audit log entries", query: { limit: { type: "number" }, category: { type: "string" }, severity: { type: "string" }, since: { type: "string" } } },
  { method: "GET", path: "/activity", description: "Recent household activity events (audit log feed, excluding the External API itself)", query: { limit: { type: "number" }, since: { type: "string" } } },
  { method: "GET", path: "/chat-history", description: "Recent Janus chat history", query: { user_id: { type: "string", required: true }, limit: { type: "number" } } },
  { method: "GET", path: "/health", description: "External API health probe" },
];

const ACTION_ENDPOINTS: EndpointDef[] = [
  {
    method: "POST", path: "/home/call-service",
    description: "Call a Home Assistant service",
    body: { type: "object", required: ["domain", "service"], properties: {
      domain: { type: "string" }, service: { type: "string" }, service_data: { type: "object" },
    } },
  },
  {
    method: "POST", path: "/broadcast",
    description: "Broadcast a TTS message to Google Home speakers, with WhatsApp fallback if all speakers fail",
    body: { type: "object", required: ["message"], properties: {
      message: { type: "string" },
      speakers: { type: "array<string>", description: "media_player.* entity IDs (defaults to bedroom speakers)" },
      volume: { type: "number" },
      voice_id: { type: "string" },
      fallback_phone: { type: "string" },
    } },
  },
  {
    method: "POST", path: "/calendar/event",
    description: "Create a Google Calendar event",
    body: { type: "object", required: ["title", "start", "end"], properties: {
      title: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      calendar_id: { type: "string" }, description: { type: "string" }, location: { type: "string" }, attendees: { type: "array<string>" },
    } },
  },
  {
    method: "PATCH", path: "/calendar/event/:event_id",
    description: "Update fields on an existing Google Calendar event",
    body: { type: "object", properties: {
      calendar_id: { type: "string" },
      title: { type: "string" }, start: { type: "string" }, end: { type: "string" },
      description: { type: "string" }, location: { type: "string" }, attendees: { type: "array<string>" },
    } },
  },
  {
    method: "DELETE", path: "/calendar/event/:event_id",
    description: "Delete a calendar event",
    query: { calendar_id: { type: "string" } },
  },
  {
    method: "POST", path: "/email/send",
    description: "Send an email from assistant@example.com via Gmail. Requires html or text.",
    body: { type: "object", required: ["to", "subject"], anyOfRequired: [["html"], ["text"]], properties: {
      to: { type: "string" }, subject: { type: "string" }, html: { type: "string" }, text: { type: "string" }, from: { type: "string" },
    } },
  },
  {
    method: "POST", path: "/notion/query",
    description: "Query a Notion database",
    body: { type: "object", required: ["database_id"], properties: {
      database_id: { type: "string" }, filter: { type: "object" }, sorts: { type: "array<object>" }, page_size: { type: "number" }, start_cursor: { type: "string" },
    } },
  },
  {
    method: "POST", path: "/notion/page",
    description: "Create a Notion page",
    body: { type: "object", required: ["database_id", "properties"], properties: {
      database_id: { type: "string" }, properties: { type: "object" }, children: { type: "array<object>" },
    } },
  },
  {
    method: "PATCH", path: "/notion/page/:page_id",
    description: "Update Notion page properties or archive state. Requires properties or archived.",
    body: { type: "object", anyOfRequired: [["properties"], ["archived"]], properties: { properties: { type: "object" }, archived: { type: "boolean" } } },
  },
  {
    method: "POST", path: "/memory",
    description: "Upsert a Janus long-term memory fact (unique on user_id+key)",
    body: { type: "object", required: ["user_id", "key", "value"], properties: {
      user_id: { type: "string" }, key: { type: "string" }, value: { type: "string" }, context: { type: "string" },
    } },
  },
];

// ── Body validation for action endpoints ─────────────────────────────
// The ACTION_ENDPOINTS defs above double as the documented parameter
// shapes in /capabilities. Convert each `body` def into a real JSON
// Schema once at module load and reject mismatched payloads with a 400
// + field-level Ajv errors BEFORE the handler runs, instead of letting
// them surface as generic 500s from deep inside the handler.

function fieldTypeToSchema(type: string): Record<string, unknown> {
  const arrayMatch = /^array<(.+)>$/.exec(type);
  if (arrayMatch) return { type: "array", items: fieldTypeToSchema(arrayMatch[1]) };
  return { type };
}

function endpointBodyToSchema(body: NonNullable<EndpointDef["body"]>): Record<string, unknown> {
  const required = body.required || [];
  const anyOfFields = new Set((body.anyOfRequired || []).flat());
  const properties: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(body.properties)) {
    const fieldSchema = fieldTypeToSchema(spec.type);
    // A required (or one-of-required) string that is empty is as useless to
    // the handler as a missing one — reject it at the schema layer so it
    // surfaces as a 400 instead of a handler 500.
    if (fieldSchema.type === "string" && (required.includes(key) || anyOfFields.has(key))) {
      fieldSchema.minLength = 1;
    }
    properties[key] = fieldSchema;
  }
  return {
    type: "object",
    ...(required.length ? { required } : {}),
    properties,
    ...(body.anyOfRequired?.length
      ? { anyOf: body.anyOfRequired.map((group) => ({ required: group })) }
      : {}),
    // Lenient on extra keys so existing callers passing benign extras
    // don't suddenly break; required fields + declared types are enforced.
    additionalProperties: true,
  };
}

function validateBody(endpoint: string, method: string, defPath: string) {
  const def = ACTION_ENDPOINTS.find((e) => e.method === method && e.path === defPath);
  if (!def?.body) {
    // Static wiring error (typo'd path/method) — fail loudly at boot.
    throw new Error(`validateBody: no body def for ${method} ${defPath}`);
  }
  const schema = endpointBodyToSchema(def.body);
  return (req: Request, res: Response, next: NextFunction) => {
    // Validate the body as sent. Only an absent body (no JSON parsed at all)
    // is treated as {}; explicit null, arrays, and primitives must fail the
    // schema's type:"object" check rather than being silently normalized.
    const body = req.body === undefined ? {} : req.body;
    const validation = validateAgainstSchema(schema, body);
    if (!validation.ok) {
      audit(req, {
        endpoint,
        status: "error",
        detail: { error: "schema_validation_failed", errors: validation.errors },
        severity: "warning",
        durationMs: 0,
        requestPayload: req.body,
      });
      fail(res, 400, `Invalid request body for ${method} ${defPath}`, validation.errors);
      return;
    }
    next();
  };
}

router.get("/health", (req, res) => {
  audit(req, { endpoint: "health", status: "success", durationMs: 0 });
  res.json({ success: true, data: { ok: true, timestamp: new Date().toISOString() } });
});

type ToolDef = { type: string; function: { name: string; description: string; parameters: unknown } };
const TOOLS = ALL_TOOLS as readonly ToolDef[];

router.get("/capabilities", asyncH("capabilities", async () => ({
  name: "Janus External API",
  version: "v1",
  base_path: "/api/v1/external",
  auth: { type: "header", header: "x-api-key" },
  rate_limit: { max_requests: RATE_LIMIT.maxRequests, window_ms: RATE_LIMIT.windowMs, scope: "global" },
  endpoints: [...READ_ENDPOINTS, ...ACTION_ENDPOINTS],
  tools: TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  })),
})));

router.get("/tools", asyncH("tools.list", async () => ({
  tools: TOOLS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  })),
})));

router.post("/tools/:name/invoke", async (req, res) => {
  const start = Date.now();
  const name = req.params.name;
  const tool = TOOLS.find((t) => t.function.name === name);
  if (!tool) {
    audit(req, { endpoint: "tools.invoke", status: "error", detail: { error: "unknown_tool", tool: name }, severity: "error", durationMs: Date.now() - start, requestPayload: req.body });
    fail(res, 500, `Unknown tool: ${name}`);
    return;
  }
  // Absent body → {}; anything else (null/array/primitive) is validated as
  // sent so the tool's type:"object" schema rejects it with a clean 400.
  const args = req.body === undefined ? {} : req.body;

  const validation = validateAgainstSchema(tool.function.parameters, args);
  if (!validation.ok) {
    audit(req, {
      endpoint: "tools.invoke",
      status: "error",
      detail: { error: "schema_validation_failed", tool: name, errors: validation.errors },
      severity: "warning",
      durationMs: Date.now() - start,
      requestPayload: args,
    });
    fail(res, 400, `Invalid arguments for tool '${name}'`, validation.errors);
    return;
  }

  try {
    const ctx: RequestContext = { svc: getServiceClient() };
    const result = await executeTool(name, args, undefined, ctx);
    let parsed: unknown = result;
    if (typeof result === "string") {
      try { parsed = JSON.parse(result); } catch { parsed = result; }
    }
    const data = { tool: name, result: parsed };
    audit(req, { endpoint: "tools.invoke", status: "success", durationMs: Date.now() - start, requestPayload: args, responsePreview: data, detail: { tool: name } });
    ok(res, data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    audit(req, { endpoint: "tools.invoke", status: "error", detail: { error: msg, tool: name }, severity: "error", durationMs: Date.now() - start, requestPayload: args });
    fail(res, 500, msg);
  }
});

// Enrich Rain Bird irrigation zones with the curated zone label (e.g.
// "Entry Left Strip") so external callers get the same friendly names as the
// irrigation UI / Janus, rather than HA's generic "Sprinkler N". Falls back to
// the existing HA friendly_name when no curated label exists. Mirrors the
// getZoneFlow() lookup used in server/routes/water.ts and home-automation.ts.
function enrichZoneLabel(entity: unknown): unknown {
  if (!entity || typeof entity !== "object") return entity;
  const e = entity as Record<string, unknown>;
  const entityId = e.entity_id;
  if (typeof entityId !== "string") return entity;
  const zone = getZoneFlow(entityId);
  if (!zone) return entity;
  const attrs = e.attributes as Record<string, unknown> | undefined;
  const friendly = (attrs?.friendly_name as string | undefined) ?? (e.name as string | undefined);
  return { ...e, zone_label: zone.label ?? friendly };
}

function enrichZoneLabels(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed.map(enrichZoneLabel);
  return enrichZoneLabel(parsed);
}

router.get("/home/states", asyncH("home.states", async (req) => {
  const domain = (req.query.domain as string) || undefined;
  const raw = await executeHAGetStates(domain);
  try { return enrichZoneLabels(JSON.parse(raw)); } catch { return raw; }
}));

router.get("/home/state/:entity_id", asyncH("home.state", async (req) => {
  const raw = await executeHAGetState(String(req.params.entity_id));
  try { return enrichZoneLabels(JSON.parse(raw)); } catch { return raw; }
}));

router.get("/home/logbook", asyncH("home.logbook", async (req) => {
  const hours = req.query.hours ? Number(req.query.hours) : undefined;
  const entity_id = (req.query.entity_id as string) || undefined;
  const raw = await executeHAGetLogbook(hours, entity_id);
  // Logbook entries for Rain Bird zones get the same curated zone_label as the
  // live state endpoints (entries carry name/entity_id, no attributes, so the
  // fallback inside enrichZoneLabel resolves via e.name).
  try { return enrichZoneLabels(JSON.parse(raw)); } catch { return raw; }
}));

router.post("/home/call-service", validateBody("home.call_service", "POST", "/home/call-service"), asyncH("home.call_service", async (req) => {
  const { domain, service, service_data } = req.body || {};
  if (!domain || !service) throw new Error("domain and service are required");
  const result = await executeHACallService(domain, service, service_data);
  return { result };
}));

router.get("/tesla/status", asyncH("tesla.status", async () => {
  const svc = getServiceClient();
  const raw = await executeCheckTeslaStatus(svc);
  try { return JSON.parse(raw); } catch { return raw; }
}));

router.get("/verkada/status", asyncH("verkada.status", async () => {
  const svc = getServiceClient();
  const raw = await executeCheckVerkadaSecurity(svc);
  try { return JSON.parse(raw); } catch { return raw; }
}));

router.get("/generator/status", asyncH("generator.status", async () => {
  const raw = await executeCheckGeneratorStatus();
  try { return JSON.parse(raw); } catch { return raw; }
}));

router.get("/pool/status", asyncH("pool.status", async () => {
  const session = await getIaqualinkSession();
  const devices = await iaqualinkSimpleGet("/devices.json", session);
  return { devices };
}));

router.get("/network/status", asyncH("network.status", async () => {
  const [statusRes, healthRes, interfacesRes] = await Promise.all([
    fortigateRequest("/api/v2/monitor/system/status"),
    fortigateRequest("/api/v2/monitor/system/resource/usage?scope=global"),
    fortigateRequest("/api/v2/monitor/system/interface"),
  ]);
  const stat = (statusRes.data as { results?: Record<string, unknown> })?.results || statusRes.data;
  const health = (healthRes.data as { results?: Record<string, unknown> })?.results || {};
  const interfaces = (interfacesRes.data as { results?: unknown })?.results || [];
  return {
    fortigate: {
      hostname: (stat as Record<string, unknown>)?.hostname,
      version: (stat as Record<string, unknown>)?.version,
      serial: (stat as Record<string, unknown>)?.serial,
      uptime: (stat as Record<string, unknown>)?.uptime,
      cpu: health.cpu ?? null,
      memory: health.mem ?? null,
      sessions: health.session ?? null,
    },
    interfaces,
  };
}));

let weatherCache: { data: unknown; expiresAt: number } | null = null;
router.get("/weather", asyncH("weather.current", async () => {
  if (weatherCache && Date.now() < weatherCache.expiresAt) return weatherCache.data;
  const port = process.env.PORT || 5000;
  const r = await fetch(`http://localhost:${port}/api/weather-dashboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!r.ok) throw new Error(`Weather dashboard HTTP ${r.status}`);
  const data = await r.json();
  weatherCache = { data, expiresAt: Date.now() + 5 * 60 * 1000 };
  return data;
}));

router.get("/calendars", asyncH("calendar.list", async (req) => {
  const calendarId = (req.query.calendar_id as string) || undefined;
  const data = await callCalendarProxy({ action: "list-calendars", calendarId: calendarId || "admin@example.com" });
  return data;
}));

router.get("/calendar/events", asyncH("calendar.events", async (req) => {
  const calendar_id = (req.query.calendar_id as string) || undefined;
  const now = new Date();
  const time_min = (req.query.time_min as string) || now.toISOString();
  const time_max =
    (req.query.time_max as string) ||
    new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
  const max_results = req.query.max_results ? Number(req.query.max_results) : 50;
  const raw = await executeGetCalendarEvents(calendar_id, time_min, time_max, max_results);
  try { return JSON.parse(raw); } catch { return { summary: raw }; }
}));

router.post("/calendar/event", validateBody("calendar.create", "POST", "/calendar/event"), asyncH("calendar.create", async (req) => {
  const { calendar_id, title, start, end, description, location, attendees } = req.body || {};
  if (!title || !start || !end) throw new Error("title, start, end are required");
  const raw = await executeCreateCalendarEvent(calendar_id, title, start, end, description, location, attendees);
  try { return JSON.parse(raw); } catch { return { result: raw }; }
}));

router.patch("/calendar/event/:event_id", validateBody("calendar.update", "PATCH", "/calendar/event/:event_id"), asyncH("calendar.update", async (req) => {
  const { calendar_id, title, start, end, description, location, attendees } = req.body || {};
  const data = await callCalendarProxy({
    action: "update-event",
    calendarId: calendar_id || "admin@example.com",
    eventId: req.params.event_id,
    title, start, end, description, location, attendees,
  });
  return data;
}));

router.delete("/calendar/event/:event_id", asyncH("calendar.delete", async (req) => {
  const calendar_id = (req.query.calendar_id as string) || undefined;
  const raw = await executeDeleteCalendarEvent(calendar_id, String(req.params.event_id));
  try { return JSON.parse(raw); } catch { return { result: raw }; }
}));

router.get("/notion/database/:id", asyncH("notion.database", async (req) => {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error("NOTION_API_KEY not configured");
  const r = await fetch(`https://api.notion.com/v1/databases/${req.params.id}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
    },
  });
  if (!r.ok) throw new Error(`Notion HTTP ${r.status}`);
  return await r.json();
}));

router.post("/notion/query", validateBody("notion.query", "POST", "/notion/query"), asyncH("notion.query", async (req) => {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error("NOTION_API_KEY not configured");
  const { database_id, filter, sorts, page_size, start_cursor } = req.body || {};
  if (!database_id) throw new Error("database_id is required");
  const r = await fetch(`https://api.notion.com/v1/databases/${database_id}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ filter, sorts, page_size, start_cursor }),
  });
  if (!r.ok) throw new Error(`Notion HTTP ${r.status}`);
  return await r.json();
}));

router.post("/notion/page", validateBody("notion.create_page", "POST", "/notion/page"), asyncH("notion.create_page", async (req) => {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error("NOTION_API_KEY not configured");
  const { database_id, properties, children } = req.body || {};
  if (!database_id || !properties) throw new Error("database_id and properties are required");
  const r = await fetch(`https://api.notion.com/v1/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ parent: { database_id }, properties, children }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Notion HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  return await r.json();
}));

router.patch("/notion/page/:page_id", validateBody("notion.update_page", "PATCH", "/notion/page/:page_id"), asyncH("notion.update_page", async (req) => {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) throw new Error("NOTION_API_KEY not configured");
  const { properties, archived } = req.body || {};
  if (!properties && archived === undefined) throw new Error("properties or archived is required");
  const r = await fetch(`https://api.notion.com/v1/pages/${req.params.page_id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties, archived }),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Notion HTTP ${r.status}: ${txt.slice(0, 200)}`);
  }
  return await r.json();
}));

router.post("/email/send", validateBody("email.send", "POST", "/email/send"), asyncH("email.send", async (req) => {
  const { to, subject, html, text, from } = req.body || {};
  if (!to || !subject || (!html && !text)) {
    throw new Error("to, subject, and html or text are required");
  }
  const saKey = getSaKey();
  const body = html || (text ? text.replace(/\n/g, "<br>") : "");
  const plain = text || html?.replace(/<[^>]+>/g, "") || "";
  const sent = await sendGmailRaw(saKey, to, subject, body, plain, from);
  if (!sent) throw new Error("Gmail send failed");
  return { sent: true, to, subject };
}));

router.post("/broadcast", validateBody("broadcast.send", "POST", "/broadcast"), asyncH("broadcast.send", async (req) => {
  const {
    message,
    speakers,
    volume = 0.9,
    voice_id = "iLVmqjzCGGvqtMCk6vVQ", // Janus – English with Italian accent (male)
    fallback_phone,
  } = req.body || {};
  if (!message || typeof message !== "string") throw new Error("message is required");

  const targetSpeakers: string[] =
    Array.isArray(speakers) && speakers.length > 0
      ? speakers
      : getMorningSpeakers();

  const errors: string[] = [];
  let succeeded = 0;

  for (const sp of targetSpeakers) {
    try {
      await callHAProxy("call-service", {
        domain: "media_player",
        service: "volume_set",
        service_data: { entity_id: sp, volume_level: volume },
      });
    } catch (e) {
      errors.push(`volume_set:${sp}:${(e as Error).message}`);
    }
    try {
      const r = await callHAProxy("call-service", {
        domain: "tts",
        service: "speak",
        service_data: {
          entity_id: "tts.elevenlabs_text_to_speech",
          media_player_entity_id: sp,
          message,
          options: { voice: voice_id },
        },
      });
      if (r.startsWith("Error:")) {
        errors.push(`${sp}:${r}`);
      } else {
        succeeded++;
      }
    } catch (e) {
      errors.push(`${sp}:${(e as Error).message}`);
    }
  }

  let whatsapp_fallback = false;
  if (succeeded === 0) {
    const phone = fallback_phone || (await getBroadcastFallbackPhone());
    whatsapp_fallback = await sendWhatsAppTo(phone, `📢 Broadcast: ${message}`);
  }

  return {
    speakers: targetSpeakers,
    succeeded,
    failed: targetSpeakers.length - succeeded,
    errors: errors.length ? errors : undefined,
    whatsapp_fallback,
  };
}));

router.get("/memory", asyncH("memory.list", async (req) => {
  const userId = (req.query.user_id as string) || ACTOR_ID;
  const facts = await storage.getJanusMemory(userId);
  return { user_id: userId, facts };
}));

router.post("/memory", validateBody("memory.upsert", "POST", "/memory"), asyncH("memory.upsert", async (req) => {
  const { user_id, key, value, context } = req.body || {};
  if (!user_id || !key || !value) throw new Error("user_id, key, value are required");
  const fact = await storage.upsertJanusMemory({ userId: user_id, key, value, context: context || null });
  return { fact };
}));

router.get("/reminders", asyncH("reminders.list", async (req) => {
  const userId = (req.query.user_id as string) || ACTOR_ID;
  const reminders = await storage.getJanusReminders(userId);
  return { user_id: userId, reminders };
}));

router.get("/trips", asyncH("trips.list", async () => {
  const trips = await storage.getTrips();
  return { trips };
}));

router.get("/entertainment", asyncH("entertainment.list", async () => {
  const events = await storage.getEntertainmentEvents();
  return { events };
}));

router.get("/household", asyncH("household.list", async () => {
  const members = await storage.getHouseholdMembers();
  return { members };
}));

router.get("/automations", asyncH("automations.list", async () => {
  const automations = await storage.getFamilyAutomations();
  return { automations };
}));

router.get("/audit-log", asyncH("audit_log.list", async (req) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;
  const category = (req.query.category as string) || undefined;
  const severity = (req.query.severity as string) || undefined;
  const since = (req.query.since as string) || undefined;
  const result = await storage.querySystemAuditLogs({ limit, category, severity, since });
  return result;
}));

router.get("/activity", asyncH("activity.list", async (req) => {
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
  const since = (req.query.since as string) || undefined;
  const result = await storage.querySystemAuditLogs({ limit: limit * 4, since });
  const rows = (result?.rows || []).filter((row) => row.category !== "external_api").slice(0, limit);
  return { ...result, rows };
}));

router.get("/chat-history", asyncH("chat.history", async (req) => {
  const userId = (req.query.user_id as string);
  if (!userId) throw new Error("user_id is required");
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
  const messages = await storage.getJanusChatLogs(userId, limit);
  return { user_id: userId, messages };
}));

router.use((req, res) => {
  audit(req, { endpoint: "not_found", status: "error", detail: { path: req.originalUrl }, severity: "warning", durationMs: 0 });
  res.status(404).json({ success: false, error: `Endpoint not found: ${req.method} ${req.originalUrl}` });
});

export default router;
