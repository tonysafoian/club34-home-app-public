/**
 * Shared helpers for the Google Weather API (weather.googleapis.com).
 * All public functions are no-throw: they return null / [] on failure
 * and log the error so callers can degrade gracefully.
 */

export const GOOGLE_WEATHER_BASE = 'https://weather.googleapis.com/v1';

const TIMEOUT_MS = 5_000;

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer),
  );
}

// ─── Current Conditions ──────────────────────────────────────────────────────

export async function fetchGoogleCurrentConditions(
  lat: number,
  lng: number,
): Promise<unknown | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `${GOOGLE_WEATHER_BASE}/currentConditions:lookup?key=${apiKey}&location.latitude=${lat}&location.longitude=${lng}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.error(`[google-weather] currentConditions returned ${res.status}`);
      return null;
    }
    return res.json();
  } catch (err) {
    console.error('[google-weather] currentConditions error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Hourly Forecast ─────────────────────────────────────────────────────────

/**
 * Fetches hourly forecast data.  The API returns at most 24 h per page; if
 * `hours` > 24 we paginate using `nextPageToken` until we have enough entries.
 */
export async function fetchGoogleHourlyForecast(
  lat: number,
  lng: number,
  hours: number,
): Promise<unknown[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return [];
  // Google paginates server-side at 24 hours per page. We pass the full `hours`
  // value in the query string (Google uses it to decide whether to issue a
  // nextPageToken) and walk the pages until we have what we need.
  // BUG FIX: a previous version passed `hours=24` which made Google think the
  // caller only wanted 24 hours total — no token was returned, callers asking
  // for 48h silently got 24.
  const all: unknown[] = [];
  let pageToken: string | null = null;
  const MAX_PAGES = Math.ceil(hours / 24) + 2; // safety bound
  let pages = 0;

  try {
    do {
      let url =
        `${GOOGLE_WEATHER_BASE}/forecast/hours:lookup?key=${apiKey}` +
        `&location.latitude=${lat}&location.longitude=${lng}` +
        `&hours=${hours}&unitsSystem=IMPERIAL`;
      if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        console.error(`[google-weather] hours:lookup returned ${res.status}`);
        break;
      }
      const json = (await res.json()) as { forecastHours?: unknown[]; nextPageToken?: string };
      const entries: unknown[] = json.forecastHours ?? [];
      all.push(...entries);
      pageToken = json.nextPageToken ?? null;
      pages += 1;
    } while (pageToken && all.length < hours && pages < MAX_PAGES);

    return all.slice(0, hours);
  } catch (err) {
    console.error('[google-weather] hours:lookup error:', err instanceof Error ? err.message : err);
    return all; // return however many we got
  }
}

// ─── Daily Forecast ───────────────────────────────────────────────────────────

/** Max 5 days — hard limit of the Google Weather API. */
export async function fetchGoogleDailyForecast(
  lat: number,
  lng: number,
  days: number,
): Promise<unknown[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return [];
  const cappedDays = Math.min(days, 5);
  try {
    const url =
      `${GOOGLE_WEATHER_BASE}/forecast/days:lookup?key=${apiKey}` +
      `&location.latitude=${lat}&location.longitude=${lng}` +
      `&days=${cappedDays}&unitsSystem=IMPERIAL`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.error(`[google-weather] days:lookup returned ${res.status}`);
      return [];
    }
    const json = (await res.json()) as { forecastDays?: unknown[] };
    return json.forecastDays ?? [];
  } catch (err) {
    console.error('[google-weather] days:lookup error:', err instanceof Error ? err.message : err);
    return [];
  }
}

// ─── Condition Helpers ────────────────────────────────────────────────────────

/**
 * Maps Google WeatherConditionType enum values to a human-readable description.
 * Falls through to 'Partly Cloudy' for unknown values.
 */
export function googleConditionToDescription(type: string): string {
  switch (type) {
    case 'CLEAR':                         return 'Clear sky ☀️';
    case 'MOSTLY_CLEAR':                  return 'Mostly clear 🌤️';
    case 'PARTLY_CLOUDY':                 return 'Partly cloudy ⛅';
    case 'MOSTLY_CLOUDY':                 return 'Mostly cloudy 🌥️';
    case 'CLOUDY':                        return 'Overcast ☁️';
    case 'WINDY':                         return 'Windy 💨';
    case 'WIND_AND_RAIN':                 return 'Windy and rainy 🌧️💨';
    case 'FOGGY':                         return 'Foggy 🌫️';
    case 'HAZE':                          return 'Hazy 🌫️';
    case 'SMOKY':                         return 'Smoky 🌫️';
    case 'DUST':                          return 'Dusty 🌫️';
    case 'LIGHT_RAIN':                    return 'Light rain 🌦️';
    case 'RAIN':                          return 'Rain 🌧️';
    case 'HEAVY_RAIN':                    return 'Heavy rain 🌧️';
    case 'LIGHT_SHOWERS':                 return 'Light showers 🌦️';
    case 'SHOWERS':                       return 'Showers 🌧️';
    case 'HEAVY_SHOWERS':                 return 'Heavy showers ⛈️';
    case 'DRIZZLE':                       return 'Drizzle 🌦️';
    case 'LIGHT_DRIZZLE':                 return 'Light drizzle 🌦️';
    case 'HEAVY_DRIZZLE':                 return 'Heavy drizzle 🌧️';
    case 'FREEZING_DRIZZLE':              return 'Freezing drizzle 🌧️❄️';
    case 'HEAVY_FREEZING_DRIZZLE':        return 'Heavy freezing drizzle 🌧️❄️';
    case 'FREEZING_RAIN':                 return 'Freezing rain 🌧️❄️';
    case 'HEAVY_FREEZING_RAIN':           return 'Heavy freezing rain 🌧️❄️';
    case 'LIGHT_SNOW':                    return 'Light snow 🌨️';
    case 'SNOW':                          return 'Snow 🌨️';
    case 'HEAVY_SNOW':                    return 'Heavy snow 🌨️';
    case 'SNOW_SHOWERS':                  return 'Snow showers 🌨️';
    case 'FLURRIES':                      return 'Flurries 🌨️';
    case 'BLOWING_SNOW':                  return 'Blowing snow 🌨️';
    case 'BLIZZARD':                      return 'Blizzard ❄️';
    case 'ICE_PELLETS':                   return 'Ice pellets 🌨️';
    case 'SLEET':                         return 'Sleet 🌨️';
    case 'HAIL':                          return 'Hail 🌨️';
    case 'THUNDERSTORM':                  return 'Thunderstorm ⛈️';
    case 'THUNDERSHOWERS':                return 'Thundershowers ⛈️';
    case 'LIGHT_THUNDERSTORM':            return 'Light thunderstorm ⛈️';
    case 'HEAVY_THUNDERSTORM':            return 'Heavy thunderstorm ⛈️';
    case 'TORNADO':                       return 'Tornado 🌪️';
    case 'TROPICAL_STORM':                return 'Tropical storm 🌀';
    case 'HURRICANE':                     return 'Hurricane 🌀';
    default:                              return 'Partly cloudy ⛅';
  }
}

/**
 * Returns a single emoji character for the given Google WeatherConditionType.
 * Extracts the emoji from googleConditionToDescription().
 */
export function googleConditionToEmoji(type: string): string {
  const desc = googleConditionToDescription(type);
  // grab first emoji character
  const match = desc.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/u);
  return match ? match[0] : '⛅';
}

// ─── WMO Code Mapping ─────────────────────────────────────────────────────────

/**
 * Maps a Google WeatherConditionType enum string to a representative WMO
 * numeric code so existing callers that expect WMO codes keep working.
 */
export function googleTypeToWMO(type: string): number {
  switch (type) {
    case 'CLEAR':                  return 0;
    case 'MOSTLY_CLEAR':           return 1;
    case 'PARTLY_CLOUDY':          return 2;
    case 'MOSTLY_CLOUDY':          return 3;
    case 'CLOUDY':                 return 3;
    case 'WINDY':                  return 2;
    case 'WIND_AND_RAIN':          return 61;
    case 'FOGGY':                  return 45;
    case 'HAZE':                   return 45;
    case 'SMOKY':                  return 45;
    case 'DUST':                   return 45;
    case 'LIGHT_DRIZZLE':          return 51;
    case 'DRIZZLE':                return 53;
    case 'HEAVY_DRIZZLE':          return 55;
    case 'FREEZING_DRIZZLE':       return 56;
    case 'HEAVY_FREEZING_DRIZZLE': return 57;
    case 'LIGHT_RAIN':             return 61;
    case 'RAIN':                   return 63;
    case 'HEAVY_RAIN':             return 65;
    case 'FREEZING_RAIN':          return 66;
    case 'HEAVY_FREEZING_RAIN':    return 67;
    case 'LIGHT_SHOWERS':          return 80;
    case 'SHOWERS':                return 81;
    case 'HEAVY_SHOWERS':          return 82;
    case 'LIGHT_SNOW':             return 71;
    case 'SNOW':                   return 73;
    case 'HEAVY_SNOW':             return 75;
    case 'SNOW_SHOWERS':           return 85;
    case 'FLURRIES':               return 71;
    case 'BLOWING_SNOW':           return 75;
    case 'BLIZZARD':               return 75;
    case 'ICE_PELLETS':            return 77;
    case 'SLEET':                  return 68;
    case 'HAIL':                   return 96;
    case 'THUNDERSTORM':           return 95;
    case 'THUNDERSHOWERS':         return 80;
    case 'LIGHT_THUNDERSTORM':     return 95;
    case 'HEAVY_THUNDERSTORM':     return 99;
    case 'TORNADO':                return 99;
    case 'TROPICAL_STORM':         return 99;
    case 'HURRICANE':              return 99;
    default:                       return 2;  // partly cloudy fallback
  }
}
