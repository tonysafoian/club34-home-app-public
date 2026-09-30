import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { AppleJWK } from "../types";
import "../types";
import {
  generateToken,
  setAuthCookie,
  clearAuthCookie,
  getAuthUser,
  handleNewUser,
  requireAuth,
} from "../auth";
import { GOOGLE_CLIENT_ID as DEFAULT_GOOGLE_CLIENT_ID, getServiceClient } from "../lib/helpers";
import { logAudit } from "../lib/auditLog.js";

const router = Router();

function htmlRedirect(res: Response, url: string) {
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.status(200).type('html').send(
    `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${safe}"></head><body><script>window.location.replace(${JSON.stringify(url)})</script></body></html>`
  );
}

function htmlRedirectWithToken(res: Response, url: string, token: string) {
  const safeUrl = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const safeToken = JSON.stringify(token);
  res.status(200).type('html').send(
    `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${safeUrl}"></head><body><script>try{localStorage.setItem('auth_token',${safeToken});}catch(e){}window.location.replace(${JSON.stringify(url)})</script></body></html>`
  );
}

let applePublicKeysCache: AppleJWK[] | null = null;
let appleKeysCacheExpiry = 0;

async function getApplePublicKeys(): Promise<AppleJWK[]> {
  if (applePublicKeysCache && Date.now() < appleKeysCacheExpiry) {
    return applePublicKeysCache;
  }
  const res = await fetch("https://appleid.apple.com/auth/keys");
  const data = (await res.json()) as { keys: AppleJWK[] };
  applePublicKeysCache = data.keys || [];
  appleKeysCacheExpiry = Date.now() + 60 * 60 * 1000;
  return applePublicKeysCache;
}

interface AppleIdTokenPayload {
  iss: string;
  aud: string;
  exp: number;
  sub: string;
  email?: string;
  email_verified?: string;
}

async function verifyAppleIdToken(idToken: string, clientId: string): Promise<AppleIdTokenPayload | null> {
  try {
    const headerBase64 = idToken.split(".")[0];
    const header = JSON.parse(Buffer.from(headerBase64, "base64").toString()) as { kid: string; alg: string };
    const keys = await getApplePublicKeys();
    const matchingKey = keys.find((k) => k.kid === header.kid);
    if (!matchingKey) return null;

    const keyObj = crypto.createPublicKey({ key: matchingKey as unknown as crypto.JsonWebKey, format: "jwk" });
    const pem = keyObj.export({ type: "spki", format: "pem" }).toString();

    const payload = jwt.verify(idToken, pem, {
      algorithms: ["RS256"],
      issuer: "https://appleid.apple.com",
      audience: clientId,
    }) as AppleIdTokenPayload;

    return payload;
  } catch (err) {
    console.error("Apple ID token verification failed:", err);
    return null;
  }
}

function getBaseUrl(req: Request): string {
  // OAuth requires a STABLE redirect_uri — it must be byte-identical between
  // the init redirect (where the user is sent to Google/Apple) and the token
  // exchange call, AND it must be in the provider's allowlist.
  // Always prefer env-pinned values (GOOGLE_REDIRECT_BASE_URL, APP_URL, APP_DOMAIN).
  if (process.env.GOOGLE_REDIRECT_BASE_URL) {
    return process.env.GOOGLE_REDIRECT_BASE_URL;
  }
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, "");
  }
  if (process.env.APP_DOMAIN) {
    return `https://${process.env.APP_DOMAIN}`;
  }
  const forwardedHost = req.headers["x-forwarded-host"] as string;
  if (forwardedHost) {
    const proto = (req.headers["x-forwarded-proto"] as string) || "https";
    return `${proto}://${forwardedHost}`;
  }
  const host = req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  return `${proto}://${host || "localhost"}`;
}

router.get("/api/auth/me", (req, res) => {
  const user = getAuthUser(req);
  if (!user) {
    res.json({ user: null });
    return;
  }
  res.json({ user });
});

router.post("/api/auth/demo", async (req, res) => {
  const isDev = process.env.NODE_ENV !== "production";
  const allowDemo = isDev || process.env.ENABLE_DEMO_LOGIN === "true" || !process.env.GOOGLE_CLIENT_SECRET;

  if (!allowDemo) {
    res.status(403).json({ error: "Demo login is disabled in this environment." });
    return;
  }

  const user = {
    userId: "demo-admin",
    email: "admin@janus.local",
    displayName: "Estate Owner (Demo)",
    avatarUrl: null,
    roles: ["admin"],
    approvalStatus: "approved",
  };

  try {
    const { storage } = await import("../storage.js");
    const existing = await storage.getProfileByUserId(user.userId);
    if (!existing) {
      await storage.createProfile({
        userId: user.userId,
        displayName: user.displayName || user.email,
        avatarUrl: null,
        approvalStatus: "approved",
        phoneNumber: null,
      });
      await storage.createUserRole({ userId: user.userId, role: "admin" });
    }
  } catch (e) {
    console.warn("[AUTH] Note: demo profile storage sync skipped:", e instanceof Error ? e.message : e);
  }

  const token = generateToken(user);
  setAuthCookie(res, token);

  res.json({ ok: true, user, token });
});

router.get("/api/auth/config", (_req, res) => {
  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID);
  const appleConfigured = Boolean(process.env.APPLE_CLIENT_ID || process.env.VITE_APPLE_CLIENT_ID);
  const demoEnabled = process.env.ENABLE_DEMO_LOGIN !== "false";
  res.json({ googleConfigured, appleConfigured, demoEnabled });
});

router.get("/api/auth/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
  if (!clientId) {
    if (req.accepts("html")) {
      const errorUrl = `${getBaseUrl(req)}/auth?error=google_not_configured`;
      htmlRedirect(res, errorUrl);
      return;
    }
    res.status(500).json({ error: "Google OAuth not configured" });
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });

  const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
  const fullScopes = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/contacts.readonly",
  ].join(" ");
  const queryParams: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: fullScopes,
    state,
    access_type: "offline",
    prompt: "consent",
  };
  if (process.env.HOUSEHOLD_DOMAIN && process.env.HOUSEHOLD_DOMAIN !== "example.com") {
    queryParams.hd = process.env.HOUSEHOLD_DOMAIN;
  }
  const params = new URLSearchParams(queryParams);

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  hd?: string;
}

router.get("/api/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    const savedState = req.cookies?.oauth_state;

    if (!state || state !== savedState) {
      logAudit("auth-google", {
        category: "security", event_type: "login_error", severity: "warn",
        actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "web",
        summary: "Google OAuth login rejected — invalid or missing state parameter (possible CSRF)",
        status: "error",
      });
      htmlRedirect(res, "/?error=invalid_state");
      return;
    }

    res.clearCookie("oauth_state", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });

    const clientId = process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      logAudit("auth-google", {
        category: "security", event_type: "login_error", severity: "error",
        actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "web",
        summary: "Google OAuth login failed — GOOGLE_CLIENT_SECRET not configured",
        status: "error",
      });
      htmlRedirect(res, "/?error=oauth_not_configured");
      return;
    }

    const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenData.access_token) {
      logAudit("auth-google", {
        category: "security", event_type: "login_error", severity: "warn",
        actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "web",
        summary: "Google OAuth token exchange failed — no access_token returned",
        status: "error",
      });
      htmlRedirect(res, "/?error=token_exchange_failed");
      return;
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userInfo = (await userInfoRes.json()) as GoogleUserInfo;
    if (!userInfo.email) {
      logAudit("auth-google", {
        category: "security", event_type: "login_error", severity: "warn",
        actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "web",
        summary: "Google OAuth login failed — no email returned from userinfo API",
        status: "error",
      });
      htmlRedirect(res, "/?error=no_email");
      return;
    }

    const emailDomain = userInfo.email.split("@")[1];
    if (emailDomain !== (process.env.HOUSEHOLD_DOMAIN || "example.com")) {
      const invite = await (await import("../storage")).storage.getInvitedEmail(userInfo.email);
      if (!invite) {
        logAudit("auth-google", {
          category: "security", event_type: "login_denied", severity: "warn",
          actor_id: userInfo.email, actor_name: userInfo.name || userInfo.email || "UNKNOWN", actor_role: "guest",
          channel: "web", summary: `Login denied for ${userInfo.email} — domain not allowed`,
          detail: { email: userInfo.email, domain: emailDomain, reason: "domain_restricted" }, status: "denied",
        });
        htmlRedirect(res, "/?error=domain_restricted");
        return;
      }
    }

    const authUser = await handleNewUser({
      userId: `google_${userInfo.id}`,
      email: userInfo.email,
      displayName: userInfo.name || null,
      avatarUrl: userInfo.picture || null,
    });

    if (tokenData.refresh_token) {
      try {
        const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
        const serviceClient = getServiceClient();
        const googleScopes = [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/contacts.readonly",
        ];
        await serviceClient.from("google_tokens").upsert(
          {
            user_id: authUser.userId,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires_at: expiresAt,
            scopes: googleScopes,
            google_email: userInfo.email,
          },
          { onConflict: "user_id" },
        );
        console.log(`[AUTH] Stored Google tokens for ${userInfo.email}`);
      } catch (tokenStoreErr) {
        console.error("[AUTH] Failed to store Google tokens:", tokenStoreErr);
      }
    }

    const token = generateToken(authUser);
    setAuthCookie(res, token);

    logAudit("auth-google", {
      category: "security", event_type: "login_success", severity: "info",
      actor_id: authUser.userId, actor_name: authUser.displayName || userInfo.email || "UNKNOWN", actor_role: (authUser as typeof authUser & { role?: string }).role || "user",
      channel: "web", summary: `${authUser.displayName || userInfo.email} logged in via Google OAuth`,
      detail: { email: userInfo.email, google_id: userInfo.id, has_refresh_token: !!tokenData.refresh_token }, status: "success",
    });

    htmlRedirectWithToken(res, "/", token);
  } catch (error) {
    console.error("Google OAuth callback error:", error);
    logAudit("auth-google", {
      category: "security", event_type: "login_error", severity: "error",
      actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "web",
      summary: `Google OAuth login failed: ${error instanceof Error ? error.message : "unknown error"}`,
      status: "error",
    });
    htmlRedirect(res, "/?error=oauth_failed");
  }
});

router.post("/api/auth/google/exchange", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      res.status(400).json({ success: false, error: "No code provided" });
      return;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(500).json({ success: false, error: "OAuth not configured" });
      return;
    }

    const redirectUri = `${getBaseUrl(req)}/auth/google/callback`;
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: code as string,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenData.access_token) {
      logAudit("auth-google-exchange", {
        category: "security", event_type: "login_error", severity: "warn",
        actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "mobile",
        summary: "Google mobile token exchange failed — no access_token returned",
        status: "error",
      });
      res.status(400).json({ success: false, error: "Token exchange failed" });
      return;
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userInfo = (await userInfoRes.json()) as GoogleUserInfo;
    if (!userInfo.email) {
      logAudit("auth-google-exchange", {
        category: "security", event_type: "login_error", severity: "warn",
        actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "mobile",
        summary: "Google mobile login failed — no email returned from userinfo API",
        status: "error",
      });
      res.status(400).json({ success: false, error: "No email received" });
      return;
    }

    const emailDomain = userInfo.email.split("@")[1];
    if (emailDomain !== (process.env.HOUSEHOLD_DOMAIN || "example.com")) {
      const invite = await (await import("../storage")).storage.getInvitedEmail(userInfo.email);
      if (!invite) {
        logAudit("auth-google-exchange", {
          category: "security", event_type: "login_denied", severity: "warn",
          actor_id: userInfo.email, actor_name: userInfo.name || userInfo.email || "UNKNOWN", actor_role: "guest",
          channel: "mobile", summary: `Login denied for ${userInfo.email} — domain not allowed`,
          detail: { email: userInfo.email, domain: emailDomain, reason: "domain_restricted" }, status: "denied",
        });
        res.status(403).json({ success: false, error: "Domain restricted" });
        return;
      }
    }

    const authUser = await handleNewUser({
      userId: `google_${userInfo.id}`,
      email: userInfo.email,
      displayName: userInfo.name || null,
      avatarUrl: userInfo.picture || null,
    });

    if (tokenData.refresh_token) {
      try {
        const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();
        const serviceClient = getServiceClient();
        const googleScopes = [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/contacts.readonly",
        ];
        await serviceClient.from("google_tokens").upsert(
          {
            user_id: authUser.userId,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires_at: expiresAt,
            scopes: googleScopes,
            google_email: userInfo.email,
          },
          { onConflict: "user_id" },
        );
        console.log(`[AUTH] Stored Google tokens for ${userInfo.email}`);
      } catch (tokenStoreErr) {
        console.error("[AUTH] Failed to store Google tokens:", tokenStoreErr);
      }
    }

    const token = generateToken(authUser);
    setAuthCookie(res, token);

    logAudit("auth-google-exchange", {
      category: "security", event_type: "login_success", severity: "info",
      actor_id: authUser.userId, actor_name: authUser.displayName || userInfo.email || "UNKNOWN", actor_role: (authUser as typeof authUser & { role?: string }).role || "user",
      channel: "mobile", summary: `${authUser.displayName || userInfo.email} logged in via Google OAuth (mobile)`,
      detail: { email: userInfo.email, google_id: userInfo.id, has_refresh_token: !!tokenData.refresh_token }, status: "success",
    });

    res.json({ success: true, user: authUser, token });
  } catch (error) {
    console.error("Google OAuth exchange error:", error);
    logAudit("auth-google-exchange", {
      category: "security", event_type: "login_error", severity: "error",
      actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "mobile",
      summary: `Google OAuth exchange failed: ${error instanceof Error ? error.message : "unknown error"}`,
      status: "error",
    });
    res.status(500).json({ success: false, error: "OAuth exchange failed" });
  }
});

router.get("/api/auth/apple", (req, res) => {
  const clientId = process.env.APPLE_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "Apple OAuth not configured" });
    return;
  }

  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });

  const redirectUri = `${getBaseUrl(req)}/api/auth/apple/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code id_token",
    scope: "name email",
    response_mode: "form_post",
    state,
  });

  res.redirect(`https://appleid.apple.com/auth/authorize?${params}`);
});

interface AppleCallbackBody {
  code?: string;
  state?: string;
  id_token?: string;
  user?: string;
}

interface AppleUserData {
  name?: {
    firstName?: string;
    lastName?: string;
  };
  email?: string;
}

router.post("/api/auth/apple/callback", async (req, res) => {
  try {
    const { state, id_token, user: appleUser } = req.body as AppleCallbackBody;
    const savedState = req.cookies?.oauth_state;

    if (!state || state !== savedState) {
      htmlRedirect(res, "/?error=invalid_state");
      return;
    }

    res.clearCookie("oauth_state", { httpOnly: true, secure: true, sameSite: "none", path: "/" });

    if (!id_token) {
      htmlRedirect(res, "/?error=no_id_token");
      return;
    }

    const appleClientId = process.env.APPLE_CLIENT_ID;
    if (!appleClientId) {
      htmlRedirect(res, "/?error=apple_not_configured");
      return;
    }

    const payload = await verifyAppleIdToken(id_token, appleClientId);
    if (!payload) {
      htmlRedirect(res, "/?error=invalid_id_token");
      return;
    }

    const email = payload.email;
    const sub = payload.sub;

    if (!email) {
      htmlRedirect(res, "/?error=no_email");
      return;
    }

    let displayName: string | null = null;
    if (appleUser) {
      try {
        const userData: AppleUserData = typeof appleUser === "string" ? JSON.parse(appleUser) : appleUser;
        if (userData.name) {
          displayName = [userData.name.firstName, userData.name.lastName]
            .filter(Boolean)
            .join(" ") || null;
        }
      } catch {
        /* Apple only sends user info on first auth */
      }
    }

    const authUser = await handleNewUser({
      userId: `apple_${sub}`,
      email,
      displayName,
      avatarUrl: null,
    });

    const token = generateToken(authUser);
    setAuthCookie(res, token);

    logAudit("auth-apple", {
      category: "security", event_type: "login_success", severity: "info",
      actor_id: authUser.userId, actor_name: authUser.displayName || email || "UNKNOWN", actor_role: (authUser as typeof authUser & { role?: string }).role || "user",
      channel: "web", summary: `${authUser.displayName || email} logged in via Apple Sign-In`,
      detail: { email, apple_sub: sub }, status: "success",
    });

    htmlRedirect(res, "/");
  } catch (error) {
    console.error("Apple OAuth callback error:", error);
    logAudit("auth-apple", {
      category: "security", event_type: "login_error", severity: "error",
      actor_id: "UNKNOWN", actor_name: "UNKNOWN", channel: "web",
      summary: `Apple Sign-In failed: ${error instanceof Error ? error.message : "unknown error"}`,
      status: "error",
    });
    htmlRedirect(res, "/?error=oauth_failed");
  }
});

router.post("/api/auth/logout", (req: Request, res) => {
  const user = getAuthUser(req);
  clearAuthCookie(res);
  if (user) {
    logAudit("auth-logout", {
      category: "security", event_type: "logout", severity: "info",
      actor_id: user.userId, actor_name: user.displayName || user.email || "UNKNOWN", actor_role: (user as typeof user & { role?: string }).role || "user",
      channel: "web", summary: `${user.displayName || user.email} logged out`,
      detail: { email: user.email }, status: "success",
    });
  }
  res.json({ success: true });
});

router.get("/api/auth/session", requireAuth, async (req, res) => {
  const user = req.user;
  res.json({ user });
});

const sseTickets = new Map<string, { userId: string; expiresAt: number }>();

router.post("/api/auth/sse-ticket", requireAuth, (req, res) => {
  const user = req.user!;
  const ticket = crypto.randomBytes(32).toString("hex");
  sseTickets.set(ticket, { userId: user.userId, expiresAt: Date.now() + 60_000 });
  setTimeout(() => sseTickets.delete(ticket), 60_000);
  res.json({ ticket });
});

export function consumeSseTicket(ticket: string): string | null {
  const entry = sseTickets.get(ticket);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sseTickets.delete(ticket);
    return null;
  }
  sseTickets.delete(ticket);
  return entry.userId;
}

export default router;
