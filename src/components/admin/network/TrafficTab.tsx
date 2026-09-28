import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  RefreshCw, Wifi, Network, TrendingUp, Clock, ChevronRight, Globe, Pencil, X, Check, ArrowRight, Activity,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar,
} from 'recharts';
import { cn } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import type { TrafficResponse, WanHistoryResponse, TrafficTalker, DeviceTrafficResponse, DevicesResponse, ConnectedDevice, NetworkTab } from './types';
import {
  LastUpdated, SectionSkeleton, ErrorCard, FortiViewSetupCallout,
} from './shared';
import { formatBytes, formatTimestamp } from './shared-utils';
import { ConnectionBadge, DeviceEditPopover } from './DevicesTab';
import { DEVICE_CATEGORIES } from './device-category';

function TalkerRename({ talker, onDone }: { talker: TrafficTalker; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(talker.hostname ?? '');
  const [category, setCategory] = useState(talker.category ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const mutation = useMutation({
    // The PUT merges with the stored override, so only the fields the admin
    // actually changed are sent — a category-only save must NOT pin the
    // currently displayed hostname as a custom_name override.
    mutationFn: (body: { custom_name?: string | null; custom_category?: string | null; original_hostname?: string | null }) =>
      apiClient.request(`/api/fortigate/device-overrides/${encodeURIComponent(talker.mac || '')}`, {
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/traffic'] });
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/devices'] });
      toast({ title: 'Device updated', description: 'Override saved successfully' });
      onDone();
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to save device override', variant: 'destructive' });
    },
  });

  function handleSave() {
    if (!talker.mac) return;
    const body: { custom_name?: string | null; custom_category?: string | null; original_hostname?: string | null } = {};
    const trimmedName = value.trim();
    const nameChanged = trimmedName !== (talker.hostname ?? '').trim();
    const categoryChanged = (category || null) !== (talker.category ?? null);
    if (!nameChanged && !categoryChanged) {
      onDone();
      return;
    }
    if (nameChanged) {
      body.custom_name = trimmedName || null;
      body.original_hostname = talker.hostname ?? null;
    }
    if (categoryChanged) {
      body.custom_category = category || null;
    }
    mutation.mutate(body);
  }

  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0" onClick={e => e.stopPropagation()}>
      <Input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={talker.ip}
        className="h-7 text-sm"
        data-testid={`input-talker-name-${talker.ip}`}
        onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onDone(); }}
        onClick={e => e.stopPropagation()}
      />
      <Select
        value={category || AUTO_CATEGORY}
        onValueChange={v => setCategory(v === AUTO_CATEGORY ? '' : v)}
      >
        <SelectTrigger
          className="h-7 w-32 sm:w-44 shrink-0 text-xs"
          data-testid={`select-talker-category-${talker.ip}`}
          onClick={e => e.stopPropagation()}
        >
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO_CATEGORY}>— auto detected —</SelectItem>
          {DEVICE_CATEGORIES.map(c => (
            <SelectItem key={c} value={c} data-testid={`option-talker-category-${c}`}>
              {c}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={(e) => { e.stopPropagation(); handleSave(); }}
        disabled={mutation.isPending}
        data-testid={`button-save-talker-${talker.ip}`}
      >
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        onClick={(e) => { e.stopPropagation(); onDone(); }}
        data-testid={`button-cancel-talker-${talker.ip}`}
      >
        <X className="h-3.5 w-3.5 text-muted-foreground" />
      </Button>
    </div>
  );
}

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatMbps(mbps: number): string {
  if (!Number.isFinite(mbps) || mbps <= 0) return '0 MB/s';
  if (mbps < 1) return `${(mbps * 1024).toFixed(0)} KB/s`;
  if (mbps >= 1024) return `${(mbps / 1024).toFixed(2)} GB/s`;
  return `${mbps.toFixed(mbps < 10 ? 2 : 1)} MB/s`;
}

export function TrafficTab({ onNavigate }: { onNavigate?: (tab: NetworkTab) => void } = {}) {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selectedTalker, setSelectedTalker] = useState<TrafficTalker | null>(null);
  const [editingMac, setEditingMac] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<TrafficResponse>({
    queryKey: ['/api/fortigate/traffic'],
    queryFn: () => apiClient.get<TrafficResponse>('/api/fortigate/traffic'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: wanHistory, refetch: refetchHistory } = useQuery<WanHistoryResponse>({
    queryKey: ['/api/fortigate/wan-history'],
    queryFn: () => apiClient.get<WanHistoryResponse>('/api/fortigate/wan-history?window=60'),
    staleTime: 30_000,
    retry: 1,
  });

  useEffect(() => {
    if (!isLoading && !isFetching) setLastUpdated(new Date());
  }, [isLoading, isFetching, data]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/traffic'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/wan-history'] });
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 60_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  const topTalkers = data?.top_talkers ?? [];
  const ifaceBandwidth = data?.interface_bandwidth ?? [];
  const wanThroughput = data?.wan_throughput;
  const maxTalkerBytes = topTalkers.length > 0 ? Math.max(...topTalkers.map(t => t.bytes)) : 1;
  const maxIfaceBytes = ifaceBandwidth.length > 0 ? Math.max(...ifaceBandwidth.map(i => i.rx_bytes + i.tx_bytes)) : 1;

  // WAN history from the dedicated rolling-window endpoint, mapped for the time-series chart
  const chartData = (wanHistory?.points ?? []).map(p => ({
    rx_mbps: p.rx_mbps,
    tx_mbps: p.tx_mbps,
    timeLabel: new Date(p.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Traffic</h2>
          <p className="text-sm text-muted-foreground">Top talkers, bandwidth by interface, and WAN throughput</p>
        </div>
        <div className="flex items-center gap-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} data-testid="button-refresh-traffic">
            <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {isError && !isLoading && (
        <ErrorCard message={(error as Error)?.message || 'Unknown error'} onRetry={refetch} />
      )}

      {isLoading ? (
        <SectionSkeleton rows={5} />
      ) : (
        <>
          {/* WAN Throughput summary + sparkline */}
          {(wanThroughput?.rx_bytes !== null || wanThroughput?.tx_bytes !== null) && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Card className="border-border/50" data-testid="card-wan-throughput">
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-2">
                    <Wifi className="h-3.5 w-3.5 text-blue-400" />
                    WAN Throughput
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      <span className="text-emerald-500">↓</span> Download
                    </span>
                    <span className="font-mono font-semibold" data-testid="text-wan-rx">{formatBytes(wanThroughput?.rx_bytes ?? null)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      <span className="text-blue-400">↑</span> Upload
                    </span>
                    <span className="font-mono font-semibold" data-testid="text-wan-tx">{formatBytes(wanThroughput?.tx_bytes ?? null)}</span>
                  </div>
                </CardContent>
              </Card>

              {/* WAN History time-series — throughput (MB/s) from consecutive-sample deltas */}
              <Card className="border-border/50 sm:col-span-2">
                <CardHeader className="pb-1">
                  <CardTitle className="text-xs text-muted-foreground uppercase tracking-wide">WAN Throughput History (last hour)</CardTitle>
                </CardHeader>
                <CardContent>
                  {chartData.length > 0 ? (
                    <>
                      <div className="h-32 w-full" data-testid="chart-wan-history">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={chartData} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" vertical={false} />
                            <XAxis dataKey="timeLabel" tick={{ fontSize: 9 }} minTickGap={32} />
                            <YAxis
                              tick={{ fontSize: 9 }}
                              tickFormatter={(v: number) => formatMbps(v)}
                              label={{ value: 'MB/s', angle: -90, position: 'insideLeft', style: { fontSize: 9, textAnchor: 'middle' }, dx: 12 }}
                            />
                            <Tooltip
                              formatter={(v: number, name) => [formatMbps(v), name === 'rx_mbps' ? 'RX (down)' : 'TX (up)']}
                              labelFormatter={(_l, payload) => payload?.[0]?.payload?.timeLabel ?? ''}
                              contentStyle={{ fontSize: '11px' }}
                            />
                            <Line type="monotone" dataKey="rx_mbps" stroke="#10b981" strokeWidth={1.5} dot={false} connectNulls name="rx_mbps" />
                            <Line type="monotone" dataKey="tx_mbps" stroke="#60a5fa" strokeWidth={1.5} dot={false} connectNulls name="tx_mbps" />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="flex gap-3 mt-1">
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm bg-emerald-500" /> RX (down)
                        </span>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm bg-blue-400" /> TX (up)
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-1 py-10 text-center" data-testid="wan-history-pending">
                      <Clock className="h-4 w-4 text-muted-foreground/50" />
                      <p className="text-xs text-muted-foreground">Collecting history — check back in a few minutes</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Top Bandwidth Consumers leaderboard */}
          <Card className="border-border/50" data-testid="card-top-talkers">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-orange-400" />
                Top Bandwidth Consumers
                {topTalkers.length > 0 && (
                  <Badge variant="secondary" className="text-xs ml-auto">{topTalkers.length} hosts</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {topTalkers.length === 0 ? (
                <div data-testid="top-talkers-pending">
                  <div className="flex flex-col items-center justify-center gap-1 py-6 text-center">
                    <Clock className="h-5 w-5 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No per-client data yet — device query pending</p>
                  </div>
                  <FortiViewSetupCallout sensor="top_talkers" />
                </div>
              ) : (
                <div className="space-y-0 divide-y divide-border/20">
                  {topTalkers.slice(0, 10).map((t, i) => {
                    const isEditing = !!editingMac && t.mac === editingMac;
                    return (
                    <div
                      key={t.ip}
                      role="button"
                      tabIndex={isEditing ? -1 : 0}
                      onClick={() => { if (!isEditing) setSelectedTalker(t); }}
                      onKeyDown={(e) => { if (!isEditing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelectedTalker(t); } }}
                      className={cn(
                        'w-full text-left py-2.5 space-y-1.5 rounded-md px-2 -mx-2 transition-colors group',
                        !isEditing && 'hover-elevate active-elevate-2 cursor-pointer',
                      )}
                      data-testid={`row-talker-${i}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-muted-foreground w-5 shrink-0 tabular-nums">#{i + 1}</span>
                        {isEditing ? (
                          <TalkerRename talker={t} onDone={() => setEditingMac(null)} />
                        ) : (
                          <>
                            <div className="flex-1 min-w-0">
                              {t.hostname ? (
                                <>
                                  <div className="text-sm font-medium truncate" data-testid={`text-talker-name-${i}`}>{t.hostname}</div>
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <div className="text-xs font-mono text-muted-foreground truncate" data-testid={`text-talker-ip-${i}`}>{t.ip}</div>
                                    {t.category && (
                                      <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0 font-normal" data-testid={`badge-talker-category-${i}`}>
                                        {t.category}
                                      </Badge>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <div className="font-mono text-sm truncate" data-testid={`text-talker-ip-${i}`}>{t.ip}</div>
                                  {t.category && (
                                    <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0 font-normal" data-testid={`badge-talker-category-${i}`}>
                                      {t.category}
                                    </Badge>
                                  )}
                                </div>
                              )}
                            </div>
                            {t.mac && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                                onClick={(e) => { e.stopPropagation(); setEditingMac(t.mac ?? null); }}
                                title="Rename or re-categorize device"
                                data-testid={`button-rename-talker-${i}`}
                              >
                                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                            )}
                            <span className="text-sm font-semibold font-mono tabular-nums shrink-0">{formatBytes(t.bytes)}</span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0" />
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="w-5 shrink-0" />
                        <div className="flex-1 relative">
                          <div className="w-full bg-muted rounded-full h-1.5">
                            <div
                              className="h-1.5 rounded-full bg-orange-400/80 transition-all"
                              style={{ width: `${(t.bytes / maxTalkerBytes) * 100}%` }}
                            />
                          </div>
                        </div>
                        <div className="flex gap-3 text-xs text-muted-foreground shrink-0">
                          <span><span className="text-emerald-500">↓</span> {formatBytes(t.rx_bytes)}</span>
                          <span><span className="text-blue-400">↑</span> {formatBytes(t.tx_bytes)}</span>
                        </div>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Interface Bandwidth */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Network className="h-4 w-4 text-blue-400" />
                Bandwidth by Interface
              </CardTitle>
            </CardHeader>
            <CardContent>
              {ifaceBandwidth.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No interface data available</p>
              ) : (
                <div className="space-y-3">
                  {ifaceBandwidth.slice(0, 12).filter(i => (i.rx_bytes + i.tx_bytes) > 0).map((iface, i) => {
                    const total = iface.rx_bytes + iface.tx_bytes;
                    return (
                      <div key={iface.name} className="space-y-1" data-testid={`row-iface-bandwidth-${i}`}>
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-1.5">
                            <span className={cn('h-1.5 w-1.5 rounded-full', iface.link ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                            <span className="font-mono text-xs">{iface.name}</span>
                          </div>
                          <span className="text-xs text-muted-foreground">{formatBytes(total)}</span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-1.5">
                          <div
                            className="h-1.5 rounded-full bg-blue-500 transition-all"
                            style={{ width: `${(total / maxIfaceBytes) * 100}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <TalkerDetailSheet talker={selectedTalker} onClose={() => setSelectedTalker(null)} onNavigate={onNavigate} />
    </div>
  );
}

function findMatchingDevice(talker: TrafficTalker | null, devices: ConnectedDevice[]): ConnectedDevice | null {
  if (!talker) return null;
  const talkerMac = talker.mac?.toLowerCase();
  if (talkerMac) {
    const byMac = devices.find(d => d.mac?.toLowerCase() === talkerMac);
    if (byMac) return byMac;
  }
  if (talker.ip) {
    const byIp = devices.find(d => d.ip === talker.ip);
    if (byIp) return byIp;
  }
  return null;
}

function TalkerDetailSheet({ talker, onClose, onNavigate }: { talker: TrafficTalker | null; onClose: () => void; onNavigate?: (tab: NetworkTab) => void }) {
  const open = talker !== null;
  const [, setSearchParams] = useSearchParams();
  const [editingIdentity, setEditingIdentity] = useState(false);
  const queryClient = useQueryClient();

  // Close any open edit popover whenever the selected talker changes / sheet closes
  useEffect(() => {
    setEditingIdentity(false);
  }, [talker]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<DeviceTrafficResponse>({
    queryKey: ['/api/fortigate/devices', talker?.ip, 'traffic'],
    queryFn: () => apiClient.get<DeviceTrafficResponse>(
      `/api/fortigate/devices/${encodeURIComponent(talker!.ip)}/traffic?srcip=${encodeURIComponent(talker!.ip)}`,
    ),
    enabled: open,
    staleTime: 30_000,
    retry: 1,
  });

  // Shares cache with DevicesTab's device list so we can match this talker to its
  // full device profile entry by MAC (preferred) or IP.
  const { data: devicesData } = useQuery<DevicesResponse>({
    queryKey: ['/api/fortigate/devices', 'category'],
    queryFn: () => apiClient.get<DevicesResponse>('/api/fortigate/devices?groupBy=category'),
    enabled: open,
    staleTime: 30_000,
    retry: 1,
  });

  const matchedDevice = findMatchingDevice(talker, devicesData?.devices ?? []);
  const canOpenDevice = onNavigate != null && !!matchedDevice?.mac;

  function handleOpenDevice() {
    if (!matchedDevice?.mac) return;
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('device', matchedDevice.mac!);
      return next;
    });
    onClose();
    onNavigate?.('devices');
  }

  const destinations = data?.destinations ?? [];
  const trafficLog = useMemo(() => data?.traffic_log ?? [], [data]);
  const maxDestBytes = destinations.length > 0 ? Math.max(...destinations.map(d => d.bytes), 1) : 1;

  // Bucket the device's traffic_log into a rx/tx throughput (bytes/sec) mini
  // time-series over the last hour. Byte totals per bucket are normalized by
  // the bucket's actual duration so spikes are comparable across slices.
  const timeSeries = useMemo(() => {
    const BUCKETS = 24;
    const WINDOW_MS = 60 * 60 * 1000;
    const points = trafficLog
      .map(e => ({ t: e.timestamp ? new Date(e.timestamp).getTime() : NaN, rx: e.rx_bytes || 0, tx: e.tx_bytes || 0 }))
      .filter(p => Number.isFinite(p.t));
    if (points.length < 2) return null;
    const maxT = Math.max(...points.map(p => p.t));
    const minT = Math.min(...points.map(p => p.t));
    const start = Math.max(minT, maxT - WINDOW_MS);
    const span = Math.max(maxT - start, 1);
    const totals = Array.from({ length: BUCKETS }, () => ({ rx: 0, tx: 0 }));
    for (const p of points) {
      if (p.t < start) continue;
      let idx = Math.floor(((p.t - start) / span) * BUCKETS);
      if (idx >= BUCKETS) idx = BUCKETS - 1;
      if (idx < 0) idx = 0;
      totals[idx].rx += p.rx;
      totals[idx].tx += p.tx;
    }
    // Each bucket covers span/BUCKETS ms — divide byte totals by that duration
    // (in seconds) to get a true rate.
    const bucketMs = span / BUCKETS;
    const bucketSecs = Math.max(bucketMs / 1000, 0.001);
    const fmtTime = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const buckets = totals.map((b, i) => {
      const bucketStart = start + i * bucketMs;
      const bucketEnd = i === BUCKETS - 1 ? maxT : bucketStart + bucketMs;
      return {
        rx: b.rx / bucketSecs,
        tx: b.tx / bucketSecs,
        rangeLabel: `${fmtTime(bucketStart)} – ${fmtTime(bucketEnd)}`,
      };
    });
    return { buckets, start, end: maxT };
  }, [trafficLog]);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto" data-testid="sheet-talker-detail">
        <SheetHeader>
          <SheetTitle className="truncate" data-testid="text-detail-name">
            {data?.hostname || talker?.hostname || talker?.ip || 'Device'}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs" data-testid="text-detail-ip">
            {talker?.ip}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-6">
          {/* Jump to the full device profile in the Devices tab (matched by MAC/IP) */}
          {canOpenDevice && (
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-between"
              onClick={handleOpenDevice}
              data-testid="button-open-device-profile"
            >
              <span className="flex items-center gap-1.5 min-w-0">
                <Network className="h-4 w-4 shrink-0 text-blue-400" />
                <span className="truncate">
                  View full device profile
                  {matchedDevice?.hostname ? ` · ${matchedDevice.hostname}` : ''}
                </span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </Button>
          )}

          {/* Compact device identity — surfaced inline when this talker matches a known device */}
          {matchedDevice && (
            <div className="relative rounded-md border border-border/50 p-3 space-y-2" data-testid="talker-identity-block">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Device Identity</div>
                {matchedDevice.mac && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 -my-1 -mr-1 shrink-0"
                    onClick={() => setEditingIdentity(o => !o)}
                    title="Edit name, owner, or category"
                    data-testid="button-edit-talker-identity"
                  >
                    <Pencil className="h-3 w-3 text-muted-foreground" />
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
                {(matchedDevice.hardware_vendor || matchedDevice.vendor) && (
                  <span className="font-medium" data-testid="text-identity-vendor">
                    {matchedDevice.hardware_vendor || matchedDevice.vendor}
                  </span>
                )}
                {matchedDevice.category && (
                  <Badge variant="secondary" className="text-xs" data-testid="badge-identity-category">
                    {matchedDevice.category}
                  </Badge>
                )}
                {matchedDevice.connection && (
                  <span data-testid="badge-identity-connection">
                    <ConnectionBadge conn={matchedDevice.connection} size="compact" />
                  </span>
                )}
              </div>
              {matchedDevice.owner && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-identity-owner">
                  <span className="uppercase tracking-wide text-[10px]">Owner</span>
                  <span className="text-foreground">{matchedDevice.owner}</span>
                </div>
              )}
              {editingIdentity && matchedDevice.mac && (
                <DeviceEditPopover
                  device={matchedDevice}
                  onClose={() => setEditingIdentity(false)}
                  onSaved={() => {
                    setEditingIdentity(false);
                    // DeviceEditPopover already invalidates the devices queries;
                    // also refresh the traffic views so the new name shows up here.
                    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/traffic'] });
                  }}
                />
              )}
            </div>
          )}

          {/* Totals summary */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-border/50 p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
              <div className="text-sm font-semibold font-mono tabular-nums" data-testid="text-detail-total">
                {formatBytes(data?.total_bytes ?? talker?.bytes ?? null)}
              </div>
            </div>
            <div className="rounded-md border border-border/50 p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <span className="text-emerald-500">↓</span> Down
              </div>
              <div className="text-sm font-semibold font-mono tabular-nums" data-testid="text-detail-rx">
                {formatBytes(data?.total_rx_bytes ?? talker?.rx_bytes ?? null)}
              </div>
            </div>
            <div className="rounded-md border border-border/50 p-2.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <span className="text-blue-400">↑</span> Up
              </div>
              <div className="text-sm font-semibold font-mono tabular-nums" data-testid="text-detail-tx">
                {formatBytes(data?.total_tx_bytes ?? talker?.tx_bytes ?? null)}
              </div>
            </div>
          </div>

          {isError && !isLoading ? (
            <ErrorCard message={(error as Error)?.message || 'Unknown error'} onRetry={refetch} />
          ) : isLoading ? (
            <SectionSkeleton rows={6} />
          ) : (
            <>
              {/* rx/tx time-series over the last hour, from traffic_log timestamps */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="h-4 w-4 text-emerald-500" />
                  <h3 className="text-sm font-medium">Throughput Over Last Hour</h3>
                </div>
                {timeSeries ? (
                  <div data-testid="chart-device-timeseries">
                    <div className="h-16 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={timeSeries.buckets} margin={{ top: 0, right: 0, left: 0, bottom: 0 }} barCategoryGap={1}>
                          <XAxis dataKey="rangeLabel" hide />
                          <YAxis hide />
                          <Tooltip
                            formatter={(v: number, name) => [formatRate(v), name === 'rx' ? 'RX (down)' : 'TX (up)']}
                            labelFormatter={(_l, payload) => payload?.[0]?.payload?.rangeLabel ?? ''}
                            contentStyle={{ fontSize: '11px' }}
                            cursor={{ fill: 'rgba(148, 163, 184, 0.15)' }}
                          />
                          <Bar dataKey="rx" stackId="traffic" fill="#10b981" fillOpacity={0.5} name="rx" isAnimationActive={false} />
                          <Bar dataKey="tx" stackId="traffic" fill="#60a5fa" fillOpacity={0.5} radius={[2, 2, 0, 0]} name="tx" isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-muted-foreground tabular-nums">{formatTimestamp(new Date(timeSeries.start).toISOString())}</span>
                      <div className="flex gap-3">
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm bg-emerald-500/50" /> RX
                        </span>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                          <span className="h-2 w-2 rounded-sm bg-blue-400/50" /> TX
                        </span>
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums">{formatTimestamp(new Date(timeSeries.end).toISOString())}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-3 text-center" data-testid="detail-timeseries-empty">
                    Not enough timestamped traffic to chart yet.
                  </p>
                )}
              </div>

              {/* Top destinations */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Globe className="h-4 w-4 text-orange-400" />
                  <h3 className="text-sm font-medium">Top Destinations</h3>
                  {destinations.length > 0 && (
                    <Badge variant="secondary" className="text-xs ml-auto">{destinations.length}</Badge>
                  )}
                </div>
                {destinations.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-3 text-center" data-testid="detail-destinations-empty">
                    No destination data available for this device.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {destinations.slice(0, 15).map((d, i) => (
                      <div key={`${d.domain}-${i}`} className="space-y-1" data-testid={`row-destination-${i}`}>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="text-sm truncate" data-testid={`text-destination-domain-${i}`}>{d.domain}</div>
                            {d.category && (
                              <div className="text-[10px] text-muted-foreground truncate">{d.category}</div>
                            )}
                          </div>
                          <span className="text-xs font-mono tabular-nums shrink-0">{formatBytes(d.bytes)}</span>
                        </div>
                        <div className="w-full bg-muted rounded-full h-1.5">
                          <div
                            className="h-1.5 rounded-full bg-orange-400/80 transition-all"
                            style={{ width: `${(d.bytes / maxDestBytes) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Recent traffic log */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Clock className="h-4 w-4 text-blue-400" />
                  <h3 className="text-sm font-medium">Recent Traffic Log</h3>
                  {trafficLog.length > 0 && (
                    <Badge variant="secondary" className="text-xs ml-auto">{trafficLog.length}</Badge>
                  )}
                </div>
                {trafficLog.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-3 text-center" data-testid="detail-log-empty">
                    No recent traffic log entries.
                  </p>
                ) : (
                  <div className="space-y-0 divide-y divide-border/20">
                    {trafficLog.slice(0, 30).map((entry, i) => (
                      <div key={i} className="py-2 flex items-center gap-3" data-testid={`row-traffic-log-${i}`}>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-mono truncate">{entry.dst || '—'}</div>
                          <div className="text-[10px] text-muted-foreground">{formatTimestamp(entry.timestamp)}</div>
                        </div>
                        <div className="flex gap-2.5 text-xs text-muted-foreground shrink-0 tabular-nums">
                          <span><span className="text-emerald-500">↓</span> {formatBytes(entry.rx_bytes)}</span>
                          <span><span className="text-blue-400">↑</span> {formatBytes(entry.tx_bytes)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-detail">
                  <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
                  Refresh
                </Button>
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const AUTO_CATEGORY = '__auto__';
