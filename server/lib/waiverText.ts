/**
 * Club34 Ball — liability waiver text + version metadata.
 *
 * Authoritative location per issue #74: server-only. The frontend
 * receives the text via the API (/api/ball/me/:token and the 400
 * waiver_required body) so the on-screen copy always matches the
 * version recorded in ball_waivers.
 *
 * WAIVER_V1_HASH is sha256 of WAIVER_V1, computed once at import,
 * so we can prove integrity of the signed text if anyone disputes it.
 * Bumping WAIVER_VERSION to "v2" (and adding the new text below) is
 * what forces everyone to re-sign on their next RSVP — the partial
 * unique index `one_active_waiver` on (player_id, waiver_version)
 * keeps each version's signature distinct.
 */

import { createHash } from 'node:crypto';

export const WAIVER_VERSION = 'v1' as const;

export const WAIVER_V1 = `Pickup Basketball — Participant Liability Waiver

Heads-up: basketball can lead to injuries. Sprained ankles, jammed fingers, pulled muscles, falls, collisions — they happen even in friendly games. By RSVPing yes, you're acknowledging that and agreeing to a few simple things:

1. I'm playing because I want to, at my own risk.
I'm in good enough health to play half-court basketball. If I'm not feeling it physically that day, I'll sit out or leave. I won't blame anyone else for injuries that happen during normal play.

2. I won't sue the organizer, their family, or other players.
I release the event organizer, their household, and the other players from any claims for ordinary injuries that come from playing — whether from my own actions or someone else's during the game.

3. I'm responsible for my own medical costs.
My health insurance covers me. I'm not expecting the host or anyone else to pay if I get hurt.

4. I understand this doesn't cover gross negligence.
If someone deliberately or recklessly causes harm, this waiver doesn't apply — California law (Civil Code §1668) doesn't allow waiving that, and I'm not trying to.

5. This applies every time I play, until I inform the organizer otherwise.
I don't need to re-sign before each game. If I want to revoke this, I'll email organizer@example.com.

By tapping "I agree and RSVP," I'm electronically signing this waiver under the federal E-SIGN Act and California UETA.`;

export const WAIVER_V1_HASH = createHash('sha256').update(WAIVER_V1, 'utf8').digest('hex');

export function getActiveWaiverText(version: string = WAIVER_VERSION): string {
  if (version === 'v1') return WAIVER_V1;
  throw new Error(`Unknown waiver version: ${version}`);
}
