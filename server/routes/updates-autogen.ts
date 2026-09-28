// What's New deterministic publisher — cron/manual trigger.
//
// POST /api/updates-autogen  (cron-triggered, 5:30 PM PT daily)
//
// Delegates to the shared pending-release publisher in
// server/lib/pendingRelease.ts (same code path as scripts/publish-release.ts).
// Adds the realtime socket notification that the standalone script cannot emit.
//
// This route replaced the previous AI-from-commits summariser. The pending
// file (pending-release/PENDING.json) is now the source of truth. Each task
// that ships user-facing changes adds its own plain-language entry before
// merging. The post-merge script publishes at merge time; this cron is the
// safety-net catch-all and the canonical path for the system:update event.
//
// Every run — including all skip/no-op outcomes — writes an
// updates_autogen_run audit row so the Automations UI has full per-run
// visibility, matching the behaviour of the old autogen route.

import { Router, type Request } from "express";
import { pool } from "../db.js";
import { logAudit } from "../lib/auditLog.js";
import { emitToAll } from "../socket.js";
import { publishPendingRelease } from "../lib/pendingRelease.js";

const router = Router();

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  return req.headers["x-cron-secret"] === secret;
}

function auditRun(
  summary: string,
  detail: Record<string, unknown>,
  t0: number,
): Promise<void> {
  return logAudit("updates-autogen", {
    category: "automation",
    event_type: "updates_autogen_run",
    severity: "info",
    actor_id: "system",
    channel: "cron",
    summary,
    detail,
    status: "success",
    duration_ms: Date.now() - t0,
  }).catch((e) => console.warn(`[updates-autogen] audit failed: ${e}`));
}

// In-process guard so the daily cron and a concurrent manual trigger don't
// both attempt a publish at the same moment. The advisory lock in
// publishPendingRelease handles true cross-process concurrency; this guard
// avoids the extra DB round-trip for obvious in-process serialization.
let inFlight = false;

router.post("/api/updates-autogen", async (req, res) => {
  const t0 = Date.now();

  if (!isCronAuthorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  if (inFlight) {
    void auditRun(
      "What's New publisher skipped: a run is already in progress",
      { skipped: "already running" },
      t0,
    );
    return res.status(200).json({ skipped: true, reason: "already running" });
  }

  // Acquire the in-flight flag AFTER the cheap checks above, and BEFORE the
  // async pool.connect() so we hold it for the full duration. But we wrap
  // everything in try/finally so the flag is always released — even if
  // pool.connect() itself throws.
  inFlight = true;
  let client;
  try {
    client = await pool.connect();
  } catch (connectErr: unknown) {
    inFlight = false;
    const message = connectErr instanceof Error ? connectErr.message : String(connectErr);
    void logAudit("updates-autogen", {
      category: "automation",
      event_type: "updates_autogen_failed",
      severity: "error",
      actor_id: "system",
      channel: "cron",
      summary: `What's New publisher failed: DB connect error — ${message}`,
      detail: { error: message },
      status: "error",
      duration_ms: Date.now() - t0,
    }).catch(() => {});
    return res.status(500).json({ error: message });
  }

  try {
    const result = await publishPendingRelease(client, "cron", t0);

    if (!result.published) {
      // Every non-publish outcome gets an audit row for Automations UI visibility.
      void auditRun(
        `What's New publisher: ${result.reason}`,
        { skipped: result.reason, shipId: result.shipId },
        t0,
      );
      return res.status(200).json({ skipped: true, reason: result.reason });
    }

    // Notify connected clients immediately — this is the primary realtime path.
    emitToAll("system:update", { version: result.version, count: result.entriesCount });

    return res.status(200).json({
      created: result.entriesCount,
      version: result.version,
      ids: result.ids,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    void logAudit("updates-autogen", {
      category: "automation",
      event_type: "updates_autogen_failed",
      severity: "error",
      actor_id: "system",
      channel: "cron",
      summary: `What's New publisher failed: ${message}`,
      detail: { error: message },
      status: "error",
      duration_ms: Date.now() - t0,
    }).catch((auditErr) => console.warn(`[updates-autogen] audit failed: ${auditErr}`));
    return res.status(500).json({ error: message });
  } finally {
    client.release();
    inFlight = false;
  }
});

export default router;
