import { useState, useCallback, useMemo } from 'react';
import { Lightbulb, Loader2, Search, Power, AlertTriangle } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { turnLightOn, turnLightOff, toggleLight, HAEntity } from '@/lib/api/homeAssistant';
import { useSharedHAEntities, useGoveeEntityIds } from '@/hooks/useHAEntitiesContext';
import { useToast } from '@/hooks/use-toast';

/** Fallback: identify Govee entities by entity_id or friendly name */
function isGoveeEntityByName(entity: HAEntity): boolean {
  if (entity.entity_id.toLowerCase().includes('govee')) return true;
  const friendly = (entity.attributes?.friendly_name as string) || '';
  if (friendly.toLowerCase().includes('govee')) return true;
  return false;
}

/** Returns true if this entity is a segment sub-entity (not the parent device) */
function isSegmentEntity(entity: HAEntity): boolean {
  const id = entity.entity_id.toLowerCase();
  if (id.includes('segment')) return true;
  const friendly = (entity.attributes?.friendly_name as string || '').toLowerCase();
  if (friendly.includes('segment')) return true;
  return false;
}

/** Build a small color swatch from rgb_color if available */
function ColorDot({ entity }: { entity: HAEntity }) {
  const rgb = entity.attributes?.rgb_color as number[] | undefined;
  if (!rgb || rgb.length < 3) return null;
  return (
    <span
      className="inline-block w-3 h-3 rounded-full border border-border shrink-0"
      style={{ backgroundColor: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }}
      title={`RGB(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
    />
  );
}

function DeviceRow({
  entity,
  onRefresh,
}: {
  entity: HAEntity;
  onRefresh: (silent?: boolean) => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [localBrightness, setLocalBrightness] = useState<number | null>(null);

  const isOn = entity.state === 'on';
  const isUnavailable = entity.state === 'unavailable';
  const hasBrightness = entity.attributes?.brightness !== undefined;
  const brightness = hasBrightness
    ? Math.round((Number(entity.attributes.brightness) / 255) * 100)
    : 0;
  const effect = entity.attributes?.effect as string | undefined;
  const name = (entity.attributes?.friendly_name as string) || entity.entity_id.replace(/^light\./, '').replace(/_/g, ' ');

  const handleToggle = useCallback(async () => {
    setBusy(true);
    try {
      await toggleLight(entity.entity_id);
      toast({ title: `${name} turned ${isOn ? 'off' : 'on'}` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }, [entity.entity_id, name, isOn, toast, onRefresh]);

  const handleBrightness = useCallback(async (vals: number[]) => {
    setLocalBrightness(null);
    setBusy(true);
    try {
      await turnLightOn(entity.entity_id, Math.round(vals[0] * 2.55));
      toast({ title: `${name} → ${vals[0]}%` });
      setTimeout(() => onRefresh(true), 800);
    } catch (e: unknown) {
      toast({ title: 'Error', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }, [entity.entity_id, name, toast, onRefresh]);

  const displayBrightness = localBrightness ?? brightness;

  return (
    <div className={`flex items-center gap-2 py-2 ${isUnavailable ? 'opacity-40' : ''}`}>
      <Lightbulb
        className={`h-4 w-4 shrink-0 transition-colors ${isOn ? 'text-green-400' : 'text-muted-foreground'}`}
        fill={isOn ? 'currentColor' : 'none'}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium truncate">{name}</span>
        {isOn && effect && (
          <span className="text-[10px] text-muted-foreground truncate">Scene: {effect}</span>
        )}
      </div>
      {busy && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
      {isOn && <ColorDot entity={entity} />}
      {isOn && hasBrightness && (
        <span className="text-xs text-muted-foreground shrink-0">{displayBrightness}%</span>
      )}
      {isOn && hasBrightness && (
        <Slider
          className="w-20 shrink-0"
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
        disabled={busy || isUnavailable}
      />
    </div>
  );
}

/** Returns true if this entity is the Tiger Den LED strip (Govee) */
function isTigerDenLedEntity(entity: HAEntity): boolean {
  const id = entity.entity_id.toLowerCase();
  const name = (entity.attributes?.friendly_name as string || '').toLowerCase();
  const isTigerDen =
    id.includes('tiger_den') || id.includes('tigerden') ||
    name.includes('tiger den') || name.includes('tigerden') || name.includes('tiger_den');
  const notSegment = !id.includes('segment') && !name.includes('segment');
  return isTigerDen && notSegment && id.startsWith('light.');
}

export function HAGoveeLightsCard() {
  const [search, setSearch] = useState('');
  const { entities: allLights, loading, unavailable, refetch } = useSharedHAEntities('light');
  const { entities: allSwitches } = useSharedHAEntities('switch');
  const goveeEntityIds = useGoveeEntityIds();

  // Govee parent devices only (no segments)
  const goveeDevices = useMemo(() => {
    const goveeLights = allLights.filter(e => {
      // Use definitive set from HA integration_entities if available
      if (goveeEntityIds.size > 0) return goveeEntityIds.has(e.entity_id);
      // Fallback to name matching
      return isGoveeEntityByName(e);
    });
    // Filter out segment sub-entities — only show parent device lights
    return goveeLights.filter(e => !isSegmentEntity(e));
  }, [allLights, goveeEntityIds]);

  // Detect Tiger Den LED strip unavailability (light.* entity is unavailable)
  // so the UI can surface a clear "using switch fallback" indicator.
  const tigerDenLedStatus = useMemo(() => {
    const lightEntity = allLights.find(isTigerDenLedEntity);
    if (!lightEntity) return null;
    if (lightEntity.state !== 'unavailable' && lightEntity.state !== 'unknown') return null;
    // Check if a switch.* fallback is available and healthy
    const switchId = lightEntity.entity_id.replace(/^light\./, 'switch.');
    const switchEntity = allSwitches.find(e => e.entity_id === switchId);
    const hasFallback = !!switchEntity && switchEntity.state !== 'unavailable' && switchEntity.state !== 'unknown';
    return { lightId: lightEntity.entity_id, switchId, hasFallback };
  }, [allLights, allSwitches]);

  const { onCount } = useMemo(() => {
    let on = 0;
    for (const e of goveeDevices) {
      if (e.state === 'on') on++;
    }
    return { onCount: on };
  }, [goveeDevices]);

  const filtered = useMemo(() => {
    if (!search.trim()) return goveeDevices;
    const q = search.toLowerCase();
    return goveeDevices.filter(e => {
      const name = (e.attributes?.friendly_name as string || e.entity_id).toLowerCase();
      return name.includes(q) || e.entity_id.toLowerCase().includes(q);
    });
  }, [search, goveeDevices]);

  const handleAllOff = useCallback(async () => {
    const onLights = goveeDevices.filter(e => e.state === 'on');
    await Promise.all(onLights.map(e => turnLightOff(e.entity_id)));
    setTimeout(() => refetch(true), 1000);
  }, [goveeDevices, refetch]);

  return (
    <SystemCard
      title="Govee Lights"
      icon={<Lightbulb className="h-6 w-6 text-green-400" />}
      status={unavailable ? 'idle' : loading ? 'idle' : goveeDevices.length > 0 ? 'online' : 'warning'}
      statusText={
        unavailable
          ? 'Not connected'
          : loading
            ? 'Loading...'
            : goveeDevices.length === 0
              ? 'No Govee devices found'
              : `${onCount} on · ${goveeDevices.length} devices`
      }
      accentColor="bg-green-500/10"
      metrics={[
        { label: 'On Now', value: unavailable ? '—' : loading ? '...' : String(onCount) },
        { label: 'Devices', value: unavailable ? '—' : loading ? '...' : String(goveeDevices.length) },
      ]}
    >
      {/* Tiger Den LED strip unavailability banner */}
      {!unavailable && !loading && tigerDenLedStatus && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 mb-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="font-medium">Govee strip unavailable</span>
            {tigerDenLedStatus.hasFallback
              ? ' — using switch fallback. Garage sync still works.'
              : ' — no switch fallback found. Garage sync may not work for Tiger Den.'}
          </span>
        </div>
      )}

      {/* All Off button */}
      {onCount > 0 && (
        <div className="flex justify-end mb-3">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={handleAllOff}>
            <Power className="h-3 w-3" /> All Off
          </Button>
        </div>
      )}

      {/* Search */}
      {goveeDevices.length > 3 && (
        <div className="relative mb-4">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter Govee lights..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      )}

      {unavailable ? (
        <p className="text-sm text-muted-foreground text-center py-4">Home Assistant is not connected</p>
      ) : loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : goveeDevices.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">
          No Govee light devices found in Home Assistant.
          Make sure the Govee integration is configured.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map(entity => (
            <DeviceRow
              key={entity.entity_id}
              entity={entity}
              onRefresh={refetch}
            />
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No lights match "{search}"
            </p>
          )}
        </div>
      )}
    </SystemCard>
  );
}
