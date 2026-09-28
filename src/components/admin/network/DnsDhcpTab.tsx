import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  RefreshCw, AlertTriangle, Lock, CheckCircle, Globe, Database, Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DnsDhcpResponse } from './types';
import {
  LastUpdated, SectionSkeleton, ErrorCard,
} from './shared';
import { formatTimestamp } from './shared-utils';

export function DnsDhcpTab() {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [dhcpSearch, setDhcpSearch] = useState('');
  const [blockedSearch, setBlockedSearch] = useState('');
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<DnsDhcpResponse>({
    queryKey: ['/api/fortigate/dns-dhcp'],
    queryFn: () => apiClient.get<DnsDhcpResponse>('/api/fortigate/dns-dhcp'),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (!isLoading && !isFetching) setLastUpdated(new Date());
  }, [isLoading, isFetching, data]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/dns-dhcp'] });
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 60_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  const topDomains = data?.top_domains ?? [];
  const blockedDomains = data?.blocked_domains ?? [];
  const dhcpLeases = data?.dhcp_leases ?? [];

  const filteredBlocked = blockedDomains.filter(b => {
    const q = blockedSearch.toLowerCase();
    return b.domain.toLowerCase().includes(q) || (b.category?.toLowerCase().includes(q) ?? false);
  });

  const filteredDhcp = dhcpLeases.filter(l => {
    const q = dhcpSearch.toLowerCase();
    return (
      (l.hostname?.toLowerCase().includes(q) ?? false) ||
      (l.ip?.toLowerCase().includes(q) ?? false) ||
      (l.mac?.toLowerCase().includes(q) ?? false) ||
      (l.interface?.toLowerCase().includes(q) ?? false)
    );
  });

  const maxCount = topDomains[0]?.count ?? 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">DNS & DHCP Insights</h2>
          <p className="text-sm text-muted-foreground">DNS query activity, blocked domains, and active DHCP leases</p>
        </div>
        <div className="flex items-center gap-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} data-testid="button-refresh-dns-dhcp">
            <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {isError && !isLoading && (
        <ErrorCard message={(error as Error)?.message || 'Unable to load DNS & DHCP data.'} onRetry={refetch} />
      )}

      {isLoading ? (
        <SectionSkeleton rows={6} />
      ) : (
        <div className="space-y-6">
          {/* Availability notice when specific logs not supported */}
          {data && !data.dns_available && !data.webfilter_available && (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="flex items-start gap-3 pt-5 pb-5">
                <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
                  DNS and web filter logs are not available on this FortiGate. DNS logging or disk logging may not be enabled in the FortiGate configuration.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Top queried domains */}
          {topDomains.length > 0 && (
            <Card className="border-border/50" data-testid="card-top-domains">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Globe className="h-4 w-4 text-blue-400" />
                  Top Queried Domains
                  <Badge variant="secondary" className="ml-auto text-xs">{topDomains.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-2">
                  {topDomains.map((d, i) => (
                    <div key={d.domain} className="flex items-center gap-3" data-testid={`row-top-domain-${i}`}>
                      <span className="text-xs text-muted-foreground w-5 text-right shrink-0">{i + 1}</span>
                      <span className="font-mono text-sm flex-1 truncate" data-testid={`text-top-domain-${i}`}>{d.domain}</span>
                      <div className="flex-1 max-w-[120px]">
                        <div className="w-full bg-muted rounded-full h-1.5">
                          <div
                            className="h-1.5 rounded-full bg-blue-500"
                            style={{ width: `${Math.round((d.count / maxCount) * 100)}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-xs font-mono text-muted-foreground w-10 text-right shrink-0" data-testid={`text-top-domain-count-${i}`}>
                        {d.count}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Blocked domains */}
          <Card className="border-border/50" data-testid="card-blocked-domains">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Lock className="h-4 w-4 text-rose-400" />
                  Blocked Domains
                  {blockedDomains.length > 0 && (
                    <Badge variant="destructive" className="text-xs">{blockedDomains.reduce((s, b) => s + b.count, 0)}</Badge>
                  )}
                </CardTitle>
                {blockedDomains.length > 0 && (
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                    <Input
                      className="h-8 pl-8 text-sm w-48"
                      placeholder="Filter..."
                      value={blockedSearch}
                      onChange={e => setBlockedSearch(e.target.value)}
                      data-testid="input-blocked-search"
                    />
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {filteredBlocked.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  {data?.webfilter_available ? (
                    <>
                      <CheckCircle className="h-8 w-8 text-emerald-500/40 mb-2" />
                      <p className="text-sm text-muted-foreground">No blocked domains in recent logs</p>
                    </>
                  ) : (
                    <>
                      <Lock className="h-8 w-8 text-muted-foreground/30 mb-2" />
                      <p className="text-sm text-muted-foreground">Web filter log not available</p>
                    </>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-blocked-domains">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2.5 text-left">Domain</th>
                        <th className="px-4 py-2.5 text-left">Category</th>
                        <th className="px-4 py-2.5 text-right">Count</th>
                        <th className="px-4 py-2.5 text-left">Last Blocked</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {filteredBlocked.map((b, i) => (
                        <tr key={b.domain} className="hover:bg-muted/20 transition-colors" data-testid={`row-blocked-${i}`}>
                          <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-blocked-domain-${i}`}>{b.domain}</td>
                          <td className="px-4 py-2.5">
                            {b.category ? (
                              <Badge variant="outline" className="text-xs" data-testid={`badge-blocked-cat-${i}`}>{b.category}</Badge>
                            ) : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <Badge variant="secondary" className="text-xs font-mono" data-testid={`badge-blocked-count-${i}`}>{b.count}</Badge>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground" data-testid={`text-blocked-latest-${i}`}>
                            {formatTimestamp(b.latest)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* DHCP leases */}
          <Card className="border-border/50" data-testid="card-dhcp-leases">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Database className="h-4 w-4 text-teal-400" />
                  DHCP Leases
                  {dhcpLeases.length > 0 && (
                    <Badge variant="secondary" className="text-xs">{dhcpLeases.length}</Badge>
                  )}
                </CardTitle>
                {dhcpLeases.length > 0 && (
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                    <Input
                      className="h-8 pl-8 text-sm w-48"
                      placeholder="Filter..."
                      value={dhcpSearch}
                      onChange={e => setDhcpSearch(e.target.value)}
                      data-testid="input-dhcp-search"
                    />
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              {filteredDhcp.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  {data?.dhcp_available ? (
                    <>
                      <CheckCircle className="h-8 w-8 text-emerald-500/40 mb-2" />
                      <p className="text-sm text-muted-foreground">No active DHCP leases found</p>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-8 w-8 text-muted-foreground/30 mb-2" />
                      <p className="text-sm text-muted-foreground">DHCP monitor not available on this FortiGate</p>
                    </>
                  )}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-dhcp-leases">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2.5 text-left">Hostname</th>
                        <th className="px-4 py-2.5 text-left">IP Address</th>
                        <th className="px-4 py-2.5 text-left">MAC</th>
                        <th className="px-4 py-2.5 text-left">Interface</th>
                        <th className="px-4 py-2.5 text-left">Lease Expiry</th>
                        <th className="px-4 py-2.5 text-left">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/30">
                      {filteredDhcp.map((l, i) => (
                        <tr key={`${l.mac}-${l.ip}-${i}`} className="hover:bg-muted/20 transition-colors" data-testid={`row-dhcp-${i}`}>
                          <td className="px-4 py-2.5 font-medium" data-testid={`text-dhcp-hostname-${i}`}>
                            {l.hostname || <span className="text-muted-foreground italic text-xs">Unknown</span>}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-dhcp-ip-${i}`}>{l.ip ?? '—'}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground" data-testid={`text-dhcp-mac-${i}`}>{l.mac ?? '—'}</td>
                          <td className="px-4 py-2.5" data-testid={`text-dhcp-iface-${i}`}>
                            {l.interface ? (
                              <Badge variant="outline" className="text-xs">{l.interface}</Badge>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground" data-testid={`text-dhcp-expiry-${i}`}>
                            {formatTimestamp(l.lease_end)}
                          </td>
                          <td className="px-4 py-2.5" data-testid={`text-dhcp-status-${i}`}>
                            <Badge
                              variant={l.status === 'active' || !l.status ? 'default' : 'secondary'}
                              className="text-xs capitalize"
                            >
                              {l.status || 'active'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
