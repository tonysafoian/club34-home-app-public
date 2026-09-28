import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer, type ViteDevServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function setupVite(app: Express, server: import("http").Server): Promise<ViteDevServer> {
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { server },
    },
    appType: "custom",
  });

  // Cross-file sentinel — read by server/index.ts's prod-vs-vite startup
  // assertion (CT #127). Any other caller of setupVite() will also flip
  // this, so the assertion catches accidental invocation from a route file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).locals.__viteLoaded = true;

  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    const url = req.originalUrl;
    try {
      const clientTemplate = path.resolve(__dirname, "..", "index.html");
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(template);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });

  return vite;
}

/**
 * Serve the built frontend (dist/public/) as static assets, with an
 * SPA fallback so client-side routes resolve to index.html.
 *
 * Critical: this MUST be mounted AFTER all /api/* routes so it doesn't
 * shadow them. The Express route table is order-sensitive, and a
 * catch-all SPA handler installed before /api/* would swallow every
 * API request and serve index.html for them.
 *
 * Used by server/index.ts when running in production mode
 * (NODE_ENV=production or SERVE_STATIC=true). In dev, setupVite() is used
 * instead.
 */
export function serveStatic(app: Express): void {
  // Static assets live in dist/public/ (produced by `npm run build`).
  // Both candidates below resolve correctly depending on whether
  // server/index.ts is being run directly (dev, __dirname=server/) or
  // from the bundled dist/index.js (prod, __dirname=dist/).
  //
  // Critical: we must check for index.html (not just dir existence),
  // because the repo also contains a root-level /public/ that holds
  // non-frontend assets (changelog.json, etc.) — without the index.html
  // check, prod would pick /public and 500 on every SPA route.
  const candidates = [
    path.resolve(__dirname, "public"),               // prod: dist/public
    path.resolve(__dirname, "..", "dist", "public"), // dev/fallback
  ];
  const root = candidates.find((p) =>
    fs.existsSync(path.join(p, "index.html")),
  );
  if (!root) {
    console.error(
      `[serveStatic] WARNING: no static asset directory found. Tried: ${candidates.join(", ")}. ` +
      `Frontend will return 404s. Ensure 'npm run build' produced dist/public/.`,
    );
    return;
  }
  console.log(`[serveStatic] Serving static frontend from ${root}`);

  // 1. Serve files that actually exist on disk (hashed JS/CSS/etc.)
  app.use(express.static(root, { index: false, maxAge: "1h" }));

  // 2. SPA fallback — any non-/api/* request that didn't match a static
  //    file gets index.html so client-side routing works on refresh.
  app.use("/{*path}", (req, res, next) => {
    if (req.path.startsWith("/api/") || req.path.startsWith("/ws/")) {
      // Don't shadow API/WS routes with index.html. If we got here for
      // /api/*, Express already failed to match any /api route and the
      // intent is a real 404. Let the next handler (or Express's default)
      // return 404 JSON.
      return next();
    }
    const indexPath = path.join(root, "index.html");
    fs.promises
      .readFile(indexPath, "utf-8")
      .then((html) =>
        res.status(200).set({ "Content-Type": "text/html" }).end(html),
      )
      .catch(next);
  });
}
