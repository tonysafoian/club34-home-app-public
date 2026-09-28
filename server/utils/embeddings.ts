import { fetchT } from "./fetch-timeout.js";

const EMBED_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";
const MAX_INPUT_CHARS = 10_000;
const EMBED_TIMEOUT_MS = 10_000;
export const EMBEDDING_DIMENSIONS = 768;

function getApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
}

/**
 * Embed a string with Gemini text-embedding-004. Returns a 768-dim float
 * array, or null on any failure (missing key, network, non-2xx, bad shape).
 *
 * Failures MUST NOT block writes — callers should treat null as "skip the
 * embedding column" and continue.
 */
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[embeddings] GEMINI_API_KEY not set — skipping embed");
    return null;
  }
  if (!text || !text.trim()) return null;

  const input = text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;

  try {
    const res = await fetchT(
      `${EMBED_ENDPOINT}?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text: input }] } }),
      },
      EMBED_TIMEOUT_MS,
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `[embeddings] Gemini embed ${res.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }

    const data = (await res.json()) as { embedding?: { values?: number[] } };
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
      console.warn(
        `[embeddings] unexpected embedding shape: len=${values?.length}`,
      );
      return null;
    }
    return values;
  } catch (e) {
    console.warn(
      `[embeddings] embed failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/** pgvector accepts a `[a,b,c,…]` string literal. */
export function toPgVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
