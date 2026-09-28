import { useState, useEffect, useCallback } from 'react';
import { Satellite, Wifi, ArrowDown, ArrowUp, Activity, Loader2, Gauge } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/apiClient';
import { cn } from '@/lib/utils';

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

interface SdwanMember {
  seq: number;
  interface: string;
  label: string;
  status: 'alive' | 'dead' | 'unknown';
  latency_ms: number | null;
  jitter_ms: number | null;
  packet_loss_pct: number | null;
  sla_met: boolean;
  gateway: string | null;
}

interface SdwanHealth {
  zone: string;
  health_check_name?: string | null;
  mode: string;
  members: SdwanMember[];
  sla_latency_threshold_ms: number;
  sla_packet_loss_threshold_pct: number;
}

function latencyColor(ms: number | null): string {
  if (ms === null) return 'text-muted-foreground';
  if (ms <= 100) return 'text-emerald-400';
  if (ms <= 250) return 'text-yellow-400';
  return 'text-red-400';
}

function lossColor(pct: number | null): string {
  if (pct === null) return 'text-muted-foreground';
  if (pct <= 1) return 'text-emerald-400';
  if (pct <= 5) return 'text-yellow-400';
  return 'text-red-400';
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 mt-1">
      {children}
    </p>
  );
}

/**
 * Starlink internet — wired to FortiGate SD-WAN WAN2. Surfaces the live
 * WAN2 health-check (latency / jitter / packet loss + SLA state) and the
 * WAN2 byte counters under the load-balanced dual-WAN setup.
 */
export function StarlinkCard() {
  const [wanStats, setWanStats] = useState<WanStats | null>(null);
  const [sdwan, setSdwan] = useState<SdwanHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [wan, health] = await Promise.allSettled([
        apiClient.get<WanStats>('/api/fortigate/wan-stats'),
        apiClient.get<SdwanHealth>('/api/fortigate/sdwan-health'),
      ]);
      setWanStats(wan.status === 'fulfilled' ? wan.value : null);
      setSdwan(health.status === 'fulfilled' ? health.value : null);
    } catch {
      setWanStats(null);
      setSdwan(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(() => fetchData(true), 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const wan2 = wanStats?.wan2 ?? null;
  const member = sdwan?.members.find(m => m.interface.toLowerCase() === 'wan2') ?? null;

  const hasData = wan2 !== null || member !== null;

  const isUp = member ? member.status === 'alive' : wan2?.link === true;
  const isDown = member ? member.status === 'dead' : wan2?.link === false;

  const overallStatus = loading
    ? ('idle' as const)
    : isUp
      ? ('online' as const)
      : isDown
        ? ('offline' as const)
        : ('idle' as const);

  const statusText = loading
    ? 'Loading...'
    : !hasData
      ? 'No Data'
      : isUp
        ? (member?.sla_met === false ? 'Degraded' : 'Online')
        : isDown
          ? 'Offline'
          : 'Unknown';

  const latency = member?.latency_ms ?? null;
  const loss = member?.packet_loss_pct ?? null;
  const jitter = member?.jitter_ms ?? null;
  const wanRx = wan2?.rx_gb ?? null;
  const wanTx = wan2?.tx_gb ?? null;

  return (
    <SystemCard
      title="Starlink Internet"
      icon={<Satellite className="h-6 w-6 text-sky-400" />}
      status={overallStatus}
      statusText={statusText}
      accentColor="bg-sky-500/10"
      metrics={[
        { label: 'Latency', value: latency !== null ? `${latency.toFixed(0)} ms` : '—' },
        { label: 'Loss', value: loss !== null ? `${loss.toFixed(1)}%` : '—' },
        { label: 'Link', value: isUp ? 'Up' : isDown ? 'Down' : '—' },
        { label: 'WAN', value: 'WAN2' },
      ]}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !hasData ? (
        <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
          <div className="rounded-full bg-sky-500/10 p-3">
            <Satellite className="h-6 w-6 text-sky-400" />
          </div>
          <div>
            <p className="text-sm font-semibold" data-testid="text-starlink-empty">No WAN2 Data</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Starlink (WAN2) data will appear here once the FortiGate SD-WAN health check reports it.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <SectionLabel>FortiGate WAN2 (Starlink) — Live</SectionLabel>
              {member && (
                <Badge
                  variant="outline"
                  className={cn(
                    'text-[10px] py-0',
                    member.sla_met ? 'border-emerald-500/40 text-emerald-400' : 'border-red-500/40 text-red-400'
                  )}
                  data-testid="badge-starlink-sla"
                >
                  {member.sla_met ? 'Meeting SLA' : 'Out of SLA'}
                </Badge>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="bg-muted/30 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="h-3.5 w-3.5 text-sky-400" />
                  <span className="text-[10px] text-muted-foreground uppercase">Status</span>
                </div>
                <p className={cn('text-lg font-bold', isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-muted-foreground')} data-testid="text-starlink-status">
                  {isUp ? 'Up' : isDown ? 'Down' : 'Unknown'}
                </p>
              </div>
              <div className="bg-muted/30 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Gauge className="h-3.5 w-3.5 text-sky-400" />
                  <span className="text-[10px] text-muted-foreground uppercase">Latency</span>
                </div>
                <p className={cn('text-lg font-bold font-mono', latencyColor(latency))} data-testid="text-starlink-latency">
                  {latency !== null ? `${latency.toFixed(0)} ms` : '—'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mt-3 text-xs">
              <div>
                <span className="text-muted-foreground">Jitter</span>
                <p className="font-mono font-semibold text-sm" data-testid="text-starlink-jitter">
                  {jitter !== null ? `${jitter.toFixed(0)} ms` : '—'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Packet Loss</span>
                <p className={cn('font-mono font-semibold text-sm', lossColor(loss))} data-testid="text-starlink-loss">
                  {loss !== null ? `${loss.toFixed(1)}%` : '—'}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Gateway</span>
                <p className="font-mono font-semibold text-xs truncate" data-testid="text-starlink-gateway">
                  {member?.gateway ?? '—'}
                </p>
              </div>
            </div>
          </div>

          {wan2 && (
            <>
              <div className="border-t border-border" />
              <div>
                <SectionLabel>WAN2 Throughput</SectionLabel>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2">
                    <ArrowDown className="h-4 w-4 text-emerald-400" />
                    <div>
                      <p className="font-mono font-semibold text-sm" data-testid="text-starlink-rx">
                        {wanRx !== null ? `${wanRx.toFixed(2)} GB` : '—'}
                      </p>
                      <p className="text-[10px] text-muted-foreground">RX (received)</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowUp className="h-4 w-4 text-blue-400" />
                    <div>
                      <p className="font-mono font-semibold text-sm" data-testid="text-starlink-tx">
                        {wanTx !== null ? `${wanTx.toFixed(2)} GB` : '—'}
                      </p>
                      <p className="text-[10px] text-muted-foreground">TX (sent)</p>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground pt-1">
            <Wifi className="h-3 w-3" />
            SD-WAN secondary link · load-balanced with Spectrum (WAN1)
          </div>
        </div>
      )}
    </SystemCard>
  );
}
