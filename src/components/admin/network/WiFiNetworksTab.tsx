import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  RefreshCw, Wifi, Users, ChevronDown, ChevronUp, ArrowUpDown, ArrowUp, ArrowDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  LastUpdated, SectionSkeleton, ErrorCard,
} from './shared';
import { formatBytes, formatRelativeTime, isRecentlyActive } from './shared-utils';

export interface WifiDevice {
  hostname: string | null;
  ip: string | null;
  mac: string | null;
  interface: string | null;
  last_seen: number | null;
  os_type: string | null;
  hardware_vendor: string | null;
  device_type: string | null;
  tx_bytes: number | null;
  rx_bytes: number | null;
  category: string;
  subcategory: string;
  vendor: string;
  active: boolean;
  wifi_label?: string | null;
  wifi_source?: 'ruckus' | 'subnet' | null;
  expected_wifi?: string | null;
  wifi_status?: string | null;
  wifi_advice?: string | null;
}

export interface WifiNetwork {
  name: string;
  label: string;
  source: 'ruckus' | 'subnet' | null;
  total: number;
  active: number;
  devices: WifiDevice[];
}

export interface WifiNetworksStats {
  total: number;
  from_ruckus: number;
  from_subnet: number;
  unknown: number;
  ruckus_observations: number;
}

export interface WifiNetworksResponse {
  networks: WifiNetwork[];
  stats: WifiNetworksStats;
}

const WIFI_NETWORK_COLORS = [
  'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
  'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
];

export function WiFiNetworksTab() {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [sortKey, setSortKey] = useState<keyof WifiDevice>('hostname');
  const [sortAsc, setSortAsc] = useState(true);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<WifiNetworksResponse>({
    queryKey: ['/api/fortigate/wifi-networks'],
    queryFn: () => apiClient.get<WifiNetworksResponse>('/api/fortigate/wifi-networks'),
    staleTime: 30_000,
    retry: 1,
  });

  useEffect(() => {
    if (!isLoading && !isFetching) setLastUpdated(new Date());
  }, [isLoading, isFetching, data]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/wifi-networks'] });
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 30_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  function toggleGroup(name: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function handleSort(key: keyof WifiDevice) {
    if (key === sortKey) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  }

  function SortIcon({ col }: { col: keyof WifiDevice }) {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortAsc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  }

  const networks = data?.networks ?? [];
  const totalDevices = networks.reduce((s, n) => s + n.total, 0);
  const totalActive = networks.reduce((s, n) => s + n.active, 0);
  const stats = data?.stats;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">WiFi Networks</h2>
          <p className="text-sm text-muted-foreground">
            Devices grouped by their observed Wi-Fi SSID from the Ruckus controller,
            falling back to the 10.0.22.0/23 subnet when Ruckus has no observation yet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} data-testid="button-refresh-wifi-networks">
            <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {isError && !isLoading && (
        <ErrorCard message={(error as Error)?.message || 'Unknown error'} onRetry={refetch} />
      )}

      {stats && stats.from_ruckus === 0 && stats.total > 0 && !isLoading && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 pt-5 pb-5">
            <Wifi className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-sm">No Ruckus observations yet</p>
              <p className="text-sm text-muted-foreground mt-0.5">
                The Ruckus controller hasn't reported any client→SSID mappings to <code className="font-mono">network_devices</code> yet.
                Wireless snapshots populate this every 5&nbsp;minutes once the controller is reachable.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!isLoading && networks.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg border border-border/50 bg-muted/20" data-testid="strip-wifi-summary">
            <Wifi className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground font-medium mr-1">Networks:</span>
            {networks.filter(n => n.name !== '__unknown__').map((network, i) => (
              <span
                key={network.name}
                className={cn('inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border', WIFI_NETWORK_COLORS[i % WIFI_NETWORK_COLORS.length])}
                data-testid={`badge-wifi-network-${network.name}`}
              >
                {network.label}
                <span className="font-bold">{network.total}</span>
                {network.active > 0 && (
                  <span className="flex items-center gap-0.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="text-emerald-600 dark:text-emerald-400">{network.active}</span>
                  </span>
                )}
              </span>
            ))}
            <div className="h-4 w-px bg-border/50 mx-1" />
            <div className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-blue-400 shrink-0" />
              <span className="text-xs font-semibold" data-testid="text-wifi-total">{totalDevices}</span>
              <span className="text-xs text-muted-foreground">total</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400" data-testid="text-wifi-active">{totalActive}</span>
              <span className="text-xs text-muted-foreground">active</span>
            </div>
          </div>
        </>
      )}

      {isLoading ? (
        <SectionSkeleton rows={5} />
      ) : networks.length === 0 && !isError ? (
        <div className="rounded-md border border-border/50 py-10 text-center text-muted-foreground text-sm">
          No devices found
        </div>
      ) : (
        <div className="space-y-3">
          {networks.map((network, ni) => {
            const isOther = network.name === '__unknown__';
            const isCollapsed = collapsedGroups.has(network.name);
            const color = isOther ? 'bg-muted/10 text-muted-foreground border-border/50' : WIFI_NETWORK_COLORS[ni % WIFI_NETWORK_COLORS.length];

            const sorted = [...network.devices].sort((a, b) => {
              const av: string | number | null = a[sortKey] as string | number | null;
              const bv: string | number | null = b[sortKey] as string | number | null;
              if (av === null && bv === null) return 0;
              if (av === null) return 1;
              if (bv === null) return -1;
              if (typeof av === 'number' && typeof bv === 'number') return sortAsc ? av - bv : bv - av;
              return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
            });

            return (
              <div key={network.name} className="rounded-md border border-border/50 overflow-hidden" data-testid={`group-wifi-${network.name}`}>
                <button
                  className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                  onClick={() => toggleGroup(network.name)}
                  data-testid={`button-toggle-wifi-${network.name}`}
                >
                  <div className="flex items-center gap-3">
                    <Wifi className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-semibold text-sm">{network.label}</span>
                    <span
                      className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border', color)}
                      data-testid={`badge-wifi-count-${network.name}`}
                    >
                      {network.total} device{network.total !== 1 ? 's' : ''}
                    </span>
                    {network.active > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {network.active} active
                      </span>
                    )}
                    {isOther && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">Not seen by Ruckus</Badge>
                    )}
                  </div>
                  {isCollapsed
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    : <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  }
                </button>

                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm" data-testid={`table-wifi-devices-${network.name}`}>
                      <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          {([
                            { key: 'hostname' as keyof WifiDevice, label: 'Hostname / Vendor' },
                            { key: 'ip' as keyof WifiDevice, label: 'IP Address' },
                            { key: 'mac' as keyof WifiDevice, label: 'MAC' },
                            { key: 'vendor' as keyof WifiDevice, label: 'Vendor / Category' },
                            { key: 'last_seen' as keyof WifiDevice, label: 'Last Seen' },
                            { key: 'rx_bytes' as keyof WifiDevice, label: 'RX' },
                            { key: 'tx_bytes' as keyof WifiDevice, label: 'TX' },
                          ]).map(col => (
                            <th
                              key={col.key}
                              className="px-4 py-2.5 text-left cursor-pointer hover:text-foreground transition-colors whitespace-nowrap"
                              onClick={() => handleSort(col.key)}
                            >
                              <div className="flex items-center gap-1">
                                {col.label}
                                <SortIcon col={col.key} />
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/30">
                        {sorted.map((device, di) => {
                          const idx = `${ni}-${di}`;
                          const active = isRecentlyActive(device.last_seen);
                          return (
                            <tr
                              key={device.mac || idx}
                              className={cn('hover:bg-muted/20 transition-colors', active ? 'bg-emerald-500/5' : '')}
                              data-testid={`row-wifi-device-${idx}`}
                            >
                              <td className="px-4 py-2.5 font-medium">
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn('h-2 w-2 rounded-full shrink-0', active ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                                    title={active ? 'Active now' : 'Previously seen'}
                                  />
                                  <span data-testid={`text-wifi-hostname-${idx}`}>{device.hostname || <span className="text-muted-foreground italic">Unknown</span>}</span>
                                </div>
                                {device.hardware_vendor && (
                                  <div className="text-xs text-muted-foreground font-normal pl-4 mt-0.5">
                                    {device.hardware_vendor}
                                  </div>
                                )}
                              </td>
                              <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-wifi-ip-${idx}`}>{device.ip ?? '—'}</td>
                              <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground" data-testid={`text-wifi-mac-${idx}`}>{device.mac ?? '—'}</td>
                              <td className="px-4 py-2.5">
                                <div className="text-xs font-medium">{device.vendor !== 'Unknown' ? device.vendor : (device.hardware_vendor || '—')}</div>
                                <div className="text-xs text-muted-foreground">{device.subcategory !== 'Unknown' ? device.subcategory : (device.device_type || '—')}</div>
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap" data-testid={`text-wifi-lastseen-${idx}`}>
                                <span className={cn('text-xs', active ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground')}>
                                  {active ? 'Active now' : formatRelativeTime(device.last_seen)}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-wifi-rx-${idx}`}>
                                <span className="text-emerald-600 dark:text-emerald-400">↓</span> {formatBytes(device.rx_bytes)}
                              </td>
                              <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-wifi-tx-${idx}`}>
                                <span className="text-blue-400">↑</span> {formatBytes(device.tx_bytes)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
