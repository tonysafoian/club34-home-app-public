import { useState, useCallback, useMemo } from 'react';
import { Thermometer, ChevronUp, ChevronDown, Loader2, Flame, CalendarClock } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { setClimateTemp, setClimateMode, HAEntity } from '@/lib/api/homeAssistant';
import { useHAEntities } from '@/hooks/useHAEntities';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

// Exact entity IDs confirmed from Home Assistant Watts Home integration
const WATTS_ENTITY_IDS = [
  'climate.floors',
  'climate.tonys_bench',
  'climate.lanas_bench',
];

const DISPLAY_NAMES: Record<string, string> = {
  'climate.floors':      'Floors',
  'climate.tonys_bench': "Tony's Bench",
  'climate.lanas_bench': "Lana's Bench",
};

type HvacMode = 'heat' | 'off';

function getModeColor(mode: string): string {
  switch (mode) {
    case 'heat': return 'bg-orange-500/15 text-orange-400 border-orange-500/30';
    default:     return 'bg-muted text-muted-foreground border-border';
  }
}

function friendlyName(entity: HAEntity): string {
  return DISPLAY_NAMES[entity.entity_id]
    || (entity.attributes?.friendly_name as string)
    || entity.entity_id.replace('climate.', '');
}

// ── Graphical 24-hour schedule bar ───────────────────────────────────
// Tekmar SunstatGen4 exposes schedule setpoints via attributes.
// We build a visual timeline using whatever period data is available,
// falling back to a representative "typical radiant floor" pattern.
interface SchedulePeriod {
  startHour: number; // 0-23
  endHour: number;   // 0-23 (exclusive)
  temp: number;
  label: string;
  color: string;
}

function buildSchedule(entity: HAEntity): SchedulePeriod[] {
  const attrs = entity.attributes as Record<string, number | undefined> | undefined;

  // Try to read Watts/Tekmar schedule attributes
  // Common attribute names from ha-watts-home integration
  const scheduleRaw: SchedulePeriod[] = [];

  // Tekmar typically exposes: morning_setpoint, day_setpoint, evening_setpoint, night_setpoint
  // and associated times. Try to read them.
  const morning = attrs?.morning_setpoint ?? attrs?.wake_setpoint;
  const day     = attrs?.day_setpoint     ?? attrs?.away_setpoint;
  const evening = attrs?.evening_setpoint ?? attrs?.home_setpoint;
  const night   = attrs?.night_setpoint   ?? attrs?.sleep_setpoint;

  const morningStart = attrs?.morning_start ?? attrs?.wake_time ?? 6;
  const dayStart     = attrs?.day_start     ?? attrs?.away_time ?? 8;
  const eveningStart = attrs?.evening_start ?? attrs?.home_time ?? 17;
  const nightStart   = attrs?.night_start   ?? attrs?.sleep_time ?? 22;

  if (morning != null || day != null || evening != null || night != null) {
    // Use real data from integration
    scheduleRaw.push(
      { startHour: nightStart,   endHour: morningStart, temp: night   ?? 65, label: 'Sleep',   color: 'bg-blue-500/60' },
      { startHour: morningStart, endHour: dayStart,     temp: morning ?? 72, label: 'Wake',    color: 'bg-orange-400/70' },
      { startHour: dayStart,     endHour: eveningStart, temp: day     ?? 65, label: 'Away',    color: 'bg-slate-500/60' },
      { startHour: eveningStart, endHour: nightStart,   temp: evening ?? 72, label: 'Home',    color: 'bg-orange-500/70' },
    );
    return scheduleRaw;
  }

  // Fallback: representative radiant-floor schedule (matches Tekmar defaults)
  return [
    { startHour: 0,  endHour: 6,  temp: 65, label: 'Sleep',   color: 'bg-blue-500/60' },
    { startHour: 6,  endHour: 8,  temp: 72, label: 'Wake',    color: 'bg-orange-400/70' },
    { startHour: 8,  endHour: 17, temp: 65, label: 'Away',    color: 'bg-slate-500/60' },
    { startHour: 17, endHour: 22, temp: 72, label: 'Home',    color: 'bg-orange-500/70' },
    { startHour: 22, endHour: 24, temp: 65, label: 'Sleep',   color: 'bg-blue-500/60' },
  ];
}

function ScheduleBar({ entity }: { entity: HAEntity }) {
  const now         = new Date();
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const schedule    = buildSchedule(entity);
  const TOTAL_HOURS = 24;

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <CalendarClock className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Schedule</span>
      </div>

      {/* Timeline bar */}
      <div className="relative h-5 rounded-md overflow-hidden flex">
        {schedule.map((period, i) => {
          const start = (period.startHour % 24) / TOTAL_HOURS * 100;
          const end   = (period.endHour   % 24) / TOTAL_HOURS * 100;
          const width = end > start ? end - start : (100 - start) + end; // handle midnight wrap
          return (
            <div
              key={i}
              className={cn('relative flex items-center justify-center group', period.color)}
              style={{ width: `${width}%` }}
              title={`${period.label}: ${period.temp}°F (${period.startHour}:00–${period.endHour}:00)`}
            >
              <span className="text-[9px] font-semibold text-white/80 truncate px-0.5 hidden group-hover:block">
                {period.temp}°
              </span>
            </div>
          );
        })}

        {/* Current time needle */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white/90 z-10"
          style={{ left: `${(currentHour / TOTAL_HOURS) * 100}%` }}
        />
      </div>

      {/* Hour labels: 12a, 6a, 12p, 6p, 12a */}
      <div className="flex justify-between px-0.5">
        {['12a', '6a', '12p', '6p', '12a'].map((label, i) => (
          <span key={i} className="text-[9px] text-muted-foreground/60">{label}</span>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {schedule.filter((p, i, arr) => arr.findIndex(x => x.label === p.label) === i).map((period, i) => (
          <div key={i} className="flex items-center gap-1">
            <div className={cn('w-2 h-2 rounded-sm', period.color)} />
            <span className="text-[9px] text-muted-foreground">{period.label} {period.temp}°</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Heater row ────────────────────────────────────────────────────────
function HeaterRow({ entity, onRefresh }: { entity: HAEntity; onRefresh: () => void }) {
  const { toast } = useToast();
  const [sending, setSending]     = useState(false);
  const [localTemp, setLocalTemp] = useState<number | undefined>(undefined);
  const [editing, setEditing]     = useState(false);
  const [editValue, setEditValue] = useState('');

  const name          = friendlyName(entity);
  const currentTemp   = entity.attributes?.current_temperature as number | undefined;
  const targetTemp    = entity.attributes?.temperature as number | undefined;
  const mode          = (entity.state || 'off') as HvacMode;
  // hvac_action reflects ACTUAL hardware state: 'heating' | 'idle' | 'off'
  const hvacAction    = (entity.attributes?.hvac_action as string) || 'idle';
  const isActiveHeat  = hvacAction === 'heating';
  const displayTarget = localTemp ?? targetTemp;

  const formatErr = (e: unknown) => {
    const err = e as { status?: number; message?: string } | null | undefined;
    const status = err?.status;
    const msg    = err?.message || 'Unknown error';
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
    } catch (e: unknown) {
      setLocalTemp(undefined);
      toast({ title: `${name} error`, description: formatErr(e), variant: 'destructive' });
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
    setSending(true);
    try {
      await setClimateMode(entity.entity_id, newMode);
      toast({ title: `${name} → ${newMode}` });
      setTimeout(onRefresh, 800);
    } catch (e: unknown) {
      toast({ title: `${name} error`, description: formatErr(e), variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [entity.entity_id, name, toast, onRefresh]);

  return (
    <div className="py-3 space-y-2">
      {/* Row 1: name + status badges */}
      <div className="flex items-center gap-2">
        <Flame className={cn('h-4 w-4 shrink-0', isActiveHeat ? 'text-orange-400 animate-pulse' : 'text-muted-foreground')} />
        <span className="text-sm font-semibold truncate flex-1">{name}</span>
        {sending && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />}
        {/* Only show Heating badge when hardware is ACTIVELY heating */}
        {isActiveHeat && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-orange-500/30 text-orange-400 animate-pulse">
            Heating
          </Badge>
        )}
        {/* Standby badge when mode=heat but not actively firing */}
        {mode === 'heat' && !isActiveHeat && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-yellow-500/30 text-yellow-500/80">
            Standby
          </Badge>
        )}
        <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 capitalize', getModeColor(mode))}>
          {mode === 'heat' ? 'Heat' : 'Off'}
        </Badge>
      </div>

      {/* Row 2: temp display + controls */}
      <div className="flex items-center gap-3 ml-6">
        {currentTemp != null && (
          <div className="text-center">
            <p className="text-lg font-bold tabular-nums">{Math.round(currentTemp)}°</p>
            <p className="text-[10px] text-muted-foreground">Current</p>
          </div>
        )}

        {displayTarget != null && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="icon"
              className="h-10 w-10 md:h-7 md:w-7"
              disabled={sending || displayTarget <= 50}
              onClick={() => handleTempChange(-1)}
            >
              <ChevronDown className="h-5 w-5 md:h-4 md:w-4" />
            </Button>
            <div className="text-center min-w-[2.5rem]">
              {editing ? (
                <input
                  autoFocus type="number" min={50} max={95}
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  onBlur={e  => handleEditCommit(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  handleEditCommit(editValue);
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
              variant="ghost" size="icon"
              className="h-10 w-10 md:h-7 md:w-7"
              disabled={sending || displayTarget >= 95}
              onClick={() => handleTempChange(1)}
            >
              <ChevronUp className="h-5 w-5 md:h-4 md:w-4" />
            </Button>
          </div>
        )}

        {/* Heat / Off toggle */}
        <div className="flex gap-1 ml-auto">
          {(['heat', 'off'] as HvacMode[]).map(m => (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              disabled={sending}
              className={cn(
                'text-[10px] px-2 py-1 rounded-md border transition-all font-medium',
                mode === m
                  ? getModeColor(m) + ' ring-1 ring-offset-1 ring-offset-background'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted',
                sending && 'opacity-50 pointer-events-none',
              )}
            >
              {m === 'heat' ? 'Heat' : 'Off'}
            </button>
          ))}
        </div>
      </div>

      {/* Row 3: 24-hour schedule bar */}
      <div className="ml-6">
        <ScheduleBar entity={entity} />
      </div>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────
export function WattsHeatersCard() {
  const { entities, loading, refetch } = useHAEntities('climate');

  const wattsEntities = useMemo(
    () => entities.filter(e => WATTS_ENTITY_IDS.includes(e.entity_id)),
    [entities],
  );

  // Count units actually firing (hvac_action=heating), not just in heat mode
  const activeCount = useMemo(
    () => wattsEntities.filter(e => e.attributes?.hvac_action === 'heating').length,
    [wattsEntities],
  );

  const heatModeCount = useMemo(
    () => wattsEntities.filter(e => e.state === 'heat').length,
    [wattsEntities],
  );

  return (
    <SystemCard
      title="Primary Bath Floors / Benches"
      icon={<Flame className="h-6 w-6 text-orange-400" />}
      status={loading ? 'idle' : wattsEntities.length === 0 ? 'idle' : 'online'}
      statusText={
        loading
          ? 'Loading…'
          : wattsEntities.length === 0
            ? 'No heaters found'
            : activeCount > 0
              ? `${activeCount} actively heating · ${wattsEntities.length} units`
              : `${heatModeCount} on standby · ${wattsEntities.length} units`
      }
      accentColor="bg-orange-500/10"
      defaultExpanded={true}
      metrics={[
        { label: 'Heating', value: loading ? '…' : String(activeCount) },
        { label: 'Standby', value: loading ? '…' : String(heatModeCount - activeCount) },
        { label: 'Units',   value: loading ? '…' : String(wattsEntities.length) },
      ]}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : wattsEntities.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
          <div className="rounded-full bg-orange-500/10 p-3">
            <Thermometer className="h-6 w-6 text-orange-400" />
          </div>
          <div>
            <p className="text-sm font-semibold">No Watts Heaters Found</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Ensure the Watts Home (Tekmar) integration is configured in Home Assistant.
            </p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {wattsEntities
            .sort((a, b) => friendlyName(a).localeCompare(friendlyName(b)))
            .map(entity => (
              <HeaterRow key={entity.entity_id} entity={entity} onRefresh={refetch} />
            ))}
        </div>
      )}
    </SystemCard>
  );
}
