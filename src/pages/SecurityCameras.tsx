import { useState, useMemo, useRef, useEffect } from 'react';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardNav } from '@/components/dashboard/DashboardNav';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import {
  useVerkadaCameras,
  useVerkadaThumbnail,
  useVerkadaLivestreamThumbnail,
  useVerkadaStreamLink,
  type VerkadaCamera,
} from '@/hooks/useVerkada';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Camera, ArrowLeft, X, Search, Wifi, WifiOff, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNavigate } from 'react-router-dom';
import Hls from 'hls.js';

function CameraThumbnail({ camera, onClick }: { camera: VerkadaCamera; onClick: () => void }) {
  const { data: thumbnail, isLoading } = useVerkadaThumbnail(camera.camera_id);
  const isOnline = camera.status?.toLowerCase() === 'live';

  return (
    <button
      onClick={onClick}
      className="relative rounded-lg overflow-hidden bg-muted/30 aspect-video text-left w-full group cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
      data-testid={`camera-thumbnail-${camera.camera_id}`}
    >
      {isLoading ? (
        <Skeleton className="w-full h-full" />
      ) : thumbnail ? (
        <img
          src={thumbnail}
          alt={camera.name}
          className="w-full h-full object-cover transition-transform group-hover:scale-105"
          loading="lazy"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Camera className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-2">
        <p className="text-xs text-white font-medium truncate">{camera.name}</p>
      </div>
      <div className="absolute top-2 right-2">
        <div className={`w-2 h-2 rounded-full ${isOnline ? 'bg-status-online animate-pulse-soft' : 'bg-muted-foreground/50'}`} />
      </div>
    </button>
  );
}

function CameraVideoPlayer({
  hlsUrl,
  cameraName,
  onFatalError,
}: {
  hlsUrl: string;
  cameraName: string;
  onFatalError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.7);
  const [hasError, setHasError] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setHasError(false);
    setIsBuffering(true);

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
      });
      hlsRef.current = hls;
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        setIsBuffering(false);
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          setHasError(true);
          setIsBuffering(false);
          onFatalError?.();
        }
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const handleLoaded = () => {
        video.play().catch(() => {});
        setIsBuffering(false);
      };
      const handleError = () => {
        setHasError(true);
        setIsBuffering(false);
        onFatalError?.();
      };
      video.src = hlsUrl;
      video.addEventListener('loadedmetadata', handleLoaded);
      video.addEventListener('error', handleError);
      return () => {
        video.removeEventListener('loadedmetadata', handleLoaded);
        video.removeEventListener('error', handleError);
        video.src = '';
        video.load();
      };
    } else {
      setHasError(true);
      setIsBuffering(false);
      onFatalError?.();
    }
  }, [hlsUrl, onFatalError]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = muted;
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
  }, [volume]);

  if (hasError) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2">
        <Camera className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Stream unavailable</p>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full flex flex-col">
      <div className="relative flex-1 bg-black">
        {isBuffering && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          </div>
        )}
        <video
          ref={videoRef}
          className="w-full h-full object-contain"
          muted={muted}
          playsInline
          autoPlay
          data-testid="hls-video-player"
          aria-label={`Live stream – ${cameraName}`}
        />
      </div>
      <div className="flex items-center gap-3 px-3 py-2 bg-black/80">
        <button
          onClick={() => setMuted((m) => !m)}
          className="text-white hover:text-white/80 transition-colors flex-shrink-0"
          data-testid="toggle-mute"
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <div className="w-24" data-testid="volume-slider">
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[muted ? 0 : volume]}
            onValueChange={([v]) => {
              setVolume(v);
              if (v > 0) setMuted(false);
              else setMuted(true);
            }}
            className="cursor-pointer"
            aria-label="Volume"
          />
        </div>
        <span className="text-xs text-white/60 ml-auto">{muted ? 'Muted' : `${Math.round(volume * 100)}%`}</span>
      </div>
    </div>
  );
}

function LivestreamViewer({ camera, onClose }: { camera: VerkadaCamera; onClose: () => void }) {
  const { data: hlsUrl, isLoading: streamLoading, isError: streamError } = useVerkadaStreamLink(camera.camera_id);
  const [runtimeStreamError, setRuntimeStreamError] = useState(false);
  const useFallback = !streamLoading && (streamError || !hlsUrl || runtimeStreamError);
  const { data: thumbnail, isLoading: thumbLoading, isFetching } = useVerkadaLivestreamThumbnail(camera.camera_id, useFallback);
  const isOnline = camera.status?.toLowerCase() === 'live';

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" data-testid="livestream-viewer">
      <div className="bg-card rounded-lg w-full max-w-4xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-3">
            <Camera className="h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="font-semibold text-sm" data-testid="livestream-camera-name">{camera.name}</h2>
              <div className="flex items-center gap-2 mt-0.5">
                {isOnline ? (
                  <span className="flex items-center gap-1 text-xs text-green-500">
                    <Wifi className="h-3 w-3" />
                    Online
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <WifiOff className="h-3 w-3" />
                    Offline
                  </span>
                )}
                {useFallback && isFetching && (
                  <span className="text-xs text-muted-foreground animate-pulse">Refreshing…</span>
                )}
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} data-testid="close-livestream">
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="relative bg-black aspect-video">
          {streamLoading ? (
            <div className="w-full h-full flex items-center justify-center">
              <Skeleton className="w-full h-full" />
            </div>
          ) : hlsUrl && !streamError && !runtimeStreamError ? (
            <CameraVideoPlayer hlsUrl={hlsUrl} cameraName={camera.name} onFatalError={() => setRuntimeStreamError(true)} />
          ) : thumbLoading && !thumbnail ? (
            <div className="w-full h-full flex items-center justify-center">
              <Skeleton className="w-full h-full" />
            </div>
          ) : thumbnail ? (
            <img
              src={thumbnail}
              alt={`Live view – ${camera.name}`}
              className="w-full h-full object-contain"
              data-testid="livestream-image"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-2">
              <Camera className="h-12 w-12 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No feed available</p>
            </div>
          )}
          <div className="absolute top-3 left-3 flex items-center gap-2 pointer-events-none">
            <div className="bg-red-600 text-white text-xs font-bold px-2 py-0.5 rounded flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              LIVE
            </div>
          </div>
        </div>

        <div className="p-3 border-t border-border text-xs text-muted-foreground">
          {camera.location && <span>{camera.location} · </span>}
          {camera.model && <span>{camera.model} · </span>}
          {useFallback ? 'Auto-refreshing every ~4s' : 'HLS stream'}
        </div>
      </div>
    </div>
  );
}

export default function SecurityCameras() {
  const { data: cameras, isLoading } = useVerkadaCameras();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCamera, setSelectedCamera] = useState<VerkadaCamera | null>(null);

  const filteredCameras = useMemo(() => {
    if (!cameras) return [];
    if (!searchQuery.trim()) return cameras;
    const q = searchQuery.toLowerCase();
    return cameras.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.location?.toLowerCase().includes(q) ||
        c.model?.toLowerCase().includes(q)
    );
  }, [cameras, searchQuery]);

  const onlineCount = cameras?.filter((c) => c.status?.toLowerCase() === 'live').length ?? 0;

  return (
    <div className="min-h-screen bg-background pb-16 md:pb-0">
      <DashboardHeader />
      <DashboardNav />
      <main className="container py-4 md:py-6 space-y-4 px-3 md:px-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/home-systems')} data-testid="back-button">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-semibold" data-testid="page-title">All Cameras</h1>
            <p className="text-sm text-muted-foreground" data-testid="camera-count">
              {isLoading ? 'Loading…' : `${cameras?.length ?? 0} cameras · ${onlineCount} online`}
            </p>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search cameras by name, location, or model…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="camera-search"
          />
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-video rounded-lg" />
            ))}
          </div>
        ) : filteredCameras.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3" data-testid="cameras-grid">
            {filteredCameras.map((camera) => (
              <CameraThumbnail
                key={camera.camera_id}
                camera={camera}
                onClick={() => setSelectedCamera(camera)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-8" data-testid="no-cameras-message">
            {searchQuery ? `No cameras matching "${searchQuery}"` : 'No cameras found.'}
          </p>
        )}
      </main>
      <MobileBottomNav />

      {selectedCamera && (
        <LivestreamViewer
          camera={selectedCamera}
          onClose={() => setSelectedCamera(null)}
        />
      )}
    </div>
  );
}
