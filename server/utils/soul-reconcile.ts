/**
 * Reconcile the SOUL prompt between its two sources of truth on boot.
 *
 * The Janus persona prompt lives in two places:
 *   1. The repo file `supabase/functions/_shared/SOUL.md` (committed; the
 *      file `loadPrompt` falls back to when the DB row is unavailable).
 *   2. The `system_prompts` row with `slug = 'janus-core'` (cached for 5 min
 *      in process, edited by the Admin UI without a redeploy).
 *
 * Whenever both exist the runtime picks the DB row, so an outdated repo file
 * silently still ships its hard-coded text if someone edits it without
 * running `sync-soul`. This reconciler runs once at startup, hashes both,
 * and:
 *   - if they match: logs an info message and is done;
 *   - if they differ: picks the more-recently-modified side as the winner;
 *       * if the FILE won, writes the file's content into the DB row so
 *         all channels converge on it;
 *       * if the DB won, logs a warning (we don't write the repo file from
 *         a running server — that creates dirty-tree / hot-reload
 *         surprises) and records it in `system_audit_log` so a human can
 *         run `sync-soul` to push the DB content back to disk.
 *
 * The whole routine is best-effort: any failure logs and returns; it never
 * throws so it can't block server startup.
 */

import { createHash } from "crypto";
import { promises as fsp } from "fs";
import path from "path";

const SOUL_FILE_RELATIVE = "supabase/functions/_shared/SOUL.md";
const SOUL_SLUG = "janus-core";

export type SoulSide = "file" | "db";

export interface ReconcileOutcome {
  status: "in_sync" | "file_won" | "db_won" | "skipped";
  fileHash?: string;
  dbHash?: string;
  fileMtime?: string;
  dbUpdatedAt?: string;
  reason?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Run the reconciliation. Safe to call once during server bootstrap.
 *
 * Returns the outcome so callers / tests can assert. Never throws.
 */
export async function reconcileSoulSource(opts: {
  /** Override the SOUL file path. Defaults to `process.cwd() + SOUL_FILE_RELATIVE`. */
  soulFilePath?: string;
  /**
   * Inject a SQL query function (signature matches `server/lib/db.ts`'s
   * `query`). Defaults to the real one. Tests pass a stub.
   */
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  /**
   * Inject an audit logger (signature matches `server/lib/auditLog.ts`'s
   * `logAudit`). Defaults to the real one. Tests pass a stub.
   */
  logAudit?: (edgeFunction: string, entry: Record<string, unknown>) => Promise<void>;
} = {}): Promise<ReconcileOutcome> {
  const filePath = opts.soulFilePath ?? path.resolve(process.cwd(), SOUL_FILE_RELATIVE);

  let queryFn = opts.query;
  if (!queryFn) {
    try {
      ({ query: queryFn } = await import("../lib/db.js"));
    } catch (e) {
      const reason = `db module unavailable: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`[soul-reconcile] ${reason}`);
      return { status: "skipped", reason };
    }
  }

  let auditFn = opts.logAudit;
  if (!auditFn) {
    try {
      ({ logAudit: auditFn } = await import("../lib/auditLog.js"));
    } catch {
      // Audit log is best-effort; carry on without it.
      auditFn = async () => {};
    }
  }

  let fileContent: string;
  let fileMtime: Date;
  try {
    const [stat, raw] = await Promise.all([fsp.stat(filePath), fsp.readFile(filePath, "utf8")]);
    fileContent = raw;
    fileMtime = stat.mtime;
  } catch (e) {
    const reason = `SOUL file unreadable at ${filePath}: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[soul-reconcile] ${reason}`);
    return { status: "skipped", reason };
  }

  let dbRow: { content: string; updated_at: string } | null = null;
  try {
    const { rows } = await queryFn(
      `SELECT content, updated_at FROM system_prompts WHERE slug = $1 LIMIT 1`,
      [SOUL_SLUG],
    );
    if (rows && rows.length > 0) {
      dbRow = { content: String(rows[0].content ?? ""), updated_at: String(rows[0].updated_at ?? "") };
    }
  } catch (e) {
    const reason = `system_prompts query failed: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[soul-reconcile] ${reason}`);
    return { status: "skipped", reason };
  }

  const fileHash = sha256(fileContent);

  // No DB row yet — seed it with the file content so the next boot is
  // already in sync. The seed script normally does this on first boot
  // but we shouldn't depend on it.
  if (!dbRow) {
    try {
      await queryFn(
        `INSERT INTO system_prompts (slug, label, content, description) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO NOTHING`,
        [SOUL_SLUG, "Janus Core Prompt (SOUL)", fileContent, "Seeded from SOUL.md on first reconcile"],
      );
      console.log(`[janus] SOUL seeded into system_prompts from file (hash=${fileHash.slice(0, 12)})`);
      await auditFn("soul-reconcile", {
        category: "system",
        event_type: "soul_reconcile",
        severity: "info",
        actor_id: "system",
        actor_name: "soul-reconcile",
        channel: "system",
        summary: "SOUL seeded into system_prompts from file",
        detail: { file_hash: fileHash, db_hash: null, winner: "file" as SoulSide, resolved_at: new Date().toISOString() },
        status: "success",
      });
      return { status: "file_won", fileHash, fileMtime: fileMtime.toISOString() };
    } catch (e) {
      const reason = `failed to seed system_prompts row: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`[soul-reconcile] ${reason}`);
      return { status: "skipped", reason };
    }
  }

  const dbHash = sha256(dbRow.content);

  if (fileHash === dbHash) {
    console.log(`[janus] SOUL in sync (hash=${fileHash.slice(0, 12)})`);
    return { status: "in_sync", fileHash, dbHash, fileMtime: fileMtime.toISOString(), dbUpdatedAt: dbRow.updated_at };
  }

  // Drift. Pick the more-recently-touched side.
  const fileTime = fileMtime.getTime();
  const dbTime = new Date(dbRow.updated_at).getTime();
  const winner: SoulSide = fileTime >= dbTime ? "file" : "db";

  console.warn(
    `[janus] SOUL drift detected: file mtime=${fileMtime.toISOString()}, db updated_at=${dbRow.updated_at}, using=${winner}, file_hash=${fileHash.slice(0, 12)}, db_hash=${dbHash.slice(0, 12)}`,
  );

  if (winner === "file") {
    // Push the file content into the DB so every channel sees the same
    // text on the next request (loadPrompt cache is 5 min).
    try {
      await queryFn(
        `UPDATE system_prompts SET content = $1, updated_at = NOW(), updated_by = 'soul-reconcile' WHERE slug = $2`,
        [fileContent, SOUL_SLUG],
      );
      console.log(`[janus] SOUL drift resolved: wrote file content to system_prompts (hash=${fileHash.slice(0, 12)})`);
    } catch (e) {
      console.warn(`[soul-reconcile] failed to write DB row: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    // We don't write to the repo file from a running server — it would
    // dirty the working tree in production and could be clobbered on the next
    // deploy. Surface the gap so a human can run sync-soul.
    console.warn(
      `[janus] SOUL drift NOT auto-resolved (DB is newer than file). Run 'sync-soul' / commit the DB content to ${SOUL_FILE_RELATIVE} to converge.`,
    );
  }

  await auditFn("soul-reconcile", {
    category: "system",
    event_type: "soul_reconcile",
    severity: "warn",
    actor_id: "system",
    actor_name: "soul-reconcile",
    channel: "system",
    summary: `SOUL drift detected — winner=${winner}`,
    detail: {
      file_hash: fileHash,
      db_hash: dbHash,
      file_mtime: fileMtime.toISOString(),
      db_updated_at: dbRow.updated_at,
      winner,
      resolved_at: new Date().toISOString(),
      action: winner === "file" ? "db_row_updated_from_file" : "manual_sync_required",
    },
    status: "success",
  });

  return {
    status: winner === "file" ? "file_won" : "db_won",
    fileHash,
    dbHash,
    fileMtime: fileMtime.toISOString(),
    dbUpdatedAt: dbRow.updated_at,
  };
}
