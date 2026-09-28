/// <reference types="google.maps" />
import { useEffect, useState, useRef, useCallback } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft, Cloud, Sun, CloudRain, CloudSnow, CloudLightning, CloudDrizzle, CloudFog,
  Loader2, Wind, Droplets, Thermometer, Flower2, ShieldAlert, AlertTriangle, Info,
  Play, Pause, SkipBack, SkipForward, Search, MapPin, Repeat, FastForward, Video,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { format, parseISO } from 'date-fns';
import { apiClient } from '@/lib/apiClient';
import { Slider } from '@/components/ui/slider';

// Window extensions for Google Maps dynamic script loading
type WindowWithGoogle = Window & { google?: typeof google };
type WindowWithCallbacks = Window & Record<string, unknown>;

const LAT = 34.0522;
const LNG = -118.2437;

interface RainViewerFrame {
  time: number;
  path: string;
  isForecast?: boolean;
}

interface HourlyForecast {
  time: string;
  temp: number;
  weatherCode: number;
  humidity: number;
  windSpeed: number;
  precipitation: number;
}

interface DayForecast {
  date: string;
  tempMax: number;
  tempMin: number;
  weatherCode: number;
  sunrise: string;
  sunset: string;
  precipSum: number;
  windMax: number;
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
  description?: string | null;
}

interface WeatherAlert {
  id: string;
  title: string;
  severity: string | null;
  description: string | null;
  senderName: string | null;
}

function weatherIcon(code: number, className = 'h-5 w-5') {
  if (code === 0) return <Sun className={`${className} text-yellow-500`} />;
  if (code <= 3) return <Cloud className={`${className} text-muted-foreground`} />;
  if (code <= 49) return <CloudFog className={`${className} text-muted-foreground`} />;
  if (code <= 59) return <CloudDrizzle className={`${className} text-blue-400`} />;
  if (code <= 69) return <CloudRain className={`${className} text-blue-500`} />;
  if (code <= 79) return <CloudSnow className={`${className} text-sky-300`} />;
  if (code <= 84) return <CloudRain className={`${className} text-blue-500`} />;
  if (code <= 94) return <CloudSnow className={`${className} text-sky-300`} />;
  return <CloudLightning className={`${className} text-yellow-400`} />;
}

function weatherLabel(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Cloudy';
  if (code <= 49) return 'Fog';
  if (code <= 59) return 'Drizzle';
  if (code <= 69) return 'Rain';
  if (code <= 79) return 'Snow';
  if (code <= 84) return 'Showers';
  if (code <= 94) return 'Snow';
  return 'Thunderstorm';
}

function aqiColor(aqi: number): string {
  if (aqi <= 50) return 'text-green-500';
  if (aqi <= 100) return 'text-yellow-500';
  if (aqi <= 150) return 'text-orange-500';
  if (aqi <= 200) return 'text-red-500';
  return 'text-purple-500';
}

function aqiBg(aqi: number): string {
  if (aqi <= 50) return 'bg-green-500/10 border-green-500/30';
  if (aqi <= 100) return 'bg-yellow-500/10 border-yellow-500/30';
  if (aqi <= 150) return 'bg-orange-500/10 border-orange-500/30';
  if (aqi <= 200) return 'bg-red-500/10 border-red-500/30';
  return 'bg-purple-500/10 border-purple-500/30';
}

function pollenColor(category: string): string {
  const c = category.toLowerCase();
  if (c === 'none' || c === 'very low') return 'text-green-500';
  if (c === 'low') return 'text-yellow-500';
  if (c === 'moderate') return 'text-orange-500';
  if (c === 'high') return 'text-red-500';
  return 'text-purple-500';
}

export default function Weather() {
  const navigate = useNavigate();
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<google.maps.Map | null>(null);
  const radarLayerRef = useRef<google.maps.ImageMapType | null>(null);

  const [hourly, setHourly] = useState<HourlyForecast[]>([]);
  const [daily, setDaily] = useState<DayForecast[]>([]);
  const [airQuality, setAirQuality] = useState<AirQuality | null>(null);
  const [pollen, setPollen] = useState<PollenType[]>([]);
  const [pollenForecast, setPollenForecast] = useState<{ date: string; types: { type: string; index: number | null; category: string }[] }[]>([]);
  const [alerts, setAlerts] = useState<WeatherAlert[]>([]);
  const [radarFrames, setRadarFrames] = useState<RainViewerFrame[]>([]);
  const [pastFrameCount, setPastFrameCount] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(true);
  const [playbackSpeed, setPlaybackSpeed] = useState(500);
  const [aerialView, setAerialView] = useState<{ state: string; uris?: Record<string, string | { landscapeUri?: string; portraitUri?: string }>; error?: unknown; metadata?: unknown } | null>(null);
  const [aerialLoading, setAerialLoading] = useState(false);
  const [aerialVideoId, setAerialVideoId] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchMarkerRef = useRef<google.maps.Marker | null>(null);
  const geocoderRef = useRef<google.maps.Geocoder | null>(null);
  const homeMarkerRef = useRef<google.maps.Marker | null>(null);

  const [weatherLoading, setWeatherLoading] = useState(true);
  const [envLoading, setEnvLoading] = useState(true);
  const [radarLoading, setRadarLoading] = useState(true);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [envError, setEnvError] = useState<string | null>(null);
  const [radarError, setRadarError] = useState<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  const fetchWeatherData = useCallback(async () => {
    setWeatherLoading(true);
    setWeatherError(null);
    setHourly([]);
    setDaily([]);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const weather = await apiClient.invokeFn<any>('weather-forecast');

      const now = new Date();
      const hourlyData: HourlyForecast[] = weather.hourly.time
        .map((t: string, i: number) => ({
          time: t,
          temp: Math.round(weather.hourly.temperature_2m[i]),
          weatherCode: weather.hourly.weather_code[i],
          humidity: weather.hourly.relative_humidity_2m[i],
          windSpeed: Math.round(weather.hourly.wind_speed_10m[i]),
          precipitation: weather.hourly.precipitation[i],
        }))
        .filter((h: HourlyForecast) => new Date(h.time) >= now)
        .slice(0, 24);
      setHourly(hourlyData);

      const dailyData: DayForecast[] = weather.daily.time.map((d: string, i: number) => ({
        date: d,
        tempMax: Math.round(weather.daily.temperature_2m_max[i]),
        tempMin: Math.round(weather.daily.temperature_2m_min[i]),
        weatherCode: weather.daily.weather_code[i],
        sunrise: weather.daily.sunrise[i],
        sunset: weather.daily.sunset[i],
        precipSum: weather.daily.precipitation_sum[i],
        windMax: Math.round(weather.daily.wind_speed_10m_max[i]),
      }));
      setDaily(dailyData);
    } catch (err) {
      console.error('Weather fetch error:', err);
      setWeatherError('Failed to load forecast data');
    } finally {
      setWeatherLoading(false);
    }
  }, []);

  const fetchEnvData = useCallback(async () => {
    setEnvLoading(true);
    setEnvError(null);
    setAirQuality(null);
    setPollen([]);
    setPollenForecast([]);
    setAlerts([]);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const envData = await apiClient.invokeFn<any>('google-environment-proxy', {});
      if (envData?.airQuality) setAirQuality(envData.airQuality);
      if (envData?.pollen) setPollen(envData.pollen);
      if (envData?.pollenForecast) setPollenForecast(envData.pollenForecast);
      if (envData?.weatherAlerts) setAlerts(envData.weatherAlerts);
    } catch (err) {
      console.error('Environment fetch error:', err);
      setEnvError('Failed to load air quality & pollen data');
    } finally {
      setEnvLoading(false);
    }
  }, []);

  const fetchRadarFrames = useCallback(async () => {
    setRadarLoading(true);
    setRadarError(null);
    setRadarFrames([]);
    setPastFrameCount(0);
    setFrameIndex(0);
    try {
      const resp = await fetch('/api/weather/radar-frames');
      if (!resp.ok) throw new Error(`Radar frames API returned ${resp.status}`);
      const data = await resp.json();
      if (data?.past) {
        const pastFrames = (data.past as RainViewerFrame[]);
        const nowcastFrames = (data.nowcast || []) as RainViewerFrame[];
        const all = [...pastFrames, ...nowcastFrames];
        setRadarFrames(all);
        setPastFrameCount(pastFrames.length);
        setFrameIndex(pastFrames.length - 1);
      }
    } catch (err) {
      console.error('Radar fetch error:', err);
      setRadarError('Failed to load radar data');
    } finally {
      setRadarLoading(false);
    }
  }, []);

  const fetchAerialView = useCallback(async () => {
    setAerialLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await apiClient.invokeFn<any>('google-environment-proxy', { action: 'aerial-view' });
      setAerialView(data);

      const vid = data?.metadata?.videoId;
      if (vid) setAerialVideoId(vid);

      if (data?.state === 'PROCESSING' && vid) {
        let attempts = 0;
        const maxAttempts = 12;
        const pollInterval = setInterval(async () => {
          attempts++;
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pollData = await apiClient.invokeFn<any>('google-environment-proxy', { action: 'aerial-view-poll', videoId: vid });
            setAerialView(pollData);
            if (pollData?.state === 'ACTIVE' || attempts >= maxAttempts) {
              clearInterval(pollInterval);
            }
          } catch (e) {
            console.error('Weather parse error:', e);
            clearInterval(pollInterval);
          }
        }, 5000);
      }
    } catch (err) {
      console.error('Aerial view error:', err);
      setAerialView({ state: 'ERROR' });
    } finally {
      setAerialLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWeatherData();
    fetchEnvData();
    fetchRadarFrames();
    fetchAerialView();
  }, [fetchWeatherData, fetchEnvData, fetchRadarFrames, fetchAerialView]);

  const mapRetryCountRef = useRef(0);

  const retryMap = useCallback(() => {
    setMapError(null);
    mapRetryCountRef.current = 0;
    mapInstanceRef.current = null;

    if ((window as WindowWithGoogle).google?.maps) {
      const div = mapRef.current;
      if (div && div.offsetWidth > 0) {
        try {
          const map = new google.maps.Map(div, {
            center: { lat: LAT, lng: LNG },
            zoom: 8,
            mapTypeId: 'roadmap',
            disableDefaultUI: false,
            zoomControl: true,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            gestureHandling: 'greedy',
            styles: [
              { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
              { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a2e' }] },
              { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a9a' }] },
              { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1a2b' }] },
              { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a3e' }] },
            ],
          });
          mapInstanceRef.current = map;
          homeMarkerRef.current = new google.maps.Marker({
            position: { lat: LAT, lng: LNG },
            map,
            title: 'Home',
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#3b82f6', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
          });
          geocoderRef.current = new google.maps.Geocoder();
          setMapLoaded(true);
        } catch (err) {
          setMapError('Failed to initialize the map');
        }
      } else {
        setMapError('Map container not available');
      }
    } else {
      window.location.reload();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout>;
    mapRetryCountRef.current = 0;

    const initMap = () => {
      if (cancelled) return;
      const div = mapRef.current;
      if (!div || div.offsetWidth === 0) {
        mapRetryCountRef.current += 1;
        if (mapRetryCountRef.current > 50) {
          setMapError('Map container failed to initialize');
          return;
        }
        retryTimeout = setTimeout(initMap, 100);
        return;
      }
      if (mapInstanceRef.current) return;

      try {
        const map = new google.maps.Map(div, {
          center: { lat: LAT, lng: LNG },
          zoom: 8,
          mapTypeId: 'roadmap',
          disableDefaultUI: false,
          zoomControl: true,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: true,
          gestureHandling: 'greedy',
          styles: [
            { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
            { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a2e' }] },
            { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a9a' }] },
            { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1a2b' }] },
            { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a3e' }] },
          ],
        });
        mapInstanceRef.current = map;

        homeMarkerRef.current = new google.maps.Marker({
          position: { lat: LAT, lng: LNG },
          map,
          title: 'Home',
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: '#3b82f6',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
          },
        });

        geocoderRef.current = new google.maps.Geocoder();
        setMapLoaded(true);
        setMapError(null);
      } catch (err) {
        console.error('Map initialization error:', err);
        setMapError('Failed to initialize the map');
      }
    };

    if ((window as WindowWithGoogle).google?.maps) {
      initMap();
      return () => { cancelled = true; clearTimeout(retryTimeout); };
    }

    const loadMapsScript = async () => {
      try {
        if (cancelled) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = await apiClient.invokeFn<any>('google-environment-proxy', { action: 'api-key' });
        if (!data?.api_key) {
          if (!cancelled) setMapError('Could not retrieve Maps API key');
          return;
        }
        if (cancelled) return;

        const callbackName = `__mapsInit_${Date.now()}`;
        (window as unknown as WindowWithCallbacks)[callbackName] = () => {
          delete (window as unknown as WindowWithCallbacks)[callbackName];
          initMap();
        };

        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${data.api_key}&libraries=places&callback=${callbackName}`;
        script.async = true;
        script.defer = true;
        script.onerror = () => {
          delete (window as unknown as WindowWithCallbacks)[callbackName];
          if (!cancelled) setMapError('Failed to load Google Maps script');
        };
        document.head.appendChild(script);
      } catch (err) {
        console.error('Failed to load Google Maps:', err);
        if (!cancelled) setMapError('Failed to load Google Maps');
      }
    };

    loadMapsScript();
    return () => { cancelled = true; clearTimeout(retryTimeout); };
  }, []);

  // Search for address
  const handleSearch = useCallback(() => {
    if (!geocoderRef.current || !mapInstanceRef.current || !searchQuery.trim()) return;
    geocoderRef.current.geocode({ address: searchQuery }, (results, status) => {
      if (status === 'OK' && results?.[0]) {
        const loc = results[0].geometry.location;
        mapInstanceRef.current?.panTo(loc);
        mapInstanceRef.current?.setZoom(10);
        
        // Remove old search marker
        searchMarkerRef.current?.setMap(null);
        
        searchMarkerRef.current = new google.maps.Marker({
          position: loc,
          map: mapInstanceRef.current!,
          title: results[0].formatted_address,
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 6,
            fillColor: '#f59e0b',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
          },
        });
      }
    });
  }, [searchQuery]);

  const goHome = useCallback(() => {
    mapInstanceRef.current?.panTo({ lat: LAT, lng: LNG });
    mapInstanceRef.current?.setZoom(8);
    searchMarkerRef.current?.setMap(null);
    setSearchQuery('');
  }, []);

  // Update radar overlay when frame changes
  const updateRadarLayer = useCallback((idx: number) => {
    const map = mapInstanceRef.current;
    if (!map || radarFrames.length === 0) return;

    // Remove old layer
    if (radarLayerRef.current) {
      map.overlayMapTypes.clear();
    }

    const frame = radarFrames[idx];
    if (!frame) return;

    const tileLayer = new google.maps.ImageMapType({
      getTileUrl: (coord, zoom) => {
        return `https://tilecache.rainviewer.com${frame.path}/256/${zoom}/${coord.x}/${coord.y}/6/1_1.png`;
      },
      tileSize: new google.maps.Size(256, 256),
      opacity: 0.75,
      name: 'Radar',
    });

    map.overlayMapTypes.push(tileLayer);
    radarLayerRef.current = tileLayer;
  }, [radarFrames]);

  useEffect(() => {
    if (mapLoaded) updateRadarLayer(frameIndex);
  }, [frameIndex, mapLoaded, updateRadarLayer]);

  // Animation playback
  useEffect(() => {
    if (!playing || radarFrames.length === 0) return;
    const interval = setInterval(() => {
      setFrameIndex(prev => {
        const next = prev + 1;
        if (next >= radarFrames.length) {
          if (looping) return 0;
          setPlaying(false);
          return prev;
        }
        return next;
      });
    }, playbackSpeed);
    return () => clearInterval(interval);
  }, [playing, radarFrames.length, looping, playbackSpeed]);

  // Auto-start playback once frames are loaded and map is ready
  useEffect(() => {
    if (radarFrames.length > 0 && mapLoaded) {
      setPlaying(true);
    }
  }, [radarFrames.length, mapLoaded]);

  const currentFrame = radarFrames[frameIndex];
  const frameTime = currentFrame
    ? format(new Date(currentFrame.time * 1000), 'h:mm a')
    : '';
  const isForecastFrame = currentFrame?.isForecast ?? false;

  const today = format(new Date(), 'yyyy-MM-dd');

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold font-display">Weather</h1>
            <p className="text-xs text-muted-foreground">Local · Live Radar & Forecast</p>
          </div>
        </div>
      </header>

      <ErrorBoundary name="weather">
      <main className="container py-6 space-y-6">
        {/* Weather Alerts */}
        {alerts.length > 0 && (
          <div className="space-y-2">
            {alerts.map((alert) => (
              <a
                key={alert.id}
                href={`https://forecast.weather.gov/MapClick.php?lat=${LAT}&lon=${LNG}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2.5 rounded-lg border px-3 py-2.5 border-orange-500/50 bg-orange-500/10 text-orange-400 hover:opacity-80 transition-opacity"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-semibold">{alert.title}</span>
                  {alert.description && <p className="text-xs opacity-80 mt-0.5 line-clamp-3">{alert.description}</p>}
                </div>
              </a>
            ))}
          </div>
        )}

        {/* Doppler Radar Map */}
        <ErrorBoundary name="radar-map">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <CloudRain className="h-4 w-4 text-blue-500" />
                Doppler Radar
                {isForecastFrame && (
                  <Badge variant="outline" className="text-[10px] h-5 px-1.5 border-primary/40 text-primary animate-pulse">
                    FORECAST
                  </Badge>
                )}
              </CardTitle>
              <Button variant="ghost" size="sm" className="text-xs gap-1" onClick={goHome}>
                <MapPin className="h-3 w-3" /> Home
              </Button>
            </div>
            {/* Address search */}
            <div className="flex gap-2 mt-2">
              <Input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Search address or city..."
                className="text-sm h-9"
              />
              <Button size="sm" variant="secondary" className="h-9 px-3" onClick={handleSearch}>
                <Search className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {mapError ? (
              <div className="w-full h-[400px] rounded-lg overflow-hidden border border-border/50 flex flex-col items-center justify-center bg-muted/20 gap-3">
                <AlertTriangle className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">{mapError}</p>
                <Button variant="outline" size="sm" onClick={retryMap} data-testid="button-retry-map">
                  Retry
                </Button>
              </div>
            ) : (
              <div
                ref={mapRef}
                className="w-full h-[400px] rounded-lg overflow-hidden border border-border/50"
              />
            )}

            {radarLoading && (
              <div className="flex items-center justify-center gap-2 py-4">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading radar data…</span>
              </div>
            )}

            {radarError && (
              <div className="flex flex-col items-center gap-2 py-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4">
                <p className="text-sm text-destructive">{radarError}</p>
                <Button variant="outline" size="sm" onClick={fetchRadarFrames} data-testid="button-retry-radar">
                  Retry
                </Button>
              </div>
            )}

            {!radarError && radarFrames.length > 0 && (
              <div className="space-y-2">
                {/* Timeline scrubber with past/future marker */}
                <div className="relative">
                  <Slider
                    value={[frameIndex]}
                    min={0}
                    max={radarFrames.length - 1}
                    step={1}
                    onValueChange={([v]) => { setFrameIndex(v); setPlaying(false); }}
                    className="flex-1"
                  />
                  {/* "Now" marker on the slider track */}
                  {pastFrameCount > 0 && radarFrames.length > pastFrameCount && (
                    <div
                      className="absolute top-0 h-5 w-px bg-primary pointer-events-none"
                      style={{ left: `${((pastFrameCount - 1) / (radarFrames.length - 1)) * 100}%` }}
                    >
                      <span className="absolute -top-4 left-1/2 -translate-x-1/2 text-[9px] font-bold text-primary uppercase tracking-wider">Now</span>
                    </div>
                  )}
                </div>

                {/* Controls row */}
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setFrameIndex(0); setPlaying(false); }}>
                      <SkipBack className="h-4 w-4" />
                    </Button>
                    <Button variant={playing ? "default" : "ghost"} size="icon" className="h-8 w-8" onClick={() => setPlaying(!playing)}>
                      {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => { setFrameIndex(radarFrames.length - 1); setPlaying(false); }}>
                      <SkipForward className="h-4 w-4" />
                    </Button>
                  </div>

                  {/* Timestamp display */}
                  <div className="flex flex-col items-center">
                    <span className={`text-sm font-mono font-semibold tabular-nums ${isForecastFrame ? 'text-primary' : 'text-foreground'}`}>
                      {frameTime}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {isForecastFrame ? 'Predicted' : 'Observed'}
                    </span>
                  </div>

                  {/* Loop & speed controls */}
                  <div className="flex items-center gap-1">
                    <Button
                      variant={looping ? "secondary" : "ghost"}
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setLooping(!looping)}
                      title={looping ? 'Loop on' : 'Loop off'}
                    >
                      <Repeat className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setPlaybackSpeed(prev => prev === 200 ? 500 : prev === 500 ? 800 : 200)}
                      title={`Speed: ${playbackSpeed === 200 ? '2x' : playbackSpeed === 500 ? '1x' : '0.5x'}`}
                    >
                      <FastForward className="h-3.5 w-3.5" />
                    </Button>
                    <span className="text-[10px] text-muted-foreground w-6 text-center">
                      {playbackSpeed === 200 ? '2×' : playbackSpeed === 500 ? '1×' : '½×'}
                    </span>
                  </div>
                </div>

                {/* Precipitation status badge */}
                {(() => {
                  const currentHourPrecip = hourly[0]?.precipitation ?? 0;
                  const hasPrecip = hourly.slice(0, 6).some(h => h.precipitation > 0);
                  return (
                    <div className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${hasPrecip ? 'border-blue-500/40 bg-blue-500/10 text-blue-400' : 'border-border/40 bg-muted/30 text-muted-foreground'}`}>
                      <div className={`h-1.5 w-1.5 rounded-full ${hasPrecip ? 'bg-blue-400 animate-pulse' : 'bg-muted-foreground/40'}`} />
                      {hasPrecip ? 'Precipitation detected nearby' : 'No precipitation — clear skies'}
                    </div>
                  );
                })()}

                {/* Precipitation legend */}
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-[10px] text-muted-foreground">Light</span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden flex">
                    <div className="flex-1 bg-[#00ff00]/50" />
                    <div className="flex-1 bg-[#ffff00]/50" />
                    <div className="flex-1 bg-[#ff8800]/50" />
                    <div className="flex-1 bg-[#ff0000]/50" />
                    <div className="flex-1 bg-[#cc00cc]/50" />
                  </div>
                  <span className="text-[10px] text-muted-foreground">Heavy</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
        </ErrorBoundary>

        {/* Hourly Forecast */}
        <ErrorBoundary name="hourly-forecast">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Thermometer className="h-4 w-4 text-primary" />
              Next 24 Hours
            </CardTitle>
          </CardHeader>
          <CardContent>
            {weatherLoading && (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading forecast…</span>
              </div>
            )}
            {weatherError && !weatherLoading && (
              <div className="flex flex-col items-center gap-2 py-6">
                <p className="text-sm text-destructive">{weatherError}</p>
                <Button variant="outline" size="sm" onClick={fetchWeatherData} data-testid="button-retry-hourly">
                  Retry
                </Button>
              </div>
            )}
            {!weatherLoading && !weatherError && hourly.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">No hourly data available</p>
            )}
            {!weatherLoading && !weatherError && hourly.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                {hourly.map((h) => (
                  <div key={h.time} className="flex flex-col items-center gap-1 min-w-[60px] rounded-lg border border-border/30 bg-card/30 px-2 py-2">
                    <span className="text-[10px] text-muted-foreground">{format(new Date(h.time), 'h a')}</span>
                    {weatherIcon(h.weatherCode, 'h-4 w-4')}
                    <span className="text-sm font-semibold">{h.temp}°</span>
                    <div className="flex items-center gap-0.5">
                      <Droplets className="h-2.5 w-2.5 text-blue-400" />
                      <span className="text-[9px] text-muted-foreground">{h.humidity}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        </ErrorBoundary>

        {/* Air Quality & Pollen */}
        <ErrorBoundary name="air-quality-pollen">
        {envLoading && (
          <Card>
            <CardContent className="py-8">
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading air quality & pollen…</span>
              </div>
            </CardContent>
          </Card>
        )}
        {envError && !envLoading && (
          <Card>
            <CardContent className="py-6">
              <div className="flex flex-col items-center gap-2">
                <p className="text-sm text-destructive">{envError}</p>
                <Button variant="outline" size="sm" onClick={fetchEnvData} data-testid="button-retry-env">
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
        {!envLoading && !envError && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {airQuality && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Wind className="h-4 w-4 text-primary" />
                    Air Quality
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className={`rounded-xl border p-4 text-center ${aqiBg(airQuality.aqi)}`}>
                    <p className={`text-4xl font-bold ${aqiColor(airQuality.aqi)}`}>{airQuality.aqi}</p>
                    <p className="text-sm font-medium mt-1">{airQuality.category}</p>
                    {airQuality.dominantPollutant && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Dominant: {airQuality.dominantPollutant}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {pollen.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Flower2 className="h-4 w-4 text-primary" />
                    Pollen
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {pollen.map((p) => (
                      <div key={p.type} className="flex items-center justify-between">
                        <span className="text-sm">{p.type}</span>
                        <div className="flex items-center gap-2">
                          <div className={`h-2.5 w-2.5 rounded-full ${pollenColor(p.category).replace('text-', 'bg-')}`} />
                          <span className={`text-sm font-semibold ${pollenColor(p.category)}`}>{p.index ?? 0}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* 5-Day Pollen Forecast */}
        {!envLoading && !envError && pollenForecast.length > 1 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Flower2 className="h-4 w-4 text-primary" />
                Pollen Forecast
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {pollenForecast.map((day, i) => {
                  const isToday = day.date === today;
                  return (
                    <div
                      key={day.date || i}
                      className={`flex items-center gap-4 rounded-lg border px-4 py-3 ${
                        isToday ? 'border-primary/40 bg-primary/5' : 'border-border/30 bg-card/30'
                      }`}
                    >
                      <span className="text-sm font-medium w-16">
                        {isToday ? 'Today' : day.date ? format(parseISO(day.date), 'EEE') : `Day ${i + 1}`}
                      </span>
                      <div className="flex-1 flex items-center gap-4">
                        {day.types.map((t) => (
                          <div key={t.type} className="flex items-center gap-1.5">
                            <span className="text-xs text-muted-foreground">{t.type}</span>
                            <div className={`h-2 w-2 rounded-full ${pollenColor(t.category).replace('text-', 'bg-')}`} />
                            <span className={`text-sm font-semibold ${pollenColor(t.category)}`}>{t.index ?? 0}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}
        </ErrorBoundary>

        {/* 7-Day Forecast */}
        <ErrorBoundary name="7-day-forecast">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">7-Day Forecast</CardTitle>
          </CardHeader>
          <CardContent>
            {weatherLoading && (
              <div className="flex items-center justify-center gap-2 py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading forecast…</span>
              </div>
            )}
            {weatherError && !weatherLoading && (
              <div className="flex flex-col items-center gap-2 py-6">
                <p className="text-sm text-destructive">{weatherError}</p>
                <Button variant="outline" size="sm" onClick={fetchWeatherData} data-testid="button-retry-daily">
                  Retry
                </Button>
              </div>
            )}
            {!weatherLoading && !weatherError && daily.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">No daily forecast available</p>
            )}
            {!weatherLoading && !weatherError && daily.length > 0 && (
              <div className="space-y-2">
                {daily.map((d) => {
                  const isToday = d.date === today;
                  return (
                    <div
                      key={d.date}
                      className={`flex items-center gap-4 rounded-lg border px-4 py-3 ${
                        isToday ? 'border-primary/40 bg-primary/5' : 'border-border/30 bg-card/30'
                      }`}
                    >
                      <span className="text-sm font-medium w-16">
                        {isToday ? 'Today' : format(parseISO(d.date), 'EEE')}
                      </span>
                      {weatherIcon(d.weatherCode)}
                      <span className="text-xs text-muted-foreground w-16">{weatherLabel(d.weatherCode)}</span>
                      <div className="flex-1 flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">{d.tempMin}°</span>
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-blue-400 to-orange-400"
                            style={{ width: `${((d.tempMax - d.tempMin) / 40) * 100}%`, marginLeft: `${((d.tempMin - 40) / 80) * 100}%` }}
                          />
                        </div>
                        <span className="text-sm font-semibold">{d.tempMax}°</span>
                      </div>
                      <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Wind className="h-3 w-3" /> {d.windMax} mph
                        </span>
                        {d.precipSum > 0 && (
                          <span className="flex items-center gap-1">
                            <Droplets className="h-3 w-3" /> {d.precipSum.toFixed(2)}"
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        </ErrorBoundary>

        {/* Aerial View */}
        <ErrorBoundary name="aerial-view">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Video className="h-4 w-4 text-primary" />
              Aerial View
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={aerialLoading}
                onClick={fetchAerialView}
              >
                {aerialLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Load Aerial View
              </Button>

              {/* Check Again button for when polling timed out but video may be ready now */}
              {aerialVideoId && aerialView?.state === 'PROCESSING' && !aerialLoading && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setAerialLoading(true);
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const data = await apiClient.invokeFn<any>('google-environment-proxy', { action: 'aerial-view-poll', videoId: aerialVideoId });
                      setAerialView(data);
                    } catch (err) {
                      console.error('Aerial poll error:', err);
                    } finally {
                      setAerialLoading(false);
                    }
                  }}
                >
                  Check Again
                </Button>
              )}
            </div>

            {aerialView && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Status:</span>
                  <Badge variant={aerialView.state === 'ACTIVE' ? 'default' : 'outline'}>
                    {aerialView.state || 'UNKNOWN'}
                  </Badge>
                  {aerialView.state === 'PROCESSING' && (
                    <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  )}
                </div>
                {aerialView.state === 'PROCESSING' && (
                  <p className="text-xs text-muted-foreground">
                    Google is rendering the aerial video — this can take several minutes for a new address. Use "Check Again" to re-poll.
                  </p>
                )}
                {aerialView.uris && (
                  <div className="space-y-2">
                    {Object.entries(aerialView.uris).map(([key, uriEntry]) => {
                      const src = typeof uriEntry === 'string' ? uriEntry : (uriEntry?.landscapeUri || uriEntry?.portraitUri || '');
                      if (!src) return null;
                      return (
                        <div key={key}>
                          <span className="text-xs text-muted-foreground block mb-1">{key}</span>
                          {key.includes('IMAGE') ? (
                            <img src={src} alt={key} className="rounded-lg w-full max-h-64 object-cover" />
                          ) : key.includes('MP4') ? (
                            <video src={src} controls className="rounded-lg w-full max-h-64" />
                          ) : (
                            <a href={src} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline break-all">{src}</a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {aerialView.error && (
                  <p className="text-xs text-destructive">{JSON.stringify(aerialView.error)}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
        </ErrorBoundary>
      </main>
      </ErrorBoundary>
    </div>
  );
}
