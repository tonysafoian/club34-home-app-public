---
name: Activity Awareness
description: Investigate what is happening (or has happened) across the whole app via the central activity log. Load when asked to "catch me up", "what's going on", "what happened with X", or to diagnose why something changed or stopped.
channels: [chat, whatsapp, email]
roles: [admin, member]
---

# Activity Awareness

The household's app-wide activity log lives in `system_audit_log`. Every
meaningful event — chat/WhatsApp/email replies, automations, cron runs,
broadcasts, security alerts, network snapshots, external API calls — writes a
row there. Use it to answer "what's going on?" and to diagnose changes.

## Tools

- `search_system_events(hours?, category?, severity?, search?, actor?, status?, source?, summary?)`
  — the primary investigation tool. Start broad, then drill down with filters.
- `query_activity_log(event_type?, hours?)` — quick recent-feed pull when you
  already know the event type.
- `get_network_history(hours?)` — network health snapshots (CPU/memory/sessions/
  WAN/threats) for connectivity questions specifically.

## How to investigate

1. **Start with a summary pass.** Call `search_system_events` with a time window
   (e.g. `hours: 24`) and no narrow filters to see the shape of activity. Read
   the summaries before drilling in.
2. **Narrow by what the user cares about:**
   - A subsystem → `category` (e.g. `janus`, `external_api`, `security`).
   - Something went wrong → `severity` (`warn`/`error`/`critical`) and/or
     `status` ("failure").
   - A person or device → `actor`.
   - A keyword → `search` / `summary`.
3. **Tighten the window** for "right now" questions (`hours: 1`–`3`) and widen it
   for "this week" questions.
4. **For network/internet questions**, prefer `get_network_history` — it has the
   structured CPU/memory/WAN/threat trend, which the generic log does not.

## Grounding rules (do not break)

- Report ONLY what the log rows actually say. Never invent events, counts, times,
  or actors. If the log is empty for the window, say so plainly.
- Quote concrete details from the rows (time, actor, summary, status) so the user
  can trust the answer.
- If a user asks "why did X change/stop", look for the failure/skip rows around
  that time rather than guessing a cause.
