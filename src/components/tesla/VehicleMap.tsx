import { useEffect, useRef, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MapPin, Navigation, Clock, Car, AlertTriangle, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';

const HOME_LAT = 34.1138;
const HOME_LNG = -118.4189;
const AT_HOME_THRESHOLD_MILES = 0.5;

const VEHICLE_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'];

interface VehicleLocation {
  id: number;
  name: string;
  lat: number;
  lng: number;
}

interface DistanceInfo {
  distance: string;
  duration: string;
  atHome: boolean;
}

interface DistanceElement {
  status: string;
  distance: { text: string };
  duration: { text: string };
}

interface DistanceResponse {
  rows?: { elements: DistanceElement[] }[];
}

/* Google Maps & Leaflet are loaded dynamically from CDN and ship no bundled types. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDN-loaded map libs (Google Maps, Leaflet) have no type definitions
type MapLib = any;

interface MapWindow extends Window {
  google?: MapLib;
  L?: MapLib;
  gm_authFailure?: () => void;
}
const mapWindow = window as MapWindow;

function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getApiKey() {
  const data = await apiClient.invokeFn<{ api_key?: string }>('google-environment-proxy', { action: 'api-key' });
  return data?.api_key || '';
}

function loadLeaflet(): Promise<MapLib> {
  return new Promise((resolve, reject) => {
    if (mapWindow.L) {
      resolve(mapWindow.L);
      return;
    }

    // Check if stylesheet is already appended
    const existingLink = document.querySelector('link[href*="leaflet.css"]');
    if (!existingLink) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      link.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
      link.crossOrigin = '';
      document.head.appendChild(link);
    }

    // Load Leaflet JS script
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    script.crossOrigin = '';
    script.onload = () => {
      resolve(mapWindow.L);
    };
    script.onerror = () => {
      reject(new Error('Failed to load Leaflet script'));
    };
    document.head.appendChild(script);
  });
}

export function VehicleMap({ vehicles }: { vehicles: VehicleLocation[] }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoading, setMapLoading] = useState(true);
  const [distances, setDistances] = useState<Record<number, DistanceInfo>>({});
  const [useLeaflet, setUseLeaflet] = useState(false);
  const [leafletLoaded, setLeafletLoaded] = useState(false);

  const mapInstanceRef = useRef<MapLib>(null);
  const markersRef = useRef<MapLib[]>([]);
  const infoWindowsRef = useRef<MapLib[]>([]);
  const scriptRef = useRef<HTMLScriptElement | null>(null);
  const unmountedRef = useRef(false);

  const leafletMapRef = useRef<MapLib>(null);
  const leafletMarkersRef = useRef<MapLib[]>([]);

  const loadMap = useCallback(async () => {
    if (mapWindow.google?.maps) {
      setMapLoaded(true);
      setMapLoading(false);
      return;
    }

    try {
      const apiKey = await getApiKey();
      if (unmountedRef.current) return;

      if (!apiKey) {
        console.warn('Google Maps API key not configured, falling back to Leaflet');
        setUseLeaflet(true);
        return;
      }

      mapWindow.gm_authFailure = () => {
        if (unmountedRef.current) return;
        console.warn('Google Maps authentication failed. Falling back to Leaflet...');
        setUseLeaflet(true);
      };

      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}`;
      script.async = true;

      script.onload = () => {
        if (unmountedRef.current) return;
        if (!mapWindow.google?.maps) {
          console.warn('Google Maps loaded but google.maps is not available. Falling back to Leaflet...');
          setUseLeaflet(true);
          return;
        }
        setMapLoaded(true);
        setMapLoading(false);
      };

      script.onerror = () => {
        if (unmountedRef.current) return;
        console.warn('Failed to load Google Maps script. Falling back to Leaflet...');
        setUseLeaflet(true);
      };

      scriptRef.current = script;
      document.head.appendChild(script);
    } catch (err) {
      if (unmountedRef.current) return;
      console.warn('Error loading Google Maps, falling back to Leaflet:', err);
      setUseLeaflet(true);
    }
  }, []);

  // Main loader useEffect
  useEffect(() => {
    unmountedRef.current = false;
    loadMap();

    return () => {
      unmountedRef.current = true;

      markersRef.current.forEach(m => {
        try { m.setMap(null); } catch { /* ignore: marker may already be detached */ }
      });
      markersRef.current = [];

      infoWindowsRef.current.forEach(iw => {
        try { iw.close(); } catch { /* ignore: info window may already be closed */ }
      });
      infoWindowsRef.current = [];

      mapInstanceRef.current = null;

      // Leaflet cleanup
      if (leafletMapRef.current) {
        try {
          leafletMapRef.current.remove();
        } catch { /* ignore: leaflet map may already be removed */ }
        leafletMapRef.current = null;
      }
      leafletMarkersRef.current = [];

      if (scriptRef.current && scriptRef.current.parentNode) {
        scriptRef.current.parentNode.removeChild(scriptRef.current);
        scriptRef.current = null;
      }

      delete mapWindow.gm_authFailure;
    };
  }, [loadMap]);

  // Leaflet dynamic loader trigger
  useEffect(() => {
    if (!useLeaflet) return;

    // Reset Google Maps state to allow Leaflet to render in loading state if necessary
    setMapLoaded(false);
    setMapLoading(true);

    loadLeaflet()
      .then(() => {
        if (unmountedRef.current) return;
        setLeafletLoaded(true);
        setMapLoaded(true);
        setMapLoading(false);
      })
      .catch(err => {
        if (unmountedRef.current) return;
        console.error('Failed to load Leaflet:', err);
        setMapError('Failed to load map. Both Google Maps and Leaflet failed.');
        setMapLoading(false);
      });
  }, [useLeaflet]);

  // Distance estimation logic with Haversine fallback
  useEffect(() => {
    if (vehicles.length === 0) return;

    (async () => {
      let success = false;
      try {
        const destinations = vehicles.map(v => `${v.lat},${v.lng}`).join('|');
        const data = await apiClient.invokeFn<DistanceResponse>('google-environment-proxy', { action: 'distance', destinations });

        if (data?.rows?.[0]?.elements) {
          const newDistances: Record<number, DistanceInfo> = {};
          let hasValidElement = false;
          data.rows[0].elements.forEach((el: DistanceElement, i: number) => {
            if (el.status === 'OK') {
              hasValidElement = true;
              const straightLine = haversineMiles(HOME_LAT, HOME_LNG, vehicles[i].lat, vehicles[i].lng);
              newDistances[vehicles[i].id] = {
                distance: el.distance.text,
                duration: el.duration.text,
                atHome: straightLine <= AT_HOME_THRESHOLD_MILES,
              };
            }
          });
          if (hasValidElement) {
            setDistances(newDistances);
            success = true;
          }
        }
      } catch (err) {
        console.error('Failed to fetch distances via API:', err);
      }

      // If API failed or was unsuccessful, run the Haversine fallback for all vehicles!
      if (!success) {
        const newDistances: Record<number, DistanceInfo> = {};
        vehicles.forEach(v => {
          const straightLine = haversineMiles(HOME_LAT, HOME_LNG, v.lat, v.lng);
          const atHome = straightLine <= AT_HOME_THRESHOLD_MILES;
          
          if (atHome) {
            newDistances[v.id] = {
              distance: '0 mi',
              duration: '0 mins',
              atHome: true,
            };
          } else {
            // Assume 1.35x routing factor over straight line, and average driving speed of 35 mph
            const estRoadMiles = straightLine * 1.35;
            const durationMins = Math.max(1, Math.round((estRoadMiles / 35) * 60));
            newDistances[v.id] = {
              distance: `${straightLine.toFixed(1)} mi (air)`,
              duration: `~${durationMins} mins`,
              atHome: false,
            };
          }
        });
        setDistances(newDistances);
      }
    })();
  }, [vehicles]);

  // Google Maps setup useEffect
  useEffect(() => {
    if (!mapLoaded || useLeaflet || !mapRef.current || vehicles.length === 0 || mapError) {
      // Clean up Google Maps if switching to Leaflet
      if (useLeaflet) {
        markersRef.current.forEach(m => {
          try { m.setMap(null); } catch { /* ignore: marker may already be detached */ }
        });
        markersRef.current = [];
        infoWindowsRef.current.forEach(iw => {
          try { iw.close(); } catch { /* ignore: info window may already be closed */ }
        });
        infoWindowsRef.current = [];
        mapInstanceRef.current = null;
      }
      return;
    }

    const google = mapWindow.google;

    try {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend({ lat: HOME_LAT, lng: HOME_LNG });
      vehicles.forEach(v => bounds.extend({ lat: v.lat, lng: v.lng }));

      if (!mapInstanceRef.current) {
        const mapInstance = new google.maps.Map(mapRef.current, {
          center: { lat: HOME_LAT, lng: HOME_LNG },
          zoom: 12,
          styles: [
            { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
            { elementType: 'labels.text.stroke', stylers: [{ color: '#1a1a2e' }] },
            { elementType: 'labels.text.fill', stylers: [{ color: '#8a8a9a' }] },
            { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a3e' }] },
            { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1a1a2e' }] },
            { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e0e1a' }] },
            { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          ],
          disableDefaultUI: true,
          zoomControl: true,
        });
        mapInstanceRef.current = mapInstance;

        let tilesDidLoad = false;
        google.maps.event.addListenerOnce(mapInstance, 'tilesloaded', () => {
          tilesDidLoad = true;
        });

        setTimeout(() => {
          if (!tilesDidLoad && !unmountedRef.current && mapInstanceRef.current && !useLeaflet) {
            const mapDiv = mapRef.current;
            if (mapDiv) {
              const errorDiv = mapDiv.querySelector('.gm-err-container, .gm-style-cc');
              const errorMsg = mapDiv.querySelector('.gm-err-message');
              if (errorDiv && errorMsg) {
                console.warn('Google Maps tile load failure, switching to Leaflet:', errorMsg.textContent);
                setUseLeaflet(true);
              }
            }
          }
        }, 8000);
      }

      const map = mapInstanceRef.current;

      markersRef.current.forEach(m => m.setMap(null));
      markersRef.current = [];
      infoWindowsRef.current.forEach(iw => iw.close());
      infoWindowsRef.current = [];

      const homeMarker = new google.maps.Marker({
        position: { lat: HOME_LAT, lng: HOME_LNG },
        map,
        title: 'Home',
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#f59e0b',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      markersRef.current.push(homeMarker);

      vehicles.forEach((v, i) => {
        const color = VEHICLE_COLORS[i % VEHICLE_COLORS.length];
        const marker = new google.maps.Marker({
          position: { lat: v.lat, lng: v.lng },
          map,
          title: v.name,
          label: {
            text: v.name,
            color: '#ffffff',
            fontWeight: 'bold',
            fontSize: '12px',
          },
          icon: {
            path: 'M 0,-8 C -4,-8 -7,-4 -7,0 C -7,5 0,12 0,12 C 0,12 7,5 7,0 C 7,-4 4,-8 0,-8 Z',
            scale: 2,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 1.5,
            labelOrigin: new google.maps.Point(0, -20),
          },
        });

        const info = distances[v.id];
        const content = `<div style="color:${color};font-size:13px;font-weight:600">${v.name}</div>${info ? `<div style="color:#555;font-size:12px">${info.distance} • ${info.duration} from home</div>` : ''}`;
        const infoWindow = new google.maps.InfoWindow({ content });
        marker.addListener('click', () => infoWindow.open(map, marker));
        markersRef.current.push(marker);
        infoWindowsRef.current.push(infoWindow);
      });

      map.fitBounds(bounds);
      const listener = google.maps.event.addListener(map, 'idle', () => {
        if (map.getZoom() > 15) map.setZoom(15);
        google.maps.event.removeListener(listener);
      });
    } catch (err) {
      console.warn('Google Maps initialization failed, switching to Leaflet:', err);
      setUseLeaflet(true);
    }
  }, [mapLoaded, useLeaflet, vehicles, distances, mapError]);

  // Leaflet setup useEffect
  useEffect(() => {
    if (!useLeaflet || !leafletLoaded || !mapRef.current || vehicles.length === 0 || mapError) return;

    const L = mapWindow.L;
    if (!L) return;

    try {
      if (!leafletMapRef.current) {
        const mapInstance = L.map(mapRef.current, {
          zoomControl: false,
          attributionControl: false,
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          maxZoom: 20,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        }).addTo(mapInstance);

        L.control.zoom({ position: 'topright' }).addTo(mapInstance);

        leafletMapRef.current = mapInstance;
      }

      const map = leafletMapRef.current;

      leafletMarkersRef.current.forEach(m => m.remove());
      leafletMarkersRef.current = [];

      // Create Custom Home Marker
      const homeHtml = `
        <div style="
          width: 16px;
          height: 16px;
          background-color: #f59e0b;
          border: 2px solid #ffffff;
          border-radius: 50%;
          box-shadow: 0 0 10px rgba(245, 158, 11, 0.8);
        "></div>
      `;
      const homeIcon = L.divIcon({
        html: homeHtml,
        className: 'custom-home-icon',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });

      const homeMarker = L.marker([HOME_LAT, HOME_LNG], { icon: homeIcon }).addTo(map);
      homeMarker.bindPopup('<div style="color:#f59e0b;font-weight:600;font-size:13px;">Home</div>', {
        closeButton: false,
        offset: [0, -6]
      });
      leafletMarkersRef.current.push(homeMarker);

      // Create Custom Vehicle Markers
      const bounds = L.latLngBounds([[HOME_LAT, HOME_LNG]]);

      vehicles.forEach((v, i) => {
        const color = VEHICLE_COLORS[i % VEHICLE_COLORS.length];
        bounds.extend([v.lat, v.lng]);

        const vehicleHtml = `
          <div style="position: relative; display: flex; flex-direction: column; align-items: center;">
            <div style="
              background-color: ${color};
              color: #ffffff;
              font-weight: bold;
              font-size: 11px;
              padding: 2px 6px;
              border-radius: 4px;
              white-space: nowrap;
              margin-bottom: 4px;
              box-shadow: 0 2px 4px rgba(0,0,0,0.5);
              border: 1px solid rgba(255,255,255,0.2);
            ">${v.name}</div>
            <div style="
              width: 12px;
              height: 12px;
              background-color: ${color};
              border: 1.5px solid #ffffff;
              border-radius: 50%;
              box-shadow: 0 0 8px ${color};
            "></div>
          </div>
        `;

        const vehicleIcon = L.divIcon({
          html: vehicleHtml,
          className: 'custom-vehicle-icon',
          iconSize: [80, 40],
          iconAnchor: [40, 36],
        });

        const marker = L.marker([v.lat, v.lng], { icon: vehicleIcon }).addTo(map);

        const info = distances[v.id];
        const popupContent = `
          <div>
            <div style="color:${color};font-size:13px;font-weight:600">${v.name}</div>
            ${info ? `<div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:2px">${info.distance} • ${info.duration} from home</div>` : ''}
          </div>
        `;

        marker.bindPopup(popupContent, {
          closeButton: false,
          offset: [0, -22]
        });

        marker.on('click', () => {
          marker.openPopup();
        });

        leafletMarkersRef.current.push(marker);
      });

      // Fit map bounds with a tiny timeout to ensure container layout is ready
      setTimeout(() => {
        if (leafletMapRef.current) {
          leafletMapRef.current.invalidateSize();
          leafletMapRef.current.fitBounds(bounds, {
            padding: [40, 40],
            maxZoom: 15,
          });
        }
      }, 50);

    } catch (err) {
      console.error('Leaflet initialization error:', err);
      setMapError(`Leaflet failed to initialize: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [useLeaflet, leafletLoaded, vehicles, distances, mapError]);

  if (vehicles.length === 0) return null;

  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-display flex items-center gap-2">
          <MapPin className="h-5 w-5 text-primary" />
          Vehicle Locations
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative w-full h-[350px] rounded-lg overflow-hidden bg-muted">
          <style dangerouslySetInnerHTML={{ __html: `
            /* Custom Leaflet glassmorphism popups styling */
            .leaflet-popup-content-wrapper {
              background: rgba(26, 26, 46, 0.9) !important;
              backdrop-filter: blur(8px) !important;
              -webkit-backdrop-filter: blur(8px) !important;
              border: 1px solid rgba(255, 255, 255, 0.15) !important;
              border-radius: 8px !important;
              box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5) !important;
            }
            .leaflet-popup-tip {
              background: rgba(26, 26, 46, 0.9) !important;
              border-bottom: 1px solid rgba(255, 255, 255, 0.15) !important;
              border-right: 1px solid rgba(255, 255, 255, 0.15) !important;
            }
            .leaflet-popup-content {
              margin: 8px 12px !important;
              color: #ffffff !important;
              font-family: inherit !important;
            }
          `}} />
          {mapError ? (
            <div
              data-testid="map-error"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
            >
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">Map failed to load</p>
                <p className="text-xs text-muted-foreground mt-1">{mapError}</p>
              </div>
            </div>
          ) : mapLoading ? (
            <div
              data-testid="map-loading"
              className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            >
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Loading map...</p>
            </div>
          ) : null}
          <div
            ref={mapRef}
            className="w-full h-full"
            style={{ visibility: mapLoaded && !mapError ? 'visible' : 'hidden' }}
          />
        </div>

        <div className="grid gap-2 md:grid-cols-2" data-testid="distance-cards">
        {vehicles.map((v, i) => {
            const info = distances[v.id];
            const color = VEHICLE_COLORS[i % VEHICLE_COLORS.length];
            return (
              <div key={v.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50" data-testid={`distance-card-${v.id}`}>
                <Car className="h-5 w-5 shrink-0" style={{ color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{v.name}</p>
                  {info ? (
                    info.atHome ? (
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="h-3 w-3" /> At Home
                      </p>
                    ) : (
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Navigation className="h-3 w-3" />
                          {info.distance}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {info.duration}
                        </span>
                      </div>
                    )
                  ) : (
                    <p className="text-xs text-muted-foreground">Calculating...</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
