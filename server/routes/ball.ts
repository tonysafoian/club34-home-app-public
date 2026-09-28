/**
 * Club34 Ball — Wednesday Night Pickup Basketball
 *
 * Public endpoints (no auth, token-based):
 *   GET  /api/ball/state                — landing-page payload (next game + counts)
 *   GET  /api/ball/me/:token            — player identity + their RSVP for next game
 *   POST /api/ball/rsvp                 — { token, gameId, status }  (in | out | maybe)
 *
 * Admin endpoints (requireAuth + admin role):
 *   GET    /api/ball/admin/overview     — all upcoming games + RSVP rollups
 *   GET    /api/ball/admin/game/:id     — full RSVP detail for one game
 *   POST   /api/ball/admin/game/:id/force-status   — { status: 'on' | 'off' | 'scheduled' }
 *   POST   /api/ball/admin/game/:id/attendance     — { playerId, showedUp }
 *   POST   /api/ball/admin/game/:id/send-invite    — manual blast
 *   POST   /api/ball/admin/game/:id/email-gate     — email confirmed roster to gatehouse (BCC)
 *   POST   /api/ball/admin/players                 — add player
 *   PATCH  /api/ball/admin/players/:id             — edit player
 *   DELETE /api/ball/admin/players/:id             — deactivate player
 *
 * Cron endpoints (CRON_SECRET via requireAuth):
 *   POST /api/ball/cron/send-invites    — Monday 9am PT — blast invites for next game
 *   POST /api/ball/cron/decide          — Wed 11am PT — game ON if >=min, OFF otherwise
 *   POST /api/ball/cron/email-gate      — Wed 12pm PT — email confirmed roster to gatehouse (BCC)
 *   POST /api/ball/cron/remind          — Wed 5:30pm PT — final reminder to confirmed
 */

import { Router, type Response } from 'express';
import { eq, and, gte, lt, sql, inArray, isNull, isNotNull, or, desc } from 'drizzle-orm';
import { db } from '../db.js';
import {
  ballPlayers,
  ballGames,
  ballRsvps,
  ballWaivers,
  ballEmailSends,
  systemConfigs,
  type BallPlayer,
  type BallGame,
} from '../../shared/schema';
import { WAIVER_VERSION, getActiveWaiverText, WAIVER_V1_HASH } from '../lib/waiverText.js';
import { requireAuth, requireComputerToken, requireAuthStrictAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLog.js';
import { sendTrackedBallEmail } from '../lib/ballEmailTracking.js';
import { recordRsvp } from '../lib/ballRsvpHelper.js';
import {
  buildInviteEmail,
  buildDecisionOnEmail,
  buildDecisionOffEmail,
  buildReminderEmail,
  buildMonthInviteEmail,
  buildReconfirmEmail,
  buildGateRosterEmail,
  type UpcomingGameSummary,
} from '../lib/ballEmails.js';
import { buildIcsString } from '../lib/ballCalendar.js';

const router = Router();

function requireAdmin(req: AuthenticatedRequest, res: Response, next: () => void): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function todayIsoPT(): string {
  // ISO date in America/Los_Angeles. The simplest correct way is to
  // ask Intl for the parts and reassemble.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

// Returns the player's currently-active waiver row for WAIVER_VERSION,
// or null if they haven't signed yet (or have revoked). Used both to
// gate POST /api/ball/rsvp and to surface waiver state on /me/:token
// so the UI knows whether to show the modal.
async function getActiveWaiver(playerId: string) {
  const [row] = await db
    .select()
    .from(ballWaivers)
    .where(and(
      eq(ballWaivers.playerId, playerId),
      eq(ballWaivers.waiverVersion, WAIVER_VERSION),
      sql`${ballWaivers.revokedAt} IS NULL`,
    ))
    .limit(1);
  return row ?? null;
}

async function getNextScheduledGame(): Promise<BallGame | null> {
  const today = todayIsoPT();
  const rows = await db
    .select()
    .from(ballGames)
    .where(and(gte(ballGames.gameDate, today), sql`${ballGames.status} IN ('scheduled','on')`))
    .orderBy(ballGames.gameDate)
    .limit(1);
  return rows[0] ?? null;
}

async function getGameWithRsvps(gameId: string) {
  const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
  if (!game) return null;

  const rsvpsWithPlayers = await db
    .select({
      rsvpId: ballRsvps.id,
      status: ballRsvps.status,
      respondedAt: ballRsvps.respondedAt,
      showedUp: ballRsvps.showedUp,
      goaccessRegisteredAt: ballRsvps.goaccessRegisteredAt,
      playerId: ballPlayers.id,
      name: ballPlayers.name,
      email: ballPlayers.email,
      isHost: ballPlayers.isHost,
    })
    .from(ballRsvps)
    .innerJoin(ballPlayers, eq(ballRsvps.playerId, ballPlayers.id))
    .where(eq(ballRsvps.gameId, gameId));

  // Host is implicitly IN — surface even if no RSVP row exists yet
  const [host] = await db
    .select()
    .from(ballPlayers)
    .where(and(eq(ballPlayers.isHost, true), eq(ballPlayers.active, true)))
    .limit(1);

  let confirmed = rsvpsWithPlayers.filter(r => r.status === 'in');
  if (host && !confirmed.find(c => c.playerId === host.id)) {
    confirmed = [
      {
        rsvpId: 'host-implicit',
        status: 'in',
        respondedAt: game.createdAt,
        showedUp: null,
        goaccessRegisteredAt: null,
        playerId: host.id,
        name: host.name,
        email: host.email,
        isHost: true,
      },
      ...confirmed,
    ];
  }
  const declined = rsvpsWithPlayers.filter(r => r.status === 'out');
  const maybe = rsvpsWithPlayers.filter(r => r.status === 'maybe');

  // Decorate every player row with their active waiver signedAt (or null).
  // Used by the admin UI to surface a "signed/unsigned" badge per row.
  const allPlayerIds = Array.from(new Set([
    ...rsvpsWithPlayers.map(r => r.playerId),
    ...(host ? [host.id] : []),
  ]));
  const waiverRows = allPlayerIds.length
    ? await db
        .select({ playerId: ballWaivers.playerId, signedAt: ballWaivers.signedAt })
        .from(ballWaivers)
        .where(and(
          inArray(ballWaivers.playerId, allPlayerIds),
          eq(ballWaivers.waiverVersion, WAIVER_VERSION),
          sql`${ballWaivers.revokedAt} IS NULL`,
        ))
    : [];
  const waiverByPlayer = new Map(waiverRows.map(w => [w.playerId, w.signedAt]));
  const decorate = <T extends { playerId: string }>(r: T) => ({
    ...r,
    waiverSignedAt: waiverByPlayer.get(r.playerId) ?? null,
  });

  return {
    game,
    confirmed: confirmed.map(decorate),
    declined: declined.map(decorate),
    maybe: maybe.map(decorate),
    all: rsvpsWithPlayers,
    host,
  };
}

// ─────────────────────────────────────────────────────────────
// Gate roster email — replaces the old GoAccess auto-sync. Emails the
// confirmed guest list (host excluded) for a game to the household (To)
// and BCCs the community gatehouse so security can admit guests.
// Sent ~6 hours before each game (noon for the standard 6pm start), after
// the ON/OFF decision is finalized.
// ─────────────────────────────────────────────────────────────
const GATE_ADMIN_EMAIL = 'gate-security@example.com';

async function sendGateRosterEmail(gameId: string): Promise<{
  ok: boolean;
  guests: string[];
  bcc: string;
  error?: string;
}> {
  const detail = await getGameWithRsvps(gameId);
  if (!detail) {
    return { ok: false, guests: [], bcc: GATE_ADMIN_EMAIL, error: 'game lookup failed' };
  }

  // Confirmed guests = everyone RSVP'd "in" except the host (the host lives
  // at the address and needs no gate clearance). Matches the old gate sync.
  const guests = detail.confirmed
    .filter(c => !c.isHost)
    .map(c => c.name)
    .sort((a, b) => a.localeCompare(b));

  const tmpl = buildGateRosterEmail({
    gameDateIso: detail.game.gameDate,
    gameStart: detail.game.startTime,
    gameEnd: detail.game.endTime,
    names: guests,
  });

  let ok = false;
  let error: string | undefined;
  try {
    const { sendGmailRaw, getSaKey, TONY_EMAIL } = await import('../lib/helpers.js');
    ok = await sendGmailRaw(
      getSaKey(),
      TONY_EMAIL,
      tmpl.subject,
      tmpl.html,
      tmpl.text,
      undefined,
      GATE_ADMIN_EMAIL,
    );
    if (!ok) error = 'gmail send failed';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error('[ball/gate-roster] send failed:', error);
  }

  logAudit('ball-gate-roster', {
    category: 'ball',
    event_type: 'gate_roster_emailed',
    severity: ok ? 'info' : 'error',
    actor_id: 'system',
    actor_name: 'BallCron',
    channel: 'cron',
    summary: `Gate roster for ${detail.game.gameDate}: ${guests.length} guest(s) BCC'd to ${GATE_ADMIN_EMAIL}`,
    detail: { gameDate: detail.game.gameDate, guestCount: guests.length, guests, bcc: GATE_ADMIN_EMAIL, error },
    status: ok ? 'success' : 'error',
  });

  return { ok, guests, bcc: GATE_ADMIN_EMAIL, error };
}

function statusBanner(confirmedCount: number, minPlayers: number): string {
  if (confirmedCount >= 8) return `🔥 Stacked night — ${confirmedCount} in, 4v4 + rotation`;
  if (confirmedCount >= 6) return `🟢 Game is ON — ${confirmedCount} in, 3v3 winners stay`;
  if (confirmedCount >= minPlayers) return `🟢 Game is ON — ${confirmedCount} in, 2v2 winners stay`;
  const needed = minPlayers - confirmedCount;
  return `🟡 Need ${needed} more — game pending`;
}

// ─────────────────────────────────────────────────────────────
// PUBLIC — landing page state
// ─────────────────────────────────────────────────────────────

router.get('/api/ball/state', async (_req, res) => {
  try {
    const game = await getNextScheduledGame();
    if (!game) {
      res.json({ game: null, message: 'No upcoming games scheduled.' });
      return;
    }
    const detail = await getGameWithRsvps(game.id);
    if (!detail) {
      res.status(500).json({ error: 'Game lookup failed' });
      return;
    }

    // All upcoming games (status scheduled/on, today or later in PT),
    // ordered soonest-first, so the public page can show the full schedule
    // — not just the next game. Confirmed counts mirror getGameWithRsvps:
    // 'in' RSVPs plus the host's implicit "in" (counted once per game).
    const today = todayIsoPT();
    const upcoming = await db
      .select()
      .from(ballGames)
      .where(and(
        gte(ballGames.gameDate, today),
        sql`${ballGames.status} IN ('scheduled','on')`,
      ))
      .orderBy(ballGames.gameDate);

    const gameIds = upcoming.map(g => g.id);

    // Confirmed ('in') RSVP counts per game.
    const counts = gameIds.length
      ? await db
          .select({
            gameId: ballRsvps.gameId,
            n: sql<number>`count(*)::int`.as('n'),
          })
          .from(ballRsvps)
          .where(and(
            inArray(ballRsvps.gameId, gameIds),
            eq(ballRsvps.status, 'in'),
          ))
          .groupBy(ballRsvps.gameId)
      : [];
    const countByGame = new Map(counts.map(c => [c.gameId, c.n]));

    // Host is implicitly IN for every game. Find which games already have an
    // explicit host 'in' row so we add the +1 bonus exactly once (no double-count).
    const [host] = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.isHost, true), eq(ballPlayers.active, true)))
      .limit(1);
    const hostInGameIds = host && gameIds.length
      ? new Set(
          (await db
            .select({ gameId: ballRsvps.gameId })
            .from(ballRsvps)
            .where(and(
              inArray(ballRsvps.gameId, gameIds),
              eq(ballRsvps.playerId, host.id),
              eq(ballRsvps.status, 'in'),
            ))).map(r => r.gameId),
        )
      : new Set<string>();

    const games = upcoming.map(g => {
      const raw = countByGame.get(g.id) ?? 0;
      const hostBonus = host && !hostInGameIds.has(g.id) ? 1 : 0;
      return {
        id: g.id,
        date: g.gameDate,
        startTime: g.startTime,
        endTime: g.endTime,
        status: g.status,
        minPlayers: g.minPlayers,
        confirmedCount: raw + hostBonus,
      };
    });

    res.json({
      game: {
        id: game.id,
        date: game.gameDate,
        startTime: game.startTime,
        endTime: game.endTime,
        status: game.status,
        minPlayers: game.minPlayers,
        notes: game.notes,
      },
      games,
      banner: statusBanner(detail.confirmed.length, game.minPlayers),
      confirmedCount: detail.confirmed.length,
      confirmed: detail.confirmed.map(c => ({ name: c.name, isHost: c.isHost })),
      declinedCount: detail.declined.length,
      address: 'Community Recreation Center',
    });
  } catch (err) {
    console.error('[ball/state] error:', err);
    res.status(500).json({ error: 'Failed to load state' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUBLIC — personal page (lookup by token)
// ─────────────────────────────────────────────────────────────

// Returns ALL upcoming games + this player's RSVP per game.
// Multi-game flow: dad picks every Wednesday he wants on one page.
// Returns the host's personal token IF the caller is authenticated as a
// Club34 admin. Used by /ball to auto-redirect the host to their
// personal page without needing the URL token.
//
// Public callers / non-admin users get { hostToken: null }.
router.get('/api/ball/host-token', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.userRole !== 'admin') {
      res.json({ hostToken: null });
      return;
    }
    const [host] = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.isHost, true), eq(ballPlayers.active, true)))
      .limit(1);
    res.json({ hostToken: host?.token ?? null });
  } catch (err) {
    console.error('[ball/host-token] error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/api/ball/me/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const [player] = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.token, token), eq(ballPlayers.active, true)))
      .limit(1);
    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }

    const today = todayIsoPT();
    const upcoming = await db
      .select()
      .from(ballGames)
      .where(and(
        gte(ballGames.gameDate, today),
        sql`${ballGames.status} IN ('scheduled','on')`,
      ))
      .orderBy(ballGames.gameDate);

    const gameIds = upcoming.map(g => g.id);
    const myRsvps = gameIds.length
      ? await db
          .select()
          .from(ballRsvps)
          .where(and(
            eq(ballRsvps.playerId, player.id),
            inArray(ballRsvps.gameId, gameIds),
          ))
      : [];
    const rsvpByGame = new Map(myRsvps.map(r => [r.gameId, r]));

    // Confirmed counts ('in' only) per game
    const counts = gameIds.length
      ? await db
          .select({
            gameId: ballRsvps.gameId,
            n: sql<number>`count(*)::int`.as('n'),
          })
          .from(ballRsvps)
          .where(and(
            inArray(ballRsvps.gameId, gameIds),
            eq(ballRsvps.status, 'in'),
          ))
          .groupBy(ballRsvps.gameId)
      : [];
    const countByGame = new Map(counts.map(c => [c.gameId, c.n]));

    // Confirmed player names per game (sorted by RSVP time so the
    // first dad to commit shows up first in the avatar stack).
    // Drives the "Who's in" expand on the player Ball card so dads
    // can see exactly who they're playing with — no more anonymous
    // "·· ··" placeholder avatars.
    const confirmedRows = gameIds.length
      ? await db
          .select({
            gameId: ballRsvps.gameId,
            playerId: ballPlayers.id,
            name: ballPlayers.name,
            respondedAt: ballRsvps.respondedAt,
          })
          .from(ballRsvps)
          .innerJoin(ballPlayers, eq(ballRsvps.playerId, ballPlayers.id))
          .where(and(
            inArray(ballRsvps.gameId, gameIds),
            eq(ballRsvps.status, 'in'),
            eq(ballPlayers.active, true),
          ))
          .orderBy(ballRsvps.respondedAt)
      : [];
    const namesByGame = new Map<string, string[]>();
    for (const r of confirmedRows) {
      const arr = namesByGame.get(r.gameId) ?? [];
      arr.push(r.name);
      namesByGame.set(r.gameId, arr);
    }

    // Host auto-IN bonus when host != requester
    const [host] = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.isHost, true), eq(ballPlayers.active, true)))
      .limit(1);
    const hostBonus = host && host.id !== player.id ? 1 : 0;

    const games = upcoming.map(g => {
      const myRsvp = rsvpByGame.get(g.id);
      const rawCount = countByGame.get(g.id) ?? 0;
      // Host is always auto-in (server refuses host RSVPs with hostImplicit:true).
      // Normalize the view so older games without an explicit host RSVP row
      // still show the host as confirmed and counted exactly once.
      const hostSelfInRow = player.isHost && myRsvp?.status === 'in';
      const confirmedCount = player.isHost
        ? rawCount + (hostSelfInRow ? 0 : 1)
        : rawCount + hostBonus;
      const myStatus = player.isHost
        ? 'in'
        : ((myRsvp?.status as string | null) ?? null);

      // Names list mirrors the count: include the host once at the
      // top when host isn't already in the rsvp rows for this game.
      const rawNames = namesByGame.get(g.id) ?? [];
      const hostName = host?.name ?? null;
      const hostAlreadyInRows = hostName ? rawNames.includes(hostName) : false;
      const confirmedNames = hostName && !hostAlreadyInRows
        ? [hostName, ...rawNames]
        : rawNames;

      return {
        id: g.id,
        date: g.gameDate,
        startTime: g.startTime,
        endTime: g.endTime,
        status: g.status,
        minPlayers: g.minPlayers,
        notes: g.notes,
        confirmedCount,
        confirmedNames,
        myStatus,
        respondedAt: myRsvp?.respondedAt ?? null,
        reconfirmedAt: myRsvp?.reconfirmedAt ?? null,
      };
    });

    const activeWaiver = await getActiveWaiver(player.id);

    // Active roster size for the "Dads on Roster" stat tile on the
    // player Ball page. Counts every active player (host included).
    const [{ n: rosterCount }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(ballPlayers)
      .where(eq(ballPlayers.active, true));

    res.json({
      player: {
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        jerseySize: player.jerseySize ?? null,
      },
      waiver: {
        version: WAIVER_VERSION,
        signed: !!activeWaiver,
        signedAt: activeWaiver?.signedAt ?? null,
        text: getActiveWaiverText(WAIVER_VERSION),
      },
      roster: { active: rosterCount },
      games,
      // Back-compat: first upcoming game for older single-game clients
      game: games[0]
        ? {
            id: games[0].id,
            date: games[0].date,
            startTime: games[0].startTime,
            endTime: games[0].endTime,
            status: games[0].status,
          }
        : null,
      myRsvp:
        games[0] && games[0].myStatus
          ? { status: games[0].myStatus, respondedAt: games[0].respondedAt }
          : null,
    });
  } catch (err) {
    console.error('[ball/me] error:', err);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUBLIC — submit RSVP
// ─────────────────────────────────────────────────────────────

// Whitelisted jersey sizes — matches the CHECK constraint in
// migration 0021 and the picker on the Ball page WaiverCard.
const ALLOWED_JERSEY_SIZES = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'] as const;
type JerseySize = (typeof ALLOWED_JERSEY_SIZES)[number];
function normalizeJerseySize(raw: unknown): JerseySize | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toUpperCase();
  return (ALLOWED_JERSEY_SIZES as readonly string[]).includes(v) ? (v as JerseySize) : null;
}

router.post('/api/ball/rsvp', async (req, res) => {
  try {
    const { token, gameId, status, source, acceptWaiver, jerseySize } = req.body ?? {};
    if (!token || !gameId || !['in', 'out', 'maybe'].includes(status)) {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    const [player] = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.token, token), eq(ballPlayers.active, true)))
      .limit(1);
    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }
    if (player.isHost) {
      // Tony is always in. Refuse the RSVP politely so the UI can show
      // "you're auto-confirmed" instead.
      res.status(200).json({ ok: true, hostImplicit: true });
      return;
    }
    const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
    if (!game || game.status === 'done' || game.status === 'off') {
      res.status(400).json({ error: 'Game not open for RSVP' });
      return;
    }

    // Liability waiver gate — applies to ALL first RSVPs (in / out /
    // maybe). The host (Tony) is auto-signed by the 0020 migration so
    // they never see this branch. If the player has no active waiver
    // at the current version, the client must include acceptWaiver:true
    // (the inline checkbox above the RSVP buttons) to consent. The
    // waiver row and the RSVP row are written inside a single
    // transaction so we never end up with one without the other.
    const existingWaiver = await getActiveWaiver(player.id);
    if (!existingWaiver && acceptWaiver !== true) {
      res.status(400).json({
        error: 'waiver_required',
        waiver: {
          version: WAIVER_VERSION,
          text: getActiveWaiverText(WAIVER_VERSION),
          hash: WAIVER_V1_HASH,
        },
      });
      return;
    }

    // Jersey size is OPTIONAL — if the client sends one, persist it
    // (but only the first time, never overwriting an existing pick).
    // No 400 if it's missing. Only reject when an explicitly-provided
    // value is malformed (so we don't silently swallow typos).
    const submittedJerseySize = normalizeJerseySize(jerseySize);
    if (jerseySize !== undefined && jerseySize !== null && jerseySize !== '' && !submittedJerseySize) {
      res.status(400).json({
        error: 'invalid_jersey_size',
        allowed: ALLOWED_JERSEY_SIZES,
      });
      return;
    }

    const ip = (req.ip ?? '').slice(0, 64);
    const userAgent = (req.headers['user-agent'] ?? '').slice(0, 512);
    let waiverJustSigned = false;

    // Transaction: waiver (if needed) + jersey size (if collected) + RSVP
    // must all commit together or not at all. Passing `tx` as `dbCtx` to
    // recordRsvp means the RSVP write is inside the same atomic unit.
    // This preserves the original all-or-nothing guarantee and ensures
    // recordRsvp can observe the just-signed waiver within the transaction.
    await db.transaction(async (tx) => {
      if (!existingWaiver) {
        try {
          await tx.insert(ballWaivers).values({
            playerId: player.id,
            waiverVersion: WAIVER_VERSION,
            ip: ip || null,
            userAgent: userAgent || null,
          });
          waiverJustSigned = true;
        } catch (err) {
          // Race: another concurrent RSVP from the same player just
          // inserted a waiver row. The partial unique index
          // `one_active_waiver` rejects the dup. Treat as "already
          // signed" and continue with the RSVP write below.
          const code = (err as { code?: string })?.code;
          if (code !== '23505') throw err;
        }
      }

      // Persist jersey size when supplied AND the player doesn't
      // already have one — never overwrite an existing pick. The
      // `jersey_size IS NULL` guard in the WHERE clause makes this
      // race-safe: a concurrent first-time RSVP that already wrote a
      // size will short-circuit the UPDATE (0 rows affected) rather
      // than clobber the winning value.
      if (submittedJerseySize && !player.jerseySize) {
        await tx
          .update(ballPlayers)
          .set({ jerseySize: submittedJerseySize, updatedAt: new Date() })
          .where(and(eq(ballPlayers.id, player.id), isNull(ballPlayers.jerseySize)));
      }

      // Delegate RSVP persistence to the shared helper inside this
      // transaction so waiver + jersey + RSVP are fully atomic.
      // Because the waiver was just inserted above (visible within tx),
      // the helper's waiver check will pass. Later manual submissions
      // always win: allowOverwrite=true ensures source is updated to
      // 'web' even when the status is unchanged from a prior email-click.
      const rsvpResult = await recordRsvp({
        playerId: player.id,
        gameId,
        status: status as 'in' | 'out' | 'maybe',
        source: source || 'web',
        allowOverwrite: true,
        dbCtx: tx,
      });

      // Any skip outcome inside the transaction is an unexpected race
      // (host/game-closed were already validated above; no-waiver means
      // the waiver insert above was somehow missed). Roll back by throwing
      // so the caller receives a 500 rather than silently swallowing the skip.
      if (rsvpResult.outcome !== 'recorded') {
        throw new Error(`RSVP not written — unexpected outcome: ${rsvpResult.outcome}`);
      }
    });

    if (waiverJustSigned) {
      logAudit('ball-waiver', {
        category: 'ball',
        event_type: 'waiver_signed',
        severity: 'info',
        actor_id: player.id,
        actor_name: player.name,
        channel: 'web',
        summary: `${player.name} signed Ball waiver ${WAIVER_VERSION}`,
        detail: {
          playerId: player.id,
          version: WAIVER_VERSION,
          ip,
          userAgent,
          source: 'rsvp',
          jerseySize: submittedJerseySize ?? null,
        },
        status: 'success',
      });
    }

    logAudit('ball-rsvp', {
      category: 'ball',
      event_type: 'rsvp_submitted',
      severity: 'info',
      actor_id: player.id,
      actor_name: player.name,
      channel: 'web',
      summary: `${player.name} RSVP'd ${status} for ${game.gameDate}`,
      detail: { gameId, gameDate: game.gameDate, status, source: source || 'web' },
      status: 'success',
    });

    // Re-read waiver so the response reflects whatever the transaction
    // ended up with (either the existing row or the one we just wrote).
    const finalWaiver = existingWaiver ?? (await getActiveWaiver(player.id));
    res.json({
      ok: true,
      rsvp: { gameId, playerId: player.id, status },
      waiver: {
        signed: !!finalWaiver,
        version: finalWaiver?.waiverVersion ?? null,
        signedAt: finalWaiver?.signedAt ?? null,
      },
    });
  } catch (err) {
    console.error('[ball/rsvp] error:', err);
    res.status(500).json({ error: 'RSVP failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUBLIC — sign waiver directly (without an RSVP)
// POST /api/ball/waiver/sign  { playerToken, waiverVersion }
// Idempotent: returns the existing active row if already signed at
// the requested version.
// ─────────────────────────────────────────────────────────────

router.post('/api/ball/waiver/sign', async (req, res) => {
  try {
    const { playerToken, waiverVersion, jerseySize } = req.body ?? {};
    if (!playerToken || typeof playerToken !== 'string') {
      res.status(400).json({ error: 'playerToken required' });
      return;
    }
    const version = typeof waiverVersion === 'string' ? waiverVersion : WAIVER_VERSION;
    if (version !== WAIVER_VERSION) {
      res.status(400).json({ error: 'unknown_waiver_version', current: WAIVER_VERSION });
      return;
    }
    const [player] = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.token, playerToken), eq(ballPlayers.active, true)))
      .limit(1);
    if (!player) {
      res.status(404).json({ error: 'Player not found' });
      return;
    }
    const existing = await getActiveWaiver(player.id);
    if (existing) {
      res.json({ ok: true, signedAt: existing.signedAt, alreadySigned: true });
      return;
    }

    // Jersey size is OPTIONAL on waiver sign — persist if supplied
    // (first-time only, never overwriting), don't reject when missing.
    // Only reject explicitly-provided malformed values.
    const submittedJerseySize = normalizeJerseySize(jerseySize);
    if (jerseySize !== undefined && jerseySize !== null && jerseySize !== '' && !submittedJerseySize) {
      res.status(400).json({
        error: 'invalid_jersey_size',
        allowed: ALLOWED_JERSEY_SIZES,
      });
      return;
    }

    const ip = (req.ip ?? '').slice(0, 64);
    const userAgent = (req.headers['user-agent'] ?? '').slice(0, 512);
    try {
      const [row] = await db.transaction(async (tx) => {
        if (submittedJerseySize && !player.jerseySize) {
          // Same race guard as /api/ball/rsvp: never overwrite an
          // existing size if a concurrent request wrote one first.
          await tx
            .update(ballPlayers)
            .set({ jerseySize: submittedJerseySize, updatedAt: new Date() })
            .where(and(eq(ballPlayers.id, player.id), isNull(ballPlayers.jerseySize)));
        }
        return tx
          .insert(ballWaivers)
          .values({
            playerId: player.id,
            waiverVersion: version,
            ip: ip || null,
            userAgent: userAgent || null,
          })
          .returning({ signedAt: ballWaivers.signedAt });
      });
      logAudit('ball-waiver', {
        category: 'ball',
        event_type: 'waiver_signed',
        severity: 'info',
        actor_id: player.id,
        actor_name: player.name,
        channel: 'web',
        summary: `${player.name} signed Ball waiver ${version}`,
        detail: {
          playerId: player.id,
          version,
          ip,
          userAgent,
          source: 'sign-endpoint',
          jerseySize: submittedJerseySize ?? null,
        },
        status: 'success',
      });
      res.json({ ok: true, signedAt: row.signedAt });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '23505') {
        // Lost the race — fetch the row another request just inserted.
        const row = await getActiveWaiver(player.id);
        res.json({ ok: true, signedAt: row?.signedAt ?? new Date(), alreadySigned: true });
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error('[ball/waiver/sign] error:', err);
    res.status(500).json({ error: 'Sign failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// PUBLIC — .ics calendar download (token-authenticated)
// GET /api/ball/ics/:token/:gameId
// Returns a valid RFC 5545 .ics file for Apple Calendar / Outlook.
// The player token authenticates the request (same as /ball/p/:token).
// UID is stable so re-downloading updates the same calendar event.
// ─────────────────────────────────────────────────────────────

router.get('/api/ball/ics/:token/:gameId', async (req, res) => {
  try {
    const { token, gameId } = req.params;
    const [player] = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.token, token), eq(ballPlayers.active, true)))
      .limit(1);
    if (!player) {
      res.status(404).send('Player not found');
      return;
    }
    const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
    if (!game) {
      res.status(404).send('Game not found');
      return;
    }
    const ics = buildIcsString({
      gameId: game.id,
      gameDate: game.gameDate,
      startTime: game.startTime,
      endTime: game.endTime,
      notes: game.notes,
      playerToken: player.token,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ball-${game.gameDate}.ics"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(ics);
  } catch (err) {
    console.error('[ball/ics] error:', err);
    res.status(500).send('Failed to generate calendar file');
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN — overview + per-game detail
// ─────────────────────────────────────────────────────────────

router.get('/api/ball/admin/overview', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const games = await db
      .select()
      .from(ballGames)
      .orderBy(ballGames.gameDate);
    const counts = await db
      .select({
        gameId: ballRsvps.gameId,
        status: ballRsvps.status,
        n: sql<number>`count(*)::int`.as('n'),
      })
      .from(ballRsvps)
      .groupBy(ballRsvps.gameId, ballRsvps.status);
    const byGame = new Map<string, { in: number; out: number; maybe: number }>();
    for (const r of counts) {
      const entry = byGame.get(r.gameId) ?? { in: 0, out: 0, maybe: 0 };
      if (r.status === 'in') entry.in = r.n;
      if (r.status === 'out') entry.out = r.n;
      if (r.status === 'maybe') entry.maybe = r.n;
      byGame.set(r.gameId, entry);
    }
    const playerRows = await db
      .select({
        id: ballPlayers.id,
        name: ballPlayers.name,
        email: ballPlayers.email,
        token: ballPlayers.token,
        isHost: ballPlayers.isHost,
      })
      .from(ballPlayers)
      .where(eq(ballPlayers.active, true))
      .orderBy(ballPlayers.name);
    const activeWaiverRows = await db
      .select({
        playerId: ballWaivers.playerId,
        version: ballWaivers.waiverVersion,
        signedAt: ballWaivers.signedAt,
      })
      .from(ballWaivers)
      .where(and(
        eq(ballWaivers.waiverVersion, WAIVER_VERSION),
        sql`${ballWaivers.revokedAt} IS NULL`,
      ));
    const waiverByPlayer = new Map(activeWaiverRows.map(w => [w.playerId, w]));

    // Per-player engagement rollup (most recent open / click across all
    // their sends). Included here so consumers of /overview can render
    // engagement signals without a second roundtrip.
    const overviewEngagementRows = await db.execute(sql`
      SELECT
        player_id,
        MAX(opened_at)        AS last_opened_at,
        MAX(first_clicked_at) AS last_clicked_at
      FROM ball_email_sends
      GROUP BY player_id
    `);
    type OverviewEngagementRow = {
      player_id: string;
      last_opened_at: string | Date | null;
      last_clicked_at: string | Date | null;
    };
    const overviewEngagementByPlayer = new Map<string, { lastOpenedAt: string | null; lastClickedAt: string | null }>(
      ((overviewEngagementRows as unknown as { rows?: OverviewEngagementRow[] }).rows ?? []).map(r => [
        r.player_id,
        {
          lastOpenedAt: r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null,
          lastClickedAt: r.last_clicked_at ? new Date(r.last_clicked_at).toISOString() : null,
        },
      ]),
    );

    res.json({
      games: games.map(g => ({
        ...g,
        counts: byGame.get(g.id) ?? { in: 0, out: 0, maybe: 0 },
      })),
      activePlayers: playerRows.length,
      players: playerRows.map(p => {
        const w = waiverByPlayer.get(p.id);
        const eng = overviewEngagementByPlayer.get(p.id);
        return {
          id: p.id,
          name: p.name,
          email: p.email,
          token: p.token,
          isHost: p.isHost,
          waiver: {
            signed: !!w,
            version: w?.version ?? null,
            signedAt: w?.signedAt ?? null,
          },
          lastOpenedAt: eng?.lastOpenedAt ?? null,
          lastClickedAt: eng?.lastClickedAt ?? null,
        };
      }),
      waiverVersion: WAIVER_VERSION,
    });
  } catch (err) {
    console.error('[ball/admin/overview] error:', err);
    res.status(500).json({ error: 'Failed to load overview' });
  }
});

router.get('/api/ball/admin/game/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const detail = await getGameWithRsvps(String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    // Also include un-responded players for "send nudge" UI
    const responded = new Set(detail.all.map(r => r.playerId));
    const noResponse = await db
      .select({ id: ballPlayers.id, name: ballPlayers.name, email: ballPlayers.email })
      .from(ballPlayers)
      .where(and(eq(ballPlayers.active, true), eq(ballPlayers.isHost, false)));
    res.json({
      ...detail,
      noResponse: noResponse.filter(p => !responded.has(p.id)),
    });
  } catch (err) {
    console.error('[ball/admin/game] error:', err);
    res.status(500).json({ error: 'Failed to load game' });
  }
});

router.post('/api/ball/admin/game/:id/force-status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.body ?? {};
    if (!['scheduled', 'on', 'off', 'done'].includes(status)) {
      res.status(400).json({ error: 'Bad status' });
      return;
    }
    await db
      .update(ballGames)
      .set({ status, updatedAt: new Date() })
      .where(eq(ballGames.id, String(req.params.id)));
    logAudit('ball-admin', {
      category: 'ball',
      event_type: 'game_status_forced',
      severity: 'info',
      actor_id: 'admin',
      actor_name: 'Host',
      channel: 'admin-ui',
      summary: `Game ${req.params.id} forced to ${status}`,
      detail: { gameId: req.params.id, status },
      status: 'success',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ball/admin/force-status] error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/api/ball/admin/game/:id/attendance', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { playerId, showedUp } = req.body ?? {};
    if (!playerId || typeof showedUp !== 'boolean') {
      res.status(400).json({ error: 'Bad request' });
      return;
    }
    await db
      .update(ballRsvps)
      .set({ showedUp, updatedAt: new Date() })
      .where(and(eq(ballRsvps.gameId, String(req.params.id)), eq(ballRsvps.playerId, playerId)));
    res.json({ ok: true });
  } catch (err) {
    console.error('[ball/admin/attendance] error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Email blasts — admin manual triggers (also used by cron)
// ─────────────────────────────────────────────────────────────

// Legacy single-game blast — kept for the per-game "re-send invite" admin
// button. The default flow uses blastMonthInvite() at start-of-month.
async function blastInvites(gameId: string): Promise<{ sent: number; failed: number }> {
  const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
  if (!game) return { sent: 0, failed: 0 };
  const recipients = await db
    .select()
    .from(ballPlayers)
    .where(and(eq(ballPlayers.active, true), eq(ballPlayers.isHost, false)));
  let sent = 0;
  let failed = 0;
  for (const p of recipients) {
    const email = buildInviteEmail({
      playerName: p.name,
      playerToken: p.token,
      gameDateIso: game.gameDate,
      gameStart: game.startTime,
      gameEnd: game.endTime,
    });
    const r = await sendTrackedBallEmail({
      playerId: p.id,
      gameId,
      template: 'invite',
      to: p.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (r.ok) sent++; else failed++;
  }
  await db
    .update(ballGames)
    .set({ inviteSentAt: new Date(), updatedAt: new Date() })
    .where(eq(ballGames.id, gameId));
  return { sent, failed };
}

// MONTH INVITE — the primary blast. Lists every upcoming Wednesday so
// each dad can RSVP to all of them from a single email. Used for:
//   - Start-of-month cron (1st of month, 9am PT) — blastMonthInvite()
//   - Auto-invite on player-add (admin) — blastMonthInvite({ recipientIds: [id] })
//   - Admin "Re-send month invite" button — blastMonthInvite({ recipientIds })
//   - NEW: Per-game manual blast (admin UI) — blastMonthInvite({ gameIds: [gameId] })
//
// Options:
//   - recipientIds: restrict to specific players by player ID (existing)
//   - recipientFilter.email: additional restrict by email address (test/safe-send)
//                            Intersected with recipientIds when both are present.
//   - gameIds: restrict the listed games to this specific set (any date, any status).
//              When omitted, falls back to "all upcoming Wednesdays this month" — the
//              default cron behavior. When provided, the email subject switches to a
//              per-game-count form so it reads correctly for a single-game blast.
//   - dryRun: build everything and return the would-be result without sending or
//             touching ball_games.invite_sent_at. Useful for previews + tests.
//
// Return:
//   - sent / failed: per-recipient send outcomes
//   - recipients: number of recipients matched (after all filters)
//   - emailSendIds: ball_email_sends.id for every sendTrackedBallEmail call so the
//                   caller can correlate to engagement tracking later.
//   - gamesIncluded: ball_games.id list actually emailed about, in date order.
//
// Example smoke test:
//   await blastMonthInvite({ dryRun: true, gameIds: ['<one-game-uuid>'] })
//   // → { sent: 0, failed: 0, recipients: <count>, emailSendIds: [], gamesIncluded: ['<one-game-uuid>'] }
export async function blastMonthInvite(
  options: {
    recipientIds?: string[];
    recipientFilter?: { email?: string[] };
    gameIds?: string[];
    dryRun?: boolean;
  } = {},
): Promise<{
  sent: number;
  failed: number;
  recipients: number;
  emailSendIds: string[];
  gamesIncluded: string[];
}> {
  const today = todayIsoPT();
  const explicitGameIds = options.gameIds && options.gameIds.length > 0;

  const upcoming = explicitGameIds
    ? await db
        .select()
        .from(ballGames)
        .where(inArray(ballGames.id, options.gameIds!))
        .orderBy(ballGames.gameDate)
    : await db
        .select()
        .from(ballGames)
        .where(and(
          gte(ballGames.gameDate, today),
          sql`${ballGames.status} IN ('scheduled','on')`,
        ))
        .orderBy(ballGames.gameDate);

  if (upcoming.length === 0) {
    return { sent: 0, failed: 0, recipients: 0, emailSendIds: [], gamesIncluded: [] };
  }

  // Confirmed counts per game (for the "X in so far" line)
  const gameIds = upcoming.map(g => g.id);
  const counts = await db
    .select({
      gameId: ballRsvps.gameId,
      n: sql<number>`count(*)::int`.as('n'),
    })
    .from(ballRsvps)
    .where(and(
      inArray(ballRsvps.gameId, gameIds),
      eq(ballRsvps.status, 'in'),
    ))
    .groupBy(ballRsvps.gameId);
  const countByGame = new Map(counts.map(c => [c.gameId, c.n]));

  // Host bonus (Tony counts on every game)
  const [host] = await db
    .select()
    .from(ballPlayers)
    .where(and(eq(ballPlayers.isHost, true), eq(ballPlayers.active, true)))
    .limit(1);
  const hostBonus = host ? 1 : 0;

  // Recipients: active non-host, then narrow via recipientIds, then via recipientFilter.email
  let recipients = await db
    .select()
    .from(ballPlayers)
    .where(and(eq(ballPlayers.active, true), eq(ballPlayers.isHost, false)));
  if (options.recipientIds && options.recipientIds.length) {
    const set = new Set(options.recipientIds);
    recipients = recipients.filter(p => set.has(p.id));
  }
  if (options.recipientFilter?.email && options.recipientFilter.email.length) {
    const emailSet = new Set(
      options.recipientFilter.email.map(e => e.trim().toLowerCase()),
    );
    recipients = recipients.filter(p => emailSet.has(p.email.toLowerCase()));
  }

  // Month label from first included game (still useful even for single-game subject fallback in body).
  // Use noon-UTC (T12:00:00Z) — same calendar day in every timezone — so the month label is
  // correct regardless of the Node process TZ. Matches the formatDate helper in ballEmails.ts.
  const monthLabel = new Date(upcoming[0].gameDate + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Los_Angeles',
  });

  // When the caller explicitly scopes to specific gameIds, override the subject so a single
  // game doesn't show up in inboxes as "June 2026 Ball at Club34 — pick your Wednesdays".
  // Default month-mode path keeps the original subject so cron + new-player auto-invite are unchanged.
  const overrideSubject = explicitGameIds
    ? `🏀 Club34 Ball — RSVP for ${upcoming.length} Wednesday game${upcoming.length === 1 ? '' : 's'}`
    : null;

  let sent = 0;
  let failed = 0;
  const emailSendIds: string[] = [];

  for (const p of recipients) {
    // Per-player game list with their existing RSVP for each
    const myRsvps = await db
      .select()
      .from(ballRsvps)
      .where(and(
        eq(ballRsvps.playerId, p.id),
        inArray(ballRsvps.gameId, gameIds),
      ));
    const byGame = new Map(myRsvps.map(r => [r.gameId, r]));
    const upcomingSummary: UpcomingGameSummary[] = upcoming.map(g => ({
      id: g.id,
      dateIso: g.gameDate,
      startTime: g.startTime,
      endTime: g.endTime,
      notes: g.notes,
      confirmedCount: (countByGame.get(g.id) ?? 0) + hostBonus,
      myStatus: (byGame.get(g.id)?.status as UpcomingGameSummary['myStatus']) ?? null,
    }));
    const email = buildMonthInviteEmail({
      playerName: p.name,
      playerToken: p.token,
      monthLabel,
      upcomingGames: upcomingSummary,
    });
    const subject = overrideSubject ?? email.subject;

    if (options.dryRun) {
      // Skip the actual send + tracking row insert; still count the recipient so the
      // caller can verify the targeting filters resolved correctly.
      continue;
    }

    const r = await sendTrackedBallEmail({
      playerId: p.id,
      gameId: null, // month invite spans multiple games; per-game correlation is via emailSendIds
      template: 'month-invite',
      to: p.email,
      subject,
      html: email.html,
      text: email.text,
    });
    emailSendIds.push(r.sendId);
    if (r.ok) sent++; else failed++;
  }

  // Mark only the games actually included as having had an invite sent.
  // (Was previously "all upcoming Wednesdays", which would have been incorrect for
  // a gameIds-scoped blast.) Skipped on dryRun.
  if (!options.dryRun) {
    await db
      .update(ballGames)
      .set({ inviteSentAt: new Date(), updatedAt: new Date() })
      .where(inArray(ballGames.id, gameIds));
  }

  return {
    sent,
    failed,
    recipients: recipients.length,
    emailSendIds,
    gamesIncluded: gameIds,
  };
}

// RECONFIRM BLAST — Wednesday 9am day-of "still in?" hard re-confirm.
// For everyone currently 'in' for today's game, flips their RSVP to
// 'pending_reconfirm' and emails them. Re-clicking the link flips back
// to 'in' with reconfirmedAt = now (handled by the public RSVP endpoint).
async function blastReconfirm(gameId: string): Promise<{ sent: number; failed: number; flagged: number }> {
  const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
  if (!game) return { sent: 0, failed: 0, flagged: 0 };

  // Flip all 'in' RSVPs (non-host) to 'pending_reconfirm'
  const inRsvps = await db
    .select({
      rsvpId: ballRsvps.id,
      playerId: ballPlayers.id,
      name: ballPlayers.name,
      email: ballPlayers.email,
      token: ballPlayers.token,
      isHost: ballPlayers.isHost,
    })
    .from(ballRsvps)
    .innerJoin(ballPlayers, eq(ballRsvps.playerId, ballPlayers.id))
    .where(and(eq(ballRsvps.gameId, gameId), eq(ballRsvps.status, 'in')));

  const nonHost = inRsvps.filter(r => !r.isHost);
  // Flag them all in one update
  if (nonHost.length) {
    await db
      .update(ballRsvps)
      .set({ status: 'pending_reconfirm', updatedAt: new Date() })
      .where(and(
        eq(ballRsvps.gameId, gameId),
        eq(ballRsvps.status, 'in'),
        sql`${ballRsvps.playerId} IN (
          SELECT id FROM ball_players WHERE is_host = false
        )`,
      ));
  }

  // Email each one
  let sent = 0;
  let failed = 0;
  for (const r of nonHost) {
    const email = buildReconfirmEmail({
      playerName: r.name,
      playerToken: r.token,
      gameDateIso: game.gameDate,
      gameStart: game.startTime,
      gameEnd: game.endTime,
      notes: game.notes,
      gameId: game.id,
    });
    const tr = await sendTrackedBallEmail({
      playerId: r.playerId,
      gameId,
      template: 'reconfirm',
      to: r.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    if (tr.ok) sent++; else failed++;
  }

  await db
    .update(ballGames)
    .set({ reconfirmSentAt: new Date(), updatedAt: new Date() })
    .where(eq(ballGames.id, gameId));

  return { sent, failed, flagged: nonHost.length };
}

router.post('/api/ball/admin/game/:id/send-invite', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await blastInvites(String(req.params.id));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ball/admin/send-invite] error:', err);
    res.status(500).json({ error: 'Blast failed' });
  }
});

router.post('/api/ball/admin/game/:id/email-gate', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await sendGateRosterEmail(String(req.params.id));
    if (!result.ok) {
      const code = result.error === 'game lookup failed' ? 404 : 502;
      res.status(code).json({ error: result.error || 'Gate email failed' });
      return;
    }
    res.json({ ok: true, guests: result.guests, bcc: result.bcc });
  } catch (err) {
    console.error('[ball/admin/email-gate] error:', err);
    res.status(500).json({ error: 'Gate email failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Player CRUD (admin)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Game CRUD (admin)
// ─────────────────────────────────────────────────────────────

// Create one game OR a recurring series. Body:
//   { date: 'YYYY-MM-DD', startTime?: '18:00', endTime?: '20:00',
//     minPlayers?: 6, notes?: string, repeatWeekly?: number, sendInvite?: boolean }
// repeatWeekly = N creates N games on consecutive weeks starting at `date`.
router.post('/api/ball/admin/games', requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      date, startTime = '18:00', endTime = '20:00',
      minPlayers = 6, notes = null, repeatWeekly = 1, sendInvite = false,
    } = req.body ?? {};

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
      return;
    }
    const count = Math.max(1, Math.min(52, Number(repeatWeekly) || 1));

    // Generate the date list — add 7 days * i to the base date
    const created: { id: string; gameDate: string }[] = [];
    for (let i = 0; i < count; i++) {
      const base = new Date(date + 'T12:00:00Z');
      base.setUTCDate(base.getUTCDate() + i * 7);
      const iso = base.toISOString().slice(0, 10);
      try {
        const [row] = await db
          .insert(ballGames)
          .values({
            gameDate: iso,
            startTime,
            endTime,
            minPlayers,
            notes,
            status: 'scheduled',
          })
          .returning({ id: ballGames.id, gameDate: ballGames.gameDate });
        created.push(row);
      } catch (e) {
        // Most likely a unique constraint hit on game_date — log and continue
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[ball/admin/games] skip ${iso}: ${msg}`);
      }
    }

    logAudit('ball-admin', {
      category: 'ball',
      event_type: 'games_created',
      severity: 'info',
      actor_id: (req as AuthenticatedRequest).userId || 'admin',
      actor_name: 'Host',
      channel: 'admin-ui',
      summary: `Created ${created.length} game(s)`,
      detail: { dates: created.map(c => c.gameDate), repeatWeekly: count },
      status: 'success',
    });

    // Optionally send the month-invite blast to all dads right after
    let inviteResult: { sent: number; failed: number; recipients: number } | null = null;
    if (sendInvite && created.length > 0) {
      try {
        inviteResult = await blastMonthInvite();
      } catch (e) {
        console.error('[ball/admin/games] post-create invite blast failed:', e);
      }
    }

    res.json({ ok: true, created, inviteResult });
  } catch (err) {
    console.error('[ball/admin/games] create error:', err);
    res.status(500).json({ error: 'Create failed' });
  }
});

// Edit a game
router.patch('/api/ball/admin/games/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const { gameDate, startTime, endTime, minPlayers, notes, status } = req.body ?? {};
    const patch: Partial<BallGame> = { updatedAt: new Date() };
    if (gameDate !== undefined) patch.gameDate = gameDate;
    if (startTime !== undefined) patch.startTime = startTime;
    if (endTime !== undefined) patch.endTime = endTime;
    if (minPlayers !== undefined) patch.minPlayers = minPlayers;
    if (notes !== undefined) patch.notes = notes;
    if (status !== undefined) patch.status = status;
    await db.update(ballGames).set(patch).where(eq(ballGames.id, id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[ball/admin/games] patch error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// Delete a game (hard delete — cascades to RSVPs and email sends)
router.delete('/api/ball/admin/games/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    await db.delete(ballGames).where(eq(ballGames.id, id));
    logAudit('ball-admin', {
      category: 'ball',
      event_type: 'game_deleted',
      severity: 'warning',
      actor_id: (req as AuthenticatedRequest).userId || 'admin',
      actor_name: 'Host',
      channel: 'admin-ui',
      summary: `Game ${id} deleted (RSVPs cascaded)`,
      detail: { gameId: id },
      status: 'success',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[ball/admin/games] delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Manual per-game invite blast (admin)
//   POST /api/ball/admin/games/:id/send-invite-blast
// Fires the month-invite email scoped to a single game. Useful when
// Tony creates a game mid-month and wants RSVPs now.
// ─────────────────────────────────────────────────────────────
router.post('/api/ball/admin/games/:id/send-invite-blast', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const gameId = String(req.params.id);
    const dryRun = req.body?.dryRun === true;
    const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
    if (!game) {
      res.status(400).json({ error: 'game not found' });
      return;
    }
    if (!dryRun && game.status !== 'scheduled') {
      res.status(400).json({ error: 'game not found or not scheduled' });
      return;
    }
    const result = await blastMonthInvite({ gameIds: [gameId], dryRun });
    if (dryRun) {
      res.json({ ok: true, dryRun: true, wouldSend: result.recipients, gamesIncluded: result.gamesIncluded });
      return;
    }
    logAudit('ball-admin', {
      category: 'ball',
      event_type: 'manual_invite_blast',
      severity: 'info',
      actor_id: req.userId || 'admin',
      actor_name: 'Host',
      channel: 'admin-ui',
      summary: `Manual invite blast for ${game.gameDate} — sent ${result.sent}/${result.recipients}`,
      detail: { gameId, gameDate: game.gameDate, ...result },
      status: 'success',
    });
    res.json({
      ok: true,
      sent: result.sent,
      failed: result.failed,
      recipients: result.recipients,
      emailSendIds: result.emailSendIds,
    });
  } catch (err) {
    console.error('[ball/admin/send-invite-blast] error:', err);
    res.status(500).json({ error: 'Blast failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Manual per-game decision email (admin)
//   POST /api/ball/admin/games/:id/send-decision-email
//   body: { decision: 'on' | 'off', force?: boolean }
// Manually marks a game ON/OFF and notifies confirmed players,
// instead of waiting for the Wed 11am PT cutoff.
// ─────────────────────────────────────────────────────────────
router.post('/api/ball/admin/games/:id/send-decision-email', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const gameId = String(req.params.id);
    const { decision, force, dryRun: dryRunArg } = (req.body ?? {}) as { decision?: string; force?: boolean; dryRun?: boolean };
    const dryRun = dryRunArg === true;
    if (decision !== 'on' && decision !== 'off') {
      res.status(400).json({ error: "decision must be 'on' or 'off'" });
      return;
    }
    const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
    if (!game) {
      res.status(400).json({ error: 'game not found' });
      return;
    }
    if (!dryRun && !force && (game.status === 'on' || game.status === 'off')) {
      res.status(400).json({
        error: `game is already ${game.status} — pass force=true to re-send`,
      });
      return;
    }

    const detail = await getGameWithRsvps(gameId);
    if (!detail) {
      res.status(500).json({ error: 'game lookup failed' });
      return;
    }

    // Recipients: confirmed non-host (matches cron-decide behavior).
    // Tony is the implicit host trigger, no need to email him.
    const recipients = detail.confirmed.filter(c => !c.isHost);

    if (dryRun) {
      res.json({ ok: true, dryRun: true, wouldSend: recipients.length, status: decision });
      return;
    }

    // Flip status + stamp decisionSentAt
    await db
      .update(ballGames)
      .set({ status: decision, decisionSentAt: new Date(), updatedAt: new Date() })
      .where(eq(ballGames.id, gameId));
    const confirmedNames = detail.confirmed.map(c => c.name);

    let sent = 0;
    let failed = 0;
    for (const r of recipients) {
      const [player] = await db
        .select()
        .from(ballPlayers)
        .where(eq(ballPlayers.id, r.playerId))
        .limit(1);
      if (!player) continue;
      const tmpl = decision === 'on'
        ? buildDecisionOnEmail({
            playerName: player.name,
            playerToken: player.token,
            gameDateIso: game.gameDate,
            gameStart: game.startTime,
            gameEnd: game.endTime,
            notes: game.notes,
            confirmedCount: detail.confirmed.length,
            confirmedNames,
            gameId,
          })
        : buildDecisionOffEmail({
            playerName: player.name,
            playerToken: player.token,
            gameDateIso: game.gameDate,
            gameStart: game.startTime,
            gameEnd: game.endTime,
          });
      const tracked = await sendTrackedBallEmail({
        playerId: player.id,
        gameId,
        template: decision === 'on' ? 'decision-on' : 'decision-off',
        to: player.email,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });
      if (tracked.ok) sent++; else failed++;
    }

    logAudit('ball-admin', {
      category: 'ball',
      event_type: 'manual_decision_email',
      severity: 'info',
      actor_id: req.userId || 'admin',
      actor_name: 'Host',
      channel: 'admin-ui',
      summary: `Manual decision (${decision}) for ${game.gameDate} — notified ${sent}/${recipients.length}`,
      detail: { gameId, gameDate: game.gameDate, decision, force: !!force, sent, failed, recipients: recipients.length },
      status: 'success',
    });

    res.json({ ok: true, sent, failed, recipients: recipients.length, status: decision });
  } catch (err) {
    console.error('[ball/admin/send-decision-email] error:', err);
    res.status(500).json({ error: 'Send failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Player CRUD (admin)
// ─────────────────────────────────────────────────────────────

// Full roster — every player (active + inactive) joined with their active
// waiver, plus per-player rollups: games invited (distinct game_id with any
// tracked email send), RSVP totals (in/out/maybe), and last response time.
router.get('/api/ball/admin/players', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const players = await db
      .select()
      .from(ballPlayers)
      .orderBy(ballPlayers.name);

    const waiverRows = await db
      .select({
        playerId: ballWaivers.playerId,
        waiverVersion: ballWaivers.waiverVersion,
        signedAt: ballWaivers.signedAt,
      })
      .from(ballWaivers)
      .where(sql`${ballWaivers.revokedAt} IS NULL`);

    const waiverByPlayer = new Map(waiverRows.map(w => [w.playerId, w]));

    // Games invited per player — distinct game_id from ball_email_sends where
    // game_id is not null. (Month-invite blasts have a NULL game_id and aren't
    // tied to a specific game, so they don't count.)
    const invitedRows = await db.execute(sql`
      SELECT player_id, COUNT(DISTINCT game_id)::int AS games_invited
      FROM ball_email_sends
      WHERE game_id IS NOT NULL
      GROUP BY player_id
    `);
    const invitedByPlayer = new Map<string, number>(
      ((invitedRows as unknown as { rows?: Array<{ player_id: string; games_invited: number }> }).rows ?? [])
        .map(r => [r.player_id, Number(r.games_invited)]),
    );

    // RSVP rollups + most recent response per player.
    const rsvpRows = await db.execute(sql`
      SELECT
        player_id,
        SUM(CASE WHEN status = 'in' THEN 1 ELSE 0 END)::int AS rsvp_in,
        SUM(CASE WHEN status = 'out' THEN 1 ELSE 0 END)::int AS rsvp_out,
        SUM(CASE WHEN status = 'maybe' THEN 1 ELSE 0 END)::int AS rsvp_maybe,
        MAX(responded_at) AS last_responded_at
      FROM ball_rsvps
      GROUP BY player_id
    `);

    // Engagement rollups per player — most recent open / click across ALL
    // their sends (any game, any template). Lets the admin scan the roster
    // and spot dads who clearly saw the email but didn't RSVP.
    const engagementRows = await db.execute(sql`
      SELECT
        player_id,
        MAX(opened_at)        AS last_opened_at,
        MAX(first_clicked_at) AS last_clicked_at
      FROM ball_email_sends
      GROUP BY player_id
    `);
    type EngagementAggRow = {
      player_id: string;
      last_opened_at: string | Date | null;
      last_clicked_at: string | Date | null;
    };
    const engagementByPlayer = new Map<string, { lastOpenedAt: string | null; lastClickedAt: string | null }>(
      ((engagementRows as unknown as { rows?: EngagementAggRow[] }).rows ?? []).map(r => [
        r.player_id,
        {
          lastOpenedAt: r.last_opened_at ? new Date(r.last_opened_at).toISOString() : null,
          lastClickedAt: r.last_clicked_at ? new Date(r.last_clicked_at).toISOString() : null,
        },
      ]),
    );
    type RsvpAggRow = {
      player_id: string;
      rsvp_in: number;
      rsvp_out: number;
      rsvp_maybe: number;
      last_responded_at: string | Date | null;
    };
    const rsvpByPlayer = new Map<string, { in: number; out: number; maybe: number; lastRespondedAt: string | null }>(
      ((rsvpRows as unknown as { rows?: RsvpAggRow[] }).rows ?? []).map(r => [
        r.player_id,
        {
          in: Number(r.rsvp_in) || 0,
          out: Number(r.rsvp_out) || 0,
          maybe: Number(r.rsvp_maybe) || 0,
          lastRespondedAt: r.last_responded_at ? new Date(r.last_responded_at).toISOString() : null,
        },
      ]),
    );

    res.json({
      players: players.map(p => {
        const w = waiverByPlayer.get(p.id);
        const rsvp = rsvpByPlayer.get(p.id);
        return {
          id: p.id,
          name: p.name,
          email: p.email,
          phone: p.phone ?? null,
          token: p.token,
          isHost: p.isHost,
          active: p.active,
          jerseySize: p.jerseySize ?? null,
          waiverSigned: !!w,
          waiverVersion: w?.waiverVersion ?? null,
          waiverSignedAt: w?.signedAt ?? null,
          gamesInvited: invitedByPlayer.get(p.id) ?? 0,
          rsvpCounts: {
            in: rsvp?.in ?? 0,
            out: rsvp?.out ?? 0,
            maybe: rsvp?.maybe ?? 0,
          },
          lastRespondedAt: rsvp?.lastRespondedAt ?? null,
          lastOpenedAt: engagementByPlayer.get(p.id)?.lastOpenedAt ?? null,
          lastClickedAt: engagementByPlayer.get(p.id)?.lastClickedAt ?? null,
        };
      }),
    });
  } catch (err) {
    console.error('[ball/admin/players GET] error:', err);
    res.status(500).json({ error: 'Failed to load roster' });
  }
});

router.post('/api/ball/admin/players', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, notes, jerseySize, sendInvite } = req.body ?? {};
    if (!name || !email) {
      res.status(400).json({ error: 'name and email required' });
      return;
    }

    // Case-insensitive duplicate email check
    const existing = await db
      .select({ id: ballPlayers.id })
      .from(ballPlayers)
      .where(sql`LOWER(${ballPlayers.email}) = LOWER(${email})`)
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: 'A dad with that email already exists' });
      return;
    }

    const token = randomToken();
    const validJerseySize = ['S', 'M', 'L', 'XL', 'XXL', 'XXXL'].includes(jerseySize) ? jerseySize : null;
    const [created] = await db
      .insert(ballPlayers)
      .values({ name, email, phone: phone || null, token, notes: notes || null, jerseySize: validJerseySize })
      .returning();

    // Auto-fire the month invite for the newly-added dad, unless caller opts out
    let inviteResult: { sent: number; failed: number; recipients: number } | null = null;
    if (sendInvite !== false) {
      try {
        inviteResult = await blastMonthInvite({ recipientIds: [created.id] });
      } catch (e) {
        console.error('[ball/admin/players] auto-invite failed:', e);
      }
    }

    res.json({ ok: true, player: created, inviteResult });
  } catch (err) {
    console.error('[ball/admin/players] add error:', err);
    res.status(500).json({ error: 'Add failed' });
  }
});

// Admin: per-player engagement rollup for a game
// Returns one row per player with the latest send across all templates,
// merged with their RSVP state. UI uses this to show 'sent / opened / clicked / RSVP'.
router.get('/api/ball/admin/game/:id/engagement', requireAuth, requireAdmin, async (req, res) => {
  try {
    const gameId = String(req.params.id);
    const [game] = await db.select().from(ballGames).where(eq(ballGames.id, gameId)).limit(1);
    if (!game) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    // Pull every active non-host player + their email rows for this game OR any
    // recent month-invite (where game_id is NULL but template = 'month-invite').
    // We pick the LATEST send per (player, template).
    const players = await db
      .select()
      .from(ballPlayers)
      .where(and(eq(ballPlayers.active, true), eq(ballPlayers.isHost, false)));

    // For each player, fetch the latest send per (player, template)
    // relevant to this game. The dataset is small (~47 dads, a handful
    // of templates) so a full fetch + JS dedup is fine and avoids a
    // raw DISTINCT ON query.  drizzle's inArray() generates the correct
    // parameterised IN (...) clause — no array literal workaround needed.
    const playerIds = players.map(p => p.id);
    const allSends = playerIds.length
      ? await db
          .select()
          .from(ballEmailSends)
          .where(and(
            inArray(ballEmailSends.playerId, playerIds),
            or(
              eq(ballEmailSends.gameId, gameId),
              and(isNull(ballEmailSends.gameId), eq(ballEmailSends.template, 'month-invite')),
            ),
          ))
          .orderBy(ballEmailSends.playerId, ballEmailSends.template, desc(ballEmailSends.createdAt))
      : [];

    // Replicate DISTINCT ON (player_id, template): keep first (most-recent)
    // per (playerId, template) pair — rows are already sorted createdAt DESC.
    const seenSendKey = new Set<string>();
    const deduped = allSends.filter(s => {
      const key = `${s.playerId}:${s.template}`;
      if (seenSendKey.has(key)) return false;
      seenSendKey.add(key);
      return true;
    });

    // Index by playerId
    const sendsByPlayer = new Map<string, typeof deduped>();
    for (const row of deduped) {
      const arr = sendsByPlayer.get(row.playerId) ?? [];
      arr.push(row);
      sendsByPlayer.set(row.playerId, arr);
    }

    // RSVPs for this game
    const rsvps = await db
      .select()
      .from(ballRsvps)
      .where(eq(ballRsvps.gameId, gameId));
    const rsvpByPlayer = new Map(rsvps.map(r => [r.playerId, r]));

    const rows = players.map(p => {
      const playerSends = sendsByPlayer.get(p.id) ?? [];
      const rsvp = rsvpByPlayer.get(p.id);
      return {
        playerId: p.id,
        name: p.name,
        email: p.email,
        rsvpStatus: rsvp?.status ?? null,
        rsvpAt: rsvp?.respondedAt ?? null,
        sends: playerSends.map(s => ({
          id: s.id,
          template: s.template,
          subject: s.subject,
          createdAt: s.createdAt,
          sentAt: s.sentAt,
          bouncedAt: s.bouncedAt,
          bounceReason: s.bounceReason,
          sendError: s.sendError,
          openedAt: s.openedAt,
          openCount: s.openCount,
          firstClickedAt: s.firstClickedAt,
          clickCount: s.clickCount,
          lastClickLink: s.lastClickLink,
          // helpful for the UI to warn about Apple Mail noise
          looksLikeAppleMail:
            typeof s.userAgentFirstOpen === 'string' &&
            /Mail.*iPhone|Mail.*Macintosh|MailPrivacyProtection/i.test(s.userAgentFirstOpen),
        })),
      };
    });

    res.json({ gameId, gameDate: game.gameDate, rows });
  } catch (err) {
    console.error('[ball/admin/engagement] error:', err);
    res.status(500).json({ error: 'Failed to load engagement' });
  }
});

// Admin: one-time backfill — reconcile email clicks with ball_rsvps
//
// Scans ball_email_sends for rows where first_clicked_at IS NOT NULL,
// last_click_link IN ('in','out','maybe'), and game_id IS NOT NULL.
// For each, calls recordRsvp with allowOverwrite=false (never overwrites
// existing RSVPs) and source='email-click-backfill'.
//
// Returns: { scanned, inserted, skipped_existing, skipped_no_waiver,
//            skipped_host, skipped_game_closed, errors }
router.post('/api/ball/admin/backfill-email-clicks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rows = await db
      .select({
        id: ballEmailSends.id,
        playerId: ballEmailSends.playerId,
        gameId: ballEmailSends.gameId,
        lastClickLink: ballEmailSends.lastClickLink,
        firstClickedAt: ballEmailSends.firstClickedAt,
      })
      .from(ballEmailSends)
      .where(and(
        isNotNull(ballEmailSends.firstClickedAt),
        inArray(ballEmailSends.lastClickLink, ['in', 'out', 'maybe']),
        isNotNull(ballEmailSends.gameId),
        isNotNull(ballEmailSends.playerId),
      ))
      .orderBy(ballEmailSends.firstClickedAt);
    const summary = {
      scanned: rows.length,
      inserted: 0,
      skipped_existing: 0,
      skipped_no_waiver: 0,
      skipped_host: 0,
      skipped_game_closed: 0,
      errors: 0,
    };

    for (const row of rows) {
      // isNotNull guards in the WHERE clause ensure these are non-null at runtime.
      const playerId = row.playerId!;
      const gameId = row.gameId!;
      const lastClickLink = row.lastClickLink!;
      const firstClickedAt = row.firstClickedAt!;

      try {
        const result = await recordRsvp({
          playerId,
          gameId,
          status: lastClickLink as 'in' | 'out' | 'maybe',
          source: 'email-click-backfill',
          respondedAt: firstClickedAt,
          allowOverwrite: false,
        });

        switch (result.outcome) {
          case 'recorded':
            summary.inserted++;
            await logAudit('ball-backfill', {
              category: 'ball',
              event_type: 'rsvp_backfilled',
              severity: 'info',
              actor_id: playerId,
              channel: 'admin-backfill',
              summary: `Backfilled RSVP ${lastClickLink.toUpperCase()} for player ${playerId} game ${gameId} (sendId: ${row.id})`,
              detail: { sendId: row.id, playerId, gameId, status: lastClickLink, firstClickedAt },
              status: 'success',
            });
            break;
          case 'skipped_existing':
            summary.skipped_existing++;
            await logAudit('ball-backfill', {
              category: 'ball',
              event_type: 'rsvp_backfill_skipped_existing',
              severity: 'info',
              actor_id: playerId,
              channel: 'admin-backfill',
              summary: `Backfill skipped — RSVP already exists for player ${playerId} game ${gameId}`,
              detail: { sendId: row.id, playerId, gameId },
              status: 'skipped',
            });
            break;
          case 'skipped_no_waiver':
            summary.skipped_no_waiver++;
            await logAudit('ball-backfill', {
              category: 'ball',
              event_type: 'rsvp_backfill_skipped_no_waiver',
              severity: 'info',
              actor_id: playerId,
              channel: 'admin-backfill',
              summary: `Backfill skipped — no waiver for player ${playerId} (sendId: ${row.id})`,
              detail: { sendId: row.id, playerId, gameId },
              status: 'skipped',
            });
            break;
          case 'skipped_host':
            summary.skipped_host++;
            await logAudit('ball-backfill', {
              category: 'ball',
              event_type: 'rsvp_backfill_skipped_host',
              severity: 'info',
              actor_id: playerId,
              channel: 'admin-backfill',
              summary: `Backfill skipped — player is host (sendId: ${row.id})`,
              detail: { sendId: row.id, playerId, gameId },
              status: 'skipped',
            });
            break;
          case 'skipped_game_closed':
            summary.skipped_game_closed++;
            await logAudit('ball-backfill', {
              category: 'ball',
              event_type: 'rsvp_backfill_skipped_game_closed',
              severity: 'info',
              actor_id: playerId,
              channel: 'admin-backfill',
              summary: `Backfill skipped — game is closed (gameId: ${gameId}, sendId: ${row.id})`,
              detail: { sendId: row.id, playerId, gameId },
              status: 'skipped',
            });
            break;
          default:
            break;
        }
      } catch (rowErr) {
        summary.errors++;
        console.error('[ball/backfill] row error:', row.id, rowErr instanceof Error ? rowErr.message : rowErr);
      }
    }

    await logAudit('ball-backfill', {
      category: 'ball',
      event_type: 'backfill_complete',
      severity: 'info',
      actor_id: 'admin',
      channel: 'admin-backfill',
      summary: `Email-click RSVP backfill complete — scanned ${summary.scanned}, inserted ${summary.inserted}, skipped ${summary.skipped_existing} existing`,
      detail: summary,
      status: 'success',
    });

    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[ball/backfill] error:', err);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

// Admin: headline blast summary for one game.
//
// Returns the numbers Tony actually scans first ("did the blast land?
// how many opened? how many RSVP'd?") so the admin overview doesn't
// have to drill into the per-dad engagement view to answer that.
//
// Predicate matches the engagement endpoint: a send "belongs" to the
// given game if game_id matches it directly, OR it's a NULL-game-id
// month-invite (those cover every upcoming game in one email).
//
// Apple-Mail Privacy opens are flagged separately because they are a
// well-known false-positive source — Apple prefetches the open pixel
// even if the user never reads the email.
router.get('/api/ball/admin/blast-summary', requireAuth, requireAdmin, async (req, res) => {
  try {
    const gameId = String(req.query.gameId ?? '').trim();
    if (!gameId || !/^[0-9a-f-]{36}$/i.test(gameId)) {
      res.status(400).json({ error: 'gameId query param required (uuid)' });
      return;
    }

    // Active non-host recipients (the universe the blast targeted).
    const recipients = await db
      .select({ id: ballPlayers.id })
      .from(ballPlayers)
      .where(and(eq(ballPlayers.active, true), eq(ballPlayers.isHost, false)));
    const recipientIds = recipients.map(r => r.id);

    // Email-send aggregates for sends relevant to this game. Same
    // predicate as /api/ball/admin/game/:id/engagement — keeps the
    // two views consistent.
    type BlastAggregateRow = {
      total_sent: number;
      total_delivered: number;
      total_opened: number;
      total_clicked: number;
      total_bounced: number;
      apple_mail_flagged: number;
      blast_sent_at: string | Date | null;
    };
    let aggRow: BlastAggregateRow | null = null;
    if (recipientIds.length > 0) {
      const recipientIdsArrayLiteral = `{${recipientIds.join(',')}}`;
      const aggResult = await db.execute(sql`
        SELECT
          COUNT(*)::int                                                              AS total_sent,
          SUM(CASE WHEN sent_at IS NOT NULL AND bounced_at IS NULL THEN 1 ELSE 0 END)::int AS total_delivered,
          SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END)::int                AS total_opened,
          SUM(CASE WHEN first_clicked_at IS NOT NULL THEN 1 ELSE 0 END)::int         AS total_clicked,
          SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END)::int               AS total_bounced,
          SUM(CASE
            WHEN user_agent_first_open IS NOT NULL
             AND user_agent_first_open ~* 'Mail.*iPhone|Mail.*Macintosh|MailPrivacyProtection'
            THEN 1 ELSE 0 END)::int                                                  AS apple_mail_flagged,
          MAX(sent_at)                                                               AS blast_sent_at
        FROM ball_email_sends
        WHERE player_id = ANY(${recipientIdsArrayLiteral}::uuid[])
          AND (game_id = ${gameId}::uuid OR (game_id IS NULL AND template = 'month-invite'))
      `);
      aggRow = ((aggResult as unknown as { rows?: BlastAggregateRow[] }).rows ?? [])[0] ?? null;
    }

    // RSVP rollup for this game.
    const rsvpAgg = await db.execute(sql`
      SELECT
        SUM(CASE WHEN status = 'in' THEN 1 ELSE 0 END)::int    AS rsvp_yes,
        SUM(CASE WHEN status = 'out' THEN 1 ELSE 0 END)::int   AS rsvp_no,
        SUM(CASE WHEN status = 'maybe' THEN 1 ELSE 0 END)::int AS rsvp_maybe
      FROM ball_rsvps
      WHERE game_id = ${gameId}::uuid
    `);
    const rsvpRow = ((rsvpAgg as unknown as { rows?: Array<{ rsvp_yes: number; rsvp_no: number; rsvp_maybe: number }> }).rows ?? [])[0]
      ?? { rsvp_yes: 0, rsvp_no: 0, rsvp_maybe: 0 };

    const totalSent = Number(aggRow?.total_sent ?? 0);
    const totalDelivered = Number(aggRow?.total_delivered ?? 0);
    const totalOpened = Number(aggRow?.total_opened ?? 0);
    const totalClicked = Number(aggRow?.total_clicked ?? 0);
    const totalBounced = Number(aggRow?.total_bounced ?? 0);
    const appleMailFlagged = Number(aggRow?.apple_mail_flagged ?? 0);
    const totalRsvpYes = Number(rsvpRow.rsvp_yes ?? 0);
    const totalRsvpNo = Number(rsvpRow.rsvp_no ?? 0);
    const totalRsvpMaybe = Number(rsvpRow.rsvp_maybe ?? 0);
    const totalResponded = totalRsvpYes + totalRsvpNo + totalRsvpMaybe;
    const totalNoResponse = Math.max(0, recipientIds.length - totalResponded);

    const pct = (n: number, d: number) =>
      d > 0 ? Math.round((n / d) * 1000) / 10 : 0;

    res.json({
      gameId,
      recipientCount: recipientIds.length,
      blastSentAt: aggRow?.blast_sent_at
        ? new Date(aggRow.blast_sent_at as string | Date).toISOString()
        : null,
      totalSent,
      totalDelivered,
      totalOpened,
      totalClicked,
      totalBounced,
      totalRsvpYes,
      totalRsvpNo,
      totalRsvpMaybe,
      totalNoResponse,
      openRatePercent: pct(totalOpened, totalDelivered),
      clickRatePercent: pct(totalClicked, totalDelivered),
      responseRatePercent: pct(totalResponded, recipientIds.length),
      appleMailFlagged,
    });
  } catch (err) {
    console.error('[ball/admin/blast-summary] error:', err);
    res.status(500).json({ error: 'Failed to load blast summary' });
  }
});

// Admin: send month invite to everyone (or a subset)
router.post('/api/ball/admin/send-month-invite', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { recipientIds } = req.body ?? {};
    const result = await blastMonthInvite(
      Array.isArray(recipientIds) ? { recipientIds } : {},
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ball/admin/send-month-invite] error:', err);
    res.status(500).json({ error: 'Blast failed' });
  }
});

// Admin: resend the month-invite to ONE or A FEW specific dads.
//
// Distinct from /send-month-invite because the intent is different:
// "I just had a dad message me to say they didn't get the email"
// (spam-filter false positive) — Tony needs to re-fire ONLY for the
// affected dads without re-blasting all 49. Body REQUIRES a
// non-empty playerIds[] to make accidental "resend to everyone"
// impossible from this endpoint.
//
// dryRun:true is honored end-to-end so the admin UI can show a
// preview ("this will send to 2 dads — go ahead?") before hitting
// the real send.
router.post('/api/ball/admin/resend-month-invite', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { playerIds, dryRun } = req.body ?? {};
    if (!Array.isArray(playerIds) || playerIds.length === 0) {
      res.status(400).json({ error: 'playerIds[] required (non-empty)' });
      return;
    }
    // Canonical UUID shape: 8-4-4-4-12 hex. Stricter than /^[0-9a-f-]{36}$/i
    // which would have accepted nonsense like 36 hyphens. Catches typos before
    // we hand the values to a parameterized SQL query.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!playerIds.every((id: unknown) => typeof id === 'string' && UUID_RE.test(id))) {
      res.status(400).json({ error: 'playerIds[] must all be uuids' });
      return;
    }
    const result = await blastMonthInvite({
      recipientIds: playerIds,
      dryRun: !!dryRun,
    });
    logAudit('ball-admin', {
      event_type: 'resend_month_invite',
      severity: 'info',
      status: 'success',
      summary: `Resent month invite to ${result.recipients} dad(s)${dryRun ? ' (dry run)' : ''}`,
      detail: { playerIds, dryRun: !!dryRun, ...result },
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
    res.json({ ok: true, dryRun: !!dryRun, ...result });
  } catch (err) {
    console.error('[ball/admin/resend-month-invite] error:', err);
    res.status(500).json({ error: 'Resend failed' });
  }
});

/**
 * GET /api/ball/admin/audit?limit=50
 *
 * Returns the most recent ball-related audit rows so the admin panel
 * can show a live activity feed (who did what, when). We filter on
 * `edge_function LIKE 'ball-%'` because every ball logAudit() call
 * uses that namespace (ball-admin / ball-rsvp / ball-waiver /
 * ball-cleanup / ball-cron).
 */
router.get('/api/ball/admin/audit', requireAuth, requireAdmin, async (req, res) => {
  try {
    const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

    const rows = await db.execute(sql`
      SELECT id, created_at, edge_function, event_type, severity, status,
             actor_name, actor_role, summary, detail, duration_ms, correlation_id
      FROM system_audit_log
      WHERE edge_function LIKE 'ball-%'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    res.json({
      ok: true,
      count: rows.rows.length,
      events: rows.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        createdAt: r.created_at,
        edgeFunction: r.edge_function,
        eventType: r.event_type,
        severity: r.severity,
        status: r.status,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        summary: r.summary,
        detail: r.detail,
        durationMs: r.duration_ms,
        correlationId: r.correlation_id,
      })),
    });
  } catch (err) {
    console.error('[ball/admin/audit] error:', err);
    res.status(500).json({ error: 'Audit fetch failed' });
  }
});

router.patch('/api/ball/admin/players/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, notes, active } = req.body ?? {};
    const patch: Partial<BallPlayer> = { updatedAt: new Date() };
    if (name !== undefined) patch.name = name;
    if (email !== undefined) patch.email = email;
    if (phone !== undefined) patch.phone = phone;
    if (notes !== undefined) patch.notes = notes;
    if (active !== undefined) patch.active = active;
    await db.update(ballPlayers).set(patch).where(eq(ballPlayers.id, String(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    console.error('[ball/admin/players] patch error:', err);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/api/ball/admin/players/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Soft-delete: just deactivate
    await db
      .update(ballPlayers)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(ballPlayers.id, String(req.params.id)));
    res.json({ ok: true });
  } catch (err) {
    console.error('[ball/admin/players] delete error:', err);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Revoke a player's active waiver — used when a dad asks to be removed
// or the admin wants to force a re-sign. Marks every active waiver row
// for this player (all versions) as revoked. The player will see the
// gate on their next RSVP attempt.
router.post(
  '/api/ball/admin/players/:id/revoke-waiver',
  // True two-factor on a legally binding e-signature: BOTH the
  // machine-level Computer Token AND a verified Google admin JWT/
  // session cookie are required. requireAuthStrictAdmin (unlike
  // requireAuth) does NOT honor the computer-token or cron-secret
  // shortcuts, so the token alone is insufficient — a stolen admin
  // cookie alone is also insufficient. Both must be present.
  requireComputerToken,
  requireAuthStrictAdmin,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const playerId = String(req.params.id);
      const result = await db
        .update(ballWaivers)
        .set({ revokedAt: new Date() })
        .where(and(
          eq(ballWaivers.playerId, playerId),
          sql`${ballWaivers.revokedAt} IS NULL`,
        ))
        .returning({ id: ballWaivers.id });
      logAudit('ball-admin', {
        category: 'ball',
        event_type: 'waiver_revoked',
        severity: 'info',
        actor_id: req.userId ?? 'admin',
        actor_name: 'Host',
        channel: 'admin-ui',
        summary: `Revoked Ball waiver(s) for player ${playerId}`,
        detail: { playerId, revokedCount: result.length },
        status: 'success',
      });
      res.json({ ok: true, revoked: result.length });
    } catch (err) {
      console.error('[ball/admin/revoke-waiver] error:', err);
      res.status(500).json({ error: 'Revoke failed' });
    }
  },
);

function randomToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ─────────────────────────────────────────────────────────────
// CRON endpoints — all gated by requireAuth (CRON_SECRET aware)
// ─────────────────────────────────────────────────────────────

// Find a game by the date offset from today. offsetDays=0 means today,
// offsetDays=2 means the Wednesday two days away from Monday, etc.
async function findGameForDate(targetIso: string): Promise<BallGame | null> {
  const [g] = await db.select().from(ballGames).where(eq(ballGames.gameDate, targetIso)).limit(1);
  return g ?? null;
}

// CRON — Start of each month: send the multi-game month invite to all
// active non-host players. Idempotent: skips if any upcoming game already
// has inviteSentAt stamped this month.
router.post('/api/ball/cron/send-month-invite', requireAuth, async (_req, res) => {
  // Find earliest upcoming game; if it already has inviteSentAt within
  // the last 25 days, skip (already blasted this month).
  const today = todayIsoPT();
  const [next] = await db
    .select()
    .from(ballGames)
    .where(and(
      gte(ballGames.gameDate, today),
      sql`${ballGames.status} IN ('scheduled','on')`,
    ))
    .orderBy(ballGames.gameDate)
    .limit(1);
  if (!next) {
    res.json({ ok: true, skipped: true, reason: 'no upcoming games' });
    return;
  }
  if (next.inviteSentAt) {
    const sentAt = new Date(next.inviteSentAt);
    const daysSince = (Date.now() - sentAt.getTime()) / 86400000;
    if (daysSince < 25) {
      res.json({ ok: true, skipped: true, reason: 'already sent', daysSince });
      return;
    }
  }
  const result = await blastMonthInvite();
  res.json({ ok: true, ...result });
});

// CRON — Wednesday 9am: day-of hard re-confirm for tonight's game
router.post('/api/ball/cron/reconfirm', requireAuth, async (_req, res) => {
  const targetIso = todayIsoPT();
  const game = await findGameForDate(targetIso);
  if (!game) {
    res.json({ ok: true, skipped: true, reason: 'no game today' });
    return;
  }
  if (game.status === 'off' || game.status === 'done') {
    res.json({ ok: true, skipped: true, reason: `game is ${game.status}` });
    return;
  }
  if (game.reconfirmSentAt) {
    res.json({ ok: true, skipped: true, reason: 'already reconfirmed today' });
    return;
  }
  const result = await blastReconfirm(game.id);
  res.json({ ok: true, ...result });
});

// (Legacy) per-game single-invite cron — still exposed for one-off blasts
router.post('/api/ball/cron/send-invites', requireAuth, async (_req, res) => {
  res.json({ ok: true, deprecated: true, message: 'Use /send-month-invite instead' });
});

router.post('/api/ball/cron/decide', requireAuth, async (_req, res) => {
  // Wednesday 11am — decide ON/OFF for today's game and notify confirmed
  const targetIso = todayIsoPT();
  const game = await findGameForDate(targetIso);
  if (!game) {
    res.json({ ok: true, skipped: true, reason: 'no game today' });
    return;
  }
  if (game.decisionSentAt) {
    res.json({ ok: true, skipped: true, reason: 'already decided' });
    return;
  }
  const detail = await getGameWithRsvps(game.id);
  if (!detail) {
    res.status(500).json({ error: 'game lookup failed' });
    return;
  }
  const goingOn = detail.confirmed.length >= game.minPlayers;
  const newStatus = goingOn ? 'on' : 'off';
  await db
    .update(ballGames)
    .set({ status: newStatus, decisionSentAt: new Date(), updatedAt: new Date() })
    .where(eq(ballGames.id, game.id));

  // Notify everyone who RSVP'd in (skip host, skip declined)
  const confirmedNonHost = detail.confirmed.filter(c => !c.isHost);
  const recipients = confirmedNonHost;
  let sent = 0, failed = 0;
  for (const r of recipients) {
    const player = await db.select().from(ballPlayers).where(eq(ballPlayers.id, r.playerId)).limit(1);
    if (!player[0]) continue;
    const tmpl = goingOn
      ? buildDecisionOnEmail({
          playerName: player[0].name,
          playerToken: player[0].token,
          gameDateIso: game.gameDate,
          gameStart: game.startTime,
          gameEnd: game.endTime,
          notes: game.notes,
          confirmedCount: detail.confirmed.length,
          confirmedNames: detail.confirmed.map(c => c.name),
          gameId: game.id,
        })
      : buildDecisionOffEmail({
          playerName: player[0].name,
          playerToken: player[0].token,
          gameDateIso: game.gameDate,
          gameStart: game.startTime,
          gameEnd: game.endTime,
        });
    const tracked = await sendTrackedBallEmail({
      playerId: player[0].id,
      gameId: game.id,
      template: goingOn ? 'decision-on' : 'decision-off',
      to: player[0].email,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
    });
    if (tracked.ok) sent++; else failed++;
  }
  res.json({ ok: true, status: newStatus, confirmed: detail.confirmed.length, sent, failed });
});

router.post('/api/ball/cron/email-gate', requireAuth, async (_req, res) => {
  // Wednesday noon (~6h before the 6pm game) — email the confirmed guest
  // roster to the household and BCC the gatehouse. Runs after the ON/OFF
  // decision (11am) so the roster always reflects a finalized game.
  const targetIso = todayIsoPT();
  const game = await findGameForDate(targetIso);
  if (!game) {
    res.json({ ok: true, skipped: true, reason: 'no game today' });
    return;
  }
  if (game.status !== 'on') {
    res.json({ ok: true, skipped: true, reason: `game is ${game.status}` });
    return;
  }
  const result = await sendGateRosterEmail(game.id);
  if (!result.ok) {
    // Return non-2xx so triggerRoute / cron monitoring registers a real failure.
    res.status(502).json({ ok: false, guests: result.guests, bcc: result.bcc, error: result.error });
    return;
  }
  res.json({ ok: true, guests: result.guests, bcc: result.bcc });
});

router.post('/api/ball/cron/remind', requireAuth, async (_req, res) => {
  // Wednesday 5:30pm — final reminder to confirmed dads
  const targetIso = todayIsoPT();
  const game = await findGameForDate(targetIso);
  if (!game) {
    res.json({ ok: true, skipped: true, reason: 'no game today' });
    return;
  }
  if (game.status !== 'on') {
    res.json({ ok: true, skipped: true, reason: `game is ${game.status}` });
    return;
  }
  if (game.reminderSentAt) {
    res.json({ ok: true, skipped: true, reason: 'already reminded' });
    return;
  }
  const detail = await getGameWithRsvps(game.id);
  if (!detail) {
    res.status(500).json({ error: 'game lookup failed' });
    return;
  }
  const confirmedNonHost = detail.confirmed.filter(c => !c.isHost);
  let sent = 0, failed = 0;
  for (const r of confirmedNonHost) {
    const [player] = await db.select().from(ballPlayers).where(eq(ballPlayers.id, r.playerId)).limit(1);
    if (!player) continue;
    const tmpl = buildReminderEmail({
      playerName: player.name,
      playerToken: player.token,
      gameDateIso: game.gameDate,
      gameStart: game.startTime,
      gameEnd: game.endTime,
    });
    const r2 = await sendTrackedBallEmail({
      playerId: player.id,
      gameId: game.id,
      template: 'reminder',
      to: player.email,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
    });
    if (r2.ok) sent++; else failed++;
  }
  await db
    .update(ballGames)
    .set({ reminderSentAt: new Date(), updatedAt: new Date() })
    .where(eq(ballGames.id, game.id));
  res.json({ ok: true, sent, failed });
});

// ─────────────────────────────────────────────────────────────
// One-time cleanup: task #270 — remove Brian Recker's 4 test RSVPs
// and ensure the Jun 3 game is back to 'scheduled'.
//
// Background: 4 RSVPs were written for Brian Recker (player
// ede55502-cbe4-470c-bdea-e17771c8013c) on 2026-05-15 within 34
// seconds — manual testing before any real invite blast. They are
// not real intent. Jun 3 was also force-flipped to `on` without
// meeting the 6-player minimum.
//
// Safety design:
//  • system_configs flag checked first — returns immediately if set.
//  • Timestamp guard: only targets RSVPs with responded_at on 2026-05-15
//    so future legitimate RSVPs from Brian cannot be accidentally deleted.
//  • Delete scoped by player_id + game_id IN (...) + responded_at window.
//  • Jun 3 status revert + RSVP delete + flag all committed atomically.
//  • Flag is ALWAYS set after the first verification (whether clean or not)
//    so the hook permanently disarms itself and never re-runs.
//  • Separate audit entries for RSVP deletion and game status reset.
//  • In dev the delete is a no-op (dev DB has no Ball RSVPs).
// ─────────────────────────────────────────────────────────────
(async () => {
  const CLEANUP_FLAG = 'ball_test_rsvp_cleanup_v1_done';
  const BRIAN_PLAYER_ID = 'ede55502-cbe4-470c-bdea-e17771c8013c';
  const JUN3_GAME_ID = '82334f28-6cd8-4955-b7df-d03c174186ac';
  const JUNE_GAME_IDS = [
    JUN3_GAME_ID,                             // Jun 3
    '46cd5cba-7be2-4eee-8c78-ee929d550784',  // Jun 10
    '89f81450-8296-4495-992a-a2ef39e64191',  // Jun 17
    '721bf81f-36b3-4624-84db-aad1a60219c0',  // Jun 24
  ];
  // Tight timestamp window: the actual test session ran 04:48:04–04:48:38 UTC.
  // Padding to the nearest minute on each side catches the known rows and
  // nothing else — any RSVP outside this 3-minute window is left untouched.
  const TEST_WINDOW_START = new Date('2026-05-15T04:47:00Z');
  const TEST_WINDOW_END   = new Date('2026-05-15T04:49:00Z');

  try {
    // Guard: skip immediately if cleanup already ran on a prior startup.
    const [existing] = await db
      .select()
      .from(systemConfigs)
      .where(eq(systemConfigs.key, CLEANUP_FLAG))
      .limit(1);
    if (existing) return;

    // Environment guard: this is a production data cleanup; in non-production
    // environments the target RSVPs won't exist and the delete is a no-op,
    // but log clearly so it's visible during local dev/testing.
    const isProduction = process.env.NODE_ENV === 'production';
    if (!isProduction) {
      console.log('[ball-cleanup] Non-production environment — running dry (no real data to delete)');
    }

    // Pre-flight snapshot — log exactly what will be touched before any write.
    const rsvpRows = await db
      .select()
      .from(ballRsvps)
      .where(and(
        eq(ballRsvps.playerId, BRIAN_PLAYER_ID),
        inArray(ballRsvps.gameId, JUNE_GAME_IDS),
        gte(ballRsvps.respondedAt, TEST_WINDOW_START),  // tight timestamp window start
        lt(ballRsvps.respondedAt, TEST_WINDOW_END),     // tight timestamp window end
      ));

    const [jun3Game] = await db
      .select({ id: ballGames.id, status: ballGames.status })
      .from(ballGames)
      .where(eq(ballGames.id, JUN3_GAME_ID))
      .limit(1);

    console.log('[ball-cleanup] Pre-flight RSVPs to delete:', JSON.stringify(
      rsvpRows.map(r => ({ id: r.id, gameId: r.gameId, status: r.status, respondedAt: r.respondedAt }))
    ));
    console.log('[ball-cleanup] Pre-flight Jun 3 status:', jun3Game?.status ?? 'not found');

    const needsRsvpDelete = rsvpRows.length > 0;
    const needsStatusRevert = jun3Game?.status === 'on';

    // Atomic transaction: delete RSVPs + optional Jun 3 status revert + flag.
    // Flag is ALWAYS committed here — disarms the hook permanently regardless
    // of whether there was anything to delete (prevents future false triggers).
    await db.transaction(async (tx) => {
      if (needsRsvpDelete) {
        await tx
          .delete(ballRsvps)
          .where(and(
            eq(ballRsvps.playerId, BRIAN_PLAYER_ID),
            inArray(ballRsvps.gameId, JUNE_GAME_IDS),
            gte(ballRsvps.respondedAt, TEST_WINDOW_START),
            lt(ballRsvps.respondedAt, TEST_WINDOW_END),
          ));
      }

      if (needsStatusRevert) {
        await tx
          .update(ballGames)
          .set({ status: 'scheduled', updatedAt: new Date() })
          .where(eq(ballGames.id, JUN3_GAME_ID));
      }

      await tx
        .insert(systemConfigs)
        .values({
          key: CLEANUP_FLAG,
          value: 'true',
          description: 'Task #270: Brian Recker test RSVP cleanup — pre-blast data from 2026-05-15',
        })
        .onConflictDoUpdate({ target: systemConfigs.key, set: { value: 'true', updatedAt: new Date() } });
    });

    // Audit entries after the transaction commits (awaited for durability).
    if (needsRsvpDelete) {
      await logAudit('ball-cleanup', {
        category: 'ball',
        event_type: 'rsvp_admin_reset',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'Planning cleanup (task #270)',
        channel: 'server-startup',
        summary: `Deleted ${rsvpRows.length} test RSVP(s) for Brian Recker — pre-blast test data from 2026-05-15`,
        detail: {
          player_id: BRIAN_PLAYER_ID,
          player_name: 'Brian Recker',
          deleted_rows: rsvpRows.map(r => ({ id: r.id, gameId: r.gameId, status: r.status, respondedAt: r.respondedAt })),
          reason: 'RSVPs written within 34 s on 2026-05-15 before any invite blast; not real intent',
        },
        status: 'success',
      });
    }

    if (needsStatusRevert) {
      await logAudit('ball-cleanup', {
        category: 'ball',
        event_type: 'game_status_reset',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'Planning cleanup (task #270)',
        channel: 'server-startup',
        summary: 'Jun 3 game status reverted on → scheduled (task #270 cleanup)',
        detail: {
          game_id: JUN3_GAME_ID,
          game_date: '2026-06-03',
          previous_status: 'on',
          new_status: 'scheduled',
          reason: 'Force-ON applied via admin UI on 2026-05-16 without 6-player minimum met',
        },
        status: 'success',
      });
    }

    console.log(
      `[ball-cleanup] Done — deleted ${rsvpRows.length} RSVP(s), Jun 3 revert: ${needsStatusRevert ? 'yes (on→scheduled)' : 'skipped (already scheduled)'}`
    );
  } catch (err) {
    console.error('[ball-cleanup] ERROR running test RSVP cleanup:', err);
  }
})();

export default router;
