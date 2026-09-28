/**
 * Club34 Ball — Calendar helpers
 *
 * Builds:
 *   - Google Calendar "Add to Calendar" template URL
 *   - RFC 5545 .ics string for Apple Calendar / Outlook
 *
 * Both use the stable game id as the UID so re-downloading doesn't
 * create duplicates — Apple Calendar deduplicates on UID.
 */

const BASE = process.env.PUBLIC_BASE_URL || 'https://example.com';
// Full street/city/state/zip so calendar apps geocode it correctly
// (taps for directions in Apple/Google Maps).
const LOCATION = process.env.BALL_LOCATION || 'Community Recreation Center, Court 1';
const TITLE = process.env.BALL_TITLE || 'Weekly Pickup Basketball';

export interface GameCalendarInput {
  gameId: string;
  gameDate: string;       // "2026-06-03"
  startTime: string;      // "18:00"
  endTime: string;        // "20:00"
  notes?: string | null;
  playerToken?: string;   // if present, links back to the personal RSVP page
}

/**
 * Formats a local date + time as ICS / Google Calendar compact datetime.
 * Returns YYYYMMDDTHHMMSS (no Z — timezone is provided separately).
 */
function compactLocal(dateIso: string, timeHHMM: string): string {
  const [y, m, d] = dateIso.split('-');
  const [hh, mm] = timeHHMM.split(':');
  return `${y}${m}${d}T${hh}${mm}00`;
}

/** DTSTAMP in UTC compact form */
function nowUtcCompact(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

/**
 * RFC 5545 §3.3.11 text escaping for TEXT-typed fields
 * (SUMMARY, DESCRIPTION, LOCATION). Order matters: backslash first.
 */
function icsEscapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Returns a prefilled Google Calendar URL that opens in a new tab and
 * lets the dad add the event to their own Google Calendar in one click.
 *
 * Uses `ctz` so Google converts from America/Los_Angeles to the user's tz.
 */
export function buildGoogleCalendarUrl(g: GameCalendarInput): string {
  const dtStart = compactLocal(g.gameDate, g.startTime);
  const dtEnd   = compactLocal(g.gameDate, g.endTime);
  const rsvpPage = g.playerToken ? `${BASE}/ball/p/${g.playerToken}` : `${BASE}/ball`;
  const descParts = [
    'Weekly Pickup Basketball.',
    g.notes ?? '',
    `RSVP page: ${rsvpPage}`,
  ].filter(Boolean);

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: TITLE,
    dates: `${dtStart}/${dtEnd}`,
    ctz: 'America/Los_Angeles',
    location: LOCATION,
    details: descParts.join('\n'),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Returns a valid RFC 5545 .ics string for Apple Calendar / Outlook.
 * UID is stable (derived from gameId) so re-downloading updates the same event.
 */
export function buildIcsString(g: GameCalendarInput): string {
  const dtStart  = compactLocal(g.gameDate, g.startTime);
  const dtEnd    = compactLocal(g.gameDate, g.endTime);
  const uid      = `ball-game-${g.gameId}@example.com`;
  const rsvpPage = g.playerToken ? `${BASE}/ball/p/${g.playerToken}` : `${BASE}/ball`;
  const descParts = [
    'Weekly Pickup Basketball.',
    g.notes ?? '',
    `RSVP page: ${rsvpPage}`,
  ].filter(Boolean);
  // RFC 5545 §3.3.11 escaping for all TEXT-typed fields.
  const description = icsEscapeText(descParts.join('\n'));
  const summary = icsEscapeText(TITLE);
  const location = icsEscapeText(LOCATION);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Club34//Ball//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${nowUtcCompact()}`,
    `DTSTART;TZID=America/Los_Angeles:${dtStart}`,
    `DTEND;TZID=America/Los_Angeles:${dtEnd}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location}`,
    `DESCRIPTION:${description}`,
    `URL:${rsvpPage}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return lines.join('\r\n');
}

/**
 * Convenience: returns the public ICS download URL for embedding in emails/UI.
 * The token authenticates the request (same as other /ball/p/:token routes).
 */
export function icsDownloadUrl(playerToken: string, gameId: string): string {
  return `${BASE}/api/ball/ics/${playerToken}/${gameId}`;
}
