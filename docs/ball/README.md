# Club34 Ball — System README

A practical reference for the Wednesday Night Ball platform: dads, waivers, RSVPs, weekly games, automations, and admin tooling.

Audience: future maintainers, future agents, future contributors. If you only have 60 seconds, skim **Architecture overview** and **Troubleshooting**.

---

## Architecture overview

```
   ┌─────────────┐    monthly blast    ┌──────────────────┐    sign + RSVP    ┌──────────────┐
   │  Host /     │ ─────────────────▶  │  Dad's inbox     │ ────────────────▶ │  Dad's RSVP  │
   │  cron job   │                     │  (4 games at     │                   │  page        │
   └─────────────┘                     │   once)          │                   │  /ball/p/<t> │
        │                              └──────────────────┘                   └──────┬───────┘
        │                                                                            │
        │                                                                            │
        ▼                                                                            ▼
   ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐
   │  ball_games     │  │  ball_email_sends│  │  ball_waivers    │  │  ball_rsvps              │
   │  (one per Wed)  │  │  (sent / opens / │  │  (e-sign         │  │  (per game ×             │
   │                 │  │   clicks)        │  │   versioned)     │  │   player: in/out/maybe)  │
   └─────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────────────┘
        │                                                                            │
        │                                       2pm Wed: decide                      │
        │ ◀───────────────────────── if confirmed >= minPlayers ───────────────────  │
        │                                                                            │
        ▼                                                                            ▼
   ┌─────────────────┐                                                       ┌──────────────┐
   │  status: on/off │  ───────── push roster to ────────────────────────▶   │  GoAccess    │
   │                 │             gatehouse                                  │  gate check  │
   └─────────────────┘                                                       └──────────────┘
```

Identity flow: every dad has a personal `token` (8-char lowercase alphanumeric). Their RSVP page lives at `/ball/p/<token>`. No login — the token in the URL is the auth. First time they click an RSVP link they sign a one-tap e-waiver; after that every future RSVP is one click.

---

## Cron schedule

All cron jobs are mounted at `POST /api/ball/cron/<name>` and authenticated by the internal cron token. They're idempotent: re-running won't double-send.

| Cron path | Schedule (PT) | What it does | Skip rules |
|---|---|---|---|
| `/api/ball/cron/send-month-invite` | Sunday 4:00 PM | If the next upcoming game has no `invite_sent_at`, fires `blastMonthInvite` to every active non-host dad with the next ~4 Wednesdays in one email | Skips if already sent in last 25 days |
| `/api/ball/cron/reconfirm` | Wednesday 9:00 AM | Day-of hard re-confirm to anyone who said "in" earlier — re-tags them as `pending_reconfirm` until they click again | Skips if no game today, game is off/done, or already sent |
| `/api/ball/cron/decide` | Wednesday 2:00 PM | Flips today's game to `on` if confirmed ≥ `min_players` (6), else `off`. Sends decision email to everyone who confirmed | Skips if already decided |
| `/api/ball/cron/sync-gate` | Wednesday ~3:00 PM | Pushes confirmed (and host) roster to GoAccess for tonight's gatehouse check-in | Skips if no game today |
| `/api/ball/cron/remind` | (legacy / on-demand) | Free-form reminder blast — manual only now | — |

Manual blast endpoints (admin-only) live alongside these but are NOT on a schedule: `/api/ball/admin/send-month-invite`, `/api/ball/admin/games/:id/send-invite-blast`, `/api/ball/admin/games/:id/send-decision-email`.

---

## Email templates

All templates live in `server/lib/ballEmails.ts`. Subject lines and HTML are stable — touching them mid-RSVP window is dangerous.

| Template | Subject (approx) | When it fires | Trigger |
|---|---|---|---|
| `month-invite` | "Wednesday Night Ball — next 4 weeks" | Sunday 4pm cron, or manual blast | `buildMonthInviteEmail` |
| `invite` (per-game, legacy) | "Wednesday Night Ball — <date>" | Manual per-game blast | `buildInviteEmail` |
| `reconfirm` | "Confirm you're still in tonight" | Wed 9am cron | `buildReconfirmEmail` |
| `decision-on` | "It's ON tonight 🏀" | Wed 2pm cron, if min_players met | `buildDecisionOnEmail` |
| `decision-off` | "Not enough dads tonight — calling it" | Wed 2pm cron, if short | `buildDecisionOffEmail` |

Every email goes through `sendTrackedBallEmail`, which inserts a row into `ball_email_sends` and rewrites every outbound link through `/api/ball/track/click/<id>` (302 redirect) and embeds a 1×1 `/api/ball/track/open/<id>.gif` pixel. Apple Mail Privacy pre-fetches are detected via user-agent and flagged on the engagement view.

---

## Admin endpoints

All admin routes require `requireAuth + requireAdmin` (Host Admin JWT). The Computer Agent uses a separate `X-Computer-Token` header for machine-to-machine writes.

### Read endpoints

| Method + path | What it returns |
|---|---|
| `GET /api/ball/admin/overview` | All games with RSVP counts + summary roster (id, name, email, token, host, waiver state, recent open/click timestamps) |
| `GET /api/ball/admin/players` | Full roster with phone, jersey, RSVP rollups, last-responded timestamp |
| `GET /api/ball/admin/game/:id` | Per-game detail: confirmed / declined / maybe / no-response lists |
| `GET /api/ball/admin/game/:id/engagement` | Per-dad rollup for one game: sent / delivered / opened / clicked / RSVP, with most recent send per template |
| `GET /api/ball/admin/blast-summary?gameId=<uuid>` | Headline numbers for a single blast: totals + rates + Apple-Mail flag count |
| `GET /api/ball/admin/audit?limit=50` | Last N `system_audit_log` rows with `category='ball'`, newest first |

### Write endpoints

| Method + path | Body | Effect |
|---|---|---|
| `POST /api/ball/admin/players` | `{name, email, phone?, sendInvite?:bool}` | Adds a new dad; auto-fires month-invite unless `sendInvite:false` |
| `POST /api/ball/admin/games` | `{gameDate, startTime, endTime, minPlayers?, notes?}` | Schedules a new Wednesday |
| `POST /api/ball/admin/game/:id/force-status` | `{status:'on'\|'off'\|'scheduled'}` | Overrides the cron decision |
| `POST /api/ball/admin/game/:id/attendance` | `{playerId, showedUp:bool}` | After-the-fact attendance mark |
| `POST /api/ball/admin/game/:id/send-invite` | — | Re-fires the per-game legacy invite (rarely used) |
| `POST /api/ball/admin/games/:id/send-invite-blast` | `{recipientIds?:string[], dryRun?:bool}` | Fires the per-game invite blast to all or specified dads |
| `POST /api/ball/admin/games/:id/send-decision-email` | — | Manual on/off decision blast |
| `POST /api/ball/admin/game/:id/sync-goaccess` | — | Manual gate-sync trigger |
| `POST /api/ball/admin/send-month-invite` | `{recipientIds?:string[], gameIds?:string[], dryRun?:bool}` | The big blast — calls `blastMonthInvite` directly |
| `POST /api/ball/admin/resend-month-invite` | `{playerIds:string[], dryRun?:bool}` | Re-send the month invite to just a few specific dads (spam-filter recovery) |

### Curl examples

```bash
# See who opened/clicked tonight's blast
curl -H "X-Computer-Token: $COMPUTER_ADMIN_TOKEN" \
  https://example.com/api/ball/admin/game/<gameId>/engagement \
  | jq '.rows[] | {name, rsvpStatus, opened:(.sends[0].openCount > 0)}'

# Headline blast numbers
curl -H "X-Computer-Token: $COMPUTER_ADMIN_TOKEN" \
  "https://example.com/api/ball/admin/blast-summary?gameId=<gameId>"

# Dry-run a re-send to one dad before pulling the trigger
curl -X POST -H "X-Computer-Token: $COMPUTER_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"playerIds":["<uuid>"],"dryRun":true}' \
  https://example.com/api/ball/admin/resend-month-invite
```

---

## Data model

| Table | Purpose | Key columns |
|---|---|---|
| `ball_players` | One row per dad (and the host). | `id`, `name`, `email`, `phone`, `token`, `is_host`, `active`, `jersey_size` |
| `ball_games` | One row per scheduled Wednesday. | `id`, `game_date`, `start_time`, `end_time`, `status` (`scheduled`/`on`/`off`/`done`), `min_players` (6), `invite_sent_at`, `decision_sent_at`, `reconfirm_sent_at` |
| `ball_rsvps` | One row per (game × player) reply. | `game_id`, `player_id`, `status` (`in`/`out`/`maybe`/`pending_reconfirm`), `source`, `reconfirmed_at`, `responded_at` |
| `ball_waivers` | One row per signature event; versioned. | `player_id`, `waiver_version`, `signed_at`, `ip`, `user_agent`, `revoked_at` |
| `ball_email_sends` | One row per email actually sent (tracking + engagement). | `player_id`, `game_id`, `template`, `sent_at`, `opened_at`, `open_count`, `first_clicked_at`, `click_count`, `last_click_link`, `user_agent_first_open`, `bounce_reason` |
| `system_audit_log` (shared) | Cross-cutting event log; ball events tagged `category='ball'`. | `created_at`, `event_type`, `severity`, `actor_id`, `actor_name`, `summary`, `detail` (jsonb) |

---

## Common tasks

### Add a new dad

**UI:** Admin → Ball → Dads Roster → "Add dad" button (top-right). Name + email are required, phone optional. `sendInvite:true` by default so they get the month-invite immediately.

**SQL fallback (only if the API is down):**
```sql
INSERT INTO ball_players (name, email, token)
VALUES ('Firstname Lastname', 'them@example.com',
        substring(md5(random()::text), 1, 8));
```
Then manually trigger the resend endpoint described above to get them an invite.

### Skip a Wednesday

**UI:** Admin → Ball → click the game → "Force status: off". This sets `status='off'` and prevents the 2pm decide cron from re-evaluating.

```bash
curl -X POST -H "Content-Type: application/json" \
  -H "X-Computer-Token: $COMPUTER_ADMIN_TOKEN" \
  -d '{"status":"off"}' \
  https://example.com/api/ball/admin/game/<gameId>/force-status
```

### Revoke a waiver

NOT exposed in the browser UI on purpose — this is a high-impact action (it invalidates a legally-binding e-signature) and requires the Computer Token AND a Google admin JWT. Curl path only:

```bash
curl -X POST -H "Content-Type: application/json" \
  -H "X-Computer-Token: $COMPUTER_ADMIN_TOKEN" \
  -d '{"reason":"player request"}' \
  https://example.com/api/ball/admin/players/<playerId>/revoke-waiver
```

The audit log records who, when, and why. The dad will be re-prompted to sign on their next RSVP attempt.

---

## Troubleshooting

### "Dad says he didn't get the email"

1. Open the per-game **Engagement** view in the admin panel. If their row shows `sent_at` but no opens, it landed in spam — they need to add `no-reply@example.com` to contacts.
2. If `bounce_reason` is set, the email address is bad; fix it via Add/Edit dad and re-blast.
3. If `sent_at` is missing entirely, the send itself failed — check `system_audit_log` for that timestamp window.
4. Either way, use the **Resend** button on their roster row (or the `/api/ball/admin/resend-month-invite` endpoint) to fire a one-off rather than re-blasting all 49.

### "Game shows 0 confirmed but dads said they're coming"

Almost always one of:
- The Wed 9am `reconfirm` cron just ran and re-tagged everyone `pending_reconfirm`. They need to click again. This is by design.
- They RSVP'd to a different game id (e.g. the wrong week). Check `ball_rsvps` directly.
- They signed the waiver but never clicked a status button. The RSVP is gated behind a successful waiver POST.

### "Engagement endpoint 500s"

Usually a Drizzle binding issue with raw SQL — `ANY(${arr}::uuid[])` spreads as individual params instead of an array. Build a `{uuid1,uuid2,…}` string and bind it as a single parameter. See PR #101 for the canonical example.

### "Auto-cancel fired when dads were going to show"

The `decide` cron flips off if `confirmed < min_players` at 2pm. If you know dads will arrive late but didn't click yet, hit `force-status: on` BEFORE 2pm. Once `decision_sent_at` is set, force-status will still flip the game but the decision-off email is already out.

### "Dad clicked the link but can't RSVP"

Check the browser console on `/ball/p/<token>`. Common causes:
- Token doesn't match the roster anymore (dad was deactivated / renamed).
- They're trying to RSVP without ticking the waiver checkbox (the buttons are gated until checked).
- `pending_reconfirm` state — they need to re-click, not assume their old "in" still counts.

---

## When in doubt

- All admin actions write to `system_audit_log` — the audit feed in the admin panel is the source of truth for "what just happened?".
- The `EXTERNAL_API.md` reference covers the Computer Agent / external integration surface.
- Migrations live in `migrations/` and are applied automatically by Replit's Publish flow; never write hand-rolled migration scripts for production.
