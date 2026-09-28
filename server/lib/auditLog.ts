import { query } from './db.js';
import { getCurrentCorrelationId } from './correlation.js';

/**
 * Audit log writer.
 *
 * Historical context (2026-05-17): an earlier version of this module had a
 * dual-DB write path that tried PROD_DATABASE_URL (a separate Supabase-hosted
 * Postgres) first and fell back to the local Replit DB on failure. That was
 * introduced in March 2026 (commit b17d318, "Fix audit logs disappearing on
 * deploy") to make audit logs durable across Replit redeploys.
 *
 * That Supabase project was deleted at some point during the Express
 * migration. PROD_DATABASE_URL has been unset since at least 2026-05-17,
 * which made the prod-write branch a silent no-op. The code path is removed
 * here. Replit's autoscale Postgres (DATABASE_URL) is now the single source
 * of truth — and it IS durable across redeploys, contrary to the assumption
 * in commit b17d318.
 *
 * If we ever introduce a separate write-durable DB again, restore the
 * fallback pattern from b17d318 (look in git history).
 */
export async function logAudit(edgeFunction: string, entry: Record<string, unknown>): Promise<void> {
  // Auto-stamp the AsyncLocalStorage-bound correlation id when the
  // caller didn't supply one explicitly. Explicit values still win.
  const merged: Record<string, unknown> = { ...entry };
  if (!('correlation_id' in merged)) {
    const id = getCurrentCorrelationId();
    if (id) merged.correlation_id = id;
  }
  const keys = ['edge_function', ...Object.keys(merged)];
  const values = [edgeFunction, ...Object.values(merged).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v)];
  const ph = keys.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO system_audit_log (${keys.join(', ')}) VALUES (${ph.join(', ')})`;

  try {
    await query(sql, values);
  } catch (e) {
    console.error('[auditLog] Audit log failed:', e);
  }
}
