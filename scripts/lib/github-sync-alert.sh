#!/bin/bash
# Shared WhatsApp alert helper for GitHub sync scripts.
#
# Sourced by scripts/push-to-github.sh and scripts/post-merge.sh so both
# operator-facing failure modes (divergence, repeated push timeouts, etc.)
# route through the same notification path.
#
# Silently no-ops when WATI env vars are absent so local/dev runs don't
# attempt to send messages.

alert_whatsapp() {
  local headline="$1"
  local body="$2"
  if [ -z "$WATI_API_ENDPOINT" ] || [ -z "$WATI_ACCESS_TOKEN" ]; then
    return 0
  fi
  local wati_root
  wati_root=$(echo "$WATI_API_ENDPOINT" | sed 's|/api/ext/v3\/?$||' | sed 's|/api/ext\/?$||' | sed 's|/$||')
  local clean_token
  clean_token=$(echo "$WATI_ACCESS_TOKEN" | sed 's/^Bearer //')
  curl -s -X POST "${wati_root}/api/ext/v3/conversations/messages/text" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${clean_token}" \
    -d "{\"target\": \"13109491469\", \"text\": \"${headline}\\n\\n${body}\"}" \
    2>/dev/null || true
}
