import type { Request, Response } from "express";
import { query } from "../lib/db.js";
import { logAudit } from "../lib/auditLog.js";
import {
  getAlertPhoneNumber,
  enqueueFailedJob,
} from "../utils/janus-tools.js";

/**
 * Proactive token-expiration warnings.
 *
 * Runs daily at 9:00 AM PT (wired in server/routes/cron.ts). Scans
 * tesla_tokens and google_tokens for rows whose token_expires_at is
 * within the next 24h, and WhatsApps the admin alert phone so Tony can
 * re-auth before the 401 storm hits.
 *
 * Dedup: token_expiry_alert_dedup row per (user_id, kind) is checked
 * against the last 24h to keep one alert per token per day.
 *
 * Logging: every alert (sent, skipped-dup, send-failed) gets an audit
 * row with event_type=token_expiry_warning and category=automation.
 *
 * Resilience: a WhatsApp send failure enqueues a failed_jobs row so the
 * existing retry worker picks it up. The handler never throws.
 */

interface ExpiringTokenRow {
  user_id: string;
  kind: "tesla" | "google";
  token_expires_at: string;
  google_email?: string | null;
}

interface AlertOutcome {
  user_id: string;
  kind: "tesla" | "google";
  status: "sent" | "skipped_duplicate" | "failed";
  expires_at: string;
  hours_to_expiry?: number;
  error?: string;
}

const DEDUP_WINDOW_HOURS = 24;
const LOOKAHEAD_HOURS = 24;
const APP_URL = process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : "https://example.com";

async function selectExpiringTokens(): Promise<ExpiringTokenRow[]> {
  const { rows } = await query(
    `SELECT user_id, 'tesla'::text AS kind, token_expires_at, NULL::text AS google_email
       FROM tesla_tokens
      WHERE token_expires_at IS NOT NULL
        AND token_expires_at > now()
        AND token_expires_at < now() + ($1 || ' hours')::interval
     UNION ALL
     SELECT user_id, 'google'::text AS kind, token_expires_at, google_email
       FROM google_tokens
      WHERE token_expires_at IS NOT NULL
        AND token_expires_at > now()
        AND token_expires_at < now() + ($1 || ' hours')::interval`,
    [String(LOOKAHEAD_HOURS)],
  );
  return rows.map((r) => ({
    user_id: String(r.user_id),
    kind: (r.kind === "tesla" ? "tesla" : "google") as "tesla" | "google",
    token_expires_at: r.token_expires_at instanceof Date
      ? r.token_expires_at.toISOString()
      : String(r.token_expires_at),
    google_email: r.google_email ? String(r.google_email) : null,
  }));
}

async function isDeduped(userId: string, kind: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT id FROM token_expiry_alert_dedup
      WHERE user_id = $1 AND kind = $2
        AND alerted_at > now() - ($3 || ' hours')::interval
      LIMIT 1`,
    [userId, kind, String(DEDUP_WINDOW_HOURS)],
  );
  return rows.length > 0;
}

async function recordAlert(userId: string, kind: string, expiresAt: string): Promise<void> {
  await query(
    `INSERT INTO token_expiry_alert_dedup (user_id, kind, expires_at) VALUES ($1, $2, $3)`,
    [userId, kind, expiresAt],
  );
}

function hoursUntil(iso: string): number {
  return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 36e5));
}

function buildMessage(row: ExpiringTokenRow): string {
  const target = row.google_email || row.user_id;
  const hours = hoursUntil(row.token_expires_at);
  return `⚠️ Janus: ${row.kind} token for ${target} expires in ${hours}h (${row.token_expires_at}). Re-auth at ${APP_URL}/settings → integrations.`;
}

async function sendWhatsAppAlert(to: string, message: string): Promise<void> {
  const baseUrl = `http://localhost:${process.env.PORT || 5000}`;
  const res = await fetch(`${baseUrl}/api/janus/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "send", to, message }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WhatsApp send ${res.status}: ${body.slice(0, 200)}`);
  }
}

export interface HandlerDeps {
  selectTokens?: typeof selectExpiringTokens;
  isDeduped?: typeof isDeduped;
  recordAlert?: typeof recordAlert;
  sendAlert?: (to: string, message: string) => Promise<void>;
  getAlertPhone?: () => Promise<string>;
  audit?: typeof logAudit;
  enqueue?: typeof enqueueFailedJob;
}

/**
 * Pure-ish worker that can be unit-tested via dependency injection.
 * Returns the per-row outcomes so tests can assert behavior.
 */
export async function runTokenExpirationWarnings(
  deps: HandlerDeps = {},
): Promise<{ outcomes: AlertOutcome[]; alert_phone?: string }> {
  const _select = deps.selectTokens ?? selectExpiringTokens;
  const _isDeduped = deps.isDeduped ?? isDeduped;
  const _record = deps.recordAlert ?? recordAlert;
  const _send = deps.sendAlert ?? sendWhatsAppAlert;
  const _phone = deps.getAlertPhone ?? getAlertPhoneNumber;
  const _audit = deps.audit ?? logAudit;
  const _enqueue = deps.enqueue ?? enqueueFailedJob;

  const expiring = await _select();
  if (expiring.length === 0) {
    console.log("[token-expiration-warnings] no tokens expiring within 24h");
    return { outcomes: [] };
  }

  let alertPhone: string;
  try {
    alertPhone = await _phone();
  } catch (e) {
    console.warn(
      `[token-expiration-warnings] could not resolve alert phone: ${e instanceof Error ? e.message : String(e)}; skipping all sends`,
    );
    return {
      outcomes: expiring.map((r) => ({
        user_id: r.user_id,
        kind: r.kind,
        status: "failed" as const,
        expires_at: r.token_expires_at,
        error: "alert phone unresolved",
      })),
    };
  }

  const outcomes: AlertOutcome[] = [];

  for (const row of expiring) {
    const hours_to_expiry = hoursUntil(row.token_expires_at);
    try {
      if (await _isDeduped(row.user_id, row.kind)) {
        outcomes.push({
          user_id: row.user_id,
          kind: row.kind,
          status: "skipped_duplicate",
          expires_at: row.token_expires_at,
          hours_to_expiry,
        });
        await _audit("token-expiration-warnings", {
          category: "automation",
          event_type: "token_expiry_warning",
          severity: "info",
          actor_id: "system",
          actor_name: "token-expiration-warnings",
          channel: "cron",
          summary: `Skipped duplicate ${row.kind} token-expiry warning for ${row.user_id}`,
          detail: { user_id: row.user_id, kind: row.kind, expires_at: row.token_expires_at, hours_to_expiry, deduped: true },
          status: "success",
        });
        continue;
      }

      const message = buildMessage(row);
      await _send(alertPhone, message);
      await _record(row.user_id, row.kind, row.token_expires_at);

      outcomes.push({
        user_id: row.user_id,
        kind: row.kind,
        status: "sent",
        expires_at: row.token_expires_at,
        hours_to_expiry,
      });
      await _audit("token-expiration-warnings", {
        category: "automation",
        event_type: "token_expiry_warning",
        severity: "warn",
        actor_id: "system",
        actor_name: "token-expiration-warnings",
        channel: "cron",
        actionable: true,
        summary: `${row.kind} token for ${row.google_email || row.user_id} expires in ${hours_to_expiry}h`,
        detail: { user_id: row.user_id, kind: row.kind, expires_at: row.token_expires_at, hours_to_expiry, alert_phone: alertPhone },
        status: "success",
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      outcomes.push({
        user_id: row.user_id,
        kind: row.kind,
        status: "failed",
        expires_at: row.token_expires_at,
        hours_to_expiry,
        error,
      });
      await _audit("token-expiration-warnings", {
        category: "automation",
        event_type: "token_expiry_warning",
        severity: "error",
        actor_id: "system",
        actor_name: "token-expiration-warnings",
        channel: "cron",
        actionable: true,
        summary: `Failed to send ${row.kind} token-expiry warning for ${row.user_id}`,
        detail: { user_id: row.user_id, kind: row.kind, expires_at: row.token_expires_at, hours_to_expiry, error },
        status: "error",
      });
      await _enqueue("janus/token-expiration-warnings", e, {
        user_id: row.user_id,
        kind: row.kind,
        token_expires_at: row.token_expires_at,
      });
    }
  }

  console.log(
    `[token-expiration-warnings] processed ${outcomes.length} row(s) — sent=${outcomes.filter((o) => o.status === "sent").length} skipped=${outcomes.filter((o) => o.status === "skipped_duplicate").length} failed=${outcomes.filter((o) => o.status === "failed").length}`,
  );

  return { outcomes, alert_phone: alertPhone };
}

/** Express handler — thin wrapper around runTokenExpirationWarnings. */
export async function handleTokenExpirationWarnings(_req: Request, res: Response): Promise<void> {
  try {
    const result = await runTokenExpirationWarnings();
    res.json({ ok: true, processed: result.outcomes.length, outcomes: result.outcomes });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[token-expiration-warnings] handler error:", error);
    res.status(500).json({ ok: false, error });
  }
}
