import { createClient, type SupabaseClient } from "../utils/supabase.js";
import { breakers } from "./breakers.js";

export const PROJECT_ID = process.env.PROJECT_ID || "sample-project-id";
export const TONY_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
export const JANUS_EMAIL = process.env.ASSISTANT_EMAIL || "assistant@example.com";
export const MOM_EMAIL = process.env.MEMBER_EMAIL || "member@example.com";
export const EMME_EMAIL = "member2@example.com";
export const ISLA_EMAIL = "member3@example.com";
export const HOME_LAT = Number(process.env.HOME_LAT) || 34.0522;
export const HOME_LNG = Number(process.env.HOME_LNG) || -118.2437;
export const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  process.env.GOOGLE_CLIENT_ID || "";
const APP_DOMAIN = process.env.APP_DOMAIN || "example.com";
const GOOGLE_REDIRECT_BASE = process.env.GOOGLE_REDIRECT_BASE_URL || `https://${APP_DOMAIN}`;
export const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${GOOGLE_REDIRECT_BASE}/google/callback`;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export function base64url(data: Uint8Array): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function getServiceToken(
  saKey: ServiceAccountKey,
  scope: string,
  sub?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const h = base64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const p = base64url(
    enc.encode(
      JSON.stringify({
        iss: saKey.client_email,
        scope,
        aud: saKey.token_uri,
        exp: now + 3600,
        iat: now,
        ...(sub ? { sub } : {}),
      }),
    ),
  );
  const unsigned = `${h}.${p}`;
  const pemBody = saKey.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const keyBytes = Uint8Array.from(
    Buffer.from(pemBody, "base64"),
  );
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      enc.encode(unsigned),
    ),
  );
  const jwt = `${unsigned}.${base64url(sig)}`;
  const res = await fetch(saKey.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!data.access_token)
    throw new Error(data.error_description || "Token exchange failed");
  return data.access_token;
}

export function getSaKey(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  return JSON.parse(raw);
}

export async function getGoogleTokenFromEnv(
  scopes: string,
  subject?: string,
): Promise<string> {
  const saKey = getSaKey();
  return getServiceToken(saKey, scopes, subject);
}

export function fetchT(
  input: string | URL | Request,
  init?: RequestInit,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

export function getServiceClient(): SupabaseClient {
  return createClient();
}

export async function logAudit(
  edgeFunction: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    const { query: q } = await import('./db.js');
    const keys = ['edge_function', ...Object.keys(entry)];
    const values = [edgeFunction, ...Object.values(entry).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v)];
    const ph = keys.map((_, i) => `$${i + 1}`);
    await q(`INSERT INTO system_audit_log (${keys.join(', ')}) VALUES (${ph.join(', ')})`, values);
  } catch (e) {
    console.error("Audit log failed:", e);
  }
}

export async function enqueueFailedJob(
  functionName: string,
  error: unknown,
): Promise<void> {
  try {
    const { query: q } = await import('./db.js');
    const msg = error instanceof Error ? error.message : String(error);
    await q(
      `INSERT INTO failed_jobs (function_name, error_message, error_detail) VALUES ($1, $2, $3)`,
      [functionName, msg.slice(0, 2000), JSON.stringify({ stack: error instanceof Error ? error.stack : null })]
    );
  } catch (_) {}
}

let _alertPhone: string | null = null;

export async function getAlertPhoneNumber(): Promise<string> {
  if (_alertPhone) return _alertPhone;
  try {
    const svc = getServiceClient();
    const { data } = await svc
      .from("system_config")
      .select("value")
      .eq("key", "alert_phone_number")
      .single();
    if (data?.value) {
      _alertPhone = data.value;
      return data.value;
    }
  } catch (_) {}
  _alertPhone = "13107101111";
  return _alertPhone;
}

export async function sendWhatsApp(message: string): Promise<void> {
  const endpoint = process.env.WATI_API_ENDPOINT;
  const token = process.env.WATI_ACCESS_TOKEN;
  if (!endpoint || !token) return;
  const phone = await getAlertPhoneNumber();
  const serverRoot = endpoint
    .replace(/\/$/, "")
    .replace(/\/api\/ext\/v3\/?$/, "")
    .replace(/\/api\/ext\/?$/, "");
  try {
    await fetchT(
      `${serverRoot}/api/ext/v3/sendSessionMessage/${phone}?messageText=${encodeURIComponent(message)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      15_000,
    );
  } catch (e) {
    console.error("WhatsApp send failed:", e);
  }
}

/**
 * Send a WhatsApp message to an explicit phone number.
 * Returns true if the message was accepted by WATI, false otherwise
 * (including when WATI credentials are not configured).
 */
export async function sendWhatsAppTo(
  phone: string,
  message: string,
): Promise<boolean> {
  const endpoint = process.env.WATI_API_ENDPOINT;
  const token = process.env.WATI_ACCESS_TOKEN;
  if (!endpoint || !token) {
    console.warn("[sendWhatsAppTo] WATI credentials not configured — message not sent");
    return false;
  }
  const serverRoot = endpoint
    .replace(/\/$/, "")
    .replace(/\/api\/ext\/v3\/?$/, "")
    .replace(/\/api\/ext\/?$/, "");
  try {
    const res = await fetchT(
      `${serverRoot}/api/ext/v3/sendSessionMessage/${phone}?messageText=${encodeURIComponent(message)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      },
      15_000,
    );
    if (!res.ok) {
      console.error(`[sendWhatsAppTo] WATI HTTP ${res.status} for phone ${phone}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[sendWhatsAppTo] send failed:", e);
    return false;
  }
}

let _fallbackPhone: string | null = null;

/**
 * Returns the phone number to use for family/broadcast fallback WhatsApp messages.
 * Looks up "broadcast_fallback_phone" in system_config; falls back to the alert phone.
 */
export async function getBroadcastFallbackPhone(): Promise<string> {
  if (_fallbackPhone) return _fallbackPhone;
  try {
    const svc = getServiceClient();
    const { data } = await svc
      .from("system_config")
      .select("value")
      .eq("key", "broadcast_fallback_phone")
      .single();
    if (data?.value) {
      _fallbackPhone = data.value;
      return data.value;
    }
  } catch (_) {}
  // Fall back to the alert phone (Tony's number)
  const alertPhone = await getAlertPhoneNumber();
  _fallbackPhone = alertPhone;
  return alertPhone;
}

export async function sendGmailRaw(
  saKey: ServiceAccountKey,
  to: string,
  subject: string,
  html: string,
  text: string,
  from = JANUS_EMAIL,
  bcc?: string,
): Promise<boolean> {
  const token = await getServiceToken(
    saKey,
    "https://www.googleapis.com/auth/gmail.send",
    from,
  );
  const enc = new TextEncoder();
  const boundary = "boundary_" + crypto.randomUUID().replace(/-/g, "");
  const subjectB64 = Buffer.from(subject).toString("base64");
  const headers = [
    `From: Janus <${from}>`,
    `To: ${to}`,
  ];
  if (bcc) headers.push(`Bcc: ${bcc}`);
  const mime = [
    ...headers,
    `Subject: =?UTF-8?B?${subjectB64}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${boundary}--`,
  ].join("\r\n");

  const raw = base64url(enc.encode(mime));
  const res = await breakers.gmail.execute(() => fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
  ));

  if (!res.ok) {
    const err = await res.text();
    console.error("Gmail send failed:", res.status, err);
    return false;
  }
  return true;
}

export function isAllowedOrigin(origin: string): boolean {
  if (origin === `https://${APP_DOMAIN}` || origin === `https://www.${APP_DOMAIN}`)
    return true;
  if (origin === "https://club34.ai" || origin === "https://www.club34.ai")
    return true;
  return false;
}

export function getCorsHeaders(origin: string): Record<string, string> {
  const allowedOrigin = isAllowedOrigin(origin)
    ? origin
    : "https://example.com";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-correlation-id, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  };
}

export async function authenticateRequest(
  authHeaderOrCookie: string | undefined,
  cookieToken?: string,
): Promise<{
  userId: string | null;
  email: string | null;
  isServiceRole: boolean;
  error: string | null;
}> {
  const cronSecret = process.env.CRON_SECRET;
  if (authHeaderOrCookie?.startsWith("Bearer ")) {
    const token = authHeaderOrCookie.replace("Bearer ", "");

    if (cronSecret && token === cronSecret) {
      return { userId: "cron", email: null, isServiceRole: true, error: null };
    }

    const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    if (jwtSecret && token === jwtSecret) {
      return { userId: "service", email: null, isServiceRole: true, error: null };
    }
  }

  let jwtToken = cookieToken;
  if (!jwtToken && authHeaderOrCookie?.startsWith("Bearer ")) {
    jwtToken = authHeaderOrCookie.replace("Bearer ", "");
  }

  if (!jwtToken) {
    return { userId: null, email: null, isServiceRole: false, error: "Unauthorized" };
  }

  try {
    const jwt = await import("jsonwebtoken");
    const secret = process.env.JWT_SECRET || process.env.SESSION_SECRET || "club34-dev-secret-change-in-production";
    const decoded = jwt.default.verify(jwtToken, secret) as { userId?: string; email?: string; sub?: string };
    return {
      userId: decoded.userId || decoded.sub || null,
      email: decoded.email || null,
      isServiceRole: false,
      error: null,
    };
  } catch {
    return { userId: null, email: null, isServiceRole: false, error: "Unauthorized" };
  }
}

export async function logEmail(
  emailType: string,
  subject: string,
  recipients: string[],
  htmlBody: string,
  status: string,
  errorMessage?: string,
  textBody?: string,
  metadata?: any,
): Promise<void> {
  try {
    const { query: q } = await import('./db.js');
    await q(
      `INSERT INTO email_logs (email_type, subject, recipients, html_body, text_body, status, error_message, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [emailType, subject, recipients, htmlBody, textBody || null, status, errorMessage || null, metadata ? JSON.stringify(metadata) : null]
    );
  } catch (e) {
    console.error("logEmail error:", e);
  }
}

export async function callAI(
  systemPrompt: string,
  userContent: string,
  maxTokens = 8000,
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const resp = await fetchT(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    },
    60_000,
  );
  if (!resp.ok) throw new Error(`AI API error: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function callAIJSON(
  prompt: string,
  maxTokens = 4000,
): Promise<any> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");
  const res = await fetchT(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    },
    60_000,
  );
  if (!res.ok) throw new Error(`AI JSON API error: ${res.status}`);
  const data = await res.json();
  const content = (data.choices?.[0]?.message?.content || "").trim();
  try {
    return JSON.parse(content);
  } catch {
    const m =
      content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      content.match(/(\{[\s\S]*\})/);
    return JSON.parse(m ? (m[1] || m[0]) : content);
  }
}
