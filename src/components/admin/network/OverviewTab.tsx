import { useState, useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  RefreshCw, Wifi, AlertTriangle, Server, Cpu,
  Activity, Clock, Shield, Users, Lock, CheckCircle,
  ArrowUp, ArrowDown, TrendingUp, Zap, Cable, HelpCircle, Globe,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  NetworkTab, SystemHealth, SystemStatus, HaStatusResponse, ThreatsResponse,
  DevicesResponse, ConnectedDevice, TrafficResponse, VpnResponse, InterfacesResponse,
  NetworkHealthSnapshot, SpeedTestResult, SdwanHealthResponse, SdwanMember,
  DualWanStatsResponse, WanLinkStats,
} from './types';
import {
  LastUpdated, ErrorCard, GaugeStat, HealthTrendChart, NetworkAlertsSection,
  MiniSparkline, HealthDot,
} from './shared';
import {
  formatBytes, formatUptime, formatRelativeTime, safeNumber, usageColor,
  isRecentlyActive, computeHealthScore, useFortiViewStatus,
} from './shared-utils';

// Connection breakdown helpers — mirror the 4-tier classification keys/labels
// used by the Devices tab so the Overview split stays consistent with it.
const CONNECTION_GROUP_ORDER = ['wired', 'wifi:34', 'wifi:34_AV', 'wifi:34_Guest', 'wifi:unknown', '__unknown__'];

const CONNECTION_COLORS: Record<string, string> = {
  wired: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
  'wifi:34': 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  'wifi:34_AV': 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
  'wifi:34_Guest': 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  'wifi:unknown': 'bg-blue-500/10 text-blue-500/70 dark:text-blue-400/70 border-blue-500/20',
  '__unknown__': 'bg-muted/30 text-muted-foreground border-border/50',
};

// Solid segment fills for the stacked proportion bar, keyed to match
// the hues of CONNECTION_COLORS above.
const CONNECTION_BAR_COLORS: Record<string, string> = {
  wired: 'bg-slate-500',
  'wifi:34': 'bg-blue-500',
  'wifi:34_AV': 'bg-violet-500',
  'wifi:34_Guest': 'bg-amber-500',
  'wifi:unknown': 'bg-blue-400/70',
  '__unknown__': 'bg-muted-foreground/40',
};

function connectionKey(conn: ConnectedDevice['connection']): string {
  if (!conn || conn.method === 'unknown') return '__unknown__';
  if (conn.method === 'wired') return 'wired';
  return conn.ssid ? `wifi:${conn.ssid}` : 'wifi:unknown';
}

function connectionLabel(key: string): string {
  if (key === '__unknown__') return 'Unknown';
  if (key === 'wired') return 'Wired';
  if (key.startsWith('wifi:')) {
    const ssid = key.slice(5);
    return ssid === 'unknown' ? 'Wi-Fi' : `Wi-Fi · ${ssid}`;
  }
  return key;
}

function slaMetric(value: number | null, unit: string, threshold?: number): { text: string; color: string } {
  if (value === null) return { text: '—', color: 'text-muted-foreground' };
  const over = threshold !== undefined && value > threshold;
  return {
    text: `${value.toFixed(value < 10 ? 1 : 0)}${unit}`,
    color: over ? 'text-red-400' : 'text-foreground',
  };
}

function SdwanLink({ member, stats }: { member: SdwanMember | null; stats: WanLinkStats | null | undefined; }) {
  const label = member?.label ?? (stats ? 'WAN' : '—');
  const iface = member?.interface ?? '';
  const isAlive = member ? member.status === 'alive' : stats?.link === true;
  const isDead = member ? member.status === 'dead' : stats?.link === false;
  const statusDot = isAlive ? 'bg-emerald-500' : isDead ? 'bg-red-500' : 'bg-muted-foreground';
  const statusText = isAlive ? 'Up' : isDead ? 'Down' : 'Unknown';

  const latency = slaMetric(member?.latency_ms ?? null, ' ms', 250);
  const jitter = slaMetric(member?.jitter_ms ?? null, ' ms');
  const loss = slaMetric(member?.packet_loss_pct ?? null, '%', 5);

  return (
    <div className="flex-1 rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2.5" data-testid={`sdwan-link-${iface || 'unknown'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', statusDot)} data-testid={`dot-sdwan-${iface}`} />
          <div>
            <p className="text-sm font-semibold leading-tight" data-testid={`text-sdwan-label-${iface}`}>{label}</p>
            {iface && <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-mono">{iface}</p>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={cn('text-xs font-semibold', isAlive ? 'text-emerald-400' : isDead ? 'text-red-400' : 'text-muted-foreground')} data-testid={`text-sdwan-status-${iface}`}>
            {statusText}
          </span>
          {member && (
            <Badge
              variant="outline"
              className={cn('text-[10px] py-0', member.sla_met ? 'border-emerald-500/40 text-emerald-400' : 'border-red-500/40 text-red-400')}
              data-testid={`badge-sdwan-sla-${iface}`}
            >
              {member.sla_met ? 'Meeting SLA' : 'Out of SLA'}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Latency</p>
          <p className={cn('text-sm font-mono font-semibold', latency.color)} data-testid={`text-sdwan-latency-${iface}`}>{latency.text}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Jitter</p>
          <p className={cn('text-sm font-mono font-semibold', jitter.color)} data-testid={`text-sdwan-jitter-${iface}`}>{jitter.text}</p>
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Loss</p>
          <p className={cn('text-sm font-mono font-semibold', loss.color)} data-testid={`text-sdwan-loss-${iface}`}>{loss.text}</p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1.5 border-t border-border/30 text-[10px] text-muted-foreground">
        <span data-testid={`text-sdwan-gateway-${iface}`}>
          {member?.gateway ? `GW ${member.gateway}` : '\u00a0'}
        </span>
        {stats && (
          <span className="font-mono">
            ↓{stats.rx_gb !== null ? `${stats.rx_gb.toFixed(1)}G` : '—'} ↑{stats.tx_gb !== null ? `${stats.tx_gb.toFixed(1)}G` : '—'}
          </span>
        )}
      </div>
    </div>
  );
}

export function OverviewTab({ onNavigate }: { onNavigate: (tab: NetworkTab) => void }) {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [speedTests, setSpeedTests] = useState<SpeedTestResult[]>([]);
  const queryClient = useQueryClient();
  const [, setSearchParams] = useSearchParams();

  // Clicking a connection segment/legend entry jumps to the Devices tab
  // pre-filtered to that connection type. The filter travels via the
  // `connection` URL param, which DevicesTab consumes (and clears) on mount.
  const handleConnectionClick = useCallback((key: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('connection', key);
      return next;
    }, { replace: true });
    onNavigate('devices');
  }, [setSearchParams, onNavigate]);

  const { data: health, isLoading: healthLoading, isError: healthError, refetch: refetchHealth } = useQuery<SystemHealth>({
    queryKey: ['/api/fortigate/system-health'],
    queryFn: () => apiClient.get<SystemHealth>('/api/fortigate/system-health'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: status, isLoading: statusLoading } = useQuery<SystemStatus>({
    queryKey: ['/api/fortigate/system-status'],
    queryFn: () => apiClient.get<SystemStatus>('/api/fortigate/system-status'),
    staleTime: 60_000,
    retry: 1,
  });

  const { data: haData } = useQuery<HaStatusResponse>({
    queryKey: ['/api/fortigate/ha-status'],
    queryFn: () => apiClient.get<HaStatusResponse>('/api/fortigate/ha-status'),
    staleTime: 60_000,
    retry: 1,
  });

  const { data: wanData } = useQuery<DualWanStatsResponse>({
    queryKey: ['/api/fortigate/wan-stats'],
    queryFn: () => apiClient.get('/api/fortigate/wan-stats'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: sdwanData } = useQuery<SdwanHealthResponse>({
    queryKey: ['/api/fortigate/sdwan-health'],
    queryFn: () => apiClient.get('/api/fortigate/sdwan-health'),
    staleTime: 30_000,
    retry: 1,
  });

  // Health Trends source flipped from the DB-backed snapshot table
  // (populated by a periodic capture cron that went stale during the
  // HA-proxy era) to the FortiGate's native time series. The chart
  // component below still consumes NetworkHealthSnapshot[], so we
  // synthesize that shape from the new {cpu,memory,sessions} arrays.
  // Each metric is independent — we align on the longest series and
  // backfill nulls where a shorter one doesn't have a sample for that
  // timestamp bucket.
  const { data: trendsData } = useQuery<{ cpu: { t: number; v: number }[]; memory: { t: number; v: number }[]; sessions: { t: number; v: number }[]; interval: string; snapshot_count: number }>({
    queryKey: ['/api/fortigate/health-trends'],
    queryFn: () => apiClient.get('/api/fortigate/health-trends?interval=1-hour'),
    staleTime: 60_000,
    retry: 1,
  });
  const snapshotsData = (() => {
    try {
      if (!trendsData || !Array.isArray(trendsData.cpu) || !Array.isArray(trendsData.memory) || !Array.isArray(trendsData.sessions)) return undefined;
      const byT = new Map<number, { cpu: number | null; mem: number | null; sessions: number | null }>();
      for (const p of trendsData.cpu) {
        const e = byT.get(p.t) ?? { cpu: null, mem: null, sessions: null };
        e.cpu = p.v;
        byT.set(p.t, e);
      }
      for (const p of trendsData.memory) {
        const e = byT.get(p.t) ?? { cpu: null, mem: null, sessions: null };
        e.mem = p.v;
        byT.set(p.t, e);
      }
      for (const p of trendsData.sessions) {
        const e = byT.get(p.t) ?? { cpu: null, mem: null, sessions: null };
        e.sessions = p.v;
        byT.set(p.t, e);
      }
      const snapshots: NetworkHealthSnapshot[] = Array.from(byT.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, v]) => ({
          id: String(t),
          captured_at: new Date(t).toISOString(),
          cpu_usage: v.cpu == null ? null : String(v.cpu),
          memory_usage: v.mem == null ? null : String(v.mem),
          active_sessions: v.sessions,
          wan_status: null,
          wan_link: null,
          threat_count: null,
        }));
      return { snapshots, count: snapshots.length };
    } catch {
      return undefined;
    }
  })();

  const { data: threatsData } = useQuery<ThreatsResponse>({
    queryKey: ['/api/fortigate/threats'],
    queryFn: () => apiClient.get<ThreatsResponse>('/api/fortigate/threats'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: devicesData } = useQuery<DevicesResponse>({
    queryKey: ['/api/fortigate/devices', 'category'],
    queryFn: () => apiClient.get<DevicesResponse>('/api/fortigate/devices?groupBy=category'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: trafficData } = useQuery<TrafficResponse>({
    queryKey: ['/api/fortigate/traffic'],
    queryFn: () => apiClient.get<TrafficResponse>('/api/fortigate/traffic'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: vpnData } = useQuery<VpnResponse>({
    queryKey: ['/api/fortigate/vpn'],
    queryFn: () => apiClient.get<VpnResponse>('/api/fortigate/vpn'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: ifaceData } = useQuery<InterfacesResponse>({
    queryKey: ['/api/fortigate/interfaces'],
    queryFn: () => apiClient.get<InterfacesResponse>('/api/fortigate/interfaces'),
    staleTime: 60_000,
    retry: 1,
  });

  const { data: fortiViewStatus } = useFortiViewStatus();

  useEffect(() => {
    apiClient.dbQuery<SpeedTestResult[]>({
      table: 'speed_tests',
      select: '*',
      order: { column: 'tested_at', ascending: false },
      limit: 8,
    }).then(res => {
      // Postgres `numeric` columns come back as strings via node-postgres, but
      // SpeedTestResult types them as numbers and the UI calls .toFixed()/math
      // on them. Coerce to real numbers (dropping any unparseable rows) so the
      // overview doesn't crash with "toFixed is not a function".
      const rows = (res.data ?? [])
        .map(r => ({
          ...r,
          download_mbps: Number(r.download_mbps),
          upload_mbps: Number(r.upload_mbps),
          latency_ms: Number(r.latency_ms),
        }))
        .filter(r => Number.isFinite(r.download_mbps) && Number.isFinite(r.upload_mbps) && Number.isFinite(r.latency_ms));
      setSpeedTests(rows);
    }).catch(() => {});
  }, []);


  const isLoading = healthLoading || statusLoading;

  useEffect(() => {
    if (!isLoading) setLastUpdated(new Date());
  }, [isLoading, health, status]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/system-health'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/system-status'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/ha-status'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/wan-stats'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/sdwan-health'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/health-trends'] });
    queryClient.invalidateQueries({ queryKey: ['/api/network/alerts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/threats'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/devices'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/traffic'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/vpn'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/interfaces'] });
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 30_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  const threats = threatsData?.threats ?? [];
  const devices = useMemo(() => devicesData?.devices ?? [], [devicesData]);
  const topTalkers = trafficData?.top_talkers ?? [];
  const wanHistory = trafficData?.wan_throughput?.history ?? [];
  const vpn = vpnData;
  const interfaces = ifaceData?.interfaces ?? [];

  const critThreats = threats.filter(t => t.severity.toLowerCase() === 'critical').length;
  const highThreats = threats.filter(t => t.severity.toLowerCase() === 'high').length;
  const medThreats = threats.filter(t => t.severity.toLowerCase() === 'medium' || t.severity.toLowerCase() === 'warning').length;
  const infoThreats = threats.filter(t => !['critical','high','medium','warning'].includes(t.severity.toLowerCase())).length;

  const activeDevices = devices.filter(d => isRecentlyActive(d.last_seen)).length;

  const latestSpeed = speedTests[0] ?? null;
  const downloadMbps = latestSpeed?.download_mbps ?? null;
  const latencyMs = latestSpeed?.latency_ms ?? null;
  const avgDownload24h = speedTests.length > 0
    ? speedTests.reduce((s, r) => s + r.download_mbps, 0) / speedTests.length
    : null;

  const healthScore = computeHealthScore({
    wanUp: wanData?.link ?? null,
    cpuPct: health?.cpu_usage ?? null,
    memPct: health?.memory_usage ?? null,
    highThreats,
    critThreats,
    latencyMs,
    downloadMbps,
  });

  const healthLabel = healthScore === 'green' ? 'Healthy' : healthScore === 'yellow' ? 'Degraded' : 'Critical';
  const healthTextColor = healthScore === 'green' ? 'text-emerald-500' : healthScore === 'yellow' ? 'text-yellow-500' : 'text-red-500';

  const offlineInterfaces = interfaces.filter(i => i.status === 'up' && !i.link);
  const alerts: { severity: 'critical' | 'warning'; message: string; tab?: NetworkTab }[] = [];

  if (wanData?.link === false) {
    alerts.push({ severity: 'critical', message: 'WAN link is down', tab: 'interfaces' });
  }
  if (critThreats > 0) {
    alerts.push({ severity: 'critical', message: `${critThreats} critical security threat${critThreats > 1 ? 's' : ''} detected`, tab: 'security' });
  }
  if (highThreats > 0) {
    alerts.push({ severity: 'warning', message: `${highThreats} high-severity threat${highThreats > 1 ? 's' : ''}`, tab: 'security' });
  }
  if ((health?.cpu_usage ?? 0) >= 85) {
    alerts.push({ severity: 'critical', message: `CPU usage critical: ${health!.cpu_usage!.toFixed(0)}%` });
  }
  if ((health?.memory_usage ?? 0) >= 85) {
    alerts.push({ severity: 'critical', message: `Memory usage critical: ${health!.memory_usage!.toFixed(0)}%` });
  }
  if (downloadMbps !== null && downloadMbps < 25) {
    alerts.push({ severity: 'critical', message: `Download speed critically low: ${downloadMbps.toFixed(0)} Mbps` });
  } else if (downloadMbps !== null && downloadMbps < 100) {
    alerts.push({ severity: 'warning', message: `Download speed below threshold: ${downloadMbps.toFixed(0)} Mbps` });
  }
  if (latencyMs !== null && latencyMs > 50) {
    alerts.push({ severity: 'warning', message: `High latency: ${latencyMs.toFixed(0)} ms` });
  }
  if (offlineInterfaces.length > 0) {
    alerts.push({ severity: 'warning', message: `${offlineInterfaces.length} interface${offlineInterfaces.length > 1 ? 's' : ''} enabled but link is down`, tab: 'interfaces' });
  }

  const categoryBreakdown = useMemo(() => {
    const map: Record<string, number> = {};
    for (const d of devices) {
      const k = d.category || 'Other';
      map[k] = (map[k] || 0) + 1;
    }
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [devices]);

  const connectionBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of devices) {
      const key = connectionKey(d.connection);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => {
      const ai = CONNECTION_GROUP_ORDER.indexOf(a[0]);
      const bi = CONNECTION_GROUP_ORDER.indexOf(b[0]);
      if (ai === -1 && bi === -1) return a[0].localeCompare(b[0]);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [devices]);

  const wanSparkData = wanHistory.slice(-20).map(p => (p.rx + p.tx));
  const speedSparkData = speedTests.slice(0, 6).reverse().map(r => r.download_mbps);

  return (
    <div className="space-y-5" data-testid="panel-command-center">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Network Command Center
          </h2>
          <p className="text-sm text-muted-foreground">At-a-glance health across all network systems</p>
        </div>
        <div className="flex items-center gap-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button variant="outline" size="sm" onClick={handleRefresh} data-testid="button-refresh-overview">
            <RefreshCw className="h-4 w-4 mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {healthError && !isLoading && (
        <ErrorCard
          message="The FortiGate API is currently unreachable. Check connectivity and API token."
          onRetry={() => { refetchHealth(); handleRefresh(); }}
        />
      )}

      {/* Overall health score + connection status strip */}
      <Card className="border-border/50" data-testid="card-health-score">
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap items-center gap-5">
            {/* Overall score */}
            <div className="flex items-center gap-3 min-w-fit">
              <HealthDot score={healthScore} />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Overall Health</p>
                <p className={cn('text-base font-bold', healthTextColor)} data-testid="text-health-score">{healthLabel}</p>
              </div>
            </div>

            <div className="h-8 w-px bg-border/50 hidden sm:block" />

            {/* WAN */}
            <div className="flex items-center gap-2">
              <span className={cn('h-2 w-2 rounded-full shrink-0',
                wanData?.link === true ? 'bg-emerald-500' : wanData?.link === false ? 'bg-red-500' : 'bg-muted-foreground'
              )} data-testid="dot-overview-wan" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">WAN</p>
                <p className="text-sm font-semibold" data-testid="text-overview-wan">
                  {wanData?.link === true ? 'Up' : wanData?.link === false ? 'Down' : '—'}
                </p>
              </div>
            </div>

            <div className="h-8 w-px bg-border/50 hidden sm:block" />

            {/* Download speed */}
            <div className="flex items-center gap-2">
              <ArrowDown className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Download</p>
                <p className="text-sm font-semibold font-mono" data-testid="text-overview-download">
                  {downloadMbps !== null ? `${downloadMbps.toFixed(0)} Mbps` : '—'}
                </p>
              </div>
            </div>

            {/* Upload speed */}
            <div className="flex items-center gap-2">
              <ArrowUp className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Upload</p>
                <p className="text-sm font-semibold font-mono" data-testid="text-overview-upload">
                  {latestSpeed?.upload_mbps !== undefined ? `${latestSpeed.upload_mbps.toFixed(0)} Mbps` : '—'}
                </p>
              </div>
            </div>

            {/* Latency */}
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-teal-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Latency</p>
                <p className="text-sm font-semibold font-mono" data-testid="text-overview-latency">
                  {latencyMs !== null ? `${latencyMs.toFixed(0)} ms` : '—'}
                </p>
              </div>
            </div>

            <div className="h-8 w-px bg-border/50 hidden sm:block" />

            {/* CPU */}
            <div className="flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5 text-orange-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">CPU</p>
                <p className={cn('text-sm font-semibold font-mono', usageColor(health?.cpu_usage ?? null))} data-testid="text-overview-cpu">
                  {health?.cpu_usage !== null && health?.cpu_usage !== undefined ? `${health.cpu_usage.toFixed(0)}%` : '—'}
                </p>
              </div>
            </div>

            {/* Memory */}
            <div className="flex items-center gap-2">
              <Activity className="h-3.5 w-3.5 text-purple-400 shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Memory</p>
                <p className={cn('text-sm font-semibold font-mono', usageColor(health?.memory_usage ?? null))} data-testid="text-overview-memory">
                  {health?.memory_usage !== null && health?.memory_usage !== undefined ? `${health.memory_usage.toFixed(0)}%` : '—'}
                </p>
              </div>
            </div>

            <div className="h-8 w-px bg-border/50 hidden sm:block" />

            {/* Uptime */}
            <div className="flex items-center gap-2">
              <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Uptime</p>
                <p className="text-sm font-semibold font-mono" data-testid="text-overview-uptime">{formatUptime(status?.uptime ?? null)}</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* SD-WAN dual-link status */}
      <Card className="border-border/50" data-testid="card-sdwan">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Globe className="h-4 w-4 text-blue-400" />
            Internet Links (SD-WAN)
            {sdwanData && sdwanData.members.length > 1 && (
              <Badge variant="secondary" className="text-[10px]" data-testid="badge-sdwan-mode">
                Load Balanced
              </Badge>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground font-normal font-mono" data-testid="text-sdwan-zone">
              {sdwanData?.zone ?? 'virtual-wan-link'}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3">
            <SdwanLink
              member={sdwanData?.members.find(m => m.interface.toLowerCase() === 'wan1') ?? null}
              stats={wanData?.wan1}
            />
            <SdwanLink
              member={sdwanData?.members.find(m => m.interface.toLowerCase() === 'wan2') ?? null}
              stats={wanData?.wan2}
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-2.5 flex items-center gap-1.5">
            <Activity className="h-3 w-3" />
            Both links active &amp; session load-balanced · SLA: latency ≤ {sdwanData?.sla_latency_threshold_ms ?? 250} ms, loss ≤ {sdwanData?.sla_packet_loss_threshold_pct ?? 5}%
          </p>
        </CardContent>
      </Card>

      {/* Alerts section */}
      {alerts.length > 0 && (
        <div className="space-y-2" data-testid="section-alerts">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            Active Alerts ({alerts.length})
          </h3>
          <div className="space-y-1.5">
            {alerts.map((alert, i) => (
              <div
                key={i}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm cursor-default',
                  alert.severity === 'critical'
                    ? 'bg-destructive/10 border border-destructive/30 text-destructive dark:text-red-400'
                    : 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-700 dark:text-yellow-400',
                  alert.tab && 'cursor-pointer hover:opacity-80 transition-opacity',
                )}
                onClick={alert.tab ? () => onNavigate(alert.tab!) : undefined}
                data-testid={`alert-item-${i}`}
              >
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{alert.message}</span>
                {alert.tab && (
                  <span className="text-xs opacity-60">View →</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3-column grid: Security + Devices + VPN */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">

        {/* Security summary */}
        <Card
          className="border-border/50 cursor-pointer hover:border-border transition-colors"
          onClick={() => onNavigate('security')}
          data-testid="card-security-summary"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="h-4 w-4 text-amber-400" />
              Security
              <span className="ml-auto text-xs text-muted-foreground font-normal">View →</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {threats.length === 0 ? (
              <div className="flex items-center gap-2 text-emerald-500 text-sm py-2">
                <CheckCircle className="h-4 w-4" />
                <span>No active threats</span>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Badge variant="destructive" className="text-xs" data-testid="badge-cc-threat-total">
                    <AlertTriangle className="h-3 w-3 mr-1" />
                    {threats.length} total
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  {critThreats > 0 && (
                    <div className="flex items-center gap-1 text-red-500" data-testid="text-cc-crit-threats">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" />
                      <span className="font-semibold">{critThreats}</span> Critical
                    </div>
                  )}
                  {highThreats > 0 && (
                    <div className="flex items-center gap-1 text-orange-400" data-testid="text-cc-high-threats">
                      <span className="h-1.5 w-1.5 rounded-full bg-orange-400 shrink-0" />
                      <span className="font-semibold">{highThreats}</span> High
                    </div>
                  )}
                  {medThreats > 0 && (
                    <div className="flex items-center gap-1 text-yellow-500" data-testid="text-cc-med-threats">
                      <span className="h-1.5 w-1.5 rounded-full bg-yellow-500 shrink-0" />
                      <span className="font-semibold">{medThreats}</span> Medium
                    </div>
                  )}
                  {infoThreats > 0 && (
                    <div className="flex items-center gap-1 text-muted-foreground" data-testid="text-cc-info-threats">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground shrink-0" />
                      <span className="font-semibold">{infoThreats}</span> Info
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Device summary */}
        <Card
          className="border-border/50 cursor-pointer hover:border-border transition-colors"
          onClick={() => onNavigate('devices')}
          data-testid="card-device-summary"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-400" />
              Devices
              <span className="ml-auto text-xs text-muted-foreground font-normal">View →</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold font-mono" data-testid="text-cc-device-total">{devices.length}</span>
              <div className="text-sm">
                <span className="text-emerald-500 font-semibold" data-testid="text-cc-device-active">{activeDevices}</span>
                <span className="text-muted-foreground"> active now</span>
              </div>
            </div>
            {connectionBreakdown.length > 0 && (
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/30" data-testid="cc-connection-bar">
                {connectionBreakdown.map(([key, count]) => {
                  const pct = (count / devices.length) * 100;
                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      aria-label={`View ${connectionLabel(key)} devices`}
                      className={cn(
                        'h-full cursor-pointer transition-opacity hover:opacity-70 focus-visible:opacity-70 outline-none',
                        CONNECTION_BAR_COLORS[key] ?? 'bg-muted-foreground/40',
                      )}
                      style={{ width: `${pct}%` }}
                      title={`${connectionLabel(key)}: ${count} (${pct.toFixed(0)}%) — click to view`}
                      onClick={e => { e.stopPropagation(); handleConnectionClick(key); }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          handleConnectionClick(key);
                        }
                      }}
                      data-testid={`bar-cc-conn-${key}`}
                    />
                  );
                })}
              </div>
            )}
            {connectionBreakdown.length > 0 && (
              <div className="flex flex-wrap gap-x-3 gap-y-1" data-testid="cc-connection-legend">
                {connectionBreakdown.map(([key, count]) => {
                  const pct = (count / devices.length) * 100;
                  return (
                    <span
                      key={key}
                      role="button"
                      tabIndex={0}
                      title={`View ${connectionLabel(key)} devices`}
                      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground hover:underline underline-offset-2 transition-colors select-none"
                      onClick={e => { e.stopPropagation(); handleConnectionClick(key); }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          e.stopPropagation();
                          handleConnectionClick(key);
                        }
                      }}
                      data-testid={`legend-cc-conn-${key}`}
                    >
                      <span
                        className={cn('h-2 w-2 rounded-full shrink-0', CONNECTION_BAR_COLORS[key] ?? 'bg-muted-foreground/40')}
                      />
                      {connectionLabel(key)}
                      <span className="text-muted-foreground/70">{pct.toFixed(0)}%</span>
                    </span>
                  );
                })}
              </div>
            )}
            {connectionBreakdown.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border/30" data-testid="cc-connection-breakdown">
                {connectionBreakdown.map(([key, count]) => (
                  <span
                    key={key}
                    role="button"
                    tabIndex={0}
                    title={`View ${connectionLabel(key)} devices`}
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer select-none transition-all opacity-90 hover:opacity-100 hover:scale-105 hover:shadow-sm',
                      CONNECTION_COLORS[key] ?? 'bg-muted/30 text-muted-foreground border-border/50',
                    )}
                    onClick={e => { e.stopPropagation(); handleConnectionClick(key); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        handleConnectionClick(key);
                      }
                    }}
                    data-testid={`badge-cc-conn-${key}`}
                  >
                    {key === 'wired' && <Cable className="h-3 w-3" />}
                    {key.startsWith('wifi:') && <Wifi className="h-3 w-3" />}
                    {key === '__unknown__' && <HelpCircle className="h-3 w-3" />}
                    {connectionLabel(key)} <span className="font-bold">{count}</span>
                  </span>
                ))}
              </div>
            )}
            {categoryBreakdown.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {categoryBreakdown.map(([cat, count]) => (
                  <Badge key={cat} variant="secondary" className="text-xs" data-testid={`badge-cc-cat-${cat}`}>
                    {cat} <span className="ml-1 font-bold">{count}</span>
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* VPN sessions */}
        <Card
          className="border-border/50 cursor-pointer hover:border-border transition-colors"
          onClick={() => onNavigate('security')}
          data-testid="card-vpn-summary"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Lock className="h-4 w-4 text-blue-400" />
              VPN Sessions
              <span className="ml-auto text-xs text-muted-foreground font-normal">View →</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {!vpn || vpn.total === 0 ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
                <Lock className="h-4 w-4" />
                <span>No active sessions</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-1">
                  {vpn.ssl_count > 0 && (
                    <Badge variant="outline" className="text-xs" data-testid="badge-cc-ssl-count">
                      {vpn.ssl_count} SSL
                    </Badge>
                  )}
                  {vpn.ipsec_count > 0 && (
                    <Badge variant="outline" className="text-xs" data-testid="badge-cc-ipsec-count">
                      {vpn.ipsec_count} IPsec
                    </Badge>
                  )}
                </div>
                <div className="space-y-1">
                  {vpn.sessions.slice(0, 4).map((s, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs" data-testid={`row-cc-vpn-${i}`}>
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-400 shrink-0" />
                      <span className="font-medium truncate">{s.user}</span>
                      <span className="text-muted-foreground ml-auto uppercase text-[10px]">{s.type}</span>
                    </div>
                  ))}
                  {vpn.total > 4 && (
                    <p className="text-[10px] text-muted-foreground">+{vpn.total - 4} more</p>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 2-column grid: Top Bandwidth Consumers + WAN Throughput sparkline */}
      <div className="grid gap-4 sm:grid-cols-2">

        {/* Top 5 bandwidth consumers */}
        <Card
          className="border-border/50 cursor-pointer hover:border-border transition-colors"
          onClick={() => onNavigate('traffic')}
          data-testid="card-top-talkers"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-orange-400" />
              Top Bandwidth Consumers
              <span className="ml-auto text-xs text-muted-foreground font-normal">View →</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topTalkers.length === 0 ? (
              <div className="py-3 text-center space-y-1" data-testid="cc-talkers-empty">
                <p className="text-sm text-muted-foreground">No traffic data</p>
                {fortiViewStatus && fortiViewStatus.cache_ready && !fortiViewStatus.top_talkers.present && (
                  <p className="text-xs text-blue-400" data-testid="text-cc-fortiview-setup">
                    FortiView sensor not set up — open Traffic for setup steps
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {topTalkers.slice(0, 5).map((t, i) => {
                  const maxBytes = topTalkers[0].bytes || 1;
                  return (
                    <div key={t.ip} className="space-y-0.5" data-testid={`row-cc-talker-${i}`}>
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground font-mono tabular-nums w-4">#{i + 1}</span>
                          <span className="font-mono truncate max-w-[120px]">{t.ip}</span>
                        </div>
                        <span className="font-semibold font-mono text-xs shrink-0">{formatBytes(t.bytes)}</span>
                      </div>
                      <div className="w-full bg-muted rounded-full h-1">
                        <div
                          className="h-1 rounded-full bg-orange-400/80"
                          style={{ width: `${(t.bytes / maxBytes) * 100}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ISP speed test trend + WAN throughput sparkline */}
        <Card
          className="border-border/50 cursor-pointer hover:border-border transition-colors"
          onClick={() => onNavigate('traffic')}
          data-testid="card-isp-trend"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Wifi className="h-4 w-4 text-blue-400" />
              ISP Health &amp; WAN Throughput
              <span className="ml-auto text-xs text-muted-foreground font-normal">View →</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Speed test sparkline */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Speed Test Trend (last 6)</p>
                {avgDownload24h !== null && (
                  <span className="text-[10px] text-muted-foreground">
                    Avg: <span className="font-semibold font-mono">{avgDownload24h.toFixed(0)} Mbps</span>
                  </span>
                )}
              </div>
              {speedSparkData.length >= 2 ? (
                <div className="flex items-end gap-3">
                  <MiniSparkline data={speedSparkData} width={100} height={30} color="#22c55e" />
                  <div className="text-xs space-y-0.5">
                    {latestSpeed && (
                      <>
                        <div className="flex items-center gap-1">
                          <ArrowDown className="h-2.5 w-2.5 text-emerald-400" />
                          <span className="font-mono font-semibold" data-testid="text-cc-speed-dl">{latestSpeed.download_mbps.toFixed(0)} Mbps</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <ArrowUp className="h-2.5 w-2.5 text-blue-400" />
                          <span className="font-mono font-semibold" data-testid="text-cc-speed-ul">{latestSpeed.upload_mbps.toFixed(0)} Mbps</span>
                        </div>
                        <div className="text-muted-foreground text-[10px]">{latestSpeed.latency_ms.toFixed(0)} ms ping</div>
                      </>
                    )}
                  </div>
                </div>
              ) : speedTests.length > 0 ? (
                <div className="text-xs text-muted-foreground">Need more data points for trend</div>
              ) : (
                <div className="text-xs text-muted-foreground py-1">No speed test data</div>
              )}
            </div>

            <div className="border-t border-border/30" />

            {/* WAN throughput history sparkline */}
            <div>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">WAN Throughput (last hour)</p>
              {wanSparkData.length >= 2 ? (
                <div className="flex items-end gap-3">
                  <MiniSparkline data={wanSparkData} width={100} height={30} color="#60a5fa" />
                  <div className="text-xs space-y-0.5">
                    <div className="flex items-center gap-1">
                      <span className="text-emerald-500">↓</span>
                      <span className="font-mono font-semibold text-xs" data-testid="text-cc-wan-rx">
                        {formatBytes(trafficData?.wan_throughput?.rx_bytes ?? null)}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-blue-400">↑</span>
                      <span className="font-mono font-semibold text-xs" data-testid="text-cc-wan-tx">
                        {formatBytes(trafficData?.wan_throughput?.tx_bytes ?? null)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground py-1">No throughput history</div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* System info + HA row */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Shield className="h-4 w-4 text-orange-400" />
              Firewall Info
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Hostname</span>
              <span className="font-mono" data-testid="text-overview-hostname">{status?.hostname ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Firmware</span>
              <Badge variant="outline" className="font-mono text-xs" data-testid="badge-overview-firmware">
                {status?.firmware_version ?? '—'}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Serial</span>
              <span className="font-mono text-xs text-muted-foreground" data-testid="text-overview-serial">{status?.serial_number ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Active Sessions</span>
              <span className="font-mono" data-testid="text-overview-sessions">
                {health?.active_sessions !== null && health?.active_sessions !== undefined
                ? (safeNumber(health.active_sessions) ?? 0).toLocaleString() : '—'}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Wifi className="h-4 w-4 text-blue-400" />
              WAN &amp; Resources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">WAN Link</span>
              <div className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full',
                  wanData?.link === true ? 'bg-emerald-500' : wanData?.link === false ? 'bg-red-500' : 'bg-muted-foreground'
                )} />
                <span data-testid="text-overview-wan-status">
                  {wanData?.link === true ? 'Connected' : wanData?.link === false ? 'Disconnected' : '—'}
                </span>
              </div>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">WAN RX</span>
              <span className="font-mono" data-testid="text-overview-wan-rx">{formatBytes((wanData?.rx_gb ?? null) !== null ? (wanData!.rx_gb! * 1073741824) : null)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">WAN TX</span>
              <span className="font-mono" data-testid="text-overview-wan-tx">{formatBytes((wanData?.tx_gb ?? null) !== null ? (wanData!.tx_gb! * 1073741824) : null)}</span>
            </div>
            <div className="pt-1 space-y-1.5">
              <GaugeStat label="CPU" value={health?.cpu_usage ?? null} pct={health?.cpu_usage ?? null} icon={<Cpu className="h-3.5 w-3.5 text-orange-400" />} />
              <GaugeStat label="Memory" value={health?.memory_usage ?? null} pct={health?.memory_usage ?? null} icon={<Activity className="h-3.5 w-3.5 text-purple-400" />} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* HA Status */}
      {haData?.ha && haData.peers.length > 0 && (
        <Card className="border-border/50" data-testid="card-ha-status">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4 text-primary" />
              HA Cluster Members
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {haData.peers.map((peer, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-md border border-border/50 px-3 py-1.5 text-sm"
                  data-testid={`badge-ha-peer-${idx}`}
                >
                  <span className="font-medium">{peer.hostname || `Node ${idx + 1}`}</span>
                  {peer.role && (
                    <Badge
                      variant={peer.role === 'master' || peer.role === 'primary' ? 'default' : 'secondary'}
                      className="text-xs capitalize"
                    >
                      {peer.role}
                    </Badge>
                  )}
                  {peer.serial_no && (
                    <span className="text-muted-foreground text-xs">{peer.serial_no}</span>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Health trend mini-charts */}
      <div data-testid="section-health-trends">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Health Trends</h3>
          {snapshotsData && (
            <Badge variant="secondary" className="text-xs ml-auto">
              {snapshotsData.count} snapshot{snapshotsData.count !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        <HealthTrendChart snapshots={snapshotsData?.snapshots ?? []} />
      </div>

      {/* Network Alerts */}
      <NetworkAlertsSection />
    </div>
  );
}
