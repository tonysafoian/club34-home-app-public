import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  RefreshCw, Globe,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TopSitesResponse } from './types';
import {
  LastUpdated, SectionSkeleton, ErrorCard, FortiViewSetupCallout,
} from './shared';
import { formatBytes } from './shared-utils';

export function TopSitesTab() {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<TopSitesResponse>({
    queryKey: ['/api/fortigate/top-sites'],
    queryFn: () => apiClient.get<TopSitesResponse>('/api/fortigate/top-sites'),
    staleTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (!isLoading && !isFetching) setLastUpdated(new Date());
  }, [isLoading, isFetching, data]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/top-sites'] });
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 60_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  const sites = data?.sites ?? [];
  const maxBytes = sites.length > 0 ? Math.max(...sites.map(s => s.bytes), 1) : 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Top Sites</h2>
          <p className="text-sm text-muted-foreground">Most visited destinations by bandwidth and hits</p>
        </div>
        <div className="flex items-center gap-2">
          <LastUpdated timestamp={lastUpdated} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} data-testid="button-refresh-topsites">
            <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {isError && !isLoading && (
        <ErrorCard message={(error as Error)?.message || 'Unknown error'} onRetry={refetch} />
      )}

      {isLoading ? (
        <SectionSkeleton rows={6} />
      ) : sites.length === 0 ? (
        <Card className="border-border/50">
          <CardContent className="py-12">
            <div className="flex flex-col items-center justify-center text-center">
              <Globe className="h-10 w-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">No site data yet — web filter log pending</p>
              <p className="text-xs text-muted-foreground/60 mt-1">Data will appear once the FortiGate web filter log has entries</p>
            </div>
            <div className="mx-auto max-w-xl">
              <FortiViewSetupCallout sensor="top_sites" />
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border/50">
          <CardContent className="pt-4">
            <div className="space-y-4">
              {sites.map((site, i) => (
                <div key={site.domain} className="space-y-1.5" data-testid={`row-site-${i}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Globe className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                        <span className="font-mono text-sm truncate" data-testid={`text-site-domain-${i}`}>{site.domain}</span>
                        {site.category && (
                          <Badge variant="outline" className="text-[10px] shrink-0">{site.category}</Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0 text-xs text-muted-foreground space-y-0.5">
                      <div>{formatBytes(site.bytes)}</div>
                      <div>{site.hits.toLocaleString()} hits</div>
                    </div>
                  </div>
                  <div className="w-full bg-muted rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full bg-blue-500 transition-all"
                      style={{ width: `${(site.bytes / maxBytes) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
