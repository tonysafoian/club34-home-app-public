/**
 * Per-completion LLM usage capture.
 *
 * OpenRouter returns a `usage` object in every chat-completion response
 * — top-level for non-streaming, embedded in the final SSE chunk for
 * streaming (when `stream_options.include_usage = true`). We persist
 * one row in `janus_llm_usage` per completion so we can later answer
 * "Janus cost this week, by user / channel / model / tier" without
 * estimating from log counts.
 *
 * Usage:
 *
 *   const usage = extractUsageFromStream(sseChunkLines);  // streaming
 *   const usage = extractUsageFromBody(jsonBody);         // non-streaming
 *   await recordLlmUsage({ model, channel, tier, ... }, usage);
 *
 * Best-effort: any failure here is swallowed (we don't want a metrics
 * write to break a working chat reply).
 */

import { query } from "./db.js";
import { getCurrentCorrelationId } from "./correlation.js";

export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** USD. OpenRouter sets this for providers that report cost; null otherwise. */
  cost?: number;
}

export interface LlmUsageRecord {
  userId?: string | null;
  channel?: string | null;       // "chat" | "whatsapp" | "email" | "cron" | "external"
  model: string;
  tier?: string | null;          // "simple" | "default" | "complex" | "summarize"
  durationMs?: number;
  requestType?: string | null;   // "chat" | "tool_round" | "summarize" | "research"
  /** Explicit override; otherwise pulled from the ALS context. */
  correlationId?: string | null;
}

/**
 * Pull usage out of a non-streaming OpenRouter JSON body. Returns null
 * when no usage was reported (older response shapes / errors).
 */
export function extractUsageFromBody(body: unknown): OpenRouterUsage | null {
  if (!body || typeof body !== "object") return null;
  const u = (body as { usage?: OpenRouterUsage }).usage;
  if (!u || typeof u !== "object") return null;
  return u;
}

/**
 * Pull usage out of an array of raw SSE lines from an OpenRouter stream.
 * OpenRouter emits one final `data: {…, "usage": {…}}` chunk when the
 * caller sets `stream_options.include_usage = true`. We scan the chunks
 * we've buffered for a non-empty usage object, returning the most
 * recent one (final chunk wins).
 */
export function extractUsageFromStream(rawChunks: string[]): OpenRouterUsage | null {
  let found: OpenRouterUsage | null = null;
  for (const line of rawChunks) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      const u = parsed?.usage;
      if (u && typeof u === "object" && (u.total_tokens || u.prompt_tokens || u.completion_tokens)) {
        found = u as OpenRouterUsage;
      }
    } catch {
      // Ignore — partial chunks happen during the stream.
    }
  }
  return found;
}

/**
 * Insert one usage row. Auto-stamps correlation_id from the ALS context
 * when the caller didn't pass one. Returns true on success, false on
 * any failure (logged once).
 */
export async function recordLlmUsage(
  meta: LlmUsageRecord,
  usage: OpenRouterUsage | null,
): Promise<boolean> {
  if (!usage) return false;
  try {
    const correlationId = meta.correlationId ?? getCurrentCorrelationId() ?? null;
    await query(
      `INSERT INTO janus_llm_usage
         (user_id, channel, model, tier,
          prompt_tokens, completion_tokens, total_tokens, cost_usd,
          correlation_id, duration_ms, request_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        meta.userId ?? null,
        meta.channel ?? null,
        meta.model,
        meta.tier ?? null,
        usage.prompt_tokens ?? null,
        usage.completion_tokens ?? null,
        usage.total_tokens ?? null,
        typeof usage.cost === "number" ? usage.cost : null,
        correlationId || null,
        typeof meta.durationMs === "number" ? meta.durationMs : null,
        meta.requestType ?? null,
      ],
    );
    return true;
  } catch (e) {
    console.warn(`[llm-usage] record failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * The `stream_options` field OpenRouter expects to start emitting
 * usage on a streaming completion. Spread this into the request body
 * to keep the wire format consistent.
 */
export const STREAM_USAGE_OPTION = { stream_options: { include_usage: true } } as const;
