import { useMemo } from 'react';
import { RefreshCw, CheckCircle2, ArrowUpCircle, ExternalLink, Loader2, PackageOpen, Server, AlertCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';
import { useHomeAssistant } from '@/hooks/useHomeAssistant';
import { cn } from '@/lib/utils';

interface UpdateItem {
  entity_id: string;
  name: string;
  installedVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

function parseUpdateEntity(entity: { entity_id: string; state: string; attributes: Record<string, unknown> }): UpdateItem {
  const attrs = entity.attributes;
  const name = (attrs.friendly_name as string) ?? entity.entity_id.replace(/^update\./, '').replace(/_/g, ' ');
  const installedVersion = (attrs.installed_version as string) ?? (attrs.current_version as string) ?? '—';
  const latestVersion = (attrs.latest_version as string) ?? '—';
  const updateAvailable = entity.state === 'on';
  return { entity_id: entity.entity_id, name, installedVersion, latestVersion, updateAvailable };
}

function UpdateRow({ item }: { item: UpdateItem }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between py-2.5 px-3 rounded-lg text-sm',
        item.updateAvailable ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-muted/40'
      )}
      data-testid={`update-row-${item.entity_id}`}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium truncate" data-testid={`update-name-${item.entity_id}`}>{item.name}</p>
        <p className="text-xs text-muted-foreground font-mono mt-0.5" data-testid={`update-installed-${item.entity_id}`}>
          {item.installedVersion !== '—' ? `v${item.installedVersion}` : '—'}
        </p>
      </div>
      <div className="ml-3 flex-shrink-0">
        {item.updateAvailable ? (
          <div className="flex flex-col items-end gap-1">
            <Badge className="bg-amber-500 text-white text-[10px] px-1.5 py-0" data-testid={`badge-update-${item.entity_id}`}>
              <ArrowUpCircle className="h-3 w-3 mr-1" />
              Available
            </Badge>
            {item.latestVersion !== '—' && (
              <span className="text-[10px] text-amber-500 font-mono" data-testid={`update-latest-${item.entity_id}`}>
                v{item.latestVersion}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1 text-emerald-500" data-testid={`badge-uptodate-${item.entity_id}`}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span className="text-[10px] font-medium">Up to date</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function HAUpdatesCard() {
  const { allEntities, loading, unavailable, error } = useSharedHAAllEntities();
  const { settings } = useHomeAssistant();
  const haUrl = settings?.ha_url ?? null;

  const updates = useMemo<UpdateItem[]>(() => {
    return allEntities
      .filter(e => e.entity_id.startsWith('update.'))
      .map(parseUpdateEntity)
      .sort((a, b) => {
        if (a.updateAvailable && !b.updateAvailable) return -1;
        if (!a.updateAvailable && b.updateAvailable) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [allEntities]);

  const pendingCount = useMemo(() => updates.filter(u => u.updateAvailable).length, [updates]);

  const statusBadgeClass = loading
    ? 'bg-muted text-muted-foreground'
    : error
    ? 'bg-red-500/10 text-red-500 border border-red-500/20'
    : unavailable
    ? 'bg-red-500/10 text-red-500 border border-red-500/20'
    : pendingCount > 0
    ? 'bg-amber-500/10 text-amber-600 border border-amber-500/20'
    : 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/20';

  const statusText = loading
    ? 'Loading…'
    : error
    ? 'Error loading'
    : unavailable
    ? 'Unavailable'
    : pendingCount > 0
    ? `${pendingCount} update${pendingCount !== 1 ? 's' : ''} available`
    : 'All up to date';

  return (
    <Card className="overflow-hidden transition-all duration-300 hover:shadow-lg animate-slide-up" data-testid="ha-updates-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-violet-500/10">
              <RefreshCw className="h-6 w-6 text-violet-400" />
            </div>
            <div>
              <CardTitle className="text-lg">Software Updates</CardTitle>
              <div className="flex items-center gap-2 mt-1">
                <span
                  className={cn('inline-flex items-center gap-1 text-xs font-medium rounded-full px-2 py-0.5', statusBadgeClass)}
                  data-testid="updates-status-badge"
                >
                  {!loading && error && <AlertCircle className="h-3 w-3" />}
                  {!loading && !error && unavailable && <AlertCircle className="h-3 w-3" />}
                  {!loading && !error && !unavailable && pendingCount > 0 && <ArrowUpCircle className="h-3 w-3" />}
                  {!loading && !error && !unavailable && pendingCount === 0 && <CheckCircle2 className="h-3 w-3" />}
                  {statusText}
                </span>
              </div>
            </div>
          </div>
          {haUrl && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5 shrink-0"
              onClick={() => window.open(haUrl, '_blank', 'noopener,noreferrer')}
              data-testid="button-open-ha"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open HA
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent>
        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-8 px-4 text-center" data-testid="updates-error-state">
            <div className="rounded-full bg-red-500/10 p-3">
              <AlertCircle className="h-6 w-6 text-red-400" />
            </div>
            <div>
              <p className="text-sm font-semibold">Failed to Load Updates</p>
              <p className="text-xs text-muted-foreground mt-1">{error}</p>
            </div>
          </div>
        ) : unavailable ? (
          <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
            <div className="rounded-full bg-red-500/10 p-3">
              <Server className="h-6 w-6 text-red-400" />
            </div>
            <div>
              <p className="text-sm font-semibold">Home Assistant Unavailable</p>
              <p className="text-xs text-muted-foreground mt-1">Unable to connect to Home Assistant.</p>
            </div>
          </div>
        ) : updates.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
            <div className="rounded-full bg-violet-500/10 p-3">
              <PackageOpen className="h-6 w-6 text-violet-400" />
            </div>
            <div>
              <p className="text-sm font-semibold">No Update Entities Found</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                No <code className="font-mono">update.*</code> entities were found in Home Assistant.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5" data-testid="updates-list">
            {updates.map(item => (
              <UpdateRow key={item.entity_id} item={item} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
