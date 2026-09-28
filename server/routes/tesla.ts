import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { getAuthUser } from '../auth.js';
import { logAudit } from '../lib/auditLog.js';
import { checkRateLimit } from '../lib/rateLimiter.js';
import { canRequest, recordSuccess, recordFailure, circuitOpenResponse } from '../lib/circuitBreaker.js';
import { safeErrorJson } from '../lib/errorSanitizer.js';
import { getCorrelationId } from '../lib/correlation.js';
import { fetchT } from '../lib/fetchWithTimeout.js';
import { query } from '../lib/db.js';
import type { TeslaTokenRow } from '../../shared/dbRows.js';
import { runTeslaBatteryMonitor } from '../scheduledTasks.js';

const router = Router();

const TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_AUTH_BASE = "https://fleet-auth.prd.vn.cloud.tesla.com";

async function refreshTokenIfNeeded(
  userId: string,
  tokenRow: Pick<TeslaTokenRow, 'access_token' | 'refresh_token' | 'token_expires_at'>
): Promise<string> {
  const expiresAt = new Date(tokenRow.token_expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000) {
    return tokenRow.access_token;
  }

  const clientId = process.env.TESLA_CLIENT_ID!;
  const clientSecret = process.env.TESLA_CLIENT_SECRET!;

  const res = await fetch(`${TESLA_AUTH_BASE}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token,
    }),
  });

  if (!res.ok) {
    throw new Error("Failed to refresh Tesla token");
  }

  const data = await res.json() as Record<string, any>;

  await query(
    `UPDATE tesla_tokens SET access_token = $1, refresh_token = $2, token_expires_at = $3 WHERE user_id = $4`,
    [data.access_token, data.refresh_token || tokenRow.refresh_token, new Date(Date.now() + data.expires_in * 1000).toISOString(), userId]
  );

  return data.access_token as string;
}

async function getTokenRow(): Promise<TeslaTokenRow | null> {
  const { rows } = await query<TeslaTokenRow>(`SELECT * FROM tesla_tokens ORDER BY token_expires_at DESC LIMIT 1`);
  return rows.length > 0 ? rows[0] : null;
}

async function teslaProxyHandler(req: AuthenticatedRequest, res: Response) {
  const correlationId = getCorrelationId(req);
  const start = Date.now();
  const authUser = getAuthUser(req);
  const userId = authUser?.userId || req.userId || 'UNKNOWN';
  const actorName = authUser?.displayName || authUser?.email || 'UNKNOWN';

  try {
    const rl = checkRateLimit(userId, 'tesla-proxy', { maxRequests: 30, windowMs: 60_000 });
    if (!rl.allowed) {
      res.status(429).set('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000))).json({ error: 'Too many requests' });
      return;
    }

    const { allowed: circuitAllowed } = canRequest('tesla-api');
    if (!circuitAllowed) {
      const circ = circuitOpenResponse('Tesla API');
      res.status(circ.status).set(circ.headers).json(circ.body);
      return;
    }

    const tokenRow = await getTokenRow();
    if (!tokenRow) {
      res.status(401).json({ error: "Tesla not connected. Please authorize first." });
      return;
    }

    const accessToken = await refreshTokenIfNeeded(tokenRow.user_id, tokenRow);
    const action = req.query.action as string;

    if (action === "vehicles") {
      const apiRes = await fetch(`${TESLA_API_BASE}/api/1/vehicles`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await apiRes.json() as any;

      if (apiRes.status === 412) {
        res.status(412).json({
          error: "pairing_required",
          message: `Your Tesla account requires fleet key pairing. Open the Tesla app or visit https://tesla.com/_ak/${process.env.APP_DOMAIN || "example.com"} to approve.`,
        });
        return;
      }

      if (!apiRes.ok) { recordFailure('tesla-api'); } else { recordSuccess('tesla-api'); }

      const vehicles = Array.isArray(data?.response)
        ? data.response
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.items) ? data.items
        : [];

      logAudit('tesla-proxy', {
        category: 'vehicle', event_type: 'tesla_vehicles', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'system',
        summary: `Listed ${vehicles.length} vehicles`,
        detail: { correlation_id: correlationId, count: vehicles.length },
        status: 'success', duration_ms: Date.now() - start,
      });

      res.status(apiRes.status).json({ ...data, response: vehicles, vehicles });
      return;
    }

    if (action === "vehicle-data") {
      const vehicleId = req.query.id as string;
      if (!vehicleId) { res.status(400).json({ error: "Missing vehicle id" }); return; }

      let endpoints = "charge_state;climate_state;drive_state;location_data;vehicle_state";
      let apiUrl = `${TESLA_API_BASE}/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=${encodeURIComponent(endpoints)}`;
      let apiRes = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      let data = await apiRes.json() as any;

      if (apiRes.status === 403) {
        endpoints = "charge_state;climate_state;drive_state;vehicle_state";
        apiUrl = `${TESLA_API_BASE}/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=${encodeURIComponent(endpoints)}`;
        apiRes = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        data = await apiRes.json() as any;

        try {
          const locRes = await fetch(`${TESLA_API_BASE}/api/1/vehicles/${vehicleId}/vehicle_data?endpoints=${encodeURIComponent("location_data")}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (locRes.ok) {
            const locData = await locRes.json() as any;
            if (locData?.response?.drive_state) {
              data.response = { ...data.response, drive_state: locData.response.drive_state };
            }
          }
        } catch {}
      }

      if (!apiRes.ok) { recordFailure('tesla-api'); } else { recordSuccess('tesla-api'); }

      logAudit('tesla-proxy', {
        category: 'vehicle', event_type: 'tesla_vehicle_data', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'system',
        summary: `Vehicle data for ${vehicleId}`,
        detail: { correlation_id: correlationId, vehicle_id: vehicleId },
        status: apiRes.ok ? 'success' : 'error', duration_ms: Date.now() - start,
      });

      res.status(apiRes.status).json(data);
      return;
    }

    if (action === "wake") {
      const vehicleId = req.query.id as string;
      if (!vehicleId) { res.status(400).json({ error: "Missing vehicle id" }); return; }

      const apiRes = await fetch(`${TESLA_API_BASE}/api/1/vehicles/${vehicleId}/wake_up`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await apiRes.json() as any;

      if (!apiRes.ok) { recordFailure('tesla-api'); } else { recordSuccess('tesla-api'); }

      logAudit('tesla-proxy', {
        category: 'vehicle', event_type: 'tesla_wake', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'system',
        summary: `Wake vehicle ${vehicleId}`,
        detail: { correlation_id: correlationId, vehicle_id: vehicleId },
        status: apiRes.ok ? 'success' : 'error', duration_ms: Date.now() - start,
      });

      res.status(apiRes.status).json(data);
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Tesla proxy error:", err);
    recordFailure('tesla-api');
    logAudit('tesla-proxy', {
      category: 'vehicle', event_type: 'tesla_error', severity: 'error',
      actor_id: userId, actor_name: actorName, channel: 'system',
      summary: `Tesla proxy error: ${err instanceof Error ? err.message : 'unknown'}`,
      detail: { correlation_id: getCorrelationId(req) },
      status: 'error', duration_ms: Date.now() - start,
    });
    res.status(500).json(safeErrorJson(err));
  }
}

router.get('/', requireAuth, teslaProxyHandler);
router.get('/proxy', requireAuth, teslaProxyHandler);
router.post('/proxy', requireAuth, teslaProxyHandler);

router.all('/setup', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.userId || 'unknown';
  const body = req.body as Record<string, unknown> | undefined;
  const action = (req.query.action || body?.action) as string;

  try {
    if (action === "generate-key") {
      const privatePem = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgfhxJjnk7hBcNZf7l
4Te9dyHPbl1136d7vDFaeFaIvBuhRANCAASKclpVOzhxEGpg0M9eSQtYq+vHz6rn
AGF0Xg3Xn/1vcyhkxIzjRAVL7CIy2R+SuKAOMVUxsPPHwYJMzOLCE2T4
-----END PRIVATE KEY-----`;
      const publicPem = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEinJaVTs4cRBqYNDPXkkLWKvrx8+q
5wBhdF4N15/9b3MoZMSM40QFS+wiMtkfkrigDjFVMbDzx8GCTMziwhNk+A==
-----END PUBLIC KEY-----`;

      const { rows: existing } = await query(`SELECT id FROM tesla_config LIMIT 1`);
      if (existing.length > 0) {
        await query(`UPDATE tesla_config SET private_key_pem = $1, public_key_pem = $2, partner_registered = false WHERE id = $3`, [privatePem, publicPem, existing[0].id]);
      } else {
        await query(`INSERT INTO tesla_config (private_key_pem, public_key_pem, partner_registered, region) VALUES ($1, $2, false, 'na')`, [privatePem, publicPem]);
      }

      res.json({
        public_key_pem: publicPem,
        message: `Host this PEM at https://${process.env.APP_DOMAIN || "example.com"}/.well-known/appspecific/com.tesla.3p.public-key.pem`,
      });
      return;
    }

    if (action === "public-key") {
      const { rows } = await query(`SELECT public_key_pem FROM tesla_config LIMIT 1`);
      if (rows.length === 0) {
        res.status(404).json({ error: "No keypair generated yet" });
        return;
      }
      res.set('Content-Type', 'application/x-pem-file').send(rows[0].public_key_pem);
      return;
    }

    if (action === "register-partner") {
      const clientId = process.env.TESLA_CLIENT_ID;
      const clientSecret = process.env.TESLA_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        res.status(500).json({ error: "Tesla credentials not configured" });
        return;
      }

      const tokenBody = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "openid vehicle_device_data vehicle_cmds vehicle_charging_cmds",
        audience: TESLA_API_BASE,
      });

      const tokenRes = await fetch(`${TESLA_AUTH_BASE}/oauth2/v3/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenBody,
      });
      const tokenData = await tokenRes.json() as any;

      if (!tokenRes.ok) {
        res.status(400).json({ error: "Failed to get partner token", details: tokenData });
        return;
      }

      const regRes = await fetch(`${TESLA_API_BASE}/api/1/partner_accounts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domain: process.env.APP_DOMAIN || "example.com" }),
      });
      const regData = await regRes.json() as any;

      const alreadyRegistered = !regRes.ok &&
        (JSON.stringify(regData).includes("already") || JSON.stringify(regData).includes("taken"));

      if (regRes.ok || alreadyRegistered) {
        const { rows: configs } = await query(`SELECT id FROM tesla_config LIMIT 1`);
        if (configs.length > 0) {
          await query(`UPDATE tesla_config SET partner_registered = true WHERE id = $1`, [configs[0].id]);
        }
      }

      res.status(regRes.ok || alreadyRegistered ? 200 : regRes.status).json(regData);
      return;
    }

    if (action === "auth-url") {
      const clientId = process.env.TESLA_CLIENT_ID;
      if (!clientId) { res.status(500).json({ error: "Tesla client ID not configured" }); return; }

      const appDomain = process.env.APP_DOMAIN || "example.com";
      const redirectUri = `https://${appDomain}/tesla-callback`;
      const state = crypto.randomUUID();
      const authUrl =
        `https://auth.tesla.com/oauth2/v3/authorize?` +
        `client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent("openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds")}` +
        `&state=${state}`;

      res.json({ auth_url: authUrl, state });
      return;
    }

    if (action === "exchange-code") {
      const code = (req.query.code || body?.code) as string;
      if (!code) { res.status(400).json({ error: "Missing authorization code" }); return; }

      const clientId = process.env.TESLA_CLIENT_ID!;
      const clientSecret = process.env.TESLA_CLIENT_SECRET!;
      const redirectUri = `https://${process.env.APP_DOMAIN || "example.com"}/tesla-callback`;

      const tokenRes = await fetch(`${TESLA_AUTH_BASE}/oauth2/v3/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          audience: TESLA_API_BASE,
        }),
      });

      const tokenData = await tokenRes.json() as any;
      if (!tokenRes.ok) {
        res.status(400).json({ error: "Token exchange failed", details: tokenData });
        return;
      }

      await query(
        `INSERT INTO tesla_tokens (user_id, access_token, refresh_token, token_expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET access_token = EXCLUDED.access_token, refresh_token = EXCLUDED.refresh_token, token_expires_at = EXCLUDED.token_expires_at, updated_at = NOW()`,
        [userId, tokenData.access_token, tokenData.refresh_token, new Date(Date.now() + tokenData.expires_in * 1000).toISOString()]
      );

      res.json({ success: true });
      return;
    }

    if (action === "status") {
      const { rows: configs } = await query(`SELECT partner_registered, region, public_key_pem FROM tesla_config LIMIT 1`);
      const config = configs.length > 0 ? configs[0] : null;

      const { rows: tokens } = await query<Pick<TeslaTokenRow, 'token_expires_at'>>(`SELECT * FROM tesla_tokens ORDER BY token_expires_at DESC LIMIT 1`);
      const token = tokens.length > 0 ? tokens[0] : null;

      const hasClientId = !!process.env.TESLA_CLIENT_ID;
      const hasClientSecret = !!process.env.TESLA_CLIENT_SECRET;

      res.json({
        credentials_configured: hasClientId && hasClientSecret,
        keypair_generated: !!config?.public_key_pem,
        partner_registered: config?.partner_registered ?? false,
        user_authenticated: !!token,
        token_valid: token ? new Date(token.token_expires_at) > new Date() : false,
      });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Tesla setup error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Unknown error" });
  }
});

router.get('/map', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "Google Maps API key not configured" });
    return;
  }

  const HOME_LAT = 34.0522;
  const HOME_LNG = -118.2437;
  const action = req.query.action as string;

  if (action === "api-key") {
    res.json({ api_key: apiKey });
    return;
  }

  if (action === "distance") {
    const destinations = req.query.destinations as string;
    if (!destinations) { res.status(400).json({ error: "Missing destinations" }); return; }

    const dmUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${HOME_LAT},${HOME_LNG}&destinations=${encodeURIComponent(destinations)}&units=imperial&key=${apiKey}`;
    const apiRes = await fetch(dmUrl);
    const data = await apiRes.json() as any;

    res.json({ home: { lat: HOME_LAT, lng: HOME_LNG }, ...data });
    return;
  }

  res.status(400).json({ error: "Unknown action" });
});

router.post('/battery-monitor', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await runTeslaBatteryMonitor();
    res.json({ ok: true });
  } catch (err) {
    console.error('[tesla/battery-monitor] route error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
