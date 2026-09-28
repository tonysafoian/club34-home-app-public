/**
 * Opt-in Sentry wiring.
 *
 * Activation requires BOTH:
 *   1. `@sentry/node` installed (`npm install @sentry/node`)
 *   2. `SENTRY_DSN` env var set in Replit Secrets
 *
 * If either is missing this module silently no-ops, so the server keeps
 * running unchanged. We use a dynamic `import()` so the codebase does not
 * take a hard dependency on `@sentry/node` (the package is intentionally
 * NOT in package.json yet — install it when you're ready to flip Sentry
 * on in prod).
 *
 * Once both prereqs are met:
 *   - initSentry() captures unhandled errors via captureException()
 *   - The Express error handler in server/index.ts forwards err to
 *     captureException() before responding.
 */

type SentryLike = {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown) => void;
  setUser: (user: { id?: string; email?: string } | null) => void;
};

let sentry: SentryLike | null = null;
let initPromise: Promise<void> | null = null;

export function initSentry(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) {
      console.log('[sentry] SENTRY_DSN not set — error reporting disabled');
      return;
    }
    try {
      // dynamic import keeps the dep optional
      const mod = (await import('@sentry/node' as string)) as unknown as SentryLike;
      mod.init({
        dsn,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
        release: process.env.SENTRY_RELEASE,
      });
      sentry = mod;
      console.log('[sentry] initialized');
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(String(e?.message))) {
        console.log('[sentry] SENTRY_DSN is set but @sentry/node is not installed — run `npm install @sentry/node` to enable');
      } else {
        console.error('[sentry] init failed:', e?.message ?? err);
      }
    }
  })();
  return initPromise;
}

export function captureException(err: unknown): void {
  if (sentry) {
    try {
      sentry.captureException(err);
    } catch {
      // never let telemetry crash the request
    }
  }
}

export function isSentryActive(): boolean {
  return sentry !== null;
}
