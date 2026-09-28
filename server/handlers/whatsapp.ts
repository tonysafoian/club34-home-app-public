import type { Request, Response } from "express";
import { createClient, getServiceClient, type SupabaseClient } from "../utils/supabase.js";
import { fetchT } from "../utils/fetch-timeout.js";
import { getGoogleServiceToken } from "../utils/google-jwt.js";
import { sanitizeText } from "../utils/sanitize.js";
import { renderSystemPrompt, loadHouseholdDirectory } from "../utils/prompt-render.js";
import { detectHallucination, auditHallucinationGuard } from "../utils/hallucination-guards.js";
import {
  classifyComplexity,
  applyMonotonicUpgrade,
  pickModel,
  type ComplexityDecision,
} from "../utils/complexity-router.js";
import {
  extractUsageFromBody,
  recordLlmUsage,
} from "../lib/llm-usage.js";
import {
  logAudit as sharedLogAudit,
  loadPrompt,
  loadConversationHistory,
  loadMemories,
  executeSendEmail as sharedSendEmail,
  executeGmailSearch,
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
  refreshTeslaToken,
  TESLA_API_BASE,
  TESLA_AUTH_BASE,
  validateAndCleanURLs,
  sanitizeGoogleFileUrls,
  enqueueFailedJob,
  sendAutomationFailureAlert,
  getAlertPhoneNumber,
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
} from "../utils/tools/media-trips.js";
import { LOAD_SKILL_TOOL, executeLoadSkill, getSkillsIndexBlock } from "../utils/janus-skills.js";

import {
  executeLaunchResearch,
  executeSetReminder,
  executeQueryActivityLog,
  executeQuerySystemHealth,
  executeQuerySystemUpdates,
  checkDuplicateReminder,
} from "../utils/tools/research-admin.js";

import { executeBrowseWebsite } from "../utils/tools/browser.js";
import { executeReadCodebase, executeProposeCodeFix } from "../utils/tools/github-code.js";
import { logJanusChannelDecision } from "../lib/janusChannelAudit.js";
import { PDFParse } from "pdf-parse";

import fs from "fs";
import path from "path";

const logAudit = (entry: Record<string, unknown>) => sharedLogAudit("janus-whatsapp", entry);
const executeSendEmail = (to: string, subject: string, body: string) => sharedSendEmail(to, subject, body, "whatsapp", "janus-whatsapp");
const executeSaveToCart = (userId: string, platform: string, productName: string, productUrl?: string, price?: string, quantity?: number, notes?: string) => sharedSaveToCart(getServiceClient(), userId, platform, productName, productUrl, price, quantity, notes);
const executeViewCart = (userId: string, platform?: string) => sharedViewCart(getServiceClient(), userId, platform);
const executeClearCart = (userId: string, platform?: string) => sharedClearCart(getServiceClient(), userId, platform);
const executeRememberFact = (userId: string, key: string, value: string, context?: string, pinned?: boolean) => sharedRememberFact(getServiceClient(), userId, key, value, context, pinned);
const executeRecallFacts = (userId: string, keySearch?: string) => sharedRecallFacts(getServiceClient(), userId, keySearch);

let JANUS_SYSTEM_PROMPT: string;
try {
  JANUS_SYSTEM_PROMPT = fs.readFileSync(path.resolve(process.cwd(), "supabase/functions/_shared/SOUL.md"), "utf8");
} catch {
  JANUS_SYSTEM_PROMPT = "You are Janus, the AI assistant for Janus.";
}

const JANUS_NUMBER = "13102996015";
const COOLDOWN_SECONDS = 30;

function sanitizeReplyForWhatsApp(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/https?:\/\/[^\s]*supabase\.co\/storage\/[^\s)"]*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

setNotionPeopleLookup({
  admin: "00000000-0000-4000-a000-000000000001",
  member: "00000000-0000-4000-a000-000000000002",
});

async function isOnCooldown(senderId: string, channel: string, svc?: SupabaseClient): Promise<boolean> {
  try {
    const sb = svc || getServiceClient();
    const cutoff = new Date(Date.now() - COOLDOWN_SECONDS * 1000).toISOString();
    const { data, error } = await sb
      .from("janus_chat_logs")
      .select("id")
      .eq("user_id", senderId)
      .eq("channel", channel)
      .gte("created_at", cutoff)
      .limit(1);
    if (error) { console.error("Cooldown check error:", error); return true; }
    return (data && data.length > 0);
  } catch (e) { console.error("Cooldown check failed:", e); return true; }
}

async function resolvePhoneToUserId(phone: string, svc?: SupabaseClient): Promise<{ userId: string; displayName: string; role: string }> {
  const sb = svc || getServiceClient();
  const normalized = phone.replace(/[^\d]/g, "");
  const strippedOf1 = normalized.replace(/^1/, "");

  // household_members is the SOLE authority for granting non-outsider access.
  // If the number is not in household_members, it must be treated as an outsider
  // regardless of whether a matching profile exists.
  try {
    const { data: member } = await sb
      .from("household_members")
      .select("supabase_uuid, display_name, role")
      .in("whatsapp_number", [normalized, `+${normalized}`, `+1${strippedOf1}`])
      .eq("is_active", true)
      .limit(1)
      .single();
    if (member) {
      const userId = member.supabase_uuid || normalized;
      let role = member.role || "member";
      let displayName = member.display_name || "UNKNOWN";
      if (member.supabase_uuid) {
        const { data: roleData } = await sb
          .from("user_roles")
          .select("role")
          .eq("user_id", member.supabase_uuid)
          .single();
        if (roleData?.role) role = roleData.role;
        // Optionally enrich display name from profiles if not set in household_members
        if (!member.display_name) {
          try {
            const { data: profile } = await sb
              .from("profiles")
              .select("display_name")
              .eq("user_id", member.supabase_uuid)
              .single();
            if (profile?.display_name) displayName = profile.display_name;
          } catch {}
        }
      }
      console.log(`Resolved ${normalized} via household_members: ${displayName} (${role})`);
      return { userId, displayName, role };
    }
  } catch (e) {
    console.warn(`Household_members lookup failed for ${normalized}:`, e instanceof Error ? e.message : e);
  }

  console.warn(`Phone ${normalized} not found in household_members — treating as outsider`);
  return { userId: normalized, displayName: "UNKNOWN", role: "outsider" };
}

function getWatiConfig() {
  const rawEndpoint = process.env.WATI_API_ENDPOINT;
  let token = process.env.WATI_ACCESS_TOKEN;
  if (!rawEndpoint || !token) throw new Error("WATI not configured");
  token = token.replace(/^Bearer\s+/i, "");
  const endpoint = rawEndpoint.replace(/\/$/, "");
  const serverRoot = endpoint.replace(/\/api\/ext\/v3\/?$/, "").replace(/\/api\/ext\/?$/, "");
  const tenantRoot = serverRoot;
  return { endpoint, serverRoot, tenantRoot, token };
}

async function sendWhatsApp(to: string, message: string): Promise<string> {
  const { serverRoot, token } = getWatiConfig();
  const normalized = to.replace(/[^\d]/g, "");
  try {
    const res = await fetch(`${serverRoot}/api/ext/v3/conversations/messages/text`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: normalized, text: message }),
    });
    if (!res.ok) {
      const e = await res.text();
      console.error("WATI send error:", res.status, e);

      if (e.includes("5002") || e.toLowerCase().includes("conversation expired")) {
        console.log(`Conversation expired for ${normalized}, retrying with janus_utility template…`);
        const templateResult = await sendTemplateMessage(normalized, "janus_utility", [
          { name: "1", value: message.slice(0, 1024) },
        ]);
        if (!templateResult.startsWith("Failed")) {
          logAudit({ category: "janus", event_type: "whatsapp_sent", severity: "info", actor_id: "system", actor_name: "Janus", channel: "whatsapp", summary: `WhatsApp (template) to ${normalized}: ${message.slice(0, 80)}`, detail: { to: normalized, message_length: message.length, via: "template_fallback" }, status: "success" });
          return `WhatsApp message sent successfully to ${normalized} (via template — conversation window had expired)`;
        }
        console.error("Template fallback also failed:", templateResult);
      }

      logAudit({ category: "janus", event_type: "whatsapp_sent", severity: "error", actor_id: "system", actor_name: "Janus", channel: "whatsapp", summary: `WhatsApp to ${normalized} failed: HTTP ${res.status}`, detail: { to: normalized, message_length: message.length, error: e.slice(0, 300) }, status: "error" });
      return `WhatsApp failed (conversation expired — recipient hasn't messaged Janus in 24h). Use email instead.`;
    }
    console.log(`WhatsApp sent to ${normalized}: "${message.slice(0, 80)}"`);
    logAudit({ category: "janus", event_type: "whatsapp_sent", severity: "info", actor_id: "system", actor_name: "Janus", channel: "whatsapp", summary: `WhatsApp to ${normalized}: ${message.slice(0, 80)}`, detail: { to: normalized, message_length: message.length }, status: "success" });
    return `WhatsApp message sent successfully to ${normalized}`;
  } catch (e) {
    console.error("WATI send error:", e);
    logAudit({ category: "janus", event_type: "whatsapp_sent", severity: "error", actor_id: "system", actor_name: "Janus", channel: "whatsapp", summary: `WhatsApp to ${normalized} failed: ${e instanceof Error ? e.message : "unknown"}`, detail: { to: normalized, message_length: message.length }, status: "error" });
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

async function sendTemplateMessage(to: string, templateName: string, parameters?: { name: string; value: string }[]): Promise<string> {
  const { serverRoot, token } = getWatiConfig();
  const normalized = to.replace(/[^\d]/g, "");
  const body: any = {
    template_name: templateName,
    broadcast_name: `janus_${templateName}_${Date.now()}`,
    Recipients: [{ whatsappNumber: normalized, ...(parameters?.length ? { customParams: parameters } : {}) }],
  };
  try {
    const res = await fetch(`${serverRoot}/api/ext/v3/messageTemplates/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { const e = await res.text(); console.error("WATI template error:", res.status, e); return `Failed: ${res.status}`; }
    return `Template "${templateName}" sent to ${normalized}`;
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export const ADMIN_ONLY_TOOLS = new Set(["send_email", "gmail_search", "batch_update_notion_pages", "query_system_health", "read_codebase", "propose_code_fix", "delete_calendar_event"]);
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
]);

export const ALL_TOOLS = [
  { type: "function", function: { name: "send_email", description: "Send an email from assistant@example.com. ADMIN ONLY.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"], additionalProperties: false } } },
  { type: "function", function: { name: "gmail_search", description: "Search Tony's Gmail inbox using Gmail search syntax. ADMIN ONLY.", parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "send_whatsapp", description: "Send a WhatsApp message via WATI.", parameters: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"], additionalProperties: false } } },
  { type: "function", function: { name: "query_notion_database", description: "Query a Notion database.", parameters: { type: "object", properties: { database_id: { type: "string" }, filter: { type: "object" } }, required: ["database_id"], additionalProperties: false } } },
  { type: "function", function: { name: "update_notion_page", description: "Update properties on a Notion page.", parameters: { type: "object", properties: { page_id: { type: "string" }, properties: { type: "object" } }, required: ["page_id", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "batch_update_notion_pages", description: "Batch update multiple Notion pages. ADMIN ONLY.", parameters: { type: "object", properties: { page_ids: { type: "array", items: { type: "string" } }, properties: { type: "object" } }, required: ["page_ids", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "create_notion_page", description: "Create a new page in a Notion database. Pass simple key-value properties — the system auto-fetches the database schema and converts values to the correct Notion format. Use get_notion_database first if you need to discover property names. Example: {\"Name\": \"My Project\", \"Status\": \"In Progress\", \"Due Date\": \"2025-04-01\"}.", parameters: { type: "object", properties: { database_id: { type: "string" }, properties: { type: "object" } }, required: ["database_id", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "get_notion_database", description: "Get a Notion database schema.", parameters: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"], additionalProperties: false } } },
  { type: "function", function: { name: "perplexity_search", description: "Search the web using Perplexity AI for synthesized, cited answers to knowledge questions. PREFERRED over web_search for: factual questions, research topics, explanations, comparisons. Use web_search instead ONLY for finding specific websites/URLs.", parameters: { type: "object", properties: { query: { type: "string" }, deep: { type: "boolean" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "home_troubleshoot", description: "Get troubleshooting advice for home system issues (HVAC, plumbing, electrical, pool, security, appliances, etc.).", parameters: { type: "object", properties: { system: { type: "string" }, issue: { type: "string" } }, required: ["system", "issue"], additionalProperties: false } } },
  { type: "function", function: { name: "web_search", description: "Search the web for links, products, URLs, and raw search results. For factual/knowledge questions, prefer perplexity_search.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "scrape_website", description: "Scrape a webpage and extract content as markdown.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "browse_website", description: "Open a real browser to interact with a website.", parameters: { type: "object", properties: { url: { type: "string" }, instruction: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { action: { type: "string", enum: ["navigate", "act", "extract"] }, value: { type: "string" } }, required: ["action", "value"] } } }, required: ["url", "instruction"], additionalProperties: false } } },
  { type: "function", function: { name: "save_to_cart", description: "Save a product to the shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" }, product_name: { type: "string" }, product_url: { type: "string" }, price: { type: "string" }, quantity: { type: "number" }, notes: { type: "string" } }, required: ["platform", "product_name"], additionalProperties: false } } },
  { type: "function", function: { name: "view_cart", description: "View shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "clear_cart", description: "Clear shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "remember_fact", description: "Save a permanent fact about the user. Set pinned=true for durable, high-importance facts that must survive the 200-row FIFO eviction cap.", parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, context: { type: "string" }, pinned: { type: "boolean", description: "Pin this fact so it survives FIFO eviction. Use for durable, high-importance facts: allergies, alarm/lock codes, medication schedules, emergency contacts." } }, required: ["key", "value"], additionalProperties: false } } },
  { type: "function", function: { name: "recall_facts", description: "Search permanent memory for facts about the user. Matches by key prefix first; falls back to semantic similarity if no exact match.", parameters: { type: "object", properties: { key_search: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "get_calendar_events", description: "Get Google Calendar events for a time range.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, time_min: { type: "string" }, time_max: { type: "string" }, max_results: { type: "number" } }, required: ["time_min", "time_max"], additionalProperties: false } } },
  { type: "function", function: { name: "create_calendar_event", description: "Create a Google Calendar event.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, attendees: { type: "array", items: { type: "string" } } }, required: ["title", "start", "end"], additionalProperties: false } } },
  { type: "function", function: { name: "delete_calendar_event", description: "Delete a Google Calendar event by its event ID. ADMIN ONLY.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, event_id: { type: "string" } }, required: ["event_id"], additionalProperties: false } } },
  { type: "function", function: { name: "check_availability", description: "Check free/busy availability for one or more people.", parameters: { type: "object", properties: { emails: { type: "array", items: { type: "string" } }, time_min: { type: "string" }, time_max: { type: "string" } }, required: ["emails", "time_min", "time_max"], additionalProperties: false } } },
  { type: "function", function: { name: "get_directions", description: "Get driving directions and travel time.", parameters: { type: "object", properties: { destination: { type: "string" }, origin: { type: "string" }, mode: { type: "string" } }, required: ["destination"], additionalProperties: false } } },
  { type: "function", function: { name: "search_places", description: "Search for places/businesses near a location.", parameters: { type: "object", properties: { query: { type: "string" }, near: { type: "string" }, type: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "get_environment_data", description: "Get air quality, pollen levels, and weather alerts.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "search_news", description: "Search for recent news articles.", parameters: { type: "object", properties: { query: { type: "string" }, period: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_states", description: "Get current state of Home Assistant entities.", parameters: { type: "object", properties: { domain: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_state", description: "Get state of a specific Home Assistant entity.", parameters: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_call_service", description: "Control a Home Assistant device.", parameters: { type: "object", properties: { domain: { type: "string" }, service: { type: "string" }, service_data: { type: "object" } }, required: ["domain", "service"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_logbook", description: "Get Home Assistant activity log.", parameters: { type: "object", properties: { hours: { type: "number" }, entity_id: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "set_reminder", description: "Set a scheduled reminder.", parameters: { type: "object", properties: { due_at: { type: "string" }, message: { type: "string" }, channel: { type: "string" }, whatsapp_number: { type: "string" } }, required: ["due_at", "message", "channel"], additionalProperties: false } } },
  { type: "function", function: { name: "launch_research", description: "Launch a deep research task.", parameters: { type: "object", properties: { topic: { type: "string" }, instructions: { type: "string" }, email_to: { type: "string" } }, required: ["topic", "email_to"], additionalProperties: false } } },
  { type: "function", function: { name: "generate_media", description: "Generate an image or video using AI. HOUSEHOLD MEMBERS ONLY.", parameters: { type: "object", properties: { prompt: { type: "string" }, type: { type: "string", enum: ["image", "video"] }, platform: { type: "string", enum: ["gemini", "fal"] }, email_to: { type: "string" }, whatsapp_number: { type: "string" } }, required: ["prompt", "type", "email_to"], additionalProperties: false } } },
  { type: "function", function: { name: "manage_trip", description: "Create, update, or delete a trip card.", parameters: { type: "object", properties: { action: { type: "string", enum: ["create", "update", "delete"] }, trip_id: { type: "string" }, trip_name: { type: "string" }, destination: { type: "string" }, departure_date: { type: "string" }, return_date: { type: "string" }, status: { type: "string", enum: ["draft", "confirmed", "completed"] }, travelers: { type: "array", items: { type: "string" } }, flights: { type: "array", items: { type: "object", properties: { flight_number: { type: "string" }, airline: { type: "string" }, from: { type: "string" }, to: { type: "string" }, departure_datetime: { type: "string" }, arrival_datetime: { type: "string" }, cabin_class: { type: "string" }, confirmation_code: { type: "string" } } } }, hotels: { type: "array", items: { type: "object", properties: { name: { type: "string" }, address: { type: "string" }, check_in: { type: "string" }, check_out: { type: "string" }, room_type: { type: "string" }, confirmation_code: { type: "string" } } } }, notes: { type: "string" } }, required: ["action", "trip_name"], additionalProperties: false } } },
  { type: "function", function: { name: "query_trips", description: "Query upcoming or past trips.", parameters: { type: "object", properties: { status: { type: "string" }, upcoming_only: { type: "boolean" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_entertainment", description: "Query upcoming entertainment events.", parameters: { type: "object", properties: { category: { type: "string" }, upcoming_only: { type: "boolean" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_media", description: "Query movies and TV shows.", parameters: { type: "object", properties: { category: { type: "string" }, limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "suggest_movie", description: "Get AI-powered movie recommendations.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "attach_file_to_notion", description: "Upload and attach a file to a Notion page.", parameters: { type: "object", properties: { page_id: { type: "string" }, base64_data: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" } }, required: ["page_id", "base64_data", "filename", "mime_type"], additionalProperties: false } } },
  { type: "function", function: { name: "create_google_file", description: "Create a Google Workspace file (Doc, Sheet, Slides, or Form).", parameters: { type: "object", properties: { file_type: { type: "string", enum: ["doc", "sheet", "slides", "form"] }, title: { type: "string" }, content: { type: "string" }, share_with: { type: "array", items: { type: "string" } } }, required: ["file_type", "title", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "check_tesla_status", description: "Check Tesla vehicles status.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_verkada_security", description: "Check Verkada security system.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_generator_status", description: "Check Generac generator status.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "query_activity_log", description: "Recent activity from Janus's central app-activity log (home, network, ball, security, automations, logins, and more). Pass an optional keyword to filter.", parameters: { type: "object", properties: { event_type: { type: "string", description: "Optional keyword to filter the feed" }, hours: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_system_health", description: "Check Janus app health status. ADMIN ONLY.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "query_system_updates", description: "Get recent Janus app updates.", parameters: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "read_codebase", description: "Read one or more files from the Janus codebase on GitHub. Accepts file paths or directory paths. ADMIN ONLY.", parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "List of file or directory paths to read (e.g. ['server/utils/tools/home-automation.ts', 'lib/github.ts'])" } }, required: ["paths"], additionalProperties: false } } },
  { type: "function", function: { name: "propose_code_fix", description: "Create a GitHub branch and pull request with a proposed code change. ADMIN ONLY. Never pushes to main directly.", parameters: { type: "object", properties: { file_path: { type: "string", description: "Repo-relative path to the file to create or update" }, new_content: { type: "string", description: "Full new content for the file" }, commit_message: { type: "string", description: "Commit message" }, pr_title: { type: "string", description: "Pull request title" }, pr_body: { type: "string", description: "Pull request description explaining the change and reasoning" } }, required: ["file_path", "new_content", "commit_message", "pr_title", "pr_body"], additionalProperties: false } } },
  LOAD_SKILL_TOOL,
];

function getToolsForRole(role: string) {
  if (role === "admin") return ALL_TOOLS;
  if (role === "member") return ALL_TOOLS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.function.name));
  return ALL_TOOLS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.function.name) && !HOUSEHOLD_ONLY_TOOLS.has(t.function.name) && !OUTSIDER_BLOCKED_TOOLS.has(t.function.name));
}

const TIER_C_BLOCKED_TOOLS = new Set(["send_email", "batch_update_notion_pages"]);

function getToolsForGroupContext(role: string, groupTier: string) {
  if (groupTier === "C") return ALL_TOOLS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.function.name) && !TIER_C_BLOCKED_TOOLS.has(t.function.name));
  return getToolsForRole(role);
}

async function executeSetReminderWA(due_at: string, message: string, channel: string, whatsapp_number: string | undefined, userId?: string): Promise<string> {
  try {
    const sb = getServiceClient();
    let userEmail = "admin@example.com";
    if (userId) {
      const { data: member } = await sb.from("household_members").select("email").eq("supabase_uuid", userId).single();
      if (member?.email) userEmail = member.email;
    }
    const dupMsg = await checkDuplicateReminder(sb, userId || "whatsapp-user", message, due_at);
    if (dupMsg) return dupMsg;
    const { error } = await sb.from("janus_reminders").insert({
      user_id: userId || "whatsapp-user",
      user_email: userEmail,
      reminder_text: message,
      due_at,
      channel: channel || "whatsapp",
      whatsapp_number: whatsapp_number || null,
    });
    if (error) return `TOOL_ERROR: Failed to save reminder: ${error.message}`;
    const dueDate = new Date(due_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    return `✅ Reminder set! I'll send you a ${channel} message on ${dueDate}: "${message}"`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

async function executeLaunchResearchWA(topic: string, instructions: string | undefined, email_to: string): Promise<string> {
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
    fetch(`${baseUrl}/api/research/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, instructions: instructions || "", email_to }),
    }).catch((e) => console.error("Research worker fire-and-forget error:", e));
    return `🔬 Research launched on "${topic}" — expect a detailed report in your email (${email_to}) in ~10 minutes.`;
  } catch (e) {
    return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

async function executeGenerateMediaWA(prompt: string, type: "image" | "video", emailTo: string, whatsappNumber?: string, platform?: string): Promise<string> {
  const BASE_URL = `http://localhost:${process.env.PORT || 5000}`;
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;

  if (type === "image") {
    try {
      let base64: string;
      let mimeType: string;
      const useFal = platform === "fal";

      if (useFal) {
        const FAL_API_KEY = process.env.FAL_API_KEY;
        if (!FAL_API_KEY) return "FAL_API_KEY not configured.";
        const falRes = await fetchT("https://fal.run/fal-ai/flux-pro/v1.1-ultra", {
          method: "POST",
          headers: { Authorization: `Key ${FAL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, num_images: 1, enable_safety_checker: false }),
        });
        if (!falRes.ok) { const err = await falRes.text(); return `FAL image generation failed (HTTP ${falRes.status}): ${err.slice(0, 200)}`; }
        const falData = await falRes.json();
        const imageUrl = falData.images?.[0]?.url;
        if (!imageUrl) return "FAL image generation failed: no image URL returned.";
        const imgRes = await fetchT(imageUrl);
        if (!imgRes.ok) return "Failed to download FAL image.";
        const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
        base64 = Buffer.from(imgBytes).toString("base64");
        mimeType = falData.images?.[0]?.content_type || "image/jpeg";
      } else {
        const res = await fetchT("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-image",
            messages: [{ role: "user", content: prompt }],
            modalities: ["image", "text"],
          }),
        });
        if (!res.ok) { const err = await res.text(); return `Image generation failed (HTTP ${res.status}): ${err.slice(0, 200)}`; }
        const data = await res.json();
        const imageDataUrl =
          data.choices?.[0]?.message?.images?.[0]?.image_url?.url ||
          data.choices?.[0]?.message?.content?.find?.((p: any) => p.type === "image_url")?.image_url?.url;
        if (!imageDataUrl) return `Image generation failed: no image data returned.`;
        base64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, "");
        mimeType = imageDataUrl.match(/^data:(image\/\w+);base64,/)?.[1] || "image/png";
      }

      const bytes = Buffer.from(base64, "base64");
      const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
      const filename = `generated-images/${Date.now()}.${ext}`;
      const sb = createClient();
      const { error } = await sb.storage.from("voice-replies").upload(filename, bytes, { contentType: mimeType, upsert: true });
      if (error) return `Image upload failed: ${error.message}`;
      const { data: urlData } = sb.storage.from("voice-replies").getPublicUrl(filename);
      const publicUrl = urlData.publicUrl;

      fetch(`${BASE_URL}/api/media/worker`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "image_deliver", publicUrl, prompt, email_to: emailTo, whatsapp_number: whatsappNumber }),
      }).catch((e) => console.error("Media delivery error:", e));

      return JSON.stringify({ success: true, type: "image", platform: useFal ? "fal" : "gemini", publicUrl, message: `🎨 Image generated and sent to ${emailTo}. Public URL: ${publicUrl}` });
    } catch (e) { return `Image generation error: ${e instanceof Error ? e.message : "unknown"}`; }
  } else {
    fetch(`${BASE_URL}/api/media/worker`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "video", prompt, email_to: emailTo, whatsapp_number: whatsappNumber }),
    }).catch((e) => console.error("Media worker error:", e));
    return `🎬 Video generation launched using Veo 3.1 Fast. This takes 1-2 minutes — I'll send it via email${whatsappNumber ? " and WhatsApp" : ""} when ready.`;
  }
}

async function executeCreateGoogleFileWA(fileType: string, title: string, content: string, shareWith?: string[], userId?: string): Promise<string> {
  try {
    const token = await getGoogleServiceToken(["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/presentations"], "assistant@example.com");
    let fileUrl = "", fileId = "";
    if (fileType === "doc") {
      const r = await fetch("https://docs.googleapis.com/v1/documents", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
      if (!r.ok) return `TOOL_ERROR: ${await r.text()}`;
      const doc = await r.json(); fileId = doc.documentId; fileUrl = `https://docs.google.com/document/d/${fileId}`;
      await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }) });
    } else if (fileType === "sheet") {
      const rows = content.split("\n").map(l => l.split("|").map(c => c.trim()));
      const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ properties: { title }, sheets: [{ properties: { title: "Sheet1" } }] }) });
      if (!r.ok) return `TOOL_ERROR: ${await r.text()}`;
      const s = await r.json(); fileId = s.spreadsheetId; fileUrl = `https://docs.google.com/spreadsheets/d/${fileId}`;
      if (rows.length) await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/Sheet1!A1:append?valueInputOption=USER_ENTERED`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) });
    } else if (fileType === "slides") {
      const r = await fetch("https://slides.googleapis.com/v1/presentations", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
      if (!r.ok) return `TOOL_ERROR: ${await r.text()}`;
      const p = await r.json(); fileId = p.presentationId; fileUrl = `https://docs.google.com/presentation/d/${fileId}`;
    } else if (fileType === "form") {
      const r = await fetch("https://forms.googleapis.com/v1/forms", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ info: { title } }) });
      if (!r.ok) return `TOOL_ERROR: ${await r.text()}`;
      const f = await r.json(); fileId = f.formId; fileUrl = f.responderUri || `https://docs.google.com/forms/d/${fileId}`;
      const qs = content.split("\n").filter(Boolean);
      if (qs.length) await fetch(`https://forms.googleapis.com/v1/forms/${fileId}:batchUpdate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ requests: qs.map((q, i) => ({ createItem: { item: { title: q.trim(), questionItem: { question: { required: false, textQuestion: { paragraph: false } } } }, location: { index: i } } })) }) });
    } else return `TOOL_ERROR: Unknown file type "${fileType}"`;
    if (userId) { const sb = getServiceClient(); const { data: m } = await sb.from("household_members").select("email").eq("supabase_uuid", userId).single(); if (m?.email) await shareFileWA(fileId, m.email, token); }
    if (shareWith?.length) for (const e of shareWith) await shareFileWA(fileId, e, token);
    const label = fileType === "doc" ? "Google Doc" : fileType === "sheet" ? "Google Sheet" : fileType === "slides" ? "Google Slides" : "Google Form";
    return `✅ Created ${label}: "${title}" — ${fileUrl}`;
  } catch (e) { return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`; }
}

async function shareFileWA(fileId: string, email: string, token: string): Promise<void> {
  try { await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: "user", role: "writer", emailAddress: email }) }); } catch (e) { console.error(`Share error:`, e); }
}

const WA_URL_PATTERN = /https?:\/\/|www\.|\.com\/|\.org\/|\.net\/|find.*(?:website|link|url|site)|(?:link|url|site)\s+(?:to|for)/i;
const WA_KNOWLEDGE_PATTERN = /^(?:what|who|why|how|when|where|explain|compare|describe|summarize|is there|are there|does|do|can|could|should|will|would|tell me|define|list|name)\b/i;

function classifySearchIntent(query: string): "perplexity" | "firecrawl" | "either" {
  if (WA_URL_PATTERN.test(query)) return "firecrawl";
  if (WA_KNOWLEDGE_PATTERN.test(query)) return "perplexity";
  return "either";
}

async function executeTool(name: string, args: any, userId?: string, role?: string): Promise<string> {
  const svc = getServiceClient();
  switch (name) {
    case "send_email": return executeSendEmail(args.to, args.subject, args.body);
    case "gmail_search": return executeGmailSearch(args.query, args.max_results);
    case "send_whatsapp": return sendWhatsApp(args.to, args.message);
    case "query_notion_database": return executeQueryNotionDatabase(args.database_id, args.filter);
    case "update_notion_page": return executeUpdateNotionPage(args.page_id, args.properties);
    case "batch_update_notion_pages": return executeBatchUpdateNotionPages(args.page_ids, args.properties);
    case "create_notion_page": return executeCreateNotionPage(args.database_id, args.properties);
    case "get_notion_database": return executeGetNotionDatabase(args.database_id);
    case "perplexity_search": {
      const intent = classifySearchIntent(args.query);
      if (intent === "firecrawl") return executeWebSearch(args.query, args.limit || 5);
      return executePerplexitySearch(args.query, args.deep);
    }
    case "home_troubleshoot": {
      const { fetchTroubleshootingAdvice } = await import("../services/perplexity.js");
      return fetchTroubleshootingAdvice(args.system, args.issue);
    }
    case "web_search": {
      const intent = classifySearchIntent(args.query);
      if (intent === "perplexity") return executePerplexitySearch(args.query, false);
      return executeWebSearch(args.query, args.limit);
    }
    case "scrape_website": return executeScrapeWebsite(args.url);
    case "browse_website": return executeBrowseWebsite(args.url, args.instruction, args.steps, { source: "whatsapp", userId, url: args.url, instruction: args.instruction });
    case "save_to_cart": return executeSaveToCart(userId || "anonymous", args.platform, args.product_name, args.product_url, args.price, args.quantity, args.notes);
    case "view_cart": return executeViewCart(userId || "anonymous", args.platform);
    case "clear_cart": return executeClearCart(userId || "anonymous", args.platform);
    case "remember_fact": return executeRememberFact(userId || "anonymous", args.key, args.value, args.context, args.pinned);
    case "recall_facts": return executeRecallFacts(userId || "anonymous", args.key_search);
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
    case "set_reminder": return executeSetReminderWA(args.due_at, args.message, args.channel, args.whatsapp_number, userId);
    case "launch_research": return executeLaunchResearchWA(args.topic, args.instructions, args.email_to);
    case "generate_media": return executeGenerateMediaWA(args.prompt, args.type, args.email_to, args.whatsapp_number, args.platform);
    case "manage_trip": return executeManageTrip(args, svc);
    case "query_trips": return executeQueryTrips(args, svc);
    case "query_entertainment": return executeQueryEntertainment(args, svc);
    case "query_media": return executeQueryMedia(args, svc);
    case "suggest_movie": return executeSuggestMovie(args.query);
    case "attach_file_to_notion": return executeAttachFileToNotion(args.page_id, args.base64_data, args.filename, args.mime_type);
    case "create_google_file": return executeCreateGoogleFileWA(args.file_type, args.title, args.content, args.share_with, userId);
    case "check_tesla_status": return executeCheckTeslaStatus(svc);
    case "check_verkada_security": return executeCheckVerkadaSecurity(svc);
    case "check_generator_status": return executeCheckGeneratorStatus();
    case "query_activity_log": return executeQueryActivityLog(args.event_type, args.hours, svc);
    case "query_system_health": return executeQuerySystemHealth(svc);
    case "query_system_updates": return executeQuerySystemUpdates(args.limit, svc);
    case "read_codebase": return executeReadCodebase(args.paths);
    case "propose_code_fix": return executeProposeCodeFix(args.file_path, args.new_content, args.commit_message, args.pr_title, args.pr_body);
    case "load_skill": return executeLoadSkill(args.slug, role || "outsider", "whatsapp", userId);
    default: return `Unknown tool: ${name}`;
  }
}


async function countOutsiderMessages24h(phone: string, svc?: SupabaseClient): Promise<number> {
  try {
    const sb = svc || getServiceClient();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count, error } = await sb
      .from("janus_chat_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", phone)
      .gte("created_at", cutoff)
      .neq("assistant_response", "(pending)");
    if (error) return 0;
    return count ?? 0;
  } catch { return 0; }
}

async function sendOutsiderFirstContactAlert(phone: string, message: string): Promise<void> {
  try {
    const alertBody = `🔔 Unknown number messaged Janus\n\nPhone: +${phone}\nMessage: "${message.slice(0, 200)}"\n\nThis is the first message from this number. Review in Admin → Outsider Logs.`;
    const alertPhone = await getAlertPhoneNumber();
    await sendWhatsApp(alertPhone, alertBody);
    await executeSendEmail("admin@example.com", `🔔 Unknown number messaged Janus (+${phone})`, alertBody);
  } catch (e) { console.error("Failed to send outsider first-contact alert:", e); }
}

// Hallucination detection lives in server/utils/hallucination-guards.ts.
// Imported below and used at the no-tool-call branch of askJanusWithTools.

async function sendAbuseAlert(phone: string, messageCount: number, lastMessage: string): Promise<void> {
  try {
    const body = `⚠️ Outsider Abuse Alert\n\nPhone: +${phone}\nMessages in last 24h: ${messageCount}\nLast message: "${lastMessage}"\n\nPlease review in the Admin → Outsider Logs section.`;
    await executeSendEmail("admin@example.com", `⚠️ Outsider using Janus (+${phone})`, body);
  } catch (e) { console.error("Failed to send abuse alert:", e); }
}

const OUTSIDER_SYSTEM_PROMPT = `You are Janus, a private household assistant. You received a message from someone outside the household.
You can ONLY help relay basic messages to the family. Do NOT reveal names, schedules, addresses, or any personal information.
Keep replies to 1-2 sentences max. Be warm but firm. You have NO access to any household tools, calendars, or data.`;

async function askJanusOutsider(userMessage: string): Promise<string> {
  userMessage = sanitizeText(userMessage);
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) return "Hi! I'm only able to help with basic logistics. How can I assist?";
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          { role: "system", content: OUTSIDER_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        stream: false,
      }),
    });
    if (!response.ok) return "Hi! I'm only able to help with basic logistics. How can I assist?";
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Hi! I'm only able to help with basic logistics. How can I assist?";
  } catch {
    return "Hi! I'm only able to help with basic logistics. How can I assist?";
  }
}

async function fetchTodayCalendar(): Promise<string> {
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
  } catch (e) { console.error("Failed to prefetch calendar:", e); return ""; }
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

async function fetchTodayTasks(): Promise<string> {
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

interface GroupConfig {
  id?: string;
  group_id: string;
  group_name: string;
  tier: string;
  notes: string | null;
  trusted_phones: string[];
  message_count: number;
  created_at?: string;
  updated_at?: string;
}

async function getOrCreateGroupConfig(groupId: string, svc: SupabaseClient): Promise<GroupConfig> {
  const { data: existing } = await svc.from("janus_group_configs").select("*").eq("group_id", groupId).single();
  if (existing) return existing as GroupConfig;
  const newConfig: any = { group_id: groupId, group_name: "", tier: "C", notes: null, trusted_phones: [], message_count: 0 };
  const { data: created } = await svc.from("janus_group_configs").insert(newConfig).select("*").single();
  console.log(`New group detected: ${groupId} — defaulting to Tier C`);
  return (created as GroupConfig) || { ...newConfig, id: groupId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
}

async function incrementGroupMessageCount(groupId: string, svc: SupabaseClient): Promise<void> {
  try {
    await svc.rpc("increment_group_message_count" as any, { p_group_id: groupId });
  } catch {
    try {
      const { data } = await svc.from("janus_group_configs").select("message_count").eq("group_id", groupId).single();
      if (data) await svc.from("janus_group_configs").update({ message_count: (data.message_count || 0) + 1 }).eq("group_id", groupId);
    } catch (e) { console.error("Failed to increment group count:", e); }
  }
}


function buildGroupContextPrompt(groupConfig: GroupConfig, senderName: string, senderRole: string, isHouseholdMember: boolean): string {
  const tierLabel = groupConfig.tier === "A" ? "Family-Only (Tier A)" : groupConfig.tier === "B" ? "Trusted Mixed (Tier B)" : "Public Mixed (Tier C)";
  const groupLabel = groupConfig.group_name ? `"${groupConfig.group_name}"` : `group ${groupConfig.group_id}`;
  let privacyRules: string;
  let senderLabel: string;

  if (groupConfig.tier === "A") {
    senderLabel = `household ${senderRole}`;
    privacyRules = `This is a FAMILY-ONLY group. You may speak freely about household matters.`;
  } else if (groupConfig.tier === "B") {
    senderLabel = isHouseholdMember ? `household ${senderRole}` : "outsider/stranger";
    privacyRules = `This is a TRUSTED MIXED group. Do NOT reveal: precise vehicle GPS, Verkada feeds, door/alarm codes, financial details.`;
  } else {
    senderLabel = isHouseholdMember ? `household ${senderRole}` : "outsider/stranger";
    privacyRules = `This is a PUBLIC MIXED group. STRICT privacy mode. NEVER reveal sensitive household data.`;
  }

  return `\n\n━━━ GROUP CONVERSATION CONTEXT ━━━\nYou are in a WhatsApp GROUP (${tierLabel}): ${groupLabel}\nCurrent message sender: ${senderName} — ${senderLabel}\n\n${privacyRules}\n\nIMPORTANT: Your reply will be visible to ALL group members.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

function stripMentionFromMessage(text: string): string {
  return text
    .replace(/^(?:ok|okay|hey|hi|yo|oi)?\s*@?janus[,:]?\s*/i, "")
    .replace(/\bjanus[,:]?\s+/gi, "")
    .trim() || text;
}

async function askJanusWithTools(
  conversationHistory: { role: string; content: string }[],
  userMessage: string,
  role: string,
  userId?: string,
  imageBase64?: string | null,
  imageMimeType?: string,
  groupContextPrompt?: string,
  groupTier?: string,
  preloadedCorePrompt?: string,
  preloadedAddendum?: string,
  voiceAudioBase64?: string | null,
  videoBase64?: string | null,
  videoMimeType?: string,
  preloadedHouseholdDirectory?: string,
): Promise<{ reply: string; toolCalls: any[] }> {
  userMessage = sanitizeText(userMessage);
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");

  const [corePromptRaw, whatsappAddendum, memories, conversationHistoryFromParallel, todayCalendar, currentWeather, todayTasks, householdDirectory, skillsIndexBlock] = await Promise.all([
    preloadedCorePrompt ? Promise.resolve(preloadedCorePrompt) : loadPrompt("janus-core", JANUS_SYSTEM_PROMPT),
    preloadedAddendum !== undefined ? Promise.resolve(preloadedAddendum) : loadPrompt("janus-whatsapp-addendum", ""),
    userId ? loadMemories(userId) : Promise.resolve([]),
    userId ? loadConversationHistory(userId, 15) : Promise.resolve([]),
    fetchTodayCalendar(),
    fetchCurrentWeather(),
    fetchTodayTasks(),
    preloadedHouseholdDirectory !== undefined ? Promise.resolve(preloadedHouseholdDirectory) : loadHouseholdDirectory(),
    getSkillsIndexBlock(role, "whatsapp"),
  ]);
  // Apply the same {{HOUSEHOLD_DIRECTORY}} substitution the chat handler
  // uses so static placeholder PII never leaks into the LLM call.
  const corePrompt = renderSystemPrompt(corePromptRaw, { householdDirectory });

  const memoryContext = memories.length > 0
    ? `\n\nPermanent memory — facts you know about this user (never forget these):\n${memories.map((m: any) => `- ${m.key}: ${m.value}${m.context ? ` (${m.context})` : ""}`).join("\n")}`
    : "";

  const nowLA = new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/Los_Angeles" });
  const dateHeader = `Current date and time: ${nowLA}\nHousehold timezone: America/Los_Angeles (Pacific Time). ALL times you mention, calculate, or create MUST be in Pacific Time.\nWhen creating calendar events, ALWAYS use timeZone: "America/Los_Angeles".\n\n`;
  const audioInstruction = "\n\nWhen the user sends an audio message, briefly acknowledge what they said before responding. Keep the acknowledgment under 10 words.";
  const briefingParts: string[] = [];
  if (todayCalendar) briefingParts.push(todayCalendar);
  if (currentWeather) briefingParts.push(currentWeather);
  if (todayTasks) briefingParts.push(todayTasks);
  const briefingBlock = briefingParts.length > 0 ? `\n\n── LIVE BRIEFING ──\n${briefingParts.join("\n\n")}\n` : "";
  const scheduleGuardrail = "\n\nCRITICAL REMINDER — ANTI-HALLUCINATION: You MUST NOT volunteer or state any facts about sports game schedules, event dates, game locations, or 'today's events' unless you have called query_entertainment (or another tool) to verify them in THIS conversation. Your training data does not contain current schedules. When in doubt, call the tool first.";
  const systemPrompt = dateHeader + corePrompt + skillsIndexBlock + audioInstruction + scheduleGuardrail + briefingBlock + memoryContext
    + (whatsappAddendum ? "\n\n" + whatsappAddendum : "")
    + (groupContextPrompt || "");

  const roleAddendum = role === "admin"
    ? `\n\nThe current user is the ADMIN (Tony). You have full access to all tools and data. No restrictions. Trust conversation context fully — when the user references something just discussed, act on it immediately using that context. Do not ask clarifying questions when the answer is obvious from recent messages.`
    : role === "outsider"
    ? `\n\nThe current user is an OUTSIDER. You are a PRIVATE household assistant. Do NOT reveal personal information. Keep responses to 1-2 sentences. When in doubt about intent, ask before acting.`
    : role === "member"
    ? `\n\nThe current user is a MEMBER (family). Access restrictions apply. Trust conversation context — when the user references something just discussed, act on it immediately using that context. Do not ask clarifying questions when the answer is clear from recent messages.`
    : `\n\nThe current user is a MEMBER (family). Access restrictions apply. Trust conversation context — when the user references something just discussed, act on it immediately using that context. Do not ask clarifying questions when the answer is clear from recent messages.`;

  const tools = groupTier !== undefined
    ? getToolsForGroupContext(role, groupTier)
    : getToolsForRole(role);
  const allToolCallsForLog: any[] = [];

  const effectiveHistory = conversationHistory.length > 0 ? conversationHistory : conversationHistoryFromParallel;

  const historyWithFallback: any[] = effectiveHistory.length === 0 && userId
    ? [{ role: "system", content: "Note: Conversation history could not be loaded for this session. This user is a known household member — do NOT reset to an intro greeting. Continue the conversation naturally based on their current message." }]
    : effectiveHistory;

  let messages: any[] = [
    { role: "system", content: systemPrompt + roleAddendum },
    ...historyWithFallback,
    {
      role: "user",
      content: voiceAudioBase64
        ? [{ type: "text", text: "Voice message from user:" }, { type: "image_url", image_url: { url: `data:audio/ogg;base64,${voiceAudioBase64}` } }]
        : videoBase64
        ? [{ type: "image_url", image_url: { url: `data:${videoMimeType};base64,${videoBase64}` } }, { type: "text", text: userMessage || "What is in this video?" }]
        : imageBase64
        ? [{ type: "image_url", image_url: { url: `data:${imageMimeType ?? "image/jpeg"};base64,${imageBase64}` } }, { type: "text", text: userMessage || "What does this image contain?" }]
        : userMessage,
    },
  ];

  // Initial complexity classification before the first model call.
  // Reclassified after every tool round with the updated toolCallsSoFar;
  // applyMonotonicUpgrade guarantees we never downgrade mid-turn.
  let currentComplexity: ComplexityDecision = classifyComplexity({
    userMessage,
    history: effectiveHistory,
    toolCallsSoFar: 0,
  });
  console.log(`[complexity-router] WhatsApp turn start → tier=${currentComplexity.tier} (${currentComplexity.reason})`);

  const MAX_ROUNDS = 5;
  let lastToolSignature = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`WhatsApp tool round ${round + 1} (tier=${currentComplexity.tier})`);
    const roundStart = Date.now();
    const modelForRound = pickModel(currentComplexity.tier);
    const response = await fetchT("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelForRound, messages, tools, stream: false }),
    });

    if (!response.ok) {
      const t = await response.text();
      console.error("AI error:", response.status, t);
      if (response.status === 500) {
        const fallbackModels = ["google/gemini-2.5-flash-lite", "openai/gpt-5-mini", "google/gemini-2.5-pro"];
        let fallbackSucceeded = false;
        for (const fallbackModel of fallbackModels) {
          console.log(`Trying fallback: ${fallbackModel}`);
          const retryResp = await fetchT("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: fallbackModel, messages, tools, stream: false }),
          });
          if (retryResp.ok) {
            const retryData = await retryResp.json();
            // Capture usage for the fallback round. The actual model
            // logged is the fallback, not the original.
            const retryUsage = extractUsageFromBody(retryData);
            if (retryUsage) {
              recordLlmUsage(
                {
                  userId,
                  channel: groupTier !== undefined ? "whatsapp-group" : "whatsapp",
                  model: fallbackModel,
                  tier: currentComplexity.tier,
                  durationMs: Date.now() - roundStart,
                  requestType: "tool_round",
                },
                retryUsage,
              ).catch(() => {});
            }
            const retryChoice = retryData.choices?.[0];
            const retryHasToolCalls = retryChoice?.finish_reason === "tool_calls" || retryChoice?.message?.tool_calls?.length > 0;
            if (!retryHasToolCalls) return { reply: retryChoice?.message?.content || "I'm sorry, I couldn't process that.", toolCalls: allToolCallsForLog };
            const retryToolCalls = retryChoice.message.tool_calls;
            messages.push(retryChoice.message);
            const retryResults = await Promise.all(retryToolCalls.map(async (tc: any) => {
              const args = JSON.parse(tc.function.arguments || "{}");
              allToolCallsForLog.push({ name: tc.function.name, arguments: args });
              const result = await executeTool(tc.function.name, args, userId, role);
              return { tool_call_id: tc.id, role: "tool" as const, content: result };
            }));
            messages.push(...retryResults);
            fallbackSucceeded = true;
            break;
          }
          await new Promise(r => setTimeout(r, 500));
        }
        if (fallbackSucceeded) continue;
        throw new Error("All fallback models failed");
      }
      if (response.status === 402) return { reply: "I'm temporarily out of AI credits. Please try again shortly.", toolCalls: allToolCallsForLog };
      throw new Error(`AI error: ${response.status}`);
    }

    const data = await response.json();
    // Capture per-completion usage (best-effort; failures swallowed).
    {
      const usage = extractUsageFromBody(data);
      if (usage) {
        recordLlmUsage(
          {
            userId,
            channel: groupTier !== undefined ? "whatsapp-group" : "whatsapp",
            model: modelForRound,
            tier: currentComplexity.tier,
            durationMs: Date.now() - roundStart,
            requestType: "tool_round",
          },
          usage,
        ).catch(() => {});
      }
    }
    const choice = data.choices?.[0];
    const hasToolCalls = choice?.finish_reason === "tool_calls" || choice?.message?.tool_calls?.length > 0;

    if (!hasToolCalls) {
      const noToolReply = choice?.message?.content || "I'm sorry, I couldn't process that.";
      const firedGuard = detectHallucination(noToolReply, allToolCallsForLog);
      if (firedGuard) {
        console.warn(`HALLUCINATION DETECTED (WhatsApp): ${firedGuard.consoleSummary}`);
        messages.push(
          { role: "assistant", content: noToolReply },
          { role: "user", content: firedGuard.overrideMessage },
        );
        auditHallucinationGuard({
          edgeFunction: "janus-whatsapp",
          channel: groupTier !== undefined ? "whatsapp-group" : "whatsapp",
          guard: firedGuard,
          reply: noToolReply,
          didRemediation: true,
          actorId: userId,
          toolNames: allToolCallsForLog.map((t) => t.name),
        });
        continue;
      }
      return { reply: sanitizeGoogleFileUrls(noToolReply, allToolCallsForLog), toolCalls: allToolCallsForLog };
    }

    const toolCalls = choice.message.tool_calls;
    const thisSignature = toolCalls.map((tc: any) => `${tc.function.name}:${tc.function.arguments}`).join("|");
    if (thisSignature === lastToolSignature) { console.log("Tool loop detected — breaking"); break; }
    lastToolSignature = thisSignature;

    const toolResults = await Promise.all(
      toolCalls.map(async (tc: any) => {
        let args: any;
        try { args = JSON.parse(tc.function.arguments); } catch { return { role: "tool", tool_call_id: tc.id, content: "Error: invalid arguments" }; }
        const result = await executeTool(tc.function.name, args, userId, role);
        console.log(`Tool ${tc.function.name}: ${result.slice(0, 200)}`);
        allToolCallsForLog.push({ name: tc.function.name, args, result: result.slice(0, 500) });
        return { role: "tool", tool_call_id: tc.id, content: result };
      })
    );

    const assistantMsg = { ...choice.message };
    if (!assistantMsg.content) assistantMsg.content = "";
    messages = [...messages, assistantMsg, ...toolResults];

    // Re-classify after this round's tool calls. Monotonic upgrade —
    // simple → default → complex is fine, the reverse never happens.
    const next = classifyComplexity({
      userMessage,
      history: effectiveHistory,
      toolCallsSoFar: allToolCallsForLog.filter((t) => t.name !== "load_skill").length,
    });
    const upgraded = applyMonotonicUpgrade(currentComplexity, next);
    if (upgraded.tier !== currentComplexity.tier) {
      console.log(`[complexity-router] WhatsApp round ${round + 1} upgrade: ${currentComplexity.tier} → ${upgraded.tier} (${upgraded.reason})`);
      currentComplexity = upgraded;
    }
  }

  const finalModels = ["google/gemini-3-flash-preview", "google/gemini-2.5-flash-lite", "openai/gpt-5-mini", "google/gemini-2.5-pro"];
  for (const model of finalModels) {
    const finalStart = Date.now();
    const finalResp = await fetchT("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
    });
    if (finalResp.ok) {
      const finalData = await finalResp.json();
      const finalUsage = extractUsageFromBody(finalData);
      if (finalUsage) {
        recordLlmUsage(
          {
            userId,
            channel: groupTier !== undefined ? "whatsapp-group" : "whatsapp",
            model,
            tier: currentComplexity.tier,
            durationMs: Date.now() - finalStart,
            requestType: "chat",
          },
          finalUsage,
        ).catch(() => {});
      }
      const content = finalData.choices?.[0]?.message?.content;
      return { reply: sanitizeGoogleFileUrls(content || "I ran into an issue. Could you try again?", allToolCallsForLog), toolCalls: allToolCallsForLog };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { reply: "I'm sorry, I'm having trouble responding right now.", toolCalls: allToolCallsForLog };
}

async function logConversation(
  userId: string, displayName: string, userRole: string,
  userMessage: string, assistantResponse: string,
  toolCalls: any[], channel: string, mediaType?: string, groupId?: string, svc?: SupabaseClient
) {
  try {
    const sb = svc || getServiceClient();
    const record: any = {
      user_id: userId,
      user_display_name: displayName || "UNKNOWN",
      user_role: userRole,
      user_message: userMessage.slice(0, 5000),
      assistant_response: assistantResponse.slice(0, 10000),
      tool_calls: toolCalls,
      channel,
    };
    if (mediaType) record.media_type = mediaType;
    if (groupId) record.group_id = groupId;
    await sb.from("janus_chat_logs").insert(record);
  } catch (e) { console.error("Failed to log:", e); }
}

export async function handleWhatsApp(req: Request, res: Response) {
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

  const threadStart = Date.now();
  try {
    const body = req.body;
    const svc = getServiceClient();

    // Prefer the WATI-supplied message id as the correlation id when
    // present — deterministic, dedup-friendly, and makes "trace what
    // this exact inbound WhatsApp triggered" a single equality query.
    // The HTTP correlation middleware already set req.correlationId; we
    // just override it (and the response header) for the duration of
    // this handler. Downstream helpers that read getCurrentCorrelationId
    // continue to see the middleware-bound id — the WATI id is captured
    // in audit/chat-log rows that explicitly pass correlation_id, and
    // surfaced in the response so a caller can correlate across hops.
    const watiMessageId = typeof body?.whatsappMessageId === "string" ? body.whatsappMessageId
      : typeof body?.id === "string" ? body.id : "";
    if (watiMessageId) {
      req.correlationId = `wati:${watiMessageId}`;
      res.setHeader("X-Correlation-Id", req.correlationId);
    }

    // Capture the directory string so we can pass it into askJanusWithTools
    // and apply the {{HOUSEHOLD_DIRECTORY}} substitution before the model
    // sees the system prompt.
    let householdDirectory = "";
    try {
      const householdResult = await loadHouseholdMembers(svc);
      setNotionPeopleLookup(householdResult.notionPeopleLookup);
      householdDirectory = householdResult.directoryTable || "";
    } catch {}

    svc.from("whatsapp_dedup").delete().lt("created_at", new Date(Date.now() - 3600000).toISOString()).then(() => {});

    if (body.action === "send") {
      const result = await sendWhatsApp(body.to, body.message);
      res.json({ result }); return;
    }
    if (body.action === "send_template") {
      const result = await sendTemplateMessage(body.to, body.template_name, body.parameters);
      res.json({ result }); return;
    }

    const incomingText = body.text || body.message || body.caption || "";
    let fromNumber = body.waId || body.from || "";
    const groupId = body.groupId || body.group_id || "";
    const isGroup = !!groupId;
    const messageType = body.type || "text";
    const mediaUrl = body.mediaUrl || body.media_url || body.data || body.audio || "";
    const whatsappMessageId = body.whatsappMessageId || body.id || "";

    const evtType = (body.eventType || "").toString();
    const isOutgoing = body.owner === true || body.isOwner === true
      || evtType.startsWith("sentMessage") || evtType.startsWith("sessionMessage")
      || body.direction === "outbound" || body.fromMe === true
      || body.source === "whatsapp_business_app" || body.synced === true;
    if (isOutgoing) { res.json({ ok: true, skipped: "outbound" }); return; }

    const isStatusOnly = (body.eventType === "status" || body.statusType) && !incomingText && !mediaUrl;
    if (isStatusOnly) { res.json({ ok: true, skipped: "status_event" }); return; }

    if (!incomingText && !mediaUrl) { res.json({ ok: true, skipped: "empty" }); return; }

    const JANUS_REPLY_FINGERPRINTS = ["I'm temporarily out of AI credits", "I'm having a temporary issue processing your message"];
    if (incomingText && JANUS_REPLY_FINGERPRINTS.some((fp: string) => incomingText.includes(fp))) {
      res.json({ ok: true, skipped: "self_reply" }); return;
    }

    const normalizedFrom = fromNumber.replace(/[^\d]/g, "");
    if (normalizedFrom === JANUS_NUMBER) { res.json({ ok: true, skipped: "self" }); return; }

    const cooldownId = isGroup ? `group:${groupId}` : normalizedFrom;
    const channel = isGroup ? "whatsapp-group" : "whatsapp";

    const [onCooldown, identity, corePrompt, whatsappAddendum] = await Promise.all([
      isOnCooldown(cooldownId, channel, svc),
      resolvePhoneToUserId(normalizedFrom, svc),
      loadPrompt("janus-core", JANUS_SYSTEM_PROMPT, svc),
      loadPrompt("janus-whatsapp-addendum", "", svc),
    ]);

    if (onCooldown) { res.json({ ok: true, skipped: "cooldown" }); return; }

    const msgTextForDedup = (incomingText || mediaUrl || "").slice(0, 100);
    const dedupKey = `${cooldownId}:${msgTextForDedup}`;
    if (dedupKey) {
      try {
        const { error: dedupError } = await svc.from("whatsapp_dedup").insert({ message_id: dedupKey });
        if (dedupError) { res.json({ ok: true, skipped: "dedup" }); return; }
      } catch {}
    }

    let messageText = incomingText;
    let voiceAudioBase64: string | null = null;
    let imageBase64: string | null = null;
    let imageMimeType = "image/jpeg";
    let videoBase64: string | null = null;
    let videoMimeType = "video/mp4";

    const isVoiceMessage = (messageType === "audio" || messageType === "voice") && !!mediaUrl;
    if (isVoiceMessage) {
      try {
        const { token: watiToken, tenantRoot } = getWatiConfig();
        let audioBuffer: ArrayBuffer | null = null;

        if (whatsappMessageId) {
          try {
            const v3Url = `${tenantRoot}/api/ext/v3/conversations/messages/file/${whatsappMessageId}`;
            const v3Resp = await fetch(v3Url, { headers: { Authorization: `Bearer ${watiToken}` } });
            if (v3Resp.ok) {
              const buf = await v3Resp.arrayBuffer();
              if (buf.byteLength >= 1000) audioBuffer = buf;
            }
          } catch {}
        }

        if (!audioBuffer && mediaUrl) {
          for (let attempt = 0; attempt < 2 && !audioBuffer; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 2000));
            let audioResp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${watiToken}` } });
            if (!audioResp.ok) audioResp = await fetch(mediaUrl);
            if (audioResp.ok) {
              const ct = audioResp.headers.get("content-type") || "";
              if (ct.includes("application/json")) {
                const json = await audioResp.json();
                const signedUrl = json.url || json.mediaUrl || json.link || "";
                if (signedUrl) { const signedResp = await fetch(signedUrl); if (signedResp.ok) audioBuffer = await signedResp.arrayBuffer(); }
              } else {
                const buf = await audioResp.arrayBuffer();
                if (buf.byteLength >= 1000) audioBuffer = buf;
              }
            }
          }
        }

        if (audioBuffer && audioBuffer.byteLength >= 1000) {
          voiceAudioBase64 = Buffer.from(new Uint8Array(audioBuffer)).toString("base64");
          messageText = "[Voice message attached]";
        } else {
          messageText = "[Voice message — download failed]";
        }
      } catch (e) {
        console.error("Voice processing error:", e);
        messageText = "[Voice message — error processing audio]";
      }
    }

    const isImageMessage = (messageType === "image" || messageType === "sticker") && !!mediaUrl;
    if (isImageMessage) {
      try {
        const { token: watiToken, tenantRoot: imgTenantRoot } = getWatiConfig();
        let imgBuffer: ArrayBuffer | null = null;
        let imgCt = "";

        if (whatsappMessageId) {
          try {
            const v3Url = `${imgTenantRoot}/api/ext/v3/conversations/messages/file/${whatsappMessageId}`;
            const v3Resp = await fetch(v3Url, { headers: { Authorization: `Bearer ${watiToken}` } });
            if (v3Resp.ok) { const buf = await v3Resp.arrayBuffer(); if (buf.byteLength >= 1000) { imgBuffer = buf; imgCt = v3Resp.headers.get("content-type") || ""; } }
          } catch {}
        }

        if (!imgBuffer && mediaUrl) {
          let imgResp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${watiToken}` } });
          if (!imgResp.ok) imgResp = await fetch(mediaUrl);
          if (imgResp.ok) {
            const ct = imgResp.headers.get("content-type") || "";
            if (ct.includes("application/json")) {
              const json = await imgResp.json();
              const signedUrl = json.url || json.mediaUrl || json.link || "";
              if (signedUrl) { const signedResp = await fetch(signedUrl); if (signedResp.ok) { imgBuffer = await signedResp.arrayBuffer(); imgCt = signedResp.headers.get("content-type") || ""; } }
            } else { imgBuffer = await imgResp.arrayBuffer(); imgCt = ct; }
          } else { messageText = messageText || "[Image — download failed]"; }
        }

        if (imgBuffer) {
          imageBase64 = Buffer.from(new Uint8Array(imgBuffer)).toString("base64");
          if (imgCt.includes("png") || mediaUrl.toLowerCase().includes(".png")) imageMimeType = "image/png";
          else if (imgCt.includes("webp") || mediaUrl.toLowerCase().includes(".webp")) imageMimeType = "image/webp";
          else if (imgCt.includes("gif")) imageMimeType = "image/gif";
          const imgDescription = await extractImageDescription(imageBase64, imageMimeType);
          if (imgDescription) {
            messageText = messageText
              ? `${messageText} [Image: ${imgDescription}]`
              : `[Image: ${imgDescription}]`;
          } else if (!messageText) {
            messageText = "[Image]";
          }
        }
      } catch (e) {
        console.error("Image processing error:", e);
        messageText = messageText || "[Image — error processing]";
      }
    }

    const isVideoMessage = messageType === "video" && !!mediaUrl;
    if (isVideoMessage) {
      try {
        const { token: watiToken, tenantRoot: vidTenantRoot } = getWatiConfig();
        let vidBuffer: ArrayBuffer | null = null;
        let vidCt = "";

        if (whatsappMessageId) {
          try {
            const v3Url = `${vidTenantRoot}/api/ext/v3/conversations/messages/file/${whatsappMessageId}`;
            const v3Resp = await fetch(v3Url, { headers: { Authorization: `Bearer ${watiToken}` } });
            if (v3Resp.ok) { const buf = await v3Resp.arrayBuffer(); if (buf.byteLength >= 1000) { vidBuffer = buf; vidCt = v3Resp.headers.get("content-type") || ""; } }
          } catch {}
        }

        if (!vidBuffer && mediaUrl) {
          let vidResp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${watiToken}` } });
          if (!vidResp.ok) vidResp = await fetch(mediaUrl);
          if (vidResp.ok) {
            const ct = vidResp.headers.get("content-type") || "";
            if (ct.includes("application/json")) {
              const json = await vidResp.json();
              const signedUrl = json.url || json.mediaUrl || json.link || "";
              if (signedUrl) { const signedResp = await fetch(signedUrl); if (signedResp.ok) { vidBuffer = await signedResp.arrayBuffer(); vidCt = signedResp.headers.get("content-type") || ""; } }
            } else { vidBuffer = await vidResp.arrayBuffer(); vidCt = ct; }
          } else { messageText = messageText || "[Video — download failed]"; }
        }

        if (vidBuffer) {
          const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
          if (vidBuffer.byteLength > MAX_VIDEO_BYTES) {
            messageText = messageText || "I received a video but it's too large for me to analyze (over 15MB).";
          } else {
            videoBase64 = Buffer.from(new Uint8Array(vidBuffer)).toString("base64");
            if (vidCt.includes("3gpp") || mediaUrl.toLowerCase().includes(".3gp")) videoMimeType = "video/3gpp";
            else if (vidCt.includes("webm") || mediaUrl.toLowerCase().includes(".webm")) videoMimeType = "video/webm";
            else if (vidCt.includes("quicktime") || mediaUrl.toLowerCase().includes(".mov")) videoMimeType = "video/quicktime";
            if (!messageText) messageText = "[Video]";
          }
        }
      } catch (e) {
        console.error("Video processing error:", e);
        messageText = messageText || "[Video — error processing]";
      }
    }

    const isDocumentMessage = messageType === "document" && !!mediaUrl;
    let documentText: string | null = null;
    if (isDocumentMessage) {
      try {
        const { token: watiToken, tenantRoot: docTenantRoot } = getWatiConfig();
        let docBuffer: ArrayBuffer | null = null;

        if (whatsappMessageId) {
          try {
            const v3Url = `${docTenantRoot}/api/ext/v3/conversations/messages/file/${whatsappMessageId}`;
            const v3Resp = await fetch(v3Url, { headers: { Authorization: `Bearer ${watiToken}` } });
            if (v3Resp.ok) { const buf = await v3Resp.arrayBuffer(); if (buf.byteLength >= 100) docBuffer = buf; }
          } catch {}
        }

        if (!docBuffer && mediaUrl) {
          let docResp = await fetch(mediaUrl, { headers: { Authorization: `Bearer ${watiToken}` } });
          if (!docResp.ok) docResp = await fetch(mediaUrl);
          if (docResp.ok) {
            const ct = docResp.headers.get("content-type") || "";
            if (ct.includes("application/json")) {
              const json = await docResp.json();
              const signedUrl = json.url || json.mediaUrl || json.link || "";
              if (signedUrl) { const signedResp = await fetch(signedUrl); if (signedResp.ok) docBuffer = await signedResp.arrayBuffer(); }
            } else { docBuffer = await docResp.arrayBuffer(); }
          }
        }

        if (docBuffer) {
          const fileName = (body.fileName || body.filename || mediaUrl || "").toLowerCase();
          const isPdf = fileName.endsWith(".pdf") || (new Uint8Array(docBuffer).slice(0, 5).toString() === "37,80,68,70,45");
          if (isPdf) {
            try {
              const parser = new PDFParse({ data: Buffer.from(new Uint8Array(docBuffer)) });
              const pdfData = await parser.getText();
              documentText = pdfData.text?.trim() || null;
              if (documentText && documentText.length > 15000) documentText = documentText.slice(0, 15000) + "\n\n[Document truncated — showing first 15,000 characters]";
              const info = await parser.getInfo().catch(() => ({ pages: 0 }));
              console.log(`[WhatsApp] PDF extracted: ${documentText?.length || 0} chars, ${(info as any).pages || '?'} pages`);
            } catch (pdfErr) {
              console.error("[WhatsApp] PDF parse error:", pdfErr);
              documentText = "[PDF document attached but could not be read — the file may be image-based or encrypted]";
            }
          } else {
            try {
              const textContent = Buffer.from(new Uint8Array(docBuffer)).toString("utf-8");
              if (textContent && textContent.length > 0 && !/[\x00-\x08\x0E-\x1F]/.test(textContent.slice(0, 200))) {
                documentText = textContent.trim();
                if (documentText.length > 15000) documentText = documentText.slice(0, 15000) + "\n\n[Document truncated]";
              } else {
                documentText = `[Non-PDF document attached: ${fileName || "unknown file"}. Unable to extract text content.]`;
              }
            } catch {
              documentText = `[Document attached: ${fileName || "unknown file"}. Unable to extract text content.]`;
            }
          }
        } else {
          documentText = "[Document attached but download failed]";
        }
      } catch (e) {
        console.error("Document processing error:", e);
        documentText = "[Document attached — error processing file]";
      }

      if (documentText) {
        const docLabel = body.fileName || body.filename || "attached document";
        messageText = (messageText ? messageText + "\n\n" : "") + `── ATTACHED DOCUMENT: ${docLabel} ──\n${documentText}`;
      }
    }

    const hasContent = !!messageText || isVoiceMessage || isImageMessage || isVideoMessage || isDocumentMessage;
    if (!hasContent || !fromNumber) { res.json({ ok: true, skipped: "no content or sender" }); return; }

    const isHouseholdMember = identity.role !== "outsider";

    if (isGroup && !isHouseholdMember) {
      const groupConfig = await getOrCreateGroupConfig(groupId, svc);
      incrementGroupMessageCount(groupId, svc);
      const priorCount = await countOutsiderMessages24h(identity.userId, svc);
      await logConversation(identity.userId, identity.displayName || "UNKNOWN", "outsider", messageText, "(pending)", [], channel, undefined, groupId, svc);
      if (priorCount === 0) { await sendOutsiderFirstContactAlert(normalizedFrom, messageText); }
      let reply = "";
      if (priorCount >= 3) {
        sendAbuseAlert(normalizedFrom, priorCount + 1, messageText);
        reply = "";
      } else if (priorCount < 3) {
        reply = "I'm a private household assistant and can't assist in this group. Feel free to message me directly if you need help! 😊";
      }

      if (reply) {
        await sendWhatsApp(groupId, reply);
        try { const { data: pl } = await svc.from("janus_chat_logs").select("id").eq("user_id", identity.userId).eq("assistant_response", "(pending)").order("created_at", { ascending: false }).limit(1); if (pl?.[0]) await svc.from("janus_chat_logs").update({ assistant_response: reply }).eq("id", pl[0].id); } catch {}
      } else {
        try { const { data: pl } = await svc.from("janus_chat_logs").select("id").eq("user_id", identity.userId).eq("assistant_response", "(pending)").order("created_at", { ascending: false }).limit(1); if (pl?.[0]) await svc.from("janus_chat_logs").update({ assistant_response: "(silenced)" }).eq("id", pl[0].id); } catch {}
      }
      await logJanusChannelDecision({
        channel: "whatsapp-group",
        route: priorCount >= 3 ? "outsider-throttled" : reply ? "outsider-reply" : "outsider-silent",
        identity: { userId: identity.userId, displayName: identity.displayName || "UNKNOWN", role: identity.role, source: "outsider" },
        fromIdentifier: normalizedFrom,
        groupId,
        messagePreview: messageText,
        replyPreview: reply,
        durationMs: Date.now() - threadStart,
      });
      res.json({ ok: true, outsider: true, group: true, silent: !reply }); return;
    }

    if (isGroup) {
      const textLower = messageText.toLowerCase();
      const mentionPatterns = ["janus", "@janus", "hey janus", "hi janus", "ok janus", "okay janus", "janus,", "janus:"];
      if (!mentionPatterns.some((p) => textLower.includes(p))) { res.json({ ok: true, skipped: "group, not mentioned" }); return; }
      messageText = stripMentionFromMessage(messageText);
    }

    let groupConfig: GroupConfig | null = null;
    let groupContextPrompt = "";

    if (isGroup) {
      groupConfig = await getOrCreateGroupConfig(groupId, svc);
      incrementGroupMessageCount(groupId, svc);

      groupContextPrompt = buildGroupContextPrompt(groupConfig, identity.displayName, identity.role, isHouseholdMember);
    } else if (!isHouseholdMember) {
      const priorCount = await countOutsiderMessages24h(identity.userId, svc);
      await logConversation(identity.userId, identity.displayName || "UNKNOWN", "outsider", messageText, "(pending)", [], channel, undefined, undefined, svc);
      if (priorCount === 0) { await sendOutsiderFirstContactAlert(normalizedFrom, messageText); }
      let reply: string;
      if (priorCount >= 3) {
        reply = "I appreciate you reaching out! I'm only able to help with basic messages to the family. 😊";
        sendAbuseAlert(normalizedFrom, priorCount + 1, messageText);
      } else {
        reply = await askJanusOutsider(messageText);
      }
      try { const { data: pl } = await svc.from("janus_chat_logs").select("id").eq("user_id", identity.userId).eq("assistant_response", "(pending)").order("created_at", { ascending: false }).limit(1); if (pl?.[0]) await svc.from("janus_chat_logs").update({ assistant_response: reply }).eq("id", pl[0].id); } catch {}
      await sendWhatsApp(fromNumber, reply);
      await logJanusChannelDecision({
        channel: "whatsapp",
        route: priorCount >= 3 ? "outsider-throttled" : "outsider-reply",
        identity: { userId: identity.userId, displayName: identity.displayName || "UNKNOWN", role: identity.role, source: "outsider" },
        fromIdentifier: normalizedFrom,
        messagePreview: messageText,
        replyPreview: reply,
        durationMs: Date.now() - threadStart,
      });
      res.json({ ok: true, outsider: true }); return;
    }

    const incomingMessageId = body.id || body.msgId || "";
    if (incomingMessageId) {
      try {
        const { serverRoot, token: watiToken } = getWatiConfig();
        await fetch(`${serverRoot}/api/ext/v3/conversations/messages/reaction`, {
          method: "POST",
          headers: { Authorization: `Bearer ${watiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ target: normalizedFrom, messageId: incomingMessageId, emoji: "⏳" }),
        });
      } catch {}
    }

    const mediaTypeForLog = videoBase64 ? "video" : imageBase64 ? "image" : isVoiceMessage ? "audio" : isDocumentMessage ? "document" : undefined;
    await logConversation(identity.userId, identity.displayName, identity.role, messageText, "(pending)", [], channel, mediaTypeForLog, isGroup ? groupId : undefined, svc);

    const groupTier = groupConfig?.tier || "";

    let { reply, toolCalls } = await askJanusWithTools([], messageText, identity.role, identity.userId, imageBase64, imageMimeType, groupContextPrompt, groupTier, corePrompt, whatsappAddendum, voiceAudioBase64, videoBase64, videoMimeType, householdDirectory);

    try {
      const { text: cleanedReply, deadCount, deadUrls } = await validateAndCleanURLs(reply);
      if (deadCount > 0) {
        console.log(`[URLCheck] Cleaned ${deadCount} dead URL(s) from WhatsApp reply: ${deadUrls.join(", ")}`);
        reply = cleanedReply;
      }
    } catch {}

    try {
      const { data: logs } = await svc.from("janus_chat_logs").select("id").eq("user_id", identity.userId).eq("channel", channel).eq("assistant_response", "(pending)").order("created_at", { ascending: false }).limit(1);
      if (logs && logs.length > 0) await svc.from("janus_chat_logs").update({ assistant_response: reply.slice(0, 10000), tool_calls: toolCalls }).eq("id", logs[0].id);
    } catch {}

    const replyTo = isGroup ? groupId : fromNumber;

    if (isVoiceMessage) {
      await sendWhatsApp(replyTo, sanitizeReplyForWhatsApp(reply));
      try {
        const voiceBaseUrl = `http://localhost:${process.env.PORT || 5000}`;
        {
          const synthesizeResp = await fetch(`${voiceBaseUrl}/api/voice/elevenlabs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "synthesize", text: reply, return_base64: true }),
          });
          if (synthesizeResp.ok) {
            const synthJson = await synthesizeResp.json();
            const audio_base64 = synthJson?.audio_base64;
            if (audio_base64) {
              const audioBytes = Buffer.from(audio_base64, "base64");
              const fileName = `${crypto.randomUUID()}.mp3`;
              const { error: uploadError } = await svc.storage.from("voice-replies").upload(fileName, audioBytes, { contentType: "audio/mpeg", upsert: false });
              if (!uploadError) {
                const { data: urlData } = svc.storage.from("voice-replies").getPublicUrl(fileName);
                const publicUrl = urlData?.publicUrl;
                if (publicUrl) {
                  const { serverRoot, token: watiToken } = getWatiConfig();
                  const normalizedReplyTo = replyTo.replace(/[^\d]/g, "");
                  await fetch(`${serverRoot}/api/ext/v3/conversations/messages/fileViaUrl`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${watiToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify({ target: normalizedReplyTo, file_url: publicUrl, caption: "" }),
                  });
                  setTimeout(async () => { try { await svc.storage.from("voice-replies").remove([fileName]); } catch {} }, 30000);
                }
              }
            }
          }
        }
      } catch (e) { console.error("[VoiceReply] TTS PIPELINE FAILED:", e); }
    } else {
      await sendWhatsApp(replyTo, sanitizeReplyForWhatsApp(reply));
    }

    logAudit({ category: "janus", event_type: "whatsapp_response", severity: "info", actor_id: identity.userId, actor_name: identity.displayName, actor_role: identity.role, channel: isGroup ? "whatsapp-group" : "whatsapp", summary: `WhatsApp: "${messageText.slice(0, 80)}"`, detail: { tools: toolCalls?.map((t: any) => t.name), reply_length: reply.length, group: isGroup ? groupId : undefined }, status: "success" });
    await logJanusChannelDecision({
      channel: isGroup ? "whatsapp-group" : "whatsapp",
      route: identity.role === "admin" ? "admin-reply" : "member-reply",
      identity: { userId: identity.userId, displayName: identity.displayName, role: identity.role, source: "email" },
      fromIdentifier: normalizedFrom,
      groupId: isGroup ? groupId : undefined,
      messagePreview: messageText,
      replyPreview: reply,
      toolNames: toolCalls?.map((t: { name: string }) => t.name),
      durationMs: Date.now() - threadStart,
    });
    res.json({ ok: true, group: isGroup });
  } catch (e) {
    console.error("janus-whatsapp error:", e);
    try {
      const errFrom = (req.body?.waId || req.body?.from || "").replace(/[^\d]/g, "");
      const errGroup = req.body?.groupId || req.body?.group_id || "";
      await logJanusChannelDecision({
        channel: errGroup ? "whatsapp-group" : "whatsapp",
        route: "error",
        identity: { userId: errFrom || "unknown", displayName: errFrom || "unknown", role: "outsider", source: "outsider" },
        fromIdentifier: errFrom,
        groupId: errGroup || undefined,
        durationMs: Date.now() - threadStart,
        status: "error",
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    } catch {}
    try {
      const errorFromNumber = req.body?.waId || req.body?.from || "";
      const errorGroupId = req.body?.groupId || req.body?.group_id || "";
      const errorReplyTo = errorGroupId || errorFromNumber;
      if (errorReplyTo) {
        const shouldSkipError = await isOnCooldown(errorReplyTo.replace(/[^\d]/g, ""), errorGroupId ? "whatsapp-group" : "whatsapp");
        if (!shouldSkipError) await sendWhatsApp(errorReplyTo, "I'm having a temporary issue processing your message. Please try again in a moment. 🙏");
      }
    } catch {}
    try {
      const sb = getServiceClient();
      const errorFrom = req.body?.waId || req.body?.from || "";
      if (errorFrom) {
        const { data: pl } = await sb.from("janus_chat_logs").select("id").eq("assistant_response", "(pending)").order("created_at", { ascending: false }).limit(1);
        if (pl?.[0]) await sb.from("janus_chat_logs").update({ assistant_response: `[Error] ${e instanceof Error ? e.message : "Unknown"}` }).eq("id", pl[0].id);
      }
    } catch {}
    res.json({ error: e instanceof Error ? e.message : "Unknown error" });
  }
}
