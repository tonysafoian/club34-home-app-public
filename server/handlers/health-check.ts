import type { Request, Response } from "express";
import { getGoogleServiceToken } from "../utils/google-jwt.js";
import { query } from "../lib/db.js";
import { logAudit } from "../lib/auditLog.js";
import { enqueueFailedJob, sendAutomationFailureAlert } from "../utils/janus-tools.js";

type CheckStatus = "ok" | "degraded" | "error";

interface CheckResult {
  name: string;
  status: CheckStatus;
  latency_ms: number;
  message?: string;
}

interface ApiErrorBody {
  error?: { message?: string };
  message?: string;
  detail?: { message?: string } | string;
  status?: string;
}

function extractErrorMessage(body: ApiErrorBody, prefix: string): string {
  const msg = body.error?.message || body.message || "";
  return `${prefix}: ${msg}`;
}

async function runCheck(
  name: string,
  fn: (signal: AbortSignal) => Promise<string | null>,
): Promise<CheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const msg = await fn(controller.signal);
    clearTimeout(timer);
    const latency_ms = Date.now() - start;
    let status: CheckStatus;
    let message: string | undefined;
    if (!msg) {
      status = latency_ms > 3000 ? "degraded" : "ok";
    } else if (msg.startsWith("degraded:")) {
      status = "degraded";
      message = msg.slice("degraded:".length).trim();
    } else {
      status = "error";
      message = msg;
    }
    return { name, status, latency_ms, message };
  } catch (e) {
    clearTimeout(timer);
    const latency_ms = Date.now() - start;
    const isTimeout = e instanceof Error && e.name === "AbortError";
    return {
      name,
      status: isTimeout ? "degraded" : "error",
      latency_ms,
      message: isTimeout
        ? "Timed out after 5s"
        : e instanceof Error
          ? e.message
          : String(e),
    };
  }
}

const HOME_LAT = 34.0522;
const HOME_LNG = -118.2437;

async function checkJanusChat(signal: AbortSignal): Promise<string | null> {
  const port = process.env.PORT || "5000";
  const res = await fetch(`http://localhost:${port}/api/janus/chat/ping`, {
    method: "GET",
    signal,
  });
  if (!res.ok) return `Chat ping returned ${res.status}`;
  return null;
}

async function checkJanusWhatsApp(signal: AbortSignal): Promise<string | null> {
  const endpoint = process.env.WATI_API_ENDPOINT;
  const token = process.env.WATI_ACCESS_TOKEN;
  if (!endpoint || !token) return "Missing WATI_API_ENDPOINT or WATI_ACCESS_TOKEN";

  const serverRoot = endpoint
    .replace(/\/$/, "")
    .replace(/\/api\/ext\/v3\/?$/, "")
    .replace(/\/api\/ext\/?$/, "");
  const url = `${serverRoot}/api/ext/v3/getContacts?pageSize=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });

  if (res.status === 0) return "WATI API unreachable";
  if (res.status === 401) return "WATI token expired or invalid";
  if (res.status >= 500) {
    const body = await res.text().catch(() => "");
    return `WATI API server error ${res.status}: ${body.substring(0, 100)}`;
  }
  return null;
}

async function checkJanusEmail(signal: AbortSignal): Promise<string | null> {
  const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!saKeyRaw) return "Missing GOOGLE_SERVICE_ACCOUNT_KEY";

  const token = await getGoogleServiceToken(
    ["https://mail.google.com/"],
    "assistant@example.com",
  );

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Gmail API returned ${res.status}`);
  }
  return null;
}

async function checkGmailTony(signal: AbortSignal): Promise<string | null> {
  const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!saKeyRaw) return "Missing GOOGLE_SERVICE_ACCOUNT_KEY";

  const token = await getGoogleServiceToken(
    ["https://mail.google.com/"],
    "admin@example.com",
  );

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1",
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Gmail tony@ returned ${res.status}`);
  }
  return null;
}

async function checkGoogleCalendar(signal: AbortSignal): Promise<string | null> {
  const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!saKeyRaw) return "Missing GOOGLE_SERVICE_ACCOUNT_KEY";

  const token = await getGoogleServiceToken(
    ["https://www.googleapis.com/auth/calendar.readonly"],
    "admin@example.com",
  );

  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/admin@example.com/events?maxResults=1",
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Calendar API returned ${res.status}`);
  }
  return null;
}

async function checkGoogleDrive(signal: AbortSignal): Promise<string | null> {
  const saKeyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!saKeyRaw) return "Missing GOOGLE_SERVICE_ACCOUNT_KEY";

  const token = await getGoogleServiceToken(
    ["https://www.googleapis.com/auth/drive.readonly"],
    "admin@example.com",
  );

  const res = await fetch(
    "https://www.googleapis.com/drive/v3/about?fields=storageQuota",
    { headers: { Authorization: `Bearer ${token}` }, signal },
  );

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Drive API returned ${res.status}`);
  }
  return null;
}

async function checkGoogleMapsRoutes(signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return "Missing GOOGLE_MAPS_API_KEY";

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${HOME_LAT},${HOME_LNG}&destinations=34.05,${HOME_LNG}&units=imperial&key=${apiKey}`;
  const res = await fetch(url, { signal });

  if (!res.ok) return `Distance Matrix returned ${res.status}`;
  const data: ApiErrorBody = await res.json();
  if (data.status !== "OK") return `Distance Matrix status: ${data.status}`;
  return null;
}

async function checkGoogleAirQuality(signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return "Missing GOOGLE_MAPS_API_KEY";

  const res = await fetch(
    `https://airquality.googleapis.com/v1/currentConditions:lookup?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location: { latitude: HOME_LAT, longitude: HOME_LNG } }),
      signal,
    },
  );

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Air Quality API returned ${res.status}`);
  }
  return null;
}

async function checkGooglePollen(signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return "Missing GOOGLE_MAPS_API_KEY";

  const res = await fetch(
    `https://pollen.googleapis.com/v1/forecast:lookup?key=${apiKey}&location.latitude=${HOME_LAT}&location.longitude=${HOME_LNG}&days=1`,
    { signal },
  );

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Pollen API returned ${res.status}`);
  }
  return null;
}

async function checkFirecrawl(signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return "Missing FIRECRAWL_API_KEY";

  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "test", limit: 1 }),
    signal,
  });

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Firecrawl returned ${res.status}`);
  }
  return null;
}

async function checkElevenLabs(signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return "Missing ELEVENLABS_API_KEY";

  const res = await fetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": apiKey },
    signal,
  });

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    const detail = body.detail;
    const detailMsg = typeof detail === "string" ? detail : detail?.message || "";
    return `ElevenLabs returned ${res.status}: ${detailMsg}`;
  }
  return null;
}

async function checkOpenRouter(signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return "Missing OPENROUTER_API_KEY";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
    signal,
  });

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `OpenRouter returned ${res.status}`);
  }
  return null;
}

async function checkHomeAssistant(signal: AbortSignal): Promise<string | null> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) return "degraded: Not configured (HA_URL or HA_TOKEN missing)";

  const res = await fetch(`${haUrl}/api/`, {
    headers: { Authorization: `Bearer ${haToken}` },
    signal,
  });

  if (!res.ok) return `Home Assistant returned ${res.status}`;
  return null;
}

async function checkNotion(signal: AbortSignal): Promise<string | null> {
  const apiKey = process.env.NOTION_API_KEY;
  if (!apiKey) return "Missing NOTION_API_KEY";

  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": "2022-06-28",
    },
    signal,
  });

  if (!res.ok) {
    const body: ApiErrorBody = await res.json().catch(() => ({}));
    return extractErrorMessage(body, `Notion returned ${res.status}`);
  }
  return null;
}

async function checkMemoryDB(_signal: AbortSignal): Promise<string | null> {
  try {
    await query("SELECT id FROM janus_memory LIMIT 1");
    return null;
  } catch (e) {
    return `Memory DB error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const checkDefs: Array<[string, (signal: AbortSignal) => Promise<string | null>]> = [
  ["janus_chat", checkJanusChat],
  ["janus_whatsapp", checkJanusWhatsApp],
  ["janus_email", checkJanusEmail],
  ["gmail_tony", checkGmailTony],
  ["google_calendar", checkGoogleCalendar],
  ["google_drive", checkGoogleDrive],
  ["google_maps_routes", checkGoogleMapsRoutes],
  ["google_air_quality", checkGoogleAirQuality],
  ["google_pollen", checkGooglePollen],
  ["firecrawl", checkFirecrawl],
  ["wati_whatsapp", checkJanusWhatsApp],
  ["elevenlabs", checkElevenLabs],
  ["openrouter", checkOpenRouter],
  ["home_assistant", checkHomeAssistant],
  ["notion", checkNotion],
  ["memory_db", checkMemoryDB],
];

export async function handleHealthCheck(req: Request, res: Response) {
  try {
    const startTime = Date.now();

    const settled = await Promise.allSettled(
      checkDefs.map(([name, fn]) => runCheck(name, fn)),
    );

    const results: CheckResult[] = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      return {
        name: checkDefs[i][0],
        status: "error" as CheckStatus,
        latency_ms: 0,
        message: s.reason instanceof Error ? s.reason.message : String(s.reason),
      };
    });

    const total_ms = Date.now() - startTime;
    const overall: CheckStatus = results.some((r) => r.status === "error")
      ? "error"
      : results.some((r) => r.status === "degraded")
        ? "degraded"
        : "ok";

    if (overall === "error") {
      const failedServices = results.filter((r) => r.status === "error").map((r) => r.name).join(", ");
      await sendAutomationFailureAlert("janus-health-check", `Services down: ${failedServices}`);
    }

    await query(
      "INSERT INTO janus_health_logs (results, overall_status, total_ms) VALUES ($1, $2, $3)",
      [JSON.stringify(results), overall, total_ms],
    );

    logAudit("janus-health-check", {
      category: "automation",
      event_type: "health_check",
      severity: overall === "error" ? "error" : overall === "degraded" ? "warn" : "info",
      actor_id: "system",
      actor_name: "Health Check",
      actor_role: "system",
      channel: "api",
      summary: `Health check: ${overall} (${results.filter((r) => r.status === "error").length} errors, ${total_ms}ms)`,
      detail: {
        overall,
        total_ms,
        error_checks: results.filter((r) => r.status !== "ok").map((r) => r.name),
      },
      duration_ms: total_ms,
      status: overall === "error" ? "error" : "success",
    });

    console.log(`Health check complete: ${overall} in ${total_ms}ms`);
    results.forEach((r) =>
      console.log(
        `  ${r.status.toUpperCase().padEnd(8)} ${r.name.padEnd(24)} ${r.latency_ms}ms${r.message ? " — " + r.message : ""}`,
      ),
    );

    res.json({ overall, total_ms, results, checked_at: new Date().toISOString() });
  } catch (err) {
    console.error("Health check handler error:", err);
    await enqueueFailedJob("janus-health-check", err);
    await sendAutomationFailureAlert("janus-health-check", err instanceof Error ? err.message : String(err));
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
