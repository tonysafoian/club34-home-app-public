import { useState, useEffect, useCallback, useMemo } from 'react';
import { Wifi, ArrowDown, ArrowUp, Clock, RefreshCw, Loader2, TrendingUp, TrendingDown, Minus, Shield, Activity, AlertTriangle } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/apiClient';
import { HAEntity } from '@/lib/api/homeAssistant';
import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';
import { cn } from '@/lib/utils';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';

interface SpeedTestResult {
  id: string;
  download_mbps: number;
  upload_mbps: number;
  latency_ms: number;
  jitter_ms: number | null;
  server_name: string | null;
  tested_at: string;
  provider: string;
}

interface WanLinkStats {
  rx_bytes: number | null;
  tx_bytes: number | null;
  rx_gb: number | null;
  tx_gb: number | null;
  link: boolean | null;
  wan_status: string;
}

interface WanStats extends WanLinkStats {
  source?: string;
  wan1?: WanLinkStats | null;
  wan2?: WanLinkStats | null;
}

const SPEEDTEST_ENTITIES = [
  'sensor.speedtest_download',
  'sensor.speedtest_upload',
  'sensor.speedtest_ping',
];

const SPEEDTEST_SET = new Set(SPEEDTEST_ENTITIES);

function numVal(entities: Record<string, HAEntity>, id: string): number {
  const v = parseFloat(entities[id]?.state ?? '');
  return isNaN(v) ? 0 : v;
}

function trendIcon(current: number, previous: number | null) {
  if (previous === null) return <Minus className="h-3 w-3 text-muted-foreground" />;
  if (current > previous * 1.05) return <TrendingUp className="h-3 w-3 text-emerald-400" />;
  if (current < previous * 0.95) return <TrendingDown className="h-3 w-3 text-red-400" />;
  return <Minus className="h-3 w-3 text-muted-foreground" />;
}

function latencyColor(ms: number): string {
  if (ms <= 15) return 'text-emerald-400';
  if (ms <= 40) return 'text-yellow-400';
  return 'text-red-400';
}

function speedGrade(downloadMbps: number): { label: string; color: string } {
  if (downloadMbps >= 800) return { label: 'Excellent', color: 'text-emerald-400' };
  if (downloadMbps >= 400) return { label: 'Good', color: 'text-blue-400' };
  if (downloadMbps >= 100) return { label: 'Fair', color: 'text-yellow-400' };
  return { label: 'Poor', color: 'text-red-400' };
}

function wanStatusColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'up' || s === 'online') return 'text-emerald-400';
  if (s === 'down' || s === 'offline') return 'text-red-400';
  return 'text-yellow-400';
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 mt-1">
      {children}
    </p>
  );
}

type TimeRange = '24h' | '7d';

interface HistoryDataPoint {
  timeLabel: string;
  download: number | null;
  upload: number | null;
  latency: number | null;
}

function SpeedTestHistoryChart({ results, timeRange, onTimeRangeChange }: {
  results: SpeedTestResult[];
  timeRange: TimeRange;
  onTimeRangeChange: (r: TimeRange) => void;
}) {
  const cutoff = timeRange === '24h'
    ? Date.now() - 24 * 60 * 60 * 1000
    : Date.now() - 7 * 24 * 60 * 60 * 1000;

  const filtered = results.filter(r => new Date(r.tested_at).getTime() >= cutoff);
  const data: HistoryDataPoint[] = [...filtered].reverse().map(r => ({
    timeLabel: new Date(r.tested_at).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
    download: r.download_mbps,
    upload: r.upload_mbps,
    latency: r.latency_ms,
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Speed History</p>
        <div className="flex gap-1">
          {(['24h', '7d'] as TimeRange[]).map(r => (
            <button
              key={r}
              onClick={() => onTimeRangeChange(r)}
              className={cn(
                'text-[10px] px-2 py-0.5 rounded font-medium transition-colors',
                timeRange === r
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              data-testid={`button-speedtest-range-${r}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      {data.length < 2 ? (
        <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">
          Not enough data for the selected range
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={90} data-testid="chart-speedtest-history">
          <LineChart data={data} margin={{ top: 2, right: 4, left: -28, bottom: 0 }}>
            <XAxis dataKey="timeLabel" hide />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9 }} tickFormatter={v => `${v}`} />
            <Tooltip
              contentStyle={{ fontSize: '11px' }}
              formatter={(v: number, name: string) => {
                if (name === 'latency') return [`${v.toFixed(0)} ms`, 'Latency'];
                return [`${v.toFixed(0)} Mbps`, name === 'download' ? 'Download' : 'Upload'];
              }}
              labelFormatter={(_l, payload) => payload?.[0]?.payload?.timeLabel ?? ''}
            />
            <Line type="monotone" dataKey="download" stroke="#34d399" strokeWidth={1.5} dot={false} connectNulls name="download" />
            <Line type="monotone" dataKey="upload" stroke="#60a5fa" strokeWidth={1.5} dot={false} connectNulls name="upload" />
            <Line type="monotone" dataKey="latency" stroke="#fbbf24" strokeWidth={1} dot={false} connectNulls strokeDasharray="4 2" name="latency" />
          </LineChart>
        </ResponsiveContainer>
      )}
      <div className="flex gap-3 mt-1.5 justify-center">
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="h-2 w-4 rounded bg-emerald-400 inline-block" /> Download
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="h-2 w-4 rounded bg-blue-400 inline-block" /> Upload
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="h-px w-4 bg-yellow-400 inline-block border-t-2 border-dashed border-yellow-400" /> Latency
        </div>
      </div>
    </div>
  );
}

export function SpectrumCard() {
  const [results, setResults] = useState<SpeedTestResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const { allEntities, loading: haLoading } = useSharedHAAllEntities();

  const [wanStats, setWanStats] = useState<WanStats | null>(null);
  const [wanLoading, setWanLoading] = useState(true);

  const haEntities = useMemo(() => {
    const map: Record<string, HAEntity> = {};
    for (const e of allEntities) {
      if (SPEEDTEST_SET.has(e.entity_id) || e.entity_id.includes('speedtest')) {
        map[e.entity_id] = e;
      }
    }
    return map;
  }, [allEntities]);

  const fetchHistory = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError(null);

      const { data } = await apiClient.dbQuery<SpeedTestResult[]>({
        table: 'speed_tests',
        select: '*',
        filters: [{ column: 'provider', op: 'eq', value: 'spectrum' }],
        order: { column: 'tested_at', ascending: false },
        limit: 200,
      });
      setResults(data ?? []);
    } catch (e) {
      console.error('Spectrum speed fetch error:', e);
      setError(e instanceof Error ? e.message : 'Failed to load');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchWanStats = useCallback(async (silent = false) => {
    if (!silent) setWanLoading(true);
    try {
      const data = await apiClient.get<WanStats>('/api/fortigate/wan-stats');
      setWanStats(data);
    } catch {
      setWanStats(null);
    } finally {
      setWanLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    fetchWanStats();
    const historyInterval = setInterval(() => fetchHistory(true), 60_000);
    const wanInterval = setInterval(() => fetchWanStats(true), 60_000);
    return () => {
      clearInterval(historyInterval);
      clearInterval(wanInterval);
    };
  }, [fetchHistory, fetchWanStats]);

  const latest = results[0] || null;
  const previous = results[1] || null;

  const avgDownload = results.length > 0
    ? results.reduce((s, r) => s + r.download_mbps, 0) / results.length
    : 0;
  const avgLatency = results.length > 0
    ? results.reduce((s, r) => s + r.latency_ms, 0) / results.length
    : 0;

  // Scope to WAN1 (Spectrum) under SD-WAN. Falls back to top-level fields
  // (WAN1-scoped for backward compat) when per-link breakdown is absent.
  const wan1 = wanStats?.wan1 ?? wanStats;
  const wanStatus = wan1?.wan_status ?? '—';
  const wanRx = wan1?.rx_gb ?? null;
  const wanTx = wan1?.tx_gb ?? null;

  const hasFgData = wanStats !== null && wan1 != null;
  const hasSpeedTests = results.length > 0;

  const haSpeedtestDown = numVal(haEntities, 'sensor.speedtest_download');
  const haSpeedtestUp = numVal(haEntities, 'sensor.speedtest_upload');
  const haSpeedtestPing = numVal(haEntities, 'sensor.speedtest_ping');
  const hasHASpeedtest = haEntities['sensor.speedtest_download'] && haEntities['sensor.speedtest_download'].state !== 'unavailable' && haEntities['sensor.speedtest_download'].state !== 'unknown';
  const haSpeedtestLastChanged = haEntities['sensor.speedtest_download']?.last_changed;
  const haSpeedtestServerName = haEntities['sensor.speedtest_download']?.attributes?.server_name as string | undefined;

  const liveDownload = hasHASpeedtest ? haSpeedtestDown : (latest?.download_mbps ?? 0);
  const liveUpload = hasHASpeedtest ? haSpeedtestUp : (latest?.upload_mbps ?? 0);
  const livePing = hasHASpeedtest ? haSpeedtestPing : (latest?.latency_ms ?? 0);

  const wanLinkKnown = wan1?.link !== null && wan1?.link !== undefined;
  const wanIsUp = wan1?.link === true || wanStatus.toLowerCase() === 'up';
  const wanIsDown = wanLinkKnown && wan1?.link === false && wanStatus.toLowerCase() !== 'up';
  const isOnline = wanIsUp || hasHASpeedtest || hasSpeedTests;
  const isStruggling = (liveDownload > 0 && liveDownload < 100) || (livePing > 50);
  const isDown = wanIsDown && !hasHASpeedtest && !hasSpeedTests;

  const allLoading = (haLoading || loading || wanLoading);

  const statusText = allLoading
    ? 'Loading...'
    : isDown
      ? 'Offline'
      : isStruggling
        ? 'Degraded'
        : hasFgData
          ? `WAN ${wanStatus}`
          : hasHASpeedtest
            ? speedGrade(haSpeedtestDown).label
            : hasSpeedTests
              ? speedGrade(latest!.download_mbps).label
              : 'No Data';

  const overallStatus = allLoading ? 'idle' as const : isDown ? 'offline' as const : isOnline ? 'online' as const : 'offline' as const;

  return (
    <SystemCard
      title="Spectrum Internet"
      icon={<Wifi className="h-6 w-6 text-blue-400" />}
      status={overallStatus}
      statusText={statusText}
      accentColor="bg-blue-500/10"
      metrics={[
        { label: 'Download', value: liveDownload > 0 ? `${liveDownload.toFixed(0)} Mbps` : '—' },
        { label: 'Upload', value: liveUpload > 0 ? `${liveUpload.toFixed(0)} Mbps` : '—' },
        { label: 'Ping', value: livePing > 0 ? `${livePing.toFixed(0)} ms` : '—' },
        { label: 'WAN', value: hasFgData ? wanStatus : (isOnline ? 'Online' : '—') },
      ]}
    >
      {allLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : error && !hasFgData && !hasHASpeedtest ? (
        <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => fetchHistory()} data-testid="button-retry-spectrum">
            <RefreshCw className="h-3 w-3 mr-1" /> Retry
          </Button>
        </div>
      ) : !hasFgData && !hasSpeedTests && !hasHASpeedtest ? (
        <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
          <div className="rounded-full bg-blue-500/10 p-3">
            <Wifi className="h-6 w-6 text-blue-400" />
          </div>
          <div>
            <p className="text-sm font-semibold" data-testid="text-spectrum-empty">No Network Data</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Speedtest and FortiGate WAN data will appear here once available.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {(isDown || isStruggling) && (
            <div className={cn(
              'flex items-start gap-2 p-2.5 rounded-lg text-xs',
              isDown ? 'bg-destructive/10 text-destructive' : 'bg-yellow-500/10 text-yellow-600'
            )} data-testid="alert-internet-issue">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <div>
                <span className="font-medium">{isDown ? 'Internet is down' : 'Internet is degraded'}</span>
                {isStruggling && !isDown && (
                  <span className="block mt-0.5 text-muted-foreground">
                    {liveDownload > 0 && liveDownload < 100 ? `Download: ${liveDownload.toFixed(0)} Mbps (below 100 Mbps). ` : ''}
                    {livePing > 50 ? `Latency: ${livePing.toFixed(0)}ms (above 50ms)` : ''}
                  </span>
                )}
              </div>
            </div>
          )}

          {hasHASpeedtest && (
            <>
              <div>
                <SectionLabel>HA Speedtest — Live</SectionLabel>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2">
                    <ArrowDown className="h-4 w-4 text-emerald-400" />
                    <div>
                      <div className="flex items-center gap-1">
                        <span className={cn('text-lg font-bold font-mono tabular-nums', speedGrade(haSpeedtestDown).color)} data-testid="text-ha-speedtest-download">
                          {haSpeedtestDown.toFixed(1)}
                        </span>
                        <span className="text-xs text-muted-foreground">Mbps</span>
                        {latest && trendIcon(haSpeedtestDown, latest.download_mbps)}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Download</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowUp className="h-4 w-4 text-blue-400" />
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="text-lg font-bold font-mono tabular-nums" data-testid="text-ha-speedtest-upload">
                          {haSpeedtestUp.toFixed(1)}
                        </span>
                        <span className="text-xs text-muted-foreground">Mbps</span>
                        {latest && trendIcon(haSpeedtestUp, latest.upload_mbps)}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Upload</p>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <div>
                    <span className="text-[10px] text-muted-foreground">Ping</span>
                    <p className={cn('font-mono font-semibold text-sm', latencyColor(haSpeedtestPing))} data-testid="text-ha-speedtest-ping">
                      {haSpeedtestPing.toFixed(1)} ms
                    </p>
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground">Last Tested</span>
                    <p className="font-mono text-xs text-muted-foreground">
                      {haSpeedtestLastChanged
                        ? new Date(haSpeedtestLastChanged).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                        : '—'}
                    </p>
                  </div>
                </div>
                {haSpeedtestServerName && (
                  <div className="mt-2">
                    <Badge variant="outline" className="text-[10px] font-mono">{haSpeedtestServerName}</Badge>
                  </div>
                )}
              </div>
              <div className="border-t border-border" />
            </>
          )}

          {hasFgData && (
            <>
              <div>
                <SectionLabel>FortiGate WAN1 (Spectrum) — Live</SectionLabel>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-muted/30 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Activity className="h-3.5 w-3.5 text-blue-400" />
                      <span className="text-[10px] text-muted-foreground uppercase">Status</span>
                    </div>
                    <p className={cn('text-lg font-bold', wanStatusColor(wanStatus))} data-testid="text-fortigate-wan-status">
                      {wanStatus}
                    </p>
                  </div>
                  <div className="bg-muted/30 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Wifi className="h-3.5 w-3.5 text-blue-400" />
                      <span className="text-[10px] text-muted-foreground uppercase">Link</span>
                    </div>
                    <p className={cn('text-lg font-bold', wan1?.link ? 'text-emerald-400' : 'text-red-400')} data-testid="text-fortigate-wan-link">
                      {wan1?.link ? 'Up' : 'Down'}
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3 mt-3">
                  <div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
                      <ArrowDown className="h-3 w-3 text-emerald-400" /> WAN RX
                    </div>
                    <p className="font-mono font-semibold text-sm" data-testid="text-fortigate-wan-rx">
                      {wanRx !== null ? `${wanRx.toFixed(2)} GB` : '—'}
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
                      <ArrowUp className="h-3 w-3 text-blue-400" /> WAN TX
                    </div>
                    <p className="font-mono font-semibold text-sm" data-testid="text-fortigate-wan-tx">
                      {wanTx !== null ? `${wanTx.toFixed(2)} GB` : '—'}
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
                      <Shield className="h-3 w-3 text-amber-400" /> IPS
                    </div>
                    <p className="font-mono font-semibold text-sm text-muted-foreground" data-testid="text-fortigate-ips">
                      —
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-border" />
            </>
          )}

          {hasSpeedTests && (
            <>
              <div>
                <SectionLabel>Speed Test History</SectionLabel>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2">
                    <ArrowDown className="h-4 w-4 text-emerald-400" />
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="text-lg font-bold font-mono tabular-nums" data-testid="text-spectrum-download">
                          {latest!.download_mbps.toFixed(1)}
                        </span>
                        <span className="text-xs text-muted-foreground">Mbps</span>
                        {trendIcon(latest!.download_mbps, previous?.download_mbps ?? null)}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Download</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowUp className="h-4 w-4 text-blue-400" />
                    <div>
                      <div className="flex items-center gap-1">
                        <span className="text-lg font-bold font-mono tabular-nums" data-testid="text-spectrum-upload">
                          {latest!.upload_mbps.toFixed(1)}
                        </span>
                        <span className="text-xs text-muted-foreground">Mbps</span>
                        {trendIcon(latest!.upload_mbps, previous?.upload_mbps ?? null)}
                      </div>
                      <p className="text-[10px] text-muted-foreground">Upload</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="border-t border-border" />

              <div>
                <SectionLabel>Latency</SectionLabel>
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <span className="text-muted-foreground">Ping</span>
                    <p className={cn('font-mono font-semibold text-sm', latencyColor(latest!.latency_ms))} data-testid="text-spectrum-latency">
                      {latest!.latency_ms.toFixed(1)} ms
                    </p>
                  </div>
                  {latest!.jitter_ms !== null && (
                    <div>
                      <span className="text-muted-foreground">Jitter</span>
                      <p className="font-mono font-semibold text-sm" data-testid="text-spectrum-jitter">
                        {latest!.jitter_ms.toFixed(1)} ms
                      </p>
                    </div>
                  )}
                  <div>
                    <span className="text-muted-foreground">Avg Latency</span>
                    <p className={cn('font-mono font-semibold text-sm', latencyColor(avgLatency))}>
                      {avgLatency.toFixed(1)} ms
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-border" />

              <div>
                <SectionLabel>24h Averages</SectionLabel>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <span className="text-muted-foreground">Avg Download</span>
                    <p className="font-mono font-semibold text-sm">{avgDownload.toFixed(0)} Mbps</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Latency</span>
                    <p className="font-mono font-semibold text-sm">{avgLatency.toFixed(1)} ms</p>
                  </div>
                </div>
              </div>

              <div className="border-t border-border" />

              <SpeedTestHistoryChart
                results={results}
                timeRange={timeRange}
                onTimeRangeChange={setTimeRange}
              />

              <div className="border-t border-border" />

              <div>
                <SectionLabel>Recent Tests</SectionLabel>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {results.slice(0, 8).map((r, i) => (
                    <div key={r.id || i} className="flex items-center justify-between text-[11px] font-mono py-1" data-testid={`row-spectrum-test-${i}`}>
                      <span className="text-muted-foreground">
                        <Clock className="h-3 w-3 inline mr-1" />
                        {new Date(r.tested_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="tabular-nums">
                        <ArrowDown className="h-3 w-3 inline text-emerald-400" /> {r.download_mbps.toFixed(0)}
                        <span className="mx-1 text-muted-foreground">/</span>
                        <ArrowUp className="h-3 w-3 inline text-blue-400" /> {r.upload_mbps.toFixed(0)}
                        <span className="mx-1 text-muted-foreground">|</span>
                        {r.latency_ms.toFixed(0)}ms
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {latest?.server_name && (
                <>
                  <div className="border-t border-border" />
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Badge variant="outline" className="text-[10px] font-mono">{latest.server_name}</Badge>
                    <span>Last tested: {new Date(latest.tested_at).toLocaleString()}</span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </SystemCard>
  );
}
