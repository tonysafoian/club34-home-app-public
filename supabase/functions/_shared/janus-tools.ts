/**
 * _shared/janus-tools.ts
 *
 * Shared tool executors and helpers used by janus-chat, janus-whatsapp, and janus-email-poll.
 * Import with: import { ... } from "../_shared/janus-tools.ts";
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Re-export createClient so consumers don't need a separate import for it
export { createClient };

export type SupabaseClient = ReturnType<typeof createClient>;

// ─── Helper: get a service-role Supabase client ──────────────────────────────
export function getServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// ─── Audit Log ───────────────────────────────────────────────────────────────
export async function logAudit(edgeFunction: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    await fetch(`${url}/rest/v1/system_audit_log`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ edge_function: edgeFunction, ...entry }),
    });
  } catch (e) { console.error("Audit log failed:", e); }
}

// ─── Dead-Letter Queue (Failed Jobs) ─────────────────────────────────────────
/**
 * Record a failed scheduled job for later inspection and retry.
 * Call this in the top-level catch of any cron/scheduled edge function.
 */
export async function enqueueFailedJob(
  functionName: string,
  error: unknown,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetail = error instanceof Error
      ? { stack: error.stack, name: error.name }
      : { raw: String(error) };
    await fetch(`${url}/rest/v1/failed_jobs`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        function_name: functionName,
        error_message: errorMessage.slice(0, 2000),
        error_detail: errorDetail,
        payload: payload || {},
      }),
    });
  } catch (e) { console.error("Failed to enqueue DLQ job:", e); }
}

// ─── Configurable Alert Destination ──────────────────────────────────────────
const FALLBACK_ALERT_PHONE = "13104717979";
let _cachedAlertPhone: string | null = null;
let _alertPhoneFetchedAt = 0;
const ALERT_PHONE_CACHE_TTL = 10 * 60_000;

export async function getAlertPhoneNumber(): Promise<string> {
  if (_cachedAlertPhone && Date.now() - _alertPhoneFetchedAt < ALERT_PHONE_CACHE_TTL) {
    return _cachedAlertPhone;
  }
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resp = await fetch(
      `${url}/rest/v1/system_configs?key=eq.alert_phone_number&select=value&limit=1`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } },
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (Array.isArray(rows) && rows.length > 0 && rows[0].value) {
        _cachedAlertPhone = rows[0].value;
        _alertPhoneFetchedAt = Date.now();
        return _cachedAlertPhone!;
      }
    }
  } catch { /* config lookup is best-effort — fall through to env var / hardcoded fallback */ }
  const envPhone = Deno.env.get("ALERT_PHONE_NUMBER");
  if (envPhone) {
    _cachedAlertPhone = envPhone;
    _alertPhoneFetchedAt = Date.now();
    return envPhone;
  }
  return FALLBACK_ALERT_PHONE;
}

// ─── Automation Failure Alert (WhatsApp) ─────────────────────────────────────
const _alertCooldowns: Record<string, number> = {};
const ALERT_COOLDOWN_MS = 30 * 60_000;

export async function sendAutomationFailureAlert(
  functionName: string,
  errorSummary: string,
): Promise<void> {
  const now = Date.now();
  if (_alertCooldowns[functionName] && now - _alertCooldowns[functionName] < ALERT_COOLDOWN_MS) return;
  _alertCooldowns[functionName] = now;

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) return;

  const alertPhone = await getAlertPhoneNumber();
  const msg = `⚠️ ${functionName} failed: ${errorSummary.slice(0, 200)}`;
  try {
    await fetch(`${url}/functions/v1/janus-whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({ action: "send", to: alertPhone, message: msg }),
    });
  } catch (e) { console.error("Failure alert send failed:", e); }
}

// ─── Prompt Cache ────────────────────────────────────────────────────────────
const promptCache: Record<string, { content: string; fetchedAt: number }> = {};
const PROMPT_CACHE_TTL = 5 * 60_000;

export async function loadPrompt(slug: string, fallback: string, svc?: SupabaseClient): Promise<string> {
  const cached = promptCache[slug];
  if (cached && Date.now() - cached.fetchedAt < PROMPT_CACHE_TTL) return cached.content;
  try {
    const sb = svc || (() => {
      const u = Deno.env.get("SUPABASE_URL"), k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      return u && k ? createClient(u, k) : null;
    })();
    if (!sb) return fallback;
    const { data } = await sb.from("system_prompts").select("content").eq("slug", slug).single();
    const result = data?.content || fallback;
    promptCache[slug] = { content: result, fetchedAt: Date.now() };
    return result;
  } catch (e) {
    console.error(`Failed to load prompt "${slug}", using fallback:`, e);
    return fallback;
  }
}

// ─── Conversation History ────────────────────────────────────────────────────
// Truncates individual messages to avoid bloating the AI prompt with long tool
// results or research outputs. 30 messages × 10KB each = 300KB without this cap.
const MAX_MESSAGE_LENGTH = 1500; // chars per message — keeps total context ~45KB max

export async function loadConversationHistory(
  userId: string, limit = 30, svc?: SupabaseClient
): Promise<{ role: string; content: string }[]> {
  try {
    const sb = svc || (() => {
      const u = Deno.env.get("SUPABASE_URL"), k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      return u && k ? createClient(u, k) : null;
    })();
    if (!sb) return [];
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await sb
      .from("janus_chat_logs")
      .select("user_message, assistant_response, created_at")
      .eq("user_id", userId)
      .gte("created_at", cutoff)
      .neq("assistant_response", "(pending)")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    const history: { role: string; content: string }[] = [];
    for (const row of data.reverse()) {
      if (row.user_message) {
        const msg = row.user_message.length > MAX_MESSAGE_LENGTH
          ? row.user_message.slice(0, MAX_MESSAGE_LENGTH) + "…[truncated]"
          : row.user_message;
        history.push({ role: "user", content: msg });
      }
      if (row.assistant_response) {
        const msg = row.assistant_response.length > MAX_MESSAGE_LENGTH
          ? row.assistant_response.slice(0, MAX_MESSAGE_LENGTH) + "…[truncated]"
          : row.assistant_response;
        history.push({ role: "assistant", content: msg });
      }
    }
    return history;
  } catch (e) {
    console.error("Failed to load conversation history:", e);
    return [];
  }
}

// ─── Permanent Memory ────────────────────────────────────────────────────────
export async function loadMemories(
  userId: string, svc?: SupabaseClient, limit = 25
): Promise<{ key: string; value: string; context?: string }[]> {
  try {
    const sb = svc || (() => {
      const u = Deno.env.get("SUPABASE_URL"), k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      return u && k ? createClient(u, k) : null;
    })();
    if (!sb) return [];
    const { data, error } = await sb
      .from("janus_memory")
      .select("key, value, context")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as { key: string; value: string; context?: string }[];
  } catch (e) {
    console.error("Failed to load memories:", e);
    return [];
  }
}

// ─── Conversation Logging ────────────────────────────────────────────────────
export async function logConversation(
  svc: SupabaseClient,
  userId: string, displayName: string, userRole: string,
  userMessage: string, assistantResponse: string,
  toolCalls: unknown[], channel: string,
): Promise<void> {
  try {
    await svc.from("janus_chat_logs").insert({
      user_id: userId,
      user_display_name: displayName,
      user_role: userRole,
      user_message: userMessage.slice(0, 5000),
      assistant_response: assistantResponse.slice(0, 10000),
      tool_calls: toolCalls,
      channel,
    });
  } catch (e) {
    console.error("Failed to log conversation:", e);
  }
}

// ─── Email ───────────────────────────────────────────────────────────────────
export async function executeSendEmail(
  to: string, subject: string, body: string,
  auditChannel = "chat", auditEdgeFunction = "janus-chat",
): Promise<string> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return "Email is not configured — missing Supabase config.";

  // Validate ALL URLs in email body before sending — emails must never contain broken links
  try {
    const { text: cleanedBody, deadCount, deadUrls } = await validateEmailURLs(body);
    if (deadCount > 0) {
      console.log(`[Email-URLCheck] Stripped ${deadCount} dead URL(s) from email to ${to}: ${deadUrls.join(', ')}`);
      body = cleanedBody;
    }
  } catch (e) { console.error("[Email-URLCheck] URL validation failed (sending anyway):", e); }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/janus-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ action: "send", to, subject, body }),
    });

    const data = await res.json();
    const result = data.result || data.error || "Email send completed.";
    const success = !result.toLowerCase().includes("error");
    logAudit(auditEdgeFunction, { category: "janus", event_type: "email_sent", severity: success ? "info" : "error", actor_id: "system", actor_name: "Janus", channel: auditChannel, summary: `Email to ${to}: ${subject}`, detail: { to, subject, body_length: body.length }, status: success ? "success" : "error" });
    return result;
  } catch (e) {
    console.error("Email tool error:", e);
    logAudit(auditEdgeFunction, { category: "janus", event_type: "email_sent", severity: "error", actor_id: "system", actor_name: "Janus", channel: auditChannel, summary: `Email to ${to} failed: ${e instanceof Error ? e.message : "unknown"}`, detail: { to, subject, body_length: body.length }, status: "error" });
    return `Error sending email: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Google Service Account JWT ──────────────────────────────────────────────
// Token cache: keyed by scopes+sub, avoids repeated RS256 sign + token exchange
// within the same isolate. TTL=50min (Google tokens last 60min). Best-effort
// cache — doesn't persist across cold starts or regions.
const _googleTokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
const GOOGLE_TOKEN_CACHE_TTL = 50 * 60_000; // 50 minutes

export async function getGoogleServiceToken(scopes: string[], sub = "assistant@example.com"): Promise<string> {
  const cacheKey = `${scopes.sort().join(",")}|${sub}`;
  const cached = _googleTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const raw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY missing");
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email, sub,
    scope: scopes.join(" "),
    aud: sa.token_uri, iat: now, exp: now + 3600,
  };
  const enc = new TextEncoder();
  const b64u = (d: Uint8Array) => btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hB = b64u(enc.encode(JSON.stringify(header)));
  const cB = b64u(enc.encode(JSON.stringify(claims)));
  const unsigned = `${hB}.${cB}`;
  const pemBody = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c: string) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, enc.encode(unsigned)));
  const jwt = `${unsigned}.${b64u(sig)}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const token = (await res.json()).access_token;
  _googleTokenCache.set(cacheKey, { token, expiresAt: Date.now() + GOOGLE_TOKEN_CACHE_TTL });
  return token;
}

// ─── Gmail Search ────────────────────────────────────────────────────────────
// Uses Gmail Batch API to fetch message metadata in a single HTTP request
// instead of N individual requests (reduces latency and rate-limit risk).
type GmailHeader = { name: string; value?: string };

export async function executeGmailSearch(query: string, maxResults = 10): Promise<string> {
  try {
    const accessToken = await getGoogleServiceToken(["https://mail.google.com/"], "admin@example.com");
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(maxResults, 20)) });
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const listData = await listRes.json();
    if (!listRes.ok) return `Gmail search failed: ${listData.error?.message || listRes.status}`;
    if (!listData.messages?.length) return `No emails found matching "${query}".`;

    const msgIds: string[] = listData.messages.map((m: { id: string }) => m.id);

    // Build Gmail batch request — single HTTP call instead of N
    const boundary = `batch_${Date.now()}`;
    const batchParts = msgIds.map((id, i) =>
      `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <msg${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date\r\n`
    ).join("");
    const batchBody = batchParts + `--${boundary}--`;

    const batchRes = await fetch("https://www.googleapis.com/batch/gmail/v1", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/mixed; boundary=${boundary}`,
      },
      body: batchBody,
    });

    if (!batchRes.ok) {
      // Fallback to individual fetches if batch fails
      const messages = await Promise.all(msgIds.map(async (id) => {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!msgRes.ok) return null;
        const msg = await msgRes.json();
        const headers: GmailHeader[] = msg.payload?.headers || [];
        return { id: msg.id, from: headers.find((h) => h.name === "From")?.value || "", subject: headers.find((h) => h.name === "Subject")?.value || "(No subject)", date: headers.find((h) => h.name === "Date")?.value || "", snippet: msg.snippet || "", unread: msg.labelIds?.includes("UNREAD") || false };
      }));
      return JSON.stringify({ count: messages.filter(Boolean).length, query, results: messages.filter(Boolean) });
    }

    // Parse multipart batch response
    const batchText = await batchRes.text();
    const respBoundary = batchRes.headers.get("Content-Type")?.match(/boundary=([^\s;]+)/)?.[1] || boundary;
    const parts = batchText.split(`--${respBoundary}`).filter(p => p.includes("HTTP/"));
    const results = parts.map(part => {
      try {
        const jsonMatch = part.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const msg = JSON.parse(jsonMatch[0]);
        const headers: GmailHeader[] = msg.payload?.headers || [];
        return { id: msg.id, from: headers.find((h) => h.name === "From")?.value || "", subject: headers.find((h) => h.name === "Subject")?.value || "(No subject)", date: headers.find((h) => h.name === "Date")?.value || "", snippet: msg.snippet || "", unread: msg.labelIds?.includes("UNREAD") || false };
      } catch { return null; }
    }).filter(Boolean);

    return JSON.stringify({ count: results.length, query, results });
  } catch (e) { return `Error searching Gmail: ${e instanceof Error ? e.message : "unknown"}`; }
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────
export async function executeSendWhatsApp(
  to: string, message: string,
  auditChannel = "chat", auditEdgeFunction = "janus-chat",
): Promise<string> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return "WhatsApp is not configured — missing Supabase config.";

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/janus-whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ action: "send", to, message }),
    });

    const data = await res.json();
    const result = data.result || data.error || "WhatsApp send completed.";
    const success = !result.toLowerCase().includes("error") && !result.toLowerCase().includes("failed");
    logAudit(auditEdgeFunction, { category: "janus", event_type: "whatsapp_sent", severity: success ? "info" : "error", actor_id: "system", actor_name: "Janus", channel: auditChannel, summary: `WhatsApp to ${to}: ${message.slice(0, 80)}`, detail: { to, message_length: message.length }, status: success ? "success" : "error" });
    return result;
  } catch (e) {
    console.error("WhatsApp tool error:", e);
    logAudit(auditEdgeFunction, { category: "janus", event_type: "whatsapp_sent", severity: "error", actor_id: "system", actor_name: "Janus", channel: auditChannel, summary: `WhatsApp to ${to} failed: ${e instanceof Error ? e.message : "unknown"}`, detail: { to, message_length: message.length }, status: "error" });
    return `Error sending WhatsApp: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Notion: Query Database ──────────────────────────────────────────────────
type NotionRichText = { plain_text: string };
type NotionOption = { name: string };
type NotionPropertyValue = {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: NotionOption | null;
  multi_select?: NotionOption[];
  date?: { start: string | null } | null;
  checkbox?: boolean;
  number?: number | null;
  status?: NotionOption | null;
  people?: { name?: string; id: string }[];
  formula?: { string?: string | null; number?: number | null; boolean?: boolean | null };
  files?: { external?: { url: string }; file?: { url: string }; name?: string }[];
};
type NotionPage = { id: string; url: string; properties?: Record<string, NotionPropertyValue> };

export async function executeQueryNotionDatabase(database_id: string, filter?: Record<string, unknown>): Promise<string> {
  const NOTION_API_KEY = Deno.env.get("NOTION_API_KEY");
  if (!NOTION_API_KEY) return "Notion API key not configured.";

  try {
    const reqBody: { page_size: number; filter?: Record<string, unknown> } = { page_size: 30 };
    if (filter) reqBody.filter = filter;

    const res = await fetch(`https://api.notion.com/v1/databases/${database_id}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    const data = await res.json();
    if (!res.ok) return `Notion query failed: ${data.message || res.status}`;

    const pages: NotionPage[] = data.results || [];
    const summary = pages.map((p) => {
      const props: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(p.properties || {})) {
        if (v.type === "title") props[key] = v.title?.map((t) => t.plain_text).join("") || "";
        else if (v.type === "rich_text") props[key] = v.rich_text?.map((t) => t.plain_text).join("") || "";
        else if (v.type === "select") props[key] = v.select?.name || null;
        else if (v.type === "multi_select") props[key] = v.multi_select?.map((s) => s.name) || [];
        else if (v.type === "date") props[key] = v.date?.start || null;
        else if (v.type === "checkbox") props[key] = v.checkbox;
        else if (v.type === "number") props[key] = v.number;
        else if (v.type === "status") props[key] = v.status?.name || null;
        else if (v.type === "people") props[key] = v.people?.map((person) => person.name || person.id) || [];
        else if (v.type === "formula") props[key] = v.formula?.string || v.formula?.number || v.formula?.boolean || null;
        else if (v.type === "files") props[key] = v.files?.map((f) => f.external?.url || f.file?.url || f.name).filter(Boolean) || [];
      }
      return { id: p.id, url: p.url, ...props };
    });

    return JSON.stringify({ count: pages.length, pages: summary });
  } catch (e) {
    console.error("Notion query error:", e);
    return `Error querying Notion: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Notion: People-field Sanitizer ──────────────────────────────────────────
// Mutable lookup — updated by loadHouseholdMembers()
let _notionPeopleLookup: Record<string, string> = {
  "admin":   "00000000-0000-4000-a000-000000000001",
  "member":  "00000000-0000-4000-a000-000000000002",
};

export function getNotionPeopleLookup(): Record<string, string> {
  return _notionPeopleLookup;
}

export function setNotionPeopleLookup(lookup: Record<string, string>): void {
  _notionPeopleLookup = Object.keys(lookup).length > 0 ? lookup : _notionPeopleLookup;
}

export function isUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

type NotionPersonRef = { object?: string; id?: string };
type NotionPeopleValue = { people?: (NotionPersonRef | null)[] };

export function sanitizePeopleField(value: NotionPeopleValue | null | undefined): NotionPeopleValue | null | undefined {
  if (value?.people && Array.isArray(value.people)) {
    value.people = value.people.map((person) => {
      if (person?.id && !isUUID(person.id)) {
        const resolved = _notionPeopleLookup[person.id.toLowerCase().trim()];
        if (resolved) {
          console.log(`Resolved Notion person "${person.id}" → ${resolved}`);
          return { object: "user", id: resolved };
        }
        console.warn(`Could not resolve Notion person name: "${person.id}" — they may not have a Notion account`);
        return null;
      }
      return person;
    }).filter(Boolean);
  }
  return value;
}

export function sanitizeAllPeopleFields(properties: Record<string, unknown>): { properties: Record<string, unknown>; warnings: string[] } {
  const warnings: string[] = [];
  for (const [key, val] of Object.entries(properties)) {
    const pv = val as NotionPeopleValue | null | undefined;
    if (pv?.people !== undefined) {
      const before = pv.people?.map((p) => p?.id) ?? [];
      properties[key] = sanitizePeopleField(pv);
      const after = (properties[key] as NotionPeopleValue).people?.map((p) => p?.id) ?? [];
      const dropped = before.filter((id) => !isUUID(id ?? "") && !after.includes(_notionPeopleLookup[id?.toLowerCase()?.trim() ?? ""]));
      for (const name of dropped) {
        warnings.push(`Note: "${name}" does not have a Notion account and was excluded from the "${key}" field.`);
      }
    }
  }
  return { properties, warnings };
}

// ─── Notion: Household Members Loader ────────────────────────────────────────
export async function loadHouseholdMembers(svc?: SupabaseClient): Promise<{
  notionPeopleLookup: Record<string, string>;
  directoryTable: string;
}> {
  try {
    const sb = svc || (() => {
      const u = Deno.env.get("SUPABASE_URL"), k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      return u && k ? createClient(u, k) : null;
    })();
    if (!sb) return { notionPeopleLookup: _notionPeopleLookup, directoryTable: "" };
    const { data, error } = await sb.from("household_members").select("display_name, email, whatsapp_number, notion_uuid, supabase_uuid, aliases").eq("is_active", true);
    if (error || !data) { console.error("Failed to load household_members:", error); return { notionPeopleLookup: _notionPeopleLookup, directoryTable: "" }; }

    const lookup: Record<string, string> = {};
    const rows: string[] = [];

    for (const m of data) {
      if (m.notion_uuid) {
        lookup[m.display_name.toLowerCase()] = m.notion_uuid;
        for (const alias of m.aliases ?? []) {
          lookup[alias.toLowerCase()] = m.notion_uuid;
        }
      }
      rows.push(
        `| ${m.display_name.padEnd(9)} | ${(m.email || "—").padEnd(28)} | ${(m.whatsapp_number || "—").padEnd(15)} | ${(m.notion_uuid || "(not in Notion)").padEnd(38)} | ${(m.supabase_uuid || "(not signed up)").padEnd(38)} |`
      );
    }

    // Update module-level lookup
    setNotionPeopleLookup(lookup);
    console.log(`Loaded ${data.length} household members from DB, ${Object.keys(_notionPeopleLookup).length} Notion entries`);

    const directoryTable = rows.length > 0
      ? `\n\n── HOUSEHOLD PEOPLE DIRECTORY (live from database) ─────────────────────────\nUse these exact IDs/numbers when messaging or assigning in Notion. NEVER guess:\n\n| Name      | Email                         | WhatsApp        | Notion UUID                            | Supabase UUID                          |\n|-----------|-------------------------------|-----------------|----------------------------------------|----------------------------------------|\n${rows.join("\n")}\n`
      : "";

    return { notionPeopleLookup: _notionPeopleLookup, directoryTable };
  } catch (e) {
    console.error("loadHouseholdMembers failed:", e);
    return { notionPeopleLookup: _notionPeopleLookup, directoryTable: "" };
  }
}

// ─── Notion: Update Page ─────────────────────────────────────────────────────
export async function executeUpdateNotionPage(page_id: string, properties: Record<string, unknown>): Promise<string> {
  const NOTION_API_KEY = Deno.env.get("NOTION_API_KEY");
  if (!NOTION_API_KEY) return "Notion API key not configured.";

  try {
    const { properties: sanitized, warnings } = sanitizeAllPeopleFields(properties);
    const res = await fetch(`https://api.notion.com/v1/pages/${page_id}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties: sanitized }),
    });

    const data = await res.json();
    if (!res.ok) return `Failed to update page: ${data.message || res.status}`;

    let title = page_id;
    for (const key of Object.keys(data.properties || {})) {
      const prop = data.properties[key];
      if (prop?.type === "title" && prop.title?.length > 0) {
        title = prop.title.map((t: NotionRichText) => t.plain_text).join("");
        break;
      }
    }
    const note = warnings.length > 0 ? ` (${warnings.join(" ")})` : "";
    return `Successfully updated "${title}" (${page_id})${note}`;
  } catch (e) {
    console.error("Notion update error:", e);
    return `Error updating Notion page: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Notion: Batch Update ────────────────────────────────────────────────────
export async function executeBatchUpdateNotionPages(page_ids: string[], properties: Record<string, unknown>): Promise<string> {
  // Deep-clone properties per page to avoid mutation from sanitizeAllPeopleFields
  const results = await Promise.allSettled(
    page_ids.map((id) => executeUpdateNotionPage(id, JSON.parse(JSON.stringify(properties))))
  );
  // executeUpdateNotionPage never throws (returns error strings), so check result content
  const details = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : `Failed: ${page_ids[i]}`
  );
  const successes = details.filter(d => d.startsWith("Successfully")).length;
  const failures = details.length - successes;
  return JSON.stringify({ updated: successes, failed: failures, details });
}

// ─── Notion: Create Page ─────────────────────────────────────────────────────
export async function executeCreateNotionPage(database_id: string, properties: Record<string, unknown>): Promise<string> {
  const NOTION_API_KEY = Deno.env.get("NOTION_API_KEY");
  if (!NOTION_API_KEY) return "Notion API key not configured.";

  try {
    const cleanProperties: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(properties)) {
      const cleanKey = key
        .replace(/\u200B|\u200C|\u200D|\uFEFF|\u00A0/g, '')
        .replace(/^['"`]+|['"`]+$/g, '')
        .trim();
      cleanProperties[cleanKey] = val;
    }

    const { properties: sanitized, warnings } = sanitizeAllPeopleFields(cleanProperties);
    console.log("Creating Notion page with properties:", JSON.stringify(Object.keys(sanitized)));
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id },
        properties: sanitized,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Notion create error response:", JSON.stringify(data));
      return `Failed to create page: ${data.message || res.status}`;
    }

    let title = "Untitled";
    for (const key of Object.keys(data.properties || {})) {
      const prop = data.properties[key];
      if (prop?.type === "title" && prop.title?.length > 0) {
        title = prop.title.map((t: NotionRichText) => t.plain_text).join("");
        break;
      }
    }
    const note = warnings.length > 0 ? ` (${warnings.join(" ")})` : "";
    return `Successfully created "${title}" — ${data.url}${note}`;
  } catch (e) {
    console.error("Notion create error:", e);
    return `Error creating Notion page: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Notion: Get Database Schema ─────────────────────────────────────────────
export async function executeGetNotionDatabase(database_id: string): Promise<string> {
  const NOTION_API_KEY = Deno.env.get("NOTION_API_KEY");
  if (!NOTION_API_KEY) return "Notion API key not configured.";

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${database_id}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
      },
    });

    const data = await res.json();
    if (!res.ok) return `Failed to get database: ${data.message || res.status}`;

    type NotionSchemaProperty = {
      type: string;
      select?: { options?: NotionOption[] };
      multi_select?: { options?: NotionOption[] };
      status?: { options?: NotionOption[] };
    };
    const schema: Record<string, { type: string; options?: string[] }> = {};
    for (const [key, val] of Object.entries(data.properties || {})) {
      const v = val as NotionSchemaProperty;
      const entry: { type: string; options?: string[] } = { type: v.type };
      if (v.type === "select" && v.select?.options) {
        entry.options = v.select.options.map((o) => o.name);
      } else if (v.type === "multi_select" && v.multi_select?.options) {
        entry.options = v.multi_select.options.map((o) => o.name);
      } else if (v.type === "status" && v.status?.options) {
        entry.options = v.status.options.map((o) => o.name);
      }
      schema[key] = entry;
    }

    return JSON.stringify({ title: data.title?.[0]?.plain_text || database_id, schema });
  } catch (e) {
    console.error("Notion get database error:", e);
    return `Error getting Notion database: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Perplexity Search ───────────────────────────────────────────────────────
export async function executePerplexitySearch(query: string, deep = false): Promise<string> {
  const apiKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!apiKey) return "Perplexity API key not configured.";
  try {
    const model = deep ? "sonar-pro" : "sonar";
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: deep
            ? "You are a thorough research assistant. Provide comprehensive, well-structured, and well-cited answers with detailed analysis."
            : "You are a helpful search assistant. Provide concise, accurate, well-cited answers. Focus on facts and current information." },
          { role: "user", content: query },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return `Perplexity search error: ${res.status} ${errText.slice(0, 200)}`;
    }
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content || "No response generated.";
    const citations: string[] = data.citations || [];
    let formatted = answer;
    if (citations.length > 0) {
      const citationBlock = citations.map((url: string, i: number) => `[${i + 1}] ${url}`).join("\n");
      formatted += `\n\n**Sources:**\n${citationBlock}`;
    }
    return JSON.stringify({ answer: formatted, citations, model });
  } catch (e) {
    return `Perplexity search error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Web Search (Firecrawl) ──────────────────────────────────────────────────
type FirecrawlSearchResult = { title?: string; url?: string; description?: string };

export async function executeWebSearch(query: string, limit = 10): Promise<string> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) return "Firecrawl API key not configured.";
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: Math.min(limit, 20) }),
    });
    const data = await res.json();
    if (!res.ok) return `Search failed: ${data.error || res.status}`;
    const results = (data.data || []).map((r: FirecrawlSearchResult) => ({
      title: r.title || "Untitled",
      url: r.url || "",
      description: r.description || "",
    }));
    return JSON.stringify({ count: results.length, results });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

// ─── Scrape Website (Firecrawl) ──────────────────────────────────────────────
export async function executeScrapeWebsite(url: string): Promise<string> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) return "Firecrawl API key not configured.";
  try {
    let formattedUrl = url.trim();
    if (!formattedUrl.startsWith("http://") && !formattedUrl.startsWith("https://")) {
      formattedUrl = `https://${formattedUrl}`;
    }
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url: formattedUrl, formats: ["markdown"], onlyMainContent: true }),
    });
    const data = await res.json();
    if (!res.ok) return `Scrape failed: ${data.error || res.status}`;
    const md = data.data?.markdown || data.markdown || "";
    const title = data.data?.metadata?.title || data.metadata?.title || url;
    const truncated = md.length > 8000 ? md.slice(0, 8000) + "\n\n...(truncated)" : md;
    return JSON.stringify({ title, url: formattedUrl, content: truncated });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

// ─── URL Validation ─────────────────────────────────────────────────────────
// Pings every URL in AI response text and strips/flags dead links.
// Uses HEAD requests with 5s timeouts to avoid blocking.

const URL_REGEX = /https?:\/\/[^\s)\]>"']+/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;

// Domains where the LLM commonly fabricates URLs (product pages, etc.)
const HIGH_RISK_DOMAINS = ['amazon.com', 'amzn.to', 'walmart.com', 'target.com', 'bestbuy.com', 'ebay.com', 'etsy.com'];

function isHighRiskUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return HIGH_RISK_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

async function pingUrl(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Use GET with range header for sites that block HEAD
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Janus-LinkChecker/1.0)' },
    });
    clearTimeout(timer);
    // 2xx/3xx = alive, 404/410 = dead, 403 = may be geo-blocked (treat as alive)
    if (res.status === 404 || res.status === 410) return false;
    // Some sites return 405 for HEAD — retry with GET
    if (res.status === 405 || res.status === 403) {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
      const res2 = await fetch(url, {
        method: 'GET',
        signal: controller2.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Janus-LinkChecker/1.0)',
          'Range': 'bytes=0-0',
        },
      });
      clearTimeout(timer2);
      if (res2.status === 404 || res2.status === 410) return false;
      // For Amazon specifically, check if we got redirected to a "dog page" (404 equivalent)
      const finalUrl = res2.url || url;
      if (finalUrl.includes('/errors/') || finalUrl.includes('/gp/product/') === false && url.includes('/dp/')) {
        // Amazon sometimes redirects dead products to search or error pages
        const body = await res2.text();
        if (body.includes("Page not found") || body.includes("looking for something") || body.includes("Sorry, we couldn")) return false;
      }
      return res2.ok;
    }
    return res.ok;
  } catch {
    // Network error / timeout — treat as potentially alive (don't strip valid links due to transient errors)
    return true;
  }
}

/**
 * Extracts all unique URLs from text (both markdown links and bare URLs).
 */
function extractUrls(text: string): Set<string> {
  const allUrls = new Set<string>();
  let match;
  const mdRegex = new RegExp(MARKDOWN_LINK_REGEX.source, 'g');
  while ((match = mdRegex.exec(text)) !== null) {
    allUrls.add(match[2]);
  }
  const bareRegex = new RegExp(URL_REGEX.source, 'g');
  while ((match = bareRegex.exec(text)) !== null) {
    allUrls.add(match[0].replace(/[.,;:!?)]+$/, '')); // strip trailing punctuation
  }
  return allUrls;
}

/**
 * Replaces dead URLs in text with "(link unavailable)" labels.
 */
function replaceDeadUrls(text: string, deadUrls: string[]): string {
  let cleaned = text;
  for (const deadUrl of deadUrls) {
    const escaped = deadUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const mdPattern = new RegExp(`\\[([^\\]]+)\\]\\(${escaped}\\)`, 'g');
    cleaned = cleaned.replace(mdPattern, '**$1** _(link unavailable — search for this product directly)_');
    const barePattern = new RegExp(`(?<!\\()${escaped}(?!\\))`, 'g');
    cleaned = cleaned.replace(barePattern, '_(link unavailable)_');
  }
  return cleaned;
}

// Domains to skip validation (always trusted — e.g. Google Docs links we generate)
const TRUSTED_DOMAINS = ['docs.google.com', 'drive.google.com', 'calendar.google.com', 'notion.so', 'example.com', 'janus.ai'];

function isTrustedUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return TRUSTED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

/**
 * Validates all URLs in AI response text and replaces dead links.
 * - Markdown links: [text](dead-url) → [text] (link unavailable)
 * - Bare URLs: dead-url → (link unavailable)
 * - In chat mode (default): only pings "high risk" domains for speed.
 * - In strict mode (validateAll=true): pings ALL non-trusted URLs.
 *   Use strict mode for emails and research reports where broken links are unacceptable.
 * - Returns { text, deadCount, deadUrls } so callers can log/report.
 */
export async function validateAndCleanURLs(text: string, validateAll = false): Promise<{ text: string; deadCount: number; deadUrls: string[] }> {
  const allUrls = extractUrls(text);
  if (allUrls.size === 0) return { text, deadCount: 0, deadUrls: [] };

  // In strict mode, validate ALL URLs except trusted domains.
  // In default mode, only validate high-risk e-commerce domains.
  const urlsToCheck = Array.from(allUrls).filter(url =>
    validateAll ? !isTrustedUrl(url) : isHighRiskUrl(url)
  );
  if (urlsToCheck.length === 0) return { text, deadCount: 0, deadUrls: [] };

  console.log(`[URLCheck] Validating ${urlsToCheck.length} URL(s) (strict=${validateAll})...`);

  const results = await Promise.all(
    urlsToCheck.map(async (url) => {
      const alive = await pingUrl(url);
      console.log(`[URLCheck] ${url} → ${alive ? 'OK' : 'DEAD'}`);
      return { url, alive };
    })
  );

  const deadUrls = results.filter(r => !r.alive).map(r => r.url);
  if (deadUrls.length === 0) return { text, deadCount: 0, deadUrls: [] };

  console.log(`[URLCheck] Found ${deadUrls.length} dead URL(s), cleaning response...`);
  const cleaned = replaceDeadUrls(text, deadUrls);
  return { text: cleaned, deadCount: deadUrls.length, deadUrls };
}

/**
 * Validates URLs in email/research text — strict mode (ALL URLs checked).
 * Emails must never contain broken links.
 */
export async function validateEmailURLs(text: string): Promise<{ text: string; deadCount: number; deadUrls: string[] }> {
  return validateAndCleanURLs(text, true);
}

// ─── Shopping Cart ───────────────────────────────────────────────────────────
export async function executeSaveToCart(
  svc: SupabaseClient, userId: string, platform: string,
  productName: string, productUrl?: string, price?: string,
  quantity?: number, notes?: string,
): Promise<string> {
  try {
    const { error } = await svc.from("shopping_cart_items").insert({
      user_id: userId,
      platform: platform.toLowerCase(),
      product_name: productName,
      product_url: productUrl || null,
      price: price || null,
      quantity: quantity || 1,
      notes: notes || null,
      added_by: "janus",
    });
    if (error) return `Failed to save: ${error.message}`;
    return `Added "${productName}" to your ${platform} cart.`;
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeViewCart(
  svc: SupabaseClient, userId: string, platform?: string,
): Promise<string> {
  try {
    let query = svc.from("shopping_cart_items").select("platform, product_name, product_url, price, quantity, notes").eq("user_id", userId).eq("status", "pending").order("created_at", { ascending: false });
    if (platform) query = query.eq("platform", platform.toLowerCase());
    const { data, error } = await query;
    if (error) return `Failed: ${error.message}`;
    if (!data || data.length === 0) return platform ? `Your ${platform} cart is empty.` : "Your shopping cart is empty.";
    type CartItemRow = { platform: string; product_name: string; product_url: string | null; price: string | null; quantity: number; notes: string | null };
    const items = data.map((item: CartItemRow) => ({
      platform: item.platform,
      name: item.product_name,
      url: item.product_url,
      price: item.price,
      qty: item.quantity,
      notes: item.notes,
    }));
    return JSON.stringify({ count: items.length, items });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeClearCart(
  svc: SupabaseClient, userId: string, platform?: string,
): Promise<string> {
  try {
    let query = svc.from("shopping_cart_items").update({ status: "cleared" }).eq("user_id", userId).eq("status", "pending");
    if (platform) query = query.eq("platform", platform.toLowerCase());
    const { error } = await query;
    if (error) return `Failed: ${error.message}`;
    return platform ? `Cleared your ${platform} cart.` : "Cleared your entire shopping cart.";
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

// ─── Memory Tools ────────────────────────────────────────────────────────────
const MEMORY_LIMIT = 200;

export async function executeRememberFact(
  svc: SupabaseClient, userId: string, key: string, value: string, context?: string,
): Promise<string> {
  try {
    const { error } = await svc
      .from("janus_memory")
      .upsert({ user_id: userId, key, value, context: context || null }, { onConflict: "user_id,key" });
    if (error) return `Failed to save memory: ${error.message}`;

    // LRU eviction: if over the limit, delete the oldest (least-recently-updated) facts
    const { count } = await svc
      .from("janus_memory")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (count && count > MEMORY_LIMIT) {
      const excess = count - MEMORY_LIMIT;
      const { data: oldest } = await svc
        .from("janus_memory")
        .select("id")
        .eq("user_id", userId)
        .order("updated_at", { ascending: true })
        .limit(excess);
      if (oldest && oldest.length > 0) {
        await svc
          .from("janus_memory")
          .delete()
          .in("id", oldest.map((r: { id: string }) => r.id));
      }
    }

    return `Remembered: ${key} = ${value}`;
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeRecallFacts(
  svc: SupabaseClient, userId: string, keySearch?: string,
): Promise<string> {
  try {
    let query = svc.from("janus_memory").select("key, value, context, updated_at").eq("user_id", userId).order("key");
    if (keySearch) query = query.ilike("key", `${keySearch}%`);
    const { data, error } = await query;
    if (error) return `Failed to recall: ${error.message}`;
    if (!data || data.length === 0) return keySearch ? `No memories found matching "${keySearch}".` : "No permanent memories stored yet.";
    return JSON.stringify({ count: data.length, facts: data.map((m: { key: string; value: string; context: string | null; updated_at: string }) => ({ key: m.key, value: m.value, context: m.context, updated: m.updated_at })) });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

// ─── Tesla ───────────────────────────────────────────────────────────────────
const TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_AUTH_BASE = "https://fleet-auth.prd.vn.cloud.tesla.com";

export { TESLA_API_BASE, TESLA_AUTH_BASE };

export type TeslaTokenRow = { user_id: string; access_token: string; refresh_token: string; token_expires_at: string };

export async function refreshTeslaToken(svc: SupabaseClient, tokenRow: TeslaTokenRow): Promise<string> {
  const expiresAt = new Date(tokenRow.token_expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) return tokenRow.access_token;
  const clientId = Deno.env.get("TESLA_CLIENT_ID")!;
  const clientSecret = Deno.env.get("TESLA_CLIENT_SECRET")!;
  const res = await fetch(`${TESLA_AUTH_BASE}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: tokenRow.refresh_token }),
  });
  if (!res.ok) throw new Error("Failed to refresh Tesla token");
  const data = await res.json();
  await svc.from("tesla_tokens").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokenRow.refresh_token,
    token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
  }).eq("user_id", tokenRow.user_id);
  return data.access_token;
}

export function sanitizeGoogleFileUrls(text: string, toolCalls: { name?: string; result?: string }[]): string {
  const fileToolResults = toolCalls
    .filter(tc => tc.name === "create_google_file" && tc.result && !tc.result.startsWith("TOOL_ERROR"))
    .map(tc => tc.result ?? "");
  const verifiedUrls = new Set<string>();
  for (const result of fileToolResults) {
    const match = result.match(/https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/[A-Za-z0-9_-]+/);
    if (match) verifiedUrls.add(match[0]);
  }
  return text.replace(
    /https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/[A-Za-z0-9_-]+[^\s)>\]]*/g,
    (url) => {
      const base = url.match(/https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/[A-Za-z0-9_-]+/)?.[0];
      if (base && verifiedUrls.has(base)) return url;
      return "[link removed — file creation failed, please retry]";
    }
  );
}
