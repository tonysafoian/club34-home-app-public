import { useMemo } from 'react';
import { useToday } from '@/hooks/useToday';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Cloud, Sun, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, CloudFog, Loader2, Wind, Flower2, AlertTriangle, ShieldAlert, Info } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { apiClient } from '@/lib/apiClient';


const LAT = 34.0522;
const LON = -118.2437;

interface DayForecast {
  date: string;
  tempMax: number;
  tempMin: number;
  weatherCode: number;
}

interface AirQuality {
  aqi: number;
  category: string;
  displayName: string;
  dominantPollutant?: string;
}

interface PollenType {
  type: string;
  index: number | null;
  category: string;
}

interface WeatherAlert {
  id: string;
  title: string;
  eventType: string | null;
  severity: string | null;
  urgency: string | null;
  description: string | null;
  instruction: string | null;
  senderName: string | null;
  expireTime: string | null;
}

function weatherInfo(code: number): { icon: React.ReactNode; label: string } {
  if (code === 0) return { icon: <Sun className="h-4 w-4 text-yellow-500" />, label: 'Clear' };
  if (code <= 3) return { icon: <Cloud className="h-4 w-4 text-muted-foreground" />, label: 'Cloudy' };
  if (code <= 49) return { icon: <CloudFog className="h-4 w-4 text-muted-foreground" />, label: 'Fog' };
  if (code <= 59) return { icon: <CloudDrizzle className="h-4 w-4 text-blue-400" />, label: 'Drizzle' };
  if (code <= 69) return { icon: <CloudRain className="h-4 w-4 text-blue-500" />, label: 'Rain' };
  if (code <= 79) return { icon: <CloudSnow className="h-4 w-4 text-sky-300" />, label: 'Snow' };
  if (code <= 84) return { icon: <CloudRain className="h-4 w-4 text-blue-500" />, label: 'Showers' };
  if (code <= 94) return { icon: <CloudSnow className="h-4 w-4 text-sky-300" />, label: 'Snow' };
  return { icon: <CloudLightning className="h-4 w-4 text-yellow-400" />, label: 'Thunderstorm' };
}

function aqiColor(aqi: number): string {
  if (aqi <= 50) return 'text-green-500';
  if (aqi <= 100) return 'text-yellow-500';
  if (aqi <= 150) return 'text-orange-500';
  if (aqi <= 200) return 'text-red-500';
  return 'text-purple-500';
}

function pollenColor(category: string): string {
  const c = category.toLowerCase();
  if (c === 'none' || c === 'very low') return 'text-green-500';
  if (c === 'low') return 'text-yellow-500';
  if (c === 'moderate') return 'text-orange-500';
  if (c === 'high') return 'text-red-500';
  return 'text-purple-500';
}

export function WeatherStrip() {
  const navigate = useNavigate();

  const { data: weatherData, isLoading: loading } = useQuery({
    queryKey: ['weather-strip'],
    queryFn: async () => {
      return await apiClient.invokeFn<{
        forecast: DayForecast[];
        airQuality: AirQuality | null;
        pollen: PollenType[] | null;
        weatherAlerts: WeatherAlert[];
      }>('weather-dashboard', {});
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const forecast = weatherData?.forecast ?? null;
  const airQuality = weatherData?.airQuality ?? null;
  const pollen = weatherData?.pollen ?? null;
  const weatherAlerts = weatherData?.weatherAlerts ?? [];

  const todayDate = useToday();
  const today = useMemo(() => format(todayDate, 'yyyy-MM-dd'), [todayDate]);

  if (loading) {
    return (
      <div className="w-full border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="container flex items-center gap-2 py-2 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="text-xs">Loading weather…</span>
        </div>
      </div>
    );
  }

  if (!forecast) return null;


  const severityIcon = (severity: string | null) => {
    switch (severity?.toUpperCase()) {
      case 'EXTREME':
      case 'SEVERE':
        return <ShieldAlert className="h-4 w-4" />;
      case 'MODERATE':
        return <AlertTriangle className="h-4 w-4" />;
      default:
        return <Info className="h-4 w-4" />;
    }
  };

  const severityStyle = (severity: string | null) => {
    switch (severity?.toUpperCase()) {
      case 'EXTREME':
        return 'border-red-500/50 bg-red-500/10 text-red-400';
      case 'SEVERE':
        return 'border-orange-500/50 bg-orange-500/10 text-orange-400';
      case 'MODERATE':
        return 'border-yellow-500/50 bg-yellow-500/10 text-yellow-400';
      default:
        return 'border-blue-500/50 bg-blue-500/10 text-blue-400';
    }
  };

  return (
    <>
      <div
        className="sticky top-16 z-45 w-full border-b border-border/40 bg-background/80 backdrop-blur-xl cursor-pointer hover:bg-background/95 transition-colors"
        onClick={() => navigate('/weather')}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && navigate('/weather')}
      >
        <div className="container">
          <div className="flex gap-1.5 overflow-x-auto py-1.5 scrollbar-hide">
            {/* Air Quality chip */}
            {airQuality && (
              <div className="flex items-center gap-1.5 rounded-lg border border-border/30 bg-card/30 px-2.5 py-1.5 min-w-fit">
                <Wind className={`h-4 w-4 ${aqiColor(airQuality.aqi)}`} />
                <span className="text-[11px] font-medium text-muted-foreground">AQI</span>
                <span className={`text-xs font-semibold ${aqiColor(airQuality.aqi)}`}>{airQuality.aqi}</span>
              </div>
            )}

            {/* Pollen chips - all types */}
            {pollen?.map((p) => (
              <div key={p.type} className="flex items-center gap-1.5 rounded-lg border border-border/30 bg-card/30 px-2.5 py-1.5 min-w-fit">
                <Flower2 className={`h-3.5 w-3.5 ${pollenColor(p.category)}`} />
                <span className="text-[11px] font-medium text-muted-foreground">{p.type}</span>
                <span className={`text-xs font-semibold ${pollenColor(p.category)}`}>{p.index ?? 0}</span>
              </div>
            ))}

            {/* Weather forecast chips */}
            {forecast.map((day) => {
              const info = weatherInfo(day.weatherCode);
              const dayIsToday = day.date === today;
              return (
                <div
                  key={day.date}
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 min-w-fit transition-colors ${
                    dayIsToday
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border/30 bg-card/30'
                  }`}
                >
                  <span className={`text-[11px] font-medium ${dayIsToday ? 'text-primary' : 'text-muted-foreground'}`}>
                    {dayIsToday ? 'Today' : format(parseISO(day.date), 'EEE')}
                  </span>
                  {info.icon}
                  <span className="text-xs font-semibold">{day.tempMax}°</span>
                  <span className="text-[10px] text-muted-foreground">{day.tempMin}°</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Weather Alerts */}
      {weatherAlerts.length > 0 && (
        <div className="w-full border-b border-border/40 bg-background/80 backdrop-blur-xl">
          <div className="container py-2 space-y-1.5">
            {weatherAlerts.map((alert) => {
              // NWS alerts page filtered to our location (Los Angeles county / 90210)
              const alertUrl = `https://forecast.weather.gov/MapClick.php?lat=${LAT}&lon=${LON}`;
              
              return (
                <a
                  key={alert.id}
                  href={alertUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-opacity hover:opacity-80 ${severityStyle(alert.severity)}`}
                >
                  {severityIcon(alert.severity)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold underline decoration-current/30">{alert.title}</span>
                      {alert.severity && (
                        <span className="text-[10px] font-medium opacity-75 uppercase">{alert.severity}</span>
                      )}
                    </div>
                    {alert.description && (
                      <p className="text-[11px] opacity-80 mt-0.5 line-clamp-2">{alert.description}</p>
                    )}
                    {alert.senderName && (
                      <span className="text-[10px] opacity-60 mt-0.5 block">— {alert.senderName}</span>
                    )}
                  </div>
                  <svg className="h-3.5 w-3.5 mt-0.5 shrink-0 opacity-50" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.22 14.78a.75.75 0 001.06 0l7.22-7.22v5.69a.75.75 0 001.5 0v-7.5a.75.75 0 00-.75-.75h-7.5a.75.75 0 000 1.5h5.69l-7.22 7.22a.75.75 0 000 1.06z" clipRule="evenodd" />
                  </svg>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
