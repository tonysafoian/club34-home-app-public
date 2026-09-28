#!/usr/bin/env bash
# audit-supabase-functions.sh
#
# Audits which supabase/functions/* directories are actually referenced
# from server/, src/, or scripts/. Reports "still used" vs "orphaned" so
# we never have to re-discover this manually.
#
# Usage: ./scripts/audit-supabase-functions.sh
# Exit 0 if no orphans, 1 if orphans found.

set -euo pipefail

FUNCS_DIR="supabase/functions"

if [ ! -d "$FUNCS_DIR" ]; then
  echo "ERROR: $FUNCS_DIR not found. Run from repo root."
  exit 2
fi

USED_FNS=()
ORPHAN_FNS=()

echo
echo "Auditing Supabase function references — $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo

for fn in $(ls "$FUNCS_DIR"); do
  # _shared is the shared library (SOUL.md etc) — always considered used
  if [ "$fn" = "_shared" ]; then
    USED_FNS+=("$fn (always: _shared library)")
    continue
  fi

  # Search refs in server/, src/, scripts/
  refs=$(grep -rln "$fn" server/ src/ scripts/ \
    --include="*.ts" --include="*.tsx" --include="*.js" \
    2>/dev/null | grep -v node_modules || true)

  if [ -n "$refs" ]; then
    USED_FNS+=("$fn")
  else
    ORPHAN_FNS+=("$fn")
  fi
done

echo "═══ USED (${#USED_FNS[@]}) ═══"
for u in "${USED_FNS[@]}"; do
  printf "  ✅  %s\n" "$u"
done

echo
echo "═══ ORPHANED (${#ORPHAN_FNS[@]}) ═══"
if [ ${#ORPHAN_FNS[@]} -eq 0 ]; then
  echo "  (none)"
else
  for o in "${ORPHAN_FNS[@]}"; do
    printf "  🗑   %s\n" "$o"
  done
fi

echo
echo "───────────────────────────────────────────────"
echo "Used: ${#USED_FNS[@]}   Orphaned: ${#ORPHAN_FNS[@]}"

if [ ${#ORPHAN_FNS[@]} -gt 0 ]; then
  exit 1
fi
exit 0
