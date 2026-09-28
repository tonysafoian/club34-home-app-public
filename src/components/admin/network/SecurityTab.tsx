import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  RefreshCw, AlertTriangle, Lock, CheckCircle,
  ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ThreatsResponse, VpnResponse } from './types';
import {
  LastUpdated, SectionSkeleton,
} from './shared';
import { formatTimestamp, formatDuration, severityBadgeVariant } from './shared-utils';

export function SecurityTab() {
  const [threatSort, setThreatSort] = useState<'severity' | 'timestamp' | 'attack'>('severity');
  const [threatAsc, setThreatAsc] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const queryClient = useQueryClient();

  const { data: threatsData, isLoading: threatsLoading, isError: threatsError, refetch: refetchThreats, isFetching: threatsFetching } = useQuery<ThreatsResponse>({
    queryKey: ['/api/fortigate/threats'],
    queryFn: () => apiClient.get<ThreatsResponse>('/api/fortigate/threats'),
    staleTime: 30_000,
    retry: 1,
  });

  const { data: vpnData, isLoading: vpnLoading, isError: vpnError } = useQuery<VpnResponse>({
    queryKey: ['/api/fortigate/vpn'],
    queryFn: () => apiClient.get<VpnResponse>('/api/fortigate/vpn'),
    staleTime: 30_000,
    retry: 1,
  });

  const isLoading = threatsLoading || vpnLoading;

  useEffect(() => {
    if (!isLoading) setLastUpdated(new Date());
  }, [isLoading, threatsData, vpnData]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/threats'] });
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/vpn'] });
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 30_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  const threats = threatsData?.threats ?? [];
  const vpn = vpnData;

  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, warning: 3, low: 4, info: 5 };

  const sortedThreats = [...threats].sort((a, b) => {
    if (threatSort === 'severity') {
      const ao = severityOrder[a.severity.toLowerCase()] ?? 99;
      const bo = severityOrder[b.severity.toLowerCase()] ?? 99;
      return threatAsc ? bo - ao : ao - bo;
    }
    if (threatSort === 'attack') {
      return threatAsc
        ? a.attack.localeCompare(b.attack)
        : b.attack.localeCompare(a.attack);
    }
    const at = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const bt = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return threatAsc ? at - bt : bt - at;
  });

  function handleThreatSort(key: typeof threatSort) {
    if (key === threatSort) setThreatAsc(!threatAsc);
    else { setThreatSort(key); setThreatAsc(false); }
  }

  function ThreatSortIcon({ col }: { col: typeof threatSort }) {
    if (threatSort !== col) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return threatAsc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Security</h2>
          <p className="text-sm text-muted-foreground">Threats, IPS events, and VPN sessions</p>
        </div>
        <div className="flex items-center gap-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={threatsFetching} data-testid="button-refresh-security">
            <RefreshCw className={cn('h-4 w-4 mr-1.5', threatsFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Threats */}
      <div>
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400" />
          Threat Events
          {threats.length > 0 && (
            <Badge variant="destructive" className="text-xs">{threats.length}</Badge>
          )}
        </h3>

        {threatsLoading ? (
          <SectionSkeleton rows={4} />
        ) : threatsError ? (
          <Card className="border-border/50">
            <CardContent className="py-4 text-sm text-muted-foreground">Threat log unavailable from this FortiGate.</CardContent>
          </Card>
        ) : threats.length === 0 ? (
          <Card className="border-border/50">
            <CardContent className="flex items-center gap-2 py-6 text-emerald-500">
              <CheckCircle className="h-5 w-5" />
              <span className="text-sm">No recent threats detected</span>
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-md border border-border/50 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-threats">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left cursor-pointer hover:text-foreground" onClick={() => handleThreatSort('severity')}>
                      <div className="flex items-center gap-1">Severity <ThreatSortIcon col="severity" /></div>
                    </th>
                    <th className="px-4 py-2.5 text-left cursor-pointer hover:text-foreground" onClick={() => handleThreatSort('attack')}>
                      <div className="flex items-center gap-1">Attack <ThreatSortIcon col="attack" /></div>
                    </th>
                    <th className="px-4 py-2.5 text-left">Source</th>
                    <th className="px-4 py-2.5 text-left">Destination</th>
                    <th className="px-4 py-2.5 text-left">Action</th>
                    <th className="px-4 py-2.5 text-left cursor-pointer hover:text-foreground" onClick={() => handleThreatSort('timestamp')}>
                      <div className="flex items-center gap-1">Time <ThreatSortIcon col="timestamp" /></div>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {sortedThreats.map((threat, i) => (
                    <tr key={i} className="hover:bg-muted/20 transition-colors" data-testid={`row-threat-${i}`}>
                      <td className="px-4 py-2.5">
                        <Badge variant={severityBadgeVariant(threat.severity)} className="text-xs capitalize">
                          {threat.severity}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 max-w-xs" data-testid={`text-threat-attack-${i}`}>
                        <span className="font-medium block truncate">{threat.attack}</span>
                        {(threat.protocol || threat.service) && (
                          <span className="text-[10px] text-muted-foreground">
                            {[threat.protocol, threat.service].filter(Boolean).join(' · ')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground" data-testid={`text-threat-src-${i}`}>
                        <span className="block">{threat.src_ip ?? '—'}</span>
                        {threat.src_country && (
                          <span className="text-[10px] text-muted-foreground/70" data-testid={`text-threat-srccountry-${i}`}>{threat.src_country}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground" data-testid={`text-threat-dst-${i}`}>
                        <span className="block">{threat.dst_ip ?? '—'}</span>
                        {threat.dst_country && (
                          <span className="text-[10px] text-muted-foreground/70" data-testid={`text-threat-dstcountry-${i}`}>{threat.dst_country}</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs">
                        {threat.action && (
                          <Badge variant="outline" className="text-xs capitalize">{threat.action}</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(threat.timestamp)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* VPN Sessions */}
      <div>
        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
          <Lock className="h-4 w-4 text-blue-400" />
          VPN Sessions
          {vpn && vpn.total > 0 && (
            <Badge variant="secondary" className="text-xs">{vpn.total}</Badge>
          )}
        </h3>

        {vpnLoading ? (
          <SectionSkeleton rows={3} />
        ) : vpnError ? (
          <Card className="border-border/50">
            <CardContent className="py-4 text-sm text-muted-foreground">VPN data unavailable.</CardContent>
          </Card>
        ) : !vpn || vpn.total === 0 ? (
          <Card className="border-border/50">
            <CardContent className="flex items-center gap-2 py-6 text-muted-foreground">
              <Lock className="h-5 w-5" />
              <span className="text-sm">No active VPN sessions</span>
            </CardContent>
          </Card>
        ) : (
          <div className="rounded-md border border-border/50 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-vpn">
                <thead className="bg-muted/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Type</th>
                    <th className="px-4 py-2.5 text-left">User / Tunnel</th>
                    <th className="px-4 py-2.5 text-left">Remote IP</th>
                    <th className="px-4 py-2.5 text-left">VPN IP</th>
                    <th className="px-4 py-2.5 text-left">Duration</th>
                    <th className="px-4 py-2.5 text-left">Connected</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {vpn.sessions.map((session, i) => (
                    <tr key={i} className="hover:bg-muted/20 transition-colors" data-testid={`row-vpn-${i}`}>
                      <td className="px-4 py-2.5">
                        <Badge variant="secondary" className="text-xs uppercase">{session.type}</Badge>
                      </td>
                      <td className="px-4 py-2.5 font-medium" data-testid={`text-vpn-user-${i}`}>{session.user}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{session.src_ip ?? '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{session.vpn_ip ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs font-mono" data-testid={`text-vpn-duration-${i}`}>
                        {session.duration_seconds !== null ? formatDuration(session.duration_seconds) : (session.status ?? '—')}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                        {formatTimestamp(session.connected_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
