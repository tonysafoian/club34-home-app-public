import { Router, type Request, type Response } from "express";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
const execFileAsync = promisify(execFile);
const router = Router();

/**
 * GET /api/fortigate/config-status
 *
 * Public endpoint that returns whether FortiGate is configured (token set).
 * No sensitive data — just boolean flags. Used for operational monitoring.
 */
router.get("/api/fortigate/config-status", (_req: Request, res: Response) => {
  const tokenSet = !!(process.env.FORTIGATE_API_TOKEN);
  const baseUrl = process.env.FORTIGATE_BASE_URL || "https://fortigate.example.com";
  res.json({
    configured: tokenSet,
    base_url: baseUrl,
    hint: tokenSet ? null : "Set FORTIGATE_API_TOKEN in Replit Secrets and redeploy",
  });
});

/**
 * POST /api/deploy/webhook
 *
 * Called by the GitHub Actions CI pipeline after every push to `main`.
 * Pulls the latest code and restarts the server process so Replit's
 * process manager picks up the changes automatically.
 *
 * Security: HMAC-SHA256 signature verification (same scheme as GitHub webhooks).
 * Set DEPLOY_WEBHOOK_SECRET in Replit Secrets to a long random string,
 * and store the same value as REPLIT_DEPLOY_SECRET in GitHub Secrets.
 */
router.post("/api/deploy/webhook", async (req: Request, res: Response) => {
  const secret = process.env.DEPLOY_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[deploy] DEPLOY_WEBHOOK_SECRET not set — rejecting");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  // Verify HMAC-SHA256 signature sent by GitHub Actions.
  const signature = req.headers["x-deploy-signature"] as string | undefined;
  if (!signature) {
    return res.status(401).json({ error: "Missing x-deploy-signature header" });
  }

  const bodyStr = JSON.stringify(req.body);
  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(bodyStr)
    .digest("hex")}`;

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    console.warn("[deploy] Invalid signature — rejecting webhook");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { ref, sha, actor } = req.body ?? {};
  console.log(`[deploy] Webhook received — ref=${ref} sha=${sha} actor=${actor}`);

  // Acknowledge immediately so GitHub Actions doesn't time out
  res.json({ ok: true, message: "Deploy started", sha });

  // Run git pull then restart (deferred so response is sent first)
  setTimeout(async () => {
    try {
      try {
        console.log("[deploy] Refreshing GitHub token...");
        const { stdout: tokenOut } = await execFileAsync("node", ["scripts/refresh-github-token.cjs"], {
          cwd: process.cwd(),
          timeout: 15_000,
        });
        if (tokenOut) console.log("[deploy] Token refresh output:", tokenOut.trim());
      } catch (tokenErr) {
        console.warn("[deploy] Token refresh failed (will try pull anyway):", tokenErr instanceof Error ? tokenErr.message : tokenErr);
      }

      const { stdout: pullOut } = await execFileAsync("git", ["pull", "origin", "main"], {
        cwd: process.cwd(),
        timeout: 60_000,
      });
      console.log("[deploy] git pull:", pullOut.trim());

      const { stdout: installOut } = await execFileAsync("npm", ["ci", "--omit=dev"], {
        cwd: process.cwd(),
        timeout: 120_000,
      });
      console.log("[deploy] npm ci:", installOut.trim().slice(0, 200));

      // Recompile the server bundle so dist/index.js reflects the new source.
      const { stdout: buildOut } = await execFileAsync("npm", ["run", "build"], {
        cwd: process.cwd(),
        timeout: 120_000,
        env: { ...process.env, REPLIT_DEPLOYMENT: "1" }, // skip github push inside build
      });
      console.log("[deploy] npm run build:", buildOut.trim().slice(0, 200));

      console.log("[deploy] Restarting process...");
      process.exit(0);
    } catch (e) {
      console.error("[deploy] Deploy failed:", e instanceof Error ? e.message : e);
    }
  }, 200);
});

export default router;

// Last deploy trigger: 2026-05-21T17:32:55Z

