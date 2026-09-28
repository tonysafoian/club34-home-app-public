/**
 * _shared/tools/calendar-maps.ts
 *
 * Calendar (get/create/delete events, availability), directions, places,
 * environment data, and news search tool executors.
 *
 * Extracted from janus-chat/index.ts to reduce monolith size.
 */

// ─── Internal helpers ─────────────────────────────────────────────────────────

type CalendarAttendee = { email?: string; self?: boolean; responseStatus?: string };
type CalendarEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  attendees?: CalendarAttendee[];
};
type CalendarProxyResponse = {
  success?: boolean;
  error?: string;
  calendars?: { id: string; selected?: boolean }[];
  events?: CalendarEvent[];
  availability?: Record<string, { busy?: { start?: string; end?: string }[]; errors?: unknown[] } | undefined>;
  htmlLink?: string;
  event?: { htmlLink?: string; id?: string };
};

async function callCalendarProxy(body: Record<string, unknown>): Promise<CalendarProxyResponse> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${supabaseUrl}/functions/v1/google-calendar-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceRoleKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log("calendar-proxy response:", JSON.stringify(data));
  return data;
}

/**
 * Normalize a datetime string to Pacific Time.
 * - Strips trailing 'Z' (UTC) and converts to Pacific offset.
 * - If no timezone offset is present, appends the current Pacific offset.
 * - Leaves date-only strings (no 'T') untouched.
 */
function normalizeToPacific(dt: string): string {
  if (!dt || !dt.includes("T")) return dt;

  const laFormatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "shortOffset" });
  const parts = laFormatter.formatToParts(new Date());
  const tzPart = parts.find(p => p.type === "timeZoneName");
  let pacificOffset = "-08:00";
  if (tzPart?.value) {
    const match = tzPart.value.match(/GMT([+-]?\d+)/);
    if (match) {
      const hours = parseInt(match[1], 10);
      pacificOffset = `${hours <= 0 ? "-" : "+"}${String(Math.abs(hours)).padStart(2, "0")}:00`;
    }
  }

  if (dt.endsWith("Z") || dt.endsWith("z")) {
    const utcDate = new Date(dt);
    if (!isNaN(utcDate.getTime())) {
      const laTime = new Date(utcDate.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const year = laTime.getFullYear();
      const month = String(laTime.getMonth() + 1).padStart(2, "0");
      const day = String(laTime.getDate()).padStart(2, "0");
      const hours = String(laTime.getHours()).padStart(2, "0");
      const minutes = String(laTime.getMinutes()).padStart(2, "0");
      const seconds = String(laTime.getSeconds()).padStart(2, "0");
      const result = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${pacificOffset}`;
      console.log(`[Time Normalize] UTC "${dt}" → Pacific "${result}"`);
      return result;
    }
  }

  const hasOffset = /[+-]\d{2}:\d{2}$/.test(dt) || /[+-]\d{4}$/.test(dt) || dt.endsWith("Z");
  if (!hasOffset) {
    const result = dt + pacificOffset;
    console.log(`[Time Normalize] Naive "${dt}" → Pacific "${result}"`);
    return result;
  }

  return dt;
}

// ─── Calendar Events ──────────────────────────────────────────────────────────

export async function executeGetCalendarEvents(calendarId?: string, timeMin?: string, timeMax?: string, maxResults?: number): Promise<string> {
  try {
    const effectiveCalId = calendarId || "tony@household.local";
    const timeMinVal = timeMin || new Date().toISOString();
    const timeMaxVal = timeMax || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const perCalMax = Math.min(maxResults || 25, 50);

    const isTonyDefault = !calendarId || effectiveCalId === "tony@household.local";
    let calendarIds: string[] = [effectiveCalId];

    if (isTonyDefault) {
      try {
        const listData = await callCalendarProxy({ action: "list-calendars", calendarId: effectiveCalId });
        if (listData.success && Array.isArray(listData.calendars)) {
          const visibleCals = listData.calendars
            .filter((c) => c.selected !== false)
            .map((c) => c.id);
          if (visibleCals.length > 0) calendarIds = visibleCals;
        }
      } catch (listErr) {
        console.error("Failed to list calendars, falling back to primary:", listErr);
      }
    }

    const allResults = await Promise.allSettled(
      calendarIds.map(async (cId: string) => {
        const data = await callCalendarProxy({
          action: "list-events",
          calendarId: cId,
          timeMin: timeMinVal,
          timeMax: timeMaxVal,
          maxResults: perCalMax,
        });
        if (!data.success) return [];
        return (data.events || []).map((e) => {
          const myAttendee = e.attendees?.find(
            (a) => a.email?.toLowerCase() === "tony@household.local" || a.self === true
          );
          const myStatus = myAttendee?.responseStatus || "accepted";
          if (myStatus === "declined") return null;
          return {
            id: e.id,
            title: e.summary || "(No title)",
            start: e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date,
            location: e.location || null,
            description: e.description ? e.description.slice(0, 200) : null,
            status: myStatus,
            attendees: e.attendees?.map((a) => a.email) || [],
            calendar: cId,
          };
        }).filter(Boolean);
      })
    );

    type EventSummary = { id: string; start?: string; [key: string]: unknown };
    const seen = new Set<string>();
    const events: EventSummary[] = [];
    for (const r of allResults) {
      if (r.status === "fulfilled") {
        for (const ev of r.value as EventSummary[]) {
          if (!seen.has(ev.id)) {
            seen.add(ev.id);
            events.push(ev);
          }
        }
      }
    }
    events.sort((a, b) => (a.start || "").localeCompare(b.start || ""));

    return JSON.stringify({ count: events.length, calendars_checked: calendarIds.length, events });
  } catch (e) {
    console.error("executeGetCalendarEvents error:", e);
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeCreateCalendarEvent(calendarId?: string, title?: string, start?: string, end?: string, description?: string, location?: string, attendees?: string[]): Promise<string> {
  try {
    const effectiveCalId = calendarId || "tony@household.local";

    const normalizedStart = start ? normalizeToPacific(start) : start;
    const normalizedEnd = end ? normalizeToPacific(end) : end;

    // Hardcoded conflict guard: ALWAYS check Tony's availability before creating
    const TONY_EMAIL = "tony@household.local";
    const isTonysCalendar = effectiveCalId.toLowerCase() === TONY_EMAIL;
    const involvesTony = isTonysCalendar || (attendees || []).some(a => a.toLowerCase() === TONY_EMAIL);

    if (involvesTony && normalizedStart && normalizedEnd) {
      try {
        const availData = await callCalendarProxy({
          action: "check-availability",
          emails: [TONY_EMAIL],
          timeMin: normalizedStart,
          timeMax: normalizedEnd,
        });
        if (availData.success && availData.availability) {
          const tonyBusy = availData.availability[TONY_EMAIL] || availData.availability[Object.keys(availData.availability)[0]];
          if (Array.isArray(tonyBusy) && tonyBusy.length > 0) {
            const conflicts = tonyBusy.map((b) => `${b.start} – ${b.end}`).join(", ");
            return JSON.stringify({
              success: false,
              blocked_by_conflict: true,
              conflicts: tonyBusy,
              message: `CANNOT CREATE EVENT: Tony has ${tonyBusy.length} conflict(s) during this time: ${conflicts}. You MUST find alternative times. Use check_availability to find open slots, then present 2-3 options to Tony.`,
            });
          }
        }
      } catch (availErr) {
        console.error("Conflict check failed (proceeding with caution):", availErr);
      }
    }

    const data = await callCalendarProxy({
      action: "create-event",
      calendarId: effectiveCalId,
      title,
      start: normalizedStart,
      end: normalizedEnd,
      description,
      location,
      attendees,
    });
    if (!data.success) return `Failed to create event: ${data.error || "unknown"}`;
    const link = data.htmlLink || data.event?.htmlLink || null;
    return JSON.stringify({
      success: true,
      title,
      calendarId: effectiveCalId,
      start: normalizedStart,
      end: normalizedEnd,
      htmlLink: link,
      eventId: data.event?.id || null,
      confirmation: `Event "${title}" created on ${effectiveCalId} for ${normalizedStart}.${link ? ` Google Calendar link: ${link}` : ""}`,
    });
  } catch (e) {
    console.error("executeCreateCalendarEvent error:", e);
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeDeleteCalendarEvent(calendarId?: string, eventId?: string): Promise<string> {
  try {
    if (!eventId) return "Error: event_id is required.";
    const effectiveCalId = calendarId || "tony@household.local";
    const data = await callCalendarProxy({ action: "delete-event", calendarId: effectiveCalId, eventId });
    if (!data.success) return `Failed to delete event: ${data.error || "unknown"}`;
    return JSON.stringify({ success: true, eventId, calendarId: effectiveCalId, confirmation: `Event ${eventId} deleted from ${effectiveCalId}.` });
  } catch (e) {
    console.error("executeDeleteCalendarEvent error:", e);
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

export async function executeCheckAvailability(emails: string[], timeMin: string, timeMax: string): Promise<string> {
  try {
    const data = await callCalendarProxy({ action: "check-availability", emails, timeMin, timeMax });
    if (!data.success) return `Availability check error: ${data.error}`;

    const annotated: Record<string, { busy: unknown[]; errors?: unknown[]; visibility: string; note: string }> = {};
    for (const [email, calData] of Object.entries(data.availability || {})) {
      const isInternal = email.toLowerCase().endsWith("@household.local");
      const busy = calData?.busy || [];
      const errors = calData?.errors || [];
      const hasErrors = errors.length > 0;

      if (isInternal) {
        annotated[email] = { busy, visibility: "full", note: "Internal @household.local calendar — full visibility via domain delegation." };
      } else if (hasErrors || busy.length === 0) {
        annotated[email] = { busy, errors, visibility: "none", note: `EXTERNAL CONTACT — calendar is NOT shared with us. Empty busy blocks does NOT mean they are free. You CANNOT determine their availability. You MUST ask them directly for their available times. Do NOT claim they are 'free' or have 'open availability'.` };
      } else {
        annotated[email] = { busy, visibility: "partial", note: "External contact with partial calendar sharing. Busy blocks shown, but there may be additional commitments not visible to us." };
      }
    }
    return JSON.stringify(annotated);
  } catch (e) {
    console.error("executeCheckAvailability error:", e);
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

// ─── Google Maps ──────────────────────────────────────────────────────────────

export async function executeGetDirections(destination: string, origin?: string, mode?: string): Promise<string> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!apiKey) return "Google Maps API key not configured.";
  try {
    const from = origin || process.env.HOME_ADDRESS || "Home";
    const params = new URLSearchParams({ origins: from, destinations: destination, mode: mode || "driving", departure_time: "now", key: apiKey });
    const res = await fetch(`https://maps.googleapis.com/maps/api/distancematrix/json?${params}`);
    const data = await res.json();
    if (data.status !== "OK") return `Directions error: ${data.status}`;
    const element = data.rows?.[0]?.elements?.[0];
    if (element?.status !== "OK") return `No route found to "${destination}".`;
    const duration = element.duration_in_traffic?.text || element.duration?.text || "unknown";
    const distance = element.distance?.text || "unknown";
    return JSON.stringify({ from, to: destination, mode: mode || "driving", duration, distance, destination_address: data.destination_addresses?.[0] || destination });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeSearchPlaces(query: string, near?: string, type?: string): Promise<string> {
  const apiKey = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!apiKey) return "Google Maps API key not configured.";
  try {
    const searchQuery = `${query} near ${near || "Beverly Hills, CA"}`;
    const params = new URLSearchParams({ query: searchQuery, key: apiKey });
    if (type) params.set("type", type);
    const res = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`);
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return `Places error: ${data.status}`;
    type PlaceResult = {
      name?: string;
      formatted_address?: string;
      rating?: number;
      user_ratings_total?: number;
      types?: string[];
      place_id?: string;
      opening_hours?: { open_now?: boolean };
    };
    const places = (data.results || []).slice(0, 5).map((p: PlaceResult) => ({
      name: p.name,
      address: p.formatted_address,
      rating: p.rating || null,
      user_ratings_total: p.user_ratings_total || 0,
      types: p.types?.slice(0, 3) || [],
      maps_url: `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
      open_now: p.opening_hours?.open_now ?? null,
    }));
    return JSON.stringify({ count: places.length, query, places });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

// ─── Environment & News ───────────────────────────────────────────────────────

export async function executeGetEnvironmentData(): Promise<string> {
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return "Environment proxy not configured.";
    const res = await fetch(`${SUPABASE_URL}/functions/v1/google-environment-proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) return `Environment data error: ${data.error || res.status}`;
    return JSON.stringify(data);
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeSearchNews(query: string, period?: string): Promise<string> {
  const apiKey = Deno.env.get("FIRECRAWL_API_KEY");
  if (!apiKey) return "Firecrawl API key not configured.";
  const tbsMap: Record<string, string> = { hour: "qdr:h", day: "qdr:d", week: "qdr:w", month: "qdr:m" };
  const tbs = tbsMap[period || "day"] || "qdr:d";
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit: 8, tbs }),
    });
    const data = await res.json();
    if (!res.ok) return `News search failed: ${data.error || res.status}`;
    const results = (data.data || []).map((r: { title?: string; url?: string; description?: string }) => ({
      title: r.title || "Untitled",
      url: r.url || "",
      source: r.url ? new URL(r.url).hostname.replace("www.", "") : "",
      description: r.description || "",
    }));
    return JSON.stringify({ count: results.length, period: period || "day", query, results });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}
