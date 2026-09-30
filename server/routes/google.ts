import { Router, type Request, type Response } from "express";
import { createClient } from "../utils/supabase.js";
import {
  authenticateRequest,
  getGoogleTokenFromEnv,
  fetchT,
  logAudit,
  GOOGLE_CLIENT_ID,
  REDIRECT_URI,
  HOME_LAT,
  HOME_LNG,
  getServiceClient,
  base64url,
  getSaKey,
  getServiceToken,
} from "../lib/helpers.js";
import { sanitizeErrorMessage } from "../lib/error-sanitizer.js";

const router = Router();

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/contacts.readonly",
].join(" ");

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

async function getUserOAuthToken(
  userId: string,
): Promise<{ token: string | null; error: string | null; noStoredToken?: boolean }> {
  try {
    const serviceClient = getServiceClient();
    const { data: tokenRow, error: fetchErr } = await serviceClient
      .from("google_tokens")
      .select("access_token, refresh_token, token_expires_at")
      .eq("user_id", userId)
      .single();

    if (fetchErr) {
      if (fetchErr.code === "PGRST116") {
        console.log(`[CALENDAR] No stored OAuth token for user ${userId}`);
        return { token: null, error: null, noStoredToken: true };
      }
      console.error(`[CALENDAR] DB error fetching OAuth token for user ${userId}:`, fetchErr);
      return { token: null, error: "Failed to read stored token" };
    }
    if (!tokenRow) {
      console.log(`[CALENDAR] No stored OAuth token for user ${userId}`);
      return { token: null, error: null, noStoredToken: true };
    }

    const expiresAt = new Date(tokenRow.token_expires_at).getTime();
    const now = Date.now();
    const bufferMs = 60_000;

    if (expiresAt - now > bufferMs) {
      console.log(`[CALENDAR] Using stored OAuth token for user ${userId}`);
      return { token: tokenRow.access_token, error: null };
    }

    console.log(`[CALENDAR] OAuth token expired for user ${userId}, refreshing...`);
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientSecret) {
      console.error("[CALENDAR] GOOGLE_CLIENT_SECRET not configured, cannot refresh token");
      return { token: null, error: "Cannot refresh token — client secret not configured" };
    }

    const refreshResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: clientSecret,
        refresh_token: tokenRow.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    const refreshData = await refreshResp.json();
    if (!refreshResp.ok) {
      const errMsg = refreshData.error_description || "Token refresh failed";
      console.error(`[CALENDAR] OAuth refresh failed for user ${userId}:`, errMsg);
      logAudit("google-oauth-refresh", {
        category: "security", event_type: "token_refresh_failed", severity: "error",
        actor_id: userId, actor_name: "UNKNOWN", channel: "server",
        summary: `Google OAuth token refresh failed for user ${userId}: ${errMsg}`,
        detail: { error: errMsg }, status: "error",
      });
      return { token: null, error: errMsg };
    }

    const newExpiresAt = new Date(
      Date.now() + refreshData.expires_in * 1000,
    ).toISOString();

    const { error: updateErr } = await serviceClient
      .from("google_tokens")
      .update({
        access_token: refreshData.access_token,
        token_expires_at: newExpiresAt,
      })
      .eq("user_id", userId);

    if (updateErr) {
      console.error(`[CALENDAR] Failed to persist refreshed token for user ${userId}:`, updateErr);
    }

    console.log(`[CALENDAR] OAuth token refreshed successfully for user ${userId}`);
    logAudit("google-oauth-refresh", {
      category: "security", event_type: "token_refreshed", severity: "info",
      actor_id: userId, actor_name: "UNKNOWN", channel: "server",
      summary: `Google OAuth token refreshed for user ${userId}`,
      detail: { new_expires_at: newExpiresAt }, status: "success",
    });
    return { token: refreshData.access_token, error: null };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown OAuth error";
    console.error(`[CALENDAR] getUserOAuthToken error for user ${userId}:`, errMsg);
    return { token: null, error: errMsg };
  }
}

export async function getServiceAccountToken(
  userEmail: string,
): Promise<{ token: string | null; error: string | null }> {
  try {
    console.log(`[CALENDAR] Attempting service account impersonation for ${userEmail}`);
    const token = await getGoogleTokenFromEnv(
      "https://www.googleapis.com/auth/calendar",
      userEmail,
    );
    console.log(`[CALENDAR] Service account token obtained for ${userEmail}`);
    return { token, error: null };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown auth error";
    console.error(`[CALENDAR] Service account auth failed for ${userEmail}:`, errMsg);
    return { token: null, error: errMsg };
  }
}

async function getGoogleAccessToken(
  userEmail: string,
  userId?: string | null,
  isServiceRole?: boolean,
): Promise<{ token: string | null; error: string | null }> {
  if (!isServiceRole && userId) {
    const oauthResult = await getUserOAuthToken(userId);
    if (oauthResult.token) {
      return oauthResult;
    }
    if (oauthResult.noStoredToken) {
      console.log(`[CALENDAR] No stored OAuth token for user ${userId}, falling back to service account`);
      return getServiceAccountToken(userEmail);
    }
    console.error(`[CALENDAR] User OAuth token exists but failed for ${userId}: ${oauthResult.error}`);
    return { token: null, error: oauthResult.error || "OAuth token refresh failed — try reconnecting Google" };
  }

  return getServiceAccountToken(userEmail);
}

router.options("/auth", (_req: Request, res: Response) => {
  res.sendStatus(204);
});

router.post("/auth", async (req: Request, res: Response) => {
  try {
    const action = req.query.action || req.body?.action;

    if (action === "authorize") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      let authUrl =
        `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${encodeURIComponent(GOOGLE_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&access_type=offline` +
        `&prompt=consent` +
        `&state=${encodeURIComponent(state!)}`;

      if (process.env.HOUSEHOLD_DOMAIN && process.env.HOUSEHOLD_DOMAIN !== "example.com") {
        authUrl += `&hd=${encodeURIComponent(process.env.HOUSEHOLD_DOMAIN)}`;
      }

      return res.json({ success: true, url: authUrl });
    }

    if (action === "callback") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const code = req.query.code || req.body?.code;
      if (!code)
        return res
          .status(400)
          .json({ success: false, error: "Missing authorization code" });

      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientSecret)
        return res
          .status(500)
          .json({ success: false, error: "GOOGLE_CLIENT_SECRET not configured" });

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

      const expiresAt = new Date(
        Date.now() + tokenData.expires_in * 1000,
      ).toISOString();
      const serviceClient = getServiceClient();

      const { error: dbError } = await serviceClient
        .from("google_tokens")
        .upsert(
          {
            user_id: auth.userId,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            token_expires_at: expiresAt,
            scopes: SCOPES.split(" "),
            google_email: userInfo.email || null,
          },
          { onConflict: "user_id" },
        );

      if (dbError) {
        console.error("[GOOGLE] Token store error:", dbError);
        return res
          .status(500)
          .json({ success: false, error: "Failed to store tokens" });
      }

      return res.json({ success: true, google_email: userInfo.email });
    }

    if (action === "refresh") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const serviceClient = getServiceClient();
      const { data: tokenRow, error: fetchErr } = await serviceClient
        .from("google_tokens")
        .select("*")
        .eq("user_id", auth.userId!)
        .single();

      if (fetchErr || !tokenRow)
        return res
          .status(404)
          .json({ success: false, error: "No Google tokens found" });

      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const refreshResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: clientSecret!,
          refresh_token: tokenRow.refresh_token,
          grant_type: "refresh_token",
        }),
      });

      const refreshData = await refreshResp.json();
      if (!refreshResp.ok) {
        return res.status(400).json({
          success: false,
          error: refreshData.error_description || "Refresh failed",
        });
      }

      await serviceClient
        .from("google_tokens")
        .update({
          access_token: refreshData.access_token,
          token_expires_at: new Date(
            Date.now() + refreshData.expires_in * 1000,
          ).toISOString(),
        })
        .eq("user_id", auth.userId!);

      return res.json({ success: true });
    }

    if (action === "disconnect") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const serviceClient = getServiceClient();
      const { data: tokenRow } = await serviceClient
        .from("google_tokens")
        .select("access_token")
        .eq("user_id", auth.userId!)
        .single();

      if (tokenRow?.access_token) {
        try {
          await fetch(
            `https://oauth2.googleapis.com/revoke?token=${tokenRow.access_token}`,
            { method: "POST" },
          );
        } catch (_) {}
        await serviceClient
          .from("google_tokens")
          .delete()
          .eq("user_id", auth.userId!);
      }

      return res.json({ success: true });
    }

    if (action === "status") {
      const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
      if (auth.error) return res.status(401).json({ error: auth.error });

      const serviceClient = getServiceClient();
      const { data: tokenRow } = await serviceClient
        .from("google_tokens")
        .select("google_email, scopes, token_expires_at")
        .eq("user_id", auth.userId!)
        .single();

      return res.json({
        success: true,
        connected: !!tokenRow,
        google_email: tokenRow?.google_email || null,
        scopes: tokenRow?.scopes || [],
      });
    }

    return res.status(400).json({
      success: false,
      error:
        "Invalid action. Use: authorize, callback, refresh, disconnect, status",
    });
  } catch (error) {
    console.error("Google auth error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ success: false, error: msg });
  }
});

router.options("/calendar", (_req: Request, res: Response) => {
  res.sendStatus(204);
});

router.post("/calendar", async (req: Request, res: Response) => {
  const auth = await authenticateRequest(req.headers.authorization, req.cookies?.auth_token);
  if (auth.error) return res.status(401).json({ error: auth.error });

  try {
    const {
      action,
      calendarId,
      timeMin,
      timeMax,
      maxResults,
      title,
      start,
      end,
      description,
      location,
      attendees,
      emails,
      eventId,
    } = req.body;

    const impersonateEmail = auth.isServiceRole
      ? calendarId || "admin@example.com"
      : auth.email!;

    const { token: googleToken, error: tokenError } =
      await getGoogleAccessToken(impersonateEmail, auth.userId, auth.isServiceRole);
    if (tokenError || !googleToken) {
      console.error(`[CALENDAR] Failed to get token for email=${impersonateEmail} userId=${auth.userId} isServiceRole=${auth.isServiceRole}: ${tokenError || "No token"}`);
      return res
        .status(500)
        .json({ success: false, error: tokenError || "No Google token" });
    }

    const googleHeaders = {
      Authorization: `Bearer ${googleToken}`,
      "Content-Type": "application/json",
    };

    if (action === "list-calendars") {
      const resp = await fetch(`${CALENDAR_BASE}/users/me/calendarList`, {
        headers: googleHeaders,
      });
      const data = await resp.json();
      if (!resp.ok)
        return res.json({
          success: false,
          error: data.error?.message || `Google API error ${resp.status}`,
        });
      return res.json({ success: true, calendars: data.items || [] });
    }

    if (action === "list-events") {
      const cId = calendarId || "primary";
      const params = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(maxResults || 250),
      });
      if (timeMin) params.set("timeMin", timeMin);
      if (timeMax) params.set("timeMax", timeMax);

      const resp = await fetch(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events?${params}`,
        { headers: googleHeaders },
      );
      const data = await resp.json();
      if (!resp.ok)
        return res.json({
          success: false,
          error: data.error?.message || `Google API error ${resp.status}`,
        });
      return res.json({ success: true, events: data.items || [] });
    }

    if (action === "create-event") {
      const cId = calendarId || impersonateEmail;
      const event: Record<string, unknown> = {
        summary: title,
        start: start?.includes("T")
          ? { dateTime: start, timeZone: "America/Los_Angeles" }
          : { date: start },
        end: end?.includes("T")
          ? { dateTime: end, timeZone: "America/Los_Angeles" }
          : { date: end },
      };
      if (description) event.description = description;
      if (location) event.location = location;
      if (attendees?.length)
        event.attendees = (attendees as string[]).map((e: string) => ({
          email: e,
        }));

      const resp = await fetch(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events`,
        {
          method: "POST",
          headers: googleHeaders,
          body: JSON.stringify(event),
        },
      );
      const data = await resp.json();
      if (!resp.ok)
        return res.json({
          success: false,
          error: data.error?.message || `Google API error ${resp.status}`,
        });
      return res.json({
        success: true,
        event: data,
        htmlLink: data.htmlLink,
      });
    }

    if (action === "update-event") {
      const cId = calendarId || impersonateEmail;
      if (!eventId)
        return res
          .status(400)
          .json({ success: false, error: "eventId is required" });

      const patch: Record<string, unknown> = {};
      if (typeof title === "string") patch.summary = title;
      if (typeof description === "string") patch.description = description;
      if (typeof location === "string") patch.location = location;
      if (start) {
        patch.start = start.includes("T")
          ? { dateTime: start, timeZone: "America/Los_Angeles" }
          : { date: start };
      }
      if (end) {
        patch.end = end.includes("T")
          ? { dateTime: end, timeZone: "America/Los_Angeles" }
          : { date: end };
      }
      if (Array.isArray(attendees) && attendees.length) {
        patch.attendees = (attendees as string[]).map((e: string) => ({
          email: e,
        }));
      }

      const resp = await fetch(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events/${encodeURIComponent(eventId)}`,
        {
          method: "PATCH",
          headers: googleHeaders,
          body: JSON.stringify(patch),
        },
      );
      const data = await resp.json();
      if (!resp.ok)
        return res.json({
          success: false,
          error:
            (data as any).error?.message ||
            `Google API error ${resp.status}`,
        });
      return res.json({ success: true, event: data, htmlLink: data.htmlLink });
    }

    if (action === "delete-event") {
      const cId = calendarId || impersonateEmail;
      if (!eventId)
        return res
          .status(400)
          .json({ success: false, error: "eventId is required" });

      const resp = await fetch(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events/${encodeURIComponent(eventId)}`,
        { method: "DELETE", headers: googleHeaders },
      );
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        return res.json({
          success: false,
          error:
            (data as any).error?.message || `Google API error ${resp.status}`,
        });
      }
      return res.json({ success: true });
    }

    if (action === "list-family-events") {
      let FAMILY: { key: string; email: string }[] = [];
      try {
        const { rows } = await query(
          `SELECT id, display_name, email FROM household_members WHERE is_active = true AND email IS NOT NULL ORDER BY created_at ASC`
        );
        if (rows && rows.length > 0) {
          FAMILY = rows.map((r: any) => ({
            key: r.id,
            email: r.email,
          }));
        }
      } catch (err) {
        console.warn("[Google] Error fetching household_members for family events:", err);
      }

      if (FAMILY.length === 0) {
        FAMILY = [
          { key: "admin", email: process.env.ADMIN_EMAIL || "admin@example.com" },
          { key: "member", email: process.env.MEMBER_EMAIL || "member@example.com" },
        ];
      }

      const params = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100",
      });
      if (timeMin) params.set("timeMin", timeMin);
      if (timeMax) params.set("timeMax", timeMax);

      const results = await Promise.allSettled(
        FAMILY.map(async ({ key, email: memberEmail }) => {
          const { token: tok, error: tokErr } =
            await getGoogleAccessToken(memberEmail);
          if (tokErr || !tok) return { key, events: [], error: tokErr };
          const resp = await fetch(
            `${CALENDAR_BASE}/calendars/primary/events?${params}`,
            {
              headers: {
                Authorization: `Bearer ${tok}`,
                "Content-Type": "application/json",
              },
            },
          );
          const d = await resp.json();
          if (!resp.ok)
            return {
              key,
              events: [],
              error: d.error?.message || `Error ${resp.status}`,
            };
          return { key, events: d.items || [] };
        }),
      );

      const familyEvents: Record<string, unknown[]> = {};
      for (const r of results) {
        if (r.status === "fulfilled") {
          familyEvents[r.value.key] = r.value.events;
        }
      }
      for (const { key } of FAMILY) {
        if (!familyEvents[key]) familyEvents[key] = [];
      }

      return res.json({ success: true, familyEvents });
    }

    if (action === "check-availability") {
      const freeBusyEmail = auth.isServiceRole
        ? "admin@example.com"
        : auth.email!;
      const { token: fbToken, error: fbTokenErr } =
        await getGoogleAccessToken(freeBusyEmail);
      if (fbTokenErr || !fbToken)
        return res.status(500).json({
          success: false,
          error: fbTokenErr || "No Google token for FreeBusy",
        });

      const emailList = (emails as string[]) || [];
      const resp = await fetch(`${CALENDAR_BASE}/freeBusy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${fbToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          timeMin,
          timeMax,
          items: emailList.map((e: string) => ({ id: e })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok)
        return res.json({
          success: false,
          error: data.error?.message || `Google API error ${resp.status}`,
        });
      return res.json({
        success: true,
        availability: data.calendars || {},
      });
    }

    return res.status(400).json({
      success: false,
      error:
        "Invalid action. Use: list-calendars, list-events, create-event, delete-event, list-family-events, check-availability",
    });
  } catch (error) {
    console.error("Google Calendar proxy error:", error);
    logAudit("google-calendar-proxy", {
      category: "integration",
      event_type: "calendar_error",
      severity: "error",
      actor_id: "system",
      actor_name: "System",
      channel: "system",
      summary: `Calendar proxy error: ${error instanceof Error ? error.message : "unknown"}`,
      status: "error",
    });
    return res
      .status(500)
      .json({ success: false, error: sanitizeErrorMessage(error) });
  }
});

router.options("/environment", (_req: Request, res: Response) => {
  res.sendStatus(204);
});

async function handleEnvironment(req: Request, res: Response) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "Google Maps API key not configured" });
  }

  const params = req.method === "POST" ? (req.body || {}) : req.query;
  const action = params.action as string;

  if (action === "api-key") {
    return res.json({ api_key: apiKey });
  }

  if (action === "distance") {
    const destinations = params.destinations as string;
    if (!destinations)
      return res.status(400).json({ error: "Missing destinations" });

    const dmUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${HOME_LAT},${HOME_LNG}&destinations=${encodeURIComponent(destinations)}&units=imperial&key=${apiKey}`;
    const r = await fetchT(dmUrl);
    const data = await r.json();
    return res.json({ home: { lat: HOME_LAT, lng: HOME_LNG }, ...data });
  }

  if (action === "aerial-view") {
    const address =
      (params.address as string) ||
      process.env.HOME_ADDRESS || "Home";
    const lookupUrl = `https://aerialview.googleapis.com/v1/videos:lookupVideo?key=${apiKey}&address=${encodeURIComponent(address)}`;
    const lookupRes = await fetchT(lookupUrl);
    const lookupData = await lookupRes.json();

    if (lookupRes.status === 200 && lookupData.state) {
      return res.json(lookupData);
    }

    const renderUrl = `https://aerialview.googleapis.com/v1/videos:renderVideo?key=${apiKey}`;
    const renderRes = await fetchT(renderUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const renderData = await renderRes.json();
    return res.json(renderData);
  }

  if (action === "aerial-view-poll") {
    const videoId = params.videoId as string;
    if (!videoId) return res.status(400).json({ error: "Missing videoId" });

    const pollUrl = `https://aerialview.googleapis.com/v1/videos/${videoId}?key=${apiKey}`;
    const pollRes = await fetchT(pollUrl);
    const pollData = await pollRes.json();
    return res.json(pollData);
  }

  try {
    const [aqRes, pollenRes, alertsRes] = await Promise.all([
      fetchT(
        `https://airquality.googleapis.com/v1/currentConditions:lookup?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            location: { latitude: HOME_LAT, longitude: HOME_LNG },
            extraComputations: [
              "HEALTH_RECOMMENDATIONS",
              "DOMINANT_POLLUTANT_CONCENTRATION",
              "POLLUTANT_CONCENTRATION",
              "LOCAL_AQI",
              "POLLUTANT_ADDITIONAL_INFO",
            ],
          }),
        },
      ),
      fetchT(
        `https://pollen.googleapis.com/v1/forecast:lookup?key=${apiKey}&location.latitude=${HOME_LAT}&location.longitude=${HOME_LNG}&days=3`,
      ),
      fetchT(
        `https://weatheralerts.googleapis.com/v1/alerts?key=${apiKey}&location.latitude=${HOME_LAT}&location.longitude=${HOME_LNG}`,
      ),
    ]);

    const [aqData, pollenData, alertsData] = await Promise.all([
      aqRes.json().catch(() => ({})),
      pollenRes.json().catch(() => ({})),
      alertsRes.json().catch(() => ({})),
    ]);

    const aqi = aqData.indexes?.find(
      (i: any) => i.code === "usa_epa" || i.code === "uaqi",
    );

    let pollen: any[] = [];
    let pollenForecast: any[] = [];
    if (pollenData.dailyInfo && Array.isArray(pollenData.dailyInfo)) {
      if (pollenData.dailyInfo.length > 0) {
        const todayPollen = pollenData.dailyInfo[0];
        pollen = (todayPollen.pollenTypeInfo || []).map((p: any) => ({
          type: p.displayName,
          index: p.indexInfo?.value ?? null,
          category: p.indexInfo?.category ?? "Unknown",
          description: p.indexInfo?.indexDescription ?? null,
        }));
      }

      pollenForecast = pollenData.dailyInfo.map((day: any) => ({
        date: day.date ? `${day.date.year}-${String(day.date.month).padStart(2, '0')}-${String(day.date.day).padStart(2, '0')}` : null,
        types: (day.pollenTypeInfo || []).map((p: any) => ({
          type: p.displayName,
          index: p.indexInfo?.value ?? null,
          category: p.indexInfo?.category ?? "Unknown",
        })),
      }));
    }

    let weatherAlerts: any[] = [];
    if (alertsData.weatherAlerts && Array.isArray(alertsData.weatherAlerts)) {
      weatherAlerts = alertsData.weatherAlerts.map((a: any) => ({
        id: a.alertId,
        title: a.alertTitle?.text ?? "Weather Alert",
        eventType: a.eventType ?? null,
        severity: a.severity ?? null,
        urgency: a.urgency ?? null,
        certainty: a.certainty ?? null,
        description: a.description?.text ?? null,
        instruction: a.instruction?.text ?? null,
        senderName: a.dataSource?.name ?? null,
        effectiveTime: a.effectiveTime ?? null,
        expireTime: a.expireTime ?? null,
      }));
    }

    return res.json({
      airQuality: aqi
        ? {
            aqi: aqi.aqi,
            category: aqi.category,
            displayName: aqi.displayName,
            dominantPollutant: aqi.dominantPollutant,
            color: aqi.color,
          }
        : null,
      pollen,
      pollenForecast,
      weatherAlerts,
      healthRecommendations: aqData.healthRecommendations || null,
    });
  } catch (err) {
    console.error("Environment proxy error:", err);
    return res
      .status(500)
      .json({ error: "Failed to fetch environment data" });
  }
}

router.get("/environment", handleEnvironment);
router.post("/environment", handleEnvironment);

export default router;
