import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SystemCard } from '../SystemCard';
import { Camera, Shield, RefreshCw } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useVerkadaCameras,
  useVerkadaThumbnail,
  type VerkadaCamera,
} from '@/hooks/useVerkada';

function CameraThumbnail({ camera }: { camera: VerkadaCamera }) {
  const { data: thumbnail, isLoading } = useVerkadaThumbnail(camera.camera_id);

  return (
    <div className="relative rounded-lg overflow-hidden bg-muted/30 aspect-video">
      {isLoading ? (
        <Skeleton className="w-full h-full" />
      ) : thumbnail ? (
        <img
          src={thumbnail}
          alt={camera.name}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Camera className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
        <p className="text-xs text-white font-medium truncate">{camera.name}</p>
      </div>
      {camera.status?.toLowerCase() === 'live' && (
        <div className="absolute top-2 right-2">
          <div className="w-2 h-2 rounded-full bg-status-online animate-pulse-soft" />
        </div>
      )}
    </div>
  );
}

export function VerkadaCard() {
  const navigate = useNavigate();
  const { data: cameras, isLoading: camerasLoading, refetch: refetchCameras } = useVerkadaCameras();

  const cameraCount = cameras?.length ?? 0;
  const onlineCameras = cameras?.filter((c) => c.status?.toLowerCase() === 'live').length ?? 0;
  const offlineCameras = cameraCount - onlineCameras;

  const top8Cameras = useMemo(() => {
    if (!cameras || cameras.length === 0) return [];
    const seen = new Set<string>();
    const unique = cameras.filter((c) => {
      if (seen.has(c.camera_id)) return false;
      seen.add(c.camera_id);
      return true;
    });
    return unique.slice(0, 8);
  }, [cameras]);

  const systemStatus = camerasLoading ? 'warning' : cameraCount > 0 ? 'online' : 'offline';

  const metrics = [
    { label: 'Online', value: camerasLoading ? '...' : String(onlineCameras) },
    ...(offlineCameras > 0
      ? [{ label: 'Offline', value: String(offlineCameras) }]
      : []),
  ];

  const quickActions = [
    {
      label: 'Refresh',
      onClick: () => refetchCameras(),
      icon: <RefreshCw className="h-4 w-4" />,
    },
  ];

  return (
    <div className="space-y-0" data-testid="verkada-card">
      <SystemCard
        title="Verkada"
        icon={<Shield className="w-6 h-6 text-system-verkada" />}
        status={systemStatus as 'online' | 'offline' | 'warning'}
        statusText={
          camerasLoading
            ? 'Connecting...'
            : cameraCount > 0
              ? `${onlineCameras} cameras online`
              : 'No devices found'
        }
        metrics={metrics}
        quickActions={quickActions}
        accentColor="bg-system-verkada/10"
        expandable={false}
      />

      {(top8Cameras.length > 0 || (!camerasLoading && cameraCount === 0)) && (
        <div className="rounded-b-lg border border-t-0 border-border bg-card px-4 pb-4 pt-3 space-y-3">
          {top8Cameras.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {top8Cameras.map((camera) => (
                <CameraThumbnail key={camera.camera_id} camera={camera} />
              ))}
            </div>
          )}

          {!camerasLoading && cameraCount === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No cameras found. Check your API key and Organization ID.
            </p>
          )}

          {cameraCount > 0 && (
            <button
              onClick={() => navigate('/security/cameras')}
              className="text-xs text-primary hover:underline cursor-pointer w-full text-center"
              data-testid="view-all-cameras"
            >
              View all {cameraCount} cameras
            </button>
          )}
        </div>
      )}
    </div>
  );
}
