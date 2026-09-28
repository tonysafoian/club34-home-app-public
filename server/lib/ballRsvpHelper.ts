/**
 * Club34 Ball — shared RSVP write helper
 *
 * Encapsulates the core RSVP write logic so it can be called from:
 *   - POST /api/ball/rsvp   (web-form, inside transaction for atomicity)
 *   - GET  /api/ball/track/click/:sendId  (email click auto-RSVP, best-effort)
 *   - POST /api/ball/admin/backfill-email-clicks (one-time backfill)
 *
 * The web form endpoint handles waiver acceptance, jersey size persistence, and
 * the RSVP write — all inside a single db.transaction(), passing tx as dbCtx so
 * every write is atomic.
 *
 * Email click and backfill paths cannot interactively accept a waiver, so they
 * receive skipped_no_waiver when the player has no active waiver.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import { ballPlayers, ballGames, ballRsvps, ballWaivers } from '../../shared/schema.js';
import { WAIVER_VERSION } from './waiverText.js';

// Extract the exact transaction type that drizzle infers for tx inside
// db.transaction(async (tx) => { ... }).  This means ball.ts can pass `tx`
// directly without any type cast.
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RsvpOutcome =
  | 'recorded'
  | 'skipped_no_waiver'
  | 'skipped_host'
  | 'skipped_game_closed'
  | 'skipped_existing';

export interface RecordRsvpOptions {
  playerId: string;
  gameId: string;
  status: 'in' | 'out' | 'maybe';
  source: string;
  /** Override timestamp — used by backfill to preserve original first_clicked_at */
  respondedAt?: Date;
  /**
   * true  (default) → always upsert, updating source/status so a later manual
   *   submission always supersedes a prior email-click in provenance.
   * false           → skip if any RSVP already exists for (player, game) (backfill).
   */
  allowOverwrite?: boolean;
  /**
   * Drizzle db or transaction context. Pass the drizzle tx from the web-form
   * transaction so waiver + jersey size + RSVP are fully atomic. Defaults to
   * the module-level db connection for standalone callers (click tracker,
   * backfill).
   */
  dbCtx?: DbOrTx;
}

export interface RecordRsvpResult {
  outcome: RsvpOutcome;
  playerId: string;
  gameId: string;
  status: string;
}

async function getActiveWaiverForPlayer(playerId: string, ctx: DbOrTx) {
  const [row] = await ctx
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

/**
 * Core RSVP write. Validates guards, computes reconfirmedAt, upserts ball_rsvps.
 *
 * allowOverwrite=true (default, used by web form and email click):
 *   Always upserts — even when status is unchanged — so source/updatedAt reflect
 *   the latest submission. Ensures a later manual web submission always supersedes
 *   an earlier email-click in source provenance.
 *
 * allowOverwrite=false (used by backfill):
 *   Returns skipped_existing immediately if any RSVP already exists.
 *   Never overwrites existing data.
 *
 * dbCtx defaults to module-level db. Pass a drizzle tx for atomic callers.
 */
export async function recordRsvp(opts: RecordRsvpOptions): Promise<RecordRsvpResult> {
  const { playerId, gameId, status, source, respondedAt, allowOverwrite = true } = opts;
  const ctx: DbOrTx = opts.dbCtx ?? db;

  const base: Pick<RecordRsvpResult, 'playerId' | 'gameId' | 'status'> = {
    playerId,
    gameId,
    status,
  };

  const [player] = await ctx
    .select()
    .from(ballPlayers)
    .where(and(eq(ballPlayers.id, playerId), eq(ballPlayers.active, true)))
    .limit(1);

  if (!player) {
    return { outcome: 'skipped_no_waiver', ...base };
  }

  if (player.isHost) {
    return { outcome: 'skipped_host', ...base };
  }

  const [game] = await ctx
    .select()
    .from(ballGames)
    .where(eq(ballGames.id, gameId))
    .limit(1);

  if (!game || game.status === 'done' || game.status === 'off') {
    return { outcome: 'skipped_game_closed', ...base };
  }

  const waiver = await getActiveWaiverForPlayer(playerId, ctx);
  if (!waiver) {
    return { outcome: 'skipped_no_waiver', ...base };
  }

  // Backfill mode: insert-only. Skip if any RSVP already exists.
  if (!allowOverwrite) {
    const [existing] = await ctx
      .select({ id: ballRsvps.id })
      .from(ballRsvps)
      .where(and(eq(ballRsvps.gameId, gameId), eq(ballRsvps.playerId, playerId)))
      .limit(1);

    if (existing) {
      return { outcome: 'skipped_existing', ...base };
    }

    // onConflictDoNothing makes the insert race-safe: if a concurrent web
    // RSVP or click sneaks in between the SELECT above and this INSERT, the
    // statement becomes a no-op (0 rows inserted) rather than an error.
    const inserted = await ctx
      .insert(ballRsvps)
      .values({
        gameId,
        playerId,
        status,
        source,
        reconfirmedAt: status === 'in' ? (respondedAt ?? new Date()) : null,
        respondedAt: respondedAt ?? new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: ballRsvps.id });

    if (inserted.length === 0) {
      return { outcome: 'skipped_existing', ...base };
    }
    return { outcome: 'recorded', ...base };
  }

  // Overwrite mode: always upsert so a later manual submission supersedes
  // an earlier auto-click. Reads existing to compute reconfirmedAt correctly.
  const [existing] = await ctx
    .select()
    .from(ballRsvps)
    .where(and(eq(ballRsvps.gameId, gameId), eq(ballRsvps.playerId, playerId)))
    .limit(1);

  let reconfirmedAt: Date | null | undefined;
  if (status === 'in') {
    if (!existing || existing.status === 'pending_reconfirm' || !existing.reconfirmedAt) {
      reconfirmedAt = new Date();
    } else {
      reconfirmedAt = existing.reconfirmedAt; // keep
    }
  } else {
    reconfirmedAt = null;
  }

  await ctx
    .insert(ballRsvps)
    .values({
      gameId,
      playerId,
      status,
      source,
      reconfirmedAt,
      respondedAt: respondedAt ?? new Date(),
    })
    .onConflictDoUpdate({
      target: [ballRsvps.gameId, ballRsvps.playerId],
      set: {
        status,
        reconfirmedAt,
        updatedAt: new Date(),
        source,
      },
    });

  return { outcome: 'recorded', ...base };
}
