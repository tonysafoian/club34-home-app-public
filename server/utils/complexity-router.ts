/**
 * Live complexity router for Janus chat dispatch.
 *
 * Background: JANUS_MODEL_SIMPLE / JANUS_MODEL_COMPLEX env tiers existed
 * but no code path selected them. Every chat request went to MODEL_DEFAULT
 * regardless of length, intent, or how deep the tool loop was. This
 * module gives us a real, heuristic-driven tier choice.
 *
 * Three tiers:
 *   - "simple"   — short, no-tool, single-shot device control / lookup.
 *                  Routed to MODEL_SIMPLE.
 *   - "default"  — everything that isn't clearly simple or complex.
 *                  Routed to MODEL_DEFAULT.
 *   - "complex"  — long prompts, explicit research / planning intent,
 *                  URL+verb (read this / summarize this), or "the model
 *                  has already chained 3+ tool calls in this turn".
 *                  Routed to MODEL_COMPLEX.
 *
 * Monotonic upgrade: once a turn reaches "complex" it stays "complex"
 * for subsequent rounds (no flip-flop). "simple" → "default" → "complex"
 * is fine; the reverse is not.
 *
 * Pure functions — no I/O, no DB access. Safe to import from anywhere.
 */

export type Complexity = "simple" | "default" | "complex";

const RANK: Record<Complexity, number> = { simple: 0, default: 1, complex: 2 };

const SIMPLE_NEGATIVE_KEYWORDS = [
  "research",
  "analyze",
  "compare",
  "summarize this",
  "summarize my",
  "plan",
  "draft",
  "write",
  "schedule",
  "book",
  "find me",
];

const COMPLEX_KEYWORDS = [
  "research",
  "deep dive",
  "deep-dive",
  "analyze",
  "compare",
  "plan",
  "strategize",
  "investigate",
];

const URL_RE = /https?:\/\/\S+/i;
const RESEARCH_VERBS = /\b(summarize|read|analyze|review|extract|digest|pull[\s-]?from)\b/i;

const SIMPLE_LENGTH_THRESHOLD = 80;
const COMPLEX_LENGTH_THRESHOLD = 400;
const COMPLEX_TOOL_CALLS_THRESHOLD = 3;

export interface ComplexityInput {
  /** The current turn's user message (or its text portion if multipart). */
  userMessage: string;
  /**
   * Tool calls already executed in *this turn's* loop. Pre-loop, 0.
   * After each tool round, the count of calls so far.
   */
  toolCallsSoFar?: number;
  /**
   * The prior conversation history (optional). Currently only used for
   * the "any tool calls in history" check that downgrades borderline
   * messages out of the "simple" tier — the model has likely chained
   * tools already.
   */
  history?: Array<{ role?: string; tool_calls?: unknown[] }>;
}

export interface ComplexityDecision {
  tier: Complexity;
  reason: string;
}

function containsAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k));
}

function priorToolCallCount(history: ComplexityInput["history"]): number {
  if (!history?.length) return 0;
  let n = 0;
  for (const m of history) {
    if (m && (m.role === "tool" || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0))) {
      n += Array.isArray(m.tool_calls) ? m.tool_calls.length : 1;
    }
  }
  return n;
}

/**
 * Decide which tier this request should run on. Pure function.
 *
 * The decision is heuristic and conservative — when in doubt it returns
 * "default" because the user-visible cost of mis-classifying down is a
 * dropped-quality reply, not a crash.
 */
export function classifyComplexity(input: ComplexityInput): ComplexityDecision {
  const raw = (input.userMessage ?? "").trim();
  const lower = raw.toLowerCase();
  const len = raw.length;
  const toolCallsSoFar = input.toolCallsSoFar ?? 0;
  const priorTools = priorToolCallCount(input.history);

  // Empty / blank user message — don't speculatively route to simple.
  // The handler may still call the model (e.g. multimodal-only turns
  // where the text part is empty but an image is attached), so default
  // is the safe choice.
  if (len === 0) {
    return { tier: "default", reason: "empty_input" };
  }

  // --- complex checks (any one matches → complex) -----------------------

  if (toolCallsSoFar >= COMPLEX_TOOL_CALLS_THRESHOLD) {
    return {
      tier: "complex",
      reason: `tool_calls_so_far=${toolCallsSoFar} ≥ ${COMPLEX_TOOL_CALLS_THRESHOLD}`,
    };
  }

  if (len > COMPLEX_LENGTH_THRESHOLD) {
    return { tier: "complex", reason: `message_length=${len} > ${COMPLEX_LENGTH_THRESHOLD}` };
  }

  if (containsAny(lower, COMPLEX_KEYWORDS)) {
    const matched = COMPLEX_KEYWORDS.filter((k) => lower.includes(k));
    return { tier: "complex", reason: `complex_keyword=${matched.join(",")}` };
  }

  if (URL_RE.test(raw) && RESEARCH_VERBS.test(raw)) {
    return { tier: "complex", reason: "url+research_verb" };
  }

  // --- simple checks (all must hold) -----------------------------------

  const simpleOk =
    len < SIMPLE_LENGTH_THRESHOLD &&
    toolCallsSoFar === 0 &&
    priorTools === 0 &&
    !raw.includes("?") &&
    !containsAny(lower, SIMPLE_NEGATIVE_KEYWORDS);

  if (simpleOk) {
    return { tier: "simple", reason: `short(${len})+no_tools+no_qmark+no_neg_kw` };
  }

  return { tier: "default", reason: "default_fallback" };
}

/**
 * Read the env-configured model id for a given tier. Same defaults the
 * chat handler used to inline. Exported separately so callers can keep
 * their model-string assembly close to the openrouter fetch.
 */
export function pickModel(tier: Complexity): string {
  switch (tier) {
    case "simple":
      return process.env.JANUS_MODEL_SIMPLE || "google/gemini-2.5-flash-lite";
    case "complex":
      return process.env.JANUS_MODEL_COMPLEX || "google/gemini-2.5-pro";
    case "default":
    default:
      return process.env.JANUS_MODEL_DEFAULT || "google/gemini-3-flash-preview";
  }
}

/**
 * Apply monotonic-upgrade semantics: never downgrade a tier within a
 * single turn. Takes the current sticky tier and the latest decision;
 * returns the tier (and reason) that should actually be used.
 *
 * If the new decision is the same rank or lower, the current tier wins
 * and the reason is unchanged. If the new decision is strictly higher,
 * adopt it.
 */
export function applyMonotonicUpgrade(
  current: ComplexityDecision,
  next: ComplexityDecision,
): ComplexityDecision {
  if (RANK[next.tier] > RANK[current.tier]) return next;
  return current;
}
