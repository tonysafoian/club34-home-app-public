/**
 * Filename-based migration runner.
 *
 * Reads migrations/*.sql in alphabetical order. For each file:
 *   - Skip if filename is already in the `_app_migrations` ledger.
 *   - Otherwise run it in a transaction and record (filename, sha256,
 *     duration_ms) in the ledger.
 *
 * Why custom (not drizzle-kit migrate): migrations/meta/_journal.json
 * only lists 1 of 15 SQL files — the team has been hand-writing raw
 * SQL migrations and never running `drizzle-kit generate`. So a
 * journal-based migrator wouldn't see most files. This runner is
 * journal-independent — filename is the contract.
 *
 * Safety: smart refusal. If `public.profiles` (or any other obvious
 * application table) exists but the ledger is empty, we treat that
 * as bootstrap drift and refuse to apply ANY migration until someone
 * runs `npm run migrate:seed` once. That avoids re-applying 0000–0014
 * on top of an already-populated production database.
 *
 * Exit codes:
 *   0  — everything applied / nothing to do
 *   1  — failure (smart refusal, SQL error, connection error, …)
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = resolve(process.cwd(), "migrations");
// Table that records which migration filenames have been applied.
const LEDGER_TABLE = "_app_migrations";

// Application tables we expect to exist on a production database. If
// any of these is non-null but the ledger is empty, we refuse to run
// until the user explicitly runs the seeder.
const BOOTSTRAP_PROBE_TABLES = ["public.profiles", "public.janus_memory", "public.system_audit_log"] as const;

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

function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // alphabetical is also numeric for our NNNN_* naming
}

export interface RunMigrationsResult {
  applied: number;
  skipped: number;
  totalMs: number;
}

export interface RunMigrationsOptions {
  /**
   * Override the migrations directory. Tests inject a tmpdir; prod
   * defaults to the project's migrations/ folder.
   */
  migrationsDir?: string;
  /**
   * Inject a Postgres client. Tests pass a fake; prod creates a fresh
   * pool with max=2 connections.
   */
  client?: PgClientLike;
  /**
   * When true, skip the bootstrap-drift check. Used only by the
   * seeder script's "fresh ledger after first deploy" probe and by
   * tests that explicitly want to exercise the empty-DB path.
   */
  skipBootstrapCheck?: boolean;
  /**
   * Log function. Tests substitute a buffer.
   */
  log?: (line: string) => void;
}

export interface PgClientLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/**
 * Apply pending migrations. Pure-ish — does not exit the process.
 * The CLI wrapper at the bottom handles exit codes.
 */
export async function runMigrations(opts: RunMigrationsOptions = {}): Promise<RunMigrationsResult> {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const log = opts.log ?? ((s: string) => console.log(s));
  const client = opts.client ?? null;
  if (!client) throw new Error("[migrate] runMigrations() requires a client");

  await client.query(CREATE_LEDGER_SQL);

  // List ledger state up-front so the bootstrap check + per-file
  // dedup are both single-query.
  const { rows: ledgerRows } = await client.query(
    `SELECT filename, checksum_sha256 FROM ${LEDGER_TABLE}`,
  );
  const ledger = new Map<string, string>();
  for (const r of ledgerRows) {
    ledger.set(String(r.filename), String(r.checksum_sha256));
  }

  if (!opts.skipBootstrapCheck && ledger.size === 0) {
    // Empty ledger. Are there application tables already? If yes,
    // bootstrap drift — refuse and tell the user to run the seeder.
    let foundExistingTable = false;
    let probeHit = "";
    for (const t of BOOTSTRAP_PROBE_TABLES) {
      try {
        const { rows } = await client.query(`SELECT to_regclass($1) AS oid`, [t]);
        if (rows[0]?.oid) {
          foundExistingTable = true;
          probeHit = t;
          break;
        }
      } catch {
        // probing failed; assume not present and continue
      }
    }
    if (foundExistingTable) {
      log(`[migrate] REFUSING: pre-existing schema detected with empty migration ledger.`);
      log(`[migrate] Found existing table: ${probeHit}`);
      log(`[migrate] This means application tables exist but the ledger has no record.`);
      log(`[migrate] To bootstrap: run \`npm run migrate:seed\` once, which marks ALL existing migrations/*.sql as already-applied. Then redeploy.`);
      throw new Error("bootstrap_drift");
    }
  }

  const files = listMigrationFiles(dir);
  const t0 = Date.now();
  let applied = 0;
  let skipped = 0;

  for (const filename of files) {
    const fullPath = join(dir, filename);
    const content = readFileSync(fullPath);
    const checksum = sha256(content);

    if (ledger.has(filename)) {
      const recordedChecksum = ledger.get(filename) || "";
      if (recordedChecksum && recordedChecksum !== checksum) {
        log(
          `[migrate] WARN ${filename} checksum drift — ledger=${recordedChecksum.slice(0, 12)} disk=${checksum.slice(0, 12)} (someone edited an applied migration; skipping)`,
        );
      } else {
        log(`[migrate] skip ${filename} (already applied)`);
      }
      skipped++;
      continue;
    }

    const sql = content.toString("utf8");
    const stepStart = Date.now();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        `INSERT INTO ${LEDGER_TABLE} (filename, checksum_sha256, duration_ms) VALUES ($1, $2, $3)`,
        [filename, checksum, Date.now() - stepStart],
      );
      await client.query("COMMIT");
      log(`[migrate] applied ${filename} in ${Date.now() - stepStart}ms`);
      applied++;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      log(`[migrate] FAILED ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  const totalMs = Date.now() - t0;
  log(`[migrate] OK — ${applied} applied, ${skipped} skipped, ${totalMs}ms total`);
  return { applied, skipped, totalMs };
}

// --- CLI entry point ------------------------------------------------------

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL not set; refusing to run");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    await runMigrations({ client: pool });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "bootstrap_drift") {
      // The smart-refusal path already printed the explanation.
      process.exit(1);
    }
    console.error("[migrate] FAILED:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Detect "is this the CLI entry?" — when running `tsx scripts/run-migrations.ts`
const invokedAsCLI =
  Boolean(process.argv[1]?.endsWith("run-migrations.ts")) ||
  import.meta.url === `file://${process.argv[1]}`;

if (invokedAsCLI) {
  main();
}
