const MAX_REPORTS_PER_MINUTE = 5;
const WINDOW_MS = 60_000;

let reportTimestamps: number[] = [];
let initialized = false;

interface ErrorReport {
  message: string;
  stack?: string;
  componentStack?: string;
  url: string;
  userAgent: string;
  timestamp: string;
  source?: string;
}

function isRateLimited(): boolean {
  const now = Date.now();
  reportTimestamps = reportTimestamps.filter(t => now - t < WINDOW_MS);
  if (reportTimestamps.length >= MAX_REPORTS_PER_MINUTE) return true;
  reportTimestamps.push(now);
  return false;
}

function sendReport(report: ErrorReport): void {
  if (isRateLimited()) return;

  try {
    const body = JSON.stringify(report);

    const sent = navigator.sendBeacon
      ? navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }))
      : false;

    if (!sent) {
      fetch('/api/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // Best-effort telemetry; never let error reporting throw.
  }
}

export function reportError(
  error: Error,
  componentStack?: string,
  source = 'error-boundary',
): void {
  sendReport({
    message: error.message || String(error),
    stack: error.stack?.slice(0, 2000),
    componentStack: componentStack?.slice(0, 2000),
    url: window.location.href,
    userAgent: navigator.userAgent,
    timestamp: new Date().toISOString(),
    source,
  });
}

// Recovery is throttled with a persistent, time-windowed budget rather than a
// one-shot flag. The budget MUST survive reloads (it lives in localStorage,
// which hardReload's cache/SW cleanup does not touch) — otherwise a genuinely
// broken deploy would recover -> reload -> recover -> reload forever.
//
// After a successful boot (see clearRecoveryBudget called from main.tsx), the
// budget is wiped so a device that self-healed from a stale build gets a fresh
// budget for any future deploy, rather than staying stuck at the limit.
const CHUNK_RECOVER_KEY = 'chunk-recover-attempts';
const RECOVER_WINDOW_MS = 60_000;
const MAX_RECOVER_ATTEMPTS = 3;

/**
 * True when the browser reports it has no network connectivity. Used to tell
 * an "offline" navigation failure apart from a genuine post-deploy chunk
 * mismatch: both surface as "Failed to fetch dynamically imported module", but
 * the remedies are opposite — a deploy error wants a cache-wiping hardReload,
 * while an offline device must NOT wipe its caches (that would leave it with
 * nothing to load) and should simply wait for connectivity to return.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    // Dynamic import failed to fetch — wording differs across engines.
    msg.includes('Failed to fetch dynamically imported module') || // Chromium
    msg.includes('Importing a module script failed') ||            // WebKit / iOS
    msg.includes('error loading dynamically imported module') ||   // Firefox
    msg.includes('ChunkLoadError') ||
    msg.includes('Loading chunk') ||
    // A stale index.html was served in place of a missing hashed chunk (the SPA
    // fallback returns text/html, which the browser refuses to execute as a
    // module). This is the dominant post-deploy symptom on iOS PWAs.
    msg.includes('is not a valid JavaScript MIME type') ||         // WebKit
    msg.includes('Failed to load module script') ||                // Chromium
    msg.includes('Expected a JavaScript module script') ||         // Chromium
    (error instanceof TypeError && msg.includes('Failed to fetch') && msg.includes('/assets/'))
  );
}

async function clearServiceWorkerAndCaches(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Best-effort SW/cache cleanup — reload regardless.
  }
}

/**
 * Unregister the service worker, drop all caches, then reload. This is the only
 * reliable way to escape a stale precache after a deploy: a plain
 * window.location.reload() can be satisfied by the still-controlling service
 * worker from its (now outdated) precache, re-serving the dead chunk and
 * leaving the user stuck on the "Couldn't load this page" fallback.
 */
export async function hardReload(): Promise<void> {
  await clearServiceWorkerAndCaches();
  window.location.reload();
}

/**
 * Wipe the chunk-recovery budget after a confirmed successful boot.
 * Call this a few seconds after the app renders cleanly so a device that
 * self-healed from a stale build gets a fresh budget for the next deploy
 * instead of being permanently stuck at the attempt ceiling.
 */
export function clearRecoveryBudget(): void {
  try {
    localStorage.removeItem(CHUNK_RECOVER_KEY);
  } catch {
    // localStorage not available — no-op.
  }
}

function readRecoverAttempts(): number[] {
  try {
    const raw = localStorage.getItem(CHUNK_RECOVER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'number') : [];
  } catch {
    return [];
  }
}

export function attemptChunkRecovery(): boolean {
  // Never "recover" while offline. A failed dynamic import on an offline device
  // looks identical to a post-deploy chunk error, but hardReload here would
  // unregister the service worker and delete every cache — leaving the user
  // with a blank page and no way back until they're online again. Bail out and
  // let the UI surface a friendly offline message instead.
  if (isOffline()) return false;

  const now = Date.now();
  const recent = readRecoverAttempts().filter((t) => now - t < RECOVER_WINDOW_MS);

  // Already recovered too many times in the window: stop reloading and let the
  // ErrorBoundary fallback / manual Hard reload take over, so a genuinely broken
  // deploy can't trap the user in an endless reload loop.
  if (recent.length >= MAX_RECOVER_ATTEMPTS) {
    return false;
  }

  recent.push(now);
  try {
    localStorage.setItem(CHUNK_RECOVER_KEY, JSON.stringify(recent));
  } catch {
    // If we can't persist the budget we'd risk a loop; bail out of auto-recovery.
    return false;
  }

  // Clear the service worker and caches before reloading so the fresh build is
  // fetched from the network instead of being served from the stale precache.
  void hardReload();
  return true;
}

/**
 * Detect the "rendered but unstyled" failure mode: the built CSS <link> is
 * present in the document but failed to load. This typically happens when a
 * stale service-worker navigation cache serves an old index.html that
 * references a CSS hash no longer present on the CDN (the JS may still render
 * from cache, leaving the page unstyled). A failed same-origin stylesheet has
 * link.sheet === null.
 *
 * When detected, trigger the same throttled hardReload used for JS chunk
 * failures so the device drops its stale precache and re-fetches the current
 * build. The shared throttle (see attemptChunkRecovery) prevents reload loops
 * if the CSS is genuinely missing.
 *
 * No-op in dev (Vite injects styles via <style> tags, not /assets/*.css links)
 * and whenever at least one app stylesheet loaded successfully.
 */
export function recoverIfStylesheetsFailed(): void {
  try {
    const links = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
    ).filter((l) => {
      try {
        const { pathname } = new URL(l.href);
        return pathname.includes('/assets/') && pathname.endsWith('.css');
      } catch {
        return false;
      }
    });

    if (links.length === 0) return;

    const anyLoaded = links.some((l) => {
      try {
        return !!l.sheet && l.sheet.cssRules.length > 0;
      } catch {
        // Cross-origin sheet present and parsed, just not introspectable.
        return true;
      }
    });

    if (!anyLoaded) {
      attemptChunkRecovery();
    }
  } catch {
    // Detection must never break startup.
  }
}

export function initGlobalErrorListeners(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener('error', (event: ErrorEvent) => {
    if (isChunkLoadError(event.error ?? event.message)) {
      if (attemptChunkRecovery()) return;
    }

    sendReport({
      message: event.message || 'Unknown error',
      stack: event.error?.stack?.slice(0, 2000),
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
      source: 'window.onerror',
    });
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    const reason = event.reason;

    if (isChunkLoadError(reason)) {
      if (attemptChunkRecovery()) return;
    }

    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled promise rejection';
    const stack = reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined;

    sendReport({
      message,
      stack,
      url: window.location.href,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString(),
      source: 'unhandledrejection',
    });
  });
}
