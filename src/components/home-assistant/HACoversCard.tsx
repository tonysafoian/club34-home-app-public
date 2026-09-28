import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { ChevronUp, ChevronDown, Loader2, Columns } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { openCover, closeCover, setCoverPosition, HAEntity } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';

function CoverRow({ entity, onRefresh }: { entity: HAEntity; onRefresh: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [localPosition, setLocalPosition] = useState<number | null>(null);
  const friendlyName = (entity.attributes?.friendly_name as string) || entity.entity_id;
  const position = (entity.attributes?.current_position as number | undefined) ?? null;

  const handleOpen = async () => {
    setBusy(true);
    try { await openCover(entity.entity_id); setTimeout(onRefresh, 1000); }
    catch (e: unknown) { toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' }); }
    finally { setBusy(false); }
  };
  const handleClose = async () => {
    setBusy(true);
    try { await closeCover(entity.entity_id); setTimeout(onRefresh, 1000); }
    catch (e: unknown) { toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' }); }
    finally { setBusy(false); }
  };
  const handlePosition = async (value: number[]) => {
    setLocalPosition(null);
    setBusy(true);
    try { await setCoverPosition(entity.entity_id, value[0]); setTimeout(onRefresh, 1000); }
    catch (e: unknown) { toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  const displayPosition = localPosition ?? position;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Columns className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm flex-1 truncate">{friendlyName}</span>
        {displayPosition !== null && <span className="text-xs text-muted-foreground">{displayPosition}%</span>}
        <div className="flex gap-1">
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={handleOpen} disabled={busy}>
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={handleClose} disabled={busy}>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {position !== null && (
        <Slider min={0} max={100} step={5} value={[displayPosition!]} onValueChange={(vals) => setLocalPosition(vals[0])} onValueCommit={handlePosition} className="w-full" />
      )}
    </div>
  );
}

export function HACoversCard() {
  const { entities, loading, unavailable, refetch } = useSharedHAEntities('cover');
  const openCount = entities.filter(e => e.state === 'open').length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Columns className="h-5 w-5 text-primary" />
            Shades & Covers
          </CardTitle>
          {unavailable ? (
            <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
          ) : (
            <Badge variant="secondary">{openCount} open</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="text-sm text-muted-foreground text-center py-4">Home Assistant is not connected</p>
        ) : loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entities.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No cover entities found</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {entities.map(entity => (
              <CoverRow key={entity.entity_id} entity={entity} onRefresh={refetch} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
