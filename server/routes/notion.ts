import { Router, type Request, type Response } from "express";
import { createClient } from "../utils/supabase.js";
import {
  authenticateRequest,
  logAudit,
  getServiceClient,
} from "../lib/helpers.js";
import { sanitizeErrorMessage } from "../lib/error-sanitizer.js";

const router = Router();

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const NOTION_ID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function isValidNotionId(id: unknown): id is string {
  return typeof id === "string" && NOTION_ID_RE.test(id);
}

function extractStatusFromProperties(
  properties: Record<string, any> | null,
): string | null {
  if (!properties) return null;
  const statusKeys = ["Status", "status"];
  for (const key of statusKeys) {
    const prop = properties[key];
    if (prop?.type === "status" && prop.status?.name)
      return prop.status.name;
    if (prop?.type === "select" && prop.select?.name)
      return prop.select.name;
  }
  return null;
}

function extractTitle(page: Record<string, unknown>): string {
  const props = page.properties as Record<
    string,
    { type: string; title?: Array<{ plain_text: string }> }
  >;
  if (!props) return "Untitled";

  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title && prop.title.length > 0) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return "Untitled";
}

router.options("/proxy", (_req: Request, res: Response) => {
  res.sendStatus(204);
});

router.post("/proxy", async (req: Request, res: Response) => {
  const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
  if (auth.error) return res.status(401).json({ error: auth.error });

  try {
    const apiKey = process.env.NOTION_API_KEY;
    if (!apiKey) {
      return res
        .status(500)
        .json({ success: false, error: "NOTION_API_KEY not configured" });
    }

    const {
      action,
      database_id,
      page_id,
      page_ids,
      query,
      properties,
      content,
    } = req.body;

    const notionHeaders = {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };

    if (action === "search-databases") {
      const response = await fetch(`${NOTION_BASE}/search`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({
          filter: { value: "database", property: "object" },
          query: query || "",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, databases: data.results || [] });
    }

    if (action === "get-database") {
      if (!isValidNotionId(database_id)) {
        return res.status(400).json({
          success: false,
          error: "Valid database_id is required",
        });
      }
      const response = await fetch(
        `${NOTION_BASE}/databases/${database_id}`,
        { headers: notionHeaders },
      );
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, database: data });
    }

    if (action === "query-database") {
      if (!isValidNotionId(database_id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid database_id format",
        });
      }
      const response = await fetch(
        `${NOTION_BASE}/databases/${database_id}/query`,
        {
          method: "POST",
          headers: notionHeaders,
          body: JSON.stringify(query || {}),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({
        success: true,
        results: data.results || [],
        has_more: data.has_more,
        next_cursor: data.next_cursor,
      });
    }

    if (action === "get-page") {
      if (!isValidNotionId(page_id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid page_id format",
        });
      }
      const response = await fetch(`${NOTION_BASE}/pages/${page_id}`, {
        headers: notionHeaders,
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, page: data });
    }

    if (action === "get-pages") {
      if (!Array.isArray(page_ids) || !page_ids.every(isValidNotionId)) {
        return res.status(400).json({
          success: false,
          error: "page_ids must be an array of valid Notion UUIDs",
        });
      }
      const pages = await Promise.all(
        page_ids.map(async (pid: string) => {
          const r = await fetch(`${NOTION_BASE}/pages/${pid}`, {
            headers: notionHeaders,
          });
          if (!r.ok) return { id: pid, error: true };
          return r.json();
        }),
      );
      return res.json({ success: true, pages });
    }

    if (action === "batch-get-page-titles") {
      const rawIds: string[] = Array.isArray(page_ids) ? page_ids : [];
      const ids = rawIds.filter(isValidNotionId);
      if (!ids.length) {
        return res.json({ success: true, titles: {} });
      }
      const batch = ids.slice(0, 50);
      const results = await Promise.allSettled(
        batch.map(async (pid: string) => {
          const resp = await fetch(`${NOTION_BASE}/pages/${pid}`, {
            headers: notionHeaders,
          });
          if (!resp.ok) return { id: pid, title: null };
          const page = await resp.json();
          let title: string | null = null;
          for (const key of Object.keys(page.properties ?? {})) {
            const prop = page.properties[key];
            if (prop?.type === "title" && prop.title?.length > 0) {
              title = prop.title
                .map((t: any) => t.plain_text)
                .join("");
              break;
            }
          }
          return { id: pid, title };
        }),
      );
      const titles: Record<string, string | null> = {};
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          titles[r.value.id] = r.value.title;
        }
      }
      return res.json({ success: true, titles });
    }

    if (action === "batch-get-users") {
      const rawIds: string[] = Array.isArray(page_ids) ? page_ids : [];
      const ids = rawIds.filter(isValidNotionId);
      if (!ids.length) {
        return res.json({ success: true, users: {} });
      }
      const batch = ids.slice(0, 25);
      const results = await Promise.allSettled(
        batch.map(async (uid: string) => {
          const resp = await fetch(`${NOTION_BASE}/users/${uid}`, {
            headers: notionHeaders,
          });
          if (!resp.ok) return { id: uid, name: null };
          const user = await resp.json();
          return { id: uid, name: user.name ?? null };
        }),
      );
      const users: Record<string, string | null> = {};
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          users[r.value.id] = r.value.name;
        }
      }
      return res.json({ success: true, users });
    }

    if (action === "create-file-upload") {
      const uploadVersion = "2025-09-03";
      const response = await fetch(`${NOTION_BASE}/file_uploads`, {
        method: "POST",
        headers: { ...notionHeaders, "Notion-Version": uploadVersion },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({
        success: true,
        file_upload_id: data.id,
        upload_url: data.upload_url,
      });
    }

    if (action === "update-page") {
      if (!isValidNotionId(page_id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid page_id format",
        });
      }
      const response = await fetch(`${NOTION_BASE}/pages/${page_id}`, {
        method: "PATCH",
        headers: notionHeaders,
        body: JSON.stringify({ properties: properties || {} }),
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, page: data });
    }

    if (action === "create-page") {
      const response = await fetch(`${NOTION_BASE}/pages`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify(req.body.page || {}),
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, page: data });
    }

    if (action === "get-block-children") {
      if (!isValidNotionId(page_id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid page_id format",
        });
      }
      const response = await fetch(
        `${NOTION_BASE}/blocks/${page_id}/children?page_size=100`,
        { headers: notionHeaders },
      );
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({
        success: true,
        results: data.results || [],
        has_more: data.has_more,
      });
    }

    if (action === "append-block-children") {
      if (!isValidNotionId(page_id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid page_id format",
        });
      }
      const response = await fetch(
        `${NOTION_BASE}/blocks/${page_id}/children`,
        {
          method: "PATCH",
          headers: notionHeaders,
          body: JSON.stringify({ children: content || [] }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, results: data.results || [] });
    }

    if (action === "add-comment") {
      if (!isValidNotionId(page_id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid page_id format",
        });
      }
      const response = await fetch(`${NOTION_BASE}/comments`, {
        method: "POST",
        headers: notionHeaders,
        body: JSON.stringify({
          parent: { page_id },
          rich_text: [
            { text: { content: (content || "").slice(0, 2000) } },
          ],
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, comment: data });
    }

    if (action === "send-file-upload") {
      const { file_url, file_name, external_url } = req.body;
      const response = await fetch(
        `${NOTION_BASE}/blocks/${page_id}/children`,
        {
          method: "PATCH",
          headers: notionHeaders,
          body: JSON.stringify({
            children: [
              {
                object: "block",
                type: "file",
                file: {
                  type: "external",
                  external: { url: external_url || file_url },
                  caption: file_name
                    ? [{ text: { content: file_name } }]
                    : undefined,
                },
              },
            ],
          }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        return res.json({
          success: false,
          error: data.message || `Notion API error ${response.status}`,
        });
      }
      return res.json({ success: true, result: data });
    }

    if (action === "search-pages" || action === "search-projects") {
      const searchQuery = query || "";
      const JANUS_DB = "2b8e96d8-93fa-80bb-9428-cd132f827553";
      const TIGERDEN_DB = "2b8e96d8-93fa-80cc-b1fa-fa4eef48c6fe";

      const fetchDb = async (
        dbId: string,
        source: string,
      ): Promise<any[]> => {
        let titlePropName = "Name";
        try {
          const dbResp = await fetch(
            `${NOTION_BASE}/databases/${dbId}`,
            { headers: notionHeaders },
          );
          if (dbResp.ok) {
            const dbData = await dbResp.json();
            for (const [key, val] of Object.entries(
              dbData.properties || {},
            )) {
              if ((val as any).type === "title") {
                titlePropName = key;
                break;
              }
            }
          }
        } catch (_) {}

        const body: Record<string, unknown> = { page_size: 50 };
        if (searchQuery) {
          body.filter = {
            property: titlePropName,
            title: { contains: searchQuery },
          };
        }
        const resp = await fetch(
          `${NOTION_BASE}/databases/${dbId}/query`,
          {
            method: "POST",
            headers: notionHeaders,
            body: JSON.stringify(body),
          },
        );
        if (!resp.ok) return [];
        const data = await resp.json();
        return (data.results || []).map((page: any) => {
          let title = "";
          for (const key of Object.keys(page.properties || {})) {
            const prop = page.properties[key];
            if (
              prop?.type === "title" &&
              prop.title?.length > 0
            ) {
              title = prop.title
                .map((t: any) => t.plain_text)
                .join("");
              break;
            }
          }
          return { id: page.id, title, source, url: page.url };
        });
      };

      const [janus, tigerDen] = await Promise.all([
        fetchDb(JANUS_DB, "Janus"),
        fetchDb(TIGERDEN_DB, "TigerDen"),
      ]);

      return res.json({
        success: true,
        results: [...janus, ...tigerDen],
      });
    }

    return res
      .status(400)
      .json({ success: false, error: "Invalid action" });
  } catch (error) {
    console.error("Notion proxy error:", error);
    logAudit("notion-proxy", {
      category: "integration",
      event_type: "notion_error",
      severity: "error",
      actor_id: auth.userId || "UNKNOWN",
      actor_name: auth.email || "UNKNOWN",
      channel: "web",
      summary: `Notion proxy error: ${error instanceof Error ? error.message : "unknown"}`,
      status: "error",
    });
    return res
      .status(500)
      .json({ success: false, error: sanitizeErrorMessage(error) });
  }
});

router.get("/webhook", (_req: Request, res: Response) => {
  return res.json({ message: "Notion webhook endpoint is ready" });
});

async function processNotionEvent(
  supabase: ReturnType<typeof createClient>,
  event: Record<string, any>,
  fallbackEventType: string,
): Promise<void> {
  const entityType = event.entity?.type;
  const notionPageId =
    entityType === "comment" && event.data?.parent?.type === "page"
      ? event.data.parent.id
      : event.entity?.id || event.page_id || null;

  const notionDatabaseId =
    (event.data?.parent?.type === "database"
      ? event.data.parent.id
      : null) ||
    event.parent?.database_id ||
    event.database_id ||
    null;

  const eventType = event.type || fallbackEventType;
  console.log(
    `[notion-webhook] processing event type=${eventType} pageId=${notionPageId} dbId=${notionDatabaseId}`,
  );

  let enrichedPayload = { ...event };
  if (notionPageId) {
    const notionApiKey = process.env.NOTION_API_KEY;
    if (notionApiKey) {
      try {
        const statusResp = await fetch(
          `${NOTION_BASE}/pages/${notionPageId}`,
          {
            headers: {
              Authorization: `Bearer ${notionApiKey}`,
              "Notion-Version": NOTION_VERSION,
            },
          },
        );
        if (statusResp.ok) {
          const pageData = await statusResp.json();
          const statusValue = extractStatusFromProperties(pageData.properties);
          if (statusValue) {
            enrichedPayload = { ...event, enriched_status: statusValue };
          }
        } else {
          const errText = await statusResp.text();
          console.warn(
            `[notion-webhook] page enrich ${notionPageId} → ${statusResp.status}: ${errText.substring(0, 200)}`,
          );
        }
      } catch (e) {
        console.error("[notion-webhook] Failed to enrich page status:", e);
      }
    }
  }

  await supabase.from("notion_webhook_events").insert({
    event_type: eventType,
    notion_page_id: notionPageId,
    notion_database_id: notionDatabaseId,
    payload: enrichedPayload,
  });

  if (!notionDatabaseId) return;

  let { data: syncConfigs } = await supabase
    .from("notion_sync_config")
    .select("id, user_id, notion_database_id")
    .eq("notion_database_id", notionDatabaseId)
    .eq("is_active", true);

  if (!syncConfigs || syncConfigs.length === 0) {
    const { data: adminRole } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin")
      .limit(1)
      .single();

    if (adminRole) {
      let dbName = "Auto-synced Database";
      const notionApiKey = process.env.NOTION_API_KEY;
      if (notionApiKey) {
        try {
          const dbResp = await fetch(
            `${NOTION_BASE}/databases/${notionDatabaseId}`,
            {
              headers: {
                Authorization: `Bearer ${notionApiKey}`,
                "Notion-Version": NOTION_VERSION,
              },
            },
          );
          if (dbResp.ok) {
            const dbData = await dbResp.json();
            if (dbData.title?.length > 0) {
              dbName = dbData.title
                .map((t: { plain_text: string }) => t.plain_text)
                .join("");
            }
          }
        } catch (e) {
          console.error("[notion-webhook] Failed to fetch database name:", e);
        }
      }

      const { data: newConfig, error: createErr } = await supabase
        .from("notion_sync_config")
        .insert({
          user_id: adminRole.user_id,
          notion_database_id: notionDatabaseId,
          database_name: dbName,
          sync_direction: "read",
        })
        .select("id, user_id, notion_database_id")
        .single();

      if (!createErr && newConfig) {
        syncConfigs = [newConfig];
      }
    }
  }

  if (!syncConfigs || syncConfigs.length === 0) return;

  if (notionPageId) {
    const notionApiKey = process.env.NOTION_API_KEY;
    if (notionApiKey) {
      try {
        const pageResponse = await fetch(
          `${NOTION_BASE}/pages/${notionPageId}`,
          {
            headers: {
              Authorization: `Bearer ${notionApiKey}`,
              "Notion-Version": NOTION_VERSION,
            },
          },
        );

        if (pageResponse.ok) {
          const pageData = await pageResponse.json();
          const title = extractTitle(pageData);

          for (const config of syncConfigs) {
            await supabase.from("notion_cached_pages").upsert(
              {
                sync_config_id: config.id,
                notion_page_id: notionPageId,
                title,
                properties: pageData.properties,
                notion_url: pageData.url,
                last_edited_at: pageData.last_edited_time,
                cached_at: new Date().toISOString(),
              },
              { onConflict: "notion_page_id" },
            );
          }
        } else {
          const errText = await pageResponse.text();
          console.warn(
            `[notion-webhook] page cache fetch ${notionPageId} → ${pageResponse.status}: ${errText.substring(0, 200)}`,
          );
        }
      } catch (fetchErr) {
        console.error("[notion-webhook] Error fetching Notion page for cache:", fetchErr);
      }
    }
  }

  for (const config of syncConfigs) {
    await supabase
      .from("notion_sync_config")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", config.id);
  }
}

router.post("/webhook", (req: Request, res: Response) => {
  const payload = req.body ?? {};

  console.log(
    "[notion-webhook] received:",
    JSON.stringify(payload).substring(0, 500),
  );

  if (!payload || typeof payload !== "object") {
    return res.status(400).json({ success: false, error: "Empty or invalid payload" });
  }

  if (payload.verification_token) {
    console.log(
      `[notion-webhook] VERIFICATION HANDSHAKE — token: ${payload.verification_token}`,
    );
    return res.json({
      success: true,
      verification_token: payload.verification_token,
    });
  }

  const fallbackEventType = payload.type || "unknown";
  const events: Record<string, any>[] = Array.isArray(payload.events)
    ? payload.events
    : [payload];

  res.json({ success: true, received: events.length });

  setImmediate(async () => {
    const supabase = createClient();
    for (const event of events) {
      try {
        await processNotionEvent(supabase, event, fallbackEventType);
      } catch (err) {
        console.error("[notion-webhook] Failed to process event:", err, JSON.stringify(event).substring(0, 300));
      }
    }
    console.log(`[notion-webhook] async processing complete for ${events.length} event(s)`);
  });
});

// ── Poller fallback ───────────────────────────────────────────────────────
// Cron-triggered safety net for when the Notion webhook subscription is
// inactive. Polls every active notion_sync_config database for pages edited
// since the last sync and records synthetic notion_webhook_events rows so the
// Activity Level chart keeps filling in without the webhook. Deduplicates
// against notion_cached_pages.last_edited_at, which the live webhook handler
// also writes — so when both are active the webhook wins and the poller finds
// nothing new. Payloads are shaped to match what the frontend classifier
// (classifyEvent / getProjectFromPayload / isHumanAuthored) expects.
router.post("/poll", async (req: Request, res: Response) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers["x-cron-secret"] !== cronSecret) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }

  const notionApiKey = process.env.NOTION_API_KEY;
  if (!notionApiKey) {
    // 503 (not 200) so the cron-trigger audit records status='error' and the
    // notion-webhook-health-monitor's poller-down check fires — a poller that
    // can't run at all is a real outage, not a quiet no-op.
    return res
      .status(503)
      .json({ success: false, error: "NOTION_API_KEY not configured", inserted: 0 });
  }

  const supabase = createClient();
  const OVERLAP_MS = 60 * 60 * 1000; // 1h window overlap so edits between polls aren't missed
  const FALLBACK_MS = 24 * 60 * 60 * 1000; // first run with no last_synced_at looks back 24h
  const WEBHOOK_ACTIVE_MS = 15 * 60 * 1000; // if the live webhook delivered within this window, stand down

  try {
    // The poller is strictly a fallback. If the live webhook has delivered any
    // real (non-poller) event recently it is healthy, so we stand down — this
    // also prevents the same edit being counted by both the webhook and the
    // poller during a reconnect window.
    const { data: recentEvents } = await supabase
      .from("notion_webhook_events")
      .select("payload, created_at")
      .gte("created_at", new Date(Date.now() - WEBHOOK_ACTIVE_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(100);

    const webhookActive = (recentEvents ?? []).some(
      (e: { payload?: { _source?: string } }) => e?.payload?._source !== "poller",
    );
    if (webhookActive) {
      return res.json({ success: true, inserted: 0, skipped: "webhook_active" });
    }

    const { data: configs } = await supabase
      .from("notion_sync_config")
      .select("id, notion_database_id, last_synced_at")
      .eq("is_active", true);

    if (!configs || configs.length === 0) {
      return res.json({ success: true, inserted: 0, databases: 0 });
    }

    let totalInserted = 0;

    for (const config of configs as Array<{
      id: string;
      notion_database_id: string;
      last_synced_at: string | null;
    }>) {
      const dbId = config.notion_database_id;
      if (!isValidNotionId(dbId)) continue;

      const sinceMs = config.last_synced_at
        ? new Date(config.last_synced_at).getTime() - OVERLAP_MS
        : Date.now() - FALLBACK_MS;
      const sinceIso = new Date(sinceMs).toISOString();

      // Page through the full result set (Notion returns max 100 per request)
      // so heavier edit windows aren't silently truncated.
      const pages: Array<Record<string, any>> = [];
      let cursor: string | undefined = undefined;
      let queryFailed = false;
      do {
        try {
          const resp: globalThis.Response = await fetch(
            `${NOTION_BASE}/databases/${dbId}/query`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${notionApiKey}`,
                "Notion-Version": NOTION_VERSION,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                filter: {
                  timestamp: "last_edited_time",
                  last_edited_time: { on_or_after: sinceIso },
                },
                sorts: [
                  { timestamp: "last_edited_time", direction: "descending" },
                ],
                page_size: 100,
                ...(cursor ? { start_cursor: cursor } : {}),
              }),
            },
          );
          if (!resp.ok) {
            const errText = await resp.text();
            console.warn(
              `[notion-poll] db ${dbId} query → ${resp.status}: ${errText.substring(0, 200)}`,
            );
            queryFailed = true;
            break;
          }
          const json = await resp.json();
          if (Array.isArray(json.results)) pages.push(...json.results);
          cursor = json.has_more ? json.next_cursor : undefined;
        } catch (e) {
          console.error(`[notion-poll] db ${dbId} query failed:`, e);
          queryFailed = true;
          break;
        }
      } while (cursor);

      // Don't advance last_synced_at if the query was incomplete — otherwise
      // we'd permanently skip the edits we failed to read.
      if (queryFailed) continue;

      for (const page of pages) {
        const pageId = page.id;
        if (!pageId) continue;
        const lastEdited = page.last_edited_time;
        const createdTime = page.created_time;
        if (!lastEdited) continue;

        const { data: cached } = await supabase
          .from("notion_cached_pages")
          .select("last_edited_at")
          .eq("notion_page_id", pageId)
          .maybeSingle();

        const cachedMs = cached?.last_edited_at
          ? new Date(cached.last_edited_at).getTime()
          : 0;
        // Already recorded (by the live webhook or an earlier poll) — skip.
        if (cachedMs && new Date(lastEdited).getTime() <= cachedMs) continue;

        const createdInWindow =
          !!createdTime && new Date(createdTime).getTime() >= sinceMs;
        const eventType =
          !cached && createdInWindow ? "page.created" : "page.content_updated";

        const status = extractStatusFromProperties(page.properties);
        const lastEditedById = page.last_edited_by?.id ?? null;

        const payload: Record<string, any> = {
          type: eventType,
          entity: { id: pageId, type: "page" },
          data: { parent: { type: "database", id: dbId } },
          authors: lastEditedById ? [{ id: lastEditedById }] : [],
          _source: "poller",
        };
        if (status) payload.enriched_status = status;

        const { error: insErr } = await supabase
          .from("notion_webhook_events")
          .insert({
            event_type: eventType,
            notion_page_id: pageId,
            notion_database_id: dbId,
            payload,
            // Bucket the activity on the day the edit actually happened, not
            // when the poll ran — the chart buckets on created_at.
            created_at: lastEdited,
          });
        if (insErr) {
          console.error(`[notion-poll] insert failed for ${pageId}:`, insErr);
          continue;
        }
        totalInserted++;

        await supabase.from("notion_cached_pages").upsert(
          {
            sync_config_id: config.id,
            notion_page_id: pageId,
            title: extractTitle(page),
            properties: page.properties,
            notion_url: page.url,
            last_edited_at: lastEdited,
            cached_at: new Date().toISOString(),
          },
          { onConflict: "notion_page_id" },
        );
      }

      await supabase
        .from("notion_sync_config")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", config.id);
    }

    console.log(
      `[notion-poll] complete — inserted ${totalInserted} event(s) across ${configs.length} database(s)`,
    );
    await logAudit("notion-poll", {
      category: "automation",
      event_type: "notion_poll_run",
      severity: "info",
      actor_id: "system",
      channel: "cron",
      summary: `Notion activity poll recorded ${totalInserted} event(s)`,
      detail: { inserted: totalInserted, databases: configs.length },
      status: "success",
    }).catch(() => {});

    return res.json({
      success: true,
      inserted: totalInserted,
      databases: configs.length,
    });
  } catch (err) {
    console.error("[notion-poll] error:", err);
    return res
      .status(500)
      .json({ success: false, error: sanitizeErrorMessage(err) });
  }
});

export default router;
