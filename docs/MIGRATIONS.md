# Database migrations

Janus uses a small custom filename-based migration runner (`scripts/run-migrations.ts`)
that auto-applies any new `migrations/*.sql` file on server boot. This document
captures the workflow.

## TL;DR

- **Add a migration** → write a new `migrations/NNNN_descriptive_name.sql`
  file by hand using the next sequence number. Commit it.
- **Deploy / Boot** applies it automatically via `npm run migrate` during the
  start command (`npm start` or Docker container boot).
- **Each migration runs in a transaction.** If it fails, the deploy
  fails fast — the server doesn't start. Logs show the error.
- **Never edit an applied migration.** The runner detects checksum
  drift and warns, but the change won't re-apply. Write a follow-up
  migration instead.
- **`npm run db:push` is intentionally non-destructive.** The original
  `drizzle-kit push` is parked behind `npm run db:push:force`.

## Why custom (not drizzle-kit migrate)

`drizzle-orm/node-postgres/migrator` reads `migrations/meta/_journal.json`
to know which migration files exist. Our journal has only 1 of 15
entries — the team has been hand-writing raw SQL migrations and
never running `drizzle-kit generate`. So Drizzle-kit's migrator can't
see most of the files on disk.

The custom runner is intentionally simple:
- alphabetical filename → contract
- ledger keyed by filename → idempotency
- transaction per file → safety
- no journal → no drift between "what's on disk" and "what's tracked"

If we ever want to go back to Drizzle-kit, we can rebuild the journal
and the existing ledger keeps working — the two are independent.

## Adding a migration

1. Pick the next sequence number — look at `migrations/` and increment
   the highest `NNNN_` prefix.
2. Write `migrations/NNNN_short_name.sql`. Use `IF NOT EXISTS` /
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` where possible so a
   manual mid-flight psql run doesn't break the auto-apply.
3. (Optional) Update `shared/schema.ts` to keep the Drizzle type
   surface aligned with the new columns. Tests against `failed_jobs`
   / `janus_chat_logs` etc. assert column existence.
4. Commit the SQL + the schema change together.
5. Push → server deploy / container restart auto-applies it. You'll see
   `[migrate] applied 00NN_short_name.sql in Xms` in the boot logs.

## Bootstrapping (one-time)

The production DB already has migrations 0000–0014 applied (via psql
over the past few months) but the new ledger table `_app_migrations`
starts empty. The runner detects this and **refuses to run**:

```
[migrate] REFUSING: pre-existing schema detected with empty migration ledger.
[migrate] To bootstrap: run `npm run migrate:seed` once, …
```

One-time fix (done from your terminal or container shell, against the same
`DATABASE_URL` the app uses):

```bash
npm run migrate:seed
```

This inserts every existing `migrations/*.sql` filename into
`_app_migrations` with its SHA-256 checksum. Idempotent — running it
twice does nothing. After that, normal deploys work.

## Smart refusal — what it catches

`scripts/run-migrations.ts` checks at startup: does any of
`public.profiles`, `public.janus_memory`, `public.system_audit_log`
exist? If yes AND the ledger is empty → refuse.

This means:
- A fresh database (no app tables, no ledger) → the runner applies
  every migration in order. Bootstrap is automatic.
- An already-populated database (app tables exist) without a ledger
  → the runner refuses; you must seed first.
- An already-bootstrapped database (any ledger row exists) → normal
  apply / skip behavior. Even the probe tables are not re-checked.

## Emergency manual application

If for some reason you need to apply a SQL file outside the runner:

```bash
psql "$DATABASE_URL" -f migrations/0099_emergency.sql
# Then immediately:
psql "$DATABASE_URL" -c "
INSERT INTO _app_migrations (filename, checksum_sha256, duration_ms)
VALUES ('0099_emergency.sql',
        encode(digest(pg_read_file('migrations/0099_emergency.sql'), 'sha256'), 'hex'),
        NULL)
ON CONFLICT DO NOTHING;
"
```

That makes the runner skip it on next boot instead of trying to
re-apply (which would fail noisily on the duplicate constraint).

If you forget to insert the ledger row, the runner will try to re-apply
and roll back on the duplicate-key error. Boot will fail. Recover by
adding the ledger row manually.

## Verifying

```bash
psql "$DATABASE_URL" -c "SELECT filename, applied_at, duration_ms FROM _app_migrations ORDER BY filename;"
```

Compare against `ls migrations/*.sql`. If a file is on disk but missing
from the ledger, next deploy will apply it. If a file is in the ledger
but missing from disk, that's a deletion (rare; usually a mistake).

## Don't run `db:push`

`drizzle-kit push` does diff-based schema sync — it compares
`shared/schema.ts` against the live DB and tries to make them match,
including dropping columns it doesn't recognize. That's wrong for
production (and even for our dev DB which has manual one-off rows).

`npm run db:push` is wired to print a warning and exit 1.
`npm run db:push:force` exists as an escape hatch if you really need
the legacy behavior — but review the proposed diff first.

## What's in the ledger

Schema:
```sql
CREATE TABLE _app_migrations (
  filename         text PRIMARY KEY,
  applied_at       timestamptz NOT NULL DEFAULT now(),
  checksum_sha256  text NOT NULL,
  duration_ms      integer
);
```

`duration_ms` is `NULL` for rows backfilled by `migrate:seed`, and a
positive integer for rows actually applied by `run-migrations.ts`.
The seeder uses NULL deliberately so you can tell from the ledger
which migrations were "auto-marked as applied" vs "actually executed
by the runner this deploy."
