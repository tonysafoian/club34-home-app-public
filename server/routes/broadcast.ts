import { Router, type Request, type Response } from "express";
import { createClient } from "../utils/supabase.js";
import {
  logAudit,
  enqueueFailedJob,
  getServiceClient,
  sendWhatsAppTo,
  getBroadcastFallbackPhone,
  getAlertPhoneNumber,
} from "../lib/helpers.js";
import { generateAndUploadTTS, verifyPlaybackState, detectSilentDropRisk } from "../lib/castBroadcast.js";
import { fetchT } from "../lib/fetchWithTimeout.js";
import {
  canRequest,
  recordSuccess,
  recordFailure,
} from "../lib/circuit-breaker.js";
import { checkRateLimit } from "../lib/rate-limiter.js";
import { sanitizeErrorMessage } from "../lib/error-sanitizer.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { composeSchoolMorningAnnouncement } from "../services/schoolMorningBriefing.js";

const router = Router();

const GIRLS_SPEAKERS = [
  "media_player.emme_s_room_speaker",
  "media_player.isla_s_room_speaker",
  "media_player.tonys_office_speaker",
];

const VOLUME = 0.9;
const JANUS_VOICE_ID = "iLVmqjzCGGvqtMCk6vVQ"; // Janus – English with Italian accent (male)
const DEFAULT_VOICE_ID = "iLVmqjzCGGvqtMCk6vVQ";

// Silent-drop streak alerting: a single school broadcast can report
// `silent_drop_risk` (all speakers loaded the audio but stayed idle at ~8s,
// suggesting Cast silently dropped the sound) while still reporting "success".
// One occurrence is noise; the same flag firing on N consecutive school-morning
// broadcasts is a strong sign a speaker is genuinely broken. When the streak
// crosses the threshold we send a WhatsApp heads-up to the alert phone, with a
// cooldown so a persistent problem doesn't ping the family every morning.
const SILENT_DROP_STREAK_THRESHOLD = 3;
const SILENT_DROP_ALERT_COOLDOWN_HOURS = 72;

/**
 * Detect a recurring silent-drop pattern across the most recent school-morning
 * broadcasts and send a one-off WhatsApp alert when it crosses the threshold.
 *
 * Streak = the most recent consecutive `school_broadcast` audit entries whose
 * `detail.silent_drop_risk === true`. This is called right after the current
 * broadcast's audit entry is written (and only when the current broadcast itself
 * flagged silent_drop_risk), so the latest row is already included.
 *
 * Dedup: we only fire if no `school_broadcast_silent_drop_alert` audit entry was
 * written in the last SILENT_DROP_ALERT_COOLDOWN_HOURS. The alert itself logs
 * such an entry, so a persistent issue re-alerts at most once per cooldown
 * window instead of every morning.
 */
async function maybeAlertSilentDropStreak(
  dateStr: string,
): Promise<{ alerted: boolean; streak: number }> {
  try {
    const { query } = await import("../lib/db.js");

    // Most recent N broadcasts; if ALL are silent-drop, the streak is met.
    // (A clean broadcast in between would appear here and break the run.)
    const { rows } = await query(
      `SELECT detail->>'silent_drop_risk' AS silent_drop_risk
         FROM system_audit_log
        WHERE event_type = 'school_broadcast'
        ORDER BY created_at DESC
        LIMIT $1`,
      [SILENT_DROP_STREAK_THRESHOLD],
    );

    if (rows.length < SILENT_DROP_STREAK_THRESHOLD) {
      return { alerted: false, streak: rows.length };
    }

    let streak = 0;
    for (const r of rows) {
      if (r.silent_drop_risk === "true") streak++;
      else break;
    }
    if (streak < SILENT_DROP_STREAK_THRESHOLD) {
      return { alerted: false, streak };
    }

    // Dedup: skip if we already alerted within the cooldown window.
    const { rows: recentAlerts } = await query(
      `SELECT 1
         FROM system_audit_log
        WHERE event_type = 'school_broadcast_silent_drop_alert'
          AND created_at > now() - make_interval(hours => $1)
        LIMIT 1`,
      [SILENT_DROP_ALERT_COOLDOWN_HOURS],
    );
    if (recentAlerts.length > 0) {
      console.log(
        `[broadcast] silent-drop streak (${streak}) met but alert suppressed (within ${SILENT_DROP_ALERT_COOLDOWN_HOURS}h cooldown)`,
      );
      return { alerted: false, streak };
    }

    const alertPhone = await getAlertPhoneNumber();
    const alertMsg =
      `🔇 Heads-up from Janus: the girls' school wake-up broadcast has shown a silent-drop risk on the last ` +
      `${streak} mornings in a row (latest ${dateStr}). All speakers loaded the audio but stayed idle at ~8s, ` +
      `so Cast may be silently dropping the sound even though the broadcast reports "success". A speaker might ` +
      `be broken — worth checking Emme's room, Isla's room, and the office speakers.`;
    const sent = await sendWhatsAppTo(alertPhone, alertMsg);
    if (sent) {
      console.log(
        `[broadcast] silent-drop streak alert sent (streak=${streak})`,
      );
    } else {
      console.warn(
        `[broadcast] silent-drop streak alert WhatsApp failed (streak=${streak})`,
      );
    }

    logAudit("school-morning-broadcast", {
      category: "automation",
      event_type: "school_broadcast_silent_drop_alert",
      severity: "warning",
      actor_id: "system",
      actor_name: "Cron",
      channel: "cron",
      summary: `Silent-drop streak alert: ${streak} consecutive school broadcasts flagged silent_drop_risk (${dateStr})${sent ? ", WhatsApp sent" : ", WhatsApp failed"}`,
      detail: {
        streak,
        threshold: SILENT_DROP_STREAK_THRESHOLD,
        cooldown_hours: SILENT_DROP_ALERT_COOLDOWN_HOURS,
        date: dateStr,
        whatsapp_sent: sent,
      },
      status: sent ? "warning" : "error",
      actionable: true,
    });

    return { alerted: sent, streak };
  } catch (e) {
    console.error("[broadcast] silent-drop streak check failed:", e);
    return { alerted: false, streak: 0 };
  }
}


const SCHOOL_YEAR_START = { month: 8, day: 24 };
const SCHOOL_YEAR_END = { month: 6, day: 3 };

// Home coordinates for weather lookup (matches server/routes/weather.ts).
const BROADCAST_HOME_LAT = 34.0522;
const BROADCAST_HOME_LNG = -118.2437;

type BriefWeather = {
  tempF: number;
  condition: string; // human-friendly word: clear, cloudy, drizzling, raining, snowing, foggy
  isPrecip: boolean;
};

// Google Weather API WeatherConditionType -> { condition, isPrecip }
// https://developers.google.com/maps/documentation/weather/reference/rest/v1/currentConditions/lookup
function googleConditionToWords(
  type: string | undefined,
): { condition: string; isPrecip: boolean } {
  switch (type) {
    case "CLEAR":
    case "MOSTLY_CLEAR":
      return { condition: "clear", isPrecip: false };
    case "PARTLY_CLOUDY":
      return { condition: "partly cloudy", isPrecip: false };
    case "MOSTLY_CLOUDY":
    case "CLOUDY":
      return { condition: "cloudy", isPrecip: false };
    case "WINDY":
    case "WIND_AND_RAIN":
      return { condition: "windy", isPrecip: type === "WIND_AND_RAIN" };
    case "LIGHT_RAIN_SHOWERS":
    case "CHANCE_OF_SHOWERS":
    case "SCATTERED_SHOWERS":
    case "RAIN_SHOWERS":
    case "HEAVY_RAIN_SHOWERS":
      return { condition: "showering", isPrecip: true };
    case "LIGHT_TO_MODERATE_RAIN":
    case "MODERATE_TO_HEAVY_RAIN":
    case "RAIN":
    case "LIGHT_RAIN":
    case "HEAVY_RAIN":
    case "RAIN_PERIODICALLY_HEAVY":
      return { condition: "raining", isPrecip: true };
    case "DRIZZLE":
    case "LIGHT_DRIZZLE":
    case "HEAVY_DRIZZLE":
      return { condition: "drizzling", isPrecip: true };
    case "LIGHT_SNOW_SHOWERS":
    case "CHANCE_OF_SNOW_SHOWERS":
    case "SCATTERED_SNOW_SHOWERS":
    case "SNOW_SHOWERS":
    case "HEAVY_SNOW_SHOWERS":
    case "LIGHT_TO_MODERATE_SNOW":
    case "MODERATE_TO_HEAVY_SNOW":
    case "SNOW":
    case "LIGHT_SNOW":
    case "HEAVY_SNOW":
    case "SNOWSTORM":
    case "SNOW_PERIODICALLY_HEAVY":
    case "HEAVY_SNOW_STORM":
    case "BLOWING_SNOW":
    case "RAIN_AND_SNOW":
      return { condition: "snowing", isPrecip: true };
    case "HAIL":
    case "HAIL_SHOWERS":
      return { condition: "hailing", isPrecip: true };
    case "THUNDERSTORM":
    case "THUNDERSHOWER":
    case "LIGHT_THUNDERSTORM_RAIN":
    case "SCATTERED_THUNDERSTORMS":
    case "HEAVY_THUNDERSTORM":
      return { condition: "stormy", isPrecip: true };
    case "FOG":
    case "LIGHT_FOG":
    case "HAZE":
    case "MIST":
    case "SMOKE":
      return { condition: "foggy", isPrecip: false };
    default:
      return { condition: "clear", isPrecip: false };
  }
}

async function fetchCurrentBriefWeather(): Promise<BriefWeather | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn("[broadcast] GOOGLE_MAPS_API_KEY not set, skipping weather lookup");
    return null;
  }
  try {
    const url =
      `https://weather.googleapis.com/v1/currentConditions:lookup` +
      `?key=${apiKey}` +
      `&location.latitude=${BROADCAST_HOME_LAT}` +
      `&location.longitude=${BROADCAST_HOME_LNG}` +
      `&unitsSystem=IMPERIAL&languageCode=en`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.error(
        `[broadcast] Google Weather currentConditions HTTP ${resp.status}`,
      );
      return null;
    }
    const data: any = await resp.json();
    const tempDeg = data?.temperature?.degrees;
    if (typeof tempDeg !== "number") return null;
    const { condition, isPrecip } = googleConditionToWords(
      data?.weatherCondition?.type,
    );
    return { tempF: Math.round(tempDeg), condition, isPrecip };
  } catch (e) {
    console.error("[broadcast] fetchCurrentBriefWeather failed:", e);
    return null;
  }
}

function buildWeatherClause(w: BriefWeather | null): string {
  if (!w) return ""; // graceful degrade: skip clause entirely
  const { tempF, condition, isPrecip } = w;
  let gear: string;
  if (isPrecip) gear = "grab a jacket";
  else if (tempF < 55) gear = "grab a sweater";
  else if (tempF > 82) gear = "you'll want light layers";
  else gear = "you're set";
  return `it's ${tempF} and ${condition} out — ${gear}.`;
}

function getLADate() {
  const now = new Date();
  const laStr = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
  });
  const la = new Date(laStr);
  const year = la.getFullYear();
  const month = la.getMonth() + 1;
  const day = la.getDate();
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    dateStr,
    hour: la.getHours(),
    minute: la.getMinutes(),
    dayOfWeek: la.getDay(),
    month,
    day,
  };
}

function currentSchoolYear(month: number): string {
  const now = new Date();
  const year = now.getFullYear();
  if (month >= 8) return `${year}-${year + 1}`;
  return `${year - 1}-${year}`;
}

function isWithinSchoolYear(month: number, day: number): boolean {
  // School year runs SCHOOL_YEAR_START – SCHOOL_YEAR_END (inclusive),
  // e.g. Aug 24 – Jun 3. Derived from the constants so a date change
  // never has to be made in two places.
  if (
    month > SCHOOL_YEAR_START.month ||
    (month === SCHOOL_YEAR_START.month && day >= SCHOOL_YEAR_START.day)
  ) return true;
  if (
    month < SCHOOL_YEAR_END.month ||
    (month === SCHOOL_YEAR_END.month && day <= SCHOOL_YEAR_END.day)
  ) return true;
  return false;
}

function expandDateRange(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  const current = new Date(start);
  while (current < end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, "0");
    const d = String(current.getUTCDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

async function getNoSchoolDates(
  supabase: any,
  schoolYear: string,
): Promise<Set<string>> {
  const { data: calendarRows } = await supabase
    .from("hw_school_calendars")
    .select("events")
    .eq("school_year", schoolYear);

  const noSchoolDates = new Set<string>();
  if (!calendarRows) return noSchoolDates;

  for (const row of calendarRows) {
    const events = (row as any).events as Array<{
      startDate: string;
      endDate: string;
      noSchool: boolean;
      divisions: string[];
    }>;
    for (const event of events) {
      if (
        event.noSchool &&
        event.divisions.includes("MS") &&
        event.divisions.includes("US")
      ) {
        const expanded = expandDateRange(event.startDate, event.endDate);
        for (const d of expanded) noSchoolDates.add(d);
      }
    }
  }
  return noSchoolDates;
}

async function callHAWithRetry(
  haUrl: string,
  haToken: string,
  path: string,
  body: unknown,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status: number; errorText: string }> {
  const url = `${haUrl.replace(/\/$/, "")}${path}`;
  const MAX_RETRIES = 3;
  let lastStatus = 0;
  let lastErrorText = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchT(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${haToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      lastStatus = res.status;
      if (res.ok) {
        return { ok: true, status: res.status, errorText: "" };
      }
      lastErrorText = await res.text().catch(() => "");
      if (res.status === 401 && attempt < MAX_RETRIES) {
        console.warn(`[broadcast] callHAWithRetry: 401 on attempt ${attempt}/${MAX_RETRIES} for ${path} — retrying in 2s`);
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      return { ok: false, status: lastStatus, errorText: lastErrorText };
    } catch (e) {
      lastErrorText = e instanceof Error ? e.message : "unknown";
      console.warn(`[broadcast] callHAWithRetry attempt ${attempt}/${MAX_RETRIES} failed for ${path}: ${lastErrorText}`);
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  return { ok: false, status: lastStatus, errorText: lastErrorText };
}


async function playAndVerifyOnSpeakers(
  haUrl: string,
  haToken: string,
  publicAudioUrl: string,
): Promise<{
  errors: string[];
  castVerifications: Record<string, { verified: boolean; state: string | null; urlMatch: boolean | null }>;
  silentDropRisk: boolean;
}> {
  const errors: string[] = [];
  for (const speaker of GIRLS_SPEAKERS) {
    const playRes = await callHAWithRetry(
      haUrl,
      haToken,
      "/api/services/media_player/play_media",
      {
        entity_id: speaker,
        media_content_id: publicAudioUrl,
        media_content_type: "audio/mpeg",
        announce: true,
        extra: {
          metadata: {
            metadataType: 3,
            title: "Morning Announcement",
            artist: "Janus",
          },
        },
      },
      20_000,
    );
    if (!playRes.ok) {
      const speakerErr = `${speaker}: play_media HTTP ${playRes.status}${playRes.errorText ? `: ${playRes.errorText}` : ""}`;
      console.warn(`[broadcast] ${speakerErr}`);
      errors.push(speakerErr);
    } else {
      console.log(`[broadcast] ✓ play_media accepted on ${speaker}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  await new Promise((r) => setTimeout(r, 3_500));
  const castVerifications: Record<string, { verified: boolean; state: string | null; urlMatch: boolean | null }> = {};
  for (const speaker of GIRLS_SPEAKERS) {
    const v = await verifyPlaybackState(haUrl, haToken, speaker, publicAudioUrl, true);
    castVerifications[speaker] = { verified: v.verified, state: v.state, urlMatch: v.urlMatch };
    if (!v.verified) {
      console.warn(
        `[broadcast] ⚠ Cast state check: ${speaker} state=${v.state ?? "null"} urlMatch=${v.urlMatch} (announce-mode: urlMatch must be true and state must not be unavailable)`,
      );
    } else {
      console.log(`[broadcast] ✓ Cast state verified: ${speaker} loaded correct content (announce-mode, state=${v.state})`);
    }
  }

  // Silent-drop heuristic: only meaningful when every speaker looked good on the
  // first poll (urlMatch===true). If so, re-poll at ~8s; if they ALL still sit at
  // 'idle' the audio may have been silently dropped. Purely observational —
  // never flips the overall success/failure status.
  let silentDropRisk = false;
  const allFirstPollVerified =
    Object.keys(castVerifications).length > 0 &&
    Object.values(castVerifications).every((v) => v.verified);
  if (allFirstPollVerified) {
    const { silentDropRisk: risk } = await detectSilentDropRisk(
      haUrl,
      haToken,
      GIRLS_SPEAKERS,
      publicAudioUrl,
      3_500,
    );
    silentDropRisk = risk;
    if (risk) {
      console.warn(
        `[broadcast] ⚠ silent_drop_risk: all speakers urlMatch=true but still idle at ~8s — audio may have been silently dropped (no failure alert raised)`,
      );
    }
  }

  return { errors, castVerifications, silentDropRisk };
}

async function broadcastToGirlsRooms(
  message: string,
): Promise<{
  success: boolean;
  errors: string[];
  ttsMethod: string;
  castVerifications?: Record<string, { verified: boolean; state: string | null; urlMatch: boolean | null }>;
  retryAttempt?: boolean;
  retryCastVerifications?: Record<string, { verified: boolean; state: string | null; urlMatch: boolean | null }>;
  silentDropRisk?: boolean;
}> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) {
    return { success: false, errors: ["Missing HA_URL or HA_TOKEN"], ttsMethod: "none" };
  }

  const errors: string[] = [];

  // Phase 0: Wake up speakers so they are ready before volume/audio
  try {
    const wakeRes = await callHAWithRetry(haUrl, haToken, "/api/services/media_player/turn_on", {
      entity_id: GIRLS_SPEAKERS,
    });
    if (!wakeRes.ok) {
      console.warn(`[broadcast] turn_on: HTTP ${wakeRes.status}${wakeRes.errorText ? `: ${wakeRes.errorText}` : ""}`);
    }
  } catch (e) {
    console.warn(`[broadcast] turn_on: ${e instanceof Error ? e.message : "unknown"}`);
  }

  await new Promise((r) => setTimeout(r, 6_000));

  // Phase 1: Volume — set all speakers at once; retry once after wake delay
  const volRes = await callHAWithRetry(haUrl, haToken, "/api/services/media_player/volume_set", {
    entity_id: GIRLS_SPEAKERS,
    volume_level: VOLUME,
  });
  if (!volRes.ok) {
    const warn = `volume_set: HTTP ${volRes.status}${volRes.errorText ? `: ${volRes.errorText}` : ""}`;
    console.warn(`[broadcast] ${warn} — retrying volume after 2s`);
    await new Promise((r) => setTimeout(r, 2_000));
    const volRetry = await callHAWithRetry(haUrl, haToken, "/api/services/media_player/volume_set", {
      entity_id: GIRLS_SPEAKERS,
      volume_level: VOLUME,
    });
    if (!volRetry.ok) {
      errors.push(`volume_set: HTTP ${volRetry.status}${volRetry.errorText ? `: ${volRetry.errorText}` : ""}`);
    }
  }

  await new Promise((r) => setTimeout(r, 1_500));

  // Phase 2: Generate TTS via ElevenLabs → upload with timestamped filename → play_media
  // Using castBroadcast.ts which gives us:
  //   • URL ending in .mp3 (no query string) — Cast won't sniff audio/mpeg if there's a ? after the extension
  //   • Unique filename per broadcast — safe to cache for 60s so Cast can buffer it
  //   • Automatic cleanup of old files (keep last 5)
  let ttsMethod = "direct_elevenlabs";
  const publicAudioUrl = await generateAndUploadTTS(message, "school-morning-broadcast");

  let castVerifications: Record<string, { verified: boolean; state: string | null; urlMatch: boolean | null }> | undefined;
  let retryAttempt = false;
  let retryCastVerifications: Record<string, { verified: boolean; state: string | null; urlMatch: boolean | null }> | undefined;
  let silentDropRisk = false;

  if (publicAudioUrl) {
    // Phase 2/3: Play the MP3 on each speaker individually (with Cast-required metadata and
    // announce flag) and then poll each speaker ~3.5s later to distinguish a true Cast
    // playback success from the silent-drop pattern (HA returns 200 but Cast never speaks).
    const first = await playAndVerifyOnSpeakers(haUrl, haToken, publicAudioUrl);
    errors.push(...first.errors);
    castVerifications = first.castVerifications;
    silentDropRisk = first.silentDropRisk;

    // Phase 3.5: Auto-retry once if 0/N speakers were verified — the silent-drop pattern is
    // usually a transient Cast issue that recovers on a second attempt with fresh TTS audio.
    const verifiedCount = Object.values(castVerifications).filter((v) => v.verified).length;
    const totalSpeakers = Object.keys(castVerifications).length;
    if (verifiedCount === 0 && totalSpeakers > 0) {
      console.warn(
        `[broadcast] ⚠ 0/${totalSpeakers} speakers verified — auto-retrying in 5s`,
      );
      // Mark the first-attempt verification failure as an error for observability;
      // it will be cleared below if the retry recovers playback.
      errors.push(`cast_verification: 0/${totalSpeakers} speakers verified on first attempt`);
      retryAttempt = true;
      await new Promise((r) => setTimeout(r, 5_000));
      const retryAudioUrl = await generateAndUploadTTS(message, "school-morning-broadcast");
      if (retryAudioUrl) {
        const second = await playAndVerifyOnSpeakers(haUrl, haToken, retryAudioUrl);
        retryCastVerifications = second.castVerifications;
        // The retry's audio is what would actually be heard, so its silent-drop
        // signal supersedes the first attempt's.
        silentDropRisk = second.silentDropRisk;
        const retryTotal = Object.keys(retryCastVerifications).length;
        const retryVerified = Object.values(retryCastVerifications).filter((v) => v.verified).length;
        if (retryVerified > 0) {
          // Retry recovered at least some speakers — clear prior play_media + cast_verification
          // errors so the overall result reflects the retry outcome.
          console.log(
            `[broadcast] ✓ Retry recovered ${retryVerified}/${retryTotal} speakers`,
          );
          for (let i = errors.length - 1; i >= 0; i--) {
            if (/: play_media HTTP /.test(errors[i]) || errors[i].startsWith("cast_verification:")) {
              errors.splice(i, 1);
            }
          }
          // Keep any non-play_media errors from the retry attempt.
          for (const e of second.errors) {
            if (!/: play_media HTTP /.test(e)) errors.push(e);
          }
          // If retry recovered only some speakers, add a structured partial error so
          // overall status is correctly classified as partial rather than success.
          if (retryVerified < retryTotal) {
            const failedDetails = Object.entries(retryCastVerifications)
              .filter(([, v]) => !v.verified)
              .map(([sp, v]) => `${sp.replace("media_player.", "")}(state=${v.state ?? "null"},urlMatch=${v.urlMatch})`)
              .join(", ");
            errors.push(`cast_verification: ${retryVerified}/${retryTotal} speakers verified after retry — failed: ${failedDetails}`);
            console.warn(
              `[broadcast] ⚠ Partial Cast verification after retry: ${retryVerified}/${retryTotal} — ${failedDetails}`,
            );
          }
        } else {
          console.warn(
            `[broadcast] ⚠ Retry also failed — 0/${retryTotal} speakers verified`,
          );
          errors.push(...second.errors);
          errors.push(`cast_verification: 0/${retryTotal} speakers verified after retry`);
        }
      } else {
        console.warn("[broadcast] Retry skipped: failed to regenerate TTS audio");
        errors.push("retry: failed to regenerate TTS audio");
      }
    } else if (verifiedCount > 0 && verifiedCount < totalSpeakers) {
      // Partial verification on first attempt: some speakers confirmed good, some failed.
      // No auto-retry (the working speakers would hear the announcement twice).
      // Add a structured error so the result is classified as partial and an alert is sent.
      const failedDetails = Object.entries(castVerifications)
        .filter(([, v]) => !v.verified)
        .map(([sp, v]) => `${sp.replace("media_player.", "")}(state=${v.state ?? "null"},urlMatch=${v.urlMatch})`)
        .join(", ");
      errors.push(`cast_verification: ${verifiedCount}/${totalSpeakers} speakers verified — failed: ${failedDetails}`);
      console.warn(
        `[broadcast] ⚠ Partial Cast verification: ${verifiedCount}/${totalSpeakers} — ${failedDetails}`,
      );
    }
  } else {
    // Direct ElevenLabs path failed — fall back to HA's tts/speak as a last resort
    ttsMethod = "ha_tts_fallback";
    console.warn("[broadcast] Direct ElevenLabs path failed — falling back to HA tts/speak (may silently fail)");
    errors.push("direct_elevenlabs: failed to generate or upload audio");

    for (const speaker of GIRLS_SPEAKERS) {
      const speakerRes = await callHAWithRetry(
        haUrl,
        haToken,
        "/api/services/tts/speak",
        {
          entity_id: "tts.elevenlabs_text_to_speech",
          media_player_entity_id: speaker,
          message,
          options: { voice: JANUS_VOICE_ID },
        },
        30_000,
      );
      if (!speakerRes.ok) {
        errors.push(`${speaker}: ha_tts HTTP ${speakerRes.status}${speakerRes.errorText ? `: ${speakerRes.errorText}` : ""}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return {
    success: errors.filter((e) => !e.startsWith("volume_set:")).length === 0,
    errors,
    ttsMethod,
    castVerifications,
    retryAttempt,
    retryCastVerifications,
    silentDropRisk,
  };
}

router.post("/school-morning", async (req: Request, res: Response) => {
  const supabase = getServiceClient();

  try {
    const la = getLADate();
    console.log(`[Broadcast] School morning check: ${la.dateStr} ${la.hour}:${String(la.minute).padStart(2, "0")} (day=${la.dayOfWeek})`);

    // Vacation mode: when the "Getting Girls to School on Time" automation is
    // toggled off (is_active=false), pause the morning wake-up broadcasts
    // (school breaks, summer). Mirrors the Morning Sauna vacation-mode pattern.
    //
    // Fail-open by design: we only skip when is_active is explicitly false. A
    // missing row, null value, or lookup error must NEVER silently suppress a
    // wake-up broadcast (kids could be late for school), so on a query error we
    // log a warning and continue with the normal broadcast logic below.
    const { data: schoolAutoRows, error: schoolAutoErr } = await supabase
      .from("family_automations")
      .select("is_active")
      .eq("name", "Getting Girls to School on Time");
    if (schoolAutoErr) {
      logAudit("school-morning-broadcast", {
        category: "automation",
        event_type: "school_broadcast_vacation_lookup_failed",
        severity: "warning",
        actor_id: "system",
        actor_name: "Cron",
        channel: "cron",
        summary: `Vacation-mode lookup failed; proceeding with broadcast (${la.dateStr})`,
        status: "warning",
        detail: { error: String((schoolAutoErr as any)?.message ?? schoolAutoErr) },
      });
    } else {
      const schoolAuto = Array.isArray(schoolAutoRows) ? schoolAutoRows[0] : schoolAutoRows;
      if (schoolAuto && schoolAuto.is_active === false) {
        logAudit("school-morning-broadcast", {
          category: "automation",
          event_type: "school_broadcast_skip",
          severity: "info",
          actor_id: "system",
          actor_name: "Cron",
          channel: "cron",
          summary: `School broadcast skipped: vacation mode (${la.dateStr})`,
          status: "skipped",
        });
        return res.json({
          success: true,
          skipped: true,
          reason: "vacation_mode",
        });
      }
    }

    if (la.dayOfWeek === 0 || la.dayOfWeek === 6) {
      logAudit("school-morning-broadcast", {
        category: "automation",
        event_type: "school_broadcast_skip",
        severity: "info",
        actor_id: "system",
        actor_name: "Cron",
        channel: "cron",
        summary: `School broadcast skipped: weekend (${la.dateStr})`,
        status: "skipped",
      });
      return res.json({
        success: true,
        skipped: true,
        reason: "weekend",
      });
    }

    if (!isWithinSchoolYear(la.month, la.day)) {
      logAudit("school-morning-broadcast", {
        category: "automation",
        event_type: "school_broadcast_skip",
        severity: "info",
        actor_id: "system",
        actor_name: "Cron",
        channel: "cron",
        summary: `School broadcast skipped: outside school year (${la.dateStr})`,
        status: "skipped",
      });
      return res.json({
        success: true,
        skipped: true,
        reason: "outside_school_year",
      });
    }

    const schoolYear = currentSchoolYear(la.month);
    const noSchoolDates = await getNoSchoolDates(supabase, schoolYear);
    if (noSchoolDates.has(la.dateStr)) {
      logAudit("school-morning-broadcast", {
        category: "automation",
        event_type: "school_broadcast_skip",
        severity: "info",
        actor_id: "system",
        actor_name: "Cron",
        channel: "cron",
        summary: `School broadcast skipped: no-school day (${la.dateStr})`,
        status: "skipped",
      });
      return res.json({
        success: true,
        skipped: true,
        reason: "no_school_day",
      });
    }

    let slot: string;
    // Test-only override: ?_test_force_slot=650am or 730am in body bypasses time window.
    // (Legacy values 7am/735am still accepted.)
    // Logs a short test message instead of the real one so it's safe to use mid-day.
    const rawForceSlot = (req.body as any)?._test_force_slot as string | undefined;
    const forceSlot = rawForceSlot === "7am" ? "650am" : rawForceSlot === "735am" ? "730am" : rawForceSlot;
    if (forceSlot === "650am" || forceSlot === "730am") {
      console.log(`[broadcast] TEST OVERRIDE: forcing slot=${forceSlot}`);
      const testMsg = "Girls, this is Janus running a broadcast system test. All good.";
      const { success: testOk, errors: testErrors, ttsMethod: testMethod } = await broadcastToGirlsRooms(testMsg);
      return res.json({
        test: true,
        success: testOk,
        slot: forceSlot,
        message: testMsg,
        ttsMethod: testMethod,
        errors: testErrors.length > 0 ? testErrors : undefined,
      });
    }
    // Slot windows around the cron fire times (6:50 and 7:30 PT), with grace
    // for late cron ticks: 6:50–7:09 → wake-up, 7:25–7:42 → leaving-soon.
    if ((la.hour === 6 && la.minute >= 50) || (la.hour === 7 && la.minute < 10)) {
      slot = "650am";
    } else if (la.hour === 7 && la.minute >= 25 && la.minute <= 42) {
      slot = "730am";
    } else {
      logAudit("school-morning-broadcast", {
        category: "automation",
        event_type: "school_broadcast_skip",
        severity: "info",
        actor_id: "system",
        actor_name: "Cron",
        channel: "cron",
        summary: `School broadcast skipped: outside broadcast window (${la.dateStr} ${la.hour}:${String(la.minute).padStart(2, "0")})`,
        status: "skipped",
      });
      return res.json({
        success: true,
        skipped: true,
        reason: "outside_broadcast_window",
      });
    }

    let message: string;
    if (slot === "650am") {
      const weather = await fetchCurrentBriefWeather();
      const weatherClause = buildWeatherClause(weather);
      message = composeSchoolMorningAnnouncement({
        slot: "650am",
        dateKey: la.dateStr,
        weatherClause,
      });
    } else {
      message = composeSchoolMorningAnnouncement({
        slot: "730am",
      });
    }
    const broadcastResult = await broadcastToGirlsRooms(message);
    const { success: broadcastOk, errors: broadcastErrors, ttsMethod } = broadcastResult;
    const ttsErrors = broadcastErrors.filter((e) => !e.startsWith("volume_set:"));
    const broadcastStatus = broadcastOk
      ? "success"
      : ttsErrors.length < GIRLS_SPEAKERS.length
        ? "partial"
        : "error";

    // WhatsApp fallback: if ALL speaker TTS calls failed, send the message to the family via WhatsApp
    let whatsappFallback = false;
    const allSpeakersFailed =
      !broadcastOk &&
      ttsErrors.length >= GIRLS_SPEAKERS.length;

    if (allSpeakersFailed) {
      const fallbackPhone = await getBroadcastFallbackPhone();
      whatsappFallback = await sendWhatsAppTo(
        fallbackPhone,
        `📢 Morning broadcast (${slot}): ${message}`,
      );
      if (whatsappFallback) {
        console.log(`[broadcast] WhatsApp fallback sent for slot ${slot}`);
      } else {
        console.warn(`[broadcast] WhatsApp fallback failed for slot ${slot}`);
      }
    }

    // WhatsApp alert: if any failure occurred (partial or full), alert Tony
    let whatsappAlert = false;
    if (!broadcastOk) {
      const alertPhone = await getAlertPhoneNumber();
      const failedSpeakers = ttsErrors.map((e) => {
        const match = e.match(/media_player\.(\S+?):/);
        return match ? match[1].replace(/_/g, " ") : e.slice(0, 60);
      });
      const speakerSummary =
        failedSpeakers.length > 0
          ? failedSpeakers.join(", ")
          : `${ttsErrors.length} speaker(s)`;
      const fallbackNote = allSpeakersFailed
        ? (whatsappFallback ? " WhatsApp fallback sent to family." : " WhatsApp fallback failed.")
        : " WhatsApp fallback not triggered (partial failure).";
      const alertMsg =
        `⚠️ School broadcast ${slot} (${la.dateStr}): ${broadcastStatus === "partial" ? "partial failure" : "all speakers failed"}. ` +
        `Failed: ${speakerSummary}.` +
        fallbackNote;
      whatsappAlert = await sendWhatsAppTo(alertPhone, alertMsg);
      if (whatsappAlert) {
        console.log(`[broadcast] WhatsApp alert sent to Tony for slot ${slot}`);
      } else {
        console.warn(`[broadcast] WhatsApp alert failed for slot ${slot}`);
      }
    }

    const { data: automation } = await supabase
      .from("family_automations")
      .select("id")
      .eq("name", "Getting Girls to School on Time")
      .single();

    if (automation) {
      await supabase.from("family_automation_logs").insert({
        automation_id: automation.id,
        status: broadcastStatus,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        output: {
          slot,
          message,
          date: la.dateStr,
          speakers: GIRLS_SPEAKERS,
          errors: broadcastErrors.length > 0 ? broadcastErrors : undefined,
          whatsapp_fallback: whatsappFallback,
          whatsapp_alert: whatsappAlert,
        },
        error_message:
          broadcastErrors.length > 0
            ? broadcastErrors.join("; ")
            : null,
      });
      await supabase
        .from("family_automations")
        .update({ last_run_at: new Date().toISOString() })
        .eq("id", automation.id);
    }

    const castVerified = broadcastResult.castVerifications
      ? Object.values(broadcastResult.castVerifications).filter((v) => v.verified).length
      : undefined;
    const castTotal = broadcastResult.castVerifications
      ? Object.keys(broadcastResult.castVerifications).length
      : undefined;
    const castSummary =
      castVerified !== undefined && castTotal !== undefined
        ? ` cast_verified=${castVerified}/${castTotal}`
        : "";

    const silentDropNote = broadcastResult.silentDropRisk
      ? ", silent-drop risk (still idle at 8s)"
      : "";

    logAudit("school-morning-broadcast", {
      category: "automation",
      event_type: "school_broadcast",
      severity: broadcastOk && !broadcastResult.silentDropRisk ? "info" : "warning",
      actor_id: "system",
      actor_name: "Cron",
      channel: "cron",
      summary: `School broadcast ${slot}: ${GIRLS_SPEAKERS.length} speakers (${broadcastStatus})${castSummary}${silentDropNote}${whatsappFallback ? ", WhatsApp fallback" : ""}`,
      detail: {
        slot,
        message,
        date: la.dateStr,
        ttsMethod,
        cast_verifications: broadcastResult.castVerifications,
        retry_attempt: broadcastResult.retryAttempt ?? false,
        retry_cast_verifications: broadcastResult.retryCastVerifications,
        silent_drop_risk: broadcastResult.silentDropRisk ?? false,
        errors: broadcastErrors.length > 0 ? broadcastErrors : undefined,
        whatsapp_fallback: whatsappFallback,
        whatsapp_alert: whatsappAlert,
      },
      status: broadcastStatus,
    });

    // When this broadcast itself flagged silent-drop risk, check whether the
    // pattern has recurred across consecutive school mornings and, if so, send a
    // deduped WhatsApp heads-up so a genuinely broken speaker isn't masked by
    // the broadcast still reporting "success".
    let silentDropAlerted = false;
    if (broadcastResult.silentDropRisk) {
      const streakResult = await maybeAlertSilentDropStreak(la.dateStr);
      silentDropAlerted = streakResult.alerted;
    }

    return res.json({
      success: broadcastOk,
      status: broadcastStatus,
      slot,
      message,
      date: la.dateStr,
      ttsMethod,
      silent_drop_risk: broadcastResult.silentDropRisk ?? false,
      silent_drop_alerted: silentDropAlerted,
      retry_attempt: broadcastResult.retryAttempt ?? false,
      retry_cast_verifications: broadcastResult.retryCastVerifications,
      errors: broadcastErrors.length > 0 ? broadcastErrors : undefined,
      whatsapp_fallback: whatsappFallback,
      whatsapp_alert: whatsappAlert,
    });
  } catch (error) {
    console.error("School morning broadcast error:", error);
    logAudit("school-morning-broadcast", {
      category: "automation",
      event_type: "school_broadcast_error",
      severity: "error",
      actor_id: "system",
      channel: "cron",
      summary: `School broadcast error: ${error instanceof Error ? error.message : "Unknown"}`,
      status: "error",
    });
    await enqueueFailedJob("school-morning-broadcast", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * POST /api/broadcast/test-morning
 * Admin-only: manually trigger a test morning broadcast bypassing all date/time/
 * school-year checks.  Useful for verifying speaker playback after Cast
 * configuration changes without waiting for 7 AM.
 * Accepts optional { message } body; uses a default test message if omitted.
 * Rate-limited: the underlying broadcastToGirlsRooms already enforces a 6s wake
 * delay + 3.5s verification window, so this naturally prevents rapid-fire abuse.
 */
router.post("/test-morning", requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (req.userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  const actorId = req.userId ?? "unknown";
  const testMessage =
    typeof req.body?.message === "string" && req.body.message.trim().length > 0
      ? req.body.message.trim()
      : "Girls, this is Janus running a broadcast system test. All systems are go.";

  console.log(`[broadcast] Manual test broadcast triggered by ${actorId}: "${testMessage.slice(0, 80)}"`);
  const t0 = Date.now();

  try {
    const result = await broadcastToGirlsRooms(testMessage);
    const castVerified = result.castVerifications
      ? Object.values(result.castVerifications).filter((v) => v.verified).length
      : undefined;
    const castTotal = result.castVerifications
      ? Object.keys(result.castVerifications).length
      : undefined;

    logAudit("school-morning-broadcast", {
      category: "automation",
      event_type: "school_broadcast_test",
      severity: result.success ? "info" : "warning",
      actor_id: actorId,
      actor_name: "Manual (admin)",
      channel: "web",
      summary: `Manual test broadcast by ${actorId}: ${GIRLS_SPEAKERS.length} speakers (${result.success ? "success" : "partial/error"})${castVerified !== undefined ? ` cast_verified=${castVerified}/${castTotal}` : ""}`,
      detail: {
        message: testMessage,
        ttsMethod: result.ttsMethod,
        cast_verifications: result.castVerifications,
        retry_attempt: result.retryAttempt ?? false,
        retry_cast_verifications: result.retryCastVerifications,
        errors: result.errors.length > 0 ? result.errors : undefined,
      },
      status: result.success ? "success" : "error",
      duration_ms: Date.now() - t0,
    });

    return res.json({
      success: result.success,
      test: true,
      message: testMessage,
      ttsMethod: result.ttsMethod,
      cast_verifications: result.castVerifications,
      retry_attempt: result.retryAttempt ?? false,
      retry_cast_verifications: result.retryCastVerifications,
      errors: result.errors.length > 0 ? result.errors : undefined,
      duration_ms: Date.now() - t0,
    });
  } catch (error) {
    console.error("[broadcast] Test broadcast error:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

function stripMarkdown(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .trim();
}

router.post("/elevenlabs-voice", async (req: Request, res: Response) => {
  const start = Date.now();
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  if (!ELEVENLABS_API_KEY) {
    return res
      .status(500)
      .json({ error: "ELEVENLABS_API_KEY not configured" });
  }

  const { allowed: circuitAllowed } = canRequest("elevenlabs");
  if (!circuitAllowed) {
    return res.status(503).json({
      error:
        "Service temporarily unavailable: ElevenLabs. The system will retry automatically.",
    });
  }

  try {
    const { action } = req.body;

    if (action === "transcribe") {
      const { audio_base64, audio_format = "webm" } = req.body;
      if (!audio_base64) {
        return res
          .status(400)
          .json({ error: "audio_base64 is required" });
      }

      let audioBytes: Uint8Array;
      try {
        const cleanBase64 = audio_base64.includes(",")
          ? audio_base64.split(",")[1]
          : audio_base64;
        audioBytes = Buffer.from(cleanBase64, "base64");
      } catch (e) {
        return res
          .status(400)
          .json({ error: "Invalid audio_base64 data" });
      }

      const mimeMap: Record<string, string> = {
        webm: "audio/webm",
        mp4: "audio/mp4",
        ogg: "audio/ogg",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        m4a: "audio/m4a",
      };
      const mimeType =
        mimeMap[audio_format.toLowerCase()] || "audio/webm";

      const formData = new FormData();
      const audioBlob = new Blob([audioBytes], { type: mimeType });
      formData.append("file", audioBlob, `audio.${audio_format}`);
      formData.append("model_id", "scribe_v2");
      formData.append("language_code", "eng");

      const sttResponse = await fetchT(
        "https://api.elevenlabs.io/v1/speech-to-text",
        {
          method: "POST",
          headers: { "xi-api-key": ELEVENLABS_API_KEY },
          body: formData,
        },
      );

      if (!sttResponse.ok) {
        recordFailure("elevenlabs");
        return res.status(500).json({
          error: `Speech-to-text failed (status ${sttResponse.status})`,
        });
      }

      recordSuccess("elevenlabs");
      const sttData = await sttResponse.json();
      logAudit("elevenlabs-voice", {
        category: "media",
        event_type: "stt_transcribe",
        severity: "info",
        actor_id: "system",
        actor_name: "System",
        channel: "system",
        summary: `Transcribed ${audioBytes.length} bytes`,
        status: "success",
        duration_ms: Date.now() - start,
      });

      return res.json({
        text: sttData.text || "",
        language_code: sttData.language_code,
      });
    }

    if (action === "synthesize") {
      const {
        text,
        voice_id = DEFAULT_VOICE_ID,
        return_base64 = true,
      } = req.body;
      if (!text) {
        return res.status(400).json({ error: "text is required" });
      }

      const truncated = stripMarkdown(text).slice(0, 5000);

      const ttsResponse = await fetchT(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice_id}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: truncated,
            model_id: "eleven_turbo_v2_5",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
        },
      );

      if (!ttsResponse.ok) {
        recordFailure("elevenlabs");
        return res.status(500).json({
          error: `Text-to-speech failed (status ${ttsResponse.status})`,
        });
      }

      recordSuccess("elevenlabs");
      const audioBuffer = await ttsResponse.arrayBuffer();

      logAudit("elevenlabs-voice", {
        category: "media",
        event_type: "tts_synthesize",
        severity: "info",
        actor_id: "system",
        actor_name: "System",
        channel: "system",
        summary: `Synthesized ${truncated.length} chars → ${audioBuffer.byteLength} bytes`,
        status: "success",
        duration_ms: Date.now() - start,
      });

      if (return_base64) {
        const audioBase64 = Buffer.from(audioBuffer).toString("base64");
        return res.json({ audio_base64: audioBase64 });
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", audioBuffer.byteLength.toString());
      return res.send(Buffer.from(audioBuffer));
    }

    return res.status(400).json({
      error: `Unknown action: ${action}. Use 'transcribe' or 'synthesize'.`,
    });
  } catch (e) {
    console.error("elevenlabs-voice error:", e);
    recordFailure("elevenlabs");
    logAudit("elevenlabs-voice", {
      category: "media",
      event_type: "voice_error",
      severity: "error",
      actor_id: "system",
      actor_name: "System",
      channel: "system",
      summary: `Error: ${e instanceof Error ? e.message : "unknown"}`,
      status: "error",
      duration_ms: Date.now() - start,
    });
    return res
      .status(500)
      .json({ error: sanitizeErrorMessage(e) });
  }
});

export default router;
// Last deploy trigger: 2026-05-21T14:50:42Z
