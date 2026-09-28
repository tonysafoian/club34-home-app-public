import { Router } from 'express';
import { logAudit } from '../lib/auditLog.js';
import {
  fetchGoogleDailyForecast,
  fetchGoogleHourlyForecast,
  googleTypeToWMO,
} from '../utils/google-weather.js';

const router = Router();

const HOME_LAT = 34.0522;
const HOME_LNG = -118.2437;

let cachedData: { data: unknown; expiresAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

router.post('/api/weather-dashboard', async (req: any, res: any) => {
  if (cachedData && Date.now() < cachedData.expiresAt) {
    return res.json(cachedData.data);
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;

  try {
    // --- Migrate from Open-Meteo 7-day daily → Google forecast/days:lookup (5 days) ---
    const forecastDays = await fetchGoogleDailyForecast(HOME_LAT, HOME_LNG, 5);

    const forecast = forecastDays.map((day: any) => {
      // Build YYYY-MM-DD string from displayDate { year, month, day }
      const d = day.displayDate ?? {};
      const date = d.year && d.month && d.day
        ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
        : '';
      const conditionType: string = day.daytimeForecast?.weatherCondition?.type ?? 'PARTLY_CLOUDY';
      return {
        date,
        tempMax: Math.round(day.maxTemperature?.degrees ?? 0),
        tempMin: Math.round(day.minTemperature?.degrees ?? 0),
        weatherCode: googleTypeToWMO(conditionType),
      };
    });

    const fetches: Promise<globalThis.Response>[] = [];

    if (apiKey) {
      fetches.push(
        fetch(`https://airquality.googleapis.com/v1/currentConditions:lookup?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: { latitude: HOME_LAT, longitude: HOME_LNG },
            extraComputations: ['HEALTH_RECOMMENDATIONS', 'DOMINANT_POLLUTANT_CONCENTRATION'],
            languageCode: 'en',
          }),
        }),
        fetch(`https://pollen.googleapis.com/v1/forecast:lookup?key=${apiKey}&location.latitude=${HOME_LAT}&location.longitude=${HOME_LNG}&days=5`),
        fetch(`https://weather.googleapis.com/v1/publicAlerts:lookup?key=${apiKey}&location.latitude=${HOME_LAT}&location.longitude=${HOME_LNG}&languageCode=en`),
      );
    }

    let airQuality: {
      aqi: unknown;
      category: unknown;
      displayName: unknown;
      dominantPollutant: unknown;
      color: unknown;
    } | null = null;
    let pollen = null;
    let pollenForecast: unknown[] = [];
    let weatherAlerts: unknown[] = [];
    let healthRecommendations = null;

    if (apiKey && fetches.length > 0) {
      const responses = await Promise.all(fetches);
      const [aqData, pollenData, alertsData] = await Promise.all([
        responses[0].json().catch(() => ({})),
        responses[1].json().catch(() => ({})),
        responses[2].json().catch(() => ({})),
      ]);

      if (aqData.indexes) {
        const usAqi = aqData.indexes.find((i: any) => i.code === 'usa_epa');
        const uaqi = aqData.indexes.find((i: any) => i.code === 'uaqi');
        const aqi = usAqi || uaqi || aqData.indexes[0] || null;
        if (aqi) {
          airQuality = {
            aqi: aqi.aqi, category: aqi.category, displayName: aqi.displayName,
            dominantPollutant: aqi.dominantPollutant, color: aqi.color,
          };
        }
      }
      healthRecommendations = aqData.healthRecommendations || null;

      if (pollenData.dailyInfo?.length > 0) {
        const todayPollen = pollenData.dailyInfo[0];
        pollen = (todayPollen.pollenTypeInfo || []).map((p: any) => ({
          type: p.displayName, index: p.indexInfo?.value ?? null,
          category: p.indexInfo?.category ?? 'Unknown', description: p.indexInfo?.indexDescription ?? null,
        }));
      }

      if (pollenData.dailyInfo?.length > 0) {
        pollenForecast = pollenData.dailyInfo.map((day: any) => ({
          date: day.date ? `${day.date.year}-${String(day.date.month).padStart(2, '0')}-${String(day.date.day).padStart(2, '0')}` : null,
          types: (day.pollenTypeInfo || []).map((p: any) => ({
            type: p.displayName, index: p.indexInfo?.value ?? null, category: p.indexInfo?.category ?? 'Unknown',
          })),
        }));
      }

      if (alertsData.weatherAlerts && Array.isArray(alertsData.weatherAlerts)) {
        weatherAlerts = alertsData.weatherAlerts.map((a: any) => ({
          id: a.alertId, title: a.alertTitle?.text ?? 'Weather Alert', eventType: a.eventType ?? null,
          severity: a.severity ?? null, urgency: a.urgency ?? null, description: a.description?.text ?? null,
          instruction: a.instruction?.text ?? null, senderName: a.dataSource?.name ?? null, expireTime: a.expireTime ?? null,
        }));
      }
    }

    const result = { forecast, airQuality, pollen, pollenForecast, weatherAlerts, healthRecommendations };
    cachedData = { data: result, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(result);
  } catch (err: any) {
    console.error('Weather dashboard error:', err);
    logAudit('weather-dashboard', {
      category: 'integration', event_type: 'weather_fetch_error', severity: 'error',
      actor_id: 'system', channel: 'cron',
      summary: `Weather dashboard fetch failed: ${err.message}`,
      detail: { error: err.message }, status: 'error',
    });
    res.status(500).json({ error: 'Failed to fetch weather data' });
  }
});

let cachedRadarData: { data: unknown; expiresAt: number } | null = null;
const RADAR_CACHE_TTL_MS = 10 * 60 * 1000;

router.get('/api/weather/radar-frames', async (_req: any, res: any) => {
  if (cachedRadarData && Date.now() < cachedRadarData.expiresAt) {
    return res.json(cachedRadarData.data);
  }

  try {
    const resp = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!resp.ok) throw new Error(`RainViewer API returned ${resp.status}`);
    const rainviewer: any = await resp.json();

    const pastFrames = (rainviewer?.radar?.past ?? []).map((f: any) => ({ ...f, isForecast: false }));
    const nowcastFrames = (rainviewer?.radar?.nowcast ?? []).map((f: any) => ({ ...f, isForecast: true }));
    const result = { past: pastFrames, nowcast: nowcastFrames };

    cachedRadarData = { data: result, expiresAt: Date.now() + RADAR_CACHE_TTL_MS };
    res.json(result);
  } catch (err: any) {
    console.error('Radar frames proxy error:', err);
    res.status(500).json({ error: 'Failed to fetch radar data' });
  }
});

let cachedForecastData: { data: unknown; expiresAt: number } | null = null;

router.post('/api/weather-forecast', async (_req: any, res: any) => {
  if (cachedForecastData && Date.now() < cachedForecastData.expiresAt) {
    return res.json(cachedForecastData.data);
  }

  try {
    // --- Migrate from Open-Meteo 7-day combined → Google forecast/hours:lookup + forecast/days:lookup ---
    const [forecastHours, forecastDays] = await Promise.all([
      fetchGoogleHourlyForecast(HOME_LAT, HOME_LNG, 24),
      fetchGoogleDailyForecast(HOME_LAT, HOME_LNG, 5),
    ]);

    // Build Open-Meteo-compatible response shape so the frontend keeps working
    const hourlyTime: string[] = forecastHours.map((h: any) => h.startTime ?? '');
    const hourlyTemp: number[] = forecastHours.map((h: any) => h.temperature?.degrees ?? 0);
    const hourlyWeatherCode: number[] = forecastHours.map((h: any) =>
      googleTypeToWMO(h.weatherCondition?.type ?? 'PARTLY_CLOUDY'),
    );
    const hourlyHumidity: number[] = forecastHours.map((h: any) => h.relativeHumidity ?? 0);
    const hourlyWindSpeed: number[] = forecastHours.map((h: any) => h.wind?.speed?.value ?? 0);
    const hourlyPrecipitation: number[] = forecastHours.map((h: any) =>
      h.precipitation?.qpf?.quantity ?? 0,
    );

    const dailyTime: string[] = forecastDays.map((day: any) => {
      const d = day.displayDate ?? {};
      return d.year && d.month && d.day
        ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
        : '';
    });
    const dailyTempMax: number[] = forecastDays.map((day: any) => day.maxTemperature?.degrees ?? 0);
    const dailyTempMin: number[] = forecastDays.map((day: any) => day.minTemperature?.degrees ?? 0);
    const dailyWeatherCode: number[] = forecastDays.map((day: any) =>
      googleTypeToWMO(day.daytimeForecast?.weatherCondition?.type ?? 'PARTLY_CLOUDY'),
    );
    // sunrise/sunset — Google returns ISO timestamp strings
    const dailySunrise: string[] = forecastDays.map((day: any) =>
      day.sunEvents?.sunriseTime ?? '',
    );
    const dailySunset: string[] = forecastDays.map((day: any) =>
      day.sunEvents?.sunsetTime ?? '',
    );
    // Google daily doesn't have a direct precipitation_sum — sum hourly qpf for each day
    const dailyPrecipSum: number[] = forecastDays.map((day: any, di: number) => {
      const dayStr = dailyTime[di];
      return forecastHours
        .filter((h: any) => (h.startTime ?? '').startsWith(dayStr))
        .reduce<number>((acc: number, h: any) => acc + (h.precipitation?.qpf?.quantity ?? 0), 0);
    });
    // Google daily doesn't have wind_speed_10m_max — take max from hourly wind for that day
    const dailyWindMax: number[] = forecastDays.map((day: any, di: number) => {
      const dayStr = dailyTime[di];
      const winds = forecastHours
        .filter((h: any) => (h.startTime ?? '').startsWith(dayStr))
        .map((h: any) => h.wind?.speed?.value ?? 0);
      return winds.length > 0 ? Math.max(...winds) : 0;
    });

    const data = {
      hourly: {
        time: hourlyTime,
        temperature_2m: hourlyTemp,
        weather_code: hourlyWeatherCode,
        relative_humidity_2m: hourlyHumidity,
        wind_speed_10m: hourlyWindSpeed,
        precipitation: hourlyPrecipitation,
      },
      daily: {
        time: dailyTime,
        temperature_2m_max: dailyTempMax,
        temperature_2m_min: dailyTempMin,
        weather_code: dailyWeatherCode,
        sunrise: dailySunrise,
        sunset: dailySunset,
        precipitation_sum: dailyPrecipSum,
        wind_speed_10m_max: dailyWindMax,
      },
    };

    cachedForecastData = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    res.json(data);
  } catch (err: any) {
    console.error('Weather forecast proxy error:', err);
    res.status(500).json({ error: 'Failed to fetch forecast data' });
  }
});

export default router;
