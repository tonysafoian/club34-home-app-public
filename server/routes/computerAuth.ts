/**
 * Computer Agent — session bootstrap route
 *
 * POST /api/auth/computer/session
 *   Header: X-Computer-Token: <COMPUTER_ADMIN_TOKEN>
 *
 * Validates the token and mints a regular auth_token cookie. Lets the
 * Computer/Comet agent transition from "fetch with header" to
 * "navigate the UI normally" — cookies carry through to admin pages.
 *
 * Cookie is the same shape minted by /api/auth/google/callback, so all
 * existing route guards (requireAuth, ProtectedRoute) accept it.
 */

import { Router, type Request, type Response } from 'express';
import { generateToken, setAuthCookie } from '../auth.js';
import { isComputerTokenValid } from '../lib/computerToken.js';
import { logAudit } from '../lib/auditLog.js';

const router = Router();

router.post('/api/auth/computer/session', (req: Request, res: Response) => {
  const headerValue = req.header('x-computer-token');
  if (!isComputerTokenValid(headerValue)) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  const token = generateToken({
    userId: 'computer-agent',
    email: 'computer@example.com',
    displayName: 'Computer (automation)',
    avatarUrl: null,
    roles: ['admin'],
    approvalStatus: 'approved',
  });

  setAuthCookie(res, token);

  // Audit so we can see when sessions were minted
  logAudit('computer-agent', {
    category: 'auth',
    event_type: 'computer_session_minted',
    severity: 'info',
    actor_id: 'computer-agent',
    actor_name: 'Computer (automation)',
    channel: 'http',
    summary: 'Computer agent minted a session cookie',
    detail: { ua: req.header('user-agent')?.slice(0, 120) ?? null },
    status: 'success',
  }).catch((err) => {
    console.error('[computer-auth] audit log write failed:', err instanceof Error ? err.message : err);
  });

  res.json({
    ok: true,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
});

export default router;
