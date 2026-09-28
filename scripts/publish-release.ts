#!/usr/bin/env tsx
// Deterministic pending-release publisher (post-merge entry point).
//
// Reads pending-release/PENDING.json via the shared publisher in
// server/lib/pendingRelease.ts, publishes any pending entries into
// system_updates, and clears the file so the next task starts fresh.
//
// Designed to run as part of scripts/post-merge.sh, BEFORE the GitHub push —
// so the cleared PENDING.json is committed and pushed in the same merge cycle.
//
// The system:update socket event is emitted by the server on boot (10s delay),
// covering long-lived client sessions after the post-merge restart.

import "dotenv/config";
import pg from "pg";
import { publishPendingRelease } from "../server/lib/pendingRelease.js";

process.env.TZ = process.env.TZ || "America/Los_Angeles";

async function main() {
  const t0 = Date.now();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const result = await publishPendingRelease(client, "post-merge", t0);

    if (!result.published) {
      console.log(`[publish-release] ${result.reason === "no pending notes"
        ? "No pending notes — nothing to publish. Version will not bump."
        : `Skipped: ${result.reason}`}`);
      return;
    }

    console.log(
      `[publish-release] ✅ Published ${result.entriesCount} ${result.entriesCount === 1 ? "entry" : "entries"} as ${result.version}: ${result.ids?.join(", ")}`
    );
    console.log("[publish-release] PENDING.json cleared — ready for next task.");
    console.log(
      "[publish-release] Note: system:update socket event fires when the server restarts after this merge."
    );
  } catch (e) {
    console.error("[publish-release] ❌ Failed:", e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
