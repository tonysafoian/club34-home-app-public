export async function callCalendarProxy(body: Record<string, unknown>): Promise<any> {
  const { getServiceAccountToken } = await import("../../routes/google.js");
  const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

  try {
    const calendarId = (body.calendarId as string) || process.env.PRIMARY_CALENDAR_ID || "primary";
    const { token: googleToken, error: tokenError } = await getServiceAccountToken(calendarId);
    if (tokenError || !googleToken) {
      console.error(`[calendar-proxy] Token error: ${tokenError}`);
      return { success: false, error: tokenError || "No Google token" };
    }

    const googleHeaders = {
      Authorization: `Bearer ${googleToken}`,
      "Content-Type": "application/json",
    };

    if (body.action === "list-calendars") {
      const resp = await fetch(`${CALENDAR_BASE}/users/me/calendarList`, { headers: googleHeaders });
      const data = await resp.json();
      if (!resp.ok) return { success: false, error: (data as any).error?.message || `Google API error ${resp.status}` };
      return { success: true, calendars: (data as any).items || [] };
    }

    if (body.action === "list-events") {
      const cId = calendarId || "primary";
      const params = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(body.maxResults || 250),
      });
      if (body.timeMin) params.set("timeMin", body.timeMin as string);
      if (body.timeMax) params.set("timeMax", body.timeMax as string);
      const resp = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events?${params}`, { headers: googleHeaders });
      const data = await resp.json();
      if (!resp.ok) return { success: false, error: (data as any).error?.message || `Google API error ${resp.status}` };
      return { success: true, events: (data as any).items || [] };
    }

    if (body.action === "create-event") {
      const cId = calendarId;
      const event: Record<string, unknown> = {
        summary: body.title,
        start: (body.start as string)?.includes("T")
          ? { dateTime: body.start, timeZone: "America/Los_Angeles" }
          : { date: body.start },
        end: (body.end as string)?.includes("T")
          ? { dateTime: body.end, timeZone: "America/Los_Angeles" }
          : { date: body.end },
      };
      if (body.description) event.description = body.description;
      if (body.location) event.location = body.location;
      if (Array.isArray(body.attendees)) event.attendees = (body.attendees as string[]).map((e: string) => ({ email: e }));
      const resp = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events`, {
        method: "POST",
        headers: googleHeaders,
        body: JSON.stringify(event),
      });
      const data = await resp.json();
      if (!resp.ok) return { success: false, error: (data as any).error?.message || `Google API error ${resp.status}` };
      return { success: true, event: data, htmlLink: (data as any).htmlLink };
    }

    if (body.action === "delete-event") {
      const cId = calendarId;
      if (!body.eventId) return { success: false, error: "eventId is required" };
      const resp = await fetch(`${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events/${encodeURIComponent(body.eventId as string)}`, {
        method: "DELETE",
        headers: googleHeaders,
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        return { success: false, error: (data as any).error?.message || `Google API error ${resp.status}` };
      }
      return { success: true };
    }

    if (body.action === "update-event") {
      const cId = calendarId;
      if (!body.eventId) return { success: false, error: "eventId is required" };
      const patch: Record<string, unknown> = {};
      if (typeof body.title === "string") patch.summary = body.title;
      if (typeof body.description === "string") patch.description = body.description;
      if (typeof body.location === "string") patch.location = body.location;
      if (body.start) {
        patch.start = (body.start as string).includes("T")
          ? { dateTime: body.start, timeZone: "America/Los_Angeles" }
          : { date: body.start };
      }
      if (body.end) {
        patch.end = (body.end as string).includes("T")
          ? { dateTime: body.end, timeZone: "America/Los_Angeles" }
          : { date: body.end };
      }
      if (Array.isArray(body.attendees) && body.attendees.length) {
        patch.attendees = (body.attendees as string[]).map((e) => ({ email: e }));
      }
      const resp = await fetch(
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(cId)}/events/${encodeURIComponent(body.eventId as string)}`,
        { method: "PATCH", headers: googleHeaders, body: JSON.stringify(patch) },
      );
      const data = await resp.json();
      if (!resp.ok) return { success: false, error: (data as any).error?.message || `Google API error ${resp.status}` };
      return { success: true, event: data, htmlLink: (data as any).htmlLink };
    }

    if (body.action === "check-availability") {
      const emailList = (body.emails as string[]) || [];
      const resp = await fetch(`${CALENDAR_BASE}/freeBusy`, {
        method: "POST",
        headers: googleHeaders,
        body: JSON.stringify({
          timeMin: body.timeMin,
          timeMax: body.timeMax,
          items: emailList.map((e: string) => ({ id: e })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return { success: false, error: (data as any).error?.message || `Google API error ${resp.status}` };
      return { success: true, availability: (data as any).calendars || {} };
    }

    return { success: false, error: `Unknown action: ${body.action}` };
  } catch (e) {
    console.error("[calendar-proxy] Error:", e);
    return { success: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

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

export async function executeGetCalendarEvents(calendarId?: string, timeMin?: string, timeMax?: string, maxResults?: number): Promise<string> {
  try {
    const effectiveCalId = calendarId || process.env.PRIMARY_CALENDAR_ID || "primary";
    const timeMinVal = timeMin || new Date().toISOString();
    const timeMaxVal = timeMax || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const perCalMax = Math.min(maxResults || 25, 50);

    const isTonyDefault = !calendarId || effectiveCalId === process.env.PRIMARY_CALENDAR_ID || "primary";
    let calendarIds: string[] = [effectiveCalId];

    if (isTonyDefault) {
      try {
        const listData = await callCalendarProxy({ action: "list-calendars", calendarId: effectiveCalId });
        if (listData.success && Array.isArray(listData.calendars)) {
          const visibleCals = listData.calendars
            .filter((c: any) => c.selected !== false)
            .map((c: any) => c.id);
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
        return (data.events || []).map((e: any) => {
          const myAttendee = e.attendees?.find(
            (a: any) => a.email?.toLowerCase() === process.env.PRIMARY_CALENDAR_ID || "primary" || a.self === true
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
            attendees: e.attendees?.map((a: any) => a.email) || [],
            calendar: cId,
          };
        }).filter(Boolean);
      })
    );

    const seen = new Set<string>();
    const events: any[] = [];
    for (const r of allResults) {
      if (r.status === "fulfilled") {
        for (const ev of r.value) {
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
    const effectiveCalId = calendarId || process.env.PRIMARY_CALENDAR_ID || "primary";

    const normalizedStart = start ? normalizeToPacific(start) : start;
    const normalizedEnd = end ? normalizeToPacific(end) : end;

    const TONY_EMAIL = process.env.PRIMARY_CALENDAR_ID || "primary";
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
            const conflicts = tonyBusy.map((b: any) => `${b.start} – ${b.end}`).join(", ");
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
    const effectiveCalId = calendarId || process.env.PRIMARY_CALENDAR_ID || "primary";
    const data = await callCalendarProxy({ action: "delete-event", calendarId: effectiveCalId, eventId });
    if (!data.success) return `Failed to delete event: ${data.error || "unknown"}`;
    return JSON.stringify({ success: true, eventId, calendarId: effectiveCalId, confirmation: `Event ${eventId} deleted from ${effectiveCalId}.` });
  } catch (e) {
    console.error("executeDeleteCalendarEvent error:", e);
    return `Error: ${e instanceof Error ? e.message : "unknown"}`;
  }
}

/**
 * Fetch trips from local DB that overlap [timeMin, timeMax] and return
 * busy-block style entries for each household traveler. Used by
 * executeCheckAvailability to ensure Janus never says "free" during a known
 * trip that lives in the trips table but isn't yet on Google Calendar.
 */
async function fetchTripBusyBlocks(
  emails: string[],
  timeMin: string,
  timeMax: string,
): Promise<Record<string, { start: string; end: string; tripName: string; destination?: string | null }[]>> {
  const out: Record<string, { start: string; end: string; tripName: string; destination?: string | null }[]> = {};
  try {
    const { storage } = await import("../../storage.js");
    const allTrips = await storage.getTrips();
    const start = new Date(timeMin).getTime();
    const end = new Date(timeMax).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return out;

    const overlapping = allTrips.filter((t) => {
      if (t.deletedAt) return false;
      if (!t.departureDate || !t.returnDate) return false;
      // All-day trips are end-INCLUSIVE in Notion convention; treat returnDate
      // as the last full day, so push end to end-of-day.
      const trDep = new Date(t.departureDate).getTime();
      const trRet = new Date(t.returnDate).getTime() + 24 * 60 * 60 * 1000 - 1;
      return trDep < end && trRet > start;
    });

    if (!overlapping.length) return out;

    // Match traveler entries (free-form strings) against requested email local-parts.
    const localParts = emails.map((e) => ({
      email: e,
      lp: (e.toLowerCase().split("@")[0] || "").replace(/[._-]/g, ""),
    }));
    const isAffected = (traveler: string, lp: string): boolean => {
      const t = traveler.toLowerCase().replace(/[^a-z]/g, "");
      return t.length > 0 && lp.length > 0 && (t.includes(lp) || lp.includes(t));
    };

    for (const trip of overlapping) {
      const travelers = Array.isArray(trip.travelers) ? trip.travelers : [];
      for (const { email, lp } of localParts) {
        const affected =
          travelers.length === 0 // unspecified travelers → assume Tony (primary cal owner)
            ? email.toLowerCase() === process.env.PRIMARY_CALENDAR_ID || "primary"
            : travelers.some((t) => isAffected(String(t), lp));
        if (!affected) continue;
        if (!out[email]) out[email] = [];
        out[email].push({
          start: new Date(trip.departureDate!).toISOString(),
          end: new Date(new Date(trip.returnDate!).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString(),
          tripName: trip.tripName,
          destination: trip.destination,
        });
      }
    }
  } catch (e) {
    console.error("[calendar-maps] fetchTripBusyBlocks failed:", e);
  }
  return out;
}

export async function executeCheckAvailability(emails: string[], timeMin: string, timeMax: string): Promise<string> {
  try {
    const [data, tripBlocks] = await Promise.all([
      callCalendarProxy({ action: "check-availability", emails, timeMin, timeMax }),
      fetchTripBusyBlocks(emails, timeMin, timeMax),
    ]);
    if (!data.success) return `Availability check error: ${data.error}`;

    const annotated: Record<string, any> = {};
    for (const [email, calData] of Object.entries(data.availability as Record<string, any>)) {
      const isInternal = email.toLowerCase().endsWith("@household.local");
      const busy = [...(calData?.busy || [])];
      const errors = calData?.errors || [];
      const hasErrors = errors.length > 0;

      // Merge in trip blocks from the trips DB (Notion-synced).
      const trips = tripBlocks[email] || [];
      for (const t of trips) {
        busy.push({ start: t.start, end: t.end, source: "trips-db", tripName: t.tripName, destination: t.destination });
      }

      if (isInternal) {
        annotated[email] = {
          busy,
          tripsCount: trips.length,
          visibility: "full",
          note:
            "Internal @household.local calendar — full visibility via domain delegation." +
            (trips.length ? ` Includes ${trips.length} trip(s) from trips DB. Treat trip blocks as fully busy (out of town).` : ""),
        };
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

export async function executeGetDirections(destination: string, origin?: string, mode?: string): Promise<string> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
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
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return "Google Maps API key not configured.";
  try {
    const searchQuery = `${query} near ${near || "Beverly Hills, CA"}`;
    const params = new URLSearchParams({ query: searchQuery, key: apiKey });
    if (type) params.set("type", type);
    const res = await fetch(`https://maps.googleapis.com/maps/api/place/textsearch/json?${params}`);
    const data = await res.json();
    if (data.status !== "OK" && data.status !== "ZERO_RESULTS") return `Places error: ${data.status}`;
    const places = (data.results || []).slice(0, 5).map((p: any) => ({
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

export async function executeGetEnvironmentData(): Promise<string> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return JSON.stringify({ error: "Google Maps API key not configured" });

  const HOME_LAT = 34.0831;
  const HOME_LNG = -118.4104;

  try {
    const [aqRes, pollenRes] = await Promise.all([
      fetch(`https://airquality.googleapis.com/v1/currentConditions:lookup?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: { latitude: HOME_LAT, longitude: HOME_LNG },
          extraComputations: ["HEALTH_RECOMMENDATIONS", "DOMINANT_POLLUTANT_CONCENTRATION", "LOCAL_AQI"],
        }),
      }),
      fetch(`https://pollen.googleapis.com/v1/forecast:lookup?key=${apiKey}&location.latitude=${HOME_LAT}&location.longitude=${HOME_LNG}&days=3`),
    ]);

    const [aqData, pollenData] = await Promise.all([
      aqRes.json().catch(() => ({})),
      pollenRes.json().catch(() => ({})),
    ]);

    const aqi = (aqData as any).indexes?.find((i: any) => i.code === "usa_epa" || i.code === "uaqi");
    const pollenForecast = Array.isArray((pollenData as any).dailyInfo)
      ? (pollenData as any).dailyInfo.map((day: any) => ({
          date: day.date,
          pollenTypes: (day.pollenTypeInfo || []).map((p: any) => ({
            type: p.displayName,
            index: p.indexInfo?.value ?? null,
            category: p.indexInfo?.category ?? "Unknown",
          })),
        }))
      : [];

    return JSON.stringify({
      airQuality: aqi ? { aqi: aqi.aqi, category: aqi.category, displayName: aqi.displayName, dominantPollutant: aqi.dominantPollutant } : null,
      pollenForecast,
      healthRecommendations: (aqData as any).healthRecommendations || null,
    });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}

export async function executeSearchNews(query: string, period?: string): Promise<string> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
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
    const results = (data.data || []).map((r: any) => ({
      title: r.title || "Untitled",
      url: r.url || "",
      source: r.url ? new URL(r.url).hostname.replace("www.", "") : "",
      description: r.description || "",
    }));
    return JSON.stringify({ count: results.length, period: period || "day", query, results });
  } catch (e) { return `Error: ${e instanceof Error ? e.message : "unknown"}`; }
}
