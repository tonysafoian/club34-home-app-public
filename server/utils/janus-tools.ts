import { createClient, getServiceClient, type SupabaseClient } from "./supabase.js";
import { breakers, CircuitOpenError, toolErrorForOpenCircuit } from "../lib/breakers.js";
import { getGoogleServiceToken } from "./google-jwt.js";

export { createClient, getServiceClient, getGoogleServiceToken };
export type { SupabaseClient };

const AUDIT_ALLOWED_COLUMNS = new Set([
  'edge_function', 'category', 'event_type', 'severity', 'actor_id',
  'actor_name', 'channel', 'summary', 'detail', 'status', 'ip_address',
  'user_agent', 'request_id', 'correlation_id', 'metadata',
  'actionable',
]);

export async function logAudit(edgeFunction: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const { query } = await import('../lib/db.js');
    // Auto-stamp the ALS-bound correlation id when caller didn't pass one.
    const enriched: Record<string, unknown> = { ...entry };
    if (!('correlation_id' in enriched)) {
      const { getCurrentCorrelationId } = await import('../lib/correlation.js');
      const id = getCurrentCorrelationId();
      if (id) enriched.correlation_id = id;
    }
    const safeEntries = Object.entries(enriched).filter(([k]) => AUDIT_ALLOWED_COLUMNS.has(k));
    const keys = ['edge_function', ...safeEntries.map(([k]) => k)];
    const values = [edgeFunction, ...safeEntries.map(([, v]) => typeof v === 'object' && v !== null ? JSON.stringify(v) : v)];
    const ph = keys.map((_, i) => `$${i + 1}`);
    await query(`INSERT INTO system_audit_log (${keys.join(', ')}) VALUES (${ph.join(', ')})`, values);
  } catch (e) { console.error("Audit log failed:", e); }
}

export async function enqueueFailedJob(
  functionName: string,
  error: unknown,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    const { query } = await import('../lib/db.js');
    const { getCurrentCorrelationId } = await import('../lib/correlation.js');
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorDetail = error instanceof Error
      ? { stack: error.stack, name: error.name }
      : { raw: String(error) };
    const correlationId = getCurrentCorrelationId() || null;
    await query(
      `INSERT INTO failed_jobs (function_name, error_message, error_detail, payload, correlation_id) VALUES ($1, $2, $3, $4, $5)`,
      [functionName, errorMessage.slice(0, 2000), JSON.stringify(errorDetail), JSON.stringify(payload || {}), correlationId]
    );
  } catch (e) { console.error("Failed to enqueue DLQ job:", e); }
}

const FALLBACK_ALERT_PHONE = "13104717979";
let _cachedAlertPhone: string | null = null;
let _alertPhoneFetchedAt = 0;
const ALERT_PHONE_CACHE_TTL = 10 * 60_000;

export async function getAlertPhoneNumber(): Promise<string> {
  if (_cachedAlertPhone && Date.now() - _alertPhoneFetchedAt < ALERT_PHONE_CACHE_TTL) {
    return _cachedAlertPhone;
  }
  try {
    const { query } = await import('../lib/db.js');
    const { rows } = await query<{ value: string }>(`SELECT value FROM system_configs WHERE key = 'alert_phone_number' LIMIT 1`);
    if (rows.length > 0 && rows[0].value) {
      _cachedAlertPhone = rows[0].value;
      _alertPhoneFetchedAt = Date.now();
      return _cachedAlertPhone!;
    }
  } catch {}
  const envPhone = process.env.ALERT_PHONE_NUMBER;
  if (envPhone) {
    _cachedAlertPhone = envPhone;
    _alertPhoneFetchedAt = Date.now();
    return envPhone;
  }
  return FALLBACK_ALERT_PHONE;
}

const _alertCooldowns: Record<string, number> = {};
const ALERT_COOLDOWN_MS = 30 * 60_000;

export async function sendAutomationFailureAlert(
  functionName: string,
  errorSummary: string,
): Promise<void> {
  const now = Date.now();
  if (_alertCooldowns[functionName] && now - _alertCooldowns[functionName] < ALERT_COOLDOWN_MS) return;
  _alertCooldowns[functionName] = now;

  const alertPhone = await getAlertPhoneNumber();
  const msg = `⚠️ ${functionName} failed: ${errorSummary.slice(0, 200)}`;
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
    await fetch(`${baseUrl}/api/janus/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to: alertPhone, message: msg }),
    });
  } catch (e) { console.error("Failure alert send failed:", e); }
}

const promptCache: Record<string, { content: string; fetchedAt: number }> = {};
const PROMPT_CACHE_TTL = 5 * 60_000;

export async function loadPrompt(slug: string, fallback: string, svc?: SupabaseClient): Promise<string> {
  const cached = promptCache[slug];
  if (cached && Date.now() - cached.fetchedAt < PROMPT_CACHE_TTL) return cached.content;
  try {
    const sb = svc || getServiceClient();
    const { data } = await sb.from("system_prompts").select("content").eq("slug", slug).single();
    const result = data?.content || fallback;
    promptCache[slug] = { content: result, fetchedAt: Date.now() };
    return result;
  } catch (e) {
    console.error(`Failed to load prompt "${slug}", using fallback:`, e);
    return fallback;
  }
}

const MAX_MESSAGE_LENGTH = 1500;

export async function loadConversationHistory(
  userId: string, limit = 30, svc?: SupabaseClient
): Promise<{ role: string; content: string }[]> {
  try {
    const sb = svc || getServiceClient();
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

export async function loadMemories(
  userId: string, svc?: SupabaseClient, limit = 25
): Promise<{ key: string; value: string; context?: string }[]> {
  try {
    const sb = svc || getServiceClient();
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

export async function logConversation(
  svc: SupabaseClient,
  userId: string, displayName: string, userRole: string,
  userMessage: string, assistantResponse: string,
  toolCalls: any[], channel: string,
): Promise<void> {
  try {
    const { getCurrentCorrelationId } = await import("../lib/correlation.js");
    const correlationId = getCurrentCorrelationId() || null;
    // Sanitize toolCalls through a JSON round-trip to strip any non-serializable
    // values (undefined, functions, circular refs) before the JSONB insert.
    let safeToolCalls: any[] = [];
    try { safeToolCalls = JSON.parse(JSON.stringify(toolCalls || [])); } catch { safeToolCalls = []; }
    const { error } = await svc.from("janus_chat_logs").insert({
      user_id: userId,
      user_display_name: displayName || "UNKNOWN",
      user_role: userRole,
      user_message: userMessage.slice(0, 5000),
      assistant_response: assistantResponse.slice(0, 10000),
      tool_calls: safeToolCalls,
      channel,
      correlation_id: correlationId,
    });
    if (error) console.error("[logConversation] janus_chat_logs insert error:", error.message);
  } catch (e) {
    console.error("[logConversation] Failed to log conversation:", e);
  }
}

export async function extractImageDescription(imageBase64: string, imageMimeType: string): Promise<string | null> {
  try {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) return null;
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${imageMimeType};base64,${imageBase64}` },
              },
              {
                type: "text",
                text: "Describe the key content of this image in 1–3 concise sentences. Focus on extracting important details: names, dates, times, flight numbers, locations, amounts, or any other specific data visible. If it's a document or itinerary, list the key facts. Be factual and specific.",
              },
            ],
          },
        ],
        stream: false,
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const description = (data.choices?.[0]?.message?.content || "").trim();
    return description || null;
  } catch (e) {
    console.error("extractImageDescription error:", e);
    return null;
  }
}

export async function executeSendEmail(
  to: string, subject: string, body: string,
  auditChannel = "chat", auditEdgeFunction = "janus-chat",
): Promise<string> {
  try {
    const { text: cleanedBody, deadCount, deadUrls } = await validateEmailURLs(body);
    if (deadCount > 0) {
      console.log(`[Email-URLCheck] Stripped ${deadCount} dead URL(s) from email to ${to}: ${deadUrls.join(', ')}`);
      body = cleanedBody;
    }
  } catch (e) { console.error("[Email-URLCheck] URL validation failed (sending anyway):", e); }

  try {
    const { sendGmailRaw, getSaKey, logEmail } = await import('../lib/helpers.js');
    const saKey = getSaKey();
    const textBody = body.replace(/<[^>]*>/g, '');
    const sent = await sendGmailRaw(saKey, to, subject, body, textBody);
    const result = sent ? `Email sent to ${to}: ${subject}` : `Error: email send failed for ${to}`;
    const success = !result.toLowerCase().includes("error");
    logAudit(auditEdgeFunction, { category: "janus", event_type: "email_sent", severity: success ? "info" : "error", actor_id: "system", actor_name: "Janus", channel: auditChannel, summary: `Email to ${to}: ${subject}`, detail: { to, subject, body_length: body.length }, status: success ? "success" : "error" });
    await logEmail("janus_chat", subject, [to], body, success ? "sent" : "error", success ? undefined : result);
    return result;
  } catch (e) {
    console.error("Email tool error:", e);
    const { logEmail } = await import('../lib/helpers.js');
    await logEmail("janus_chat", subject, [to], body, "error", e instanceof Error ? e.message : "unknown");
    logAudit(auditEdgeFunction, { category: "janus", event_type: "email_sent", severity: "error", actor_id: "system", actor_name: "Janus", channel: auditChannel, summary: `Email to ${to} failed: ${e instanceof Error ? e.message : "unknown"}`, detail: { to, subject, body_length: body.length }, status: "error" });
    return `Error sending email: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeGmailSearch(query: string, maxResults = 10): Promise<string> {
  try {
    const accessToken = await getGoogleServiceToken(["https://mail.google.com/"], "admin@example.com");
    const params = new URLSearchParams({ q: query, maxResults: String(Math.min(maxResults, 20)) });
    const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const listData = await listRes.json();
    if (!listRes.ok) return `Gmail search failed: ${listData.error?.message || listRes.status}`;
    if (!listData.messages?.length) return `No emails found matching "${query}".`;

    const msgIds: string[] = listData.messages.map((m: { id: string }) => m.id);
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
      const messages = await Promise.all(msgIds.map(async (id) => {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!msgRes.ok) return null;
        const msg = await msgRes.json();
        const headers: any[] = msg.payload?.headers || [];
        return { id: msg.id, from: headers.find((h: any) => h.name === "From")?.value || "", subject: headers.find((h: any) => h.name === "Subject")?.value || "(No subject)", date: headers.find((h: any) => h.name === "Date")?.value || "", snippet: msg.snippet || "", unread: msg.labelIds?.includes("UNREAD") || false };
      }));
      return JSON.stringify({ count: messages.filter(Boolean).length, query, results: messages.filter(Boolean) });
    }

    const batchText = await batchRes.text();
    const respBoundary = batchRes.headers.get("Content-Type")?.match(/boundary=([^\s;]+)/)?.[1] || boundary;
    const parts = batchText.split(`--${respBoundary}`).filter(p => p.includes("HTTP/"));
    const results = parts.map(part => {
      try {
        const jsonMatch = part.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        const msg = JSON.parse(jsonMatch[0]);
        const headers: any[] = msg.payload?.headers || [];
        return { id: msg.id, from: headers.find((h: any) => h.name === "From")?.value || "", subject: headers.find((h: any) => h.name === "Subject")?.value || "(No subject)", date: headers.find((h: any) => h.name === "Date")?.value || "", snippet: msg.snippet || "", unread: msg.labelIds?.includes("UNREAD") || false };
      } catch { return null; }
    }).filter(Boolean);

    return JSON.stringify({ count: results.length, query, results });
  } catch (e) { return `Error searching Gmail: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeSendWhatsApp(
  to: string, message: string,
  auditChannel = "chat", auditEdgeFunction = "janus-chat",
): Promise<string> {
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
    const res = await fetch(`${baseUrl}/api/janus/whatsapp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

// All Notion fetches in this module go through the breaker. 4xx (auth /
// validation) errors pass through without tripping; 5xx and network
// errors count toward the failure threshold and open the circuit so
// dependent jobs return TOOL_ERROR fast instead of hammering Notion.
function notionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return breakers.notion.execute(() => fetch(input, init));
}

export async function executeQueryNotionDatabase(database_id: string, filter?: any): Promise<string> {
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return "Notion API key not configured.";

  try {
    const reqBody: any = { page_size: 30 };
    if (filter) reqBody.filter = filter;
    const res = await notionFetch(`https://api.notion.com/v1/databases/${database_id}/query`, {
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
    const pages = data.results || [];
    const summary = pages.map((p: any) => {
      const props: Record<string, any> = {};
      for (const [key, val] of Object.entries(p.properties || {})) {
        const v = val as any;
        if (v.type === "title") props[key] = v.title?.map((t: any) => t.plain_text).join("") || "";
        else if (v.type === "rich_text") props[key] = v.rich_text?.map((t: any) => t.plain_text).join("") || "";
        else if (v.type === "select") props[key] = v.select?.name || null;
        else if (v.type === "multi_select") props[key] = v.multi_select?.map((s: any) => s.name) || [];
        else if (v.type === "date") props[key] = v.date?.start || null;
        else if (v.type === "checkbox") props[key] = v.checkbox;
        else if (v.type === "number") props[key] = v.number;
        else if (v.type === "status") props[key] = v.status?.name || null;
        else if (v.type === "people") props[key] = v.people?.map((p: any) => p.name || p.id) || [];
        else if (v.type === "formula") props[key] = v.formula?.string || v.formula?.number || v.formula?.boolean || null;
        else if (v.type === "files") props[key] = v.files?.map((f: any) => f.external?.url || f.file?.url || f.name).filter(Boolean) || [];
      }
      return { id: p.id, url: p.url, ...props };
    });
    return JSON.stringify({ count: pages.length, pages: summary });
  } catch (e) {
    if (e instanceof CircuitOpenError) return toolErrorForOpenCircuit(e);
    console.error("Notion query error:", e);
    return `Error querying Notion: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

let _notionPeopleLookup: Record<string, string> = {
  "admin":   "00000000-0000-4000-a000-000000000001",
  "member":  "00000000-0000-4000-a000-000000000002",
  "staff":   "00000000-0000-4000-a000-000000000003",
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

export function sanitizePeopleField(value: any): any {
  if (value?.people && Array.isArray(value.people)) {
    value.people = value.people.map((person: any) => {
      if (person.id && !isUUID(person.id)) {
        const resolved = _notionPeopleLookup[person.id.toLowerCase().trim()];
        if (resolved) {
          console.log(`Resolved Notion person "${person.id}" → ${resolved}`);
          return { object: "user", id: resolved };
        }
        console.warn(`Could not resolve Notion person name: "${person.id}"`);
        return null;
      }
      return person;
    }).filter(Boolean);
  }
  return value;
}

export function sanitizeAllPeopleFields(properties: Record<string, any>): { properties: Record<string, any>; warnings: string[] } {
  const warnings: string[] = [];
  for (const [key, val] of Object.entries(properties)) {
    if ((val as any)?.people !== undefined) {
      const before = (val as any).people?.map((p: any) => p.id) ?? [];
      properties[key] = sanitizePeopleField(val);
      const after = (properties[key] as any).people?.map((p: any) => p.id) ?? [];
      const dropped = before.filter((id: string) => !isUUID(id) && !after.includes(_notionPeopleLookup[id?.toLowerCase()?.trim() ?? ""]));
      for (const name of dropped) {
        warnings.push(`Note: "${name}" does not have a Notion account and was excluded from the "${key}" field.`);
      }
    }
  }
  return { properties, warnings };
}

export async function loadHouseholdMembers(svc?: SupabaseClient): Promise<{
  notionPeopleLookup: Record<string, string>;
  directoryTable: string;
}> {
  try {
    const sb = svc || getServiceClient();
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

export async function executeUpdateNotionPage(page_id: string, properties: any): Promise<string> {
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return "Notion API key not configured.";
  try {
    let dbSchema: Record<string, any> = {};
    try {
      const pageRes = await notionFetch(`https://api.notion.com/v1/pages/${page_id}`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28" },
      });
      if (pageRes.ok) {
        const pageData = await pageRes.json();
        if (pageData.parent?.database_id) {
          const dbRes = await notionFetch(`https://api.notion.com/v1/databases/${pageData.parent.database_id}`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28" },
          });
          if (dbRes.ok) {
            const dbData = await dbRes.json();
            dbSchema = dbData.properties || {};
          } else { await dbRes.text(); }
        }
      } else { await pageRes.text(); }
    } catch { /* proceed without schema */ }

    const schemaKeys = Object.keys(dbSchema);
    let builtProperties: Record<string, any>;
    const skippedKeys: string[] = [];

    if (schemaKeys.length > 0) {
      builtProperties = {};
      for (const [inputKey, rawValue] of Object.entries(properties)) {
        const cleanKey = inputKey.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, '').replace(/^['"`]+|['"`]+$/g, '').trim();
        const resolvedKey = resolvePropertyName(cleanKey, schemaKeys);
        if (!resolvedKey) { skippedKeys.push(cleanKey); continue; }
        const propType = (dbSchema[resolvedKey] as any)?.type;
        builtProperties[resolvedKey] = propType ? coerceToNotionValue(rawValue, propType, dbSchema[resolvedKey]) : rawValue;
      }
    } else {
      builtProperties = properties;
    }

    const { properties: sanitized, warnings } = sanitizeAllPeopleFields(builtProperties);
    const res = await notionFetch(`https://api.notion.com/v1/pages/${page_id}`, {
      method: "PATCH",
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ properties: sanitized }),
    });
    const data = await res.json();
    if (!res.ok) return `Failed to update page: ${data.message || res.status}`;
    let title = page_id;
    for (const key of Object.keys(data.properties || {})) {
      const prop = data.properties[key];
      if (prop?.type === "title" && prop.title?.length > 0) {
        title = prop.title.map((t: any) => t.plain_text).join("");
        break;
      }
    }
    const notes: string[] = [];
    if (warnings.length > 0) notes.push(...warnings);
    if (skippedKeys.length > 0) notes.push(`Skipped unrecognized properties: ${skippedKeys.join(", ")}`);
    const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
    return `Successfully updated "${title}" (${page_id})${note}`;
  } catch (e) {
    if (e instanceof CircuitOpenError) return toolErrorForOpenCircuit(e);
    console.error("Notion update error:", e);
    return `Error updating Notion page: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeBatchUpdateNotionPages(page_ids: string[], properties: any): Promise<string> {
  const results = await Promise.allSettled(
    page_ids.map((id) => executeUpdateNotionPage(id, JSON.parse(JSON.stringify(properties))))
  );
  const details = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : `Failed: ${page_ids[i]}`
  );
  const successes = details.filter(d => d.startsWith("Successfully")).length;
  const failures = details.length - successes;
  return JSON.stringify({ updated: successes, failed: failures, details });
}

function resolvePropertyName(inputKey: string, schemaKeys: string[]): string | null {
  const clean = inputKey.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, '').replace(/^['"`]+|['"`]+$/g, '').trim();
  if (schemaKeys.includes(clean)) return clean;
  const lower = clean.toLowerCase();
  const match = schemaKeys.find(k => k.toLowerCase() === lower);
  if (match) return match;
  const underscored = lower.replace(/[\s-]+/g, '_');
  const match2 = schemaKeys.find(k => k.toLowerCase().replace(/[\s-]+/g, '_') === underscored);
  return match2 || null;
}

function coerceToNotionValue(rawValue: any, propType: string, propMeta: any): any {
  if (rawValue && typeof rawValue === 'object' && rawValue[propType] !== undefined) return rawValue;

  switch (propType) {
    case 'title': {
      const text = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
      return { title: [{ text: { content: text } }] };
    }
    case 'rich_text': {
      const text = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
      return { rich_text: [{ text: { content: text } }] };
    }
    case 'number': {
      const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      return { number: isNaN(num) ? null : num };
    }
    case 'select': {
      const name = typeof rawValue === 'string' ? rawValue : rawValue?.name || String(rawValue ?? '');
      return { select: { name } };
    }
    case 'multi_select': {
      const items = Array.isArray(rawValue) ? rawValue : [rawValue];
      return { multi_select: items.map((i: any) => ({ name: typeof i === 'string' ? i : (i?.name || String(i)) })) };
    }
    case 'status': {
      const name = typeof rawValue === 'string' ? rawValue : rawValue?.name || String(rawValue ?? '');
      return { status: { name } };
    }
    case 'date': {
      if (typeof rawValue === 'string') return { date: { start: rawValue } };
      if (rawValue?.start) return { date: rawValue };
      return { date: { start: String(rawValue) } };
    }
    case 'checkbox': {
      return { checkbox: rawValue === true || rawValue === 'true' || rawValue === 1 };
    }
    case 'url': {
      return { url: typeof rawValue === 'string' ? rawValue : String(rawValue ?? '') };
    }
    case 'email': {
      return { email: typeof rawValue === 'string' ? rawValue : String(rawValue ?? '') };
    }
    case 'phone_number': {
      return { phone_number: typeof rawValue === 'string' ? rawValue : String(rawValue ?? '') };
    }
    case 'people': {
      return rawValue;
    }
    case 'relation': {
      const ids = Array.isArray(rawValue) ? rawValue : [rawValue];
      return { relation: ids.map((id: any) => ({ id: typeof id === 'string' ? id : id?.id || String(id) })) };
    }
    default:
      return rawValue;
  }
}

export async function executeCreateNotionPage(database_id: string, properties: any): Promise<string> {
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return "Notion API key not configured.";
  try {
    const schemaRes = await notionFetch(`https://api.notion.com/v1/databases/${database_id}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28" },
    });
    let dbSchema: Record<string, any> = {};
    if (schemaRes.ok) {
      const dbData = await schemaRes.json();
      dbSchema = dbData.properties || {};
    } else {
      console.warn("Could not fetch Notion DB schema — proceeding with raw properties");
      await schemaRes.text();
    }
    const schemaKeys = Object.keys(dbSchema);

    const builtProperties: Record<string, any> = {};
    const skippedKeys: string[] = [];
    for (const [inputKey, rawValue] of Object.entries(properties)) {
      const cleanKey = inputKey.replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, '').replace(/^['"`]+|['"`]+$/g, '').trim();

      if (schemaKeys.length > 0) {
        const resolvedKey = resolvePropertyName(cleanKey, schemaKeys);
        if (!resolvedKey) {
          skippedKeys.push(cleanKey);
          continue;
        }
        const propType = (dbSchema[resolvedKey] as any)?.type;
        if (propType) {
          builtProperties[resolvedKey] = coerceToNotionValue(rawValue, propType, dbSchema[resolvedKey]);
        } else {
          builtProperties[resolvedKey] = rawValue;
        }
      } else {
        builtProperties[cleanKey] = rawValue;
      }
    }

    const { properties: sanitized, warnings } = sanitizeAllPeopleFields(builtProperties);
    console.log("Creating Notion page with properties:", JSON.stringify(Object.keys(sanitized)));
    if (skippedKeys.length > 0) {
      console.warn("Skipped unrecognized Notion properties:", skippedKeys.join(", "));
    }

    const res = await notionFetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { database_id }, properties: sanitized }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error("Notion create error response:", JSON.stringify(data));
      const schemaHint = schemaKeys.length > 0
        ? ` Available properties: ${schemaKeys.map(k => `"${k}" (${(dbSchema[k] as any)?.type})`).join(", ")}.`
        : "";
      return `Failed to create page: ${data.message || res.status}.${schemaHint}`;
    }
    let title = "Untitled";
    for (const key of Object.keys(data.properties || {})) {
      const prop = data.properties[key];
      if (prop?.type === "title" && prop.title?.length > 0) {
        title = prop.title.map((t: any) => t.plain_text).join("");
        break;
      }
    }
    const notes: string[] = [];
    if (warnings.length > 0) notes.push(...warnings);
    if (skippedKeys.length > 0) notes.push(`Skipped unrecognized properties: ${skippedKeys.join(", ")}`);
    const note = notes.length > 0 ? ` (${notes.join("; ")})` : "";
    return `Successfully created "${title}" — ${data.url}${note}`;
  } catch (e) {
    if (e instanceof CircuitOpenError) return toolErrorForOpenCircuit(e);
    console.error("Notion create error:", e);
    return `Error creating Notion page: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeGetNotionDatabase(database_id: string): Promise<string> {
  const NOTION_API_KEY = process.env.NOTION_API_KEY;
  if (!NOTION_API_KEY) return "Notion API key not configured.";
  try {
    const res = await notionFetch(`https://api.notion.com/v1/databases/${database_id}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28" },
    });
    const data = await res.json();
    if (!res.ok) return `Failed to get database: ${data.message || res.status}`;
    const schema: Record<string, any> = {};
    for (const [key, val] of Object.entries(data.properties || {})) {
      const v = val as any;
      const entry: any = { type: v.type };
      if (v.type === "select" && v.select?.options) entry.options = v.select.options.map((o: any) => o.name);
      else if (v.type === "multi_select" && v.multi_select?.options) entry.options = v.multi_select.options.map((o: any) => o.name);
      else if (v.type === "status" && v.status?.options) entry.options = v.status.options.map((o: any) => o.name);
      schema[key] = entry;
    }
    return JSON.stringify({ title: data.title?.[0]?.plain_text || database_id, schema });
  } catch (e) {
    if (e instanceof CircuitOpenError) return toolErrorForOpenCircuit(e);
    console.error("Notion get database error:", e);
    return `Error getting Notion database: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export { executePerplexitySearch } from "../services/perplexity.js";

export async function executeWebSearch(query: string, limit = 10): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return "Firecrawl API key not configured.";
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: Math.min(limit, 20) }),
    });
    const data = await res.json();
    if (!res.ok) return `Search failed: ${data.error || res.status}`;
    const results = (data.data || []).map((r: any) => ({
      title: r.title || "Untitled",
      url: r.url || "",
      description: r.description || "",
    }));
    return JSON.stringify({ count: results.length, results });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeScrapeWebsite(url: string): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
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

const URL_REGEX = /https?:\/\/[^\s)\]>"']+/g;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
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
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Club34-LinkChecker/1.0)' },
    });
    clearTimeout(timer);
    if (res.status === 404 || res.status === 410) return false;
    if (res.status === 405 || res.status === 403) {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
      const res2 = await fetch(url, {
        method: 'GET',
        signal: controller2.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Club34-LinkChecker/1.0)', 'Range': 'bytes=0-0' },
      });
      clearTimeout(timer2);
      if (res2.status === 404 || res2.status === 410) return false;
      const finalUrl = res2.url || url;
      if (finalUrl.includes('/errors/') || finalUrl.includes('/gp/product/') === false && url.includes('/dp/')) {
        const body = await res2.text();
        if (body.includes("Page not found") || body.includes("looking for something") || body.includes("Sorry, we couldn")) return false;
      }
      return res2.ok;
    }
    return res.ok;
  } catch {
    return true;
  }
}

function extractUrls(text: string): Set<string> {
  const allUrls = new Set<string>();
  let match;
  const mdRegex = new RegExp(MARKDOWN_LINK_REGEX.source, 'g');
  while ((match = mdRegex.exec(text)) !== null) {
    allUrls.add(match[2]);
  }
  const bareRegex = new RegExp(URL_REGEX.source, 'g');
  while ((match = bareRegex.exec(text)) !== null) {
    allUrls.add(match[0].replace(/[.,;:!?)]+$/, ''));
  }
  return allUrls;
}

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

const TRUSTED_DOMAINS = ['docs.google.com', 'drive.google.com', 'calendar.google.com', 'notion.so', process.env.APP_DOMAIN || 'example.com', 'club34.ai'];

function isTrustedUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    return TRUSTED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

export async function validateAndCleanURLs(text: string, validateAll = false): Promise<{ text: string; deadCount: number; deadUrls: string[] }> {
  const allUrls = extractUrls(text);
  if (allUrls.size === 0) return { text, deadCount: 0, deadUrls: [] };
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

export async function validateEmailURLs(text: string): Promise<{ text: string; deadCount: number; deadUrls: string[] }> {
  return validateAndCleanURLs(text, true);
}

export async function executeSaveToCart(
  svc: SupabaseClient, userId: string, platform: string,
  productName: string, productUrl?: string, price?: string,
  quantity?: number, notes?: string,
): Promise<string> {
  try {
    const { error } = await svc.from("shopping_cart_items").insert({
      user_id: userId, platform: platform.toLowerCase(), product_name: productName,
      product_url: productUrl || null, price: price || null, quantity: quantity || 1,
      notes: notes || null, added_by: "janus",
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
    const items = data.map((item: any) => ({
      platform: item.platform, name: item.product_name, url: item.product_url,
      price: item.price, qty: item.quantity, notes: item.notes,
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

const MEMORY_LIMIT = 200;
// Semantic recall threshold. Cosine similarity = 1 - cosine distance; rows
// below this are too unrelated to surface as a "match".
const SEMANTIC_SIMILARITY_FLOOR = 0.65;
const SEMANTIC_RECALL_LIMIT = 5;

export async function executeRememberFact(
  svc: SupabaseClient, userId: string, key: string, value: string, context?: string, pinned?: boolean,
): Promise<string> {
  // The per-user ANN recall cache holds values + embeddings; drop it on any
  // write so same-instance remember → recall is never stale.
  const invalidateRecallCache = async () => {
    try {
      const { invalidateMemoryIndex } = await import("../lib/memory-index.js");
      invalidateMemoryIndex(userId);
    } catch { /* cache invalidation is best-effort */ }
  };
  try {
    const isPinned = pinned === true;
    // Upsert the row first so we always persist the fact even if the
    // embedding call later fails.
    const { error } = await svc
      .from("janus_memory")
      .upsert(
        { user_id: userId, key, value, context: context || null, pinned: isPinned },
        { onConflict: "user_id,key" },
      );
    if (error) return `Failed to save memory: ${error.message}`;

    // Best-effort embed-on-write. Failures here are logged but never
    // surfaced — the row already exists and is recallable by keyword.
    try {
      const { embedText, toPgVectorLiteral } = await import("./embeddings.js");
      const embedding = await embedText(
        `${key} ${value} ${context ?? ""}`.trim(),
      );
      if (embedding) {
        const { query } = await import("../lib/db.js");
        await query(
          `UPDATE janus_memory SET embedding = $1::vector WHERE user_id = $2 AND key = $3`,
          [toPgVectorLiteral(embedding), userId, key],
        );
      }
    } catch (e) {
      console.warn(
        `[remember_fact] embed failed for ${userId}/${key}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // FIFO eviction — pinned rows are immune. We count only unpinned rows
    // against the cap, matching the prior "soft" semantics: pinning a fact
    // does not push the cap higher, it just removes that row from the
    // eviction pool.
    const { count } = await svc
      .from("janus_memory")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("pinned", false);
    if (count && count > MEMORY_LIMIT) {
      const excess = count - MEMORY_LIMIT;
      const { data: oldest } = await svc
        .from("janus_memory")
        .select("id")
        .eq("user_id", userId)
        .eq("pinned", false)
        .order("updated_at", { ascending: true })
        .limit(excess);
      if (oldest && oldest.length > 0) {
        await svc.from("janus_memory").delete().in("id", oldest.map((r: any) => r.id));
      }
    }
    await invalidateRecallCache();
    return `Remembered: ${key} = ${value}${isPinned ? " (pinned)" : ""}`;
  } catch (e) {
    // The upsert may have landed before the failure — invalidate anyway.
    await invalidateRecallCache();
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeRecallFacts(
  svc: SupabaseClient, userId: string, keySearch?: string,
): Promise<string> {
  try {
    let query = svc.from("janus_memory").select("key, value, context, updated_at, pinned").eq("user_id", userId).order("key");
    if (keySearch) query = query.ilike("key", `${keySearch}%`);
    const { data, error } = await query;
    if (error) return `Failed to recall: ${error.message}`;
    if (data && data.length > 0) {
      return JSON.stringify({
        path: "keyword",
        count: data.length,
        facts: data.map((m: any) => ({
          key: m.key,
          value: m.value,
          context: m.context,
          pinned: m.pinned === true,
          updated: m.updated_at,
        })),
      });
    }

    // Keyword miss — try semantic fallback when there's something to embed.
    if (keySearch && keySearch.trim()) {
      try {
        const { embedText } = await import("./embeddings.js");
        const embedding = await embedText(keySearch.trim());
        if (embedding) {
          // ANN via the in-process per-user HNSW index (server/lib/memory-index.ts);
          // falls back internally to the exact pgvector sequential scan. The
          // DB-level ANN index is banned here — Replit's publish-diff cannot
          // represent pgvector operator classes (see migration 0046).
          const { semanticRecall } = await import("../lib/memory-index.js");
          const rows = await semanticRecall(userId, embedding, SEMANTIC_RECALL_LIMIT);
          const matches = rows.filter(
            (r) => typeof r.similarity === "number" && r.similarity > SEMANTIC_SIMILARITY_FLOOR,
          );
          if (matches.length > 0) {
            return JSON.stringify({
              path: "semantic",
              count: matches.length,
              facts: matches.map((m) => ({
                key: m.key,
                value: m.value,
                context: m.context,
                pinned: m.pinned === true,
                updated: m.updated_at,
                similarity: Number(m.similarity.toFixed(3)),
                note: "[via semantic match]",
              })),
            });
          }
        }
      } catch (e) {
        console.warn(
          `[recall_facts] semantic fallback failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    return keySearch ? `No memories found matching "${keySearch}".` : "No permanent memories stored yet.";
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export const TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
export const TESLA_AUTH_BASE = "https://fleet-auth.prd.vn.cloud.tesla.com";

export async function refreshTeslaToken(svc: SupabaseClient, tokenRow: any): Promise<string> {
  const expiresAt = new Date(tokenRow.token_expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) return tokenRow.access_token;
  const clientId = process.env.TESLA_CLIENT_ID!;
  const clientSecret = process.env.TESLA_CLIENT_SECRET!;
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

export function sanitizeGoogleFileUrls(text: string, toolCalls: any[]): string {
  const fileToolResults = toolCalls
    .filter(tc => tc.name === "create_google_file" && tc.result && !tc.result.startsWith("TOOL_ERROR"))
    .map(tc => tc.result);
  const verifiedUrls = new Set<string>();
  for (const result of fileToolResults) {
    const match = result.match(/https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/[A-Za-z0-9_-]+/);
    if (match) verifiedUrls.add(match[0]);
  }
  return text.replace(
    /https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/[A-Za-z0-9_-]+[^\s)>\]]*/g,
    (url: string) => {
      const base = url.match(/https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/[A-Za-z0-9_-]+/)?.[0];
      if (base && verifiedUrls.has(base)) return url;
      return "[link removed — file creation failed, please retry]";
    }
  );
}
