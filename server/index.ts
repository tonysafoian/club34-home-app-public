// Default to Pacific Time if TZ unset. The household automations run on local time
// (cron windows, calendar events, morning briefings, etc.).
// Opt-out by setting TZ in your environment (e.g. TZ=America/New_York).
process.env.TZ = process.env.TZ || "America/Los_Angeles";

import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { computerTokenMiddleware, logComputerTokenStartup } from "./lib/computerToken.js";
import { correlationMiddleware } from "./lib/correlation";
import { createServer } from "http";
import { execFile } from "child_process";
import { registerRoutes } from "./routes";
import { setupVite } from "./vite";
import { seedDatabase } from "./seed";
import { startScheduledTasks } from "./scheduledTasks";
import { initCronJobs } from "./routes/cron";
import { setupSocketIO, emitToAll } from "./socket";
import { startHAWebSocket } from "./lib/haWebSocket";
import { runStartupCatchup } from "./routes/verkada";
import { logAudit } from "./lib/auditLog";
import { storage } from "./storage";
import { initSentry, captureException as sentryCapture } from "./lib/sentry.js";
import pg from "pg";

// Fire-and-forget Sentry init. No-op unless SENTRY_DSN is set AND
// @sentry/node is installed (see server/lib/sentry.ts). Runs in
// parallel with the rest of startup so it never blocks boot.
void initSentry();

// NOTE (2026-05-17): syncAuditLogsFromProd() and checkAuditLogSource() used
// Primary PostgreSQL database (`DATABASE_URL`) is the source of truth for audit logs.

async function checkAuditLogSource(): Promise<void> {
  try {
    const result = await storage.querySystemAuditLogs({ limit: 1, offset: 0 });
    console.log(`[startup] Audit log effective read source: LOCAL DB — ${result.count} rows`);
  } catch (e: any) {
    console.error('[startup] Audit log source check failed:', e.message);
  }
}

const app = express();
// trust proxy: true — required so req.ip resolves to the real client address behind reverse proxies.
app.set("trust proxy", true);

const appDomain = process.env.APP_DOMAIN || "example.com";

const ALLOWED_ORIGINS = [
  `https://${appDomain}`,
  `https://www.${appDomain}`,
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:3000",
];

if (process.env.ADDITIONAL_ALLOWED_ORIGINS) {
  for (const d of process.env.ADDITIONAL_ALLOWED_ORIGINS.split(',')) {
    const trimmed = d.trim();
    if (trimmed) {
      ALLOWED_ORIGINS.push(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    }
  }
}

// Correlation IDs end-to-end. Generates / reads X-Correlation-Id and
// runs the rest of the request inside an AsyncLocalStorage context so
// downstream helpers (audit log, failed-jobs, chat logs) can stamp the
// id without prop-drilling. Must run before route handlers so they
// inherit the context.
app.use(correlationMiddleware);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Allow Home Assistant ingress, supervisor, dev mode, and private LAN origins
    if (
      process.env.SUPERVISOR_TOKEN ||
      process.env.HASSIO_TOKEN ||
      process.env.NODE_ENV !== "production" ||
      /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|.*\.local)(:\d+)?$/.test(origin)
    ) {
      return callback(null, true);
    }
    callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-correlation-id", "x-client-info", "apikey"],
  // Surface X-Correlation-Id in the response so browser fetch() / fetch
  // wrappers in src/ can read it for debugging.
  exposedHeaders: ["X-Correlation-Id"],
}));

app.use(express.json({
  limit: '10mb',
  verify: (req: any, _res, buf) => {
    if (
      req.url?.includes('/api/verkada/poi-webhook') ||
      req.url?.includes('/api/deploy/webhook')
    ) {
      req.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Computer Agent token middleware — must run BEFORE any auth guard so
// the token path can short-circuit normal cookie/JWT auth checks.
// See server/lib/computerToken.ts for full details.
app.use(computerTokenMiddleware);
logComputerTokenStartup();

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse).substring(0, 80)}`;
      }
      console.log(logLine);
    }
  });

  next();
});

async function writeDeploymentHeartbeat(port: number): Promise<void> {
  try {
    // Resolve git commit SHA (best-effort, non-blocking)
    let gitCommit: string | null = null;
    try {
      gitCommit = await new Promise<string | null>((resolve) => {
        execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: process.cwd(), timeout: 5000 }, (err, stdout) => {
          resolve(err ? null : stdout.trim() || null);
        });
      });
    } catch { /* ignore */ }

    // Find the previous deployment_started entry to compute uptime-since-last-start.
    // Uses the already-imported pg module with a short connection/statement timeout
    // so this lookup never blocks startup for more than a few seconds.
    let prevStartedAt: Date | null = null;
    let uptimeSinceLastStartMs: number | null = null;
    try {
      const dbUrl = process.env.DATABASE_URL;
      if (dbUrl) {
        const prevPool = new pg.Pool({
          connectionString: dbUrl,
          max: 1,
          connectionTimeoutMillis: 4000,
          statement_timeout: 4000,
        });
        try {
          const res = await prevPool.query(
            `SELECT created_at FROM system_audit_log WHERE event_type = 'deployment_started' ORDER BY created_at DESC LIMIT 1`
          );
          if (res.rows[0]?.created_at) {
            prevStartedAt = new Date(res.rows[0].created_at);
            uptimeSinceLastStartMs = Date.now() - prevStartedAt.getTime();
          }
        } finally {
          await prevPool.end();
        }
      }
    } catch { /* ignore — don't block startup */ }

    const isDeployment = process.env.NODE_ENV === 'production';
    await logAudit('server-startup', {
      category: 'system',
      event_type: 'deployment_started',
      severity: 'info',
      actor_id: 'system',
      actor_name: 'System',
      channel: 'startup',
      summary: `Server started on port ${port} (${isDeployment ? 'production' : process.env.NODE_ENV || 'development'})${prevStartedAt ? ` — ${Math.round((uptimeSinceLastStartMs ?? 0) / 60000)} min since last start` : ''}`,
      detail: {
        port,
        node_version: process.version,
        node_env: process.env.NODE_ENV || 'development',
        is_deployment: isDeployment,
        git_commit: gitCommit,
        npm_version: process.env.npm_package_version || null,
        prev_started_at: prevStartedAt?.toISOString() ?? null,
        uptime_since_last_start_ms: uptimeSinceLastStartMs,
        uptime_since_last_start_min: uptimeSinceLastStartMs !== null ? Math.round(uptimeSinceLastStartMs / 60000) : null,
      },
      status: 'success',
    });
    console.log(`[startup] Server heartbeat written — git: ${gitCommit ?? 'unknown'}, prev start: ${prevStartedAt?.toISOString() ?? 'none'}`);
  } catch (e) {
    console.error('[startup] Failed to write server heartbeat:', e);
  }
}

(async () => {
  // Write deployment heartbeat at the very start of boot so crash loops still
  // leave a visible audit trail even if subsequent startup steps fail.
  // Awaited with an internal timeout so it completes before risky startup ops,
  // but never blocks startup for more than a few seconds if the DB is slow.
  const port = Number(process.env.PORT) || 5000;
  if (process.env.NODE_ENV === 'production' || process.env.ENABLE_CRON === '1') {
    await writeDeploymentHeartbeat(port);
  }

  await seedDatabase().catch((err) =>
    console.error("[SEED] Failed to seed database:", err),
  );

  // Load vendor→category rules from DB into the in-memory classifier cache.
  // Best-effort: if the table isn't ready yet the cache stays empty and the
  // in-code TYPE_RULES / OUI_MAP remain the sole classification source.
  await (async () => {
    try {
      const { loadVendorRulesFromDb } = await import('./lib/deviceRulesCache.js');
      await loadVendorRulesFromDb();
    } catch (err) {
      console.warn('[startup] deviceRulesCache load failed (non-fatal):', err);
    }
  })();

  // Warm the irrigation zone-name override cache so getZoneFlow() (used inline
  // by water usage calc + the Janus tool layer) returns admin-renamed labels
  // immediately. Best-effort: missing rows fall back to hardcoded defaults.
  await (async () => {
    try {
      const { refreshZoneNames } = await import('./lib/irrigationFlow.js');
      await refreshZoneNames(() => storage.getIrrigationZoneNames());
    } catch (err) {
      console.warn('[startup] irrigation zone-name cache load failed (non-fatal):', err);
    }
  })();

  // Reconcile the SOUL prompt between SOUL.md and the system_prompts DB
  // row so a stale repo file or an unsynced admin-UI edit can't silently
  // drift. Best-effort: errors are logged but never block startup.
  await (async () => {
    try {
      const { reconcileSoulSource } = await import("./utils/soul-reconcile.js");
      await reconcileSoulSource();
    } catch (err) {
      console.warn("[soul-reconcile] unexpected error:", err);
    }
  })();

  await registerRoutes(app);

  startScheduledTasks();
  initCronJobs();

  runStartupCatchup().catch(err => console.error('[startup] Verkada catch-up failed:', err));

  const server = createServer(app);
  setupSocketIO(server);
  startHAWebSocket();

  app.use((err: Error & { status?: number; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error(`[ERROR] ${status}: ${message}`, err.stack || "");
    // Forward unexpected (5xx) errors to Sentry. Skip 4xx — those are
    // expected client mistakes and would just create noise.
    if (status >= 500) {
      try { sentryCapture(err); } catch { /* never let telemetry crash */ }
    }
    if (!res.headersSent) {
      res.status(status).json({ message });
    }
  });

  // Decide whether Express serves Vite dev middleware (HMR) or static built assets from dist/public/.
  const isProdRuntime =
    process.env.NODE_ENV === "production" ||
    process.env.SERVE_STATIC === "true" ||
    (!process.env.NODE_ENV && fs.existsSync(path.join(process.cwd(), "dist", "public", "index.html")));

  const nodeEnv = process.env.NODE_ENV ?? "<unset>";

  let viteWasLoaded = false;
  if (!isProdRuntime && process.env.SKIP_VITE === "1") {
    console.log(
      `[startup] Running in DEV mode with SKIP_VITE=1 (API only, no frontend).`,
    );
  } else if (!isProdRuntime) {
    console.log(
      `[startup] Running in DEV mode (NODE_ENV=${nodeEnv}). Loading Vite HMR.`,
    );
    await setupVite(app, server);
    viteWasLoaded = true;
  } else {
    console.log(
      `[startup] Running in PROD mode (NODE_ENV=${nodeEnv}). Serving static built assets.`,
    );
    // In a deployed bundle, serve the static built frontend from dist/public.
    const { serveStatic } = await import("./vite");
    serveStatic(app);
  }

  // Post-load invariant: introspect the router stack so a future regression
  // fails loudly at startup instead of silently serving HMR HTML for /api/* routes.
  if (isProdRuntime) {
    const stack: Array<{ handle?: { name?: string }; name?: string }> =
      // Express 5 exposes `app.router`; v4 used `app._router`. Tolerate both.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app as any).router?.stack ?? (app as any)._router?.stack ?? [];
    const viteLayer = stack.find((layer) => {
      const n = layer?.handle?.name ?? layer?.name ?? "";
      return /vite/i.test(n);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sentinel = !!(app as any).locals?.__viteLoaded;
    if (viteWasLoaded || sentinel || viteLayer) {
      throw new Error(
        `Server bootstrap consistency error: running in PROD mode ` +
        `but Vite middleware was loaded (viteWasLoaded=${viteWasLoaded}, ` +
        `sentinel=${sentinel}, viteLayerFound=${!!viteLayer}). Refusing to start.`,
      );
    }
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`Server running on port ${port}`);

    checkAuditLogSource().catch(() => {});

    // Emit system:update ~10 seconds after boot so any clients that were
    // connected during a post-merge restart pick up release notes published
    // by scripts/publish-release.ts before the server came back up.
    // The standalone publish script cannot emit socket events itself — this
    // is the coverage for the primary ship path.
    setTimeout(() => {
      emitToAll("system:update", { trigger: "boot" });
      console.log("[startup] Emitted system:update to refresh client caches after boot.");
    }, 10_000);

    // Startup workflow reconcile — runs 45s after boot to give the HA WebSocket
    // time to connect and populate the entity cache. Immediately fixes any
    // automations that went missing during an HA restart, without waiting for
    // the 30-min cron tick.
    setTimeout(async () => {
      try {
        const baseUrl = `http://localhost:${port}`;
        const res = await fetch(`${baseUrl}/api/ha-workflow-reconciler`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET || '' },
        });
        if (res.ok) {
          console.log('[startup] Workflow reconciler startup run complete');
        } else {
          const body = await res.text().catch(() => '');
          console.error(`[startup] Workflow reconciler startup run failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
        }
      } catch (err: any) {
        console.warn('[startup] Workflow reconciler startup run failed:', err.message);
      }
    }, 45_000);

    // NOTE: the old one-shot boot-time GitHub push (setTimeout 5s →
    // push-to-github.sh) was removed — github-autosync (startGithubAutosync,
    // first tick 30s after boot, then every 5 min) now owns all pushes and
    // serializes them, so two script instances can never contend on git locks.
  });
})();
