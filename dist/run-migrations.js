
import { createRequire as __createRequire } from 'module';
const require = __createRequire(import.meta.url);


// scripts/run-migrations.ts
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
var MIGRATIONS_DIR = resolve(process.cwd(), "migrations");
var LEDGER_TABLE = "_app_migrations";
var BOOTSTRAP_PROBE_TABLES = ["public.profiles", "public.janus_memory", "public.system_audit_log"];
var CREATE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    filename         text PRIMARY KEY,
    applied_at       timestamptz NOT NULL DEFAULT now(),
    checksum_sha256  text NOT NULL,
    duration_ms      integer
  );
`;
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
function listMigrationFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}
async function runMigrations(opts = {}) {
  const dir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const log = opts.log ?? ((s) => console.log(s));
  const client = opts.client ?? null;
  if (!client) throw new Error("[migrate] runMigrations() requires a client");
  await client.query(CREATE_LEDGER_SQL);
  const { rows: ledgerRows } = await client.query(
    `SELECT filename, checksum_sha256 FROM ${LEDGER_TABLE}`
  );
  const ledger = /* @__PURE__ */ new Map();
  for (const r of ledgerRows) {
    ledger.set(String(r.filename), String(r.checksum_sha256));
  }
  if (!opts.skipBootstrapCheck && ledger.size === 0) {
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
          `[migrate] WARN ${filename} checksum drift \u2014 ledger=${recordedChecksum.slice(0, 12)} disk=${checksum.slice(0, 12)} (someone edited an applied migration; skipping)`
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
        [filename, checksum, Date.now() - stepStart]
      );
      await client.query("COMMIT");
      log(`[migrate] applied ${filename} in ${Date.now() - stepStart}ms`);
      applied++;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      log(`[migrate] FAILED ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
  const totalMs = Date.now() - t0;
  log(`[migrate] OK \u2014 ${applied} applied, ${skipped} skipped, ${totalMs}ms total`);
  return { applied, skipped, totalMs };
}
async function main() {
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
      process.exit(1);
    }
    console.error("[migrate] FAILED:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
var invokedAsCLI = Boolean(process.argv[1]?.endsWith("run-migrations.ts")) || import.meta.url === `file://${process.argv[1]}`;
if (invokedAsCLI) {
  main();
}
export {
  runMigrations
};
