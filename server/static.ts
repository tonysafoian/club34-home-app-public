import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serve the built frontend (dist/public/) as static assets, with an
 * SPA fallback so client-side routes resolve to index.html.
 *
 * Critical: this file has ZERO imports of Vite or Rolldown so that
 * production runtimes never trigger optional native binding loads.
 */
export function serveStatic(app: Express): void {
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
