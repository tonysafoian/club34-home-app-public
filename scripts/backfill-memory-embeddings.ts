/**
 * Backfill embeddings for janus_memory rows that don't yet have one.
 *
 * Run: npm run backfill:memory-embeddings
 *
 * Idempotent — re-running only processes rows where embedding IS NULL.
 * Skips rows whose embedding call fails so the script always makes
 * forward progress.
 */
import "dotenv/config";
import { query } from "../server/lib/db.js";
import { embedText, toPgVectorLiteral } from "../server/utils/embeddings.js";

const SLEEP_MS = 50;
const PROGRESS_EVERY = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) not set — aborting.");
    process.exit(1);
  }

  console.log("[backfill] selecting rows without embeddings…");
  const { rows } = await query(
    `SELECT id, user_id, key, value, context FROM janus_memory WHERE embedding IS NULL ORDER BY updated_at ASC`,
  );
  console.log(`[backfill] ${rows.length} rows to process`);

  let success = 0;
  let skipped = 0;
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const text = `${row.key} ${row.value} ${row.context ?? ""}`.trim();
    const embedding = await embedText(text);
    if (!embedding) {
      skipped++;
      console.warn(`[backfill] skip ${row.user_id}/${row.key} — embed returned null`);
    } else {
      try {
        await query(
          `UPDATE janus_memory SET embedding = $1::vector WHERE id = $2`,
          [toPgVectorLiteral(embedding), row.id],
        );
        success++;
      } catch (e) {
        skipped++;
        console.warn(
          `[backfill] update failed for ${row.user_id}/${row.key}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if ((i + 1) % PROGRESS_EVERY === 0) {
      console.log(
        `[backfill] ${i + 1}/${rows.length} processed (${success} ok, ${skipped} skipped)`,
      );
    }
    await sleep(SLEEP_MS);
  }

  console.log(
    `[backfill] done. ${success} embedded, ${skipped} skipped, ${(Date.now() - t0) / 1000}s elapsed`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] fatal:", err);
    process.exit(1);
  });
