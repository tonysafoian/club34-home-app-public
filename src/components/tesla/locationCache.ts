const LOCATION_CACHE_KEY = 'tesla_last_known_locations';

export interface CachedLocation {
  name: string;
  lat: number;
  lng: number;
  cachedAt: string;
}

export function getCachedLocations(): Record<number, CachedLocation> {
  try {
    const raw = localStorage.getItem(LOCATION_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function cacheLocation(id: number, name: string, lat: number, lng: number) {
  const cached = getCachedLocations();
  cached[id] = { name, lat, lng, cachedAt: new Date().toISOString() };
  localStorage.setItem(LOCATION_CACHE_KEY, JSON.stringify(cached));
}
