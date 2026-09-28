import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import express from "express";
import { putObject, getObject, deleteObject } from "../lib/objectStore.js";

const router = Router();

/**
 * The internal service secret used to authorize storage writes/deletes. Mirrors
 * the service-role convention in `server/middleware/auth.ts`: a caller proving
 * knowledge of JWT_SECRET/SESSION_SECRET is the trusted backend itself. In
 * production `server/auth.ts` guarantees one of these is set.
 */
function serviceSecret(): string | null {
  const configured = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  if (configured) return configured;
  // Fail closed in production: never accept the static dev fallback there.
  if (process.env.NODE_ENV === "production") return null;
  return "janus-dev-secret-change-in-production";
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Guard write/delete routes. Reads were intentionally left public (they serve
 * media to Google Cast / browsers), but uploads and deletes are restricted to
 * the trusted backend to prevent anonymous object-store abuse or media deletion.
 */
function requireServiceAuth(req: Request, res: Response, next: NextFunction) {
  const expected = serviceSecret();
  if (!expected) {
    console.error(`[StorageCompat] No internal secret configured — refusing ${req.method} ${req.path}`);
    return res.status(503).json({ error: "Storage auth not configured" });
  }
  const authHeader = (req.headers.authorization as string) || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const token = bearer || ((req.headers.apikey as string) || "").trim();
  if (token && timingSafeEqualStr(token, expected)) return next();
  console.warn(`[StorageCompat] Rejected unauthorized ${req.method} ${req.path}`);
  return res.status(401).json({ error: "Unauthorized" });
}

/**
 * Reject bucket names that could escape the storage namespace. Buckets are flat
 * identifiers (e.g. `voice-replies`) — no slashes, dots-only, or traversal.
 */
function sanitizeBucket(bucket: string): string | null {
  if (!bucket || !/^[A-Za-z0-9._-]+$/.test(bucket) || bucket === "." || bucket === "..") {
    return null;
  }
  return bucket;
}

/**
 * Reject filenames that could traverse outside the bucket dir (../, absolute
 * paths, backslashes, NUL). Returns the POSIX-normalized relative path.
 */
function sanitizeFilename(filename: string): string | null {
  if (!filename || filename.includes("\0") || filename.includes("\\")) return null;
  const norm = path.posix.normalize(filename);
  if (
    norm.startsWith("/") ||
    norm === ".." ||
    norm.startsWith("../") ||
    norm.includes("/../") ||
    norm.endsWith("/..")
  ) {
    return null;
  }
  return norm;
}

/** Final containment check: the resolved FS path must stay under baseDir. */
function safeJoin(baseDir: string, bucket: string, filename: string): string | null {
  const full = path.resolve(baseDir, bucket, filename);
  const root = path.resolve(baseDir) + path.sep;
  return full.startsWith(root) ? full : null;
}

function setContentType(res: Response, filename: string) {
  if (filename.endsWith(".mp3")) {
    res.setHeader("Content-Type", "audio/mpeg");
    // Cast-friendly cache headers: unique timestamped filenames mean we can
    // cache aggressively.  max-age=0 was causing Cast to drop audio because it
    // couldn't finish buffering before the "no-cache" response expired.
    res.setHeader("Cache-Control", "public, max-age=60, immutable");
    res.setHeader("Accept-Ranges", "bytes");
  } else if (filename.endsWith(".mp4")) {
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
  } else if (filename.endsWith(".png")) {
    res.setHeader("Content-Type", "image/png");
  } else if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
    res.setHeader("Content-Type", "image/jpeg");
  }
}

function parseParams(req: { params: Record<string, any> }): { bucket: string; filename: string } | null {
  const bucket = sanitizeBucket(req.params.bucket);
  if (!bucket) return null;
  const rawFilename = req.params.filename;
  const joined = Array.isArray(rawFilename) ? rawFilename.join("/") : rawFilename;
  const filename = sanitizeFilename(joined);
  if (!filename) return null;
  return { bucket, filename };
}

const CACHE_DIRS = [
  path.join(process.cwd(), "public"),
  path.join(process.cwd(), "dist", "public"),
];

// Endpoint for file uploads
router.post("/storage/v1/object/:bucket/*filename", requireServiceAuth, express.raw({ type: "*/*", limit: "100mb" }), async (req, res) => {
  try {
    const parsed = parseParams(req);
    if (!parsed) return res.status(400).json({ error: "Invalid bucket or filename" });
    const { bucket, filename } = parsed;
    console.log(`[StorageCompat] POST upload - bucket: ${bucket}, filename: ${filename}`);

    const fileBuffer = req.body;
    if (!fileBuffer || fileBuffer.length === 0) {
      return res.status(400).json({ error: "Empty file body" });
    }

    // Durable, instance-shared storage is the source of truth. On autoscale the
    // instance that uploads is often NOT the instance that later serves the GET,
    // so local disk alone causes intermittent 404s (silent Cast drops).
    await putObject(bucket, filename, fileBuffer);

    // Also write to local disk as a best-effort same-instance cache.
    try {
      for (const base of CACHE_DIRS) {
        const dest = safeJoin(base, bucket, filename);
        if (!dest) continue;
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, fileBuffer);
      }
    } catch (cacheErr: any) {
      console.warn(`[StorageCompat] local cache write failed (non-fatal): ${cacheErr?.message}`);
    }

    console.log(`[StorageCompat] Stored ${bucket}/${filename} (${fileBuffer.length} bytes)`);
    return res.status(200).json({ Key: `${bucket}/${filename}` });
  } catch (e: any) {
    console.error("[StorageCompat] Upload error:", e);
    return res.status(500).json({ error: e.message });
  }
});

// Endpoint for serving public files
router.get("/storage/v1/object/public/:bucket/*filename", async (req, res) => {
  try {
    const parsed = parseParams(req);
    if (!parsed) return res.status(400).send("Invalid bucket or filename");
    const { bucket, filename } = parsed;

    // Fast path: serve from local disk cache if this instance happens to have it.
    // res.sendFile natively handles Range/206 requests.
    for (const base of CACHE_DIRS) {
      const p = safeJoin(base, bucket, filename);
      if (p && fs.existsSync(p)) {
        setContentType(res, filename);
        return res.sendFile(p);
      }
    }

    // Durable path: pull from shared object storage (works on any instance).
    const bytes = await getObject(bucket, filename);
    if (!bytes) return res.status(404).send("File not found");

    // Repopulate the local cache so repeat hits on this instance are fast.
    try {
      const cachePath = safeJoin(CACHE_DIRS[0], bucket, filename);
      if (cachePath) {
        await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.promises.writeFile(cachePath, bytes);
      }
    } catch {}

    setContentType(res, filename);

    // Honour Range requests (some media clients, including certain Cast
    // variants, require 206 Partial Content for reliable buffering).
    const total = bytes.length;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (m && (m[1] !== "" || m[2] !== "")) {
        let start = m[1] !== "" ? parseInt(m[1], 10) : NaN;
        let end = m[2] !== "" ? parseInt(m[2], 10) : NaN;
        if (Number.isNaN(start)) start = total - end; // suffix range: bytes=-N
        if (Number.isNaN(end) || end >= total) end = total - 1;
        if (start < 0) start = 0;
        if (Number.isNaN(start) || start > end || start >= total) {
          res.status(416).setHeader("Content-Range", `bytes */${total}`);
          return res.end();
        }
        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(end - start + 1));
        return res.end(bytes.subarray(start, end + 1));
      }
    }

    res.setHeader("Content-Length", String(total));
    return res.status(200).end(bytes);
  } catch (e: any) {
    console.error("[StorageCompat] GET error:", e);
    return res.status(500).send(e.message);
  }
});

// Endpoint for deleting files
router.delete("/storage/v1/object/:bucket/*filename", requireServiceAuth, async (req, res) => {
  try {
    const parsed = parseParams(req);
    if (!parsed) return res.status(400).json({ error: "Invalid bucket or filename" });
    const { bucket, filename } = parsed;

    // Durable delete is the source of truth — surface its failures rather than
    // reporting a successful delete while the object actually remains.
    await deleteObject(bucket, filename);

    for (const base of CACHE_DIRS) {
      const p = safeJoin(base, bucket, filename);
      try {
        if (p && fs.existsSync(p)) await fs.promises.unlink(p);
      } catch {}
    }

    return res.status(200).json({ message: "Deleted" });
  } catch (e: any) {
    console.error("[StorageCompat] DELETE error:", e);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
