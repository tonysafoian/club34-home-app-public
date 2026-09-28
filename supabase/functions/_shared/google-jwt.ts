/**
 * Native Deno JWT helper for Google Service Account authentication.
 * Uses Web Crypto API (no npm dependencies).
 */

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface GoogleServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/**
 * Create a signed JWT and exchange it for a Google access token.
 * @param saKey  Parsed service account JSON
 * @param scopes Space-separated OAuth scopes
 * @param subject Email to impersonate (domain-wide delegation)
 */
export async function getGoogleAccessToken(
  saKey: GoogleServiceAccountKey,
  scopes: string,
  subject?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims: Record<string, unknown> = {
    iss: saKey.client_email,
    scope: scopes,
    aud: saKey.token_uri,
    iat: now,
    exp: now + 3600,
  };
  if (subject) claims.sub = subject;

  const encoder = new TextEncoder();
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const claimsB64 = base64url(encoder.encode(JSON.stringify(claims)));
  const unsigned = `${headerB64}.${claimsB64}`;

  // Import RSA private key
  const pemBody = saKey.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, encoder.encode(unsigned)),
  );

  const jwt = `${unsigned}.${base64url(signature)}`;

  // Exchange JWT for access token
  const tokenRes = await fetch(saKey.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Google token exchange failed: ${tokenRes.status} - ${err}`);
  }

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('No access_token in Google token response');
  }
  return tokenData.access_token;
}

/**
 * Convenience: parse GOOGLE_SERVICE_ACCOUNT_KEY env var and get a token.
 */
export async function getGoogleTokenFromEnv(
  scopes: string,
  subject?: string,
): Promise<string> {
  const saKeyJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_KEY');
  if (!saKeyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured');
  const credentials: GoogleServiceAccountKey = JSON.parse(saKeyJson);
  return getGoogleAccessToken(credentials, scopes, subject);
}
