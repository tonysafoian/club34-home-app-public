#!/bin/bash
# Main-workspace guard — single authority on WHERE GitHub pushes may run.
#
# WHY (task #677): Replit task agents run in SUBREPL clones of this workspace.
# A subrepl is a FULL copy: same .replit workflows, same scripts, and the same
# `origin` remote (GitHub, with an embedded access token). When a task
# environment boots the app (e.g. so server-tests can run), the dev-only
# github-autosync would happily run scripts/push-to-github.sh and push the
# task branch's in-progress commits straight to origin/main — in parallel with
# the platform's own merge of the same task into the real workspace. Result:
# origin/main and workspace main diverge with same-content parallel commits,
# and the next sync's `git merge origin/main` auto-merges them badly
# (duplicated Express routes, INSERTs pasted 3x). This corrupted origin twice.
#
# HOW: the real workspace's REPL_ID is a bare UUID, pinned in
# scripts/lib/main-workspace-repl-id (one line). Subrepls get
# REPL_ID="<parent-uuid>:<slug>" (colon suffix), so they can NEVER match the
# pin. Only an exact match is allowed to push. Missing REPL_ID or a missing
# pin file fails safe (no push).
#
# Wrong-pin safety net: if this guard ever wrongly skipped in the REAL
# workspace, post-merge.sh's post-push verification (HEAD vs origin/main)
# fails loudly on the next task merge — drift cannot accumulate silently.
#
# The TypeScript twin of this check lives in server/lib/githubAutosync.ts and
# reads the SAME pin file — update the pin file, not the scripts, if the
# workspace's REPL_ID ever legitimately changes.

WORKSPACE_GUARD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN_WORKSPACE_REPL_ID_FILE="$WORKSPACE_GUARD_LIB_DIR/main-workspace-repl-id"
MAIN_WORKSPACE_REPL_ID="$(tr -d '[:space:]' < "$MAIN_WORKSPACE_REPL_ID_FILE" 2>/dev/null || true)"

# 0 = this process runs in the main workspace and may push to GitHub.
is_main_workspace() {
  [ -n "$MAIN_WORKSPACE_REPL_ID" ] && [ "${REPL_ID:-}" = "$MAIN_WORKSPACE_REPL_ID" ]
}

# Human-readable explanation for why is_main_workspace failed (for logs).
workspace_guard_reason() {
  if [ -z "$MAIN_WORKSPACE_REPL_ID" ]; then
    echo "pin file missing or empty ($MAIN_WORKSPACE_REPL_ID_FILE)"
  elif [ -z "${REPL_ID:-}" ]; then
    echo "REPL_ID is unset"
  elif [ "${REPL_ID#*:}" != "$REPL_ID" ]; then
    echo "REPL_ID '$REPL_ID' has a ':<slug>' suffix — this is a task subrepl"
  else
    echo "REPL_ID '$REPL_ID' does not match pinned main workspace '$MAIN_WORKSPACE_REPL_ID'"
  fi
}
