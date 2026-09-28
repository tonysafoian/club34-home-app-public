/**
 * Club34 Ball — email tracking endpoints (open pixel + click redirect)
 *
 * Public, no auth required (these are hit by email clients).
 *
 * GET /api/ball/track/open/:sendId.gif
 *   Returns a 1x1 transparent GIF and stamps openedAt / increments openCount.
 *   Always returns 200 with the GIF, even if sendId is bogus, to avoid
 *   leaking which IDs are valid.
 *
 * GET /api/ball/track/click/:sendId?to=<url>&l=<linkType>
 *   Stamps firstClickedAt / lastClickLink, increments clickCount, then
 *   302s to the real destination. Validates the destination is on our
 *   own domain to prevent open-redirect abuse.
 *
 *   If linkType is 'in' / 'out' / 'maybe' and the send row has both a
 *   player_id and a non-null game_id, the click itself auto-records an
 *   RSVP via recordRsvp() with source='email-click'. The redirect always
 *   fires regardless of the RSVP outcome (success, skip, or error) so the
 *   dad always lands on the player page.
 */

import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import { ballEmailSends } from '../../shared/schema.js';
import { recordRsvp } from '../lib/ballRsvpHelper.js';
import { logAudit } from '../lib/auditLog.js';

const router = Router();

// 43-byte transparent 1x1 GIF (smallest valid GIF89a)
const GIF_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const ALLOWED_REDIRECT_HOSTS = new Set([
  'example.com',
  'www.example.com',
  'club34.replit.app',
]);

const RSVP_LINK_TYPES = new Set(['in', 'out', 'maybe']);

function safeUserAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  return ua.slice(0, 200);
}

interface IpRequest {
  header?: (name: string) => string | undefined;
  ip?: string;
  socket?: { remoteAddress?: string };
}

function clientIp(req: IpRequest): string | null {
  const fwd = req.header?.('x-forwarded-for');
  if (fwd && typeof fwd === 'string') return fwd.split(',')[0].trim().slice(0, 64);
  return (req.ip || req.socket?.remoteAddress || null)?.slice(0, 64) ?? null;
}

// ── Open pixel ────────────────────────────────────────────────────────

router.get('/api/ball/track/open/:filename', async (req, res) => {
  // sendId is in the filename like "abc123.gif"
  const filename = String(req.params.filename || '');
  const sendId = filename.replace(/\.gif$/i, '');

  // Always serve the GIF regardless of validity
  res.set({
    'Content-Type': 'image/gif',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.status(200).end(GIF_PIXEL);

  // UUID format check before touching DB
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sendId)) {
    return;
  }

  try {
    const ua = safeUserAgent(req.header('user-agent'));
    const ip = clientIp(req);
    // Atomic update — only set first-open timestamp if null
    await db.execute(sql`
      UPDATE ball_email_sends
      SET
        opened_at = COALESCE(opened_at, NOW()),
        open_count = open_count + 1,
        user_agent_first_open = COALESCE(user_agent_first_open, ${ua}),
        ip_first_open = COALESCE(ip_first_open, ${ip})
      WHERE id = ${sendId}
    `);
  } catch (e) {
    console.error('[ball-track/open] DB update failed:', e instanceof Error ? e.message : e);
  }
});

// ── Click redirect ────────────────────────────────────────────────────

router.get('/api/ball/track/click/:sendId', async (req, res) => {
  const sendId = String(req.params.sendId || '');
  const to = String(req.query.to || '');
  const linkType = String(req.query.l || 'link').slice(0, 32);

  // Validate destination — must be one of our own hosts
  let destination: URL | null = null;
  try {
    destination = new URL(to);
  } catch {
    res.status(400).send('Invalid destination');
    return;
  }
  if (!ALLOWED_REDIRECT_HOSTS.has(destination.host)) {
    console.warn(`[ball-track/click] refused redirect to ${destination.host}`);
    res.status(400).send('Invalid destination');
    return;
  }

  const isValidUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sendId);

  // Stamp the click AND, if it's an RSVP link, auto-record the RSVP.
  // Best-effort — never block the redirect on any error.
  if (isValidUuid) {
    try {
      const ua = safeUserAgent(req.header('user-agent'));

      // Stamp the click and fetch the send row in one round-trip via RETURNING.
      // drizzle's .update().returning() is fully typed — no raw SQL needed.
      const updatedRows = await db
        .update(ballEmailSends)
        .set({
          firstClickedAt: sql`COALESCE(first_clicked_at, NOW())`,
          clickCount: sql`click_count + 1`,
          lastClickLink: linkType,
          userAgentFirstClick: sql`COALESCE(user_agent_first_click, ${ua})`,
        })
        .where(eq(ballEmailSends.id, sendId))
        .returning({
          id: ballEmailSends.id,
          playerId: ballEmailSends.playerId,
          gameId: ballEmailSends.gameId,
        });

      // Auto-RSVP: only for in/out/maybe links that have both player + game
      if (RSVP_LINK_TYPES.has(linkType)) {
        const row = updatedRows[0];
        const playerId: string | null = row?.playerId ?? null;
        const gameId: string | null = row?.gameId ?? null;

        if (playerId && gameId) {
          try {
            const result = await recordRsvp({
              playerId,
              gameId,
              status: linkType as 'in' | 'out' | 'maybe',
              source: 'email-click',
              allowOverwrite: true,
            });

            logAudit('ball-email-click', {
              category: 'ball',
              event_type: result.outcome === 'recorded' ? 'rsvp_auto_recorded' : `rsvp_auto_${result.outcome}`,
              severity: 'info',
              actor_id: playerId,
              channel: 'email-click',
              summary: result.outcome === 'recorded'
                ? `Auto-RSVP ${linkType.toUpperCase()} recorded from email click (sendId: ${sendId})`
                : `Auto-RSVP skipped (${result.outcome}) from email click (sendId: ${sendId})`,
              detail: { sendId, playerId, gameId, status: linkType, outcome: result.outcome, source: 'email-click' },
              status: result.outcome === 'recorded' ? 'success' : 'skipped',
            }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
          } catch (rsvpErr) {
            console.error('[ball-track/click] auto-RSVP failed (non-blocking):', rsvpErr instanceof Error ? rsvpErr.message : rsvpErr);
            logAudit('ball-email-click', {
              category: 'ball',
              event_type: 'rsvp_auto_error',
              severity: 'warn',
              actor_id: playerId,
              channel: 'email-click',
              summary: `Auto-RSVP error from email click (sendId: ${sendId}): ${rsvpErr instanceof Error ? rsvpErr.message : String(rsvpErr)}`,
              detail: { sendId, playerId, gameId, status: linkType, error: rsvpErr instanceof Error ? rsvpErr.message : String(rsvpErr) },
              status: 'error',
            }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
          }
        }
      }
    } catch (e) {
      console.error('[ball-track/click] DB update failed:', e instanceof Error ? e.message : e);
    }
  }

  res.redirect(302, destination.toString());
});

export default router;
