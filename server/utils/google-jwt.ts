import { webcrypto } from "node:crypto";

const crypto = webcrypto as unknown as Crypto;

function base64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface GoogleServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

const _tokenCache: Map<string, { token: string; expiresAt: number }> = new Map();
const TOKEN_CACHE_TTL = 50 * 60_000;

export async function getGoogleServiceToken(
  scopes: string[],
  sub = "assistant@example.com",
): Promise<string> {
  const cacheKey = `${scopes.sort().join(",")}|${sub}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY missing");
  const sa: GoogleServiceAccountKey = JSON.parse(raw);

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims: Record<string, unknown> = {
    iss: sa.client_email,
    sub,
    scope: scopes.join(" "),
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  };

  const enc = new TextEncoder();
  const hB = base64url(enc.encode(JSON.stringify(header)));
  const cB = base64url(enc.encode(JSON.stringify(claims)));
  const unsigned = `${hB}.${cB}`;

  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const keyBytes = Buffer.from(pemBody, "base64");

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, enc.encode(unsigned)),
  );
  const jwt = `${unsigned}.${base64url(sig)}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  const token = (await res.json()).access_token;
  _tokenCache.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_CACHE_TTL });
  return token;
}

export async function getGoogleAccessToken(
  saKey: GoogleServiceAccountKey,
  scopes: string,
  subject?: string,
): Promise<string> {
  const scopeArr = scopes.split(" ").filter(Boolean);
  return getGoogleServiceToken(scopeArr, subject || "assistant@example.com");
}
