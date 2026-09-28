import { describe, expect, it, vi } from "vitest";
import {
  buildWeatherSourceData,
  extractWeatherData,
  fetchMarketSnapshot,
  fetchOpenMeteoWeather,
  formatWeatherForAI,
} from "../../services/morningReportData.js";

describe("morning report weather data", () => {
  const hours = Array.from({ length: 13 }, (_, index) => {
    const hour = index + 7;
    return {
      startTime: `2026-09-08T${String(hour).padStart(2, "0")}:00:00-07:00`,
      temperature: { degrees: 70 + index },
      feelsLikeTemperature: { degrees: 69 + index },
      precipitation: { probability: { percent: index === 5 ? 60 : 5 } },
      weatherCondition: { type: index === 5 ? "RAIN" : "CLEAR" },
      wind: { speed: { value: 3 } },
      uvIndex: index,
    };
  });

  it("matches forecast slots by local clock time instead of array position", () => {
    const source = buildWeatherSourceData(hours, {
      currentTime: "2026-09-08T07:05:00-07:00",
      temperature: { degrees: 68 },
      feelsLikeTemperature: { degrees: 68 },
      weatherCondition: { type: "CLEAR" },
    });
    expect(source).not.toBeNull();

    const extracted = extractWeatherData(
      source!,
      new Date("2026-09-08T07:05:00-07:00"),
    );

    expect(extracted.current).toMatchObject({ temp: 68, feels: 68 });
    expect(extracted.slots).toEqual([
      { hour: 8, code: 0, temp: 71, precip: 5 },
      { hour: 12, code: 63, temp: 75, precip: 60 },
      { hour: 15, code: 0, temp: 78, precip: 5 },
      { hour: 19, code: 0, temp: 82, precip: 5 },
    ]);
  });

  it("formats the actual local forecast hours rather than shifted indexes", () => {
    const source = buildWeatherSourceData(hours, null);
    const summary = formatWeatherForAI(
      source!,
      new Date("2026-09-08T07:05:00-07:00"),
    );

    expect(summary).toContain("08:00: 71°F");
    expect(summary).toContain("12:00: 75°F");
    expect(summary).not.toContain("08:00: 78°F");
  });

  it("returns no fabricated 70-degree fallback when weather is unavailable", () => {
    expect(buildWeatherSourceData([], null)).toBeNull();
  });

  it("uses timestamped Open-Meteo data as a real provider fallback", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          utc_offset_seconds: -25200,
          current: {
            time: "2026-09-08T07:15",
            temperature_2m: 79.1,
            apparent_temperature: 77.5,
            weather_code: 0,
          },
          hourly: {
            time: ["2026-09-08T08:00", "2026-09-08T12:00", "2026-09-08T15:00", "2026-09-08T19:00"],
            temperature_2m: [83.9, 93.9, 95.3, 92.9],
            apparent_temperature: [84.2, 99.5, 95.6, 92.8],
            precipitation_probability: [1, 1, 3, 2],
            weather_code: [0, 2, 3, 0],
            wind_speed_10m: [2, 4, 6, 3],
            uv_index: [1, 7, 5, 0],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const source = await fetchOpenMeteoWeather(34.0522, -118.2437, fetchImpl);
    const extracted = extractWeatherData(
      source!,
      new Date("2026-09-08T07:15:00-07:00"),
    );

    expect(source?.source).toBe("Open-Meteo");
    expect(source?.current?.observedAt).toBe("2026-09-08T07:15-07:00");
    expect(extracted.current?.temp).toBe(79);
    expect(extracted.slots.map((slot) => slot.temp)).toEqual([84, 94, 95, 93]);
  });
});

describe("morning report market data", () => {
  it("maps live quote fields without asking an AI to invent values", async () => {
    const response = {
      FormattedQuoteResult: {
        FormattedQuote: [
          {
            symbol: ".DJI",
            code: 0,
            last: "52,808.45",
            change: "-605.80",
            changetype: "DOWN",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
          {
            symbol: ".SPX",
            code: 0,
            last: "7,680.96",
            change: "-37.64",
            changetype: "DOWN",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
          {
            symbol: ".IXIC",
            code: 0,
            last: "26,372.552",
            change: "-134.438",
            changetype: "DOWN",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
          {
            symbol: "@GC.1",
            code: 0,
            last: "4,450.10",
            change: "-26.50",
            changetype: "DOWN",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
          {
            symbol: "@CL.1",
            code: 0,
            last: "93.22",
            change: "+1.74",
            changetype: "UP",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
          {
            symbol: "EUR=",
            code: 0,
            last: "1.1624",
            change: "+0.0003",
            changetype: "UP",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
          {
            symbol: "GBP=",
            code: 0,
            last: "1.355",
            change: "+0.0012",
            changetype: "UP",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
          {
            symbol: "JPY=",
            code: 0,
            last: "153.88",
            change: "-0.47",
            changetype: "DOWN",
            last_time: "2026-09-08T10:07:17.000-0400",
          },
        ],
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const snapshot = await fetchMarketSnapshot(fetchImpl);

    expect(snapshot?.indices).toEqual([
      { name: "Dow Jones", value: "52,808.45", change: "-605.80", up: false },
      { name: "S&P 500", value: "7,680.96", change: "-37.64", up: false },
      { name: "Nasdaq", value: "26,372.552", change: "-134.438", up: false },
    ]);
    expect(snapshot?.commodities[1]).toEqual({
      name: "Crude Oil WTI",
      value: "93.22",
      change: "+1.74",
      up: true,
    });
    expect(snapshot?.currencies).toHaveLength(3);
    expect(snapshot?.asOf).toBe("7:07 AM PDT");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});