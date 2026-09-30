import { useState, useCallback, useMemo } from 'react';
import { Thermometer, ChevronUp, ChevronDown, Loader2, Flame, Snowflake, Zap } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { setClimateTemp, setClimateMode, HAEntity } from '@/lib/api/homeAssistant';
import { useHAEntities } from '@/hooks/useHAEntities';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  AV_CLOSET_WARN_TEMP,
  AV_CLOSET_CRITICAL_TEMP,
  AV_CLOSET_PLACEHOLDER_TITLE,
  AV_CLOSET_PLACEHOLDER_DETAIL,
  AV_CLOSET_THRESHOLD_NOTE,
} from '@shared/avCloset';
import { useAvClosetReading } from '@/hooks/useAvClosetReading';

type HvacMode = 'heat' | 'cool' | 'heat_cool' | 'auto' | 'off';

const HVAC_MODES: { value: HvacMode; label: string }[] = [
  { value: 'heat', label: 'Heat' },
  { value: 'cool', label: 'Cool' },
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
];

function getModeColor(mode: string): string {
  switch (mode) {
    case 'heat': return 'bg-red-500/15 text-red-400 border-red-500/30';
    case 'cool': return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
    case 'auto':
    case 'heat_cool': return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

function getModeIcon(mode: string) {
  switch (mode) {
    case 'heat': return <Flame className="h-3 w-3" />;
    case 'cool': return <Snowflake className="h-3 w-3" />;
    case 'auto':
    case 'heat_cool': return <Zap className="h-3 w-3" />;
    default: return null;
  }
}

function isRunning(entity: HAEntity): boolean {
  const action = entity.attributes?.hvac_action as string | undefined;
  return action === 'heating' || action === 'cooling';
}

function friendlyName(entity: HAEntity): string {
  return (entity.attributes?.friendly_name as string) || entity.entity_id.replace('climate.', '');
}

/** Collapse repeated prefix/suffix in friendly names */
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
  // Check trailing partial match (e.g. "Isla's Room Isla's")
  if (words.length >= 3) {
    const last = words[words.length - 1];
    if (words[0].startsWith(last) || last.startsWith(words[0])) {
      return words.slice(0, -1).join(' ');
    }
  }
  return name;
}

function smartTitleCase(s: string): string {
  return s
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .replace(/'(\w)/g, (_, c) => `'${c.toLowerCase()}`);
}

// ── thermostat row ───────────────────────────────────────────────────
function ThermostatRow({ entity, onRefresh }: { entity: HAEntity; onRefresh: () => void }) {
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [localTemp, setLocalTemp] = useState<number | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const name = deduplicateName(smartTitleCase(friendlyName(entity)));
  const currentTemp = entity.attributes?.current_temperature as number | undefined;
  const targetTemp = entity.attributes?.temperature as number | undefined;
  const mode = (entity.state || 'off') as HvacMode;
  const running = isRunning(entity);

  // Optimistic display — prefer local state while API call is in-flight
  const displayTarget = localTemp ?? targetTemp;

  const formatClimateError = (e: unknown): string => {
    const err = e as { status?: number | string; message?: string } | null;
    const status = err?.status;
    const msg = err?.message || 'Unknown error';
    return status ? `${status}: ${msg}` : msg;
  };

  const commitTemp = useCallback(async (newTemp: number) => {
    if (newTemp < 50 || newTemp > 95) return;
    setLocalTemp(newTemp);
    setSending(true);
    try {
      await setClimateTemp(entity.entity_id, newTemp);
      toast({ title: `${name} → ${newTemp}°F` });
      setTimeout(() => { onRefresh(); setLocalTemp(undefined); }, 1500);
    } catch (e) {
      setLocalTemp(undefined);
      toast({ title: `${name} error`, description: formatClimateError(e), variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [entity.entity_id, name, toast, onRefresh]);

  const handleTempChange = useCallback((delta: number) => {
    const base = localTemp ?? targetTemp;
    if (base == null) return;
    commitTemp(base + delta);
  }, [localTemp, targetTemp, commitTemp]);

  const handleEditStart = () => {
    if (displayTarget == null) return;
    setEditValue(String(Math.round(displayTarget)));
    setEditing(true);
  };

  const handleEditCommit = (val: string) => {
    setEditing(false);
    const parsed = parseInt(val, 10);
    if (isNaN(parsed)) return;
    commitTemp(parsed);
  };

  const handleModeChange = useCallback(async (newMode: HvacMode) => {
    const haMode = newMode === 'auto' ? 'heat_cool' : newMode;
    setSending(true);
    try {
      await setClimateMode(entity.entity_id, haMode);
      toast({ title: `${name} → ${newMode}` });
      setTimeout(onRefresh, 800);
    } catch (e) {
      toast({ title: `${name} error`, description: formatClimateError(e), variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [entity.entity_id, name, toast, onRefresh]);

  return (
    <div className="py-3 space-y-2">
      {/* Top line: name + mode badge + running indicator */}
      <div className="flex items-center gap-2">
        <Thermometer className={cn("h-4 w-4 shrink-0", running ? 'text-orange-400 animate-pulse' : 'text-muted-foreground')} />
        <span className="text-sm font-semibold truncate flex-1">{name}</span>
        {sending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
        {running && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-orange-500/30 text-orange-400 animate-pulse">
            {(entity.attributes?.hvac_action as string) === 'heating' ? 'Heating' : 'Cooling'}
          </Badge>
        )}
        <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 capitalize", getModeColor(mode))}>
          {getModeIcon(mode)}
          <span className="ml-1">{mode === 'heat_cool' ? 'Auto' : mode}</span>
        </Badge>
      </div>

      {/* Temps + controls */}
      <div className="flex items-center gap-3 ml-6">
        {/* Current temp */}
        {currentTemp != null && (
          <div className="text-center">
            <p className="text-lg font-bold tabular-nums">{Math.round(currentTemp)}°</p>
            <p className="text-[10px] text-muted-foreground">Current</p>
          </div>
        )}

        {/* Target temp with +/- and click-to-type */}
        {displayTarget != null && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 md:h-7 md:w-7"
              disabled={sending || displayTarget <= 50}
              onClick={() => handleTempChange(-1)}
            >
              <ChevronDown className="h-5 w-5 md:h-4 md:w-4" />
            </Button>
            <div className="text-center min-w-[2.5rem]">
              {editing ? (
                <input
                  autoFocus
                  type="number"
                  min={50}
                  max={95}
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onBlur={e => handleEditCommit(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleEditCommit(editValue);
                    if (e.key === 'Escape') setEditing(false);
                  }}
                  className="w-12 text-center text-lg font-bold tabular-nums text-primary bg-transparent border-b border-primary outline-none"
                />
              ) : (
                <button
                  className="text-lg font-bold tabular-nums text-primary hover:underline cursor-text focus:outline-none"
                  onClick={handleEditStart}
                  title="Click to type a temperature"
                >
                  {Math.round(displayTarget)}°
                </button>
              )}
              <p className="text-[10px] text-muted-foreground">Target</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-10 w-10 md:h-7 md:w-7"
              disabled={sending || displayTarget >= 95}
              onClick={() => handleTempChange(1)}
            >
              <ChevronUp className="h-5 w-5 md:h-4 md:w-4" />
            </Button>
          </div>
        )}

        {/* Mode buttons */}
        <div className="flex gap-1 ml-auto">
          {HVAC_MODES.map(m => (
            <button
              key={m.value}
              onClick={() => handleModeChange(m.value)}
              disabled={sending}
              className={cn(
                "text-[10px] px-2 py-1 rounded-md border transition-all font-medium",
                mode === m.value || (mode === 'heat_cool' && m.value === 'auto')
                  ? getModeColor(m.value) + ' ring-1 ring-offset-1 ring-offset-background'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted',
                sending && 'opacity-50 pointer-events-none'
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── AV Closet sensor row (read-only temp sensor, always shown) ───────────
function AvClosetRow() {
  // Value comes straight from Govee (HA double-converts and reports ~155°F).
  const { data: reading } = useAvClosetReading();
  const temp = reading?.tempF != null && Number.isFinite(reading.tempF) ? reading.tempF : NaN;
  const humidity = reading?.humidity != null && Number.isFinite(reading.humidity) ? reading.humidity : NaN;
  const hasHumidity = Number.isFinite(humidity);
  // Treat a Govee-reported offline device (dead battery / lost link) as no reading.
  const isOffline = reading?.online === false;
  const hasReading = Number.isFinite(temp) && !isOffline;
  const unit = '°F';
  const isCritical = hasReading && temp >= AV_CLOSET_CRITICAL_TEMP;
  const isWarn = hasReading && temp >= AV_CLOSET_WARN_TEMP;
  const tempColor = isCritical ? 'text-destructive' : isWarn ? 'text-orange-400' : 'text-blue-400';

  return (
    <div className="py-3 space-y-1" data-testid="row-av-closet">
      <div className="flex items-center gap-2">
        <Thermometer className={cn('h-4 w-4 shrink-0', hasReading ? tempColor : 'text-muted-foreground')} />
        <span className="text-sm font-semibold truncate flex-1">AV Closet</span>
        <Badge
          variant="outline"
          className={cn(
            'text-[10px] px-1.5 py-0',
            hasReading
              ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10'
              : 'border-border text-muted-foreground'
          )}
          data-testid="badge-av-closet-status"
        >
          {hasReading ? 'Live' : 'Offline'}
        </Badge>
      </div>
      {hasReading ? (
        <div className="ml-6 flex items-baseline gap-3">
          <p className={cn('text-lg font-bold tabular-nums', tempColor)} data-testid="text-av-closet-temp">
            {Math.round(temp)}{unit}
          </p>
          {hasHumidity && (
            <p className="text-lg font-bold tabular-nums text-cyan-400" data-testid="text-av-closet-humidity">
              {Math.round(humidity)}%
            </p>
          )}
          <span className="text-[10px] text-muted-foreground">
            {isCritical ? 'Critical' : isWarn ? 'High' : 'Sensor only · ' + AV_CLOSET_THRESHOLD_NOTE}
          </span>
        </div>
      ) : (
        <div className="ml-6 space-y-0.5">
          <p className="text-xs font-medium" data-testid="text-av-closet-placeholder">{AV_CLOSET_PLACEHOLDER_TITLE}</p>
          <p className="text-[10px] text-muted-foreground">{AV_CLOSET_PLACEHOLDER_DETAIL}</p>
          <p className="text-[10px] text-muted-foreground">{AV_CLOSET_THRESHOLD_NOTE}</p>
        </div>
      )}
    </div>
  );
}

// ── main card ────────────────────────────────────────────────────────
export function CrestronThermostatsCard() {
  const { entities, loading, refetch } = useHAEntities('climate');

  // Filter out pool/spa climate entities — those are not HVAC thermostats
  const hvacEntities = useMemo(
    () => entities.filter(e => !/pool|spa/i.test(e.entity_id)),
    [entities]
  );

  const activeCount = useMemo(
    () => hvacEntities.filter(e => e.state !== 'off' && e.state !== 'unavailable').length,
    [hvacEntities]
  );

  return (
    <SystemCard
      title="Climate & Thermostats"
      icon={<Thermometer className="h-6 w-6 text-blue-400" />}
      status={loading ? 'idle' : hvacEntities.length === 0 ? 'idle' : 'online'}
      statusText={loading ? 'Loading…' : hvacEntities.length === 0 ? 'No climate zones' : `${activeCount} active · ${hvacEntities.length} zones`}
      accentColor="bg-blue-500/10"
      defaultExpanded={true}
      metrics={[
        { label: 'Active', value: loading ? '…' : String(activeCount) },
        { label: 'Zones', value: loading ? '…' : String(hvacEntities.length) },
      ]}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="divide-y divide-border">
          {hvacEntities.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
              <div className="rounded-full bg-blue-500/10 p-3">
                <Thermometer className="h-6 w-6 text-blue-400" />
              </div>
              <div>
                <p className="text-sm font-semibold">No Climate Zones Found</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  No thermostat entities were detected. Pair your Ecobee, Nest, Honeywell, or other climate integrations in Home Assistant to manage climate zones here.
                </p>
              </div>
            </div>
          ) : (
            hvacEntities
              .sort((a, b) => friendlyName(a).localeCompare(friendlyName(b)))
              .map(entity => (
                <ThermostatRow key={entity.entity_id} entity={entity} onRefresh={refetch} />
              ))
          )}
          {/* AV Closet temperature sensor — value pulled directly from Govee */}
          <AvClosetRow />
        </div>
      )}
    </SystemCard>
  );
}
