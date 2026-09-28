import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RefreshCw, AlertTriangle, Cpu, Activity, Network, Clock, Shield, Lock, CheckCircle, Bell, Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
} from 'recharts';
import type {
  SystemHealth, SystemStatus, ThreatsResponse, DnsDhcpResponse,
  NetworkHealthSnapshot, NetworkAlert, HealthScore,
} from './types';
import {
  formatRelativeTime, formatUptime, safeNumber, usageColor, usageBarColor, useFortiViewStatus,
} from './shared-utils';

const FORTIVIEW_DOC = 'docs/fortigate-ha-traffic.yaml';

function isHtmlTokenError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('html instead of json') || lower.includes('api token may be expired');
}

function severityAlertColor(severity: string): string {
  const s = severity.toLowerCase();
  if (s === 'error' || s === 'critical') return 'text-red-500';
  if (s === 'warn' || s === 'warning') return 'text-yellow-500';
  return 'text-muted-foreground';
}

function severityAlertBg(severity: string): string {
  const s = severity.toLowerCase();
  if (s === 'error' || s === 'critical') return 'bg-red-500/10 border-red-500/20';
  if (s === 'warn' || s === 'warning') return 'bg-yellow-500/10 border-yellow-500/20';
  return 'bg-muted/30 border-border/50';
}

export function LastUpdated({ timestamp }: { timestamp: Date | null }) {
  if (!timestamp) return null;
  return (
    <span className="text-xs text-muted-foreground">
      Updated {formatRelativeTime(Math.floor(timestamp.getTime() / 1000))}
    </span>
  );
}

export function SectionSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const isTokenError = isHtmlTokenError(message);
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="flex items-start gap-3 pt-6">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div>
          <p className="font-medium text-sm">Could not reach FortiGate</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isTokenError
              ? 'FortiGate may be unreachable or the API token may have expired. Check the FortiGate API token in your configuration.'
              : message}
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry} data-testid="button-retry">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function GaugeStat({
  label, value, pct, icon, suffix = '%',
}: {
  label: string; value: number | null; pct: number | null; icon: React.ReactNode; suffix?: string;
}) {
  const safeValue = safeNumber(value);
  const safePct = safeNumber(pct);
  return (
    <div className="bg-muted/30 rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
        </div>
        <span className={cn('text-xl font-bold font-mono tabular-nums', usageColor(safePct))}>
          {safeValue !== null ? `${safeValue.toFixed(0)}${suffix}` : '—'}
        </span>
      </div>
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className={cn('h-2 rounded-full transition-all', usageBarColor(safePct))}
          style={{ width: `${Math.min(safePct ?? 0, 100)}%` }}
        />
      </div>
    </div>
  );
}

export function NetworkHealthStrip() {
  const queryClient = useQueryClient();

  const { data: health } = useQuery<SystemHealth>({
    queryKey: ['/api/fortigate/system-health'],
    queryFn: () => apiClient.get<SystemHealth>('/api/fortigate/system-health'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: status } = useQuery<SystemStatus>({
    queryKey: ['/api/fortigate/system-status'],
    queryFn: () => apiClient.get<SystemStatus>('/api/fortigate/system-status'),
    staleTime: 60_000,
    retry: 1,
  });

  const { data: wanData } = useQuery<{ wan_status: string; rx_gb: number | null; tx_gb: number | null; link: boolean | null }>({
    queryKey: ['/api/fortigate/wan-stats'],
    queryFn: () => apiClient.get('/api/fortigate/wan-stats'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: threatsData } = useQuery<ThreatsResponse>({
    queryKey: ['/api/fortigate/threats'],
    queryFn: () => apiClient.get<ThreatsResponse>('/api/fortigate/threats'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: dnsDhcpData } = useQuery<DnsDhcpResponse>({
    queryKey: ['/api/fortigate/dns-dhcp'],
    queryFn: () => apiClient.get<DnsDhcpResponse>('/api/fortigate/dns-dhcp'),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/system-health'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/system-status'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/wan-stats'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/threats'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/dns-dhcp'] });
    }, 60_000);
    return () => clearInterval(interval);
  }, [queryClient]);

  const cpuPct = health?.cpu_usage ?? null;
  const memPct = health?.memory_usage ?? null;
  const wanUp = wanData?.link;
  const threatCount = threatsData?.total ?? 0;
  const dnsBlockCount = dnsDhcpData?.total_blocked ?? null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5 rounded-lg border border-border/50 bg-muted/20 text-sm"
      data-testid="strip-network-health"
    >
      {/* WAN */}
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            'h-2 w-2 rounded-full shrink-0',
            wanUp === true ? 'bg-emerald-500' : wanUp === false ? 'bg-red-500' : 'bg-muted-foreground'
          )}
          data-testid="dot-wan-status"
        />
        <span className="text-xs text-muted-foreground">WAN</span>
        <span className="text-xs font-medium" data-testid="text-health-wan">
          {wanUp === true ? 'Up' : wanUp === false ? 'Down' : '—'}
        </span>
      </div>

      <div className="h-4 w-px bg-border/50 hidden sm:block" />

      {/* CPU */}
      <div className="flex items-center gap-1.5">
        <Cpu className="h-3.5 w-3.5 text-orange-400 shrink-0" />
        <span className="text-xs text-muted-foreground">CPU</span>
        <span className={cn('text-xs font-mono font-semibold', usageColor(cpuPct))} data-testid="text-health-cpu">
          {cpuPct !== null ? `${cpuPct.toFixed(0)}%` : '—'}
        </span>
        {cpuPct !== null && (
          <div className="w-12 bg-muted rounded-full h-1.5">
            <div className={cn('h-1.5 rounded-full', usageBarColor(cpuPct))} style={{ width: `${Math.min(cpuPct, 100)}%` }} />
          </div>
        )}
      </div>

      <div className="h-4 w-px bg-border/50 hidden sm:block" />

      {/* Memory */}
      <div className="flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 text-purple-400 shrink-0" />
        <span className="text-xs text-muted-foreground">Mem</span>
        <span className={cn('text-xs font-mono font-semibold', usageColor(memPct))} data-testid="text-health-mem">
          {memPct !== null ? `${memPct.toFixed(0)}%` : '—'}
        </span>
        {memPct !== null && (
          <div className="w-12 bg-muted rounded-full h-1.5">
            <div className={cn('h-1.5 rounded-full', usageBarColor(memPct))} style={{ width: `${Math.min(memPct, 100)}%` }} />
          </div>
        )}
      </div>

      <div className="h-4 w-px bg-border/50 hidden sm:block" />

      {/* Sessions */}
      <div className="flex items-center gap-1.5">
        <Network className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        <span className="text-xs text-muted-foreground">Sessions</span>
        <span className="text-xs font-mono font-semibold" data-testid="text-health-sessions">
          {health?.active_sessions !== null && health?.active_sessions !== undefined
            ? health.active_sessions.toLocaleString()
            : '—'}
        </span>
      </div>

      <div className="h-4 w-px bg-border/50 hidden sm:block" />

      {/* Uptime */}
      <div className="flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 text-teal-400 shrink-0" />
        <span className="text-xs text-muted-foreground">Uptime</span>
        <span className="text-xs font-mono font-semibold" data-testid="text-health-uptime">
          {formatUptime(status?.uptime ?? null)}
        </span>
      </div>

      <div className="h-4 w-px bg-border/50 hidden sm:block" />

      {/* Threats */}
      <div className="flex items-center gap-1.5">
        <Shield className="h-3.5 w-3.5 text-amber-400 shrink-0" />
        <span className="text-xs text-muted-foreground">Threats</span>
        {threatCount > 0 ? (
          <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4" data-testid="badge-health-threats">
            {threatCount}
          </Badge>
        ) : (
          <span className="text-xs font-semibold text-emerald-500" data-testid="badge-health-threats">0</span>
        )}
      </div>

      {dnsBlockCount !== null && (
        <>
          <div className="h-4 w-px bg-border/50 hidden sm:block" />
          <div className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 text-rose-400 shrink-0" />
            <span className="text-xs text-muted-foreground">DNS Blocked</span>
            {dnsBlockCount > 0 ? (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4" data-testid="badge-health-dns-blocked">
                {dnsBlockCount}
              </Badge>
            ) : (
              <span className="text-xs font-semibold text-emerald-500" data-testid="badge-health-dns-blocked">0</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function HealthTrendChart({ snapshots }: { snapshots: NetworkHealthSnapshot[] }) {
  const data = snapshots.map(s => ({
    time: new Date(s.captured_at).getTime(),
    timeLabel: new Date(s.captured_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    cpu: s.cpu_usage !== null ? parseFloat(s.cpu_usage) : null,
    mem: s.memory_usage !== null ? parseFloat(s.memory_usage) : null,
    sessions: s.active_sessions,
  }));

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
        No snapshots yet — data will appear after the next health check
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Card className="border-border/50">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
            <Cpu className="h-3.5 w-3.5 text-orange-400" />
            CPU (24h)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
              <XAxis dataKey="timeLabel" hide />
              <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickFormatter={v => `${v}%`} />
              <Tooltip
                formatter={(v: number) => [`${v.toFixed(1)}%`, 'CPU']}
                labelFormatter={(_l, payload) => payload?.[0]?.payload?.timeLabel ?? ''}
                contentStyle={{ fontSize: '11px' }}
              />
              <Line type="monotone" dataKey="cpu" stroke="#fb923c" strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
            <Activity className="h-3.5 w-3.5 text-purple-400" />
            Memory (24h)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
              <XAxis dataKey="timeLabel" hide />
              <YAxis domain={[0, 100]} tick={{ fontSize: 9 }} tickFormatter={v => `${v}%`} />
              <Tooltip
                formatter={(v: number) => [`${v.toFixed(1)}%`, 'Memory']}
                labelFormatter={(_l, payload) => payload?.[0]?.payload?.timeLabel ?? ''}
                contentStyle={{ fontSize: '11px' }}
              />
              <Line type="monotone" dataKey="mem" stroke="#a78bfa" strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <Card className="border-border/50">
        <CardHeader className="pb-1 pt-3 px-4">
          <CardTitle className="text-xs font-medium flex items-center gap-1.5 text-muted-foreground">
            <Network className="h-3.5 w-3.5 text-blue-400" />
            Sessions (24h)
          </CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-3">
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={data} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <XAxis dataKey="timeLabel" hide />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9 }} tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} />
              <Tooltip
                formatter={(v: number) => [v.toLocaleString(), 'Sessions']}
                labelFormatter={(_l, payload) => payload?.[0]?.payload?.timeLabel ?? ''}
                contentStyle={{ fontSize: '11px' }}
              />
              <Line type="monotone" dataKey="sessions" stroke="#60a5fa" strokeWidth={1.5} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

export function NetworkAlertsSection() {
  const { data, isLoading } = useQuery<{ alerts: NetworkAlert[]; count: number }>({
    queryKey: ['/api/network/alerts'],
    queryFn: () => apiClient.get('/api/network/alerts?limit=15'),
    staleTime: 60_000,
    retry: 1,
  });

  const alerts = data?.alerts ?? [];

  return (
    <Card className="border-border/50" data-testid="card-network-alerts">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Bell className="h-4 w-4 text-amber-400" />
          Recent Network Alerts
          {alerts.length > 0 && (
            <Badge variant="secondary" className="ml-auto text-xs">
              {alerts.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : alerts.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4 text-emerald-500" />
            No network alerts — everything looks healthy
          </div>
        ) : (
          <div className="space-y-1.5 max-h-72 overflow-y-auto" data-testid="list-network-alerts">
            {alerts.map((alert, i) => (
              <div
                key={alert.id}
                className={cn('flex items-start gap-2.5 rounded-md border px-3 py-2 text-xs', severityAlertBg(alert.severity))}
                data-testid={`alert-network-${i}`}
              >
                <AlertTriangle className={cn('h-3.5 w-3.5 shrink-0 mt-0.5', severityAlertColor(alert.severity))} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium leading-snug">{alert.summary}</p>
                  <p className="text-muted-foreground mt-0.5">
                    {new Date(alert.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {alert.actor_name && ` · ${alert.actor_name}`}
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className={cn('text-[10px] shrink-0', severityAlertColor(alert.severity))}
                >
                  {alert.severity}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MiniSparkline({
  data,
  width = 80,
  height = 28,
  color = '#22c55e',
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2) return <span className="text-xs text-muted-foreground">—</span>;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Subtle info callout shown when a FortiView panel is in its "pending" state
 * (no rows yet). Explains whether the HA sensor is configured and links to the
 * operator reference doc so setup can be completed without digging through docs.
 */
export function FortiViewSetupCallout({ sensor }: { sensor: 'top_talkers' | 'top_sites' }) {
  const { data, isLoading } = useFortiViewStatus();
  if (isLoading || !data) return null;

  const entityId = sensor === 'top_talkers'
    ? 'sensor.fortigate_top_talkers'
    : 'sensor.fortigate_top_sites';
  const present = data[sensor]?.present ?? false;
  const cacheReady = data.cache_ready;

  const message = !cacheReady
    ? 'Home Assistant connection is not ready yet — sensor status will appear once HA reconnects.'
    : present
      ? 'The sensor is configured in Home Assistant but has no data yet. It populates on the next FortiView poll.'
      : 'This panel needs a Home Assistant FortiView sensor that is not configured yet.';

  return (
    <div
      className="mt-3 flex items-start gap-2.5 rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2.5 text-xs"
      data-testid={`callout-fortiview-${sensor}`}
    >
      <Info className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
      <div className="space-y-1 text-muted-foreground">
        <p className="leading-snug">{message}</p>
        <p className="leading-snug">
          Add the <code className="px-1 bg-muted rounded">{entityId}</code> sensor via a
          {' '}<code className="px-1 bg-muted rounded">rest_command.fortigate_proxy</code> call.
          See <code className="px-1 bg-muted rounded">{FORTIVIEW_DOC}</code> for the snippet to paste into your
          HA <code className="px-1 bg-muted rounded">configuration.yaml</code>.
        </p>
      </div>
    </div>
  );
}

export function HealthDot({ score }: { score: HealthScore }) {
  const cls = score === 'green'
    ? 'bg-emerald-500 shadow-emerald-500/50'
    : score === 'yellow'
      ? 'bg-yellow-500 shadow-yellow-500/50'
      : 'bg-red-500 shadow-red-500/50';
  return <span className={cn('h-3 w-3 rounded-full shrink-0 shadow-md', cls)} />;
}
