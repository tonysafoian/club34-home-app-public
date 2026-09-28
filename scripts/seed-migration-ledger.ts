/**
 * One-time bootstrap for the filename-based migration runner.
 *
 * The production database already has migrations 0000–0014 applied
 * (manually via psql over the past few months). The new ledger table
 * `_app_migrations` starts empty, so the runner's smart-refusal check
 * would block any deploy.
 *
 * This script reads every `migrations/*.sql` file, computes its
 * SHA-256, and INSERTs a row per file into `_app_migrations` with
 * `applied_at = now()` and `duration_ms = NULL` (NULL meaning "this
 * row was backfilled, not actually timed by the runner").
 *
 * ON CONFLICT DO NOTHING — re-running is safe and a no-op for files
 * already in the ledger. Use this if you ever add a new migration
 * file to a system that already has the new ones in the ledger but
 * is missing the rest (shouldn't happen, but the idempotency is
 * cheap).
 *
 * Exit codes:
 *   0 — all migrations seeded (newly inserted or already present)
 *   1 — DATABASE_URL missing / DB connection failed
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import type { PgClientLike } from "./run-migrations.js";

const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");
const LEDGER_TABLE = "_app_migrations";

const CREATE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    filename         text PRIMARY KEY,
    applied_at       timestamptz NOT NULL DEFAULT now(),
    checksum_sha256  text NOT NULL,
    duration_ms      integer
  );
`;

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface SeedLedgerOptions {
  migrationsDir?: string;
  client?: PgClientLike;
  log?: (line: string) => void;
}

export interface SeedLedgerResult {
  inserted: number;
  skipped: number;
  total: number;
}

export async function seedMigrationLedger(opts: SeedLedgerOptions = {}): Promise<SeedLedgerResult> {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const log = opts.log ?? ((s: string) => console.log(s));
  const client = opts.client;
  if (!client) throw new Error("[migrate:seed] requires a client");

  await client.query(CREATE_LEDGER_SQL);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let inserted = 0;
  let skipped = 0;
  for (const filename of files) {
    const content = readFileSync(join(dir, filename));
    const checksum = sha256(content);
    const res = await client.query(
      `INSERT INTO ${LEDGER_TABLE} (filename, checksum_sha256, duration_ms)
       VALUES ($1, $2, NULL)
       ON CONFLICT (filename) DO NOTHING`,
      [filename, checksum],
    );
    if (res.rowCount && res.rowCount > 0) {
      log(`[migrate:seed] inserted ${filename} (sha256=${checksum.slice(0, 12)})`);
      inserted++;
    } else {
      log(`[migrate:seed] already in ledger: ${filename}`);
      skipped++;
    }
  }

  log(`[migrate:seed] OK — ${inserted} inserted, ${skipped} already present, ${files.length} total`);
  return { inserted, skipped, total: files.length };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate:seed] DATABASE_URL not set; refusing to run");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await seedMigrationLedger({ client: pool });
  } catch (err) {
    console.error("[migrate:seed] FAILED:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

const invokedAsCLI = (() => {
  try {
    const argvUrl = new URL(`file://${process.argv[1]}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (invokedAsCLI) {
  main();
}
