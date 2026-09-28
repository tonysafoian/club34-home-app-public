import { SystemCard } from '../SystemCard';
import { Zap, RefreshCw, CheckCircle2, AlertTriangle, WifiOff, Battery, Clock } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useGenerac, GeneracGenerator } from '@/hooks/useGenerac';
import { Badge } from '@/components/ui/badge';

function getStatusDisplay(gen: GeneracGenerator) {
  // apparatusStatus: 0 = Ready, 1 = Running, etc. Also check string properties.
  const statusProps = gen.properties?.find(p => p.name === 'GeneratorStatus');
  const statusLabel = statusProps?.value || gen.statusText || 'Unknown';

  const isReady = /ready/i.test(String(statusLabel));
  const isRunning = /running/i.test(String(statusLabel));

  return { statusLabel: String(statusLabel), isReady, isRunning };
}

export function GeneracCard() {
  const { data: generators, isLoading, error, refetch } = useGenerac();
  const gen = generators?.[0];
  const hasGen = !!gen;

  const quickActions = [
    {
      label: 'Refresh',
      onClick: () => refetch(),
      icon: <RefreshCw className="h-4 w-4" />,
    },
  ];

  if (isLoading) {
    return (
      <SystemCard
        title="Generac Generator"
        icon={<Zap className="w-6 h-6 text-amber-500" />}
        status="warning"
        statusText="Connecting…"
        quickActions={quickActions}
        accentColor="bg-amber-500/10"
      >
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </SystemCard>
    );
  }

  if (error || !hasGen) {
    return (
      <SystemCard
        title="Generac Generator"
        icon={<Zap className="w-6 h-6 text-amber-500" />}
        status="offline"
        statusText={error ? 'Error' : 'No generators found'}
        quickActions={quickActions}
        accentColor="bg-amber-500/10"
      >
        <p className="text-sm text-muted-foreground text-center py-4">
          {error instanceof Error ? error.message : 'Could not load generator data. Check credentials.'}
        </p>
      </SystemCard>
    );
  }

  const { statusLabel, isReady, isRunning } = getStatusDisplay(gen);
  const systemStatus = !gen.isConnected ? 'offline' : isReady ? 'online' : isRunning ? 'warning' : 'idle';

  const metrics = [
    {
      label: 'Battery',
      value: gen.batteryVoltage ? `${gen.batteryVoltage}V` : '—',
    },
    {
      label: 'Run Hours',
      value: gen.runHours != null ? `${gen.runHours}h` : '—',
    },
  ];

  return (
    <SystemCard
      title="Generac Generator"
      icon={<Zap className="w-6 h-6 text-amber-500" />}
      status={systemStatus}
      statusText={gen.isConnected ? statusLabel : 'Connection Lost'}
      metrics={metrics}
      quickActions={quickActions}
      accentColor="bg-amber-500/10"
    >
      <div className="space-y-3">
        {/* Status indicator */}
        <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
          {!gen.isConnected ? (
            <WifiOff className="h-5 w-5 text-destructive shrink-0" />
          ) : isReady ? (
            <CheckCircle2 className="h-5 w-5 text-status-online shrink-0" />
          ) : isRunning ? (
            <AlertTriangle className="h-5 w-5 text-status-warning shrink-0" />
          ) : (
            <Zap className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{gen.name}</p>
            <p className="text-xs text-muted-foreground">{gen.serialNumber || 'No serial'}</p>
          </div>
          <Badge
            variant="outline"
            className={
              !gen.isConnected
                ? 'text-destructive border-destructive/30'
                : isReady
                  ? 'text-status-online border-status-online/30'
                  : 'text-status-warning border-status-warning/30'
            }
          >
            {!gen.isConnected ? 'Offline' : statusLabel}
          </Badge>
        </div>

        {/* Connection lost alert */}
        {!gen.isConnected && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <WifiOff className="h-4 w-4 text-destructive shrink-0" />
            <p className="text-sm text-destructive font-medium">Connection Lost — Generator is not reporting.</p>
          </div>
        )}

        {/* Sub-stats */}
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
            <Battery className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Battery</p>
              <p className="text-sm font-medium">{gen.batteryVoltage ? `${gen.batteryVoltage}V` : '—'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/30">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Run Hours</p>
              <p className="text-sm font-medium">{gen.runHours != null ? `${gen.runHours}` : '—'}</p>
            </div>
          </div>
        </div>

        {/* Last seen */}
        {gen.lastSeen && (
          <p className="text-xs text-muted-foreground text-center">
            Last seen: {new Date(gen.lastSeen).toLocaleString()}
          </p>
        )}
      </div>
    </SystemCard>
  );
}
