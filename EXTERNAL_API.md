# Club 34 / Janus External API

A read/write HTTP API for sibling apps and external integrations to interact with the Club 34 / Janus stack.

- **Base path:** `/api/v1/external`
- **Production:** `https://example.com/api/v1/external`
- **Auth:** single shared API key in the `x-api-key` header
- **Rate limit:** 60 requests / minute (global, across all callers)
- **Audit:** every request is logged to `system_audit_log` with `category=external_api` and `detail.source = "external_api"`
- **Sanitization:** known token / secret fields (`access_token`, `refresh_token`, `api_key`, `password`, `private_key`, etc.) are redacted before being returned or audited

## Authentication

The API uses a single shared key stored in the `EXTERNAL_API_KEY` Replit secret. Rotate the secret to revoke access. Comparison is constant-time.

```bash
curl -H "x-api-key: $EXTERNAL_API_KEY" https://example.com/api/v1/external/health
```

Missing or invalid keys return `401 Unauthorized` and are recorded as `denied` in the audit log.

## Response shape

All responses are JSON:

```json
{ "success": true, "data": { ... } }
```

Errors:

```json
{ "success": false, "error": "Human readable message" }
```

## Discovery

### `GET /capabilities`

Returns the full catalog of endpoints and tools in one call.

```bash
curl -H "x-api-key: $EXTERNAL_API_KEY" \
  https://example.com/api/v1/external/capabilities
```

### `GET /tools`

Returns the generic tool registry (same JSON-Schema definitions used by Janus).

### `POST /tools/:name/invoke`

Invoke any registered tool by name. The body is the tool's `parameters` object and is **validated against the tool's JSON Schema** before execution. Invalid arguments return `400 Invalid arguments for tool '<name>'` with the Ajv error list in `detail`.

```bash
curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"weather in Los Angeles"}' \
  https://example.com/api/v1/external/tools/perplexity_search/invoke
```

## Read endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | API health probe |
| GET | `/home/states` | All HA entity states. `?domain=light` to filter |
| GET | `/home/state/:entity_id` | Single HA entity |
| GET | `/home/logbook` | `?hours=12&entity_id=...` |
| GET | `/tesla/status` | Tesla vehicles |
| GET | `/verkada/status` | Cameras + recent alerts |
| GET | `/generator/status` | Generac generator |
| GET | `/pool/status` | iAqualink pool / spa devices |
| GET | `/network/status` | FortiGate device + WAN interface health |
| GET | `/weather` | Current + 7-day forecast, AQI, pollen, alerts (cached 5 min) |
| GET | `/calendars` | List Google calendars |
| GET | `/calendar/events` | `?calendar_id&time_min&time_max&max_results` |
| GET | `/notion/database/:id` | Notion database schema |
| GET | `/memory` | Janus long-term facts. `?user_id` |
| GET | `/reminders` | `?user_id` |
| GET | `/trips` | All saved trips |
| GET | `/entertainment` | Upcoming entertainment events |
| GET | `/household` | Household members |
| GET | `/automations` | Family automations |
| GET | `/audit-log` | `?limit&category&severity&since` |
| GET | `/activity` | Recent household activity feed (audit log, excludes External API noise) `?limit&since` |
| GET | `/chat-history` | `?user_id&limit` |

## Action endpoints

| Method | Path | Body |
|---|---|---|
| POST | `/home/call-service` | `{ "domain", "service", "service_data" }` |
| POST | `/broadcast` | `{ "message", "speakers"?, "volume"?, "voice_id"?, "fallback_phone"? }` |
| POST | `/calendar/event` | `{ "title", "start", "end", "calendar_id"?, "description"?, "location"?, "attendees"? }` |
| PATCH | `/calendar/event/:event_id` | `{ "title"?, "start"?, "end"?, "description"?, "location"?, "attendees"?, "calendar_id"? }` |
| DELETE | `/calendar/event/:event_id` | `?calendar_id=` |
| POST | `/email/send` | `{ "to", "subject", "html"?, "text"?, "from"? }` |
| POST | `/notion/query` | `{ "database_id", "filter"?, "sorts"?, "page_size"? }` |
| POST | `/notion/page` | `{ "database_id", "properties", "children"? }` |
| PATCH | `/notion/page/:page_id` | `{ "properties"?, "archived"? }` |
| POST | `/memory` | `{ "user_id", "key", "value", "context"? }` |

### Broadcast behavior

`POST /broadcast` plays the given message via ElevenLabs TTS to the configured Google Home speakers. Defaults to the three girls' room speakers. If **all** speakers fail, a WhatsApp fallback message is sent to the broadcast fallback phone (or the override `fallback_phone`). The response reports per-speaker success and whether the fallback was used.

```bash
curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"Dinner is ready"}' \
  https://example.com/api/v1/external/broadcast
```

### Home Assistant control

```bash
curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domain":"light","service":"turn_on","service_data":{"entity_id":"light.kitchen"}}' \
  https://example.com/api/v1/external/home/call-service
```

### Calendar create

```bash
curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title":"Dentist",
    "start":"2026-05-10T14:00:00-07:00",
    "end":"2026-05-10T15:00:00-07:00",
    "calendar_id":"admin@example.com"
  }' \
  https://example.com/api/v1/external/calendar/event
```

> All calendar times **must** include an explicit Pacific Time offset (`-07:00` PDT or `-08:00` PST). `Z`-suffix UTC times will be rejected.

### Send email

```bash
curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"someone@example.com","subject":"Hello","text":"From Janus"}' \
  https://example.com/api/v1/external/email/send
```

### Write Janus memory

```bash
curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"tony","key":"favorite_pizza","value":"margherita","context":"food prefs"}' \
  https://example.com/api/v1/external/memory
```

## Errors

| Status | Meaning |
|---|---|
| 401 | Missing or invalid `x-api-key` |
| 404 | Unknown endpoint |
| 429 | Rate limit exceeded — returns `Retry-After` header |
| 500 | Tool / handler raised an error (message in `error`) |
| 503 | `EXTERNAL_API_KEY` not configured on the server |

## Audit log

Every successful or failed request is recorded to `system_audit_log`:

- `edge_function`: `external-api`
- `category`: `external_api`
- `event_type`: `external_api.<endpoint_id>`
- `actor_name`: `external_api`
- `channel`: `external_api`
- `detail.source`: `"external_api"`
- `detail.path`, `detail.method`, `detail.ip`
- `detail.duration_ms` — wall-clock time the handler took
- `detail.query` — request query string (when present, sanitized)
- `detail.request` — sanitized & truncated request body for non-GET requests
- `detail.response_preview` — sanitized & truncated successful response (for debugging callers)
- All payloads are passed through the same secret redactor used for outgoing responses; values longer than ~4 KB are truncated with a `_truncated: true` marker

Filter recent activity:

```bash
curl -H "x-api-key: $EXTERNAL_API_KEY" \
  "https://example.com/api/v1/external/audit-log?category=external_api&limit=50"
```

## Admin UI

A documentation + capability-explorer page is available in the Club 34 web app at  
`/admin?section=api`.
