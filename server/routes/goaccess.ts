import { Router, type Request, type Response } from "express";
import { authenticateRequest, getServiceClient, GOOGLE_CLIENT_ID, REDIRECT_URI, logAudit } from "../lib/helpers.js";
import { query } from "../lib/db.js";
import { pollGoAccessEmails } from "../handlers/goaccess-poll.js";

const router = Router();

const GOACCESS_SCOPES = "https://www.googleapis.com/auth/gmail.readonly";
const GOACCESS_USER_ID = "goaccess_system";
const GOACCESS_EMAIL = "gate-notifications@example.com";

router.post("/poll", async (req: Request, res: Response) => {
  const cronSecret = process.env.CRON_SECRET;
  const cronHeader = req.headers["x-cron-secret"] as string | undefined;

  if (cronHeader && cronSecret && cronHeader === cronSecret) {
    return pollGoAccessEmails(req, res);
  }

  const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
  if (auth.error) return res.status(401).json({ error: auth.error });

  return pollGoAccessEmails(req, res);
});

router.get("/checkins", async (req: Request, res: Response) => {
  const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
  if (auth.error) return res.status(401).json({ error: auth.error });

  try {
    await query(
      `CREATE TABLE IF NOT EXISTS goaccess_checkins (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        guest_name TEXT NOT NULL,
        company_name TEXT,
        checked_in_at TIMESTAMPTZ NOT NULL,
        raw_email_subject TEXT,
        gmail_message_id TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`
    );

    const filter = (req.query.filter as string) || "all";
    let dateCondition = "";

    if (filter === "today") {
      dateCondition = "WHERE checked_in_at >= CURRENT_DATE";
    } else if (filter === "7days") {
      dateCondition = "WHERE checked_in_at >= CURRENT_DATE - INTERVAL '7 days'";
    } else if (filter === "30days") {
      dateCondition = "WHERE checked_in_at >= CURRENT_DATE - INTERVAL '30 days'";
    }

    const result = await query(
      `SELECT id, guest_name, company_name, checked_in_at, raw_email_subject, gmail_message_id, created_at
       FROM goaccess_checkins
       ${dateCondition}
       ORDER BY checked_in_at DESC
       LIMIT 500`
    );

    res.json({ success: true, checkins: result.rows });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[goaccess] Checkins query error:", msg);
    res.status(500).json({ success: false, error: msg });
  }
});

router.post("/auth", async (req: Request, res: Response) => {
  try {
    const action = req.query.action || req.body?.action;

    if (action === "authorize") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const state = `goaccess_${auth.userId}`;
      const authUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(GOACCESS_SCOPES)}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&login_hint=${encodeURIComponent(GOACCESS_EMAIL)}` +
        `&state=${encodeURIComponent(state)}`;

      return res.json({ success: true, url: authUrl });
    }

    if (action === "callback") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const code = req.query.code || req.body?.code;
      const state = req.query.state || req.body?.state;
      if (!code) return res.status(400).json({ success: false, error: "Missing authorization code" });

      const expectedState = `goaccess_${auth.userId}`;
      if (!state || state !== expectedState) {
        console.error(`[goaccess] OAuth state mismatch: got "${state}", expected "${expectedState}"`);
        return res.status(400).json({ success: false, error: "OAuth state validation failed" });
      }

      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientSecret) return res.status(500).json({ success: false, error: "GOOGLE_CLIENT_SECRET not configured" });

      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: code as string,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: clientSecret,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenResponse.json();
      if (!tokenResponse.ok) {
        return res.status(400).json({
          success: false,
          error: tokenData.error_description || "Token exchange failed",
        });
      }

      const userInfoResp = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
      );
      const userInfo = await userInfoResp.json();

      if (userInfo.email && userInfo.email.toLowerCase() !== GOACCESS_EMAIL) {
        console.error(`[goaccess] Wrong Google account connected: ${userInfo.email}, expected ${GOACCESS_EMAIL}`);
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenData.access_token}`, { method: "POST" });
        } catch {
          // best-effort token revoke; ignore failures
        }
        return res.status(400).json({
          success: false,
          error: `Please connect ${GOACCESS_EMAIL}. You connected ${userInfo.email} instead.`,
        });
      }

      const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
      const serviceClient = getServiceClient();

      const { error: dbError } = await serviceClient
        .from("google_tokens")
        .upsert(
          {
            user_id: GOACCESS_USER_ID,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires_at: expiresAt,
            scopes: GOACCESS_SCOPES.split(" "),
            google_email: GOACCESS_EMAIL,
          },
          { onConflict: "user_id" },
        );

      if (dbError) {
        console.error("[goaccess] Token store error:", dbError);
        return res.status(500).json({ success: false, error: "Failed to store tokens" });
      }

      logAudit("goaccess-oauth", {
        category: "security",
        event_type: "goaccess_google_connected",
        severity: "info",
        actor_id: auth.userId,
        channel: "web",
        summary: `GoAccess Google account connected: ${userInfo.email}`,
        status: "success",
      }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

      return res.json({ success: true, google_email: userInfo.email });
    }

    if (action === "disconnect") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const serviceClient = getServiceClient();

      const { data: tokenRow } = await serviceClient
        .from("google_tokens")
        .select("access_token")
        .eq("user_id", GOACCESS_USER_ID)
        .single();

      if (tokenRow?.access_token) {
        try {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenRow.access_token}`, { method: "POST" });
        } catch {
          // best-effort token revoke; ignore failures
        }
        await serviceClient.from("google_tokens").delete().eq("user_id", GOACCESS_USER_ID);
      }

      return res.json({ success: true });
    }

    if (action === "status") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const serviceClient = getServiceClient();

      const { data: tokenRow } = await serviceClient
        .from("google_tokens")
        .select("google_email, token_expires_at")
        .eq("user_id", GOACCESS_USER_ID)
        .single();

      return res.json({
        success: true,
        connected: !!tokenRow,
        google_email: tokenRow?.google_email || null,
      });
    }

    return res.status(400).json({ success: false, error: "Invalid action" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("[goaccess] Auth error:", msg);
    return res.status(500).json({ success: false, error: msg });
  }
});

export default router;
