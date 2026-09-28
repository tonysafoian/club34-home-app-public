import { Router, type Request, type Response } from "express";
import { createClient } from "../utils/supabase.js";
import {
  getServiceToken,
  getSaKey,
  getGoogleTokenFromEnv,
  fetchT,
  logAudit,
  sendWhatsApp,
  getAlertPhoneNumber,
  getServiceClient,
  base64url,
  TONY_EMAIL,
  JANUS_EMAIL,
  type ServiceAccountKey,
} from "../lib/helpers.js";

const router = Router();

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_AUTH_BASE = "https://fleet-auth.prd.vn.cloud.tesla.com";
const BEASTX_DISPLAY_NAME = "BeastX";

interface CalendarEvent {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
}

interface Conflict {
  type: "overlap" | "back-to-back" | "triple-booked";
  events: CalendarEvent[];
  description: string;
  fingerprint: string;
}

async function fetchCalendarEventsForDays(
  saKey: ServiceAccountKey,
  days: number,
): Promise<CalendarEvent[]> {
  const token = await getServiceToken(
    saKey,
    "https://www.googleapis.com/auth/calendar.readonly",
    TONY_EMAIL,
  );
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetchT(
    `${CALENDAR_BASE}/calendars/${TONY_EMAIL}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Calendar fetch failed: ${res.status}`);
  const data = await res.json();

  return (data.items || [])
    .filter((e: any) => e.start?.dateTime)
    .map((e: any) => ({
      id: e.id,
      summary: e.summary || "Untitled",
      start: new Date(e.start.dateTime),
      end: new Date(e.end.dateTime),
      allDay: false,
    }));
}

function detectConflicts(events: CalendarEvent[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const sorted = [...events].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.start >= a.end) break;

      const fp = [a.id, b.id].sort().join("|");
      if (!conflicts.find((c) => c.fingerprint === fp)) {
        conflicts.push({
          type: "overlap",
          events: [a, b],
          description: `"${a.summary}" and "${b.summary}" overlap`,
          fingerprint: fp,
        });
      }
    }

    if (i < sorted.length - 1) {
      const gap =
        sorted[i + 1].start.getTime() - sorted[i].end.getTime();
      if (gap >= 0 && gap < 5 * 60 * 1000) {
        const fp = `b2b|${sorted[i].id}|${sorted[i + 1].id}`;
        conflicts.push({
          type: "back-to-back",
          events: [sorted[i], sorted[i + 1]],
          description: `"${sorted[i].summary}" → "${sorted[i + 1].summary}" (${Math.round(gap / 60000)}m gap)`,
          fingerprint: fp,
        });
      }
    }
  }

  return conflicts;
}

router.post("/conflicts", async (_req: Request, res: Response) => {
  const t0 = Date.now();
  try {
    const saKey = getSaKey();
    const svc = getServiceClient();
    const events = await fetchCalendarEventsForDays(saKey, 7);
    const allConflicts = detectConflicts(events);

    const { data: existingLogs } = await svc
      .from("system_audit_log")
      .select("summary")
      .eq("edge_function", "calendar-conflict-detection")
      .gte(
        "created_at",
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      );

    const existingSummaries = new Set(
      (existingLogs || []).map((l: any) => l.summary),
    );

    const newConflicts = allConflicts.filter(
      (c) => !existingSummaries.has(c.description),
    );

    let waCount = 0;
    for (const conflict of newConflicts) {
      const emoji =
        conflict.type === "overlap"
          ? "⚠️"
          : conflict.type === "triple-booked"
            ? "🚨"
            : "⏰";
      await sendWhatsApp(`${emoji} Calendar: ${conflict.description}`);
      waCount++;
    }

    logAudit("calendar-conflict-detection", {
      category: "automation",
      event_type: "calendar_conflict_detection",
      severity: newConflicts.length > 0 ? "info" : "info",
      actor_id: "system",
      actor_name: "Janus",
      channel: "cron",
      summary: `Scanned ${events.length} events, found ${allConflicts.length} total conflicts (${newConflicts.length} new). WA sent: ${waCount}.`,
      status: "success",
      duration_ms: Date.now() - t0,
    });

    return res.json({
      ok: true,
      events_scanned: events.length,
      total_conflicts: allConflicts.length,
      new_conflicts: newConflicts.length,
      whatsapp_sent: waCount,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    logAudit("calendar-conflict-detection", {
      category: "automation",
      event_type: "calendar_conflict_detection",
      severity: "error",
      actor_id: "system",
      actor_name: "Janus",
      channel: "cron",
      summary: `Calendar conflict detection error: ${msg.slice(0, 100)}`,
      status: "error",
      duration_ms: Date.now() - t0,
    });
    return res.status(500).json({ ok: false, error: msg });
  }
});

async function refreshTeslaToken(
  serviceClient: any,
  tokenRow: any,
): Promise<string> {
  const expiresAt = new Date(tokenRow.token_expires_at);
  if (expiresAt.getTime() - Date.now() > 5 * 60 * 1000)
    return tokenRow.access_token;

  const clientId = process.env.TESLA_CLIENT_ID!;
  const clientSecret = process.env.TESLA_CLIENT_SECRET!;
  const res = await fetch(`${TESLA_AUTH_BASE}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokenRow.refresh_token,
    }),
  });
  if (!res.ok) throw new Error("Failed to refresh Tesla token");
  const data = await res.json();
  await serviceClient
    .from("tesla_tokens")
    .update({
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokenRow.refresh_token,
      token_expires_at: new Date(
        Date.now() + data.expires_in * 1000,
      ).toISOString(),
    })
    .eq("user_id", tokenRow.user_id);
  return data.access_token;
}

router.post("/nav-tesla", async (req: Request, res: Response) => {
  const t0 = Date.now();
  const isDryRun = req.query.test === "true";

  // Dry-run requires a valid cron secret to prevent leaking sensitive calendar/location PII
  if (isDryRun) {
    const cronSecret = process.env.CRON_SECRET;
    const providedSecret = req.headers["x-cron-secret"];
    if (!cronSecret || providedSecret !== cronSecret) {
      return res.status(401).json({ ok: false, error: "Unauthorized: x-cron-secret required for dry-run mode" });
    }
  }
  try {
    const saKey = getSaKey();
    const svc = getServiceClient();

    const calToken = await getServiceToken(
      saKey,
      "https://www.googleapis.com/auth/calendar.readonly",
      TONY_EMAIL,
    );

    const now = new Date();
    let timeMin: Date;
    let timeMax: Date;

    if (isDryRun) {
      // Dry-run: widen to full day (start of today to end of today)
      timeMin = new Date(now);
      timeMin.setHours(0, 0, 0, 0);
      timeMax = new Date(now);
      timeMax.setHours(23, 59, 59, 999);
    } else {
      // Normal: query from now to 30 min ahead (eligible acts on 10-30 min window)
      timeMin = new Date(now.getTime());
      timeMax = new Date(now.getTime() + 30 * 60 * 1000);
    }

    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: isDryRun ? "250" : "20",
    });

    const calRes = await fetchT(
      `${CALENDAR_BASE}/calendars/${TONY_EMAIL}/events?${params}`,
      { headers: { Authorization: `Bearer ${calToken}` } },
    );
    if (!calRes.ok) throw new Error(`Calendar fetch: ${calRes.status}`);
    const calData = await calRes.json();

    const allItems: any[] = calData.items || [];
    const totalFetched = allItems.length;

    console.log(
      `[calendar-nav-tesla] Fetched ${totalFetched} total events from Google Calendar` +
        (isDryRun ? " (dry-run, full day)" : ` (window: now to +30 min)`),
    );
    if (totalFetched > 0) {
      console.log(
        `[calendar-nav-tesla] Event summaries: ${allItems.map((e: any) => `"${e.summary || "(no title)"}" [has location: ${!!e.location}]`).join(", ")}`,
      );
    }

    // Dry-run: return diagnostic info without sending nav
    if (isDryRun) {
      const dryRunEvents = allItems.map((e: any) => ({
        id: e.id,
        summary: e.summary || "(no title)",
        start: e.start?.dateTime || e.start?.date,
        location: e.location || null,
        hasLocation: !!e.location,
        hasDateTime: !!e.start?.dateTime,
      }));
      return res.json({
        ok: true,
        dry_run: true,
        total_events: totalFetched,
        events_with_location: dryRunEvents.filter((e) => e.hasLocation).length,
        events: dryRunEvents,
        duration_ms: Date.now() - t0,
      });
    }

    const eventsWithLocation = allItems.filter(
      (e: any) => e.location && e.start?.dateTime,
    );

    console.log(
      `[calendar-nav-tesla] ${eventsWithLocation.length} of ${totalFetched} events have a location field`,
    );

    if (totalFetched > 0 && eventsWithLocation.length === 0) {
      console.log(
        `[calendar-nav-tesla] Found ${totalFetched} events but none had a location field — skipping nav`,
      );
      logAudit("calendar-nav-tesla", {
        category: "automation",
        event_type: "calendar_nav_run",
        severity: "info",
        actor_id: "system",
        actor_name: "Janus",
        channel: "cron",
        summary: `Found ${totalFetched} events but none had a location field`,
        status: "success",
        duration_ms: Date.now() - t0,
        detail: {
          total_events: totalFetched,
          events_with_location: 0,
          event_summaries: allItems.map((e: any) => e.summary || "(no title)"),
        },
      });
      return res.json({
        ok: true,
        total_events: totalFetched,
        events_with_location: 0,
        nav_sent: 0,
        duration_ms: Date.now() - t0,
      });
    }

    // Filter to events starting in 10–30 minutes ahead
    const eligibleEvents = eventsWithLocation.filter((e: any) => {
      const startsIn =
        (new Date(e.start.dateTime).getTime() - now.getTime()) / 60000;
      return startsIn >= 10 && startsIn <= 30;
    });

    console.log(
      `[calendar-nav-tesla] ${eligibleEvents.length} of ${eventsWithLocation.length} location-events are in the 10–30 min eligible window`,
    );

    let navSent = 0;

    for (const event of eligibleEvents) {
      const eventId = event.id;
      const since = new Date();
      since.setHours(since.getHours() - 2);
      const { data: dedupRows } = await svc
        .from("system_audit_log")
        .select("detail")
        .eq("edge_function", "calendar-nav-tesla")
        .eq("event_type", "nav_sent")
        .gte("created_at", since.toISOString())
        .limit(100);

      const alreadySent = (dedupRows || []).some(
        (r: any) => r.detail?.event_id === eventId,
      );
      if (alreadySent) continue;

      const { data: tokenRow } = await svc
        .from("tesla_tokens")
        .select("*")
        .limit(1)
        .single();

      if (!tokenRow) {
        console.error("No Tesla tokens found");
        continue;
      }

      const teslaToken = await refreshTeslaToken(svc, tokenRow);

      const { data: vehicles } = await svc
        .from("tesla_vehicles")
        .select("*")
        .ilike("display_name", `%${BEASTX_DISPLAY_NAME}%`)
        .limit(1)
        .single();

      const vin = vehicles?.vin || tokenRow.vin;
      if (!vin) continue;

      try {
        await fetchT(
          `${TESLA_API_BASE}/api/1/vehicles/${vin}/wake_up`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${teslaToken}` },
          },
          15_000,
        );
        await new Promise((r) => setTimeout(r, 5000));
      } catch (_) {}

      const navRes = await fetchT(
        `${TESLA_API_BASE}/api/1/vehicles/${vin}/command/navigation_request`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${teslaToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "share_ext_content_raw",
            value: { "android.intent.extra.TEXT": event.location },
            locale: "en-US",
            timestamp_ms: String(Date.now()),
          }),
        },
        15_000,
      );

      const navResult = await navRes.json();
      if (navRes.ok && navResult.response?.result) {
        navSent++;
        const timeStr = new Date(event.start.dateTime).toLocaleTimeString(
          "en-US",
          {
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/Los_Angeles",
          },
        );
        logAudit("calendar-nav-tesla", {
          category: "automation",
          event_type: "nav_sent",
          severity: "info",
          actor_id: "system",
          actor_name: "Janus",
          channel: "cron",
          summary: `Navigation to "${event.location}" sent to ${BEASTX_DISPLAY_NAME}`,
          status: "success",
          detail: { event_id: eventId, location: event.location },
        });
        await sendWhatsApp(
          `📍 Navigation to *${event.location}* sent to ${BEASTX_DISPLAY_NAME} for "${event.summary}" at ${timeStr}`,
        );
      }
    }

    logAudit("calendar-nav-tesla", {
      category: "automation",
      event_type: "calendar_nav_run",
      severity: "info",
      actor_id: "system",
      actor_name: "Janus",
      channel: "cron",
      summary: `Scanned calendar: ${totalFetched} total events, ${eventsWithLocation.length} with locations, ${eligibleEvents.length} eligible (10-30 min), ${navSent} nav commands sent`,
      status: "success",
      duration_ms: Date.now() - t0,
      detail: {
        total_events: totalFetched,
        events_with_location: eventsWithLocation.length,
        events_eligible: eligibleEvents.length,
        nav_sent: navSent,
        event_summaries: allItems.map((e: any) => e.summary || "(no title)"),
      },
    });

    return res.json({
      ok: true,
      total_events: totalFetched,
      events_with_location: eventsWithLocation.length,
      events_eligible: eligibleEvents.length,
      nav_sent: navSent,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    logAudit("calendar-nav-tesla", {
      category: "automation",
      event_type: "calendar_nav_run",
      severity: "error",
      actor_id: "system",
      actor_name: "Janus",
      channel: "cron",
      summary: `Calendar nav error: ${msg.slice(0, 100)}`,
      status: "error",
      duration_ms: Date.now() - t0,
    });
    return res.status(500).json({ ok: false, error: msg });
  }
});

function currentSchoolYear(): string {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();
  if (month >= 8) return `${year}-${year + 1}`;
  return `${year - 1}-${year}`;
}

router.post("/hw-sync", async (req: Request, res: Response) => {
  try {
    const supabase = getServiceClient();
    let advanceGrades = false;
    let requestedYear: string | null = null;
    if (req.body) {
      advanceGrades = req.body.advance_grades === true;
      requestedYear = req.body.school_year || null;
    }

    const schoolYear = requestedYear || currentSchoolYear();

    if (advanceGrades) {
      const { data: currentConfigs } = await supabase
        .from("hw_calendar_config")
        .select("*")
        .eq("school_year", schoolYear);

      if (currentConfigs && currentConfigs.length > 0) {
        const [startYear] = schoolYear.split("-").map(Number);
        const nextYear = `${startYear + 1}-${startYear + 2}`;
        for (const config of currentConfigs) {
          const newGrade = config.grade + 1;
          await supabase.from("hw_calendar_config").upsert(
            {
              child_name: config.child_name,
              email: config.email,
              grade: newGrade,
              campus: newGrade >= 10 ? "upper" : "lower",
              school_year: nextYear,
            },
            { onConflict: "email,school_year" },
          );
        }
      }
    }

    const { data: children } = await supabase
      .from("hw_calendar_config")
      .select("*")
      .eq("school_year", schoolYear);

    if (!children || children.length === 0) {
      return res.json({
        success: true,
        school_year: schoolYear,
        results: {},
        message: "No children configured",
      });
    }

    const { data: calendarRows } = await supabase
      .from("hw_school_calendars")
      .select("campus, events")
      .eq("school_year", schoolYear);

    if (!calendarRows || calendarRows.length === 0) {
      return res.json({
        success: true,
        school_year: schoolYear,
        results: {},
        message: "No calendar data",
      });
    }

    const results: Record<string, any> = {};

    for (const child of children) {
      const division = child.grade <= 9 ? "MS" : "US";
      const campus = child.grade >= 10 ? "upper" : "lower";

      const campusRow = calendarRows.find(
        (r: any) => r.campus === campus,
      );
      if (!campusRow) {
        results[child.child_name] = { created: 0, skipped: 0, errors: ["No calendar for campus"] };
        continue;
      }

      const googleToken = await getGoogleTokenFromEnv(
        "https://www.googleapis.com/auth/calendar",
        child.email,
      );

      const [startYear] = schoolYear.split("-").map(Number);
      const searchParams = new URLSearchParams({
        q: "[Harvard-Westlake]",
        timeMin: `${startYear}-08-01T00:00:00Z`,
        timeMax: `${startYear + 1}-07-01T00:00:00Z`,
        singleEvents: "true",
        maxResults: "250",
      });

      const existingResp = await fetch(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(child.email)}/events?${searchParams}`,
        { headers: { Authorization: `Bearer ${googleToken}` } },
      );
      const existingData = existingResp.ok ? await existingResp.json() : { items: [] };
      const existing = new Set(
        (existingData.items || []).map(
          (e: any) =>
            `${e.summary}||${e.start?.date || e.start?.dateTime?.split("T")[0]}`,
        ),
      );

      const campusEvents = (campusRow.events as any[]).filter(
        (e: any) =>
          e.divisions.includes(division) ||
          (e.divisions.includes("MS") && e.divisions.includes("US")),
      );

      let created = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const event of campusEvents) {
        const key = `${event.title}||${event.startDate}`;
        if (existing.has(key)) {
          skipped++;
          continue;
        }

        const eventBody = {
          summary: event.title,
          start: { date: event.startDate },
          end: { date: event.endDate },
          description: "[Harvard-Westlake] School Calendar",
          transparency: "transparent",
        };

        const createResp = await fetch(
          `${CALENDAR_BASE}/calendars/${encodeURIComponent(child.email)}/events`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${googleToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(eventBody),
          },
        );

        if (createResp.ok) {
          await createResp.json();
          created++;
        } else {
          errors.push(`${event.title}: ${await createResp.text()}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      await supabase
        .from("hw_calendar_config")
        .update({ synced_at: new Date().toISOString() })
        .eq("email", child.email)
        .eq("school_year", schoolYear);

      results[child.child_name] = { created, skipped, errors };
    }

    const { data: automation } = await supabase
      .from("family_automations")
      .select("id")
      .eq("name", "Getting Girls to School on Time")
      .single();

    if (automation) {
      await supabase.from("family_automation_logs").insert({
        automation_id: automation.id,
        status: "success",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        output: { school_year: schoolYear, results },
      });
      await supabase
        .from("family_automations")
        .update({ last_run_at: new Date().toISOString() })
        .eq("id", automation.id);
    }

    return res.json({ success: true, school_year: schoolYear, results });
  } catch (error) {
    console.error("HW Calendar Sync error:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
