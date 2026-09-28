/**
 * Post-generation hallucination guards.
 *
 * Janus's defense layer for "I did X" claims the model emits without
 * actually calling the X tool. Each guard pairs:
 *   - a detector that inspects the model's text + the turn's tool_calls,
 *   - a SYSTEM OVERRIDE re-prompt that gets fed back into the loop so
 *     the model either calls the tool or corrects itself,
 *   - audit metadata for the system_audit_log row written on every fire.
 *
 * Previously each handler (chat, whatsapp, email-poll) carried its own
 * pair of detector functions (`detectCalendarHallucination`,
 * `detectGoogleFileHallucination`). This module collapses the three
 * copies into one source of truth and adds three new guards
 * (email-sent, cart-add, reminder-set) plus structured audit logging.
 */

import { logAudit } from "../lib/auditLog.js";

export interface ToolCallRecord {
  name: string;
  /** Raw tool result string (the detectors use this to filter TOOL_ERROR results). */
  result?: string;
  // Other fields (args, etc.) tolerated but unused.
  [k: string]: unknown;
}

export interface HallucinationGuard {
  /** Stable id used in logs + audit rows. */
  name: string;
  /** Returns true when the guard considers `reply` a hallucination. */
  detector: (reply: string, toolCalls: ToolCallRecord[]) => boolean;
  /** Sentinel inserted as a user-role message to force the model to retry. */
  overrideMessage: string;
  /** Short console-log tag. */
  consoleSummary: string;
}

function hasSuccessfulToolCall(toolCalls: ToolCallRecord[], name: string): boolean {
  return toolCalls.some(
    (t) => t.name === name && !(typeof t.result === "string" && t.result.startsWith("TOOL_ERROR")),
  );
}

function lowercaseIncludesAny(text: string, phrases: string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p.toLowerCase()));
}

// --- Individual guard definitions ---------------------------------------

const CALENDAR_PHRASES = [
  "created a calendar event",
  "added to your calendar",
  "scheduled",
  "i've created the event",
  "event has been created",
];

const calendarGuard: HallucinationGuard = {
  name: "calendar_event",
  detector: (reply, toolCalls) =>
    lowercaseIncludesAny(reply, CALENDAR_PHRASES) &&
    !hasSuccessfulToolCall(toolCalls, "create_calendar_event"),
  overrideMessage:
    "SYSTEM OVERRIDE: You claimed to create a calendar event but did NOT call the create_calendar_event tool. Do it now.",
  consoleSummary: "Calendar claim without tool call",
};

const GOOGLE_FILE_URL_RE =
  /https:\/\/docs\.google\.com\/(document|spreadsheets|presentation|forms)\/d\/[a-zA-Z0-9_-]+/;

const googleFileGuard: HallucinationGuard = {
  name: "google_file",
  detector: (reply, toolCalls) =>
    GOOGLE_FILE_URL_RE.test(reply) && !hasSuccessfulToolCall(toolCalls, "create_google_file"),
  overrideMessage:
    "SYSTEM OVERRIDE: You included a Google URL that doesn't exist. Call the create_google_file tool now.",
  consoleSummary: "Google file URL without tool call",
};

// --- New guards ---------------------------------------------------------

// Email-sent. Be inclusive on phrasing but anchor on first-person past-tense
// or imperative confirmation. "Send me an email" / "if you want, I can email"
// are NOT claims of having sent and must not fire.
const EMAIL_SENT_PATTERNS: RegExp[] = [
  /\bi (?:just )?sent (?:the |an? |your )?email\b/i,
  /\bi(?:'ve| have)\s+sent (?:the |an? |your )?email\b/i,
  /\bi(?:'ve| have)?\s*emailed\b/i,
  /\bemail (?:has been |was |is )?sent\b/i,
  /\bsent (?:the |an? |your )?email to\b/i,
  /\bjust emailed\b/i,
  /✉️\s*sent\b/i,
];

const emailSentGuard: HallucinationGuard = {
  name: "email_sent",
  detector: (reply, toolCalls) =>
    EMAIL_SENT_PATTERNS.some((re) => re.test(reply)) &&
    !hasSuccessfulToolCall(toolCalls, "send_email"),
  overrideMessage:
    "SYSTEM OVERRIDE: You told the user you sent the email but did not call the send_email tool. Do it now using send_email, or correct yourself.",
  consoleSummary: "Email-sent claim without tool call",
};

// Cart-add. The actual tool name in ALL_TOOLS is `save_to_cart` (single tool
// covering Amazon Fresh, Instacart, DoorDash, Postmates, …). The patterns
// are written to match common past-tense / state-of-being claims that
// imply the action was completed, without firing on "look in your cart"
// or "what's in your cart?".
const CART_ADD_PATTERNS: RegExp[] = [
  /\badded\b[^.!?]{0,80}?\bto (?:your|the) (?:amazon |grocery |instacart |fresh |doordash |postmates )?cart\b/i,
  /\bsaved\b[^.!?]{0,80}?\bto (?:your|the) (?:amazon |grocery |instacart |fresh |doordash |postmates )?cart\b/i,
  /\bare in your (?:amazon |grocery |instacart |fresh |doordash |postmates )?cart\b/i,
  /\b(?:it'?s|that'?s|they'?re) in your (?:amazon |grocery |instacart |fresh |doordash |postmates )?cart\b/i,
];

const cartAddGuard: HallucinationGuard = {
  name: "cart_add",
  detector: (reply, toolCalls) =>
    CART_ADD_PATTERNS.some((re) => re.test(reply)) &&
    !hasSuccessfulToolCall(toolCalls, "save_to_cart"),
  overrideMessage:
    "SYSTEM OVERRIDE: You claimed to add an item to the cart but did not call the save_to_cart tool. Do it now or correct yourself.",
  consoleSummary: "Cart-add claim without tool call",
};

// Reminder-set. Tool name is `set_reminder`. "I'll remind you" is a soft
// promise that, in conversational use, usually presumes a backing tool
// call — treat it the same way.
const REMINDER_SET_PATTERNS: RegExp[] = [
  /\bi (?:just |'ve |have )?set (?:a |the |your )?reminder\b/i,
  /\bi(?:'ll| will)\s+remind you\b/i,
  /\breminder (?:has been |is |was )?set\b/i,
  /\bi (?:just |'ve |have )?created (?:a |the |your )?reminder\b/i,
];

const reminderSetGuard: HallucinationGuard = {
  name: "reminder_set",
  detector: (reply, toolCalls) =>
    REMINDER_SET_PATTERNS.some((re) => re.test(reply)) &&
    !hasSuccessfulToolCall(toolCalls, "set_reminder"),
  overrideMessage:
    "SYSTEM OVERRIDE: You told the user a reminder was set but did not call the set_reminder tool. Do it now.",
  consoleSummary: "Reminder-set claim without tool call",
};

export const HALLUCINATION_GUARDS: readonly HallucinationGuard[] = [
  calendarGuard,
  googleFileGuard,
  emailSentGuard,
  cartAddGuard,
  reminderSetGuard,
];

/**
 * Runs every guard in order against (reply, toolCalls). Returns the
 * first guard that fires (the loop should re-prompt with that guard's
 * overrideMessage), or null if no guard matches.
 *
 * Audit logging is intentionally NOT done here — the caller does it
 * after the fire so we can record handler-specific context (channel,
 * user_id, etc.) consistently with the rest of the audit stream.
 */
export function detectHallucination(
  reply: string,
  toolCalls: ToolCallRecord[],
): HallucinationGuard | null {
  for (const guard of HALLUCINATION_GUARDS) {
    if (guard.detector(reply, toolCalls)) return guard;
  }
  return null;
}

/**
 * Convenience audit-log helper. Records guard fires (or no-fire summary)
 * in system_audit_log with event_type=hallucination_guard so we can
 * later count how often each guard saves us across channels.
 *
 * Best-effort: any failure is swallowed (logAudit already does this).
 */
export async function auditHallucinationGuard(opts: {
  /** "janus-chat" | "janus-whatsapp" | "janus-email-poll" — matches the existing edge_function field convention. */
  edgeFunction: string;
  /** "chat" | "whatsapp" | "whatsapp-group" | "email". */
  channel: string;
  /** The guard that fired, or null if you want a no-fire breadcrumb. */
  guard: HallucinationGuard | null;
  /** The model's reply text — truncated by this helper. */
  reply: string;
  /** Whether the override re-prompt was actually queued. */
  didRemediation: boolean;
  actorId?: string;
  actorName?: string;
  toolNames?: string[];
}): Promise<void> {
  if (!opts.guard) return; // We only audit fires.
  const snippet = opts.reply.length > 280 ? opts.reply.slice(0, 280) + "…" : opts.reply;
  await logAudit(opts.edgeFunction, {
    category: "janus",
    event_type: "hallucination_guard",
    severity: "warn",
    actor_id: opts.actorId ?? "system",
    actor_name: opts.actorName ?? "hallucination-guard",
    channel: opts.channel,
    summary: `Hallucination guard fired: ${opts.guard.name}`,
    detail: {
      guard_name: opts.guard.name,
      original_text_snippet: snippet,
      did_remediation: opts.didRemediation,
      tool_names: opts.toolNames ?? [],
    },
    status: "success",
    // Worth a human glance — we caught a confabulation and re-prompted
    // the model. Tracking the actual rate per guard lets us tune the
    // regexes if false positives start showing up.
    actionable: true,
  }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
}
