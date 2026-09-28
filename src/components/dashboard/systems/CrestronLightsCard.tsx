import { useState, useCallback, useMemo } from 'react';
import {
  Lightbulb, Fan, Loader2, Search, ChevronDown, ChevronUp, Power, RotateCcw,
} from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { turnLightOn, turnLightOff, HAEntity } from '@/lib/api/homeAssistant';
import { useSharedHAEntities, useGoveeEntityIds } from '@/hooks/useHAEntitiesContext';
import { useToast } from '@/hooks/use-toast';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useUserRole } from '@/hooks/useUserRole';

// ── room parsing ─────────────────────────────────────────────────────
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

/** Title-case that doesn't capitalize after apostrophes (Butler's not Butler'S) */
function smartTitleCase(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .replace(/'(\w)/g, (_, c) => `'${c.toLowerCase()}`);
}

// ── excluded entities ────────────────────────────────────────────────
const EXCLUDED_ENTITIES = new Set([
  'light.spa_light',
  'light.pool_light',
  'light.laminar_led_lt',
]);

// ── room controls (turn off all / dim all in a room) ─────────────────
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

  const onEntities = entities.filter(e => e.state === 'on');
  const anyOn = onEntities.length > 0;

  // Average brightness of on lights that support dimming
  const dimmable = onEntities.filter(e => e.attributes?.brightness !== undefined);
  const avgBrightness = dimmable.length > 0
    ? Math.round(dimmable.reduce((sum, e) => sum + Math.round((Number(e.attributes.brightness) / 255) * 100), 0) / dimmable.length)
    : 0;

  const handleRoomOff = useCallback(async () => {
    setSending(true);
    try {
      await Promise.all(onEntities.map(e => turnLightOff(e.entity_id)));
      toast({ title: `${roomName} — all off` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
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
      await Promise.all(targets.map(e => turnLightOn(e.entity_id, Math.round(pct * 2.55))));
      toast({ title: `${roomName} → ${pct}%` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
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

// ── device row (full) ────────────────────────────────────────────────
function DeviceRow({
  entity,
  deviceName,
  onRefresh,
}: {
  entity: HAEntity;
  deviceName: string;
  onRefresh: (silent?: boolean) => void;
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [localBrightness, setLocalBrightness] = useState<number | null>(null);

  const isOn = entity.state === 'on';
  const isUnavailable = entity.state === 'unavailable';
  const hasBrightness = entity.attributes?.brightness !== undefined;
  const brightness = hasBrightness
    ? Math.round((Number(entity.attributes.brightness) / 255) * 100)
    : 0;

  const doToggle = useCallback(async (turnOn: boolean) => {
    setSending(true);
    try {
      await (turnOn ? turnLightOn(entity.entity_id) : turnLightOff(entity.entity_id));
      toast({ title: `${deviceName} turned ${turnOn ? 'on' : 'off'}` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [entity.entity_id, deviceName, toast, onRefresh]);

  const handleBrightness = useCallback(async (vals: number[]) => {
    const pct = vals[0];
    setLocalBrightness(null);
    setSending(true);
    try {
      await turnLightOn(entity.entity_id, Math.round(pct * 2.55));
      toast({ title: `${deviceName} → ${pct}%` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [entity.entity_id, deviceName, toast, onRefresh]);

  const displayBrightness = localBrightness ?? brightness;

  return (
    <div className={`flex items-center gap-2 py-2 ${isUnavailable ? 'opacity-40' : ''}`}>
      <Lightbulb
        className={`h-4 w-4 shrink-0 transition-colors ${isOn ? 'text-yellow-400' : 'text-muted-foreground'}`}
        fill={isOn ? 'currentColor' : 'none'}
      />
      <span className="text-sm font-medium truncate min-w-0 flex-1">{deviceName}</span>
      {sending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      {isOn && hasBrightness && (
        <span className="text-xs text-muted-foreground shrink-0">{displayBrightness}%</span>
      )}
      {isOn && hasBrightness && (
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
        onCheckedChange={doToggle}
        disabled={sending || isUnavailable}
      />
    </div>
  );
}

// ── compact "currently on" row ───────────────────────────────────────
function CurrentlyOnRow({
  entity,
  roomName,
  deviceName,
  onRefresh,
}: {
  entity: HAEntity;
  roomName: string;
  deviceName: string;
  onRefresh: (silent?: boolean) => void;
}) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [localBrightness, setLocalBrightness] = useState<number | null>(null);

  const hasBrightness = entity.attributes?.brightness !== undefined;
  const brightness = hasBrightness
    ? Math.round((Number(entity.attributes.brightness) / 255) * 100)
    : 0;

  const handleOff = useCallback(async () => {
    setSending(true);
    try {
      await turnLightOff(entity.entity_id);
      toast({ title: `${deviceName} turned off` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [entity.entity_id, deviceName, toast, onRefresh]);

  const handleBrightness = useCallback(async (vals: number[]) => {
    setLocalBrightness(null);
    setSending(true);
    try {
      await turnLightOn(entity.entity_id, Math.round(vals[0] * 2.55));
      setTimeout(() => onRefresh(true), 800);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [entity.entity_id, toast, onRefresh]);

  const displayBrightness = localBrightness ?? brightness;

  return (
    <div className="flex items-center gap-2 py-1.5">
      <Lightbulb className="h-3 w-3 shrink-0 text-yellow-400" fill="currentColor" />
      <span className="text-xs font-medium truncate min-w-0 flex-1">{deviceName}</span>
      {sending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      {hasBrightness && (
        <Slider
          className="w-24 sm:w-16 shrink-0"
          min={1}
          max={100}
          step={5}
          value={[displayBrightness]}
          onValueChange={(vals) => setLocalBrightness(vals[0])}
          onValueCommit={handleBrightness}
        />
      )}
      <Switch
        checked={true}
        onCheckedChange={() => handleOff()}
        disabled={sending}
        className="scale-75"
      />
    </div>
  );
}

// ── main card ────────────────────────────────────────────────────────
export function CrestronLightsCard() {
  const [search, setSearch] = useState('');
  const [currentlyOnOpen, setCurrentlyOnOpen] = useState(true);
  const { toast } = useToast();
  const { isAdmin } = useUserRole();

  const { entities, loading, refetch } = useSharedHAEntities('light');
  const goveeEntityIds = useGoveeEntityIds();

  const qc = useQueryClient();
  const reloadMutation = useMutation({
    mutationFn: () => apiClient.post('/api/home-assistant/crestron/reload'),
    onSuccess: () => {
      toast({ title: 'Crestron reloading', description: 'The integration will restart — lights should refresh within a few seconds.' });
      setTimeout(() => refetch(true), 5_000);
      qc.invalidateQueries({ queryKey: ['/api/home-assistant/states'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast({ title: 'Reload failed', description: msg, variant: 'destructive' });
    },
  });

  // Group entities by parsed room
  const { zones, onCount, onLights, totalCount, unavailableCount } = useMemo(() => {
    const roomMap = new Map<string, { entity: HAEntity; device: string }[]>();
    let on = 0;
    let total = 0;
    let unavailable = 0;
    const lightsOn: { entity: HAEntity; room: string; device: string }[] = [];

    for (const entity of entities) {
      if (EXCLUDED_ENTITIES.has(entity.entity_id)) continue;
      // Skip Govee entities — they have their own card
      if (goveeEntityIds.size > 0) {
        if (goveeEntityIds.has(entity.entity_id)) continue;
      } else {
        // Fallback to name matching when Govee IDs haven't loaded yet
        if (entity.entity_id.toLowerCase().includes('govee') ||
            ((entity.attributes?.friendly_name as string) || '').toLowerCase().includes('govee')) continue;
      }
      const { room, device } = parseRoomAndDevice(entity);
      if (!roomMap.has(room)) roomMap.set(room, []);
      roomMap.get(room)!.push({ entity, device });
      total++;
      if (entity.state === 'on') {
        on++;
        lightsOn.push({ entity, room, device });
      } else if (entity.state === 'unavailable') {
        unavailable++;
      }
    }

    const sorted = Array.from(roomMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([room, devices]) => ({
        room,
        devices: devices.sort((a, b) => a.device.localeCompare(b.device)),
      }));

    lightsOn.sort((a, b) => a.room.localeCompare(b.room) || a.device.localeCompare(b.device));

    return { zones: sorted, onCount: on, onLights: lightsOn, totalCount: total, unavailableCount: unavailable };
  }, [entities, goveeEntityIds]);

  // Bridge is "degraded" if >20% of Crestron lights are unavailable
  const unavailablePct = totalCount > 0 ? unavailableCount / totalCount : 0;
  const bridgeDown = unavailablePct >= 0.2;

  // Filter by search
  const filteredZones = useMemo(() => {
    if (!search.trim()) return zones;
    const q = search.toLowerCase();
    return zones
      .map(z => ({
        ...z,
        devices: z.devices.filter(
          d =>
            d.device.toLowerCase().includes(q) ||
            d.entity.entity_id.toLowerCase().includes(q) ||
            z.room.toLowerCase().includes(q),
        ),
      }))
      .filter(z => z.devices.length > 0);
  }, [search, zones]);

  return (
    <div className="space-y-4">
      <SystemCard
        title="Home Lights"
        icon={<Lightbulb className="h-6 w-6 text-yellow-400" />}
        status={loading ? 'idle' : bridgeDown ? 'warning' : 'online'}
        statusText={
          loading
            ? 'Loading…'
            : bridgeDown
              ? `⚠ Bridge offline · ${unavailableCount}/${totalCount} unavailable · ${onCount} on`
              : `${onCount} on · ${zones.length} rooms · ${totalCount} lights${unavailableCount > 0 ? ` · ${unavailableCount} offline` : ''}`
        }
        accentColor="bg-yellow-500/10"
        metrics={[
          { label: 'On Now', value: loading ? '…' : String(onCount) },
          { label: 'Total', value: loading ? '…' : String(totalCount) },
        ]}
      >
        {/* Bridge offline banner with Reload button */}
        {bridgeDown && isAdmin && (
          <div className="flex items-center justify-between gap-3 mb-4 px-3 py-2 rounded-lg border border-orange-500/30 bg-orange-500/10">
            <p className="text-sm text-orange-600 dark:text-orange-400 font-medium">
              Crestron bridge is offline
            </p>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 border-orange-500/50 text-orange-600 dark:text-orange-400 hover:bg-orange-500/10"
              onClick={() => reloadMutation.mutate()}
              disabled={reloadMutation.isPending}
              data-testid="button-reload-crestron"
            >
              {reloadMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Reload Crestron
            </Button>
          </div>
        )}

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter lights…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : entities.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No light entities found in Home Assistant
          </p>
        ) : (
          <>
            {/* Room accordion */}
            <Accordion type="multiple" className="w-full">
              {filteredZones.map(zone => {
                const zoneOn = zone.devices.filter(d => d.entity.state === 'on').length;
                return (
                  <AccordionItem key={zone.room} value={zone.room}>
                    <AccordionTrigger className="py-2 text-sm hover:no-underline">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="font-semibold truncate">{zone.room}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {zoneOn > 0 ? (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              {zoneOn}/{zone.devices.length} on
                            </Badge>
                          ) : (
                            `(${zone.devices.length})`
                          )}
                        </span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <RoomControls
                        entities={zone.devices.map(d => d.entity)}
                        onRefresh={refetch}
                        roomName={zone.room}
                      />
                      <div className="divide-y divide-border">
                        {zone.devices.map(d => (
                          <DeviceRow
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

            {filteredZones.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No lights match "{search}"
              </p>
            )}
          </>
        )}
      </SystemCard>

      {/* Currently On — always visible below the card */}
      {!loading && onCount > 0 && (
        <Collapsible open={currentlyOnOpen} onOpenChange={setCurrentlyOnOpen}>
          <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4">
            <CollapsibleTrigger className="flex items-center gap-2 w-full text-left">
              {currentlyOnOpen ? (
                <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              <Lightbulb className="h-4 w-4 text-yellow-400 shrink-0" fill="currentColor" />
              <span className="text-sm font-semibold">Currently On</span>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {onCount}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-3 space-y-3">
                {Object.entries(
                  onLights.reduce<Record<string, typeof onLights>>((acc, l) => {
                    (acc[l.room] ??= []).push(l);
                    return acc;
                  }, {})
                )
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([room, lights]) => (
                    <div key={room}>
                      <RoomControls
                        entities={lights.map(l => l.entity)}
                        onRefresh={refetch}
                        roomName={room}
                      />
                      <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{room}</p>
                      <div className="divide-y divide-border">
                        {lights.map(l => (
                          <CurrentlyOnRow
                            key={l.entity.entity_id}
                            entity={l.entity}
                            roomName={l.room}
                            deviceName={l.device}
                            onRefresh={refetch}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      )}
    </div>
  );
}
