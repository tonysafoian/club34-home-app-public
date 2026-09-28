/**
 * Computer Agent Token Auth
 *
 * Parallel auth path for the Perplexity Computer agent so it can drive
 * the Janus app via browser_task / Comet without hitting OAuth/login
 * walls. The agent sends an `X-Computer-Token` header; if it matches
 * the env-configured secret, the request is treated as an admin user.
 *
 * Wired into the middleware chain BEFORE requireAuth so the token path
 * can short-circuit normal auth checks. See server/index.ts for wiring.
 *
 * SETUP
 *   1. Generate a token:  openssl rand -base64 32
 *   2. Set COMPUTER_ADMIN_TOKEN in environment variables (.env)
 *   3. Redeploy. Look for the startup log line confirming token is configured.
 *
 * USAGE FROM COMET / browser_task
 *   - API-only: add header `X-Computer-Token: <token>` to every fetch
 *   - UI bootstrap: POST /api/auth/computer/session with that header to
 *     mint a normal auth_token cookie, then navigate the UI as admin
 *
 * Audit logging fires for every non-GET agent request.
 */

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { logAudit } from './auditLog.js';

const HEADER = 'x-computer-token';
const MIN_TOKEN_LENGTH = 24;

export function isComputerTokenValid(headerValue: string | undefined): boolean {
  const configured = process.env.COMPUTER_ADMIN_TOKEN?.trim();
  if (!configured || configured.length < MIN_TOKEN_LENGTH) return false;
  if (!headerValue || typeof headerValue !== 'string') return false;
  // Belt-and-suspenders: never accept token auth under NODE_ENV=test so
  // suites can't accidentally authenticate as admin
  if (process.env.NODE_ENV === 'test') return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(headerValue.trim());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Middleware — runs BEFORE requireAuth in the chain. If the header is
 * present and valid, synthesizes a system/admin user on req so any
 * downstream requireAuth/requireAdmin check passes. If missing or
 * invalid, falls through silently and normal auth runs.
 */
export function computerTokenMiddleware(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): void {
  const headerValue = req.header(HEADER);
  if (isComputerTokenValid(headerValue)) {
    req.userId = 'computer-agent';
    req.userRole = 'admin';
    (req as Request & { isComputerAgent?: boolean }).isComputerAgent = true;

    // Audit log non-GETs so we can trace what the agent did
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      // Fire and forget — never block the request on audit failure
      logAudit('computer-agent', {
        category: 'auth',
        event_type: 'computer_agent_request',
        severity: 'info',
        actor_id: 'computer-agent',
        actor_name: 'Computer (automation)',
        channel: 'http',
        summary: `Computer agent ${req.method} ${req.path}`,
        detail: { method: req.method, path: req.path },
        status: 'success',
      }).catch((err) => {
        console.error('[computer-token] audit log write failed:', err instanceof Error ? err.message : err);
      });
    }
  }
  next();
}

/**
 * Startup log — emits a single line at boot confirming the token is
 * configured. Never logs the token value; only its length.
 */
export function logComputerTokenStartup(): void {
  const t = process.env.COMPUTER_ADMIN_TOKEN?.trim();
  if (!t) {
    console.log('[computer-token] COMPUTER_ADMIN_TOKEN not set — agent token auth disabled.');
    return;
  }
  if (t.length < MIN_TOKEN_LENGTH) {
    console.warn(
      `[computer-token] COMPUTER_ADMIN_TOKEN is set but too short (${t.length} chars, min ${MIN_TOKEN_LENGTH}) — token auth disabled.`,
    );
    return;
  }
  console.log(`[computer-token] Computer agent admin token configured (length=${t.length}).`);
}
