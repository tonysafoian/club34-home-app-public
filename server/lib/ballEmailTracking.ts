/**
 * Club34 Ball — email engagement tracking helper
 *
 * Wraps the email-send flow so every outbound message gets:
 *   1. A pre-send row in ball_email_sends with a unique sendId
 *   2. A tracking pixel injected into the HTML body
 *   3. Click-tracking wrappers around RSVP buttons + manage links
 *   4. Post-send status update (sent / send_error)
 *
 * Public surface:
 *   sendTrackedBallEmail({ playerId, gameId, template, to, subject, html, text })
 *     → returns { sendId, ok, error? }
 *
 * Pixel URL:   {PUBLIC_BASE_URL}/api/ball/track/open/{sendId}.gif
 * Click URL:   {PUBLIC_BASE_URL}/api/ball/track/click/{sendId}?to=<url>&l=<linkType>
 *
 * Linktype helps us answer "did Brian click In or Out?" without parsing URLs.
 *
 * Privacy: 'opened' is unreliable for Apple Mail (Mail Privacy Protection
 * pre-fetches images). Treat 'clicked' as the trustworthy signal.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { ballEmailSends, ballPlayers } from '../../shared/schema.js';
import { executeSendEmail } from '../utils/janus-tools.js';

const BASE = process.env.PUBLIC_BASE_URL || 'https://example.com';

export type BallEmailTemplate =
  | 'month-invite'
  | 'reconfirm'
  | 'decision-on'
  | 'decision-off'
  | 'reminder'
  | 'invite'  // legacy single-game invite
  | 'other';

export interface TrackedSendInput {
  playerId: string;
  gameId?: string | null;
  template: BallEmailTemplate;
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface TrackedSendResult {
  sendId: string;
  ok: boolean;
  error?: string;
}

/**
 * Build the tracking pixel URL for a given sendId.
 * Returns an <img> tag string ready to inject before </body>.
 */
export function trackingPixelTag(sendId: string): string {
  // Cache-bust by sendId only; never use timestamp (Apple Mail caches by URL)
  const url = `${BASE}/api/ball/track/open/${sendId}.gif`;
  return `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
}

/**
 * Wrap a destination URL with the click-tracker, so clicks go through us
 * before redirecting to the real URL.
 *
 * linkType is a short string we'll use in admin to see what was clicked
 * ('in', 'out', 'page', 'admin-change', etc).
 */
export function wrapClickUrl(sendId: string, destination: string, linkType: string): string {
  const params = new URLSearchParams({ to: destination, l: linkType });
  return `${BASE}/api/ball/track/click/${sendId}?${params.toString()}`;
}

/**
 * Rewrites all <a href="..."> tags in an HTML body to route through the
 * click-tracker. Skips:
 *   - mailto: links
 *   - the tracking pixel itself
 *   - any link containing 'no-track' in its href (escape hatch)
 *
 * Best-effort regex (we control the email templates so it's fine — emails
 * aren't user-generated HTML).
 */
export function rewriteLinksForTracking(html: string, sendId: string): string {
  // Match <a ... href="..."> capturing the href value
  return html.replace(/<a\s+([^>]*?)href="([^"]+)"([^>]*)>/gi, (match, before, href, after) => {
    if (href.startsWith('mailto:')) return match;
    if (href.includes('no-track')) return match;
    if (href.includes('/api/ball/track/')) return match;
    // Best-effort: derive linkType from the destination
    let linkType = 'link';
    if (href.includes('?r=in') || href.endsWith('&r=in')) linkType = 'in';
    else if (href.includes('?r=out') || href.endsWith('&r=out')) linkType = 'out';
    else if (href.match(/\/ball\/p\/[a-z0-9]+(?:\?|$)/)) linkType = 'page';
    const wrapped = wrapClickUrl(sendId, href, linkType);
    return `<a ${before}href="${wrapped}"${after}>`;
  });
}

/**
 * Resolve the Ball host's email. Every ball email is also sent to the host as
 * an untracked monitor copy so they see exactly what players receive.
 *
 * Resolution order:
 *   1. process.env.BALL_HOST_COPY_EMAIL — explicit override. Set it to an empty
 *      string to DISABLE monitor copies entirely without a code change.
 *   2. The active is_host player's email (cached for 10 minutes).
 */
let _hostEmailCache: { value: string | null; at: number } | null = null;
const HOST_EMAIL_TTL_MS = 10 * 60 * 1000;

async function getBallHostEmail(): Promise<string | null> {
  if (process.env.BALL_HOST_COPY_EMAIL !== undefined) {
    const override = process.env.BALL_HOST_COPY_EMAIL.trim();
    return override.length > 0 ? override : null;
  }
  const now = Date.now();
  if (_hostEmailCache && now - _hostEmailCache.at < HOST_EMAIL_TTL_MS) {
    return _hostEmailCache.value;
  }
  try {
    const [host] = await db
      .select({ email: ballPlayers.email })
      .from(ballPlayers)
      .where(and(eq(ballPlayers.isHost, true), eq(ballPlayers.active, true)))
      .limit(1);
    _hostEmailCache = { value: host?.email ?? null, at: now };
    return _hostEmailCache.value;
  } catch (e) {
    console.error('[ball-host-copy] host email lookup failed:', e instanceof Error ? e.message : e);
    return _hostEmailCache?.value ?? null;
  }
}

/**
 * The main entry point. Persists a row, sends the email, updates the row.
 * Returns the sendId so callers can log it / surface in audit entries.
 */
export async function sendTrackedBallEmail(input: TrackedSendInput): Promise<TrackedSendResult> {
  // 1. Persist a pre-send row so we have the ID for pixel/links
  const [row] = await db
    .insert(ballEmailSends)
    .values({
      playerId: input.playerId,
      gameId: input.gameId ?? null,
      template: input.template,
      toEmail: input.to,
      subject: input.subject,
    })
    .returning({ id: ballEmailSends.id });

  const sendId = row.id;

  // 2. Inject tracking pixel + rewrite click URLs
  let html = rewriteLinksForTracking(input.html, sendId);
  const pixel = trackingPixelTag(sendId);
  if (html.includes('</body>')) {
    html = html.replace('</body>', `${pixel}</body>`);
  } else {
    html = html + pixel;
  }

  // 3. Send via the existing Gmail-backed helper
  let ok = false;
  let errorMsg: string | undefined;
  try {
    const result = await executeSendEmail(
      input.to,
      input.subject,
      html,
      `ball-${input.template}`,
      `ball-${input.template}`,
    );
    if (result.toLowerCase().includes('error')) {
      errorMsg = result;
    } else {
      ok = true;
    }
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : String(e);
  }

  // 4. Update row with send status
  if (ok) {
    await db
      .update(ballEmailSends)
      .set({ sentAt: new Date() })
      .where(eq(ballEmailSends.id, sendId));
  } else {
    await db
      .update(ballEmailSends)
      .set({ sendError: errorMsg ?? 'unknown error', bouncedAt: new Date() })
      .where(eq(ballEmailSends.id, sendId));
  }

  // 5. Monitor copy → Ball host. Sent as a SEPARATE, UNTRACKED message using the
  //    ORIGINAL html (no tracking pixel, no click-rewrite) so the host's own
  //    opens/clicks never pollute the player's engagement data. Best-effort: a
  //    failure here must never affect the player's send result.
  try {
    const hostEmail = await getBallHostEmail();
    if (hostEmail && hostEmail.toLowerCase() !== input.to.toLowerCase()) {
      const banner =
        `<div style="background:#fff3cd;border:1px solid #ffe69c;color:#664d03;` +
        `padding:10px 14px;margin:0 0 16px;border-radius:6px;` +
        `font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">` +
        `<strong>Monitor copy</strong> — this is the exact email sent to <strong>${input.to}</strong>` +
        `${ok ? '' : ' <strong style="color:#b02a37;">(DELIVERY TO PLAYER FAILED)</strong>'}.<br>` +
        `Any RSVP buttons below act <strong>as this player</strong> — do not click them.` +
        `</div>`;
      const hostSubject = `[Ball copy → ${input.to}${ok ? '' : ' — SEND FAILED'}] ${input.subject}`;
      await executeSendEmail(
        hostEmail,
        hostSubject,
        banner + input.html,
        'ball-host-copy',
        'ball-host-copy',
      );
    }
  } catch (e) {
    console.error('[ball-host-copy] monitor copy failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return { sendId, ok, error: errorMsg };
}
