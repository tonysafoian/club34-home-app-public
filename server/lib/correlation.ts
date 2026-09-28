/**
 * Correlation IDs end-to-end.
 *
 * Each inbound request (HTTP, WhatsApp ingress, Gmail poll, cron) gets
 * a stable id — either the inbound X-Correlation-Id header or a fresh
 * uuid v4. The id rides in an AsyncLocalStorage context for the
 * lifetime of the request so deeply nested helpers (audit log, failed
 * job enqueue, chat log insert) can stamp it without prop-drilling.
 *
 * Background: this file used to be a single one-liner that read the
 * header off `req`. Now it also provides:
 *   - runWithCorrelation(id, fn)           — sets the context
 *   - getCurrentCorrelationId()            — reads it (returns "" outside ctx)
 *   - withCorrelation(fn)                  — convenience wrapper for cron / one-shots
 *   - correlationMiddleware                — Express middleware that reads
 *                                             the inbound header, stores
 *                                             it on req + in ALS, echoes
 *                                             it on the response, and
 *                                             passes control downstream.
 *
 * The classic `getCorrelationId(req)` overload is preserved for the
 * legacy callers (server/routes/tesla.ts) so this PR doesn't have to
 * touch every prior usage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

interface CorrelationContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const CORRELATION_HEADER = "x-correlation-id";

/** Generate a fresh correlation id. uuid v4 — stable, sortable enough, no deps. */
export function generateCorrelationId(): string {
  return randomUUID();
}

/**
 * Read the AsyncLocalStorage-bound correlation id for the current
 * request, or "" if we're not inside a correlation context (e.g.,
 * scheduled tasks that haven't been wrapped yet). Callers should
 * treat the empty string as "no correlation id — write NULL".
 */
export function getCurrentCorrelationId(): string {
  return storage.getStore()?.correlationId ?? "";
}

/**
 * Run `fn` with `id` bound as the current correlation context. Any
 * async work spawned inside inherits the id without further plumbing.
 * Returns whatever `fn` returns.
 */
export function runWithCorrelation<T>(id: string, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run({ correlationId: id }, fn);
}

/**
 * Sugar for cron jobs / one-shot ingress handlers that want to start a
 * fresh context. Generates a new id, runs `fn`, and returns both the
 * id and the result so the caller can echo the id in their response /
 * logs.
 */
export async function withCorrelation<T>(fn: () => T | Promise<T>): Promise<{ id: string; result: T }> {
  const id = generateCorrelationId();
  const result = await runWithCorrelation(id, fn);
  return { id, result: result as T };
}

// --- Express integration ---------------------------------------------

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      correlationId?: string;
    }
  }
}

/**
 * Express middleware. Reads the inbound X-Correlation-Id header (case
 * insensitive — Express normalizes), generates one if absent, attaches
 * to req.correlationId, echoes on the response header, and runs the
 * rest of the chain inside the ALS context so downstream helpers can
 * read it via getCurrentCorrelationId().
 *
 * Apply once, globally, BEFORE all route handlers.
 */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = (Array.isArray(incoming) ? incoming[0] : incoming) || generateCorrelationId();
  req.correlationId = id;
  res.setHeader("X-Correlation-Id", id);
  storage.run({ correlationId: id }, () => next());
}

/**
 * Legacy overload — preserved for server/routes/tesla.ts and any other
 * spot that already reads the header off `req` directly. New code
 * should use req.correlationId (set by the middleware) or
 * getCurrentCorrelationId().
 */
export function getCorrelationId(req: Request): string {
  return req.correlationId
    || (req.headers[CORRELATION_HEADER] as string)
    || generateCorrelationId();
}
