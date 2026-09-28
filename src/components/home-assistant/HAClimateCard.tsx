import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Thermometer, ChevronUp, ChevronDown, Loader2, Wind } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { setClimateTemp, setClimateMode, HAEntity } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';
/** Collapse repeated prefix/suffix in friendly names, e.g. "Kitchen Kitchen" → "Kitchen", "Guest House Upstairs Guest House" → "Guest House Upstairs" */
function deduplicateName(name: string): string {
  const words = name.split(' ');
  // Check prefix repetition
  for (let n = Math.floor(words.length / 2); n >= 1; n--) {
    if (words.slice(0, n).join(' ') === words.slice(n, n * 2).join(' ')) {
      return words.slice(n).join(' ');
    }
  }
  // Check suffix repetition (e.g. "Guest House Upstairs Guest House")
  for (let n = Math.floor(words.length / 2); n >= 1; n--) {
    if (words.slice(0, n).join(' ') === words.slice(-n).join(' ')) {
      return words.slice(0, words.length - n).join(' ');
    }
  }
  // Check trailing partial match (e.g. "Isla's Room Isla's" where last word(s) partially repeat start)
  if (words.length >= 3) {
    const last = words[words.length - 1];
    if (words[0].startsWith(last) || last.startsWith(words[0])) {
      return words.slice(0, -1).join(' ');
    }
  }
  return name;
}

const MODE_COLORS: Record<string, string> = {
  heat: 'text-orange-500',
  cool: 'text-blue-400',
  heat_cool: 'text-purple-400',
  auto: 'text-purple-400',
  fan_only: 'text-cyan-400',
  dry: 'text-yellow-500',
  off: 'text-muted-foreground',
};

function ClimateRow({ entity, onRefresh }: { entity: HAEntity; onRefresh: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const friendlyName = deduplicateName((entity.attributes?.friendly_name as string) || entity.entity_id);
  const currentTemp = entity.attributes?.current_temperature as number | undefined;
  const targetTemp = entity.attributes?.temperature as number | undefined;
  const hvacMode = entity.state;
  const availableModes: string[] = (entity.attributes?.hvac_modes as string[]) || [];

  const formatClimateError = (e: unknown): string => {
    const err = e as { status?: number; message?: string } | null | undefined;
    const status = err?.status;
    const msg = err?.message || 'Unknown error';
    return status ? `${status}: ${msg}` : msg;
  };

  const adjustTemp = async (delta: number) => {
    if (targetTemp == null) return;
    setBusy(true);
    try {
      await setClimateTemp(entity.entity_id, targetTemp + delta);
      setTimeout(onRefresh, 800);
    } catch (e: unknown) {
      toast({ title: `${friendlyName} error`, description: formatClimateError(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const changeMode = async (mode: string) => {
    setBusy(true);
    try {
      await setClimateMode(entity.entity_id, mode);
      setTimeout(onRefresh, 800);
    } catch (e: unknown) {
      toast({ title: `${friendlyName} error`, description: formatClimateError(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Thermometer className={`h-4 w-4 flex-shrink-0 ${MODE_COLORS[hvacMode] || 'text-muted-foreground'}`} />
        <span className="text-sm font-medium flex-1 truncate">{friendlyName}</span>
        {currentTemp !== undefined && (
          <span className="text-sm text-muted-foreground">{currentTemp}°</span>
        )}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {availableModes.length > 0 && availableModes.slice(0, 4).map(mode => (
            <Button
              key={mode}
              variant={hvacMode === mode ? 'default' : 'outline'}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => changeMode(mode)}
              disabled={busy}
            >
              {mode === 'heat_cool' ? 'Auto' : mode === 'fan_only' ? 'Fan' : mode.charAt(0).toUpperCase() + mode.slice(1)}
            </Button>
          ))}
        </div>
        {targetTemp !== undefined && hvacMode !== 'off' && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => adjustTemp(-1)} disabled={busy}>
              <ChevronDown className="h-3 w-3" />
            </Button>
            <span className="text-sm font-semibold w-10 text-center">{targetTemp}°</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => adjustTemp(1)} disabled={busy}>
              <ChevronUp className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function HAClimateCard() {
  const { entities, loading, unavailable, refetch } = useSharedHAEntities('climate');
  const active = entities.filter(e => e.state !== 'off').length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wind className="h-5 w-5 text-blue-400" />
            Climate
          </CardTitle>
          {unavailable ? (
            <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
          ) : (
            <Badge variant="secondary">{active} active</Badge>
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
          <p className="text-sm text-muted-foreground text-center py-4">No climate entities found</p>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {entities.map(entity => (
              <ClimateRow key={entity.entity_id} entity={entity} onRefresh={refetch} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
