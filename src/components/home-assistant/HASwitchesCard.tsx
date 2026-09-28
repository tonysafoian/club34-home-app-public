import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Power, Loader2, Plug } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { toggleSwitch, HAEntity } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';

function SwitchRow({ entity, onRefresh }: { entity: HAEntity; onRefresh: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const isOn = entity.state === 'on';
  const friendlyName = (entity.attributes?.friendly_name as string) || entity.entity_id;

  const handleToggle = async () => {
    setBusy(true);
    try { await toggleSwitch(entity.entity_id); setTimeout(onRefresh, 800); }
    catch (e: unknown) { toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' }); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
      <Plug className={`h-4 w-4 flex-shrink-0 ${isOn ? 'text-primary' : 'text-muted-foreground'}`} />
      <span className="text-sm flex-1 truncate">{friendlyName}</span>
      <Button
        variant={isOn ? 'default' : 'outline'}
        size="sm"
        className="h-7 px-2"
        onClick={handleToggle}
        disabled={busy}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
      </Button>
    </div>
  );
}

export function HASwitchesCard() {
  const { entities, loading, unavailable, refetch } = useSharedHAEntities('switch');
  const onCount = entities.filter(e => e.state === 'on').length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-5 w-5 text-primary" />
            Switches
          </CardTitle>
          {unavailable ? (
            <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
          ) : (
            <Badge variant="secondary">{onCount}/{entities.length} on</Badge>
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
          <p className="text-sm text-muted-foreground text-center py-4">No switch entities found</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
            {[...entities]
              .sort((a, b) => (b.state === 'on' ? 1 : 0) - (a.state === 'on' ? 1 : 0))
              .map(entity => (
                <SwitchRow key={entity.entity_id} entity={entity} onRefresh={refetch} />
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
