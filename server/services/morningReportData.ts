import { googleTypeToWMO } from "../utils/google-weather.js";

const LA_TIME_ZONE = "America/Los_Angeles";
const CNBC_QUOTE_URL =
  "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol";
const CNBC_SYMBOLS = [".DJI", ".SPX", ".IXIC", "@GC.1", "@CL.1", "EUR=", "GBP=", "JPY="] as const;

export interface MarketItem {
  name: string;
  value: string;
  change: string;
  up: boolean;
}

export interface MarketSnapshot {
  indices: MarketItem[];
  commodities: MarketItem[];
  currencies: MarketItem[];
  asOf: string | null;
  source: "CNBC";
}

export interface WeatherSourceData {
  source: "Google Weather" | "Open-Meteo";
  current: {
    code: number;
    temp: number;
    feels: number;
    observedAt: string | null;
  } | null;
  hourly: {
    time: string[];
    temperature_2m: number[];
    apparent_temperature: number[];
    precipitation_probability: number[];
    weathercode: number[];
    windspeed_10m: number[];
    uv_index: number[];
  };
}

export interface ExtractedWeatherData {
  current: {
    code: number;
    temp: number;
    feels: number;
    precip: number;
  } | null;
  slots: {
    hour: number;
    code: number;
    temp: number;
    precip: number;
  }[];
}

interface CnbcQuote {
  symbol?: string;
  code?: number;
  last?: string;
  change?: string;
  changetype?: string;
  last_time?: string;
}

interface GoogleForecastHour {
  startTime: string;
  temperature?: { degrees?: unknown };
  feelsLikeTemperature?: { degrees?: unknown };
  precipitation?: { probability?: { percent?: unknown } };
  weatherCondition?: { type?: unknown };
  wind?: { speed?: { value?: unknown } };
  uvIndex?: unknown;
}

interface GoogleCurrentConditions {
  currentTime?: unknown;
  temperature?: { degrees?: unknown };
  feelsLikeTemperature?: { degrees?: unknown };
  weatherCondition?: { type?: unknown };
}

interface OpenMeteoResponse {
  utc_offset_seconds?: number;
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    apparent_temperature?: number[];
    precipitation_probability?: number[];
    weather_code?: number[];
    wind_speed_10m?: number[];
    uv_index?: number[];
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function laDateHour(value: string | Date): { date: string; hour: number } | null {
  if (typeof value === "string") {
    const localWallTime = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):\d{2}$/);
    if (localWallTime) {
      return { date: localWallTime[1], hour: Number(localWallTime[2]) };
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = read("year");
  const month = read("month");
  const day = read("day");
  const hour = Number(read("hour"));
  if (!year || !month || !day || !Number.isFinite(hour)) return null;
  return { date: `${year}-${month}-${day}`, hour };
}

export function buildWeatherSourceData(
  forecastHours: unknown[],
  currentConditions: unknown,
): WeatherSourceData | null {
  const usableHours = forecastHours.filter(
    (entry): entry is GoogleForecastHour =>
      Boolean(entry) &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).startTime === "string",
  );
  if (usableHours.length === 0 && (!currentConditions || typeof currentConditions !== "object")) {
    return null;
  }

  const currentRaw =
    currentConditions && typeof currentConditions === "object"
      ? (currentConditions as GoogleCurrentConditions)
      : null;
  const currentTemp = finiteNumber(currentRaw?.temperature?.degrees);
  const currentFeels = finiteNumber(currentRaw?.feelsLikeTemperature?.degrees);
  const currentType = currentRaw?.weatherCondition?.type;
  const current =
    currentTemp !== null
      ? {
          code: googleTypeToWMO(typeof currentType === "string" ? currentType : "PARTLY_CLOUDY"),
          temp: currentTemp,
          feels: currentFeels ?? currentTemp,
          observedAt: typeof currentRaw?.currentTime === "string" ? currentRaw.currentTime : null,
        }
      : null;

  return {
    source: "Google Weather",
    current,
    hourly: {
      time: usableHours.map((hour) => hour.startTime),
      temperature_2m: usableHours.map((hour) => finiteNumber(hour.temperature?.degrees) ?? NaN),
      apparent_temperature: usableHours.map(
        (hour) => finiteNumber(hour.feelsLikeTemperature?.degrees) ?? NaN,
      ),
      precipitation_probability: usableHours.map(
        (hour) => finiteNumber(hour.precipitation?.probability?.percent) ?? 0,
      ),
      weathercode: usableHours.map((hour) =>
        googleTypeToWMO(
          typeof hour.weatherCondition?.type === "string"
            ? hour.weatherCondition.type
            : "PARTLY_CLOUDY",
        ),
      ),
      windspeed_10m: usableHours.map((hour) => finiteNumber(hour.wind?.speed?.value) ?? 0),
      uv_index: usableHours.map((hour) => finiteNumber(hour.uvIndex) ?? 0),
    },
  };
}

function offsetSuffix(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const totalMinutes = Math.abs(Math.round(offsetSeconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export async function fetchOpenMeteoWeather(
  lat: number,
  lng: number,
  fetchImpl: typeof fetch = fetch,
): Promise<WeatherSourceData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lng),
      current: "temperature_2m,apparent_temperature,weather_code",
      hourly:
        "temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m,uv_index",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      timezone: LA_TIME_ZONE,
      forecast_days: "2",
    });
    const response = await fetchImpl(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[morning-report] Open-Meteo returned ${response.status}`);
      return null;
    }
    const body = (await response.json()) as OpenMeteoResponse;
    const hourly = body.hourly;
    if (!hourly?.time?.length) return null;
    const currentTemp = finiteNumber(body.current?.temperature_2m);
    const currentFeels = finiteNumber(body.current?.apparent_temperature);
    const offset = finiteNumber(body.utc_offset_seconds) ?? 0;
    const observedAt =
      typeof body.current?.time === "string"
        ? `${body.current.time}${offsetSuffix(offset)}`
        : null;

    return {
      source: "Open-Meteo",
      current:
        currentTemp === null
          ? null
          : {
              code: finiteNumber(body.current?.weather_code) ?? 2,
              temp: currentTemp,
              feels: currentFeels ?? currentTemp,
              observedAt,
            },
      hourly: {
        time: hourly.time,
        temperature_2m: hourly.temperature_2m ?? [],
        apparent_temperature: hourly.apparent_temperature ?? [],
        precipitation_probability: hourly.precipitation_probability ?? [],
        weathercode: hourly.weather_code ?? [],
        windspeed_10m: hourly.wind_speed_10m ?? [],
        uv_index: hourly.uv_index ?? [],
      },
    };
  } catch (error) {
    console.error(
      "[morning-report] Open-Meteo failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function formatWeatherForAI(data: WeatherSourceData, now = new Date()): string {
  const targetDate = laDateHour(now)?.date;
  const lines: string[] = [];
  for (let index = 0; index < data.hourly.time.length; index += 1) {
    const local = laDateHour(data.hourly.time[index]);
    if (!local || local.date !== targetDate || local.hour < 6 || local.hour > 23) continue;
    const temp = data.hourly.temperature_2m[index];
    const feelsLike = data.hourly.apparent_temperature[index];
    if (!Number.isFinite(temp) || !Number.isFinite(feelsLike)) continue;
    const precip = data.hourly.precipitation_probability[index] ?? 0;
    const code = data.hourly.weathercode[index] ?? 2;
    const wind = data.hourly.windspeed_10m[index] ?? 0;
    const uv = data.hourly.uv_index[index] ?? 0;
    lines.push(
      `${String(local.hour).padStart(2, "0")}:00: ${Math.round(temp)}°F ` +
        `(feels ${Math.round(feelsLike)}°F), WMO ${code}, ${precip}% rain, ` +
        `wind ${Math.round(wind)}mph, UV ${uv}`,
    );
  }
  return lines.join("\n");
}

export function extractWeatherData(
  data: WeatherSourceData,
  now = new Date(),
): ExtractedWeatherData {
  const nowLocal = laDateHour(now);
  const hourlyRows = data.hourly.time
    .map((time, index) => {
      const local = laDateHour(time);
      const temp = data.hourly.temperature_2m[index];
      if (!local || !Number.isFinite(temp)) return null;
      return {
        ...local,
        code: data.hourly.weathercode[index] ?? 2,
        temp: Math.round(temp),
        feels: Math.round(
          Number.isFinite(data.hourly.apparent_temperature[index])
            ? data.hourly.apparent_temperature[index]
            : temp,
        ),
        precip: data.hourly.precipitation_probability[index] ?? 0,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const todayRows = nowLocal
    ? hourlyRows.filter((row) => row.date === nowLocal.date)
    : hourlyRows;
  const fallbackCurrent =
    nowLocal && todayRows.length
      ? [...todayRows].sort(
          (left, right) =>
            Math.abs(left.hour - nowLocal.hour) - Math.abs(right.hour - nowLocal.hour),
        )[0]
      : todayRows[0];
  const current = data.current
    ? {
        code: data.current.code,
        temp: Math.round(data.current.temp),
        feels: Math.round(data.current.feels),
        precip: fallbackCurrent?.precip ?? 0,
      }
    : fallbackCurrent
      ? {
          code: fallbackCurrent.code,
          temp: fallbackCurrent.temp,
          feels: fallbackCurrent.feels,
          precip: fallbackCurrent.precip,
        }
      : null;

  const slots = [8, 12, 15, 19].flatMap((hour) => {
    const row = todayRows.find((candidate) => candidate.hour === hour);
    return row
      ? [{ hour, code: row.code, temp: row.temp, precip: row.precip }]
      : [];
  });

  return { current, slots };
}

function marketItem(
  quotes: Map<string, CnbcQuote>,
  symbol: string,
  name: string,
): MarketItem | null {
  const quote = quotes.get(symbol);
  if (!quote || quote.code !== 0 || !quote.last || !quote.change) return null;
  const numericChange = Number(quote.change.replace(/,/g, ""));
  return {
    name,
    value: quote.last,
    change: quote.change,
    up:
      Number.isFinite(numericChange)
        ? numericChange >= 0
        : quote.changetype?.toUpperCase() === "UP",
  };
}

export async function fetchMarketSnapshot(
  fetchImpl: typeof fetch = fetch,
): Promise<MarketSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const params = new URLSearchParams({
      symbols: CNBC_SYMBOLS.join("|"),
      requestMethod: "quick",
      noform: "1",
      partnerId: "2",
      fund: "1",
      exthrs: "1",
      output: "json",
    });
    const response = await fetchImpl(`${CNBC_QUOTE_URL}?${params}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`[morning-report] CNBC quote feed returned ${response.status}`);
      return null;
    }
    const body = (await response.json()) as {
      FormattedQuoteResult?: { FormattedQuote?: CnbcQuote[] };
    };
    const quoteList = body.FormattedQuoteResult?.FormattedQuote ?? [];
    const quotes = new Map(
      quoteList
        .filter((quote): quote is CnbcQuote & { symbol: string } => Boolean(quote.symbol))
        .map((quote) => [quote.symbol, quote]),
    );
    const compact = (items: Array<MarketItem | null>) =>
      items.filter((item): item is MarketItem => item !== null);
    const allTimes = quoteList
      .map((quote) => (quote.last_time ? new Date(quote.last_time).getTime() : NaN))
      .filter(Number.isFinite);
    const latestTime = allTimes.length ? Math.max(...allTimes) : NaN;
    const asOf = Number.isFinite(latestTime)
      ? new Date(latestTime).toLocaleTimeString("en-US", {
          timeZone: LA_TIME_ZONE,
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        })
      : null;

    const snapshot: MarketSnapshot = {
      indices: compact([
        marketItem(quotes, ".DJI", "Dow Jones"),
        marketItem(quotes, ".SPX", "S&P 500"),
        marketItem(quotes, ".IXIC", "Nasdaq"),
      ]),
      commodities: compact([
        marketItem(quotes, "@GC.1", "Gold"),
        marketItem(quotes, "@CL.1", "Crude Oil WTI"),
      ]),
      currencies: compact([
        marketItem(quotes, "EUR=", "EUR/USD"),
        marketItem(quotes, "GBP=", "GBP/USD"),
        marketItem(quotes, "JPY=", "USD/JPY"),
      ]),
      asOf,
      source: "CNBC",
    };
    const itemCount =
      snapshot.indices.length + snapshot.commodities.length + snapshot.currencies.length;
    return itemCount > 0 ? snapshot : null;
  } catch (error) {
    console.error(
      "[morning-report] CNBC quote feed failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}