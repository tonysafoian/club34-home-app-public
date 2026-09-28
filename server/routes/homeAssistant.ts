import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { getAuthUser } from '../auth.js';
import { storage } from '../storage.js';
import { logAudit } from '../lib/auditLog.js';
import { encryptToken, decryptToken } from '../lib/encryption.js';
import { guardedFetch } from '../lib/ssrfGuard.js';
import { breakers, CircuitOpenError } from '../lib/breakers.js';
import { safeErrorJson } from '../lib/errorSanitizer.js';
import { getEntityCache, getGoveeEntityIdsFromCache, isCacheReady, callHAService } from '../lib/haWebSocket.js';
import { getBroadcastFallbackPhone, getAlertPhoneNumber, sendWhatsAppTo } from '../lib/helpers.js';
import { generateAndUploadTTS, verifyPlaybackState, detectSilentDropRisk } from '../lib/castBroadcast.js';
import { getZoneFlow } from '../lib/irrigationFlow.js';
import { validateHaUrl } from '../lib/haUrlGuard.js';
import { fetch as undiciFetch, type Dispatcher } from 'undici';

const router = Router();

function requireAdmin(req: AuthenticatedRequest, res: Response, next: () => void): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// Per-user resolved HA credentials. A stored per-household token (saved from
// Settings, encrypted at rest) takes precedence over the HA_URL/HA_TOKEN env
// vars. Cached briefly because the proxy is hit constantly by the dashboard;
// invalidated whenever the user saves new settings.
interface ResolvedHACreds { haUrl: string; haToken: string; source: 'settings' | 'env' }
const haCredsCache = new Map<string, { creds: ResolvedHACreds | null; fetchedAt: number }>();
const HA_CREDS_CACHE_TTL_MS = 60 * 1000;

function invalidateHACredsCache(userId?: string): void {
  if (userId) haCredsCache.delete(userId);
  else haCredsCache.clear();
}

async function resolveHACreds(userId: string | undefined): Promise<ResolvedHACreds | null> {
  const cacheKey = userId && userId !== 'UNKNOWN' ? userId : '__env__';
  const cached = haCredsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < HA_CREDS_CACHE_TTL_MS) return cached.creds;

  let creds: ResolvedHACreds | null = null;
  if (userId && userId !== 'UNKNOWN') {
    try {
      const settings = await storage.getHomeAssistantSettings(userId);
      if (settings?.encryptedToken) {
        const token = await decryptToken(settings.encryptedToken);
        let url = settings.haUrl || process.env.HA_URL || '';
        // Defense in depth against SSRF: stored URLs were validated at save
        // time, but re-check at resolve time (per cache TTL) so an allowlist
        // change takes effect and a host that later resolves to an internal
        // address (DNS rebinding) stops being used. On rejection fall back to
        // the env-configured endpoint, which is operator-trusted as-is.
        if (url && settings.haUrl) {
          const check = await validateHaUrl(url);
          if (!check.ok) {
            console.warn(`[home-assistant] Stored HA URL for user ${userId} rejected (${check.reason}) — falling back to env HA_URL`);
            url = process.env.HA_URL || '';
          }
        }
        if (url && token) creds = { haUrl: url, haToken: token, source: 'settings' };
      }
    } catch (err) {
      // A DB/decryption failure must not take down the whole proxy — fall back
      // to env vars, but log loudly since a decrypt error usually means
      // ENCRYPTION_KEY changed and the stored token needs to be re-saved.
      console.error(
        `[home-assistant] Failed to load stored HA credentials for user ${userId}; falling back to env:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (!creds) {
    const envUrl = process.env.HA_URL ?? '';
    const envToken = process.env.HA_TOKEN ?? '';
    if (envUrl && envToken) creds = { haUrl: envUrl, haToken: envToken, source: 'env' };
  }
  haCredsCache.set(cacheKey, { creds, fetchedAt: Date.now() });
  return creds;
}

// Cached Crestron config entry id — fetched once per server restart then reused
let crestronEntryIdCache: string | null = null;
let crestronEntryIdFetchedAt = 0;
const CRESTRON_ENTRY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getCrestronEntryId(haUrl: string, haToken: string): Promise<string | null> {
  const now = Date.now();
  if (crestronEntryIdCache && now - crestronEntryIdFetchedAt < CRESTRON_ENTRY_CACHE_TTL_MS) {
    return crestronEntryIdCache;
  }
  const { status, data } = await callHA(haUrl, haToken, 'GET', '/api/config/config_entries/entry');
  if (status !== 200 || !Array.isArray(data)) return null;
  const entries = data as { entry_id: string; domain: string; title: string }[];
  const crestron = entries.find(e =>
    e.domain === 'crestron_home' ||
    (typeof e.title === 'string' && e.title.toLowerCase().includes('crestron')),
  );
  if (!crestron) return null;
  crestronEntryIdCache = crestron.entry_id;
  crestronEntryIdFetchedAt = now;
  return crestronEntryIdCache;
}

// Cached Govee Cloud config entry — fetched once per server restart then reused
let goveeEntryCache: { entry_id: string; domain: string; title: string } | null = null;
let goveeEntryIdCache: string | null = null;
let goveeEntryIdFetchedAt = 0;

async function getGoveeCloudEntryId(haUrl: string, haToken: string): Promise<{ entry_id: string; domain: string; title: string } | null> {
  const now = Date.now();
  if (goveeEntryCache && goveeEntryIdCache && now - goveeEntryIdFetchedAt < CRESTRON_ENTRY_CACHE_TTL_MS) {
    return goveeEntryCache;
  }
  const { status, data } = await callHA(haUrl, haToken, 'GET', '/api/config/config_entries/entry');
  if (status !== 200 || !Array.isArray(data)) return null;
  const entries = data as { entry_id: string; domain: string; title: string }[];
  // Prefer the Govee Cloud integration specifically; fall back to any Govee entry if
  // the cloud variant isn't found (covers govee_light, govee_ble, etc.)
  const goveeAll = entries.filter(e =>
    e.domain.toLowerCase().includes('govee') ||
    (typeof e.title === 'string' && e.title.toLowerCase().includes('govee')),
  );
  const goveeCloud = goveeAll.find(e =>
    e.domain === 'govee_cloud' ||
    (typeof e.title === 'string' && e.title.toLowerCase().includes('govee cloud')),
  );
  const govee = goveeCloud ?? goveeAll[0];
  if (!govee) return null;
  goveeEntryCache = govee;
  goveeEntryIdCache = govee.entry_id;
  goveeEntryIdFetchedAt = now;
  return govee;
}

router.post('/crestron/reload', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const creds = await resolveHACreds(req.userId);
  const HA_URL = creds?.haUrl ?? '';
  const HA_TOKEN = creds?.haToken ?? '';
  const userId = req.userId ?? 'unknown';
  const userInfo = getAuthUser(req as any);
  const actorName = (userInfo as (typeof userInfo & { name?: string }))?.name ?? userInfo?.email ?? userId;
  const t0 = Date.now();

  if (!HA_URL || !HA_TOKEN) {
    res.status(503).json({ error: 'Home Assistant not configured' });
    return;
  }

  try {
    const entryId = await getCrestronEntryId(HA_URL, HA_TOKEN);
    if (!entryId) {
      await logAudit('crestron-reload', {
        category: 'crestron_bridge',
        event_type: 'crestron_reload',
        severity: 'error',
        actor_id: userId,
        actor_name: actorName,
        channel: 'web',
        summary: 'Crestron reload failed — config entry not found',
        detail: {},
        status: 'error',
        duration_ms: Date.now() - t0,
      });
      res.status(404).json({ error: 'Crestron Home config entry not found in Home Assistant' });
      return;
    }

    const { status, data } = await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/homeassistant/reload_config_entry', {
      entry_id: entryId,
    });

    const success = status < 400;
    let haErrorMsg: string | undefined;
    if (!success && data) {
      if (typeof data === 'string') haErrorMsg = data.slice(0, 300);
      else if (typeof data === 'object') {
        const d = data as Record<string, unknown>;
        haErrorMsg = String(d.message ?? d.error ?? JSON.stringify(data)).slice(0, 300);
      }
    }
    await logAudit('crestron-reload', {
      category: 'crestron_bridge',
      event_type: 'crestron_reload',
      severity: success ? 'info' : 'warn',
      actor_id: userId,
      actor_name: actorName,
      channel: 'web',
      summary: success
        ? `Crestron integration reloaded by ${actorName}`
        : `Crestron reload failed (HTTP ${status})`,
      detail: { entry_id: entryId, ha_status: status, ...(haErrorMsg ? { ha_error: haErrorMsg } : {}) },
      status: success ? 'success' : 'error',
      duration_ms: Date.now() - t0,
    });

    res.status(success ? 200 : 502).json({ success, entry_id: entryId, data });
  } catch (err) {
    console.error('[crestron-reload] Error:', err);
    await logAudit('crestron-reload', {
      category: 'crestron_bridge',
      event_type: 'crestron_reload',
      severity: 'error',
      actor_id: userId,
      actor_name: actorName,
      channel: 'web',
      summary: `Crestron reload error: ${err instanceof Error ? err.message : String(err)}`,
      detail: { error: err instanceof Error ? err.message : String(err) },
      status: 'error',
      duration_ms: Date.now() - t0,
    });
    res.status(500).json({ error: 'Failed to reload Crestron integration' });
  }
});

router.post('/govee/reload', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const creds = await resolveHACreds(req.userId);
  const HA_URL = creds?.haUrl ?? '';
  const HA_TOKEN = creds?.haToken ?? '';
  const userId = req.userId ?? 'unknown';
  const userInfo = getAuthUser(req as any);
  const actorName = (userInfo as (typeof userInfo & { name?: string }))?.name ?? userInfo?.email ?? userId;
  const t0 = Date.now();

  if (!HA_URL || !HA_TOKEN) {
    res.status(503).json({ error: 'Home Assistant not configured' });
    return;
  }

  try {
    const entry = await getGoveeCloudEntryId(HA_URL, HA_TOKEN);
    if (!entry) {
      await logAudit('govee-reload', {
        category: 'home',
        event_type: 'govee_reload',
        severity: 'error',
        actor_id: userId,
        actor_name: actorName,
        channel: 'web',
        summary: 'Govee reload failed — config entry not found in Home Assistant',
        detail: {},
        status: 'error',
        duration_ms: Date.now() - t0,
      });
      res.status(404).json({ error: 'Govee config entry not found in Home Assistant' });
      return;
    }

    const { status, data } = await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/homeassistant/reload_config_entry', {
      entry_id: entry.entry_id,
    });

    const success = status < 400;
    let haErrorMsg: string | undefined;
    if (!success && data) {
      if (typeof data === 'string') haErrorMsg = data.slice(0, 300);
      else if (typeof data === 'object') {
        const d = data as Record<string, unknown>;
        haErrorMsg = String(d.message ?? d.error ?? JSON.stringify(data)).slice(0, 300);
      }
    }

    // Invalidate the cached Govee entry so the next call re-discovers after reload
    goveeEntryCache = null;
    goveeEntryIdCache = null;
    goveeEntryIdFetchedAt = 0;

    await logAudit('govee-reload', {
      category: 'home',
      event_type: 'govee_reload',
      severity: success ? 'info' : 'warn',
      actor_id: userId,
      actor_name: actorName,
      channel: 'web',
      summary: success
        ? `Govee integration (${entry.domain}) reloaded by ${actorName}`
        : `Govee reload failed (HTTP ${status})`,
      detail: {
        entry_id: entry.entry_id,
        domain: entry.domain,
        title: entry.title,
        ha_status: status,
        ...(haErrorMsg ? { ha_error: haErrorMsg } : {}),
      },
      status: success ? 'success' : 'error',
      duration_ms: Date.now() - t0,
    });

    res.status(success ? 200 : 502).json({ success, entry_id: entry.entry_id, domain: entry.domain, title: entry.title, data });
  } catch (err) {
    console.error('[govee-reload] Error:', err);
    await logAudit('govee-reload', {
      category: 'home',
      event_type: 'govee_reload',
      severity: 'error',
      actor_id: userId,
      actor_name: actorName,
      channel: 'web',
      summary: `Govee reload error: ${err instanceof Error ? err.message : String(err)}`,
      detail: { error: err instanceof Error ? err.message : String(err) },
      status: 'error',
      duration_ms: Date.now() - t0,
    });
    res.status(500).json({ error: 'Failed to reload Govee integration' });
  }
});

router.get('/govee/config-entries', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const creds = await resolveHACreds(req.userId);
  const HA_URL = creds?.haUrl ?? '';
  const HA_TOKEN = creds?.haToken ?? '';

  if (!HA_URL || !HA_TOKEN) {
    res.status(503).json({ error: 'Home Assistant not configured' });
    return;
  }

  try {
    const { status, data } = await callHA(HA_URL, HA_TOKEN, 'GET', '/api/config/config_entries/entry');
    if (status !== 200 || !Array.isArray(data)) {
      res.status(502).json({ error: 'Failed to fetch config entries from HA' });
      return;
    }
    const entries = data as { entry_id: string; domain: string; title: string; state: string }[];
    const goveeEntries = entries.filter(e =>
      e.domain.toLowerCase().includes('govee') ||
      (typeof e.title === 'string' && e.title.toLowerCase().includes('govee')),
    );
    res.json({ entries: goveeEntries });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get('/states', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  if (!isCacheReady()) {
    res.status(503).json({ error: 'State cache not ready yet' });
    return;
  }
  res.json(getEntityCache());
});

router.get('/govee-ids', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  res.json(getGoveeEntityIdsFromCache());
});

const HA_TOKEN_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// Exported for server/tests/ha-url-guard.test.ts (redirect + rebinding handling).
export async function callHA(
  haUrl: string,
  haToken: string,
  method: string,
  path: string,
  body?: unknown,
  opts?: {
    maxRetries?: number;
    retryOn401?: boolean;
    /**
     * Dispatcher override — ONLY for tests that need to reach a loopback
     * fixture server. Production callers must never pass this: the default
     * transport is guardedFetch, which pins every connection to vetted
     * public addresses (DNS-rebinding defense) and blocks internal IP
     * literals outright.
     */
    dispatcher?: Dispatcher;
  }
): Promise<{ status: number; data: unknown }> {
  const url = `${haUrl.replace(/\/$/, '')}${path}`;
  const MAX_RETRIES = opts?.maxRetries ?? 3;
  const retryOn401 = opts?.retryOn401 ?? true;
  let lastError: Error | null = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Funnel every HA request through the breaker. The breaker counts
      // network errors + 5xx as failure; 4xx (incl. 401) passes through
      // without tripping (those are caller problems, not connectivity).
      // When the breaker is open, CircuitOpenError is thrown immediately
      // and the retry loop short-circuits to the outer catch.
      // guardedFetch pins the connection through a DNS lookup that rejects
      // internal/metadata addresses AT CONNECT TIME, closing the DNS-rebinding
      // (validate-then-fetch TOCTOU) gap for user-configurable HA URLs.
      // Tests may inject a permissive dispatcher to reach a loopback fixture
      // server; production callers never set opts.dispatcher.
      const init = {
        method,
        headers: {
          'Authorization': `Bearer ${haToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        // Never follow redirects: a redirecting host could bounce the request
        // (and its bearer token) to an unvalidated internal destination.
        // HA's REST API does not redirect in normal operation; a 3xx is
        // surfaced to the caller as-is.
        redirect: 'manual' as const,
      };
      const res = await breakers.ha.execute(() =>
        opts?.dispatcher
          ? undiciFetch(url, { ...init, dispatcher: opts.dispatcher })
          : guardedFetch(url, init));

      const text = await res.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = text; }

      lastStatus = res.status;

      if (res.status >= 500 && attempt < MAX_RETRIES) {
        console.warn(`callHA: HA returned ${res.status} on attempt ${attempt}/${MAX_RETRIES} for ${method} ${path} — retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (retryOn401 && res.status === 401 && attempt < MAX_RETRIES) {
        console.warn(`callHA: HA returned 401 on attempt ${attempt}/${MAX_RETRIES} for ${method} ${path} — retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (retryOn401 && res.status === 401 && attempt === MAX_RETRIES) {
        console.error(`callHA: HA returned 401 after ${MAX_RETRIES} attempts for ${method} ${path} — HA token likely expired or revoked`);
        logAudit('home-assistant-proxy', {
          category: 'home', event_type: 'ha_auth_failure', severity: 'critical',
          actor_id: 'system', actor_name: 'System', channel: 'system',
          summary: `CRITICAL: Home Assistant rejected auth (401) for ${method} ${path} after ${MAX_RETRIES} retries. Token may need rotation.`,
          detail: { method, path, attempts: MAX_RETRIES },
          status: 'error',
        });
      }

      return { status: res.status, data };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof CircuitOpenError) {
        console.warn(`callHA: breaker open for HA, skipping remaining ${MAX_RETRIES - attempt} retries for ${method} ${path}`);
        throw err;
      }
      console.warn(`callHA attempt ${attempt}/${MAX_RETRIES} failed for ${method} ${path}: ${lastError.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  throw lastError!;
}

function prettifyEntityId(id: string): string {
  // Irrigation/Rain Bird zones have curated friendly names (e.g. "Entry Left
  // Strip") that match the irrigation UI — prefer them over the generic
  // entity-id prettifier ("Sprinkler 5"). Falls back below when unknown.
  const zoneLabel = getZoneFlow(id)?.label;
  if (zoneLabel) return zoneLabel;

  const raw = id.replace(/^[^.]+\./, '');
  const parts = raw.split('_');
  if (parts.length >= 3) {
    for (let len = Math.floor(parts.length / 2); len >= 1; len--) {
      const a = parts.slice(0, len).join('_');
      const b = parts.slice(len, len * 2).join('_');
      if (a === b) {
        parts.splice(0, len);
        break;
      }
    }
  }
  return parts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const JANUS_LOGO_URL = process.env.APP_LOGO_URL || '/icon.svg';
const DISPLAY_DEVICES = [
  "media_player.family_room_display",
  "media_player.kitchen_display_1",
  "media_player.gym_tv",
  "media_player.kitchen_tv",
];

router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const authUser = getAuthUser(req);
  const userId = authUser?.userId || req.userId || 'UNKNOWN';
  const actorName = authUser?.displayName || authUser?.email || 'UNKNOWN';

  try {
    const body = req.body;
    const { action, path, method = 'GET', payload } = body;

    // save-settings must work even when nothing is configured yet, so handle
    // it before credential resolution.
    if (action === 'save-settings') {
      if (userId === 'UNKNOWN') {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const haUrlInput = typeof body.ha_url === 'string' ? body.ha_url.trim().replace(/\/$/, '') : '';
      const tokenInput = typeof body.access_token === 'string' ? body.access_token.trim() : '';

      if (!haUrlInput) {
        res.status(400).json({ error: 'ha_url is required' });
        return;
      }
      // SSRF guard: the server will attach a bearer token to requests against
      // this URL, so it must be a publicly-resolving http(s) host (never
      // loopback, private, link-local, or cloud-metadata) and, when an
      // admin allowlist is configured (HA_URL / HA_ALLOWED_HOSTS), its host
      // must be on it.
      const urlCheck = await validateHaUrl(haUrlInput);
      if (!urlCheck.ok) {
        res.status(400).json({ error: urlCheck.reason });
        return;
      }

      const existing = await storage.getHomeAssistantSettings(userId);
      if (!tokenInput && !existing?.encryptedToken) {
        res.status(400).json({ error: 'access_token is required' });
        return;
      }

      const update: { userId: string; haUrl: string; encryptedToken?: string } = { userId, haUrl: haUrlInput };
      if (tokenInput) {
        update.encryptedToken = await encryptToken(tokenInput);
      }
      await storage.upsertHomeAssistantSettings(update);
      invalidateHACredsCache(userId);

      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_settings_saved', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: tokenInput
          ? `Home Assistant settings saved (URL + new token) by ${actorName}`
          : `Home Assistant URL updated by ${actorName}`,
        detail: { ha_url: haUrlInput, token_updated: Boolean(tokenInput) },
        status: 'success',
      });

      // Never echo the token (raw or encrypted) back to the client.
      res.json({ success: true, ha_url: haUrlInput, token_saved: Boolean(tokenInput) });
      return;
    }

    // get-settings: the ONLY way clients read HA settings. Scoped strictly to
    // the authenticated user's own row; encrypted_token is never included.
    // (home_assistant_settings is excluded from the generic DB proxy so other
    // users' rows — and the ciphertext — are unreachable from the client.)
    if (action === 'get-settings') {
      if (userId === 'UNKNOWN') {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const settings = await storage.getHomeAssistantSettings(userId);
      res.json({
        settings: settings
          ? {
              id: settings.id,
              ha_url: settings.haUrl,
              is_connected: settings.isConnected,
              last_connected_at: settings.lastConnectedAt,
              has_token: Boolean(settings.encryptedToken),
            }
          : null,
      });
      return;
    }

    // disconnect: clears the authenticated user's OWN stored token. Replaces
    // the old client-side generic dbUpdate (which could target arbitrary rows).
    if (action === 'disconnect') {
      if (userId === 'UNKNOWN') {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      const existing = await storage.getHomeAssistantSettings(userId);
      if (existing) {
        await storage.upsertHomeAssistantSettings({
          userId,
          haUrl: existing.haUrl,
          encryptedToken: null,
          isConnected: false,
        });
        invalidateHACredsCache(userId);
        logAudit('home-assistant-proxy', {
          category: 'home', event_type: 'ha_disconnected', severity: 'info',
          actor_id: userId, actor_name: actorName, channel: 'web',
          summary: `Home Assistant disconnected by ${actorName}`,
          detail: { ha_url: existing.haUrl },
          status: 'success',
        });
      }
      res.json({ success: true });
      return;
    }

    const creds = await resolveHACreds(userId);

    if (action === 'test-connection') {
      const suppliedUrl = typeof body.ha_url === 'string' ? body.ha_url.trim().replace(/\/$/, '') : '';
      const suppliedToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';

      let testUrl: string;
      let testToken: string;
      if (suppliedToken) {
        // Explicit token: test it against the supplied URL (or the configured
        // one). The caller already possesses this token, so no disclosure risk.
        testUrl = suppliedUrl || creds?.haUrl || '';
        testToken = suppliedToken;
      } else {
        // No explicit token: only ever test the configured URL+token pairing.
        // The stored token must NEVER be attached to a caller-supplied URL —
        // that would let any authenticated user exfiltrate it to their own host.
        if (suppliedUrl && creds && suppliedUrl !== creds.haUrl) {
          res.status(400).json({ error: 'To test a new URL, provide its access token too' });
          return;
        }
        testUrl = creds?.haUrl || '';
        testToken = creds?.haToken || '';
      }

      if (!testUrl || !testToken) {
        res.status(503).json({ unavailable: true, reason: 'not_configured', message: 'ha_not_configured' });
        return;
      }
      // SSRF guard: the target must pass the same allowlist + resolved-IP
      // validation as save-settings before the server sends any request
      // (carrying a bearer token) to it.
      const urlCheck = await validateHaUrl(testUrl);
      if (!urlCheck.ok) {
        res.status(400).json({ error: urlCheck.reason });
        return;
      }
      const { status } = await callHA(testUrl, testToken, 'GET', '/api/');
      const connected = status === 200;
      if (connected && userId && userId !== 'UNKNOWN') {
        const existing = await storage.getHomeAssistantSettings(userId);
        if (existing) {
          await storage.upsertHomeAssistantSettings({
            userId,
            isConnected: true,
            lastConnectedAt: new Date(),
          });
        }
      }
      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_test_connection', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: connected ? 'Home Assistant connection test succeeded' : `Home Assistant connection test failed (HTTP ${status})`,
        detail: { status, connected }, status: connected ? 'success' : 'error',
      });
      // Never relay the upstream response body — only whether it connected.
      res.json({ connected });
      return;
    }

    if (!creds) {
      res.status(503).json({ unavailable: true, reason: 'not_configured', message: 'ha_not_configured' });
      return;
    }
    const HA_URL = creds.haUrl;
    const HA_TOKEN = creds.haToken;

    if (action === 'proxy' && path) {
      // The path is appended to the HA base URL verbatim — require a plain
      // absolute path so it cannot rewrite the authority (e.g. "@evil.com").
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
        res.status(400).json({ error: 'path must be an absolute URL path' });
        return;
      }
      const t0 = Date.now();
      const { status, data } = await callHA(HA_URL, HA_TOKEN, method, path, payload);

      if (status >= 400 && path.startsWith('/api/calendars/')) {
        console.warn(`Calendar endpoint returned ${status} — returning empty array`);
        logAudit('home-assistant-proxy', {
          category: 'home', event_type: 'ha_proxy_error', severity: 'warn',
          actor_id: userId, actor_name: actorName, channel: 'web',
          summary: `Home Assistant calendar proxy ${method} ${path} returned HTTP ${status} (suppressed)`,
          detail: { method, path, status, suppressed: true },
          status: 'error',
          duration_ms: Date.now() - t0,
        });
        res.json([]);
        return;
      }

      if (status >= 400) {
        const payloadBytes = payload ? JSON.stringify(payload).length : 0;
        const responseBytes = JSON.stringify(data).length;
        const errorDetail = typeof data === 'object' && data !== null
          ? ((data as Record<string, unknown>).message || (data as Record<string, unknown>).error || undefined)
          : undefined;
        logAudit('home-assistant-proxy', {
          category: 'home', event_type: 'ha_proxy_error', severity: 'warn',
          actor_id: userId, actor_name: actorName, channel: 'web',
          summary: `Home Assistant proxy ${method} ${path} returned HTTP ${status}`,
          detail: {
            method, path, status,
            request_bytes: payloadBytes || undefined,
            response_bytes: responseBytes,
            ...(errorDetail ? { error: errorDetail } : {}),
          },
          status: 'error',
          duration_ms: Date.now() - t0,
        });
      } else if (method !== 'GET') {
        const responseBytes = JSON.stringify(data).length;
        const payloadBytes = payload ? JSON.stringify(payload).length : 0;
        logAudit('home-assistant-proxy', {
          category: 'home', event_type: 'ha_proxy_request', severity: 'info',
          actor_id: userId, actor_name: actorName, channel: 'web',
          summary: `HA proxy ${method} ${path}`,
          detail: { method, path, status, request_bytes: payloadBytes || undefined, response_bytes: responseBytes },
          status: 'success',
          duration_ms: Date.now() - t0,
        });
      }

      res.status(status).json(data);
      return;
    }

    if (action === 'get-states') {
      const { status, data } = await callHA(HA_URL, HA_TOKEN, 'GET', '/api/states');
      const entityIds: string[] | undefined = body.entity_ids;
      if (entityIds && Array.isArray(entityIds) && entityIds.length > 0 && Array.isArray(data)) {
        const idSet = new Set(entityIds);
        const filtered = (data as any[]).filter((s: { entity_id: string }) => idSet.has(s.entity_id));
        res.status(status).json(filtered);
        return;
      }
      res.status(status).json(data);
      return;
    }

    if (action === 'get-state') {
      const { entity_id } = body;
      if (!entity_id) { res.status(400).json({ error: 'entity_id required' }); return; }
      const { status, data } = await callHA(HA_URL, HA_TOKEN, 'GET', `/api/states/${entity_id}`);
      res.status(status).json(data);
      return;
    }

    if (action === 'get-domain') {
      const { domain } = body;
      if (!domain) { res.status(400).json({ error: 'domain required' }); return; }
      const { status: domainStatus, data: allStates } = await callHA(HA_URL, HA_TOKEN, 'GET', '/api/states');
      const statesArray = Array.isArray(allStates) ? allStates : [];
      const states = statesArray.filter((s: any) => s.entity_id?.startsWith(`${domain}.`));
      res.status(domainStatus < 400 ? 200 : domainStatus).json(states);
      return;
    }

    if (action === 'call-service') {
      const { domain: svcDomain, service, service_data } = body;
      if (!svcDomain || !service) { res.status(400).json({ error: 'domain and service required' }); return; }
      const t0 = Date.now();
      const entityId = service_data?.entity_id;
      const svcPath = `/api/services/${svcDomain}/${service}`;
      const svcPayload = service_data || {};

      let callResult: { status: number; data: unknown };
      // The process-global HA WebSocket is connected with the ENV credentials.
      // Only use it when this request's resolved credentials ARE the env ones —
      // a user with their own saved settings must have every action (including
      // climate) go to THEIR instance via REST, never the env instance.
      if (svcDomain === 'climate' && creds.source === 'env') {
        try {
          const wsResult = await callHAService(svcDomain, service, svcPayload);
          console.log(
            `[HA climate] WebSocket call succeeded for entity_id=${entityId ?? 'unknown'} service=${service}`
          );
          callResult = { status: 200, data: wsResult ?? [] };
        } catch (wsErr: unknown) {
          const wsErrMsg = wsErr instanceof Error ? wsErr.message : String(wsErr);
          console.warn(
            `[HA climate] WebSocket call failed for entity_id=${entityId ?? 'unknown'} service=${service} error=${wsErrMsg} — falling back to REST`
          );
          try {
            const restResult = await callHA(HA_URL, HA_TOKEN, 'POST', svcPath, svcPayload, { maxRetries: 1, retryOn401: false });
            if (restResult.status >= 400) {
              console.error(
                `[HA climate] REST fallback returned ${restResult.status} for entity_id=${entityId ?? 'unknown'} service=${service} (WS error: ${wsErrMsg})`
              );
              callResult = { status: 500, data: { error: `Climate control failed — WS: ${wsErrMsg}, REST: HTTP ${restResult.status}` } };
            } else {
              callResult = restResult;
            }
          } catch (restErr: unknown) {
            const restErrMsg = restErr instanceof Error ? restErr.message : String(restErr);
            console.error(
              `[HA climate] REST fallback also threw for entity_id=${entityId ?? 'unknown'} service=${service} ws_error=${wsErrMsg} rest_error=${restErrMsg}`
            );
            callResult = { status: 500, data: { error: `Climate control failed — WS: ${wsErrMsg}, REST: ${restErrMsg}` } };
          }
        }
      } else {
        callResult = await callHA(HA_URL, HA_TOKEN, 'POST', svcPath, svcPayload);
      }

      const { status, data } = callResult;
      const ids: string[] = entityId ? (Array.isArray(entityId) ? entityId : [entityId]) : [];
      const count = ids.length;

      const verbMap: Record<string, string> = {
        turn_on: svcDomain === 'scene' ? 'Activated scene' : 'Turned on',
        turn_off: 'Turned off',
        toggle: 'Toggled',
        set_temperature: service_data?.temperature != null ? `Set temperature to ${service_data.temperature}°F` : 'Set temperature',
        set_hvac_mode: service_data?.hvac_mode ? `Set mode to ${service_data.hvac_mode}` : 'Set HVAC mode',
        volume_set: service_data?.volume_level != null ? `Set volume to ${Math.round(service_data.volume_level * 100)}%` : 'Set volume',
        select_source: service_data?.source ? `Selected source ${service_data.source} on` : 'Selected source on',
        activate: 'Activated scene',
      };
      const verb = verbMap[service] || service.replace(/_/g, ' ');

      let summary: string;
      if (count === 0) {
        summary = `${verb} (${svcDomain})`;
      } else if (count === 1) {
        summary = `${verb} ${prettifyEntityId(ids[0])}`;
      } else if (count <= 2) {
        summary = `${verb} ${ids.map(prettifyEntityId).join(' & ')}`;
      } else {
        summary = `${verb} ${ids.slice(0, 2).map(prettifyEntityId).join(', ')} +${count - 2} more`;
      }

      const extras: string[] = [];
      if (service_data?.brightness != null && !verbMap[service]?.includes('brightness'))
        extras.push(`brightness ${Math.round((service_data.brightness / 255) * 100)}%`);
      if (extras.length) summary += ` (${extras.join(', ')})`;

      if (status >= 400 && svcDomain === 'climate') {
        const responseBody = typeof data === 'object' ? JSON.stringify(data) : String(data ?? '');
        console.error(
          `[HA climate] call-service failed: entity_id=${entityId ?? 'unknown'} service=${service} status=${status} body=${responseBody}`
        );
      }

      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_call_service', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web', summary,
        detail: { domain: svcDomain, service, entity_id: entityId, service_data, status },
        duration_ms: Date.now() - t0,
        status: status < 400 ? 'success' : 'error',
      });

      res.status(status).json(data);
      return;
    }

    if (action === 'get-climate-debug') {
      const t0 = Date.now();
      const { status, data: allStates } = await callHA(HA_URL, HA_TOKEN, 'GET', '/api/states');
      const statesArray = Array.isArray(allStates) ? allStates : [];
      const climateEntities = statesArray.filter((s: any) => s.entity_id?.startsWith('climate.'));
      const poolSpaFilter = /pool|spa/i;

      const debug = climateEntities.map((e: any) => ({
        entity_id: e.entity_id,
        friendly_name: e.attributes?.friendly_name || e.entity_id,
        state: e.state,
        hvac_modes: e.attributes?.hvac_modes || [],
        current_temperature: e.attributes?.current_temperature ?? null,
        target_temperature: e.attributes?.temperature ?? null,
        hvac_action: e.attributes?.hvac_action ?? null,
        is_pool_spa: poolSpaFilter.test(e.entity_id),
        category: poolSpaFilter.test(e.entity_id) ? 'pool_spa' : 'hvac',
      }));

      const hvacCount = debug.filter((d: any) => d.category === 'hvac').length;
      const poolSpaCount = debug.filter((d: any) => d.category === 'pool_spa').length;

      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_climate_debug', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: `Climate debug: ${climateEntities.length} entities (${hvacCount} HVAC, ${poolSpaCount} pool/spa)`,
        duration_ms: Date.now() - t0,
        status: status < 400 ? 'success' : 'error',
      });

      res.json({
        total_climate_entities: climateEntities.length,
        hvac_count: hvacCount,
        pool_spa_count: poolSpaCount,
        total_ha_entities: statesArray.length,
        timestamp: new Date().toISOString(),
        entities: debug,
      });
      return;
    }

    if (action === 'get-history') {
      const { entity_id, hours = 24 } = body;
      const end = new Date().toISOString();
      const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      let histPath = `/api/history/period/${start}?end_time=${encodeURIComponent(end)}&minimal_response`;
      if (entity_id) histPath += `&filter_entity_id=${entity_id}`;
      const t0 = Date.now();
      const { status, data } = await callHA(HA_URL, HA_TOKEN, 'GET', histPath);
      const entityLabel = entity_id ? prettifyEntityId(entity_id) : 'all entities';
      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_get_history', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: `Retrieved ${hours}h history for ${entityLabel}`,
        detail: { entity_id: entity_id || undefined, hours },
        status: status < 400 ? 'success' : 'error',
        duration_ms: Date.now() - t0,
      });
      res.status(status).json(data);
      return;
    }

    if (action === 'get-logbook') {
      const { hours = 24, entity_id } = body;
      const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      let logPath = `/api/logbook/${start}`;
      if (entity_id) logPath += `?entity=${entity_id}`;
      const t0 = Date.now();
      const { status, data } = await callHA(HA_URL, HA_TOKEN, 'GET', logPath);
      const entityLabel = entity_id ? prettifyEntityId(entity_id) : 'all entities';
      const entryCount = Array.isArray(data) ? data.length : 0;
      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_get_logbook', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: `Retrieved ${entryCount} logbook entries (${hours}h) for ${entityLabel}`,
        detail: { entity_id: entity_id || undefined, hours, entry_count: entryCount },
        status: status < 400 ? 'success' : 'error',
        duration_ms: Date.now() - t0,
      });
      res.status(status).json(data);
      return;
    }

    if (action === 'get-services') {
      const t0 = Date.now();
      const { status, data } = await callHA(HA_URL, HA_TOKEN, 'GET', '/api/services');
      const domainCount = Array.isArray(data) ? data.length : 0;
      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_get_services', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: `Fetched HA service list (${domainCount} domain${domainCount !== 1 ? 's' : ''})`,
        detail: { domain_count: domainCount },
        status: status < 400 ? 'success' : 'error',
        duration_ms: Date.now() - t0,
      });
      res.status(status).json(data);
      return;
    }

    if (action === 'get-config') {
      const t0 = Date.now();
      const { status, data } = await callHA(HA_URL, HA_TOKEN, 'GET', '/api/config');
      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'ha_get_config', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: 'Fetched Home Assistant configuration',
        detail: {},
        status: status < 400 ? 'success' : 'error',
        duration_ms: Date.now() - t0,
      });
      res.status(status).json(data);
      return;
    }

    if (action === 'broadcast-all') {
      const speakers = [
        "media_player.bathroom_speaker", "media_player.emme_s_room_speaker",
        "media_player.family_room_display", "media_player.glam_room_speaker",
        "media_player.gym_speaker", "media_player.isla_s_room_speaker",
        "media_player.kitchen_display_1", "media_player.lanas_closet_speaker",
        "media_player.main_rack_speaker", "media_player.master_bedroom_speaker",
        "media_player.playroom_speaker", "media_player.theater_reciever",
        "media_player.tonys_office_speaker",
        "media_player.gym_tv", "media_player.kitchen_tv"
      ];
      const tvs = ["media_player.gym_tv", "media_player.kitchen_tv"];

      const requestedVolumeAll = Number.isFinite(body.volume) ? (body.volume as number) : 0.75;
      const volumeLevelAll = Math.min(1, Math.max(0, requestedVolumeAll));

      await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/turn_on', { entity_id: speakers });
      await new Promise(r => setTimeout(r, 3000));

      await Promise.all([
        callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/volume_set', {
          entity_id: speakers, volume_level: volumeLevelAll,
        }),
        callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/play_media', {
          entity_id: DISPLAY_DEVICES,
          media_content_id: JANUS_LOGO_URL,
          media_content_type: 'image/png',
        }),
      ]);
      await new Promise(r => setTimeout(r, 1500));

      const t0 = Date.now();
      await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/tts/speak', {
        entity_id: 'tts.elevenlabs_text_to_speech',
        media_player_entity_id: speakers,
        message: body.message,
        options: { voice: 'iLVmqjzCGGvqtMCk6vVQ' },
      });

      setTimeout(async () => {
        try {
          await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/turn_off', { entity_id: tvs });
        } catch {}
      }, 60_000);

      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'broadcast_all', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: `Broadcast to ${speakers.length} devices (vol ${Math.round(volumeLevelAll * 100)}%)`,
        detail: { message: body.message?.slice(0, 100), volume: volumeLevelAll },
        duration_ms: Date.now() - t0,
        status: 'success',
      });

      res.json({ success: true, devices: speakers.length });
      return;
    }

    if (action === 'broadcast-girls') {
      const speakers = [
        "media_player.emme_s_room_speaker",
        "media_player.isla_s_room_speaker",
        "media_player.lanas_closet_speaker",
      ];

      const requestedVolumeGirls = Number.isFinite(body.volume) ? (body.volume as number) : 0.9;
      const volumeLevelGirls = Math.min(1, Math.max(0, requestedVolumeGirls));

      await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/turn_on', { entity_id: speakers });
      await new Promise(r => setTimeout(r, 3000));

      await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/volume_set', {
        entity_id: speakers, volume_level: volumeLevelGirls,
      });
      await new Promise(r => setTimeout(r, 1500));

      const t0 = Date.now();
      await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/tts/speak', {
        entity_id: 'tts.elevenlabs_text_to_speech',
        media_player_entity_id: speakers,
        message: body.message,
        options: { voice: 'iLVmqjzCGGvqtMCk6vVQ' },
      });

      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'broadcast_girls', severity: 'info',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: `Broadcast to girls' rooms (${speakers.length} speakers)`,
        detail: { message: body.message?.slice(0, 100) },
        duration_ms: Date.now() - t0,
        status: 'success',
      });

      res.json({ success: true, devices: speakers.length });
      return;
    }

    if (action === 'broadcast-google-home') {
      const speakers = [
        "media_player.bathroom_speaker", "media_player.emme_s_room_speaker",
        "media_player.family_room_display", "media_player.glam_room_speaker",
        "media_player.gym_speaker", "media_player.isla_s_room_speaker",
        "media_player.kitchen_display_1", "media_player.lanas_closet_speaker",
        "media_player.main_rack_speaker", "media_player.master_bedroom_speaker",
        "media_player.playroom_speaker", "media_player.tonys_office_speaker",
      ];
      const displayDevices = [
        "media_player.family_room_display",
        "media_player.kitchen_display_1",
      ];

      const requestedVolumeGH = Number.isFinite(body.volume) ? (body.volume as number) : 0.75;
      const volumeLevelGH = Math.min(1, Math.max(0, requestedVolumeGH));

      await callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/turn_on', { entity_id: speakers });
      await new Promise(r => setTimeout(r, 3000));

      await Promise.all([
        callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/volume_set', {
          entity_id: speakers, volume_level: volumeLevelGH,
        }),
        callHA(HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/play_media', {
          entity_id: displayDevices,
          media_content_id: JANUS_LOGO_URL,
          media_content_type: 'image/png',
        }),
      ]);
      await new Promise(r => setTimeout(r, 1500));

      const t0 = Date.now();
      const messageText = typeof body.message === 'string' ? body.message : '';
      let ttsOk = true;
      let ttsError: string | null = null;
      let whatsappFallback = false;
      let whatsappAlert = false;

      // Use direct ElevenLabs → storage-compat → play_media approach (same as school
      // morning broadcast).  This bypasses HA's tts/speak, which silently returns 200
      // even when Cast drops the audio.  The timestamped filename means no query string
      // after .mp3, which fixes Cast's content-type sniffing.  announce:true + metadata
      // is the standard fix for the "chirps then drops audio" Google Cast bug.
      const audioUrl = await generateAndUploadTTS(messageText, 'google-home-broadcast');

      if (audioUrl) {
        const speakerErrors: string[] = [];
        for (const speaker of speakers) {
          const { status: playStatus } = await callHA(
            HA_URL, HA_TOKEN, 'POST', '/api/services/media_player/play_media',
            {
              entity_id: speaker,
              media_content_id: audioUrl,
              media_content_type: 'audio/mpeg',
              announce: true,
              extra: {
                metadata: { metadataType: 3, title: 'Home Announcement', artist: 'Janus' },
              },
            },
          );
          if (playStatus >= 400) {
            speakerErrors.push(`${speaker}: HTTP ${playStatus}`);
            console.warn(`[home-assistant-proxy] play_media failed on ${speaker}: HTTP ${playStatus}`);
          } else {
            console.log(`[home-assistant-proxy] ✓ play_media accepted on ${speaker}`);
          }
          await new Promise(r => setTimeout(r, 400));
        }
        if (speakerErrors.length > 0) {
          ttsOk = false;
          ttsError = `play_media failed on ${speakerErrors.length} speaker(s): ${speakerErrors.join('; ')}`;
        }
      } else {
        ttsOk = false;
        ttsError = 'ElevenLabs TTS or storage upload failed';
      }

      if (!ttsOk) {
        try {
          const fallbackPhone = await getBroadcastFallbackPhone();
          whatsappFallback = await sendWhatsAppTo(fallbackPhone, `📢 Home broadcast: ${messageText}`);
          if (whatsappFallback) {
            console.log('[home-assistant-proxy] WhatsApp fallback sent for broadcast-google-home');
          } else {
            console.warn('[home-assistant-proxy] WhatsApp fallback failed for broadcast-google-home');
          }
        } catch (e) {
          console.error('[home-assistant-proxy] WhatsApp fallback error:', e);
        }
        try {
          const alertPhone = await getAlertPhoneNumber();
          const fallbackNote = whatsappFallback
            ? ' WhatsApp fallback sent to family.'
            : ' WhatsApp fallback failed.';
          whatsappAlert = await sendWhatsAppTo(
            alertPhone,
            `⚠️ All Google Home broadcast failed: ${ttsError ?? 'unknown TTS error'}.${fallbackNote}`,
          );
        } catch (e) {
          console.error('[home-assistant-proxy] WhatsApp alert error:', e);
        }
      }

      logAudit('home-assistant-proxy', {
        category: 'home', event_type: 'broadcast_google_home', severity: ttsOk ? 'info' : 'warn',
        actor_id: userId, actor_name: actorName, channel: 'web',
        summary: ttsOk
          ? `Broadcast to ${speakers.length} Google Home devices (vol ${Math.round(volumeLevelGH * 100)}%)`
          : `Broadcast to ${speakers.length} Google Home devices FAILED (vol ${Math.round(volumeLevelGH * 100)}%)`,
        detail: {
          message: messageText.slice(0, 100),
          volume: volumeLevelGH,
          ttsError,
          whatsappFallback,
          whatsappAlert,
        },
        duration_ms: Date.now() - t0,
        status: ttsOk ? 'success' : 'error',
      });

      res.json({
        success: ttsOk,
        devices: speakers.length,
        ttsError,
        whatsappFallback,
        whatsappAlert,
      });

      // Fire-and-forget Cast state verification ~3.5s after play_media.  Done
      // AFTER the response so the user-facing broadcast stays snappy, but still
      // gives the same audit visibility as the school-morning broadcast: catches
      // the silent-drop pattern where Cast accepts play_media → 200 → chirp →
      // drops audio.  Only run when we actually used the direct play_media path.
      if (ttsOk && audioUrl) {
        setTimeout(async () => {
          const tVerify = Date.now();
          const verifications: Record<string, { verified: boolean; state: string | null; contentId: string | null; urlMatch: boolean | null }> = {};
          let verifiedCount = 0;
          for (const speaker of speakers) {
            const v = await verifyPlaybackState(HA_URL, HA_TOKEN, speaker, audioUrl, true);
            verifications[speaker] = v;
            if (v.verified) {
              verifiedCount++;
              console.log(`[home-assistant-proxy] ✓ Cast state verified: ${speaker} loaded correct content (announce-mode, state=${v.state})`);
            } else {
              console.warn(
                `[home-assistant-proxy] ⚠ Cast state check: ${speaker} state=${v.state ?? 'null'} urlMatch=${v.urlMatch} (announce-mode: urlMatch must be true and state must not be unavailable)`,
              );
            }
          }
          const allVerified = verifiedCount === speakers.length;

          // Silent-drop heuristic: only meaningful when every speaker looked good
          // on the first poll (urlMatch=true). Re-poll at ~8s; if they ALL still
          // sit at 'idle' the audio may have been silently dropped. Purely
          // observational — never changes the broadcast success/failure status.
          let silentDropRisk = false;
          if (allVerified) {
            const { silentDropRisk: risk } = await detectSilentDropRisk(
              HA_URL,
              HA_TOKEN,
              speakers,
              audioUrl,
              3_500,
            );
            silentDropRisk = risk;
            if (risk) {
              console.warn(
                `[home-assistant-proxy] ⚠ silent_drop_risk: all speakers urlMatch=true but still idle at ~8s — audio may have been silently dropped (no failure alert raised)`,
              );
            }
          }

          logAudit('home-assistant-proxy', {
            category: 'home',
            event_type: 'broadcast_cast_verification',
            severity: allVerified && !silentDropRisk ? 'info' : 'warn',
            actor_id: userId,
            actor_name: actorName,
            channel: 'web',
            summary: silentDropRisk
              ? `Cast state verified ${verifiedCount}/${speakers.length} Google Home speakers (silent-drop risk: still idle at 8s)`
              : `Cast state verified ${verifiedCount}/${speakers.length} Google Home speakers`,
            detail: {
              broadcast: 'all-google-home',
              expectedUrl: audioUrl,
              verifiedCount,
              totalSpeakers: speakers.length,
              verifications,
              silent_drop_risk: silentDropRisk,
            },
            duration_ms: Date.now() - tVerify,
            status: allVerified ? 'success' : 'warning',
          });
        }, 3_500).unref?.();
      }
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('Home Assistant proxy error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

export default router;
