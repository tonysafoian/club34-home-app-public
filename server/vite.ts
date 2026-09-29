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
export { serveStatic } from "./static.js";
