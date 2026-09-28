import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { verifyToken } from '../auth.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  userRole?: string;
}

function validComputerToken(headerValue: unknown): boolean {
  const configured = process.env.COMPUTER_ADMIN_TOKEN?.trim();
  if (!configured || configured.length < 24) return false;
  if (typeof headerValue !== 'string' || !headerValue.trim()) return false;
  if (process.env.NODE_ENV === 'test') return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(headerValue.trim());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Defense-in-depth gate for the most destructive privileged endpoints
// (e.g. waiver revocation). Requires the X-Computer-Token header to
// match COMPUTER_ADMIN_TOKEN *in addition to* the normal admin auth
// chain. Stack this BEFORE requireAuth + requireAdmin on the route so
// even a hijacked admin OAuth session can't trigger the action without
// the machine-level token.
export function requireComputerToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if (!validComputerToken(req.headers['x-computer-token'])) {
    res.status(403).json({ error: 'computer_token_required' });
    return;
  }
  next();
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall = !!cronSecret && req.headers['x-cron-secret'] === cronSecret;

  if (isCronCall) {
    req.userId = 'system';
    req.userRole = 'admin';
    next();
    return;
  }

  // Computer Agent token — grant admin role when X-Computer-Token matches
  // COMPUTER_ADMIN_TOKEN. Lets the Perplexity Computer agent drive admin
  // routes without going through OAuth.
  if (validComputerToken(req.headers['x-computer-token'])) {
    req.userId = 'computer-agent';
    req.userRole = 'admin';
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const cookieToken = (req as { cookies?: Record<string, string> }).cookies?.auth_token;

  if (!authHeader?.startsWith('Bearer ') && !cookieToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = cookieToken || authHeader!.replace('Bearer ', '');

  const isServiceRole = (process.env.JWT_SECRET && token === process.env.JWT_SECRET) || (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET);

  if (isServiceRole) {
    req.userId = 'system';
    req.userRole = 'admin';
    next();
    return;
  }

  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  req.userId = user.userId;
  if (user.roles?.includes('admin')) {
    req.userRole = 'admin';
  } else if (user.roles?.includes('worker')) {
    req.userRole = 'worker';
  } else {
    req.userRole = 'member';
  }
  next();
}

// Blocks worker-role tokens from non-time-tracking routes.
// Mount this as global middleware AFTER /api/time/* is registered.
// Decodes the token itself — does NOT rely on req.userRole, which is only
// populated by route-level requireAuth (runs after this global middleware).
export function rejectWorkers(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  const cookieToken = (req as { cookies?: Record<string, string> }).cookies?.auth_token;
  const token = cookieToken || (authHeader?.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : null);

  if (!token) {
    next();
    return;
  }

  // Skip service-role shortcuts — they are admin by convention
  const isServiceRole = (process.env.JWT_SECRET && token === process.env.JWT_SECRET) ||
    (process.env.SESSION_SECRET && token === process.env.SESSION_SECRET);
  if (isServiceRole) {
    next();
    return;
  }

  const user = verifyToken(token);
  if (!user || !user.roles?.includes('worker')) {
    next();
    return;
  }

  // This is a worker token — only allow time/*, specific auth endpoints, and health
  const allowed =
    req.path.startsWith('/api/time/') ||
    req.path === '/api/auth/me' ||
    req.path === '/api/auth/logout' ||
    req.path === '/api/auth/google' ||
    req.path === '/api/auth/google/callback' ||
    req.path === '/api/health';
  if (!allowed) {
    res.status(403).json({ error: 'Worker accounts are restricted to /api/time/* endpoints' });
    return;
  }
  next();
}

// Like requireAuth, but rejects computer-token and cron-secret
// shortcuts. Use ONLY in combination with requireComputerToken when
// you need to enforce a true two-factor pattern on a destructive
// endpoint: human admin (Google OAuth JWT or session cookie) **plus**
// machine token. Neither alone is sufficient.
export function requireAuthStrictAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  const cookieToken = (req as { cookies?: Record<string, string> }).cookies?.auth_token;

  if (!authHeader?.startsWith('Bearer ') && !cookieToken) {
    res.status(401).json({ error: 'admin_session_required' });
    return;
  }

  const token = cookieToken || authHeader!.replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'admin_session_required' });
    return;
  }
  req.userId = user.userId;
  req.userRole = user.roles?.includes('admin') ? 'admin' : 'member';
  next();
}

export function optionalAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const cookieToken = (req as { cookies?: Record<string, string> }).cookies?.auth_token;
  const token = cookieToken || (authHeader?.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : null);

  if (token) {
    const user = verifyToken(token);
    if (user) {
      req.userId = user.userId;
      if (user.roles?.includes('admin')) {
        req.userRole = 'admin';
      } else if (user.roles?.includes('worker')) {
        req.userRole = 'worker';
      } else {
        req.userRole = 'member';
      }
    }
  }
  next();
}
