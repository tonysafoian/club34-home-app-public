import { useState, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion';
import { Lightbulb, Power, Loader2 } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { turnLightOn, turnLightOff, toggleLight, HAEntity } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';

// ── room parsing (same logic as CrestronLightsCard) ──────────────────
function parseRoomAndDevice(entity: HAEntity): { room: string; device: string } {
  const friendly = (entity.attributes?.friendly_name as string) || '';
  if (friendly) {
    const words = friendly.trim().split(/\s+/);
    for (let prefixLen = Math.min(Math.floor(words.length / 2), 4); prefixLen >= 1; prefixLen--) {
      const prefix = words.slice(0, prefixLen);
      const nextChunk = words.slice(prefixLen, prefixLen + prefixLen);
      if (prefix.join(' ').toLowerCase() === nextChunk.join(' ').toLowerCase()) {
        const room = prefix.join(' ');
        const device = words.slice(prefixLen * 2).join(' ') || room;
        return { room: smartTitleCase(room), device: smartTitleCase(device) };
      }
    }
    if (words.length >= 2) {
      return { room: smartTitleCase(words[0]), device: smartTitleCase(words.slice(1).join(' ')) };
    }
    return { room: smartTitleCase(friendly), device: smartTitleCase(friendly) };
  }
  const id = entity.entity_id.replace(/^light\./, '');
  const parts = id.split('_');
  return { room: smartTitleCase(parts[0] || 'Other'), device: smartTitleCase(parts.slice(1).join(' ') || id) };
}

function smartTitleCase(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .replace(/'(\w)/g, (_, c) => `'${c.toLowerCase()}`);
}

function RoomControls({
  entities,
  onRefresh,
  roomName,
}: {
  entities: HAEntity[];
  onRefresh: (silent?: boolean) => void;
  roomName: string;
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [localBrightness, setLocalBrightness] = useState<number | null>(null);

  const onEntities = entities.filter((e) => e.state === 'on');
  const anyOn = onEntities.length > 0;
  const dimmable = onEntities.filter((e) => e.attributes?.brightness !== undefined);
  const avgBrightness = dimmable.length > 0
    ? Math.round(dimmable.reduce((sum: number, e) => sum + Math.round((Number(e.attributes.brightness) / 255) * 100), 0) / dimmable.length)
    : 0;

  const handleRoomOff = useCallback(async () => {
    setSending(true);
    try {
      await Promise.all(onEntities.map((e) => turnLightOff(e.entity_id)));
      toast({ title: `${roomName} — all off` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [onEntities, roomName, toast, onRefresh]);

  const handleRoomBrightness = useCallback(async (vals: number[]) => {
    const pct = vals[0];
    setLocalBrightness(null);
    setSending(true);
    try {
      const targets = dimmable.length > 0 ? dimmable : onEntities;
      await Promise.all(targets.map((e) => turnLightOn(e.entity_id, Math.round(pct * 2.55))));
      toast({ title: `${roomName} → ${pct}%` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [dimmable, onEntities, roomName, toast, onRefresh]);

  if (!anyOn) return null;

  const displayBrightness = localBrightness ?? avgBrightness;

  return (
    <div className="flex items-center gap-2 py-1.5 px-1 mb-1 rounded bg-muted/40">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide flex-1 truncate font-semibold">Room</span>
      {sending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      {dimmable.length > 0 && (
        <>
          <span className="text-[10px] text-muted-foreground shrink-0">{displayBrightness}%</span>
          <Slider
            className="w-28 sm:w-20 shrink-0"
            min={1}
            max={100}
            step={5}
            value={[displayBrightness]}
            onValueChange={(vals) => setLocalBrightness(vals[0])}
            onValueCommit={handleRoomBrightness}
          />
        </>
      )}
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-[10px] gap-1 shrink-0"
        onClick={handleRoomOff}
        disabled={sending}
      >
        <Power className="h-3 w-3" /> All Off
      </Button>
    </div>
  );
}

function LightRow({ entity, deviceName, onRefresh }: { entity: HAEntity; deviceName: string; onRefresh: (silent?: boolean) => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [localBrightness, setLocalBrightness] = useState<number | null>(null);

  const isOn = entity.state === 'on';
  const brightness = entity.attributes?.brightness
    ? Math.round((Number(entity.attributes.brightness) / 255) * 100)
    : 0;

  const handleToggle = async () => {
    setBusy(true);
    try {
      await toggleLight(entity.entity_id);
      setTimeout(() => onRefresh(true), 800);
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const handleBrightness = async (value: number[]) => {
    setLocalBrightness(null);
    setBusy(true);
    try {
      await turnLightOn(entity.entity_id, Math.round((value[0] / 100) * 255));
      setTimeout(() => onRefresh(true), 800);
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const displayBrightness = localBrightness ?? brightness;

  return (
    <div className="flex items-center gap-2 py-2">
      <Lightbulb
        className={`h-4 w-4 flex-shrink-0 transition-colors ${isOn ? 'text-yellow-400' : 'text-muted-foreground'}`}
        fill={isOn ? 'currentColor' : 'none'}
      />
      <span className="text-sm flex-1 truncate">{deviceName}</span>
      {isOn && <span className="text-xs text-muted-foreground">{displayBrightness}%</span>}
      {isOn && entity.attributes?.brightness !== undefined && (
        <Slider
          className="w-28 sm:w-20 shrink-0"
          min={1}
          max={100}
          step={5}
          value={[displayBrightness]}
          onValueChange={(vals) => setLocalBrightness(vals[0])}
          onValueCommit={handleBrightness}
        />
      )}
      <Switch
        checked={isOn}
        onCheckedChange={handleToggle}
        disabled={busy}
      />
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
    </div>
  );
}

export function HALightsCard() {
  const { entities, loading, unavailable, refetch } = useSharedHAEntities('light');

  const { rooms, onCount } = useMemo(() => {
    const roomMap = new Map<string, { entity: HAEntity; device: string }[]>();
    let on = 0;
    for (const entity of entities) {
      const { room, device } = parseRoomAndDevice(entity);
      if (!roomMap.has(room)) roomMap.set(room, []);
      roomMap.get(room)!.push({ entity, device });
      if (entity.state === 'on') on++;
    }
    const sorted = Array.from(roomMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([room, devices]) => ({
        room,
        devices: devices.sort((a, b) => a.device.localeCompare(b.device)),
      }));
    return { rooms: sorted, onCount: on };
  }, [entities]);

  const allOff = () => Promise.all(entities.map(e => turnLightOff(e.entity_id))).then(() => setTimeout(() => refetch(true), 1000));

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-5 w-5 text-yellow-400" />
            Lights
          </CardTitle>
          <div className="flex items-center gap-2">
            {!unavailable && <Badge variant="secondary">{onCount}/{entities.length} on</Badge>}
            {unavailable && <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>}
            {!unavailable && onCount > 0 && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={allOff}>
                All Off
              </Button>
            )}
          </div>
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
          <p className="text-sm text-muted-foreground text-center py-4">No light entities found</p>
        ) : (
          <Accordion type="multiple" className="w-full" defaultValue={rooms.filter(r => r.devices.some(d => d.entity.state === 'on')).map(r => r.room)}>
            {rooms.map(({ room, devices }) => {
              const roomOn = devices.filter(d => d.entity.state === 'on').length;
              return (
                <AccordionItem key={room} value={room}>
                  <AccordionTrigger className="py-2 text-sm hover:no-underline">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="font-semibold truncate">{room}</span>
                      {roomOn > 0 ? (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                          {roomOn}/{devices.length} on
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">({devices.length})</span>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    <RoomControls
                      entities={devices.map(d => d.entity)}
                      onRefresh={refetch}
                      roomName={room}
                    />
                    <div className="divide-y divide-border">
                      {devices.map(d => (
                        <LightRow
                          key={d.entity.entity_id}
                          entity={d.entity}
                          deviceName={d.device}
                          onRefresh={refetch}
                        />
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
