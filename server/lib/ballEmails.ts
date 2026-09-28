/**
 * Club34 Ball — Email templates
 *
 * Weekly Pickup Basketball at the Community Court.
 * Sender: Event Organizer via executeSendEmail
 * uses the Gmail service account).
 *
 * Templates:
 *   - invite        Monday 9am — "Wednesday Ball — who's in?"
 *   - decisionOn    Wed 11am — "Game is ON tonight 6pm"
 *   - decisionOff   Wed 11am — "Tonight's off, see you next week"
 *   - reminder      Wed 5:30pm — "Heading down in 30. See you at 6."
 *
 * Each template returns { subject, html, text }. The text version strips
 * tags; the HTML is intentionally simple inline styles only — works in
 * every email client including Apple Mail dark mode.
 */

import { buildGoogleCalendarUrl, icsDownloadUrl } from './ballCalendar.js';

const BASE = process.env.PUBLIC_BASE_URL || 'https://example.com';

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(iso: string): string {
  // iso = "2026-06-03".
  //
  // Defense-in-depth fix for the "shows Tuesday instead of Wednesday" bug.
  // The previous implementation did `new Date(y, m-1, d)`, which builds the
  // Date in the SERVER's local timezone. On a UTC server (Replit default
  // when TZ is unset) that gives midnight UTC → 5pm previous day PT,
  // which then rendered "Tuesday, June 2" for a 2026-06-03 game date.
  //
  // server/index.ts now pins process.env.TZ to America/Los_Angeles which
  // already fixes this, but we normalize via noon-UTC here so this helper
  // is correct even if TZ ever drifts (tests, scripts, future runtime).
  // Noon UTC = same calendar day in every timezone on earth.
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'America/Los_Angeles',
  });
}

function formatTime(hhmm: string): string {
  // "18:00" -> "6:00 PM". Falls back to the raw value if unparseable.
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

function htmlShell(headline: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0a0a0a;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:32px 16px;">
<tr><td align="center">
<table width="100%" style="max-width:480px;background:#141414;border-radius:16px;padding:32px;border:1px solid #262626;">
<tr><td>
<img src="${BASE}/ball/logo.jpg" alt="Club34 Ball" width="96" height="96" style="display:block;margin:0 auto 16px;border-radius:8px;" />
<h1 style="margin:0 0 8px;font-size:24px;font-weight:700;color:#fafafa;">${escape(headline)}</h1>
${body}
<p style="margin:32px 0 0;color:#737373;font-size:12px;line-height:1.5;">
Pickup Basketball · Community Recreation Center<br>
Hosted by Event Organizer. Reply to this email if anything's off.
</p>
</td></tr></table>
</td></tr></table></body></html>`;
}

function button(href: string, label: string, color = '#22c55e'): string {
  return `<a href="${href}" style="display:inline-block;padding:14px 28px;background:${color};color:#0a0a0a;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;margin:4px 0;">${escape(label)}</a>`;
}

function calendarLinksHtml(googleUrl: string, icsUrl: string): string {
  return `<div style="margin:20px 0 0;padding:14px 16px;background:#1a1a1a;border-radius:10px;border:1px solid #2a2a2a;">
    <p style="margin:0 0 8px;font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Add to calendar</p>
    <a href="${googleUrl}" style="display:inline-block;padding:8px 14px;background:#1a73e8;color:#fff;text-decoration:none;border-radius:7px;font-weight:600;font-size:13px;margin:2px 4px 2px 0;">Google Calendar</a>
    <a href="${icsUrl}" style="display:inline-block;padding:8px 14px;background:#3a3a3a;color:#fafafa;text-decoration:none;border-radius:7px;font-weight:600;font-size:13px;margin:2px 0;">Apple Calendar (.ics)</a>
  </div>`;
}

function calendarLinksText(googleUrl: string, icsUrl: string): string {
  return `Add to Google Calendar: ${googleUrl}\nApple Calendar (.ics):    ${icsUrl}`;
}

export interface BallEmailInput {
  playerName: string;
  playerToken: string;
  gameDateIso: string;
  gameStart: string; // "18:00"
  gameEnd: string;   // "20:00"
  notes?: string | null;
  confirmedCount?: number;
  minPlayers?: number;
  gameId?: string;
}

export interface UpcomingGameSummary {
  id: string;
  dateIso: string;
  startTime: string;   // "18:00"
  endTime: string;     // "20:00"
  notes?: string | null;
  confirmedCount: number;
  myStatus: 'in' | 'out' | 'maybe' | 'pending_reconfirm' | null;
}

export interface MonthInviteInput {
  playerName: string;
  playerToken: string;
  monthLabel: string;        // e.g. "June 2026"
  upcomingGames: UpcomingGameSummary[];
}

export function buildInviteEmail(i: BallEmailInput): { subject: string; html: string; text: string } {
  const dateLabel = formatDate(i.gameDateIso);
  const linkIn = `${BASE}/ball/p/${i.playerToken}?r=in`;
  const linkOut = `${BASE}/ball/p/${i.playerToken}?r=out`;
  const linkPage = `${BASE}/ball/p/${i.playerToken}`;
  const subject = `🏀 Wednesday Pickup Basketball — ${dateLabel}, 6–8pm`;
  const html = htmlShell(
    `Ball Wednesday, ${dateLabel.split(',')[1]?.trim() || dateLabel}`,
    `<p style="margin:0 0 16px;font-size:16px;color:#d4d4d4;">
      Hey ${escape(i.playerName.split(' ')[0])} — pickup runs at the half-court Wednesday <strong style="color:#fafafa;">6–8pm</strong>.
      Winners stay, rotation as more dads show. We need at least 6 to play.
    </p>
    <p style="margin:0 0 24px;font-size:16px;color:#d4d4d4;">You in?</p>
    <div style="margin:24px 0;">
      ${button(linkIn, "I'm in", '#22c55e')}
      &nbsp;
      ${button(linkOut, "Can't make it", '#404040')}
    </div>
    <p style="margin:24px 0 0;font-size:14px;color:#a3a3a3;">
      Or see who's in:&nbsp;<a href="${linkPage}" style="color:#60a5fa;">${linkPage}</a>
    </p>`
  );
  const text = `Hey ${i.playerName.split(' ')[0]} — Wednesday Night Pickup Basketball, ${dateLabel}, 6–8pm.

You in?

I'm in:        ${linkIn}
Can't make it: ${linkOut}

See who's in: ${linkPage}

— The Organizer`;
  return { subject, html, text };
}

export function buildDecisionOnEmail(i: BallEmailInput & { confirmedNames: string[]; gameId: string }): { subject: string; html: string; text: string } {
  const dateLabel = formatDate(i.gameDateIso);
  const linkPage = `${BASE}/ball/p/${i.playerToken}`;
  const subject = `🟢 Game ON tonight — Pickup Basketball, 6pm`;
  const googleUrl = buildGoogleCalendarUrl({
    gameId: i.gameId,
    gameDate: i.gameDateIso,
    startTime: i.gameStart,
    endTime: i.gameEnd,
    notes: i.notes,
    playerToken: i.playerToken,
  });
  const icsUrl = icsDownloadUrl(i.playerToken, i.gameId);
  const html = htmlShell(
    `Game is ON tonight`,
    `<p style="margin:0 0 16px;font-size:16px;color:#d4d4d4;">
      ${dateLabel}, <strong style="color:#fafafa;">6–8pm</strong>. We've got <strong style="color:#22c55e;">${i.confirmedNames.length} confirmed</strong>. Winners stay.
    </p>
    <p style="margin:0 0 8px;font-size:14px;color:#a3a3a3;">Playing tonight:</p>
    <p style="margin:0 0 24px;font-size:15px;color:#fafafa;line-height:1.7;">
      ${i.confirmedNames.map(escape).join(' · ')}
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#d4d4d4;">
      📍 Community Recreation Center<br>
      🕕 6:00 PM sharp<br>
      🥤 Water available courtside
    </p>
    ${calendarLinksHtml(googleUrl, icsUrl)}
    <p style="margin:24px 0 0;font-size:14px;color:#a3a3a3;">
      Plans change?&nbsp;<a href="${linkPage}" style="color:#60a5fa;">Update RSVP</a>
    </p>`
  );
  const text = `Game is ON tonight. ${dateLabel}, 6–8pm. ${i.confirmedNames.length} confirmed.

Playing: ${i.confirmedNames.join(', ')}

Community Recreation Center, 6pm sharp.

${calendarLinksText(googleUrl, icsUrl)}

Update RSVP: ${linkPage}

— The Organizer`;
  return { subject, html, text };
}

export function buildDecisionOffEmail(i: BallEmailInput): { subject: string; html: string; text: string } {
  const dateLabel = formatDate(i.gameDateIso);
  const subject = `🔴 Tonight's ball is off — see you next Wednesday`;
  const html = htmlShell(
    `Tonight's off`,
    `<p style="margin:0 0 16px;font-size:16px;color:#d4d4d4;">
      Didn't hit our minimum of 6 for ${dateLabel}. Pickup is cancelled for tonight.
    </p>
    <p style="margin:0 0 24px;font-size:16px;color:#d4d4d4;">
      See you next Wednesday. Stay loose.
    </p>`
  );
  const text = `Tonight's ball is off. Didn't hit the 6-player minimum for ${dateLabel}.

See you next Wednesday.

— The Organizer`;
  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────
// Month invite — listed all upcoming Wednesdays, one-tap per game
// ─────────────────────────────────────────────────────────────
export function buildMonthInviteEmail(i: MonthInviteInput): { subject: string; html: string; text: string } {
  const subject = `🏀 ${i.monthLabel} Pickup Basketball — pick your Wednesdays`;
  const linkPage = `${BASE}/ball/p/${i.playerToken}`;
  const rows = i.upcomingGames.map(g => {
    const dateLabel = formatDate(g.dateIso); // "Wednesday, June 3"
    const inLink = `${BASE}/ball/p/${i.playerToken}?g=${g.id}&r=in`;
    const outLink = `${BASE}/ball/p/${i.playerToken}?g=${g.id}&r=out`;
    const isIn = g.myStatus === 'in' || g.myStatus === 'pending_reconfirm';
    const calHtml = isIn ? calendarLinksHtml(
      buildGoogleCalendarUrl({ gameId: g.id, gameDate: g.dateIso, startTime: g.startTime, endTime: g.endTime, notes: g.notes, playerToken: i.playerToken }),
      icsDownloadUrl(i.playerToken, g.id),
    ) : '';
    const statusBadge = isIn
      ? `<div style="display:inline-block;margin-bottom:8px;padding:3px 10px;background:rgba(34,197,94,0.15);color:#22c55e;border-radius:6px;font-size:12px;font-weight:600;">✓ You're in</div>`
      : '';
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #262626;">
      <div style="font-size:16px;font-weight:600;color:#fafafa;margin-bottom:4px;">${escape(dateLabel)}</div>
      <div style="font-size:13px;color:#a3a3a3;margin-bottom:8px;">6–8pm · ${g.confirmedCount} in so far</div>
      ${statusBadge}
      <div>
        ${button(inLink, isIn ? "Still in ✓" : "I'm in", isIn ? '#166534' : '#22c55e')}
        &nbsp;
        ${button(outLink, "Can't make it", '#404040')}
      </div>
      ${calHtml}
    </td></tr>`;
  }).join('');

  const html = htmlShell(
    `${i.monthLabel} Pickup`,
    `<p style="margin:0 0 20px;font-size:16px;color:#d4d4d4;">
      Hey ${escape(i.playerName.split(' ')[0])} — running Wednesday night ball at Club34 all month.
      <strong style="color:#fafafa;">Half-court, 6–8pm, winners stay.</strong> Need 6 to play.
    </p>
    <p style="margin:0 0 16px;font-size:15px;color:#d4d4d4;">Tap the Wednesdays you can make. You can change anytime.</p>
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    <p style="margin:24px 0 0;font-size:13px;color:#737373;">
      You'll get a quick "still in?" check the morning of each game.<br>
      Manage all your RSVPs:&nbsp;<a href="${linkPage}" style="color:#60a5fa;">${linkPage}</a>
    </p>`
  );

  const text = `Hey ${i.playerName.split(' ')[0]} — Wednesday Night Pickup Basketball all ${i.monthLabel}.
Half-court, 6–8pm, winners stay. Need 6 to play.

Tap the Wednesdays you can make:

${i.upcomingGames.map(g => {
    const date = formatDate(g.dateIso);
    const isIn = g.myStatus === 'in' || g.myStatus === 'pending_reconfirm';
    const calText = isIn ? '\n  ' + calendarLinksText(
      buildGoogleCalendarUrl({ gameId: g.id, gameDate: g.dateIso, startTime: g.startTime, endTime: g.endTime, notes: g.notes, playerToken: i.playerToken }),
      icsDownloadUrl(i.playerToken, g.id),
    ).replace(/\n/g, '\n  ') : '';
    return `${date}\n  In:  ${BASE}/ball/p/${i.playerToken}?g=${g.id}&r=in\n  Out: ${BASE}/ball/p/${i.playerToken}?g=${g.id}&r=out${calText}`;
  }).join('\n\n')}

Manage RSVPs: ${linkPage}

— The Organizer`;

  return { subject, html, text };
}

// ─────────────────────────────────────────────────────────────
// Wednesday morning hard re-confirm — must click to stay IN
// ─────────────────────────────────────────────────────────────
export function buildReconfirmEmail(i: BallEmailInput & { gameId: string }): { subject: string; html: string; text: string } {
  const dateLabel = formatDate(i.gameDateIso);
  const linkIn = `${BASE}/ball/p/${i.playerToken}?g=${i.gameId}&r=in`;
  const linkOut = `${BASE}/ball/p/${i.playerToken}?g=${i.gameId}&r=out`;
  const subject = `🏀 Tonight — confirm you're still playing`;
  const googleUrl = buildGoogleCalendarUrl({
    gameId: i.gameId,
    gameDate: i.gameDateIso,
    startTime: i.gameStart,
    endTime: i.gameEnd,
    notes: i.notes,
    playerToken: i.playerToken,
  });
  const icsUrl = icsDownloadUrl(i.playerToken, i.gameId);
  const html = htmlShell(
    `Confirm tonight`,
    `<p style="margin:0 0 16px;font-size:16px;color:#d4d4d4;">
      Ball is tonight (${escape(dateLabel)}, 6–8pm). You said you were in.
    </p>
    <p style="margin:0 0 16px;font-size:16px;color:#fafafa;font-weight:600;">
      Tap to confirm — <span style="color:#eab308;">we drop your spot at 11am if we don't hear back.</span>
    </p>
    <div style="margin:24px 0;">
      ${button(linkIn, "Yes, I'm playing", '#22c55e')}
      &nbsp;
      ${button(linkOut, "Can't make it", '#404040')}
    </div>
    ${calendarLinksHtml(googleUrl, icsUrl)}
    <p style="margin:24px 0 0;font-size:13px;color:#737373;">
      This filter prevents no-shows and keeps the count honest. Decision goes out at 11am.
    </p>`
  );
  const text = `Ball is tonight (${dateLabel}, 6–8pm). You said you were in.

Confirm by 11am or we drop your spot.

Yes, I'm playing: ${linkIn}
Can't make it:   ${linkOut}

${calendarLinksText(googleUrl, icsUrl)}

— The Organizer`;
  return { subject, html, text };
}

export function buildReminderEmail(i: BallEmailInput): { subject: string; html: string; text: string } {
  const linkPage = `${BASE}/ball/p/${i.playerToken}`;
  const subject = `🏀 1 hour — see you at 6`;
  const html = htmlShell(
    `1 hour`,
    `<p style="margin:0 0 16px;font-size:16px;color:#d4d4d4;">
      Court is set. See you at 6pm sharp.
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#d4d4d4;">
      📍 Community Recreation Center<br>
      🕕 6:00 PM<br>
      🚗 Gate is auto-approved for you tonight
    </p>
    <p style="margin:24px 0 0;font-size:14px;color:#a3a3a3;">
      Plans changed?&nbsp;<a href="${linkPage}" style="color:#60a5fa;">Update RSVP</a>
    </p>`
  );
  const text = `1 hour — see you at 6.

Community Recreation Center. Gate approved tonight.

Update RSVP if plans changed: ${linkPage}

— The Organizer`;
  return { subject, html, text };
}

export interface GateRosterInput {
  gameDateIso: string;
  gameStart: string; // "18:00"
  gameEnd: string;   // "20:00"
  names: string[];   // confirmed guest names (host excluded)
}

/**
 * Gate access roster — sent to the household and BCC'd to the North
 * community gatehouse so security can admit confirmed guests. This is
 * a security-facing notice (not a player email), so it uses a clean,
 * light, professional layout rather than the dark player-facing shell and
 * carries no tracking pixels or RSVP links.
 */
export function buildGateRosterEmail(i: GateRosterInput): { subject: string; html: string; text: string } {
  const dateLabel = formatDate(i.gameDateIso);
  const timeLabel = `${formatTime(i.gameStart)} – ${formatTime(i.gameEnd)}`;
  const count = i.names.length;
  const subject = `Gate List — Club34 Ball, ${dateLabel} (${count} guest${count === 1 ? '' : 's'})`;

  const listHtml = count
    ? `<ol style="margin:0;padding-left:22px;color:#111827;font-size:15px;line-height:1.9;">${i.names
        .map(n => `<li>${escape(n)}</li>`)
        .join('')}</ol>`
    : `<p style="margin:0;color:#6b7280;font-size:15px;">No confirmed guests for this game.</p>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;color:#111827;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e4e7;">
<tr><td>
<h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#111827;">Gate Access List</h1>
<p style="margin:0 0 20px;font-size:14px;color:#52525b;">Community Recreation Center</p>
<table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;font-size:15px;color:#111827;">
  <tr><td style="padding:4px 0;color:#71717a;width:72px;">Event</td><td style="padding:4px 0;font-weight:600;">Club34 Wednesday Ball</td></tr>
  <tr><td style="padding:4px 0;color:#71717a;">Date</td><td style="padding:4px 0;font-weight:600;">${escape(dateLabel)}</td></tr>
  <tr><td style="padding:4px 0;color:#71717a;">Time</td><td style="padding:4px 0;font-weight:600;">${escape(timeLabel)}</td></tr>
</table>
<p style="margin:0 0 10px;font-size:12px;color:#71717a;text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Approved Guests (${count})</p>
${listHtml}
<p style="margin:24px 0 0;font-size:13px;color:#71717a;line-height:1.6;">Please admit the guests listed above for the event window. This list is generated automatically from confirmed RSVPs. Reply to this email with any questions.</p>
</td></tr></table>
</td></tr></table></body></html>`;

  const text = `Gate Access List — Community Recreation Center

Event: Club34 Wednesday Ball
Date:  ${dateLabel}
Time:  ${timeLabel}

Approved Guests (${count}):
${count ? i.names.map((n, idx) => `${idx + 1}. ${n}`).join('\n') : '(none)'}

Please admit the guests listed above for the event window. This list is
generated automatically from confirmed RSVPs.`;

  return { subject, html, text };
}
