import { query } from './db.js';
import { getCurrentCorrelationId } from './correlation.js';

/**
 * Audit log writer.
 * Persists structured system audit records to the primary PostgreSQL database (`DATABASE_URL`).
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
