/**
 * Runner for the standalone server test suite (server/tests/*.test.ts).
 *
 * These are plain tsx scripts (NOT vitest specs — vitest only picks up
 * server/**\/__tests__/*). Each one exits 0 on success, 2 when it cannot run
 * (missing prerequisite, e.g. a secret), and any other non-zero code on
 * failure. This runner executes them sequentially and aggregates the results
 * into a single pass/skip/fail summary, exiting non-zero if any test failed.
 *
 * It is wired up as the `server-tests` validation step so a broken SQL change,
 * column rename, or route regression gets flagged automatically instead of
 * silently breaking a feature.
 *
 * Trigger it via the validation skill:
 *   startValidationRun({ commandIds: ["server-tests"] })
 *
 * Or run it directly:
 *   npx tsx scripts/run-server-tests.ts
 *
 * Several tests hit the running HTTP server (localhost:$PORT). The runner
 * first waits (with retries) for the already-running dev server — covering a
 * workflow that is mid-restart. Only if the app port stays down does it boot
 * its own `npm run dev` instance, and it does so on a SEPARATE free port
 * (never the app port), so the validation can never clash with the "Start
 * application" workflow on port 5000 (EADDRINUSE). It waits for /api/health
 * on that port, runs the suite, then tears its own server back down. DB-only
 * tests just need DATABASE_URL.
 *
 * SKIP map: tests listed in SKIP are intentionally not run, with a documented
 * reason. Keep this list as small as possible.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const TESTS_DIR = path.resolve(import.meta.dirname, "..", "server", "tests");
// Port the dev app runs on (the "Start application" workflow).
const APP_PORT = process.env.PORT || "5000";
// If we must boot our own server, scan this range for a free port. NEVER the
// app port — a duplicate `npm run dev` on 5000 races the running workflow and
// can take it down with EADDRINUSE.
const TEST_PORT_RANGE_START = 5100;
const TEST_PORT_RANGE_END = 5199;

function healthUrl(port: string | number): string {
  return `http://localhost:${port}/api/health`;
}

// Tests that should not be part of the automated gate, with the reason why.
// Keep this minimal — only exclude tests that cannot produce a deterministic
// result in the environment where validation runs.
const SKIP: Record<string, string> = {
  // Asserts that specific household members' phone numbers are seeded in
  // household_members. That is prod-style data which is not present in the dev
  // database (dev and prod are separate DBs), so it can only pass against prod
  // data — it is not a code regression check.
  "whatsapp-identity.test.ts":
    "requires prod-seeded household_members phone data (not present in dev DB)",
};

type Outcome = "PASS" | "FAIL" | "SKIP";
interface TestResult {
  file: string;
  outcome: Outcome;
  exitCode: number | null;
  reason?: string;
}

async function isServerUp(port: string | number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(healthUrl(port), { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(
  port: string | number,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** True if something is listening on the port (even if not healthy yet). */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (inUse: boolean) => {
      sock.destroy();
      resolve(inUse);
    };
    sock.setTimeout(1500);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

/** Find a free port in [TEST_PORT_RANGE_START, TEST_PORT_RANGE_END]. */
async function findFreePort(): Promise<number> {
  for (let port = TEST_PORT_RANGE_START; port <= TEST_PORT_RANGE_END; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "0.0.0.0", () => {
        srv.close(() => resolve(true));
      });
    });
    if (free) return port;
  }
  throw new Error(
    `No free port found in ${TEST_PORT_RANGE_START}-${TEST_PORT_RANGE_END} for the test server.`,
  );
}

function runTest(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", path.join(TESTS_DIR, file)], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const files = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.ts"))
    .sort();

  if (files.length === 0) {
    console.error(`No *.test.ts files found in ${TESTS_DIR}`);
    process.exit(1);
  }

  // Prefer the already-running dev server ("Start application" workflow).
  // Retry for a while: the workflow may be mid-restart, in which case a single
  // failed health probe used to trigger a duplicate `npm run dev` that raced
  // it on the same port (EADDRINUSE) and could take the dev server down.
  let managedServer: ChildProcess | null = null;
  let testPort: string = APP_PORT;

  let appUp = await isServerUp(APP_PORT);
  if (!appUp && (await isPortInUse(Number(APP_PORT)))) {
    // Something is listening but not healthy yet (likely booting) — give it
    // time to come up rather than spawning a competitor.
    console.log(
      `Port ${APP_PORT} is occupied but not healthy yet — waiting for the app to finish booting...`,
    );
    appUp = await waitForServer(APP_PORT, 60000);
  }

  if (appUp) {
    console.log(`Reusing already-running server on port ${APP_PORT}.`);
  } else {
    // Boot our own instance on a separate free port — NEVER on the app port,
    // so this can never clash with the "Start application" workflow.
    const freePort = await findFreePort();
    testPort = String(freePort);
    console.log(
      `No healthy server on port ${APP_PORT} — starting \`npm run dev\` on separate port ${testPort} for tests...`,
    );
    // SKIP_VITE: the tests only hit /api/*, and a second Vite watcher tree can
    // exhaust the inotify watcher limit (ENOSPC) and crash this instance.
    managedServer = spawn("npm", ["run", "dev"], {
      stdio: "ignore",
      env: { ...process.env, PORT: testPort, SKIP_VITE: "1" },
      detached: true,
    });
    const up = await waitForServer(testPort, 60000);
    if (!up) {
      console.error(
        `Test server did not become healthy on port ${testPort} within 60s — HTTP-dependent tests may fail.`,
      );
    } else {
      console.log(`Test server is healthy on port ${testPort}.`);
    }
  }

  // Tests read process.env.PORT to find the HTTP server.
  process.env.PORT = testPort;

  const results: TestResult[] = [];
  try {
    for (const file of files) {
      if (SKIP[file]) {
        console.log(`\n=== SKIP ${file} — ${SKIP[file]} ===`);
        results.push({ file, outcome: "SKIP", exitCode: null, reason: SKIP[file] });
        continue;
      }
      console.log(`\n=== RUN ${file} ===`);
      const code = await runTest(file);
      if (code === 0) {
        results.push({ file, outcome: "PASS", exitCode: code });
      } else if (code === 2) {
        // Convention: exit code 2 means "could not run" (missing prerequisite).
        results.push({
          file,
          outcome: "SKIP",
          exitCode: code,
          reason: "test reported missing prerequisite (exit 2)",
        });
      } else {
        results.push({ file, outcome: "FAIL", exitCode: code });
      }
    }
  } finally {
    if (managedServer && managedServer.pid) {
      try {
        process.kill(-managedServer.pid, "SIGTERM");
      } catch {
        try {
          managedServer.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
  }

  const passed = results.filter((r) => r.outcome === "PASS");
  const skipped = results.filter((r) => r.outcome === "SKIP");
  const failed = results.filter((r) => r.outcome === "FAIL");

  console.log("\n──────── server-tests summary ────────");
  for (const r of results) {
    const tag = r.outcome.padEnd(4);
    const extra =
      r.outcome === "SKIP"
        ? ` (${r.reason})`
        : r.outcome === "FAIL"
          ? ` (exit ${r.exitCode})`
          : "";
    console.log(`  ${tag} ${r.file}${extra}`);
  }
  console.log(
    `\n  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped\n`,
  );

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("server-tests runner error:", e);
  process.exit(1);
});
