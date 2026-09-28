import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { fetchT } from '../lib/fetchWithTimeout.js';

const router = Router();

const API_BASE = "https://app.mobilelinkgen.com/api";
const FORM_ENCODED = "application/x-www-form-urlencoded;charset=UTF-8";

const encode = encodeURIComponent;
const encodeForm = (fields: Record<string, string>) =>
  Object.keys(fields).map(k => `${encode(k)}=${encode(fields[k])}`).join("&");

class CookieJar {
  private cookies: Map<string, string> = new Map();

  extract(resp: globalThis.Response) {
    const raw = resp.headers.get("set-cookie");
    if (raw) {
      for (const part of raw.split(',')) {
        const cookiePart = part.split(";")[0].trim();
        const eqIdx = cookiePart.indexOf("=");
        if (eqIdx > 0) {
          this.cookies.set(cookiePart.substring(0, eqIdx).trim(), cookiePart.substring(eqIdx + 1).trim());
        }
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
  }

  count(): number { return this.cookies.size; }

  async get(url: string, extraHeaders: Record<string, string> = {}): Promise<globalThis.Response> {
    return this._fetch(url, { method: "GET", headers: extraHeaders });
  }

  async post(url: string, body: string, extraHeaders: Record<string, string> = {}): Promise<globalThis.Response> {
    return this._fetch(url, { method: "POST", body, headers: { "Content-Type": FORM_ENCODED, ...extraHeaders } });
  }

  private async _fetch(url: string, options: RequestInit): Promise<globalThis.Response> {
    const headers = new Headers(options.headers as Record<string, string> || {});
    const ck = this.header();
    if (ck) headers.set("Cookie", ck);

    const resp = await fetchT(url, { ...options, headers, redirect: "manual" });
    this.extract(resp);

    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      try { await resp.arrayBuffer(); } catch {}
      if (loc) {
        const next = loc.startsWith("http") ? loc : new URL(loc, url).href;
        return this.get(next);
      }
    }

    return resp;
  }
}

const B2C_TENANT = "generacconnectivity.onmicrosoft.com";
const B2C_POLICY = "B2C_1A_MobileLink_SignIn";
const B2C_CLIENT_ID = "cf3e2bfb-2d0c-47dd-8067-bf59a6f88ed7";
const B2C_TOKEN_URL = `https://generacconnectivity.b2clogin.com/${B2C_TENANT}/${B2C_POLICY}/oauth2/v2.0/token`;
const B2C_SCOPE = `openid https://${B2C_TENANT}/${B2C_CLIENT_ID}/client offline_access`;
const LOGIN_BASE = "https://generacconnectivity.b2clogin.com/generacconnectivity.onmicrosoft.com/B2C_1A_MobileLink_SignIn";

function extractSettings(html: string): { csrf: string; transId: string } | null {
  const match = /var SETTINGS = (\{.*?\});/ms.exec(html);
  if (match?.[1]) {
    try {
      const config = JSON.parse(match[1]);
      if (config?.csrf && config?.transId) return { csrf: config.csrf, transId: config.transId };
    } catch {}
  }
  for (const line of html.split("\n")) {
    if (line.trimStart().startsWith("var SETTINGS")) {
      const start = line.indexOf("{");
      const end = line.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try {
          const c = JSON.parse(line.substring(start, end + 1));
          if (c?.csrf && c?.transId) return { csrf: c.csrf, transId: c.transId };
        } catch {}
      }
    }
  }
  return null;
}

function extractForm(html: string): { action: string; state: string; code: string } | null {
  const actionMatch = html.match(/<form[^>]*action=["']([^"']+)["']/i);
  if (!actionMatch || actionMatch[1].toLowerCase().includes("javascript")) return null;
  const stateMatch = html.match(/<input[^>]*name=["']state["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']state["']/i);
  const codeMatch = html.match(/<input[^>]*name=["']code["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/<input[^>]*value=["']([^"']+)["'][^>]*name=["']code["']/i);
  if (!stateMatch || !codeMatch) return null;
  return { action: actionMatch[1], state: stateMatch[1], code: codeMatch[1] };
}

async function login(jar: CookieJar, username: string, password: string): Promise<string> {
  console.log("Attempting ROPC token flow...");
  try {
    const tokenResp = await fetchT(B2C_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": FORM_ENCODED },
      body: encodeForm({
        grant_type: "password",
        client_id: B2C_CLIENT_ID,
        scope: B2C_SCOPE,
        username,
        password,
        response_type: "token",
      }),
    });
    const tokenText = await tokenResp.text();
    if (tokenResp.ok) {
      const tokenData = JSON.parse(tokenText);
      if (tokenData.access_token) {
        (jar as any)._accessToken = tokenData.access_token;
        return "";
      }
    }
  } catch (e) {
    console.log(`ROPC failed: ${(e as Error).message}`);
  }

  console.log("Falling back to B2C UI scraping flow...");
  const r1 = await jar.get(`${API_BASE}/Auth/SignIn?email=${encode(username)}`);
  const html1 = await r1.text();

  const form1 = extractForm(html1);
  if (form1) {
    await jar.post(form1.action, encodeForm({ state: form1.state, code: form1.code }));
    return "";
  }

  const settings = extractSettings(html1);
  if (!settings) throw new Error("No SETTINGS found in B2C page");

  const tx = `StateProperties=${settings.transId}`;
  const r3 = await jar.post(
    `${LOGIN_BASE}/SelfAsserted?tx=${encode(tx)}&p=B2C_1A_SignUpOrSigninOnline`,
    encodeForm({ request_type: "RESPONSE", signInName: username, password: password }),
    { "X-Csrf-Token": settings.csrf }
  );
  const t3 = await r3.text();
  const j3 = JSON.parse(t3);
  if (j3.status !== "200") throw new Error(`Credentials rejected: ${j3.message}`);

  const r4 = await jar.get(
    `${LOGIN_BASE}/api/CombinedSigninAndSignup/confirmed?csrf_token=${settings.csrf}&tx=${encode(tx)}&p=B2C_1A_SignUpOrSigninOnline`
  );
  const html4 = await r4.text();

  const form4 = extractForm(html4);
  if (form4) {
    await jar.post(form4.action, encodeForm({ state: form4.state, code: form4.code }));
    return settings.csrf;
  }

  throw new Error("Could not complete B2C login flow");
}

function findProp(detail: any, name: string): any {
  const props = detail?.apparatusDetail?.properties || detail?.properties || [];
  return props.find((p: any) => p.name === name)?.value ?? null;
}

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const username = process.env.GENERAC_EMAIL;
    const password = process.env.GENERAC_PASSWORD;
    if (!username || !password) {
      res.status(500).json({ error: "Generac credentials not configured" });
      return;
    }

    const jar = new CookieJar();
    const csrf = await login(jar, username, password);
    const accessToken = (jar as any)._accessToken;

    const apiHeaders: Record<string, string> = {};
    if (accessToken) apiHeaders["Authorization"] = `Bearer ${accessToken}`;
    if (csrf) apiHeaders["X-Csrf-Token"] = csrf;

    const listResp = await jar.get(`${API_BASE}/v2/Apparatus/list`, apiHeaders);
    const listText = await listResp.text();

    if (!listText.trimStart().startsWith("[") && !listText.trimStart().startsWith("{")) {
      throw new Error("API returned HTML instead of JSON after login");
    }

    const apparatuses = JSON.parse(listText);
    const generators = (apparatuses || []).filter((a: any) => a.type === 0);

    const results: Record<string, unknown>[] = [];
    for (const gen of generators) {
      try {
        const detResp = await jar.get(`${API_BASE}/v1/Apparatus/details/${gen.apparatusId}`, apiHeaders);
        const detText = await detResp.text();
        const detail = JSON.parse(detText);

        results.push({
          id: gen.apparatusId,
          name: gen.name || "Generator",
          serialNumber: gen.serialNumber,
          isConnected: gen.isConnected ?? false,
          apparatusStatus: gen.apparatusStatus,
          statusText: detail?.apparatusDetail?.statusText || "Unknown",
          batteryVoltage: findProp(detail, "BatteryVoltage"),
          runHours: findProp(detail, "RunHours"),
          lastSeen: detail?.apparatusDetail?.lastSeen || null,
          heroImageUrl: gen.heroImageUrl,
          address: gen.localizedAddress,
          weather: gen.weather,
          properties: detail?.apparatusDetail?.properties || detail?.properties || [],
        });
      } catch (e) {
        console.error(`Detail error ${gen.apparatusId}:`, e);
        results.push({
          id: gen.apparatusId, name: gen.name || "Generator",
          serialNumber: gen.serialNumber, isConnected: gen.isConnected ?? false,
          statusText: "Unknown", batteryVoltage: null, runHours: null,
          lastSeen: null, properties: [],
        });
      }
    }

    res.json({ generators: results });
  } catch (err) {
    console.error("Generac proxy error:", err);
    res.status(500).json({ error: (err as Error).message || "Internal error" });
  }
});

export default router;
