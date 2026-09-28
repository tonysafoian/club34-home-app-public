import type { Request, Response } from "express";
import { createClient, getServiceClient, type SupabaseClient } from "../utils/supabase.js";
import { fetchT } from "../utils/fetch-timeout.js";
import {
  logAudit as sharedLogAudit,
  loadPrompt,
  loadConversationHistory,
  loadMemories,
  logConversation,
  executeSendEmail as sharedSendEmail,
  executeGmailSearch,
  executeSendWhatsApp as sharedSendWhatsApp,
  executeQueryNotionDatabase,
  isUUID,
  sanitizePeopleField,
  sanitizeAllPeopleFields,
  setNotionPeopleLookup,
  loadHouseholdMembers,
  executeUpdateNotionPage,
  executeBatchUpdateNotionPages,
  executeCreateNotionPage,
  executeGetNotionDatabase,
  executeWebSearch,
  executeScrapeWebsite,
  executePerplexitySearch,
  executeSaveToCart as sharedSaveToCart,
  executeViewCart as sharedViewCart,
  executeClearCart as sharedClearCart,
  executeRememberFact as sharedRememberFact,
  executeRecallFacts as sharedRecallFacts,
  validateAndCleanURLs,
  sanitizeGoogleFileUrls,
  extractImageDescription,
} from "../utils/janus-tools.js";

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
  executeGetCalendarEvents,
  executeCreateCalendarEvent,
  executeDeleteCalendarEvent,
  executeCheckAvailability,
  executeGetDirections,
  executeSearchPlaces,
  executeGetEnvironmentData,
  executeSearchNews,
  callCalendarProxy,
} from "../utils/tools/calendar-maps.js";

import {
  executeCreateGoogleFile,
  executeAttachFileToNotion,
} from "../utils/tools/google-workspace.js";

import {
  executeGenerateMedia,
  executeManageTrip,
  executeQueryTrips,
  executeQueryEntertainment,
  executeQueryMedia,
  executeSuggestMovie,
  type RequestContext,
} from "../utils/tools/media-trips.js";
import { LOAD_SKILL_TOOL, executeLoadSkill, getSkillsIndexBlock } from "../utils/janus-skills.js";

import { sanitizeText, sanitizeMessages } from "../utils/sanitize.js";
import { renderSystemPrompt } from "../utils/prompt-render.js";
import { detectHallucination, auditHallucinationGuard } from "../utils/hallucination-guards.js";
import {
  classifyComplexity,
  applyMonotonicUpgrade,
  pickModel,
  type ComplexityDecision,
} from "../utils/complexity-router.js";
import {
  extractUsageFromStream,
  extractUsageFromBody,
  recordLlmUsage,
  STREAM_USAGE_OPTION,
} from "../lib/llm-usage.js";

import {
  executeLaunchResearch,
  executeSetReminder,
  executeQueryActivityLog,
  executeQuerySystemHealth,
  executeQuerySystemUpdates,
  executeSearchSystemEvents,
  executeGetNetworkHistory,
  executeAddProjectNote,
  executeGetProjectNotes,
} from "../utils/tools/research-admin.js";

import { executeBrowseWebsite } from "../utils/tools/browser.js";
import { executeReadCodebase, executeProposeCodeFix } from "../utils/tools/github-code.js";
import { executeWifiWhoIsOnline, executeWifiLabelDevice, executeWifiUnknownDevices } from "../utils/tools/wifi.js";

import fs from "fs";
import path from "path";

const PROJECT_ID = "b5561696-27c3-437d-a6f3-c33ce05a412f";
const APP_DOMAIN = process.env.APP_DOMAIN || "example.com";

function isAllowedOrigin(origin: string): boolean {
  if (origin === `https://${APP_DOMAIN}` || origin === `https://www.${APP_DOMAIN}`) return true;
  if (origin === "https://club34.ai" || origin === "https://www.club34.ai") return true;
  return false;
}

function getCorsHeaders(req: Request) {
  const origin = req.headers.origin || "";
  const allowedOrigin = isAllowedOrigin(origin) ? origin : "https://example.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  };
}

const logAudit = (entry: Record<string, unknown>) => sharedLogAudit("janus-chat", entry);
const executeSendEmail = (to: string, subject: string, body: string) => sharedSendEmail(to, subject, body, "chat", "janus-chat");
const executeSendWhatsApp = (to: string, message: string) => sharedSendWhatsApp(to, message, "chat", "janus-chat");

const JANUS_EMAIL = "assistant@example.com";

// Chat tier selection (SIMPLE / DEFAULT / COMPLEX) now lives in
// server/utils/complexity-router.ts via pickModel(tier). Summarizer
// model stays inline because it's a single-shot, non-streaming side
// channel with different cost characteristics.
const MODEL_SUMMARIZE = process.env.JANUS_MODEL_SUMMARIZE || "google/gemini-2.5-flash-lite";
const FALLBACK_MODELS = (process.env.JANUS_FALLBACK_MODELS || "google/gemini-2.5-flash-lite,openai/gpt-5-mini,google/gemini-2.5-pro").split(",").map(s => s.trim());

let SYSTEM_PROMPT: string;
try {
  SYSTEM_PROMPT = fs.readFileSync(path.resolve(process.cwd(), "supabase/functions/_shared/SOUL.md"), "utf8");
} catch {
  SYSTEM_PROMPT = "You are Janus, the AI assistant for Club 34.";
}

// Quick-reply prompt used when an unrecognized sender hits the chat
// endpoint. Lives at module scope so the tone-fairness test suite can
// assert on it without standing up the full handler. Polished + firm
// + no household PII — the contract the test enforces.
export const OUTSIDER_QUICK_REPLY_PROMPT = `You are Janus, a private household assistant. You received a message from someone outside the household.
You can ONLY help relay basic messages to the family. Do NOT reveal names, schedules, addresses, or any personal information.
Keep replies to 1-2 sentences max. Be warm but firm. You have NO access to any household tools, calendars, or data.`;

const TOOL_STATUS_MAP: Record<string, string> = {
  perplexity_search: "Searching with Perplexity…",
  home_troubleshoot: "Getting troubleshooting advice…",
  web_search: "Searching the web…",
  scrape_website: "Reading webpage…",
  get_calendar_events: "Checking calendar…",
  create_calendar_event: "Creating calendar event…",
  delete_calendar_event: "Deleting calendar event…",
  check_availability: "Checking availability…",
  get_directions: "Getting directions…",
  search_places: "Finding places…",
  get_environment_data: "Checking environment…",
  search_news: "Searching news…",
  query_notion_database: "Querying Notion…",
  update_notion_page: "Updating Notion…",
  create_notion_page: "Creating Notion page…",
  get_notion_database: "Fetching Notion schema…",
  batch_update_notion_pages: "Batch updating Notion…",
  send_email: "Sending email…",
  gmail_search: "Searching Gmail…",
  send_whatsapp: "Sending WhatsApp…",
  remember_fact: "Saving to memory…",
  recall_facts: "Recalling memories…",
  save_to_cart: "Adding to cart…",
  view_cart: "Checking cart…",
  clear_cart: "Clearing cart…",
  ha_get_states: "Checking home systems…",
  ha_get_state: "Checking device…",
  ha_call_service: "Controlling device…",
  ha_get_logbook: "Reading home log…",
  generate_media: "Generating media…",
  launch_research: "Launching research…",
  check_tesla_status: "Checking Tesla vehicles…",
  set_reminder: "Setting reminder…",
  manage_trip: "Managing trip…",
  query_trips: "Checking trips…",
  query_entertainment: "Checking events…",
  query_media: "Browsing media…",
  suggest_movie: "Getting recommendations…",
  attach_file_to_notion: "Attaching file…",
  create_google_file: "Creating Google file…",
  check_verkada_security: "Checking security cameras…",
  check_generator_status: "Checking generator…",
  query_activity_log: "Checking activity log…",
  query_system_health: "Checking system health…",
  query_system_updates: "Checking updates…",
  add_project_note: "Saving note to project…",
  get_project_notes: "Loading project notes…",
  browse_website: "Browsing website…",
  search_system_events: "Searching system logs…",
  get_network_history: "Checking network history…",
};

const SLOW_TOOLS = new Set(["scrape_website", "launch_research", "generate_media", "web_search", "create_google_file", "browse_website", "perplexity_search", "home_troubleshoot"]);

async function executeToolWithTimeout(name: string, args: any, userId: string | undefined, ctx: RequestContext): Promise<string> {
  const timeoutMs = name === "generate_media" ? 30_000 : name === "browse_website" ? 60_000 : SLOW_TOOLS.has(name) ? 10_000 : 5_000;
  try {
    return await Promise.race([
      executeTool(name, args, userId, ctx),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
  } catch (e) {
    if (e instanceof Error && e.message === "timeout") {
      console.warn(`Tool ${name} timed out after ${timeoutMs}ms`);
      return `TOOL_TIMEOUT: ${name} took too long (>${timeoutMs / 1000}s). Try proceeding without this data.`;
    }
    throw e;
  }
}

async function fetchTodayCalendar(svc: SupabaseClient): Promise<string> {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString();

    let calendarIds = ["admin@example.com"];
    try {
      const listData = await callCalendarProxy({ action: "list-calendars", calendarId: "admin@example.com" });
      if (listData.success && Array.isArray(listData.calendars)) {
        const visibleCals = listData.calendars.filter((c: any) => c.selected !== false).map((c: any) => c.id);
        if (visibleCals.length > 0) calendarIds = visibleCals;
      }
    } catch {}

    const allResults = await Promise.allSettled(
      calendarIds.map(async (cId: string) => {
        const data = await callCalendarProxy({ action: "list-events", calendarId: cId, timeMin: startOfDay, timeMax: endOfDay, maxResults: 20 });
        if (!data.success) return [];
        return (data.events || []).map((e: any) => {
          const myAttendee = e.attendees?.find((a: any) => a.email?.toLowerCase() === "admin@example.com" || a.self === true);
          if (myAttendee?.responseStatus === "declined") return null;
          return e;
        }).filter(Boolean);
      })
    );

    const seen = new Set<string>();
    const events: any[] = [];
    for (const r of allResults) {
      if (r.status === "fulfilled") {
        for (const ev of r.value) { if (ev.id && !seen.has(ev.id)) { seen.add(ev.id); events.push(ev); } }
      }
    }
    events.sort((a, b) => (a.start?.dateTime || a.start?.date || "").localeCompare(b.start?.dateTime || b.start?.date || ""));

    if (events.length === 0) return "";
    const lines = events.map((e: any) => {
      const time = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) : "All day";
      const loc = e.location ? ` (${e.location})` : "";
      return `- ${time} — ${e.summary || "(No title)"}${loc}`;
    });
    return `Today's Calendar:\n${lines.join("\n")}`;
  } catch (e) {
    console.error("Failed to prefetch calendar:", e);
    return "";
  }
}

async function fetchCurrentWeather(): Promise<string> {
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
    const res = await fetch(`${baseUrl}/api/weather/dashboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    const parts: string[] = [];
    if (data.forecast?.[0]) { const today = data.forecast[0]; parts.push(`${today.tempMax}°F high, ${today.tempMin}°F low`); }
    if (data.airQuality) parts.push(`AQI ${data.airQuality.aqi} (${data.airQuality.category})`);
    return parts.length ? `Current Weather: ${parts.join(", ")}` : "";
  } catch { return ""; }
}

async function fetchTodayTasks(svc: SupabaseClient): Promise<string> {
  try {
    const NOTION_API_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_API_KEY) return "";
    const today = new Date().toISOString().split("T")[0];
    const res = await fetch("https://api.notion.com/v1/databases/2b8e96d8-93fa-80b9-859f-c321f25e74ae/query", {
      method: "POST",
      headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ page_size: 20, filter: { and: [{ property: "Status", status: { does_not_equal: "Done" } }, { property: "Due date", date: { on_or_before: today } }] }, sorts: [{ property: "Due date", direction: "ascending" }] }),
    });
    const data = await res.json();
    if (!res.ok || !data.results?.length) return "";
    const overdue: string[] = [];
    const dueToday: string[] = [];
    for (const p of data.results) {
      const props = p.properties || {};
      const title = props["Task"]?.title?.map((t: any) => t.plain_text).join("") || "Untitled";
      const dueDate = props["Due date"]?.date?.start || "";
      const priority = props["Priority"]?.select?.name || "—";
      const assignee = props["Assignee"]?.people?.map((a: any) => a.name || "?").join(", ") || "Unassigned";
      const line = `"${title}" (Due ${dueDate}, ${priority}, ${assignee})`;
      if (dueDate < today) overdue.push(line);
      else dueToday.push(line);
    }
    const parts: string[] = [];
    if (overdue.length) parts.push(`Overdue (${overdue.length}): ${overdue.join("; ")}`);
    if (dueToday.length) parts.push(`Due Today (${dueToday.length}): ${dueToday.join("; ")}`);
    return parts.length ? `── TASK STATUS ──\n${parts.join("\n")}` : "";
  } catch { return ""; }
}

async function loadSummary(userId: string, svc: SupabaseClient): Promise<string> {
  try {
    const { data } = await svc.from("janus_chat_summaries").select("summary").eq("user_id", userId).single();
    return data?.summary || "";
  } catch { return ""; }
}

async function summarizeIfNeeded(userId: string, fullHistory: { role: string; content: string }[], svc: SupabaseClient): Promise<void> {
  if (fullHistory.length < 10) return;
  try {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) return;
    const toSummarize = fullHistory.slice(0, -6);
    const transcript = toSummarize.map(m => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 300) : "[media]"}`).join("\n");
    const summarizeStart = Date.now();
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL_SUMMARIZE, messages: [{ role: "system", content: "Summarize this conversation in 2-3 concise sentences. Focus on key topics discussed, decisions made, and any important context. Be factual and brief." }, { role: "user", content: transcript }], stream: false }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    // Non-streaming → usage is top-level on the body. Best-effort write.
    const usage = extractUsageFromBody(data);
    if (usage) {
      recordLlmUsage(
        {
          userId,
          channel: "chat",
          model: MODEL_SUMMARIZE,
          tier: "summarize",
          durationMs: Date.now() - summarizeStart,
          requestType: "summarize",
        },
        usage,
      ).catch(() => {});
    }
    const summary = data.choices?.[0]?.message?.content || "";
    if (!summary) return;
    await svc.from("janus_chat_summaries").upsert({ user_id: userId, summary, message_count: fullHistory.length, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    console.log(`Summarized ${toSummarize.length} messages for ${userId}`);
  } catch (e) { console.error("Summarization failed:", e); }
}

async function resolveUser(req: Request, existingSvc?: SupabaseClient): Promise<{ userId: string; displayName: string; role: string } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  try {
    const token = authHeader.replace("Bearer ", "");
    let userId: string;
    let email: string | undefined;
    try {
      const payloadB64 = token.split(".")[1];
      const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
      userId = payload.sub || payload.userId;
      email = payload.email;
      if (!userId) return null;
    } catch {
      return null;
    }

    const { query: q } = await import('../lib/db.js');
    const [profileRes, roleRes] = await Promise.all([
      q<{ display_name: string }>(`SELECT display_name FROM profiles WHERE user_id = $1 LIMIT 1`, [userId]),
      q<{ role: string }>(`SELECT role FROM user_roles WHERE user_id = $1 LIMIT 1`, [userId]),
    ]);
    let displayName = profileRes.rows[0]?.display_name;
    if (!displayName) {
      const hmRes = await q<{ display_name: string }>(
        `SELECT display_name FROM household_members WHERE supabase_uuid = $1 AND is_active = true LIMIT 1`,
        [userId],
      );
      displayName = hmRes.rows[0]?.display_name;
    }
    if (!displayName && email) {
      const hmByEmail = await q<{ display_name: string }>(
        `SELECT display_name FROM household_members WHERE email = $1 AND is_active = true LIMIT 1`,
        [email],
      );
      displayName = hmByEmail.rows[0]?.display_name;
    }
    return {
      userId,
      displayName: displayName || email || "Unknown",
      role: roleRes.rows[0]?.role || "outsider",
    };
  } catch (e) { console.error("Auth resolution failed:", e); return null; }
}

export const ADMIN_ONLY_TOOLS = new Set(["send_email", "gmail_search", "batch_update_notion_pages", "query_system_health", "read_codebase", "propose_code_fix", "wifi_label_device", "wifi_unknown_devices", "delete_calendar_event"]);

// Hallucination detection now lives in server/utils/hallucination-guards.ts
// as a data-driven table (calendar + google file + email + cart + reminder).
// Imported above; the call site below uses detectHallucination() to find
// the first guard that fires.

const HOUSEHOLD_ONLY_TOOLS = new Set(["generate_media"]);
export const OUTSIDER_BLOCKED_TOOLS = new Set([
  "load_skill",
  "ha_call_service", "ha_get_states", "ha_get_state", "ha_get_logbook",
  "check_tesla_status", "check_verkada_security", "check_generator_status",
  "query_activity_log", "query_system_health", "query_system_updates",
  "get_calendar_events", "create_calendar_event", "delete_calendar_event", "check_availability",
  "query_notion_database", "create_notion_page", "update_notion_page", "delete_notion_page",
  "batch_update_notion_pages", "attach_file_to_notion",
  "manage_trip", "query_trips", "query_entertainment",
  "remember_fact", "recall_facts",
  "save_to_cart", "view_cart", "clear_cart",
  "set_reminder",
  "send_email", "gmail_search",
  "send_whatsapp",
  "generate_media",
  "create_google_file",
  "add_project_note", "get_project_notes",
  "home_troubleshoot",
  "wifi_who_is_online", "wifi_label_device", "wifi_unknown_devices",
  "search_system_events", "get_network_history",
]);

export const ALL_TOOLS = [
  { type: "function", function: { name: "send_email", description: "Send an email from assistant@example.com. Use for longer or more formal communications. ADMIN ONLY. CRITICAL: Any URLs in the body MUST be copied EXACTLY from web_search or scrape_website results — never guess or reconstruct a URL.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"], additionalProperties: false } } },
  { type: "function", function: { name: "gmail_search", description: "Search Tony's Gmail inbox using Gmail search syntax. ADMIN ONLY.", parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "send_whatsapp", description: "Send a WhatsApp message via WATI.", parameters: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"], additionalProperties: false } } },
  { type: "function", function: { name: "query_notion_database", description: "Query a Notion database.", parameters: { type: "object", properties: { database_id: { type: "string" }, filter: { type: "object" } }, required: ["database_id"], additionalProperties: false } } },
  { type: "function", function: { name: "update_notion_page", description: "Update properties on a Notion page.", parameters: { type: "object", properties: { page_id: { type: "string" }, properties: { type: "object" } }, required: ["page_id", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "batch_update_notion_pages", description: "Batch update multiple Notion pages. ADMIN ONLY.", parameters: { type: "object", properties: { page_ids: { type: "array", items: { type: "string" } }, properties: { type: "object" } }, required: ["page_ids", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "create_notion_page", description: "Create a new page in a Notion database. Pass simple key-value properties — the system auto-fetches the database schema and converts values to the correct Notion format. Use get_notion_database first if you need to discover property names. Example: {\"Name\": \"My Project\", \"Status\": \"In Progress\", \"Due Date\": \"2025-04-01\"}.", parameters: { type: "object", properties: { database_id: { type: "string" }, properties: { type: "object" } }, required: ["database_id", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "get_notion_database", description: "Get a Notion database schema.", parameters: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"], additionalProperties: false } } },
  { type: "function", function: { name: "perplexity_search", description: "Search the web using Perplexity AI for synthesized, cited answers to knowledge questions. PREFERRED over web_search for: factual questions (what is, how does, why did, current status of), research topics, explanations, comparisons, and any question that benefits from a synthesized answer with citations. Use web_search instead ONLY for finding specific websites/URLs or when you need raw links to share.", parameters: { type: "object", properties: { query: { type: "string", description: "The search query — ask a clear, specific question for best results" }, deep: { type: "boolean", description: "Use deep search (sonar-pro) for complex research questions. Default false." } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "home_troubleshoot", description: "Get troubleshooting advice for home system issues (HVAC, plumbing, electrical, pool, security, appliances, etc.). Provides likely causes, immediate steps, when to call a pro, and local service provider recommendations near Beverly Hills.", parameters: { type: "object", properties: { system: { type: "string", description: "The home system (e.g. 'HVAC', 'pool heater', 'electrical', 'plumbing', 'garage door')" }, issue: { type: "string", description: "Description of the issue or symptoms" } }, required: ["system", "issue"], additionalProperties: false } } },
  { type: "function", function: { name: "web_search", description: "Search the web for links, products, URLs, and raw search results via Firecrawl. Use for finding specific websites, product links, or when you need raw URLs to share. For factual/knowledge questions, prefer perplexity_search instead.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "scrape_website", description: "Scrape a webpage and extract content as markdown.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "browse_website", description: "Open a real browser to interact with a website.", parameters: { type: "object", properties: { url: { type: "string" }, instruction: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { action: { type: "string", enum: ["navigate", "act", "extract"] }, value: { type: "string" } }, required: ["action", "value"] } } }, required: ["url", "instruction"], additionalProperties: false } } },
  { type: "function", function: { name: "save_to_cart", description: "Save a product to the shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" }, product_name: { type: "string" }, product_url: { type: "string" }, price: { type: "string" }, quantity: { type: "number" }, notes: { type: "string" } }, required: ["platform", "product_name"], additionalProperties: false } } },
  { type: "function", function: { name: "view_cart", description: "View shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "remember_fact", description: "Save a permanent fact about the user. Set pinned=true for durable, high-importance facts that must survive the 200-row FIFO eviction cap.", parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, context: { type: "string" }, pinned: { type: "boolean", description: "Pin this fact so it survives FIFO eviction. Use for durable, high-importance facts: allergies, alarm/lock codes, medication schedules, emergency contacts." } }, required: ["key", "value"], additionalProperties: false } } },
  { type: "function", function: { name: "recall_facts", description: "Search permanent memory for facts about the user. Matches by key prefix first; falls back to semantic similarity if no exact match.", parameters: { type: "object", properties: { key_search: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "clear_cart", description: "Clear shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "get_calendar_events", description: "Get Google Calendar events for a time range.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, time_min: { type: "string" }, time_max: { type: "string" }, max_results: { type: "number" } }, required: ["time_min", "time_max"], additionalProperties: false } } },
  { type: "function", function: { name: "create_calendar_event", description: "Create a Google Calendar event. CRITICAL: ALL times MUST be in Pacific Time with explicit offset. NEVER use Z suffix.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, attendees: { type: "array", items: { type: "string" } } }, required: ["title", "start", "end"], additionalProperties: false } } },
  { type: "function", function: { name: "delete_calendar_event", description: "Delete a calendar event. ADMIN ONLY.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, event_id: { type: "string" } }, required: ["event_id"], additionalProperties: false } } },
  { type: "function", function: { name: "check_availability", description: "Check free/busy availability.", parameters: { type: "object", properties: { emails: { type: "array", items: { type: "string" } }, time_min: { type: "string" }, time_max: { type: "string" } }, required: ["emails", "time_min", "time_max"], additionalProperties: false } } },
  { type: "function", function: { name: "get_directions", description: "Get driving directions and travel time.", parameters: { type: "object", properties: { destination: { type: "string" }, origin: { type: "string" }, mode: { type: "string" } }, required: ["destination"], additionalProperties: false } } },
  { type: "function", function: { name: "search_places", description: "Search for places near a location.", parameters: { type: "object", properties: { query: { type: "string" }, near: { type: "string" }, type: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "get_environment_data", description: "Get air quality, pollen, weather alerts.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "search_news", description: "Search for recent news.", parameters: { type: "object", properties: { query: { type: "string" }, period: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_states", description: "Get Home Assistant entity states.", parameters: { type: "object", properties: { domain: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_state", description: "Get specific HA entity state.", parameters: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_call_service", description: "Control a Home Assistant device.", parameters: { type: "object", properties: { domain: { type: "string" }, service: { type: "string" }, service_data: { type: "object" } }, required: ["domain", "service"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_logbook", description: "Get HA activity log.", parameters: { type: "object", properties: { hours: { type: "number" }, entity_id: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "set_reminder", description: "Set a scheduled reminder.", parameters: { type: "object", properties: { due_at: { type: "string" }, message: { type: "string" }, channel: { type: "string" }, whatsapp_number: { type: "string" } }, required: ["due_at", "message", "channel"], additionalProperties: false } } },
  { type: "function", function: { name: "manage_trip", description: "Create, update, or delete a trip card.", parameters: { type: "object", properties: { action: { type: "string", enum: ["create", "update", "delete"] }, trip_id: { type: "string" }, trip_name: { type: "string" }, destination: { type: "string" }, departure_date: { type: "string" }, return_date: { type: "string" }, status: { type: "string", enum: ["draft", "confirmed", "completed"] }, travelers: { type: "array", items: { type: "string" } }, flights: { type: "array", items: { type: "object", properties: { flight_number: { type: "string" }, airline: { type: "string" }, from: { type: "string" }, to: { type: "string" }, departure_datetime: { type: "string" }, arrival_datetime: { type: "string" }, cabin_class: { type: "string" }, confirmation_code: { type: "string" } } } }, hotels: { type: "array", items: { type: "object", properties: { name: { type: "string" }, address: { type: "string" }, check_in: { type: "string" }, check_out: { type: "string" }, room_type: { type: "string" }, confirmation_code: { type: "string" } } } }, notes: { type: "string" } }, required: ["action", "trip_name"], additionalProperties: false } } },
  { type: "function", function: { name: "launch_research", description: "Launch a deep research task.", parameters: { type: "object", properties: { topic: { type: "string" }, instructions: { type: "string" }, email_to: { type: "string" }, project_id: { type: "string" } }, required: ["topic", "email_to"], additionalProperties: false } } },
  { type: "function", function: { name: "generate_media", description: "Generate an image or video using AI. HOUSEHOLD MEMBERS ONLY.", parameters: { type: "object", properties: { prompt: { type: "string" }, type: { type: "string", enum: ["image", "video"] }, platform: { type: "string", enum: ["gemini", "fal"] }, email_to: { type: "string" }, whatsapp_number: { type: "string" } }, required: ["prompt", "type", "email_to"], additionalProperties: false } } },
  { type: "function", function: { name: "query_trips", description: "Query trips.", parameters: { type: "object", properties: { status: { type: "string" }, upcoming_only: { type: "boolean" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_entertainment", description: "Query entertainment events.", parameters: { type: "object", properties: { category: { type: "string" }, upcoming_only: { type: "boolean" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_media", description: "Query movies/shows.", parameters: { type: "object", properties: { category: { type: "string" }, limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "suggest_movie", description: "Get AI movie recommendations.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "attach_file_to_notion", description: "Attach file to Notion page.", parameters: { type: "object", properties: { page_id: { type: "string" }, base64_data: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" } }, required: ["page_id", "base64_data", "filename", "mime_type"], additionalProperties: false } } },
  { type: "function", function: { name: "create_google_file", description: "Create a Google Workspace file.", parameters: { type: "object", properties: { file_type: { type: "string", enum: ["doc", "sheet", "slides", "form"] }, title: { type: "string" }, content: { type: "string" }, share_with: { type: "array", items: { type: "string" } } }, required: ["file_type", "title", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "check_tesla_status", description: "Check Tesla vehicles status.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_verkada_security", description: "Check Verkada security.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_generator_status", description: "Check generator status.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "query_activity_log", description: "Quick recent-activity feed from Club 34's central app-activity log. For filtered or aggregated questions (by area, person, severity, or a 'what's going on' overview) use search_system_events instead.", parameters: { type: "object", properties: { event_type: { type: "string", description: "Optional keyword to filter the feed" }, hours: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_system_health", description: "Check system health. ADMIN ONLY.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "query_system_updates", description: "Get recent updates.", parameters: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "add_project_note", description: "Add a note to the current project.", parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, artifact_type: { type: "string", enum: ["text", "code"] } }, required: ["title", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "get_project_notes", description: "Get project notes.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "read_codebase", description: "Read one or more files from the Club 34 codebase on GitHub. Accepts file paths or directory paths. ADMIN ONLY.", parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "List of file or directory paths to read (e.g. ['server/utils/tools/home-automation.ts', 'lib/github.ts'])" } }, required: ["paths"], additionalProperties: false } } },
  { type: "function", function: { name: "propose_code_fix", description: "Create a GitHub branch and pull request with a proposed code change. ADMIN ONLY. Never pushes to main directly.", parameters: { type: "object", properties: { file_path: { type: "string", description: "Repo-relative path to the file to create or update" }, new_content: { type: "string", description: "Full new content for the file" }, commit_message: { type: "string", description: "Commit message" }, pr_title: { type: "string", description: "Pull request title" }, pr_body: { type: "string", description: "Pull request description explaining the change and reasoning" } }, required: ["file_path", "new_content", "commit_message", "pr_title", "pr_body"], additionalProperties: false } } },
  { type: "function", function: { name: "wifi_who_is_online", description: "Return the currently-online wireless clients grouped by person/role (Tony, Lana, family, staff, IoT, Unknown). Joins live Ruckus client data with the labeled network_devices inventory so the answer uses 'Tony's iPhone' instead of MAC addresses.", parameters: { type: "object", properties: { filter: { type: "string", enum: ["family", "staff", "guest", "iot", "unknown"], description: "Optional role filter — restrict output to one of family/staff/guest/iot/unknown" } }, additionalProperties: false } } },
  { type: "function", function: { name: "wifi_label_device", description: "Label a device in the network_devices inventory by MAC. Use when Tony tells you which person owns a device or what to call it. ADMIN ONLY.", parameters: { type: "object", properties: { mac: { type: "string", description: "MAC address of the device to label" }, label: { type: "string", description: "Friendly label, e.g. \"Tony's iPhone 16 Pro\"" }, owner_person_id: { type: "string", description: "Owner person id: tony / lana / isla / emme / enzo / staff" }, owner_role: { type: "string", enum: ["family", "staff", "guest", "iot", "unknown"], description: "Role bucket" }, device_type: { type: "string", description: "phone / tablet / laptop / tv / speaker / camera / iot / unknown" }, expected_ssid: { type: "string", description: "Which SSID this device should normally be on (alert when it appears elsewhere)" }, trusted: { type: "boolean", description: "Explicit trust flag" }, notes: { type: "string", description: "Free-form notes" } }, required: ["mac"], additionalProperties: false } } },
  { type: "function", function: { name: "wifi_unknown_devices", description: "Return the recently-seen devices that have not been labeled yet (no owner, no label, not trusted). Includes inferred vendor + hostname hints. Use this when Tony asks 'what new devices are on the network'. ADMIN ONLY.", parameters: { type: "object", properties: { window_hours: { type: "number", description: "How far back to look. Default 24 hours; max 720." } }, additionalProperties: false } } },
  { type: "function", function: { name: "search_system_events", description: "Search Club 34's central app-activity log — almost EVERYTHING the app does is recorded here: home/IoT device actions, network & internet health, the Ball guest/RSVP system, security & access, scheduled automations, your own chat/email/WhatsApp actions, system health, config changes, logins, media generation, and vehicle events. Use for ANY question about what is happening or has happened in the app ('what's going on', 'anything new', 'catch me up', 'what happened with X', 'why did Y stop'). Set summary=true FIRST for a counts-by-area overview, then drill into one area with category. Always ground answers in the returned rows and timestamps — never fabricate.", parameters: { type: "object", properties: { summary: { type: "boolean", description: "Return a counts-by-area overview instead of individual rows. Use this FIRST for broad 'what's going on' questions." }, hours: { type: "number", description: "How many hours back to look. Default 24, max 720 (30 days)." }, category: { type: "string", description: "Area filter, e.g. home, network, ball, security, automation, automations, janus, system, config, auth, media, vehicle" }, severity: { type: "string", description: "info, warn, warning, error, or critical" }, status: { type: "string", description: "success, error, skipped, warning, or logged" }, actor: { type: "string", description: "Person or system that caused the event, e.g. 'Janus', 'Tony', or a monitor name (substring match)" }, source: { type: "string", description: "Originating job/function, e.g. 'cron-trigger', 'ball-rsvp' (substring match)" }, search: { type: "string", description: "Keyword to match in summary, event type, source, or actor" } }, additionalProperties: false } } },
  { type: "function", function: { name: "get_network_history", description: "Get network health history snapshots (FortiGate CPU, memory, sessions, WAN status, threat count) over the last N hours. Use to diagnose internet outages, slowdowns, or network performance issues.", parameters: { type: "object", properties: { hours: { type: "number", description: "How many hours of history to fetch. Default 6, max 48." } }, additionalProperties: false } } },
  LOAD_SKILL_TOOL,
];

function getToolsForRole(role: string) {
  if (role === "admin") return ALL_TOOLS;
  if (role === "member") return ALL_TOOLS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.function.name));
  return ALL_TOOLS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.function.name) && !HOUSEHOLD_ONLY_TOOLS.has(t.function.name) && !OUTSIDER_BLOCKED_TOOLS.has(t.function.name));
}

// Exported so the tone-fairness test suite can assert per-role
// substring properties without standing up the whole handler. Pure
// function — no I/O.
const DIAGNOSTIC_GUIDANCE = `

── DIAGNOSTIC & LOG-ANALYSIS GUIDANCE ──
When asked "why did X stop?", "what happened with Y?", "can you diagnose Z?", or any question about past events or failures:
1. ALWAYS search logs first — do not guess or fabricate. Use search_system_events and/or ha_get_logbook for the relevant device/room/time window.
2. For home media/speaker/display issues: call ha_get_logbook with the relevant entity_id and search_system_events with search="broadcast" or search="media".
3. For internet/network issues: call get_network_history and search_system_events with category="network".
4. For automation issues: call search_system_events with category="automation".
5. Correlate across sources — combine HA logbook, system events, and network history to build a timeline.
6. If no relevant records exist, say clearly: "I checked the logs for the last Xh and found no record of [event] — [possible reason or suggestion]." NEVER fabricate a root cause.
7. Always cite timestamps and entity names from the actual log data in your answer.

── APP-WIDE AWARENESS ──
Almost EVERYTHING that happens anywhere in Club 34 is recorded to one central app-activity log, queryable with search_system_events. This spans: home/IoT device actions (category=home), network & internet health (network), the Ball guest/RSVP system (ball), security & access (security), scheduled automations (automation, automations), your own actions across chat/email/WhatsApp (janus, janus.email, janus.whatsapp), system health & config changes (system, config), logins (auth), media generation (media), and vehicle events (vehicle).
For ANY "what's going on / what's been happening / anything new / catch me up" question, call search_system_events with summary=true FIRST to get a counts-by-area overview, then drill into a specific area with category=<name>. Cut routine noise with severity=warn|error|critical, see what one person or monitor did with actor=<name>, or filter by source=<job> / search=<keyword>. The window is hours (default 24, up to 720 = 30 days). Ground every answer in the real rows and timestamps; if the log shows nothing, say so plainly rather than guessing.`;

export function getRoleSystemPromptAddendum(role: string): string {
  if (role === "admin") return `\n\nThe current user is the ADMIN (Tony). You have full access to all tools and data. No restrictions.\nCRITICAL: The Notion database IDs are listed in your system prompt above. NEVER call recall_facts to look up a database ID — use the exact ID from your knowledge.${DIAGNOSTIC_GUIDANCE}`;
  if (role === "outsider") return `\n\nThe current user is an OUTSIDER. You are a PRIVATE household assistant.\nSTRICT RULES:\n- Do NOT reveal ANY personal information about the family.\n- Do NOT execute ANY home automation commands.\n- Do NOT access calendars, Notion, Tesla, cameras, or any household systems.\n- You can ONLY help with basic logistics.\n- Keep responses to 1-2 sentences max.`;
  return `\n\nThe current user is a MEMBER (not admin). Access restrictions:\n- You CANNOT send emails\n- You CANNOT batch-update Notion pages\n- You CAN query and update (but NOT delete) Notion pages\n- You CAN view Tesla status but CANNOT send control commands\n- You CAN view and control home systems\n- You CAN send WhatsApp messages\nCRITICAL: The Notion database IDs are listed in your system prompt above. NEVER call recall_facts to look up a database ID.${DIAGNOSTIC_GUIDANCE}`;
}

const URL_PATTERN = /https?:\/\/|www\.|\.com\/|\.org\/|\.net\/|find.*(?:website|link|url|site)|(?:link|url|site)\s+(?:to|for)/i;
const KNOWLEDGE_PATTERN = /^(?:what|who|why|how|when|where|explain|compare|describe|summarize|is there|are there|does|do|can|could|should|will|would|tell me|define|list|name)\b/i;

function classifySearchIntent(query: string): "perplexity" | "firecrawl" | "either" {
  if (URL_PATTERN.test(query)) return "firecrawl";
  if (KNOWLEDGE_PATTERN.test(query)) return "perplexity";
  return "either";
}

export async function executeTool(name: string, args: any, userId: string | undefined, ctx: RequestContext): Promise<string> {
  switch (name) {
    case "send_email": return executeSendEmail(args.to, args.subject, args.body);
    case "gmail_search": return executeGmailSearch(args.query, args.max_results);
    case "send_whatsapp": return executeSendWhatsApp(args.to, args.message);
    case "query_notion_database": return executeQueryNotionDatabase(args.database_id, args.filter);
    case "update_notion_page": return executeUpdateNotionPage(args.page_id, args.properties);
    case "batch_update_notion_pages": return executeBatchUpdateNotionPages(args.page_ids, args.properties);
    case "create_notion_page": return executeCreateNotionPage(args.database_id, args.properties);
    case "get_notion_database": return executeGetNotionDatabase(args.database_id);
    case "perplexity_search": {
      const intent = classifySearchIntent(args.query);
      if (intent === "firecrawl") {
        return executeWebSearch(args.query, args.limit || 5);
      }
      return executePerplexitySearch(args.query, args.deep);
    }
    case "home_troubleshoot": {
      const { fetchTroubleshootingAdvice } = await import("../services/perplexity.js");
      return fetchTroubleshootingAdvice(args.system, args.issue);
    }
    case "web_search": {
      const intent = classifySearchIntent(args.query);
      if (intent === "perplexity") {
        return executePerplexitySearch(args.query, false);
      }
      return executeWebSearch(args.query, args.limit);
    }
    case "scrape_website": return executeScrapeWebsite(args.url);
    case "browse_website": return executeBrowseWebsite(args.url, args.instruction, args.steps, { source: "chat", userId, url: args.url, instruction: args.instruction });
    case "save_to_cart": return sharedSaveToCart(ctx.svc, userId || "anonymous", args.platform, args.product_name, args.product_url, args.price, args.quantity, args.notes);
    case "view_cart": return sharedViewCart(ctx.svc, userId || "anonymous", args.platform);
    case "clear_cart": return sharedClearCart(ctx.svc, userId || "anonymous", args.platform);
    case "remember_fact": return sharedRememberFact(ctx.svc, userId || "anonymous", args.key, args.value, args.context, args.pinned);
    case "recall_facts": return sharedRecallFacts(ctx.svc, userId || "anonymous", args.key_search);
    case "get_calendar_events": return executeGetCalendarEvents(args.calendar_id, args.time_min, args.time_max, args.max_results);
    case "create_calendar_event": return executeCreateCalendarEvent(args.calendar_id, args.title, args.start, args.end, args.description, args.location, args.attendees);
    case "delete_calendar_event": return executeDeleteCalendarEvent(args.calendar_id, args.event_id);
    case "check_availability": return executeCheckAvailability(args.emails, args.time_min, args.time_max);
    case "get_directions": return executeGetDirections(args.destination, args.origin, args.mode);
    case "search_places": return executeSearchPlaces(args.query, args.near, args.type);
    case "get_environment_data": return executeGetEnvironmentData();
    case "search_news": return executeSearchNews(args.query, args.period);
    case "ha_get_states": return executeHAGetStates(args.domain);
    case "ha_get_state": return executeHAGetState(args.entity_id);
    case "ha_call_service": return executeHACallService(args.domain, args.service, args.service_data);
    case "ha_get_logbook": return executeHAGetLogbook(args.hours, args.entity_id);
    case "set_reminder": return executeSetReminder(args.due_at, args.message, args.channel, args.whatsapp_number, userId, ctx.svc);
    case "launch_research": return executeLaunchResearch(args.topic, args.instructions, args.email_to, args.project_id || ctx.projectId, userId);
    case "generate_media": return executeGenerateMedia(args.prompt, args.type, args.email_to, args.whatsapp_number, userId, args.platform, ctx);
    case "manage_trip": return executeManageTrip(args, ctx.svc);
    case "query_trips": return executeQueryTrips(args, ctx.svc);
    case "query_entertainment": return executeQueryEntertainment(args, ctx.svc);
    case "query_media": return executeQueryMedia(args, ctx.svc);
    case "suggest_movie": return executeSuggestMovie(args.query);
    case "attach_file_to_notion": return executeAttachFileToNotion(args.page_id, args.base64_data, args.filename, args.mime_type);
    case "create_google_file": return executeCreateGoogleFile(args.file_type, args.title, args.content, args.share_with, userId, ctx.svc);
    case "check_tesla_status": return executeCheckTeslaStatus(ctx.svc);
    case "check_verkada_security": return executeCheckVerkadaSecurity(ctx.svc);
    case "check_generator_status": return executeCheckGeneratorStatus();
    case "query_activity_log": return executeQueryActivityLog(args.event_type, args.hours, ctx.svc);
    case "query_system_health": return executeQuerySystemHealth(ctx.svc);
    case "query_system_updates": return executeQuerySystemUpdates(args.limit, ctx.svc);
    case "add_project_note": return executeAddProjectNote(ctx.projectId, args.title, args.content, args.artifact_type, userId, ctx.svc);
    case "get_project_notes": return executeGetProjectNotes(ctx.projectId, ctx.svc);
    case "read_codebase": return executeReadCodebase(args.paths);
    case "propose_code_fix": return executeProposeCodeFix(args.file_path, args.new_content, args.commit_message, args.pr_title, args.pr_body);
    case "wifi_who_is_online": return executeWifiWhoIsOnline(args ?? {});
    case "wifi_label_device": return executeWifiLabelDevice(args ?? {}, userId);
    case "wifi_unknown_devices": return executeWifiUnknownDevices(args ?? {});
    case "search_system_events": return executeSearchSystemEvents(args.hours, args.category, args.severity, args.search, ctx.svc, args.actor, args.status, args.source, args.summary);
    case "get_network_history": return executeGetNetworkHistory(args.hours);
    case "load_skill": return executeLoadSkill(args.slug, ctx.role || "outsider", "chat", userId);
    default: return `Unknown tool: ${name}`;
  }
}

export async function handleChat(req: Request, res: Response) {
  const corsHeaders = getCorsHeaders(req);
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const urlPath = req.path || "";
  if (urlPath.endsWith("/ping") || req.headers["x-ping"] === "1") {
    fetch("https://openrouter.ai/api/v1/models", {
      method: "HEAD",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    }).catch(() => {});
    res.json({ ok: true, ts: Date.now() });
    return;
  }

  if (req.method === "GET") {
    const user = await resolveUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    const history = await loadConversationHistory(user.userId, 20);
    res.json({ history });
    return;
  }

  try {
    const body = req.body;
    const { newSession, _testMode, userId: testUserId, complexity: complexityOverride, project_id: reqProjectId } = body;
    const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");
    if (messages.length === 0) throw new Error("messages is required and must be a non-empty array");

    const svc = createClient();
    const ctx: RequestContext = { svc, projectId: reqProjectId || undefined };

    let user = await resolveUser(req, svc);
    let logUserId: string;
    let logDisplayName: string;
    let role: string;

    const testModeAllowed = _testMode && process.env.JANUS_TEST_MODE === "true";
    if (testModeAllowed && !user && testUserId) {
      logUserId = testUserId;
      logDisplayName = "System Functional Test";
      role = body.userRole === "admin" ? "admin" : "member";
    } else {
      logUserId = user?.userId || "anonymous";
      logDisplayName = user?.displayName || "UNKNOWN";
      role = user?.role || "outsider";
    }

    ctx.role = role;
    const PROJECT_ONLY_TOOLS = new Set(["add_project_note", "get_project_notes"]);
    const allTools = getToolsForRole(role);
    const tools = ctx.projectId ? allTools : allTools.filter((t) => !PROJECT_ONLY_TOOLS.has(t.function.name));

    const isOutsider = role === "outsider";

    if (isOutsider) {
      const sanitizedMessages = sanitizeMessages(messages);
      const lastUserMsg = [...sanitizedMessages].reverse().find((m: any) => m.role === "user");
      const outsiderUserText = sanitizeText(
        typeof lastUserMsg?.content === "string"
          ? lastUserMsg.content
          : Array.isArray(lastUserMsg?.content)
            ? lastUserMsg.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ") || "[media]"
            : "[unknown]"
      );
      const outsiderSystemPrompt = OUTSIDER_QUICK_REPLY_PROMPT;
      const outsiderReply = await (async () => {
        const OUTSIDER_MODEL = "google/gemini-2.5-flash-lite";
        const outsiderStart = Date.now();
        try {
          const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: OUTSIDER_MODEL,
              messages: [
                { role: "system", content: outsiderSystemPrompt },
                { role: "user", content: outsiderUserText.slice(0, 1000) },
              ],
              stream: false,
            }),
          });
          if (!resp.ok) return "Hi! I'm a private household assistant. I can relay a message to the family if needed.";
          const data = await resp.json();
          const usage = extractUsageFromBody(data);
          if (usage) {
            recordLlmUsage(
              {
                userId: logUserId,
                channel: "chat",
                model: OUTSIDER_MODEL,
                tier: "simple",
                durationMs: Date.now() - outsiderStart,
                requestType: "chat",
              },
              usage,
            ).catch(() => {});
          }
          return data.choices?.[0]?.message?.content || "Hi! I'm a private household assistant. I can relay a message to the family if needed.";
        } catch { return "Hi! I'm a private household assistant. I can relay a message to the family if needed."; }
      })();
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const writeSSEOutsider = (data: string) => new Promise<void>((resolve) => { res.write(data, () => resolve()); });
      await writeSSEOutsider(`data: ${JSON.stringify({ choices: [{ delta: { content: outsiderReply } }] })}\n\n`);
      await writeSSEOutsider("data: [DONE]\n\n");
      await logConversation(ctx.svc, logUserId, logDisplayName, role, outsiderUserText, outsiderReply, [], "chat");
      logAudit({ category: "janus", event_type: "chat_response", severity: "info", actor_id: logUserId, actor_name: logDisplayName, actor_role: role, channel: "chat", summary: `Chat outsider: "${outsiderUserText.slice(0, 80)}"`, detail: { tool_count: 0, response_length: outsiderReply.length, tools: [] }, status: "success" });
      res.end();
      return;
    }

    const { fetchSituationalAwareness } = await import("../services/perplexity.js");
    const [corePrompt, chatAddendum, memories, dbHistory, householdResult, todayCalendar, currentWeather, todayTasks, existingSummary, situationalAwareness, skillsIndexBlock] = await Promise.all([
      loadPrompt("janus-core", SYSTEM_PROMPT, svc),
      loadPrompt("janus-chat-addendum", "", svc),
      (user || testModeAllowed) ? loadMemories(logUserId, svc) : Promise.resolve([]),
      ((user || testModeAllowed) && !newSession) ? loadConversationHistory(logUserId, 15, svc) : Promise.resolve([]),
      loadHouseholdMembers(svc),
      fetchTodayCalendar(svc),
      fetchCurrentWeather(),
      fetchTodayTasks(svc),
      ((user || testModeAllowed) && !newSession) ? loadSummary(logUserId, svc) : Promise.resolve(""),
      fetchSituationalAwareness().catch(() => ""),
      getSkillsIndexBlock(role, "chat"),
    ]);

    setNotionPeopleLookup(householdResult.notionPeopleLookup);
    const householdMembers = householdResult.directoryTable;
    const resolvedCorePrompt = renderSystemPrompt(corePrompt, { householdDirectory: householdMembers });
    const audioInstruction = "\n\nWhen the user sends an audio message, briefly acknowledge what they said before responding. Keep the acknowledgment under 10 words.";
    const briefingParts: string[] = [];
    if (todayCalendar) briefingParts.push(todayCalendar);
    if (currentWeather) briefingParts.push(currentWeather);
    if (todayTasks) briefingParts.push(todayTasks);
    if (situationalAwareness) briefingParts.push(situationalAwareness);
    const briefingBlock = briefingParts.length > 0
      ? `\n\n── LIVE BRIEFING (auto-refreshed each message) ──\n${briefingParts.join("\n\n")}\n\nYou already have this data — answer calendar/weather/task questions directly without calling tools unless the user asks about a DIFFERENT day, calendar, or specific database query.`
      : "";
    const memoryContext = memories.length > 0
      ? `\n\nPermanent memory — 25 most recent facts about this user (use recall_facts tool to search all memories):\n${memories.map((m: any) => `- ${m.key}: ${m.value}${m.context ? ` (${m.context})` : ""}`).join("\n")}`
      : "";
    const nowLA = new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/Los_Angeles" });
    const dateHeader = `Current date and time: ${nowLA}\nHousehold timezone: America/Los_Angeles (Pacific Time). ALL times you mention, calculate, or create MUST be in Pacific Time.\nWhen creating calendar events, ALWAYS use timeZone: "America/Los_Angeles".\n\n`;
    const systemPrompt = dateHeader + resolvedCorePrompt + audioInstruction + skillsIndexBlock + briefingBlock + memoryContext + getRoleSystemPromptAddendum(role) + (chatAddendum ? "\n\n" + chatAddendum : "");

    const sanitizedMessages = sanitizeMessages(messages);

    const lastUserMsg = [...sanitizedMessages].reverse().find((m: any) => m.role === "user");
    const lastUserContent = lastUserMsg?.content;
    const rawUserText = sanitizeText(
      typeof lastUserContent === "string"
        ? lastUserContent
        : Array.isArray(lastUserContent)
          ? lastUserContent.filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ") || "[media]"
          : "[unknown]"
    );

    const hasImagePart = Array.isArray(lastUserContent) && lastUserContent.some((p: any) => p.type === "image_url");
    let userMessageText = rawUserText;
    if (hasImagePart && Array.isArray(lastUserContent)) {
      const imgPart = lastUserContent.find((p: any) => p.type === "image_url");
      const dataUrl: string = imgPart?.image_url?.url || "";
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (match) {
        const mimeType = match[1];
        const base64 = match[2];
        const description = await extractImageDescription(base64, mimeType);
        if (description) {
          userMessageText = rawUserText && rawUserText !== "[media]"
            ? `${rawUserText} [Image: ${description}]`
            : `[Image: ${description}]`;
        }
      }
    }

    const hasVoiceInput = Array.isArray(lastUserContent) && lastUserContent.some((p: any) => p.type === "input_audio");

    let processedMessages = [...sanitizedMessages];
    let voiceTranscript = "";
    if (hasVoiceInput && Array.isArray(lastUserContent)) {
      const audioPart = lastUserContent.find((p: any) => p.type === "input_audio");
      const audioBase64 = audioPart?.input_audio?.data || "";
      const audioFormat = audioPart?.input_audio?.format || "webm";
      const voiceBaseUrl = `http://localhost:${process.env.PORT || 5000}`;
      if (audioBase64) {
        try {
          console.log(`[WebVoice] Transcribing ${audioFormat} audio via ElevenLabs (${audioBase64.length} chars base64)`);
          const sttResp = await fetch(`${voiceBaseUrl}/api/voice/elevenlabs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "transcribe", audio_base64: audioBase64, audio_format: audioFormat }),
          });
          if (sttResp.ok) {
            const sttData = await sttResp.json();
            voiceTranscript = (sttData.transcript || "").trim();
            console.log(`[WebVoice] Transcript: "${voiceTranscript.slice(0, 120)}"`);
          } else {
            console.error(`[WebVoice] ElevenLabs STT FAILED: ${sttResp.status}`);
          }
        } catch (e) { console.error("[WebVoice] ElevenLabs STT call error:", e); }
      }

      const lastIdx = sanitizedMessages.length - 1;
      const safeTranscript = sanitizeText(voiceTranscript);
      processedMessages = sanitizedMessages.map((msg: any, idx: number) => {
        if (!Array.isArray(msg.content)) return msg;
        const hasAudio = msg.content.some((p: any) => p.type === "input_audio");
        if (!hasAudio) return msg;
        if (idx === lastIdx && safeTranscript) {
          const textParts = msg.content.filter((p: any) => p.type !== "input_audio");
          textParts.push({ type: "text", text: safeTranscript });
          return { ...msg, content: textParts };
        } else {
          return { ...msg, content: msg.content.filter((p: any) => p.type !== "input_audio").concat({ type: "text", text: "[Voice message]" }) };
        }
      });
    }

    const allToolCallsForLog: any[] = [];

    if (newSession) console.log("New session flag set — skipping conversation history injection");
    let effectiveHistory = dbHistory;
    if (existingSummary && dbHistory.length > 6) {
      effectiveHistory = [{ role: "system", content: `Summary of earlier conversation:\n${existingSummary}` }, ...dbHistory.slice(-6)];
      console.log(`Using summarized history (${dbHistory.length} → ${effectiveHistory.length} messages)`);
    }
    const historyWithFallback = (!newSession && effectiveHistory.length === 0 && (user || testModeAllowed))
      ? [{ role: "system", content: "Note: Conversation history could not be loaded for this session. This user is a known household member — do NOT reset to an intro greeting. Continue the conversation naturally based on their current message." }]
      : effectiveHistory;
    const aiMessages = [{ role: "system", content: systemPrompt }, ...historyWithFallback, ...processedMessages];

    // Pick a model tier for this turn. Callers can still pass an explicit
    // body.complexity to force a tier (test_mode / legacy); otherwise we
    // run the heuristic classifier and re-evaluate after each tool round
    // inside the dispatch loop with monotonic upgrade — we never
    // downgrade mid-turn (see applyMonotonicUpgrade).
    const explicitOverride: "simple" | "default" | "complex" | undefined =
      complexityOverride === "simple" || complexityOverride === "complex" || complexityOverride === "default"
        ? complexityOverride
        : undefined;
    let currentComplexity: ComplexityDecision = explicitOverride
      ? { tier: explicitOverride, reason: "caller_override" }
      : classifyComplexity({ userMessage: userMessageText, history: effectiveHistory, toolCallsSoFar: 0 });
    const tierSelectionLog: Array<{ round: number; tier: ComplexityDecision["tier"]; reason: string; model: string }> = [
      { round: 0, tier: currentComplexity.tier, reason: currentComplexity.reason, model: pickModel(currentComplexity.tier) },
    ];
    console.log(`[complexity-router] turn start → tier=${currentComplexity.tier} model=${pickModel(currentComplexity.tier)} (${currentComplexity.reason})`);

    // X-Correlation-Id is already set by correlationMiddleware on the
    // response — re-set here because res.writeHead replaces headers.
    const correlationIdForResponse = req.correlationId || "";
    res.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...(correlationIdForResponse ? { "X-Correlation-Id": correlationIdForResponse } : {}),
    });

    async function writeSSE(data: string) {
      return new Promise<void>((resolve, reject) => {
        res.write(data, (err) => { if (err) reject(err); else resolve(); });
      });
    }

    // Emit the correlation id as the first SSE event so the web UI can
    // capture it for debugging without parsing response headers.
    if (correlationIdForResponse) {
      await writeSSE(`data: ${JSON.stringify({ type: "correlation_id", correlation_id: correlationIdForResponse })}\n\n`);
    }

    async function synthesizeVoiceReply(text: string, timeoutMs = 15_000): Promise<void> {
      try {
        if (!text) return;
        const voiceBaseUrl = `http://localhost:${process.env.PORT || 5000}`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        const synthesizeResp = await fetch(`${voiceBaseUrl}/api/voice/elevenlabs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "synthesize", text, return_base64: true }),
          signal: ac.signal,
        });
        clearTimeout(timer);
        if (synthesizeResp.ok) {
          const { audio_base64 } = await synthesizeResp.json();
          if (audio_base64) {
            console.log(`[WebVoice] TTS OK — sending ${audio_base64.length} chars`);
            await writeSSE(`data: ${JSON.stringify({ type: "voice_audio", audio: audio_base64 })}\n\n`);
          }
        } else {
          console.error(`[WebVoice] TTS failed: ${synthesizeResp.status}`);
        }
      } catch (e) { console.error("[WebVoice] Voice reply error:", e); }
    }

    ctx.imageSSECallback = async (base64: string, mime: string) => {
      try { await writeSSE(`data: ${JSON.stringify({ image_data: base64, mime })}\n\n`); } catch (e) { console.error("Failed to write image SSE event:", e); }
    };

    if (hasVoiceInput) {
      if (!voiceTranscript) {
        const retryMsg = "I couldn't catch that — could you try speaking again?";
        await writeSSE(`data: ${JSON.stringify({ type: "voice_transcript", transcript: "" })}\n\n`);
        await writeSSE(`data: ${JSON.stringify({ choices: [{ delta: { content: retryMsg } }] })}\n\n`);
        await synthesizeVoiceReply(retryMsg, 5000);
        await writeSSE("data: [DONE]\n\n");
        await logConversation(ctx.svc, logUserId, logDisplayName, role, "[voice — empty transcript]", retryMsg, [], "chat");
        ctx.imageSSECallback = undefined;
        res.end();
        return;
      }
      await writeSSE(`data: ${JSON.stringify({ type: "voice_transcript", transcript: voiceTranscript })}\n\n`);
    }

    async function streamRound(msgs: any[], streamToClient: boolean): Promise<{ finishReason: string; toolCalls: any[]; capturedText: string }> {
      const roundStart = Date.now();
      const modelForRound = pickModel(currentComplexity.tier);
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        // stream_options.include_usage = true asks OpenRouter to emit
        // the per-completion usage object in the final SSE chunk, which
        // we then capture and persist via janus_llm_usage.
        body: JSON.stringify({ model: modelForRound, messages: msgs, tools, stream: true, ...STREAM_USAGE_OPTION }),
      });

      if (!resp.ok) {
        if (resp.status === 429) {
          if (streamToClient) await writeSSE(`data: ${JSON.stringify({ choices: [{ delta: { content: "⚠️ Rate limited. Please try again shortly." } }] })}\n\n`);
          return { finishReason: "error", toolCalls: [], capturedText: "" };
        }
        if (resp.status === 402) {
          if (streamToClient) await writeSSE(`data: ${JSON.stringify({ choices: [{ delta: { content: "⚠️ AI credits exhausted." } }] })}\n\n`);
          return { finishReason: "error", toolCalls: [], capturedText: "" };
        }
        if (resp.status === 500) {
          const t = await resp.text();
          console.warn("AI gateway 500 — retrying with fallback models", t);
          if (streamToClient) await writeSSE(`: status:retrying\n\n`);

          for (const fallbackModel of FALLBACK_MODELS) {
            try {
              console.log(`Trying fallback model: ${fallbackModel}`);
              const retryResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: fallbackModel, messages: msgs, tools, stream: true, ...STREAM_USAGE_OPTION }),
              });
              if (retryResp.ok && retryResp.body) {
                console.log(`Fallback model ${fallbackModel} succeeded`);
                const retryStart = Date.now();
                const retryReader = retryResp.body.getReader();
                const retryDecoder = new TextDecoder();
                let retryTextBuffer = "";
                let retryCapturedText = "";
                const retryTcMap: Record<number, any> = {};
                let retryFinishReason = "stop";
                const retryRawSseLines: string[] = [];
                while (true) {
                  const { done, value } = await retryReader.read();
                  if (done) break;
                  retryTextBuffer += retryDecoder.decode(value, { stream: true });
                  let newlineIdx: number;
                  while ((newlineIdx = retryTextBuffer.indexOf("\n")) !== -1) {
                    let line = retryTextBuffer.slice(0, newlineIdx);
                    retryTextBuffer = retryTextBuffer.slice(newlineIdx + 1);
                    line = line.replace(/\r$/, "");
                    if (!line.startsWith("data: ") && !line.startsWith(": ")) continue;
                    if (line.startsWith(": ")) { if (streamToClient) await writeSSE(line + "\n\n"); continue; }
                    retryRawSseLines.push(line);
                    const payload = line.slice(6);
                    if (payload === "[DONE]") continue;
                    try {
                      const chunk = JSON.parse(payload);
                      const delta = chunk.choices?.[0]?.delta;
                      if (delta?.content) { retryCapturedText += delta.content; if (streamToClient) await writeSSE(`data: ${JSON.stringify(chunk)}\n\n`); }
                      if (delta?.tool_calls) { for (const tc of delta.tool_calls) { if (!retryTcMap[tc.index]) retryTcMap[tc.index] = { id: tc.id || "", function: { name: "", arguments: "" } }; if (tc.id) retryTcMap[tc.index].id = tc.id; if (tc.function?.name) retryTcMap[tc.index].function.name += tc.function.name; if (tc.function?.arguments) retryTcMap[tc.index].function.arguments += tc.function.arguments; } }
                      if (chunk.choices?.[0]?.finish_reason) retryFinishReason = chunk.choices[0].finish_reason;
                    } catch {}
                  }
                }
                // Capture usage for the fallback round too. tier is the
                // logical complexity, model is the fallback we actually used.
                const retryUsage = extractUsageFromStream(retryRawSseLines);
                if (retryUsage) {
                  const retryToolCalls = Object.values(retryTcMap).filter((tc) => tc.function.name);
                  recordLlmUsage(
                    {
                      userId: logUserId,
                      channel: "chat",
                      model: fallbackModel,
                      tier: currentComplexity.tier,
                      durationMs: Date.now() - retryStart,
                      requestType: retryToolCalls.length > 0 ? "tool_round" : "chat",
                    },
                    retryUsage,
                  ).catch(() => {});
                }
                return { finishReason: retryFinishReason, toolCalls: Object.values(retryTcMap), capturedText: retryCapturedText };
              }
              console.warn(`Fallback ${fallbackModel} also failed: ${retryResp.status}`);
            } catch (retryErr) { console.error(`Fallback ${fallbackModel} threw:`, retryErr); }
            await new Promise(r => setTimeout(r, 500));
          }
          console.error("All fallback models failed");
        }
        const t2 = await resp.text().catch(() => "");
        console.error("AI gateway error:", resp.status, t2);
        if (streamToClient) await writeSSE(`data: ${JSON.stringify({ choices: [{ delta: { content: "Sorry, I'm experiencing a temporary outage. Please try again in a few minutes." } }] })}\n\n`);
        return { finishReason: "error", toolCalls: [], capturedText: "" };
      }

      if (!resp.body) return { finishReason: "error", toolCalls: [], capturedText: "" };

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = "";
      let capturedText = "";
      const tcMap: Record<number, any> = {};
      let finishReason = "stop";
      // Buffer the raw "data: …" SSE lines so we can scan for the
      // usage object that OpenRouter emits in the final chunk when
      // stream_options.include_usage = true.
      const rawSseLines: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = textBuffer.indexOf("\n")) !== -1) {
          let line = textBuffer.slice(0, newlineIdx);
          textBuffer = textBuffer.slice(newlineIdx + 1);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (!line.startsWith("data: ")) continue;
          rawSseLines.push(line);
          const jsonStr = line.slice(6).trim();
          if (jsonStr === "[DONE]") { finishReason = finishReason || "stop"; break; }
          try {
            const chunk = JSON.parse(jsonStr);
            const delta = chunk.choices?.[0]?.delta;
            const fr = chunk.choices?.[0]?.finish_reason;
            if (fr && fr !== "null") finishReason = fr;

            if (delta?.content) {
              capturedText += delta.content;
              if (streamToClient) await writeSSE(`data: ${JSON.stringify({ choices: [{ delta: { content: delta.content } }] })}\n\n`);
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!tcMap[idx]) tcMap[idx] = { id: tc.id, function: { name: "", arguments: "" } };
                if (tc.id) tcMap[idx].id = tc.id;
                if (tc.function?.name) tcMap[idx].function.name += tc.function.name;
                if (tc.function?.arguments) tcMap[idx].function.arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
      }

      const toolCalls = Object.values(tcMap).filter((tc) => tc.function.name);
      if (toolCalls.length > 0) finishReason = "tool_calls";

      // Capture usage from the final SSE chunk. Fire-and-forget — a
      // metrics-write failure must never break a working chat reply.
      const usage = extractUsageFromStream(rawSseLines);
      if (usage) {
        recordLlmUsage(
          {
            userId: logUserId,
            channel: "chat",
            model: modelForRound,
            tier: currentComplexity.tier,
            durationMs: Date.now() - roundStart,
            requestType: toolCalls.length > 0 ? "tool_round" : "chat",
          },
          usage,
        ).catch(() => {});
      }

      return { finishReason, toolCalls, capturedText };
    }

    const REQUEST_TIMEOUT_MS = 120_000;
    const requestTimeout = setTimeout(async () => {
      console.error(`janus-chat: request-level timeout after ${REQUEST_TIMEOUT_MS / 1000}s`);
      try {
        await writeSSE(`data: ${JSON.stringify({ choices: [{ delta: { content: "\n\n⚠️ Request timed out after 2 minutes. Please try again with a simpler request." } }] })}\n\n`);
        await writeSSE("data: [DONE]\n\n");
        res.end();
      } catch {}
    }, REQUEST_TIMEOUT_MS);

    (async () => {
      try {
        const MAX_TOOL_ROUNDS = 8;
        let currentMessages = [...aiMessages];

        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          console.log(`Tool round ${round + 1} (single-pass streaming)`);
          let { finishReason, toolCalls, capturedText } = await streamRound(currentMessages, true);

          if (finishReason === "error") {
            await writeSSE("data: [DONE]\n\n");
            res.end();
            return;
          }

          if (finishReason !== "tool_calls" || toolCalls.length === 0) {
            console.log("Single-pass complete — no tool calls, response already streamed");

            const firedGuard = detectHallucination(capturedText, allToolCallsForLog);
            if (firedGuard) {
              console.warn(`HALLUCINATION DETECTED (Chat): ${firedGuard.consoleSummary}`);
              currentMessages.push(
                { role: "assistant", content: capturedText },
                { role: "user", content: firedGuard.overrideMessage },
              );
              auditHallucinationGuard({
                edgeFunction: "janus-chat",
                channel: "chat",
                guard: firedGuard,
                reply: capturedText,
                didRemediation: true,
                actorId: logUserId,
                actorName: logDisplayName,
                toolNames: allToolCallsForLog.map((t) => t.name),
              });
              continue;
            }

            const voicePromise = (hasVoiceInput && capturedText)
              ? (console.log(`[WebVoice] Synthesizing voice reply (${capturedText.length} chars)...`), synthesizeVoiceReply(capturedText))
              : Promise.resolve();

            capturedText = sanitizeGoogleFileUrls(capturedText, allToolCallsForLog);

            const urlPromise = validateAndCleanURLs(capturedText).catch(e => {
              console.error("[URLCheck] URL validation failed:", e);
              return { text: capturedText, deadCount: 0, deadUrls: [] as string[] };
            });

            const [, urlResult] = await Promise.all([voicePromise, urlPromise]);
            if (urlResult.deadCount > 0) {
              console.log(`[URLCheck] Chat: cleaned ${urlResult.deadCount} dead URL(s): ${urlResult.deadUrls.join(", ")}`);
              await writeSSE(`data: ${JSON.stringify({ type: "url_corrections", dead_urls: urlResult.deadUrls, corrected_text: urlResult.text })}\n\n`);
              capturedText = urlResult.text;
            }

            await writeSSE("data: [DONE]\n\n");
            // Stamp the per-round tier selection as a sentinel meta entry
            // on the JSONB tool_calls column. Sentinel name uses a `__`
            // prefix so anything iterating tool calls by real tool name
            // ignores it.
            const toolCallsWithMeta = [...allToolCallsForLog, { name: "__janus_meta", complexity: { final_tier: currentComplexity.tier, final_reason: currentComplexity.reason, selections: tierSelectionLog } }];
            await logConversation(ctx.svc, logUserId, logDisplayName, role, userMessageText, capturedText, toolCallsWithMeta, "chat");
            logAudit({ category: "janus", event_type: "chat_response", severity: "info", actor_id: logUserId, actor_name: logDisplayName, actor_role: role, channel: "chat", summary: `Chat: "${userMessageText.slice(0, 80)}"`, detail: { tool_count: allToolCallsForLog.length, response_length: capturedText.length, tools: allToolCallsForLog.map((t: any) => t.name), tier: currentComplexity.tier, tier_reason: currentComplexity.reason, tier_upgrades: tierSelectionLog.length - 1 }, status: "success" });
            if (user || testModeAllowed) summarizeIfNeeded(logUserId, dbHistory, svc).catch(() => {});
            res.end();
            return;
          }

          const toolNames = toolCalls.map((tc: any) => tc.function.name);
          console.log(`Executing ${toolCalls.length} tool call(s) in parallel: ${toolNames.join(", ")}`);

          const toolResults = await Promise.all(
            toolCalls.map(async (tc: any) => {
              let args: any;
              try { args = JSON.parse(tc.function.arguments); } catch {
                console.error(`Failed to parse tool args for ${tc.function.name}`);
                return { role: "tool", tool_call_id: tc.id, content: "Error: invalid arguments" };
              }
              const stepLabel = TOOL_STATUS_MAP[tc.function.name] || `Running ${tc.function.name}…`;
              await writeSSE(`: step_start:${stepLabel}\n\n`);
              const result = await executeToolWithTimeout(tc.function.name, args, logUserId, ctx);
              await writeSSE(`: step_done:${stepLabel}\n\n`);
              console.log(`Tool ${tc.function.name} result: ${result.slice(0, 200)}`);
              allToolCallsForLog.push({ name: tc.function.name, args, result: result.slice(0, 500) });
              return { role: "tool", tool_call_id: tc.id, content: result };
            })
          );

          const assistantMsg = {
            role: "assistant",
            content: capturedText || "",
            tool_calls: toolCalls.map((tc: any) => ({ id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } })),
          };
          currentMessages = [...currentMessages, assistantMsg, ...toolResults];

          // Re-classify after this round's tool calls. Skip when the
          // caller explicitly forced a tier — their choice sticks for
          // the whole turn. Otherwise apply monotonic upgrade so we
          // never flip-flop downward inside one chain.
          if (!explicitOverride) {
            const next = classifyComplexity({
              userMessage: userMessageText,
              history: effectiveHistory,
              toolCallsSoFar: allToolCallsForLog.filter((t) => t.name !== "load_skill").length,
            });
            const upgraded = applyMonotonicUpgrade(currentComplexity, next);
            if (upgraded.tier !== currentComplexity.tier) {
              console.log(`[complexity-router] round ${round + 1} upgrade: ${currentComplexity.tier} → ${upgraded.tier} (${upgraded.reason})`);
              currentComplexity = upgraded;
            }
            tierSelectionLog.push({ round: round + 1, tier: currentComplexity.tier, reason: currentComplexity.reason, model: pickModel(currentComplexity.tier) });
          }
        }

        console.log("Exhausted tool rounds, streaming final response");
        const { capturedText: finalText } = await streamRound(currentMessages, true);

        const exhaustedVoicePromise = (hasVoiceInput && finalText) ? synthesizeVoiceReply(finalText) : Promise.resolve();
        const sanitizedFinalText = sanitizeGoogleFileUrls(finalText, allToolCallsForLog);
        const exhaustedUrlPromise = validateAndCleanURLs(sanitizedFinalText).catch(e => {
          console.error("[URLCheck] URL validation failed:", e);
          return { text: finalText, deadCount: 0, deadUrls: [] as string[] };
        });
        const [, exhaustedUrlResult] = await Promise.all([exhaustedVoicePromise, exhaustedUrlPromise]);
        let validatedFinalText = finalText;
        if (exhaustedUrlResult.deadCount > 0) {
          console.log(`[URLCheck] Chat (exhausted): cleaned ${exhaustedUrlResult.deadCount} dead URL(s)`);
          await writeSSE(`data: ${JSON.stringify({ type: "url_corrections", dead_urls: exhaustedUrlResult.deadUrls, corrected_text: exhaustedUrlResult.text })}\n\n`);
          validatedFinalText = exhaustedUrlResult.text;
        }

        await writeSSE("data: [DONE]\n\n");
        const exhaustedToolCallsWithMeta = [...allToolCallsForLog, { name: "__janus_meta", complexity: { final_tier: currentComplexity.tier, final_reason: currentComplexity.reason, selections: tierSelectionLog } }];
        await logConversation(ctx.svc, logUserId, logDisplayName, role, userMessageText, validatedFinalText, exhaustedToolCallsWithMeta, "chat");
        if (user || testModeAllowed) summarizeIfNeeded(logUserId, dbHistory, svc).catch(() => {});
        res.end();
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const corrId = req.correlationId || "(no id)";
        console.error(`janus-chat stream error [${corrId}]:`, errMsg, e);
        try {
          const userMsg = errMsg.includes("timeout")
            ? "Request timed out. Please try again with a shorter question."
            : errMsg.includes("OPENROUTER_API_KEY") || errMsg.includes("API key")
              ? "AI service is not configured — please contact the admin."
              : errMsg.includes("credits") || errMsg.includes("402")
                ? "AI credits exhausted — please try again later."
                : "Sorry, something went wrong. Please try again.";
          await writeSSE(`data: ${JSON.stringify({ choices: [{ delta: { content: userMsg } }] })}\n\n`);
          await writeSSE("data: [DONE]\n\n");
          res.end();
        } catch {}
      } finally {
        clearTimeout(requestTimeout);
        ctx.imageSSECallback = undefined;
      }
    })();
  } catch (e) {
    console.error("janus-chat error:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
}
