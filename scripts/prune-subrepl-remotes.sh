#!/usr/bin/env bash
# Remove stale task-environment remotes from a repository.
#
# Usage:
#   scripts/prune-subrepl-remotes.sh --apply \
#     --keep subrepl-active-task-a --keep subrepl-active-task-b
#
# The script is a dry run unless --apply is supplied. It only ever removes
# remotes whose names begin with "subrepl-"; origin and gitsafe-backup are
# never candidates. Pass every remote belonging to an active task with --keep
# (or in ACTIVE_SUBREPL_REMOTES) before applying the cleanup.

set -euo pipefail

APPLY=false
declare -a KEEP_REMOTES=()

usage() {
  cat <<'EOF'
Usage: scripts/prune-subrepl-remotes.sh [--dry-run|--apply] [--keep REMOTE]...

Lists or removes stale Replit task remotes named subrepl-*. The default is a
dry run. Use --apply only after listing any remotes that still belong to active
tasks with --keep.

Options:
  --apply          Remove eligible remotes. Required to make changes.
  --dry-run        Show eligible remotes without changing git config (default).
  --keep REMOTE    Preserve this active task remote. May be repeated.
  -h, --help       Show this help text.

You may also provide active task remotes through ACTIVE_SUBREPL_REMOTES as a
comma- or whitespace-separated list. For example:
  ACTIVE_SUBREPL_REMOTES="subrepl-a subrepl-b" \
    scripts/prune-subrepl-remotes.sh --apply
EOF
}

add_keep_remote() {
  local remote="$1"
  if [[ ! "$remote" =~ ^subrepl- ]]; then
    echo "Refusing to preserve non-subrepl remote: $remote" >&2
    exit 2
  fi
  KEEP_REMOTES+=("$remote")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)
      APPLY=true
      ;;
    --dry-run)
      APPLY=false
      ;;
    --keep)
      if [[ $# -lt 2 ]]; then
        echo "--keep requires a remote name" >&2
        usage >&2
        exit 2
      fi
      shift
      add_keep_remote "$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -n "${ACTIVE_SUBREPL_REMOTES:-}" ]]; then
  while IFS= read -r remote; do
    [[ -n "$remote" ]] && add_keep_remote "$remote"
  done < <(printf '%s\n' "$ACTIVE_SUBREPL_REMOTES" | tr ',[:space:]' '\n')
fi

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Run this script from inside the repository to clean." >&2
  exit 2
fi

is_kept() {
  local candidate="$1"
  local remote
  for remote in "${KEEP_REMOTES[@]}"; do
    [[ "$remote" == "$candidate" ]] && return 0
  done
  return 1
}

mapfile -t SUBREPL_REMOTES < <(git remote | grep '^subrepl-' || true)

for keep_remote in "${KEEP_REMOTES[@]}"; do
  keep_found=false
  for remote in "${SUBREPL_REMOTES[@]}"; do
    if [[ "$remote" == "$keep_remote" ]]; then
      keep_found=true
      break
    fi
  done
  if [[ "$keep_found" == false ]]; then
    echo "Active remote was not found: $keep_remote" >&2
    echo "Run without --apply first to verify the remote name." >&2
    exit 2
  fi
done

removed=0
preserved=0
for remote in "${SUBREPL_REMOTES[@]}"; do
  if is_kept "$remote"; then
    echo "[subrepl-cleanup] Keeping active remote: $remote"
    ((preserved += 1))
    continue
  fi

  if [[ "$APPLY" == true ]]; then
    git remote remove "$remote"
    echo "[subrepl-cleanup] Removed stale remote: $remote"
    ((removed += 1))
  else
    echo "[subrepl-cleanup] Would remove stale remote: $remote"
    ((removed += 1))
  fi
done

if [[ "$APPLY" == true ]]; then
  echo "[subrepl-cleanup] Removed $removed stale remote(s); kept $preserved active remote(s)."
else
  echo "[subrepl-cleanup] Dry run: $removed stale remote(s) would be removed; kept $preserved active remote(s)."
  echo "[subrepl-cleanup] Re-run with --apply after supplying every active remote with --keep."
fi