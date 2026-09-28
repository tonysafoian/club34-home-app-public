#!/usr/bin/env bash
# check-migration-immutability.sh
#
# Asserts that every applied migration file's current content matches the
# checksum recorded in the _app_migrations ledger. If a migration was edited
# after it was applied, the file's checksum will no longer match — that's a
# bug class that causes silent schema drift between dev workstations and
# production.
#
# This is the script that would have caught the 2026-05-17 grocery_staples
# incident: migration 0024 was edited from v1 to v2 after the v1 row was
# already in the ledger, so the v2 schema changes silently never applied.
#
# Usage:
#   ./scripts/check-migration-immutability.sh                # against $DATABASE_URL
#   DATABASE_URL=... ./scripts/check-migration-immutability.sh
#
# Exit codes:
#   0 — all applied migrations have matching checksums
#   1 — at least one migration file was modified after being applied
#   2 — usage / connection error

set -euo pipefail

MIG_DIR="${MIG_DIR:-migrations}"
DB_URL="${DATABASE_URL:-}"

if [ -z "$DB_URL" ]; then
  echo "ERROR: DATABASE_URL not set."
  exit 2
fi

if [ ! -d "$MIG_DIR" ]; then
  echo "ERROR: migrations directory $MIG_DIR not found. Run from repo root."
  exit 2
fi

echo
echo "Migration immutability check — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Database: ${DB_URL%@*}@... (host hidden)"
echo

# Pull the applied-migrations ledger from the DB.
LEDGER=$(psql "$DB_URL" -At -F'|' -c \
  "SELECT filename, checksum_sha256 FROM _app_migrations ORDER BY filename;" \
  2>/dev/null) || {
    echo "ERROR: failed to query _app_migrations table. Does it exist?"
    exit 2
  }

if [ -z "$LEDGER" ]; then
  echo "INFO: ledger is empty. Nothing to verify."
  exit 0
fi

DRIFT_COUNT=0
DRIFT_LIST=()

while IFS='|' read -r filename recorded_checksum; do
  [ -z "$filename" ] && continue

  file_path="$MIG_DIR/$filename"

  if [ ! -f "$file_path" ]; then
    printf "  ⚠   %-45s (ledger says applied, but file does not exist locally)\n" "$filename"
    continue
  fi

  # Recorded checksums in older rows may be empty (the seed-ledger inserted
  # blank checksums for legacy migrations). Skip those — we can't verify
  # what we don't have a record for.
  if [ -z "$recorded_checksum" ]; then
    printf "  -   %-45s (no recorded checksum — skipped)\n" "$filename"
    continue
  fi

  actual_checksum=$(shasum -a 256 "$file_path" 2>/dev/null | awk '{print $1}' || \
                    sha256sum "$file_path" 2>/dev/null | awk '{print $1}')

  if [ "$actual_checksum" = "$recorded_checksum" ]; then
    printf "  ✅  %-45s\n" "$filename"
  else
    printf "  ❌  %-45s\n" "$filename"
    printf "     recorded: %s\n" "$recorded_checksum"
    printf "     actual:   %s\n" "$actual_checksum"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
    DRIFT_LIST+=("$filename")
  fi
done <<< "$LEDGER"

echo
echo "───────────────────────────────────────────────"

if [ $DRIFT_COUNT -gt 0 ]; then
  echo "FAIL: $DRIFT_COUNT migration(s) were edited after being applied:"
  for d in "${DRIFT_LIST[@]}"; do
    echo "  - $d"
  done
  echo
  echo "Migration files are append-only. To change a previously-applied"
  echo "migration's effect, write a NEW numbered migration that performs"
  echo "the correction (see migrations/0026_align_grocery_staples_schema.sql"
  echo "for an example following the 2026-05-17 incident)."
  exit 1
fi

echo "PASS: all applied migrations have matching checksums."
exit 0
