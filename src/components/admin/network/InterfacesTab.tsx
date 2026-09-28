import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  RefreshCw, Network, ChevronDown, ChevronUp, Eye, EyeOff,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FortiInterface, InterfacesResponse } from './types';
import {
  LastUpdated, SectionSkeleton, ErrorCard,
} from './shared';
import { formatBytes, typeLabel } from './shared-utils';

function interfaceStatusLight(iface: FortiInterface): { color: string; title: string } {
  const isAdminUp = iface.status === 'up';
  const hasLink = iface.link;
  if (!isAdminUp) return { color: 'bg-red-500', title: 'Admin disabled' };
  if (isAdminUp && hasLink) return { color: 'bg-emerald-500', title: 'Link up, enabled' };
  if (isAdminUp && !hasLink) return { color: 'bg-yellow-500', title: 'Enabled, no link' };
  return { color: 'bg-muted-foreground', title: 'Unused' };
}

function InterfaceGroupSection({
  type,
  interfaces,
  defaultOpen = true,
}: {
  type: string;
  interfaces: FortiInterface[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div data-testid={`section-iface-group-${type}`}>
      <button
        className="w-full flex items-center gap-2 py-1.5 text-left group"
        onClick={() => setOpen(!open)}
        data-testid={`button-iface-group-${type}`}
      >
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
          {typeLabel(type)}
        </span>
        <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">{interfaces.length}</Badge>
        <span className="ml-auto">
          {open
            ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          }
        </span>
      </button>

      {open && (
        <div className="mt-1 rounded-md border border-border/40 overflow-hidden">
          {interfaces.map((iface, idx) => {
            const statusLight = interfaceStatusLight(iface);
            const displayName = iface.description || iface.name;
            const techName = iface.description ? iface.name : null;
            const totalBytes = (iface.rx_bytes ?? 0) + (iface.tx_bytes ?? 0);
            const hasTraffic = totalBytes > 0 || (iface.rx_packets ?? 0) > 0;

            return (
              <div
                key={iface.name}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 text-sm',
                  idx !== 0 && 'border-t border-border/30',
                  'hover:bg-muted/20 transition-colors'
                )}
                data-testid={`row-interface-${iface.name}`}
              >
                {/* Status light */}
                <span
                  className={cn('h-2.5 w-2.5 rounded-full shrink-0 shadow-sm', statusLight.color)}
                  title={statusLight.title}
                  data-testid={`dot-iface-${iface.name}`}
                />

                {/* Name */}
                <div className="min-w-0 w-44 shrink-0">
                  <div className="font-medium truncate" data-testid={`text-iface-name-${iface.name}`}>{displayName}</div>
                  {techName && (
                    <div className="text-xs text-muted-foreground font-mono truncate">{techName}</div>
                  )}
                </div>

                {/* Type badge */}
                <Badge variant="outline" className="text-[10px] px-1.5 shrink-0 hidden sm:flex">
                  {typeLabel(iface.type)}
                </Badge>

                {/* IP */}
                <div className="text-xs font-mono text-muted-foreground w-36 shrink-0 hidden md:block truncate">
                  {iface.ip
                    ? <span data-testid={`text-iface-ip-${iface.name}`}>{iface.ip}{iface.mask ? `/${iface.mask}` : ''}</span>
                    : <span className="opacity-40">—</span>
                  }
                </div>

                {/* Speed */}
                <div className="text-xs text-muted-foreground w-20 shrink-0 hidden lg:block">
                  {iface.speed > 0
                    ? <span data-testid={`text-iface-speed-${iface.name}`}>{iface.speed} Mbps</span>
                    : <span className="opacity-40">—</span>
                  }
                </div>

                {/* VLAN */}
                {iface.vlanid > 0 && (
                  <Badge variant="secondary" className="text-[10px] shrink-0 hidden lg:flex">
                    VLAN {iface.vlanid}
                  </Badge>
                )}

                {/* RX / TX */}
                <div className="ml-auto flex items-center gap-4 text-xs font-mono shrink-0">
                  {hasTraffic ? (
                    <>
                      <span className="hidden sm:block text-muted-foreground">
                        <span className="text-emerald-500">↓</span>{' '}
                        <span data-testid={`text-iface-rx-${iface.name}`}>{formatBytes(iface.rx_bytes)}</span>
                      </span>
                      <span className="hidden sm:block text-muted-foreground">
                        <span className="text-blue-400">↑</span>{' '}
                        <span data-testid={`text-iface-tx-${iface.name}`}>{formatBytes(iface.tx_bytes)}</span>
                      </span>
                      {(() => {
                        const totalPkts = (iface.rx_packets ?? 0) + (iface.tx_packets ?? 0);
                        return totalPkts > 0 ? (
                          <span className="hidden lg:block text-muted-foreground/60">
                            {totalPkts.toLocaleString()} pkts
                          </span>
                        ) : null;
                      })()}
                    </>
                  ) : (
                    <span className="text-muted-foreground/40">no traffic</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function InterfacesTab() {
  const [showUnused, setShowUnused] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const {
    data: ifaceData,
    isLoading,
    isError,
    error: ifaceErrorObj,
    refetch,
    isFetching,
  } = useQuery<InterfacesResponse>({
    queryKey: ['/api/fortigate/interfaces'],
    queryFn: () => apiClient.get<InterfacesResponse>('/api/fortigate/interfaces'),
    staleTime: 30_000,
    retry: 1,
  });

  useEffect(() => {
    if (!isLoading && !isFetching) setLastUpdated(new Date());
  }, [isLoading, isFetching, ifaceData]);

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 30_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  const interfaces = ifaceData?.interfaces ?? [];

  const isUnused = (iface: FortiInterface) =>
    !iface.link &&
    iface.status !== 'up' &&
    !iface.ip &&
    (iface.rx_bytes === null || iface.rx_bytes === 0) &&
    (iface.tx_bytes === null || iface.tx_bytes === 0) &&
    (iface.rx_packets === null || iface.rx_packets === 0);

  const used = interfaces.filter(i => !isUnused(i));
  const unused = interfaces.filter(isUnused);

  const grouped: Record<string, FortiInterface[]> = {};
  for (const iface of used) {
    const t = iface.type || 'physical';
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(iface);
  }
  const typeOrder = ['physical', 'aggregate', 'hard_switch', 'vlan', 'loopback', 'tunnel', 'vdom'];
  const sortedTypes = [
    ...typeOrder.filter(t => grouped[t]),
    ...Object.keys(grouped).filter(t => !typeOrder.includes(t)),
  ];

  const upCount = interfaces.filter(i => i.link && i.status === 'up').length;
  const downCount = interfaces.filter(i => !i.link && i.status === 'up').length;
  const disabledCount = interfaces.filter(i => i.status !== 'up').length;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Firewall Interfaces</h2>
          <p className="text-sm text-muted-foreground">Network interfaces — live status and traffic metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isFetching}
            data-testid="button-refresh-interfaces"
          >
            <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {isError && !isLoading && (
        <ErrorCard
          message={ifaceErrorObj instanceof Error ? ifaceErrorObj.message : 'The firewall API is unreachable.'}
          onRetry={refetch}
        />
      )}

      {/* Status legend */}
      {!isLoading && interfaces.length > 0 && (
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground" data-testid="legend-interface-status">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span>Link up ({upCount})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-yellow-500" />
            <span>No link ({downCount})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            <span>Admin disabled ({disabledCount})</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-muted-foreground" />
            <span>Unused ({unused.length})</span>
          </div>
        </div>
      )}

      {isLoading ? (
        <SectionSkeleton rows={8} />
      ) : interfaces.length === 0 ? (
        <Card className="border border-border/50">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Network className="h-10 w-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm text-muted-foreground">No interfaces found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {sortedTypes.map(type => (
            <InterfaceGroupSection
              key={type}
              type={type}
              interfaces={grouped[type]}
              defaultOpen={true}
            />
          ))}

          {/* Unused interfaces — collapsed by default */}
          {unused.length > 0 && (
            <div>
              <button
                className="w-full flex items-center gap-2 py-1.5 text-left group"
                onClick={() => setShowUnused(!showUnused)}
                data-testid="button-toggle-unused"
              >
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground group-hover:text-foreground transition-colors">
                  Unused
                </span>
                <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">{unused.length}</Badge>
                <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                  {showUnused ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {showUnused ? 'Hide' : 'Show'}
                  {showUnused ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </span>
              </button>

              {showUnused && (
                <div className="mt-1 rounded-md border border-border/30 overflow-hidden opacity-60">
                  {unused.map((iface, idx) => (
                    <div
                      key={iface.name}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 text-sm',
                        idx !== 0 && 'border-t border-border/20',
                      )}
                      data-testid={`row-interface-${iface.name}`}
                    >
                      <span className="h-2.5 w-2.5 rounded-full shrink-0 bg-muted-foreground" title="Unused" />
                      <div className="min-w-0 w-44 shrink-0">
                        <div className="font-mono text-xs text-muted-foreground">{iface.name}</div>
                        {iface.description && (
                          <div className="text-xs text-muted-foreground/60 truncate">{iface.description}</div>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[10px] opacity-60">Unused</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
