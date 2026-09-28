import { fetchT } from "../lib/fetchWithTimeout.js";
import { logAudit } from "../lib/auditLog.js";
import {
  cleanGlobalHeadlines,
  cleanMarketUpdate,
} from "./schoolMorningBriefing.js";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const MODEL_SEARCH = "sonar";
const MODEL_DEEP = "sonar-pro";

interface PerplexityResult {
  answer: string;
  citations: string[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface CacheEntry {
  result: PerplexityResult;
  cachedAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_SIZE = 100;

const rateLimitState = {
  lastRequestAt: 0,
  minIntervalMs: 200,
};

function getCacheKey(query: string, model: string): string {
  return `${model}:${query.toLowerCase().trim()}`;
}

function getCached(key: string): PerplexityResult | null {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    responseCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key: string, result: PerplexityResult): void {
  if (responseCache.size >= MAX_CACHE_SIZE) {
    const oldest = responseCache.keys().next().value;
    if (oldest) responseCache.delete(oldest);
  }
  responseCache.set(key, { result, cachedAt: Date.now() });
}

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - rateLimitState.lastRequestAt;
  if (elapsed < rateLimitState.minIntervalMs) {
    await new Promise((r) => setTimeout(r, rateLimitState.minIntervalMs - elapsed));
  }
  rateLimitState.lastRequestAt = Date.now();
}

function formatCitations(answer: string, citations: string[]): string {
  if (!citations.length) return answer;
  let formatted = answer;
  const citationBlock = citations
    .map((url, i) => `[${i + 1}] ${url}`)
    .join("\n");
  formatted += `\n\n**Sources:**\n${citationBlock}`;
  return formatted;
}

async function callPerplexity(
  query: string,
  model: string,
  systemPrompt?: string,
): Promise<PerplexityResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not configured");

  const cacheKey = getCacheKey(query, model);
  const cached = getCached(cacheKey);
  if (cached) {
    console.log(`[Perplexity] Cache hit for: ${query.slice(0, 60)}`);
    return cached;
  }

  await rateLimit();

  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: query });

  const res = await fetchT(
    PERPLEXITY_API_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
      }),
    },
    30_000,
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[Perplexity] API error ${res.status}: ${errText}`);
    throw new Error(`Perplexity API error ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const answer = choice?.message?.content || "No response generated.";
  const citations: string[] = data.citations || [];

  const result: PerplexityResult = {
    answer,
    citations,
    model,
    usage: data.usage
      ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
        }
      : undefined,
  };

  setCache(cacheKey, result);
  return result;
}

export async function perplexitySearch(query: string): Promise<PerplexityResult> {
  return callPerplexity(
    query,
    MODEL_SEARCH,
    "You are a helpful search assistant. Provide concise, accurate, well-cited answers. Focus on facts and current information.",
  );
}

export async function perplexityDeepSearch(query: string): Promise<PerplexityResult> {
  return callPerplexity(
    query,
    MODEL_DEEP,
    "You are a thorough research assistant. Provide comprehensive, well-structured, and well-cited answers with detailed analysis.",
  );
}

export async function executePerplexitySearch(
  query: string,
  deep = false,
): Promise<string> {
  try {
    const result = deep
      ? await perplexityDeepSearch(query)
      : await perplexitySearch(query);

    const formatted = formatCitations(result.answer, result.citations);

    logAudit("perplexity-search", {
      category: "research",
      event_type: "perplexity_search",
      severity: "info",
      actor_id: "system",
      actor_name: "Janus",
      channel: "system",
      summary: `Janus searched Perplexity${deep ? " (deep)" : ""}: "${query.slice(0, 80)}"`,
      detail: {
        query,
        model: result.model,
        citation_count: result.citations.length,
        answer_length: result.answer.length,
      },
      status: "success",
    });

    return JSON.stringify({
      answer: formatted,
      citations: result.citations,
      model: result.model,
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "unknown";
    console.error("[Perplexity] Search error:", errMsg);
    logAudit("perplexity-search", {
      category: "research",
      event_type: "perplexity_search_error",
      severity: "error",
      actor_id: "system",
      actor_name: "Janus",
      channel: "system",
      summary: `Perplexity search failed: ${errMsg.slice(0, 100)}`,
      status: "error",
    });
    return `Perplexity search error: ${errMsg}`;
  }
}

export async function fetchSituationalAwareness(
  location = "Beverly Hills, CA",
): Promise<string> {
  try {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) return "";

    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const query = `What are the most important things happening right now in ${location} and Los Angeles area today (${dateStr})? Include: breaking news, weather advisories, traffic disruptions, notable local events, and any safety alerts. Be extremely concise — 3 to 5 bullet points max, one line each.`;

    const result = await perplexitySearch(query);

    if (!result.answer || result.answer.length < 20) return "";

    const lines = result.answer
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 5);

    return `── SITUATIONAL AWARENESS (${dateStr}) ──\n${lines.join("\n")}`;
  } catch (e) {
    console.error("[Perplexity] Situational awareness fetch failed:", e);
    return "";
  }
}

export async function fetchTravelIntelligence(
  destination: string,
  departureDate: string,
  returnDate: string,
): Promise<string> {
  try {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) return "";

    const query = `I'm traveling to ${destination} from ${departureDate} to ${returnDate}. Provide a brief travel intelligence briefing covering: (1) weather forecast for those dates, (2) any safety or health advisories, (3) 2-3 local tips or must-knows, (4) any relevant current events at the destination. Be concise and actionable.`;

    const result = await perplexityDeepSearch(query);
    return formatCitations(result.answer, result.citations);
  } catch (e) {
    console.error("[Perplexity] Travel intelligence fetch failed:", e);
    return "";
  }
}

export async function fetchTroubleshootingAdvice(
  system: string,
  issue: string,
  location = "Beverly Hills, CA",
): Promise<string> {
  try {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) return "";

    const query = `Home ${system} issue: ${issue}. Location: ${location}. Provide: (1) likely causes, (2) immediate troubleshooting steps the homeowner can try, (3) when to call a professional, (4) recommend 1-2 highly-rated local service providers near ${location} if applicable. Be concise and practical.`;

    const result = await perplexitySearch(query);
    return formatCitations(result.answer, result.citations);
  } catch (e) {
    console.error("[Perplexity] Troubleshooting advice fetch failed:", e);
    return "";
  }
}

export async function fetchGlobalNewsBriefing(): Promise<string[]> {
  try {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) return [];

    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    const query =
      `Today is ${dateStr}. Give exactly three distinct, major global news stories that matter most this morning. ` +
      `Prioritize consequential international developments across different regions or topics. ` +
      `Each item must be one factual spoken sentence of at most 11 words. ` +
      `Return exactly three lines and nothing else. No headings, citations, links, bullets, commentary, or predictions.`;

    const result = await perplexitySearch(query);
    if (!result.answer) return [];
    const headlines = cleanGlobalHeadlines(result.answer);
    return headlines.length === 3 ? headlines : [];
  } catch (e) {
    console.error("[Perplexity] Global news briefing fetch failed:", e);
    return [];
  }
}

export async function fetchMarketBriefing(): Promise<string> {
  try {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) return "";

    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const query =
      `Today is ${dateStr}. Give a current, neutral U.S. stock-market update for a spoken family briefing. ` +
      `State the broad direction of the S&P 500, Dow, and Nasdaq futures or latest session, plus the single dominant driver. ` +
      `Use one sentence of at most 20 words. Avoid investment advice, individual-stock recommendations, unsupported precision, ` +
      `headings, citations, links, bullets, and market jargon.`;
    const result = await perplexitySearch(query);
    return cleanMarketUpdate(result.answer ?? "");
  } catch (e) {
    console.error("[Perplexity] Market briefing fetch failed:", e);
    return "";
  }
}
