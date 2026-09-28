import type { Request, Response } from "express";
import { createClient, getServiceClient, type SupabaseClient } from "../utils/supabase.js";
import { getGoogleServiceToken } from "../utils/google-jwt.js";
import { fetchT } from "../utils/fetch-timeout.js";
import { breakers } from "../lib/breakers.js";
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
import { decodeMimeHeader, encodeMimeHeader } from "../lib/mimeHeaders.js";
import { classifyForwardedEmail } from "../lib/forwardedEmailGuard.js";
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
  validateAndCleanURLs,
  sanitizeGoogleFileUrls,
  enqueueFailedJob,
  sendAutomationFailureAlert,
} from "../utils/janus-tools.js";

import {
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
} from "../utils/tools/calendar-maps.js";

import {
  executeCreateGoogleFile,
  executeAttachFileToNotion,
} from "../utils/tools/google-workspace.js";

import {
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
import { resolveEmailIdentity, type ResolvedIdentity } from "../lib/identityResolver.js";
import { logJanusEmailDecision, type EmailRoute } from "../lib/janusEmailAudit.js";

import fs from "fs";
import path from "path";

const logAudit = (entry: Record<string, unknown>) => sharedLogAudit("janus-email-poll", entry);
const executeSendEmail = (to: string, subject: string, body: string) => sharedSendEmail(to, subject, body, "email", "janus-email-poll");

let JANUS_EMAIL_SYSTEM_PROMPT: string;
try {
  JANUS_EMAIL_SYSTEM_PROMPT = fs.readFileSync(path.resolve(process.cwd(), "supabase/functions/_shared/SOUL.md"), "utf8");
} catch {
  JANUS_EMAIL_SYSTEM_PROMPT = "You are Janus, the AI assistant for Janus.";
}

const JANUS_EMAIL = "assistant@example.com";
const TONY_EMAIL = "admin@example.com";

// Fallback for Tony when the household_members table is empty/unreachable.
// All other users now resolve via resolveEmailIdentity() against household_members.
const TONY_FALLBACK: ResolvedIdentity = {
  userId: "77d99e2b-d9b6-4c2a-a170-6a6da473c1d2",
  displayName: "Tony",
  role: "admin",
  source: "outsider", // marker that fallback was used
};

let _cachedTonyIdentity: ResolvedIdentity | null = null;
async function getTonyIdentity(): Promise<ResolvedIdentity> {
  if (_cachedTonyIdentity) return _cachedTonyIdentity;
  try {
    const id = await resolveEmailIdentity(TONY_EMAIL);
    if (id.role === "admin") { _cachedTonyIdentity = id; return id; }
  } catch (e) {
    console.error("[email-poll] getTonyIdentity failed, using fallback:", e);
  }
  return TONY_FALLBACK;
}

let _currentCallerEmail = "";
let _currentEmailAttachments: EmailAttachment[] = [];
let _currentTriageToken = "";
let _currentTriageMessageId = "";

interface EmailAttachment {
  base64: string;
  mimeType: string;
  filename: string;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

async function getAccessToken(saKey: ServiceAccountKey, impersonate?: string): Promise<string> {
  const scopes = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
  ];
  return getGoogleServiceToken(scopes, impersonate || JANUS_EMAIL);
}

// All Gmail API calls in this module flow through the breaker. 4xx
// (auth / not-found) errors pass through without tripping; 5xx and
// network errors count toward the failure threshold and open the
// circuit so the cron-driven poll loop returns fast instead of
// hammering Gmail when it's down.
function gmailFetchT(input: RequestInfo | URL, init?: RequestInit, timeoutMs?: number): Promise<globalThis.Response> {
  return breakers.gmail.execute(() => fetchT(input, init, timeoutMs));
}

async function listUnreadMessages(token: string): Promise<any[]> {
  const res = await gmailFetchT(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+in:inbox&maxResults=5`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail list failed: ${res.status}`);
  const data = await res.json();
  return data.messages || [];
}

async function getMessage(token: string, messageId: string): Promise<any> {
  const res = await gmailFetchT(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  return res.json();
}

function extractHeader(message: any, name: string): string {
  const headers = message?.payload?.headers || [];
  const h = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
  // Decode RFC 2047 encoded-words (=?UTF-8?Q?...?= / =?UTF-8?B?...?=) so we
  // never feed mojibake into routing, logging, or reply-subject construction.
  return decodeMimeHeader(h?.value || "");
}

function extractEmailBody(message: any): string {
  const payload = message?.payload;
  if (!payload) return "";

  function findTextPart(part: any): string {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf8");
    }
    if (part.parts) {
      for (const p of part.parts) {
        const result = findTextPart(p);
        if (result) return result;
      }
    }
    if (part.mimeType === "text/html" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  return findTextPart(payload).slice(0, 10000);
}

function extractImageAttachments(message: any): { attachmentId: string; mimeType: string; filename: string }[] {
  const refs: { attachmentId: string; mimeType: string; filename: string }[] = [];
  function walk(part: any) {
    if (part.body?.attachmentId && part.mimeType?.startsWith("image/")) {
      refs.push({ attachmentId: part.body.attachmentId, mimeType: part.mimeType, filename: part.filename || "image" });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(message.payload);
  return refs;
}

function extractPdfAttachments(message: any): { attachmentId: string; mimeType: string; filename: string }[] {
  const refs: { attachmentId: string; mimeType: string; filename: string }[] = [];
  function walk(part: any) {
    if (part.body?.attachmentId && part.mimeType === "application/pdf") {
      refs.push({ attachmentId: part.body.attachmentId, mimeType: part.mimeType, filename: part.filename || "document.pdf" });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(message.payload);
  return refs;
}

function extractAudioAttachments(message: any): { attachmentId: string; mimeType: string; filename: string }[] {
  const refs: { attachmentId: string; mimeType: string; filename: string }[] = [];
  function walk(part: any) {
    if (part.body?.attachmentId && part.mimeType?.startsWith("audio/")) {
      refs.push({ attachmentId: part.body.attachmentId, mimeType: part.mimeType, filename: part.filename || "audio" });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(message.payload);
  return refs;
}

function extractVideoAttachments(message: any): { attachmentId: string; mimeType: string; filename: string }[] {
  const refs: { attachmentId: string; mimeType: string; filename: string }[] = [];
  function walk(part: any) {
    if (part.body?.attachmentId && part.mimeType?.startsWith("video/")) {
      refs.push({ attachmentId: part.body.attachmentId, mimeType: part.mimeType, filename: part.filename || "video" });
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(message.payload);
  return refs;
}

async function fetchAttachment(token: string, messageId: string, attachmentId: string): Promise<string> {
  const res = await gmailFetchT(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Attachment fetch failed: ${res.status}`);
  const data = await res.json();
  return (data.data || "").replace(/-/g, "+").replace(/_/g, "/");
}

async function markAsRead(token: string, messageId: string): Promise<void> {
  await gmailFetchT(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    },
  );
}

async function sendReply(token: string, to: string, subject: string, body: string, threadId?: string, inReplyTo?: string, cc?: string): Promise<void> {
  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  // Any non-ASCII in the subject (emoji, accents, decoded NBSPs, em-dashes,
  // etc.) must be wrapped per RFC 2047 before going on the wire — otherwise
  // raw UTF-8 bytes leak into the header and the receiving MTA renders the
  // classic mojibake (e.g. "Ã,Â Ã,Â").
  const encodedSubject = encodeMimeHeader(replySubject);
  const headers = [
    `From: Janus <${JANUS_EMAIL}>`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodedSubject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    "Content-Type: text/html; charset=UTF-8",
    "",
    body.includes("<") ? body : `<div style="font-family:Arial,sans-serif;white-space:pre-wrap">${body}</div>`,
  ];
  const raw = Buffer.from(headers.join("\r\n")).toString("base64url");
  const endpoint = threadId
    ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`
    : `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`;
  await gmailFetchT(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
  });
}

async function resolveEmailToUserId(email: string): Promise<ResolvedIdentity> {
  const id = await resolveEmailIdentity(email);
  if (id.role !== "outsider") {
    console.log(`[email-poll] resolved ${email} → ${id.displayName} (${id.role}) via ${id.source}`);
  }
  return id;
}

function isEmailOutsider(userId: string): boolean {
  return !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(userId);
}

async function getThreadMessages(token: string, threadId: string): Promise<any[]> {
  try {
    const res = await gmailFetchT(
      `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.messages || [];
  } catch { return []; }
}

function isJanusInitiatedThread(threadMessages: any[]): boolean {
  if (!threadMessages.length) return false;
  const firstMsg = threadMessages[0];
  const from = extractHeader(firstMsg, "From").toLowerCase();
  return from.includes(JANUS_EMAIL.toLowerCase());
}

function buildThreadContext(threadMessages: any[], currentBody: string): string {
  if (threadMessages.length <= 1) return "";
  const prior = threadMessages.slice(0, -1).slice(-3);
  const parts = prior.map((msg: any) => {
    const from = extractHeader(msg, "From").replace(/<[^>]+>/, "").trim();
    const body = extractEmailBody(msg).slice(0, 500);
    return `[${from}]: ${body}`;
  });
  return parts.length ? `── THREAD CONTEXT ──\n${parts.join("\n\n")}\n── END THREAD CONTEXT ──\n\n` : "";
}

// Hallucination detection lives in server/utils/hallucination-guards.ts.
// See call site in askJanusForReply below.

async function countOutsiderEmails24h(email: string): Promise<number> {
  try {
    const sb = getServiceClient();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await sb
      .from("janus_chat_logs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", email.toLowerCase())
      .eq("channel", "email")
      .gte("created_at", cutoff);
    return count ?? 0;
  } catch { return 0; }
}

const OUTSIDER_EMAIL_SYSTEM_PROMPT = `You are Janus, a private household assistant. You received an email from someone outside the household.
You can ONLY help relay basic messages to the family. Do NOT reveal names, schedules, addresses, or any personal information.
Keep replies to 1-2 sentences max. Be warm but firm.`;

async function askJanusEmailOutsider(fromEmail: string, fromName: string, subject: string, body: string): Promise<string> {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) return "Hi! I'm a private household assistant. I can relay a message to the family if needed.";
  try {
    const response = await fetchT("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          { role: "system", content: OUTSIDER_EMAIL_SYSTEM_PROMPT },
          { role: "user", content: `Email from: ${fromName} <${fromEmail}>\nSubject: ${subject}\n\n${body.slice(0, 1000)}` },
        ],
        stream: false,
      }),
    });
    if (!response.ok) return "Hi! I'm a private household assistant. I can relay a message to the family if needed.";
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Hi! I'm a private household assistant. I can relay a message to the family if needed.";
  } catch { return "Hi! I'm a private household assistant. I can relay a message to the family if needed."; }
}

export const ALL_TOOLS = [
  { type: "function", function: { name: "send_email", description: "Send an email from assistant@example.com. ADMIN ONLY.", parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"], additionalProperties: false } } },
  { type: "function", function: { name: "gmail_search", description: "Search Gmail inbox. ADMIN ONLY.", parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "send_whatsapp", description: "Send a WhatsApp message.", parameters: { type: "object", properties: { to: { type: "string" }, message: { type: "string" } }, required: ["to", "message"], additionalProperties: false } } },
  { type: "function", function: { name: "query_notion_database", description: "Query a Notion database.", parameters: { type: "object", properties: { database_id: { type: "string" }, filter: { type: "object" } }, required: ["database_id"], additionalProperties: false } } },
  { type: "function", function: { name: "update_notion_page", description: "Update a Notion page.", parameters: { type: "object", properties: { page_id: { type: "string" }, properties: { type: "object" } }, required: ["page_id", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "create_notion_page", description: "Create a new page in a Notion database. Pass simple key-value properties — the system auto-fetches the database schema and converts values to the correct Notion format. Use get_notion_database first if you need to discover property names. Example: {\"Name\": \"My Project\", \"Status\": \"In Progress\", \"Due Date\": \"2025-04-01\"}.", parameters: { type: "object", properties: { database_id: { type: "string" }, properties: { type: "object" } }, required: ["database_id", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "get_notion_database", description: "Get a Notion database schema.", parameters: { type: "object", properties: { database_id: { type: "string" } }, required: ["database_id"], additionalProperties: false } } },
  { type: "function", function: { name: "batch_update_notion_pages", description: "Batch update multiple Notion pages. ADMIN ONLY.", parameters: { type: "object", properties: { page_ids: { type: "array", items: { type: "string" } }, properties: { type: "object" } }, required: ["page_ids", "properties"], additionalProperties: false } } },
  { type: "function", function: { name: "perplexity_search", description: "Search the web using Perplexity AI for synthesized, cited answers. PREFERRED over web_search for factual questions, research, comparisons.", parameters: { type: "object", properties: { query: { type: "string" }, deep: { type: "boolean" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "home_troubleshoot", description: "Get troubleshooting advice for home system issues (HVAC, plumbing, electrical, pool, security, appliances).", parameters: { type: "object", properties: { system: { type: "string" }, issue: { type: "string" } }, required: ["system", "issue"], additionalProperties: false } } },
  { type: "function", function: { name: "web_search", description: "Search the web for links, products, URLs. For factual questions, prefer perplexity_search.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "save_to_cart", description: "Save a product to the shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" }, product_name: { type: "string" }, product_url: { type: "string" }, price: { type: "string" }, quantity: { type: "number" }, notes: { type: "string" } }, required: ["platform", "product_name"], additionalProperties: false } } },
  { type: "function", function: { name: "view_cart", description: "View shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "clear_cart", description: "Clear shopping cart.", parameters: { type: "object", properties: { platform: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_system_health", description: "Check system health. ADMIN ONLY.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "query_system_updates", description: "Get recent system updates.", parameters: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "scrape_website", description: "Scrape a webpage.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } } },
  { type: "function", function: { name: "browse_website", description: "Browse a website interactively.", parameters: { type: "object", properties: { url: { type: "string" }, instruction: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { action: { type: "string" }, value: { type: "string" } }, required: ["action", "value"] } } }, required: ["url", "instruction"], additionalProperties: false } } },
  { type: "function", function: { name: "remember_fact", description: "Save a permanent fact about the user. Set pinned=true for durable, high-importance facts that must survive the 200-row FIFO eviction cap.", parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" }, context: { type: "string" }, pinned: { type: "boolean", description: "Pin this fact so it survives FIFO eviction. Use for durable, high-importance facts: allergies, alarm/lock codes, medication schedules, emergency contacts." } }, required: ["key", "value"], additionalProperties: false } } },
  { type: "function", function: { name: "recall_facts", description: "Search permanent memory for facts about the user. Matches by key prefix first; falls back to semantic similarity if no exact match.", parameters: { type: "object", properties: { key_search: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "get_calendar_events", description: "Get calendar events.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, time_min: { type: "string" }, time_max: { type: "string" }, max_results: { type: "number" } }, required: ["time_min", "time_max"], additionalProperties: false } } },
  { type: "function", function: { name: "create_calendar_event", description: "Create a calendar event.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, attendees: { type: "array", items: { type: "string" } } }, required: ["title", "start", "end"], additionalProperties: false } } },
  { type: "function", function: { name: "delete_calendar_event", description: "Delete a calendar event. ADMIN ONLY.", parameters: { type: "object", properties: { calendar_id: { type: "string" }, event_id: { type: "string" } }, required: ["event_id"], additionalProperties: false } } },
  { type: "function", function: { name: "check_availability", description: "Check calendar availability.", parameters: { type: "object", properties: { emails: { type: "array", items: { type: "string" } }, time_min: { type: "string" }, time_max: { type: "string" } }, required: ["emails", "time_min", "time_max"], additionalProperties: false } } },
  { type: "function", function: { name: "get_directions", description: "Get driving directions.", parameters: { type: "object", properties: { destination: { type: "string" }, origin: { type: "string" }, mode: { type: "string" } }, required: ["destination"], additionalProperties: false } } },
  { type: "function", function: { name: "search_places", description: "Search for places.", parameters: { type: "object", properties: { query: { type: "string" }, near: { type: "string" }, type: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "get_environment_data", description: "Get weather/air quality.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "search_news", description: "Search news.", parameters: { type: "object", properties: { query: { type: "string" }, period: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_states", description: "Get Home Assistant states.", parameters: { type: "object", properties: { domain: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_state", description: "Get specific HA entity state.", parameters: { type: "object", properties: { entity_id: { type: "string" } }, required: ["entity_id"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_call_service", description: "Control HA device.", parameters: { type: "object", properties: { domain: { type: "string" }, service: { type: "string" }, service_data: { type: "object" } }, required: ["domain", "service"], additionalProperties: false } } },
  { type: "function", function: { name: "ha_get_logbook", description: "Get HA activity log.", parameters: { type: "object", properties: { hours: { type: "number" }, entity_id: { type: "string" } }, additionalProperties: false } } },
  { type: "function", function: { name: "set_reminder", description: "Set a reminder.", parameters: { type: "object", properties: { due_at: { type: "string" }, message: { type: "string" }, channel: { type: "string" }, whatsapp_number: { type: "string" } }, required: ["due_at", "message", "channel"], additionalProperties: false } } },
  { type: "function", function: { name: "launch_research", description: "Launch deep research.", parameters: { type: "object", properties: { topic: { type: "string" }, instructions: { type: "string" }, email_to: { type: "string" } }, required: ["topic", "email_to"], additionalProperties: false } } },
  { type: "function", function: { name: "generate_media", description: "Generate image/video.", parameters: { type: "object", properties: { prompt: { type: "string" }, type: { type: "string", enum: ["image", "video"] }, platform: { type: "string", enum: ["gemini", "fal"] }, email_to: { type: "string" }, whatsapp_number: { type: "string" } }, required: ["prompt", "type", "email_to"], additionalProperties: false } } },
  { type: "function", function: { name: "manage_trip", description: "Manage trip cards.", parameters: { type: "object", properties: { action: { type: "string" }, trip_id: { type: "string" }, trip_name: { type: "string" }, destination: { type: "string" }, departure_date: { type: "string" }, return_date: { type: "string" }, status: { type: "string" }, travelers: { type: "array", items: { type: "string" } }, flights: { type: "array", items: { type: "object" } }, hotels: { type: "array", items: { type: "object" } }, notes: { type: "string" } }, required: ["action", "trip_name"], additionalProperties: false } } },
  { type: "function", function: { name: "query_trips", description: "Query trips.", parameters: { type: "object", properties: { status: { type: "string" }, upcoming_only: { type: "boolean" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_entertainment", description: "Query entertainment events.", parameters: { type: "object", properties: { category: { type: "string" }, upcoming_only: { type: "boolean" } }, additionalProperties: false } } },
  { type: "function", function: { name: "query_media", description: "Query movies/shows.", parameters: { type: "object", properties: { category: { type: "string" }, limit: { type: "number" } }, additionalProperties: false } } },
  { type: "function", function: { name: "suggest_movie", description: "Get movie recommendations.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } },
  { type: "function", function: { name: "attach_file_to_notion", description: "Attach file to Notion page.", parameters: { type: "object", properties: { page_id: { type: "string" }, base64_data: { type: "string" }, filename: { type: "string" }, mime_type: { type: "string" } }, required: ["page_id", "base64_data", "filename", "mime_type"], additionalProperties: false } } },
  { type: "function", function: { name: "create_google_file", description: "Create a Google file.", parameters: { type: "object", properties: { file_type: { type: "string", enum: ["doc", "sheet", "slides", "form"] }, title: { type: "string" }, content: { type: "string" }, share_with: { type: "array", items: { type: "string" } } }, required: ["file_type", "title", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "check_tesla_status", description: "Check Tesla vehicles.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_verkada_security", description: "Check security system.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "check_generator_status", description: "Check generator.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "query_activity_log", description: "Recent activity from Janus's central app-activity log (home, network, ball, security, automations, logins, and more). Pass an optional keyword to filter.", parameters: { type: "object", properties: { event_type: { type: "string", description: "Optional keyword to filter the feed" }, hours: { type: "number" } }, additionalProperties: false } } },
  LOAD_SKILL_TOOL,
  { type: "function", function: { name: "archive_email", description: "Archive the current email in Tony's inbox. Use during triage to archive low-priority emails.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
];

export const ADMIN_ONLY_TOOLS = new Set(["send_email", "gmail_search", "batch_update_notion_pages", "query_system_health", "delete_calendar_event"]);

function getToolsForRole(role: string) {
  if (role === "admin") return ALL_TOOLS;
  return ALL_TOOLS.filter((t) => !ADMIN_ONLY_TOOLS.has(t.function.name));
}

function getRoleAddendum(role: string): string {
  if (role === "admin") return "\n\nThe current user is the ADMIN (Tony). Full access to all tools.";
  return "\n\nThe current user is a MEMBER.";
}

async function executeSendWhatsApp(to: string, message: string): Promise<string> {
  try {
    const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
    const res = await fetchT(`${baseUrl}/api/whatsapp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", to, message }),
    });
    if (!res.ok) return `TOOL_ERROR: WhatsApp send failed: ${res.status}`;
    const data = await res.json();
    return data.result || "WhatsApp sent";
  } catch (e) { return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`; }
}

async function executeArchiveEmail(): Promise<string> {
  if (!_currentTriageToken || !_currentTriageMessageId) return "TOOL_ERROR: No email to archive (not in triage mode)";
  try {
    await gmailFetchT(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${_currentTriageMessageId}/modify`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${_currentTriageToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
      },
    );
    return "✅ Email archived successfully.";
  } catch (e) { return `TOOL_ERROR: ${e instanceof Error ? e.message : "unknown"}`; }
}

async function executeTool(name: string, args: any, userId: string, role?: string): Promise<string> {
  const svc = getServiceClient();
  switch (name) {
    case "send_email": return executeSendEmail(args.to, args.subject, args.body);
    case "gmail_search": return executeGmailSearch(args.query, args.max_results);
    case "send_whatsapp": return executeSendWhatsApp(args.to, args.message);
    case "query_notion_database": return executeQueryNotionDatabase(args.database_id, args.filter);
    case "update_notion_page": return executeUpdateNotionPage(args.page_id, args.properties);
    case "create_notion_page": return executeCreateNotionPage(args.database_id, args.properties);
    case "get_notion_database": return executeGetNotionDatabase(args.database_id);
    case "batch_update_notion_pages": return executeBatchUpdateNotionPages(args.page_ids, args.properties);
    case "perplexity_search": {
      const EP_URL_PATTERN = /https?:\/\/|www\.|\.com\/|\.org\/|\.net\/|find.*(?:website|link|url|site)|(?:link|url|site)\s+(?:to|for)/i;
      if (EP_URL_PATTERN.test(args.query)) return executeWebSearch(args.query, args.limit || 5);
      return executePerplexitySearch(args.query, args.deep);
    }
    case "home_troubleshoot": {
      const { fetchTroubleshootingAdvice } = await import("../services/perplexity.js");
      return fetchTroubleshootingAdvice(args.system, args.issue);
    }
    case "web_search": {
      const EP_KNOWLEDGE_PATTERN = /^(?:what|who|why|how|when|where|explain|compare|describe|summarize|is there|are there|does|do|can|could|should|will|would|tell me|define|list|name)\b/i;
      if (EP_KNOWLEDGE_PATTERN.test(args.query)) return executePerplexitySearch(args.query, false);
      return executeWebSearch(args.query, args.limit);
    }
    case "scrape_website": return executeScrapeWebsite(args.url);
    case "browse_website": return executeBrowseWebsite(args.url, args.instruction, args.steps, { source: "email-poll", userId, url: args.url, instruction: args.instruction });
    case "remember_fact": return sharedRememberFact(svc, userId, args.key, args.value, args.context, args.pinned);
    case "recall_facts": return sharedRecallFacts(svc, userId, args.key_search);
    case "get_calendar_events": return executeGetCalendarEvents(args.calendar_id || _currentCallerEmail || "admin@example.com", args.time_min, args.time_max, args.max_results);
    case "create_calendar_event": return executeCreateCalendarEvent(args.calendar_id || _currentCallerEmail || "admin@example.com", args.title, args.start, args.end, args.description, args.location, args.attendees);
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
    case "set_reminder": return executeSetReminder(args.due_at, args.message, args.channel, args.whatsapp_number, userId, svc);
    case "launch_research": return executeLaunchResearch(args.topic, args.instructions, args.email_to, undefined, userId);
    case "generate_media": {
      const mediaBaseUrl = `http://localhost:${process.env.PORT || 5000}`;
      if (args.type === "video") {
        fetch(`${mediaBaseUrl}/api/media/worker`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "video", prompt: args.prompt, email_to: args.email_to, whatsapp_number: args.whatsapp_number }),
        }).catch(() => {});
        return `🎬 Video generation launched. I'll send it via email when ready.`;
      }
      return `Image generation is handled via the media worker.`;
    }
    case "manage_trip": return executeManageTrip(args, svc);
    case "query_trips": return executeQueryTrips(args, svc);
    case "query_entertainment": return executeQueryEntertainment(args, svc);
    case "query_media": return executeQueryMedia(args, svc);
    case "suggest_movie": return executeSuggestMovie(args.query);
    case "attach_file_to_notion": return executeAttachFileToNotion(args.page_id, args.base64_data, args.filename, args.mime_type);
    case "create_google_file": return executeCreateGoogleFile(args.file_type, args.title, args.content, args.share_with, userId, svc);
    case "check_tesla_status": return executeCheckTeslaStatus(svc);
    case "check_verkada_security": return executeCheckVerkadaSecurity(svc);
    case "check_generator_status": return executeCheckGeneratorStatus();
    case "query_activity_log": return executeQueryActivityLog(args.event_type, args.hours, svc);
    case "save_to_cart": return sharedSaveToCart(svc, userId, args.platform, args.product_name, args.product_url, args.price, args.quantity, args.notes);
    case "view_cart": return sharedViewCart(svc, userId, args.platform);
    case "clear_cart": return sharedClearCart(svc, userId, args.platform);
    case "query_system_health": return executeQuerySystemHealth(svc);
    case "query_system_updates": return executeQuerySystemUpdates(args.limit, svc);
    case "archive_email": return executeArchiveEmail();
    case "load_skill": return executeLoadSkill(args.slug, role || "outsider", "email", userId);
    default: return `Unknown tool: ${name}`;
  }
}

async function askJanusWithTools(
  fromEmail: string, fromName: string, subject: string, userMessage: string,
  role: string, userId: string,
  imageAttachments?: EmailAttachment[], pdfAttachments?: EmailAttachment[],
  audioAttachments?: EmailAttachment[], videoAttachments?: EmailAttachment[],
  threadRecipients?: string
): Promise<{ reply: string; toolCalls: any[] }> {
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not configured");

  const [corePromptRaw, emailAddendum, memories, conversationHistory, householdDirectory, skillsIndexBlock] = await Promise.all([
    loadPrompt("janus-core", JANUS_EMAIL_SYSTEM_PROMPT),
    loadPrompt("janus-email-addendum", ""),
    loadMemories(userId),
    loadConversationHistory(userId, 15),
    loadHouseholdDirectory(),
    getSkillsIndexBlock(role, "email"),
  ]);
  // Apply {{HOUSEHOLD_DIRECTORY}} substitution so static placeholder PII
  // never ships to the LLM on the email channel.
  const corePrompt = renderSystemPrompt(corePromptRaw, { householdDirectory });

  const memoryContext = memories.length > 0
    ? `\n\nPermanent memory:\n${memories.map((m: any) => `- ${m.key}: ${m.value}${m.context ? ` (${m.context})` : ""}`).join("\n")}`
    : "";

  const nowLA = new Date().toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/Los_Angeles" });
  const dateHeader = `Current date and time: ${nowLA}\nHousehold timezone: America/Los_Angeles (Pacific Time).\n\n`;
  const systemPrompt = dateHeader + corePrompt + skillsIndexBlock + memoryContext + (emailAddendum ? "\n\n" + emailAddendum : "") + getRoleAddendum(role);

  const tools = getToolsForRole(role);
  const allToolCallsForLog: any[] = [];

  const recipientContext = threadRecipients ? `\nOther recipients on this thread: ${threadRecipients}` : "";
  const contextMessage = `Email from: ${fromName} <${fromEmail}>\nSubject: ${subject}${recipientContext}\n\n${userMessage}`;

  const hasImages = imageAttachments && imageAttachments.length > 0;
  const hasPdfs = pdfAttachments && pdfAttachments.length > 0;
  const hasAudio = audioAttachments && audioAttachments.length > 0;
  const hasVideo = videoAttachments && videoAttachments.length > 0;

  let userContent: any;
  if (hasImages || hasPdfs || hasAudio || hasVideo) {
    const parts: any[] = [];
    const MAX_IMAGE_BASE64 = 700_000;
    const MAX_TOTAL_BASE64 = 1_400_000;
    let totalBase64Used = 0;
    for (const img of (imageAttachments || [])) {
      if (img.base64.length < 1000) continue;
      if (img.base64.length > MAX_IMAGE_BASE64 || totalBase64Used + img.base64.length > MAX_TOTAL_BASE64) {
        parts.push({ type: "text", text: `[Attached image: ${img.filename} — too large to analyze inline]` });
        continue;
      }
      parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
      totalBase64Used += img.base64.length;
    }
    for (const pdf of (pdfAttachments || [])) parts.push({ type: "image_url", image_url: { url: `data:application/pdf;base64,${pdf.base64}` } });
    for (const audio of (audioAttachments || [])) parts.push({ type: "image_url", image_url: { url: `data:${audio.mimeType};base64,${audio.base64}` } });
    for (const video of (videoAttachments || [])) parts.push({ type: "image_url", image_url: { url: `data:${video.mimeType};base64,${video.base64}` } });
    parts.push({ type: "text", text: contextMessage });
    userContent = parts;
  } else {
    userContent = contextMessage;
  }

  let messages: any[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: userContent },
  ];

  // Initial complexity classification, monotonic upgrade after each tool round.
  let currentComplexity: ComplexityDecision = classifyComplexity({
    userMessage,
    history: conversationHistory,
    toolCallsSoFar: 0,
  });
  console.log(`[complexity-router] Email turn start → tier=${currentComplexity.tier} (${currentComplexity.reason})`);

  const MAX_ROUNDS = 5;
  let lastToolSignature = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    console.log(`Email tool round ${round + 1} (tier=${currentComplexity.tier})`);
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
          const retryResp = await fetchT("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: fallbackModel, messages, tools, stream: false }),
          });
          if (retryResp.ok) {
            const retryData = await retryResp.json();
            const retryUsage = extractUsageFromBody(retryData);
            if (retryUsage) {
              recordLlmUsage(
                {
                  userId,
                  channel: "email",
                  model: fallbackModel,
                  tier: currentComplexity.tier,
                  durationMs: Date.now() - roundStart,
                  requestType: "tool_round",
                },
                retryUsage,
              ).catch(() => {});
            }
            const retryChoice = retryData.choices?.[0];
            if (!(retryChoice?.finish_reason === "tool_calls" || retryChoice?.message?.tool_calls?.length > 0)) {
              return { reply: retryChoice?.message?.content || "I couldn't process this email right now.", toolCalls: allToolCallsForLog };
            }
            messages.push(retryChoice.message);
            const retryResults = await Promise.all(retryChoice.message.tool_calls.map(async (tc: any) => {
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
      throw new Error(`AI error: ${response.status}`);
    }

    const data = await response.json();
    // Per-completion usage capture (best-effort, channel=email).
    {
      const usage = extractUsageFromBody(data);
      if (usage) {
        recordLlmUsage(
          {
            userId,
            channel: "email",
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
      const noToolReply = choice?.message?.content || "I couldn't process this email right now.";
      const firedGuard = detectHallucination(noToolReply, allToolCallsForLog);
      if (firedGuard) {
        console.warn(`HALLUCINATION DETECTED (Email): ${firedGuard.consoleSummary}`);
        messages.push(
          { role: "assistant", content: noToolReply },
          { role: "user", content: firedGuard.overrideMessage },
        );
        auditHallucinationGuard({
          edgeFunction: "janus-email-poll",
          channel: "email",
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
    if (thisSignature === lastToolSignature) break;
    lastToolSignature = thisSignature;

    const toolResults = await Promise.all(
      toolCalls.map(async (tc: any) => {
        let args: any;
        try { args = JSON.parse(tc.function.arguments); } catch { return { role: "tool", tool_call_id: tc.id, content: "Error: invalid arguments" }; }
        const result = await executeTool(tc.function.name, args, userId, role);
        allToolCallsForLog.push({ name: tc.function.name, args, result: result.slice(0, 500) });
        return { role: "tool", tool_call_id: tc.id, content: result };
      })
    );

    const assistantMsg = { ...choice.message };
    if (!assistantMsg.content) assistantMsg.content = "";
    messages = [...messages, assistantMsg, ...toolResults];

    // Re-classify after this round. Monotonic upgrade only.
    const next = classifyComplexity({
      userMessage,
      history: conversationHistory,
      toolCallsSoFar: allToolCallsForLog.filter((t) => t.name !== "load_skill").length,
    });
    const upgraded = applyMonotonicUpgrade(currentComplexity, next);
    if (upgraded.tier !== currentComplexity.tier) {
      console.log(`[complexity-router] Email round ${round + 1} upgrade: ${currentComplexity.tier} → ${upgraded.tier} (${upgraded.reason})`);
      currentComplexity = upgraded;
    }
  }

  const finalModels = ["google/gemini-3-flash-preview", "google/gemini-2.5-flash-lite", "openai/gpt-5-mini", "google/gemini-2.5-pro"];
  for (const model of finalModels) {
    const finalStart = Date.now();
    const finalResp = await fetchT("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false }),
    });
    if (finalResp.ok) {
      const finalData = await finalResp.json();
      const finalUsage = extractUsageFromBody(finalData);
      if (finalUsage) {
        recordLlmUsage(
          {
            userId,
            channel: "email",
            model,
            tier: currentComplexity.tier,
            durationMs: Date.now() - finalStart,
            requestType: "chat",
          },
          finalUsage,
        ).catch(() => {});
      }
      const content = finalData.choices?.[0]?.message?.content;
      return { reply: sanitizeGoogleFileUrls(content || "I ran into an issue processing that.", allToolCallsForLog), toolCalls: allToolCallsForLog };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { reply: "I'm sorry, I'm having trouble responding right now.", toolCalls: allToolCallsForLog };
}

async function logEmail(subject: string, recipients: string[], htmlBody: string, status: string, errorMessage?: string): Promise<void> {
  try {
    const { query } = await import('../lib/db.js');
    await query(
      `INSERT INTO email_logs (email_type, subject, recipients, html_body, text_body, status, error_message) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['janus_email_reply', subject, JSON.stringify(recipients), htmlBody, htmlBody, status, errorMessage || null]
    );
  } catch {}
}

async function logJanusConversation(userId: string, displayName: string, userRole: string, userMessage: string, assistantResponse: string, toolCalls: any[], channel: string, mediaType?: string) {
  try {
    const sb = getServiceClient();
    const record: any = {
      user_id: userId, user_display_name: displayName, user_role: userRole,
      user_message: userMessage.slice(0, 5000), assistant_response: assistantResponse.slice(0, 10000),
      tool_calls: toolCalls, channel,
    };
    if (mediaType) record.media_type = mediaType;
    await sb.from("janus_chat_logs").insert(record);
  } catch {}
}

let _emailPollRunning = false;
const _recentlyProcessedMsgIds = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000;

export async function handleEmailPoll(req: Request, res: Response) {
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const urlPath = req.path || "";
  if (urlPath.endsWith("/ping")) {
    fetch("https://openrouter.ai/api/v1/models", {
      method: "HEAD",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    }).catch(() => {});
    res.json({ ok: true, ts: Date.now() });
    return;
  }

  if (_emailPollRunning) {
    res.json({ skipped: true, reason: "previous poll still running" });
    return;
  }
  _emailPollRunning = true;

  const svc = getServiceClient();

  try {
    const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!saKeyRaw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not configured");
    const saKey: ServiceAccountKey = JSON.parse(saKeyRaw);

    let accessToken: string;
    try {
      accessToken = await getAccessToken(saKey);
    } catch (authErr) {
      const errMsg = authErr instanceof Error ? authErr.message : String(authErr);
      const is401 = errMsg.includes("401") || errMsg.toLowerCase().includes("unauthorized");
      console.error("🚨 JANUS EMAIL AUTH FAILURE:", errMsg);
      if (is401) {
        try {
          const watiEndpoint = process.env.WATI_API_ENDPOINT;
          const watiToken = process.env.WATI_ACCESS_TOKEN;
          if (watiEndpoint && watiToken) {
            const serverRoot = watiEndpoint.replace(/\/$/, "").replace(/\/api\/ext\/v3\/?$/, "").replace(/\/api\/ext\/?$/, "");
            await fetch(`${serverRoot}/api/ext/v3/conversations/messages/text`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${watiToken.replace(/^Bearer\s+/i, "")}` },
              body: JSON.stringify({ target: "13109491469", text: "🚨 *Janus Email Alert*: Gmail auth failed for assistant@example.com (401). Domain-wide delegation may have been revoked." }),
            });
          }
        } catch {}
      }
      throw new Error(`Gmail auth failed: ${errMsg}`);
    }

    const unreadMessages = await listUnreadMessages(accessToken);
    if (unreadMessages.length === 0) { res.json({ processed: 0 }); return; }

    console.log(`Found ${unreadMessages.length} unread email(s) to process.`);
    let processed = 0;

    const now = Date.now();
    for (const [id, ts] of _recentlyProcessedMsgIds) {
      if (now - ts > DEDUP_TTL_MS) _recentlyProcessedMsgIds.delete(id);
    }

    // Filter out already-processed messages and group remaining by threadId
    const unprocessedMessages = unreadMessages.filter(msg => {
      if (_recentlyProcessedMsgIds.has(msg.id)) {
        console.log(`[email-poll] Skipping already-processed message ${msg.id}`);
        markAsRead(accessToken, msg.id).catch(() => {});
        return false;
      }
      return true;
    });

    // Group messages by threadId so multiple messages in the same thread are combined
    const threadGroups = new Map<string, typeof unreadMessages>();
    for (const msg of unprocessedMessages) {
      const threadId = msg.threadId ?? msg.id;
      if (!threadGroups.has(threadId)) threadGroups.set(threadId, []);
      threadGroups.get(threadId)!.push(msg);
    }

    for (const [threadId, threadMsgs] of threadGroups) {
      const allMsgIds = threadMsgs.map(m => m.id);
      let fromEmail = "";
      let fromName = "";
      let subject = "";
      let messageIdHeader = "";
      try {
        // Fetch all messages in the group; keep (id, fullMessage) pairs so sorting
        // by date doesn't break the msgId↔fullMessage relationship needed for attachments.
        const fetched = (await Promise.all(
          threadMsgs.map(async m => {
            const fm = await getMessage(accessToken, m.id);
            return fm ? { id: m.id, fm } : null;
          })
        )).filter(Boolean) as { id: string; fm: any }[];
        if (fetched.length === 0) continue;

        // Sort pairs by internalDate ascending so oldest first
        fetched.sort((a, b) => {
          const da = parseInt(a.fm.internalDate ?? "0", 10);
          const db = parseInt(b.fm.internalDate ?? "0", 10);
          return da - db;
        });

        // Use the latest message (by date) for metadata (From, Subject, Message-ID, To, Cc)
        const latestPair = fetched[fetched.length - 1];
        const latestMsg = latestPair.fm;
        const latestMsgId = latestPair.id;

        const from = extractHeader(latestMsg, "From");
        subject = extractHeader(latestMsg, "Subject");
        messageIdHeader = extractHeader(latestMsg, "Message-ID");

        const emailMatch = from.match(/<([^>]+)>/);
        fromEmail = emailMatch ? emailMatch[1] : from;
        fromName = from.replace(/<[^>]+>/, "").trim() || fromEmail;

        const rawTo = extractHeader(latestMsg, "To");
        const rawCc = extractHeader(latestMsg, "Cc");
        const allAddresses = [rawTo, rawCc].filter(Boolean).join(",").split(",")
          .map((addr: string) => addr.trim())
          .filter((addr: string) => !addr.toLowerCase().includes(JANUS_EMAIL.toLowerCase()) && !addr.toLowerCase().includes(fromEmail.toLowerCase()));
        const unique = [...new Set(allAddresses.map((a: string) => a.toLowerCase()))];
        const ccRecipients = unique.length > 0 ? unique.join(", ") : undefined;

        if (fromEmail.toLowerCase() === JANUS_EMAIL.toLowerCase()) {
          await Promise.all(allMsgIds.map(id => markAsRead(accessToken, id)));
          continue;
        }

        // Mark all messages in this thread group as read and processed
        await Promise.all(allMsgIds.map(id => markAsRead(accessToken, id)));
        const nowTs = Date.now();
        for (const id of allMsgIds) _recentlyProcessedMsgIds.set(id, nowTs);

        if (fetched.length > 1) {
          console.log(`[email-poll] Combining ${fetched.length} messages from thread ${threadId} into single request`);
        }

        // Combine bodies from all messages in chronological order
        const combinedBodyText = fetched.length === 1
          ? extractEmailBody(fetched[0].fm)
          : fetched.map((pair, idx) => {
              const body = extractEmailBody(pair.fm);
              return `[Message ${idx + 1} of ${fetched.length}]\n${body}`;
            }).join("\n\n---\n\n");

        // Collect and merge attachments from all messages; use each pair's own msgId
        // so fetchAttachment uses the correct source message.
        const imgMimes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/tiff"]);
        const pdfMimes = new Set(["application/pdf"]);
        const audioMimes = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/m4a", "audio/aac", "audio/flac", "audio/webm"]);

        const allImageRefs: { attachmentId: string; mimeType: string; filename: string; msgId: string }[] = [];
        const allPdfRefs: { attachmentId: string; mimeType: string; filename: string; msgId: string }[] = [];
        const allAudioRefs: { attachmentId: string; mimeType: string; filename: string; msgId: string }[] = [];
        const allVideoRefs: { attachmentId: string; mimeType: string; filename: string; msgId: string }[] = [];

        for (const { id: srcMsgId, fm } of fetched) {
          for (const ref of extractImageAttachments(fm)) allImageRefs.push({ ...ref, msgId: srcMsgId });
          for (const ref of extractPdfAttachments(fm)) allPdfRefs.push({ ...ref, msgId: srcMsgId });
          for (const ref of extractAudioAttachments(fm)) allAudioRefs.push({ ...ref, msgId: srcMsgId });
          for (const ref of extractVideoAttachments(fm)) allVideoRefs.push({ ...ref, msgId: srcMsgId });
        }

        const downloadAttachment = async (ref: { attachmentId: string; mimeType: string; filename: string; msgId: string }, maxSizeKb?: number): Promise<EmailAttachment | null> => {
          try {
            const base64 = await fetchAttachment(accessToken, ref.msgId, ref.attachmentId);
            if (maxSizeKb) { const sizeKb = base64.length * 0.75 / 1024; if (sizeKb > maxSizeKb) return null; }
            return { base64, mimeType: ref.mimeType, filename: ref.filename };
          } catch { return null; }
        };

        const allDownloads = await Promise.allSettled([
          ...allImageRefs.slice(0, 5).map(ref => downloadAttachment(ref)),
          ...allPdfRefs.slice(0, 3).map(ref => downloadAttachment(ref)),
          ...allAudioRefs.slice(0, 2).map(ref => downloadAttachment(ref, 20480)),
          ...allVideoRefs.slice(0, 1).map(ref => downloadAttachment(ref, 10240)),
        ]);

        const downloadedAll = allDownloads
          .filter((r): r is PromiseFulfilledResult<EmailAttachment | null> => r.status === "fulfilled")
          .map(r => r.value)
          .filter((a): a is EmailAttachment => a !== null);

        const imageAttachments = downloadedAll.filter(a => imgMimes.has(a.mimeType));
        const pdfAttachments = downloadedAll.filter(a => pdfMimes.has(a.mimeType));
        const audioAttachments = downloadedAll.filter(a => audioMimes.has(a.mimeType));
        const videoAttachments = downloadedAll.filter(a => !imgMimes.has(a.mimeType) && !pdfMimes.has(a.mimeType) && !audioMimes.has(a.mimeType));

        const identity = await resolveEmailToUserId(fromEmail);

        const threadStart = Date.now();

        // Forwarded transactional guard: file-and-skip when the inbound looks
        // like a forwarded receipt/confirmation/etc. with no actual ask. This
        // stops Janus from auto-replying "I'm Janus — I run the house at Club
        // 34. What can I help you with?" to vendors on threads that Tony
        // forwarded purely to file. Applies to every role (admin/member/
        // outsider) — if Tony forwards a receipt to himself + Janus, we don't
        // want a reply either. Only suppresses when the sender clearly added
        // no question and the body matches transactional patterns.
        const fwdGuard = classifyForwardedEmail({ subject, body: combinedBodyText });
        if (fwdGuard.isForwardedTransactional) {
          console.log(`[email-poll] Suppressing reply: forwarded transactional from ${fromEmail} "${subject}" — ${fwdGuard.reason}`);
          await logJanusEmailDecision({
            fromEmail, fromName, subject, threadId, threadLength: 1,
            isJanusInitiatedThread: false, identity,
            route: "forwarded-transactional-suppressed",
            replyPreview: fwdGuard.reason, durationMs: Date.now() - threadStart,
          });
          processed++;
          continue;
        }

        if (identity.role === "outsider" && isEmailOutsider(identity.userId)) {
          const threadMessages = await getThreadMessages(accessToken, threadId);
          const janusInitiated = isJanusInitiatedThread(threadMessages);
          const isCoordinationReply = threadMessages.length > 1 && janusInitiated;

          if (isCoordinationReply) {
            const tonyId = await getTonyIdentity();
            const threadContext = buildThreadContext(threadMessages, combinedBodyText);
            _currentCallerEmail = TONY_EMAIL;
            const { reply, toolCalls } = await askJanusWithTools(
              fromEmail, fromName, subject, threadContext + combinedBodyText,
              "admin", tonyId.userId,
            );
            await sendReply(accessToken, fromEmail, subject, reply, threadId, messageIdHeader || latestMsgId, ccRecipients);
            await logJanusConversation(tonyId.userId, `${fromName} (coordination)`, "coordination", `[${subject}] ${combinedBodyText}`, reply, toolCalls, "email");
            await logJanusEmailDecision({
              fromEmail, fromName, subject, threadId, threadLength: threadMessages.length,
              isJanusInitiatedThread: janusInitiated, identity, route: "coordination-reply",
              replyPreview: reply, durationMs: Date.now() - threadStart,
            });
            processed++;
            continue;
          }

          const priorCount = await countOutsiderEmails24h(fromEmail);
          let reply: string;
          let route: EmailRoute = "outsider-reply";
          if (priorCount >= 3) {
            reply = "Hi! I appreciate you reaching out. I'm a private household assistant and can only help relay basic messages to the family.";
            route = "outsider-throttled";
          } else {
            reply = await askJanusEmailOutsider(fromEmail, fromName, subject, combinedBodyText);
          }
          await sendReply(accessToken, fromEmail, subject, reply, threadId, messageIdHeader || latestMsgId, ccRecipients);
          await logJanusConversation(identity.userId, identity.displayName, "outsider", `[${subject}] ${combinedBodyText}`, reply, [], "email");
          await logJanusEmailDecision({
            fromEmail, fromName, subject, threadId, threadLength: threadMessages.length,
            isJanusInitiatedThread: janusInitiated, identity, route,
            replyPreview: reply, durationMs: Date.now() - threadStart,
          });
          processed++;
          continue;
        }

        _currentEmailAttachments = [...imageAttachments, ...pdfAttachments, ...audioAttachments, ...videoAttachments];
        _currentCallerEmail = fromEmail.toLowerCase().trim();

        let enrichedBodyText = combinedBodyText;
        let resolvedThreadLen = 1;
        let resolvedJanusInitiated = false;
        try {
          const threadMessages = await getThreadMessages(accessToken, threadId);
          resolvedThreadLen = threadMessages.length;
          resolvedJanusInitiated = isJanusInitiatedThread(threadMessages);
          if (threadMessages.length > 1) {
            const threadContext = buildThreadContext(threadMessages, combinedBodyText);
            if (threadContext) enrichedBodyText = threadContext + combinedBodyText;
          }
        } catch {}

        const { reply, toolCalls } = await askJanusWithTools(
          fromEmail, fromName, subject, enrichedBodyText,
          identity.role, identity.userId,
          imageAttachments.length > 0 ? imageAttachments : undefined,
          pdfAttachments.length > 0 ? pdfAttachments : undefined,
          audioAttachments.length > 0 ? audioAttachments : undefined,
          videoAttachments.length > 0 ? videoAttachments : undefined,
          ccRecipients || undefined,
        );

        await sendReply(accessToken, fromEmail, subject, reply, threadId, messageIdHeader || latestMsgId, ccRecipients);

        const emailMediaType = videoAttachments.length > 0 ? "video" : audioAttachments.length > 0 ? "audio" : pdfAttachments.length > 0 ? "pdf" : imageAttachments.length > 0 ? "image" : undefined;
        await logJanusConversation(identity.userId, identity.displayName, identity.role, `[${subject}] ${combinedBodyText}`, reply, toolCalls, "email", emailMediaType);
        await logJanusEmailDecision({
          fromEmail, fromName, subject, threadId, threadLength: resolvedThreadLen,
          isJanusInitiatedThread: resolvedJanusInitiated, identity,
          route: identity.role === "admin" ? "admin-reply" : "member-reply",
          replyPreview: reply, durationMs: Date.now() - threadStart,
        });

        const allRecipients = ccRecipients ? [fromEmail, ...ccRecipients.split(", ")] : [fromEmail];
        await logEmail(`Re: ${subject}`, allRecipients, reply, "sent");
        processed++;
      } catch (e) {
        console.error(`Error processing thread ${threadId} (messages: ${allMsgIds.join(", ")}):`, e);
        try {
          const errorReply = `I received your email but encountered a temporary error. Please try again in a few minutes.\n\nError: ${e instanceof Error ? e.message : "Unknown"}`;
          await sendReply(accessToken, fromEmail, subject, errorReply, threadId, messageIdHeader || allMsgIds[allMsgIds.length - 1]);
        } catch {}
        await logEmail(`Error processing email thread ${threadId}`, [fromEmail], e instanceof Error ? e.message : "Unknown", "error", e instanceof Error ? e.message : "Unknown");
        await logJanusEmailDecision({
          fromEmail, fromName, subject, threadId, threadLength: 0,
          isJanusInitiatedThread: false,
          identity: { userId: fromEmail.toLowerCase(), displayName: fromName || fromEmail, role: "unknown", source: "outsider" },
          route: "error", status: "error",
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }

    let tonyTriaged = 0;
    try {
      const tonyToken = await getAccessToken(saKey, TONY_EMAIL);
      const tonyUnread = await listUnreadMessages(tonyToken);
      if (tonyUnread.length > 0) {
        for (const msg of tonyUnread.slice(0, 5)) {
          try {
            const fullMessage = await getMessage(tonyToken, msg.id);
            if (!fullMessage) continue;
            const from = extractHeader(fullMessage, "From");
            const subject = extractHeader(fullMessage, "Subject");
            const bodyText = extractEmailBody(fullMessage);
            const emailMatch = from.match(/<([^>]+)>/);
            const fromEmail = emailMatch ? emailMatch[1] : from;
            const fromName = from.replace(/<[^>]+>/, "").trim() || fromEmail;
            if (fromEmail.toLowerCase() === JANUS_EMAIL.toLowerCase()) continue;

            _currentTriageToken = tonyToken;
            _currentTriageMessageId = msg.id;
            _currentCallerEmail = TONY_EMAIL;

            const { reply: triageReply, toolCalls: triageToolCalls } = await askJanusWithTools(
              fromEmail, fromName, subject,
              `[TRIAGE MODE] This is an email in Tony's inbox. Do NOT reply to the sender. Instead, decide what to do:\n` +
              `1. Low-priority — archive it and send Tony a WhatsApp summary.\n` +
              `2. Important — send Tony a WhatsApp notification.\n` +
              `3. Spam — archive silently.\n\n` +
              `Email from: ${fromName} <${fromEmail}>\nSubject: ${subject}\n\n${bodyText.slice(0, 3000)}`,
              "admin", (await getTonyIdentity()).userId,
            );

            await markAsRead(tonyToken, msg.id);
            const tonyId = await getTonyIdentity();
            await logJanusConversation(tonyId.userId, "Tony (triage)", "admin", `[TRIAGE] [${subject}] from ${fromEmail}`, triageReply, triageToolCalls, "email-triage");
            await logJanusEmailDecision({
              fromEmail, fromName, subject, threadId: undefined, threadLength: 1,
              isJanusInitiatedThread: false, identity: tonyId, route: "triage",
              replyPreview: triageReply,
            });
            tonyTriaged++;
          } catch (triageErr) {
            console.error(`[Triage] Error processing message ${msg.id}:`, triageErr);
          }
        }
      }
    } catch (tonyErr) {
      console.error("[Triage] Failed to access Tony's inbox:", tonyErr);
    }

    _currentTriageToken = "";
    _currentTriageMessageId = "";

    res.json({ processed, tonyTriaged, total: unreadMessages.length });
  } catch (e) {
    console.error("janus-email-poll error:", e);
    await enqueueFailedJob("janus-email-poll", e);
    await sendAutomationFailureAlert("janus-email-poll", e instanceof Error ? e.message : "Unknown");
    res.status(500).json({ error: e instanceof Error ? e.message : "Unknown error" });
  } finally {
    _emailPollRunning = false;
  }
}
