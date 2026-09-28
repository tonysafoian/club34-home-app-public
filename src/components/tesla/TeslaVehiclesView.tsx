import { useEffect, useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Car, RefreshCw, ExternalLink, MapPin } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useTesla } from '@/hooks/useTesla';
import { VehicleMap } from '@/components/tesla/VehicleMap';
import { VehicleCard } from './VehicleCard';
import { SetupWizard } from './SetupWizard';
import { PairingRequired } from './PairingRequired';
import { getCachedLocations, cacheLocation } from './locationCache';

interface TeslaVehiclesViewProps {
  /** Show "Reset Tesla Setup" button (embeddable section has it, full page may not) */
  showResetSetup?: boolean;
}

export function TeslaVehiclesView({ showResetSetup = false }: TeslaVehiclesViewProps) {
  const { status, vehicles, vehicleData, pairingRequired, fetchStatus, fetchVehicles, fetchVehicleData, wakeVehicle, getAuthUrl, registerPartner, generateKeypair, loading } = useTesla();
  const [initialized, setInitialized] = useState(false);
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await fetchStatus();
      if (s?.user_authenticated) {
        const vList = await fetchVehicles();
        for (const v of vList) {
          if (v.state === 'online') {
            fetchVehicleData(v.id);
          }
        }
      }
      setInitialized(true);
    })();
  }, [fetchStatus, fetchVehicles, fetchVehicleData]);

  // Cache locations whenever vehicleData updates with drive_state
  useEffect(() => {
    for (const [idStr, data] of Object.entries(vehicleData)) {
      const d = data?.drive_state;
      if (d?.latitude != null && d?.longitude != null) {
        const id = Number(idStr);
        const vehicle = vehicles.find(v => v.id === id);
        cacheLocation(id, vehicle?.display_name || 'Tesla', d.latitude, d.longitude);
      }
    }
  }, [vehicleData, vehicles]);

  const handleResetSetup = async () => {
    await generateKeypair();
    await fetchStatus();
    setShowSetupWizard(true);
  };

  const handleReauthorize = async () => {
    const url = await getAuthUrl();
    if (url) window.location.href = url;
  };

  const handleReregisterAndReauth = async () => {
    await registerPartner();
    const url = await getAuthUrl();
    if (url) window.location.href = url;
  };

  const isSetupComplete = status?.user_authenticated;

  // Build locations: prefer live data, fallback to cached
  const mapLocations = useMemo(() => {
    const locs: { id: number; name: string; lat: number; lng: number; cached?: boolean }[] = [];
    const cached = getCachedLocations();
    const seen = new Set<number>();

    for (const v of vehicles) {
      const d = vehicleData[v.id]?.drive_state;
      if (d?.latitude != null && d?.longitude != null) {
        locs.push({ id: v.id, name: v.display_name || 'Tesla', lat: d.latitude, lng: d.longitude });
        seen.add(v.id);
      }
    }

    for (const v of vehicles) {
      if (!seen.has(v.id) && cached[v.id]) {
        locs.push({ id: v.id, name: cached[v.id].name, lat: cached[v.id].lat, lng: cached[v.id].lng, cached: true });
        seen.add(v.id);
      }
    }

    return locs;
  }, [vehicles, vehicleData]);

  if (!initialized) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="glass"><CardContent className="py-8"><Skeleton className="h-32 w-full" /></CardContent></Card>
        <Card className="glass"><CardContent className="py-8"><Skeleton className="h-32 w-full" /></CardContent></Card>
      </div>
    );
  }

  if (showSetupWizard) {
    return (
      <div className="space-y-3">
        <SetupWizard />
        <Button variant="ghost" size="sm" onClick={() => setShowSetupWizard(false)}>
          ← Back to vehicles
        </Button>
      </div>
    );
  }

  if (!isSetupComplete) {
    return <SetupWizard />;
  }

  if (pairingRequired) {
    return (
      <PairingRequired
        loading={loading}
        onRetry={() => fetchVehicles()}
        onReregisterAndReauth={handleReregisterAndReauth}
        onShowSetup={() => setShowSetupWizard(true)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end gap-2">
        {showResetSetup && (
          <Button variant="ghost" size="sm" onClick={handleResetSetup} disabled={loading} className="gap-1 text-xs text-muted-foreground">
            <RefreshCw className="h-3 w-3" /> Reset Tesla Setup
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={handleReauthorize} className="gap-1">
          <ExternalLink className="h-3 w-3" /> Re-authorize Tesla
        </Button>
      </div>

      {mapLocations.length > 0 ? (
        <>
          <VehicleMap vehicles={mapLocations} />
          {mapLocations.some(l => l.cached) && (
            <p className="text-xs text-muted-foreground text-center -mt-4">
              Showing last known location for some vehicles
            </p>
          )}
        </>
      ) : (
        <Card className="glass">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-display flex items-center gap-2">
              <MapPin className="h-5 w-5 text-primary" />
              Vehicle Locations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
              <Car className="h-8 w-8" />
              <p className="text-sm">No location data available yet. Location will appear once a vehicle reports its position.</p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {vehicles.map((v) => (
          <VehicleCard
            key={v.id}
            vehicle={v}
            data={vehicleData[v.id]}
            onRefresh={() => fetchVehicleData(v.id)}
            onWake={() => wakeVehicle(v.id)}
          />
        ))}
      </div>
      {vehicles.length === 0 && (
        <Card className="glass">
          <CardContent className="py-8 text-center text-muted-foreground">
            <p>No vehicles found on your Tesla account.</p>
            <Button variant="outline" className="mt-3" onClick={fetchVehicles} disabled={loading}>
              <RefreshCw className="h-4 w-4 mr-2" /> Retry
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
