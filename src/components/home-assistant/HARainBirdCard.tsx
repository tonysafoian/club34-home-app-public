import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useUserRole } from '@/hooks/useUserRole';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Droplets, Power, Loader2, CloudRain, Timer, Calendar,
  ChevronDown, ChevronUp, History, ChevronRight, Wifi, WifiOff,
} from 'lucide-react';
import { useHADomains } from '@/hooks/useHAEntities';
import { callService, haProxy, getEntityHistory, HAEntity } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';
import { CLOCK_DEFS, ValveDef, matchEntityToValve, ALL_VALVES, applyZoneNameOverrides, withZoneNameOverride } from '@/lib/irrigation/controllers';
import { useValveConfigs, estimateGallons } from '@/hooks/useValveConfigs';
import { IrrigationMap } from './IrrigationMap';
import { ValveDetailPanel } from './ValveDetailPanel';

/* ─────────────────────────────────────────
   Types
───────────────────────────────────────── */

interface ScheduleEvent {
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  summary: string;
  description?: string;
}

interface WateringSession {
  startTime: string;
  stopTime: string | null;
  durationMs: number | null;
}

/* ─────────────────────────────────────────
   Helpers — entity classification
───────────────────────────────────────── */

function isRainBirdZone(entity: HAEntity) {
  const id = entity.entity_id;
  return id.startsWith('switch.rain_bird') || id.startsWith('switch.rainbird');
}

function isRainSensor(entity: HAEntity) {
  const id = entity.entity_id;
  return id.startsWith('binary_sensor.rain_bird') || id.startsWith('binary_sensor.rainbird');
}

function isRainDelay(entity: HAEntity) {
  const id = entity.entity_id;
  return id.startsWith('number.rain_bird') || id.startsWith('number.rainbird');
}

function isRainBirdCalendar(entity: HAEntity) {
  const id = entity.entity_id;
  return id.startsWith('calendar.rain_bird') || id.startsWith('calendar.rainbird');
}

function friendlyZoneName(entity: HAEntity): string {
  if (entity.attributes?.friendly_name) return entity.attributes.friendly_name as string;
  return entity.entity_id
    .replace(/^switch\.(rain_?bird_?)?(sprinkler_?)?/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/* ─────────────────────────────────────────
   Helpers — date / time formatting
───────────────────────────────────────── */

function resolveDateTime(dt: { dateTime?: string; date?: string }): string {
  return dt.dateTime ?? dt.date ?? '';
}

function formatEventTime(dt: string): string {
  return new Date(dt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatEventDate(dt: string): string {
  const d = new Date(dt);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function durationMinutes(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}min`;
}

function formatSessionDate(dt: string): string {
  const d = new Date(dt);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function parseWateringSessions(
  entityHistory: Array<{ state: string; last_changed: string }>,
  currentState: string
): WateringSession[] {
  const sessions: WateringSession[] = [];
  let onTime: string | null = null;
  for (const entry of entityHistory) {
    if (entry.state === 'on' && onTime === null) {
      onTime = entry.last_changed;
    } else if (entry.state === 'off' && onTime !== null) {
      sessions.push({
        startTime: onTime,
        stopTime: entry.last_changed,
        durationMs: new Date(entry.last_changed).getTime() - new Date(onTime).getTime(),
      });
      onTime = null;
    }
  }
  if (onTime !== null && currentState === 'on') {
    sessions.push({ startTime: onTime, stopTime: null, durationMs: null });
  }
  return sessions.reverse();
}

/* ─────────────────────────────────────────
   StatusDot — connectivity indicator
───────────────────────────────────────── */

function StatusDot({ state }: { state: 'on' | 'off' | 'unavailable' | 'disconnected' }) {
  if (state === 'on') {
    return (
      <span className="relative flex h-2.5 w-2.5 flex-shrink-0" title="Running">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
      </span>
    );
  }
  if (state === 'off') {
    return <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 flex-shrink-0" title="Online" />;
  }
  if (state === 'unavailable') {
    return <span className="h-2.5 w-2.5 rounded-full bg-amber-500 flex-shrink-0" title="Unavailable" />;
  }
  // disconnected / no entity
  return <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground/30 flex-shrink-0" title="Not connected" />;
}

/* ─────────────────────────────────────────
   Sub-components — zone row (connected)
───────────────────────────────────────── */

function ZoneRow({
  entity,
  valve,
  isSelected,
  onRefresh,
  onSelect,
}: {
  entity: HAEntity;
  valve: ValveDef | undefined;
  isSelected: boolean;
  onRefresh: () => void;
  onSelect?: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const isOn = entity.state === 'on';

  const handleToggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await callService('switch', isOn ? 'turn_off' : 'turn_on', { entity_id: entity.entity_id });
      setTimeout(onRefresh, 800);
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
        onSelect ? 'cursor-pointer' : ''
      } ${
        isSelected
          ? 'border-primary bg-primary/10'
          : isOn
          ? 'border-blue-500/40 bg-blue-500/5'
          : 'border-border bg-muted/20 hover:bg-muted/40'
      }`}
      onClick={onSelect}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={onSelect ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }}) : undefined}
      data-testid={`zone-row-${entity.entity_id}`}
    >
      <StatusDot state={entity.state === 'on' ? 'on' : entity.state === 'unavailable' ? 'unavailable' : 'off'} />
      <Droplets className={`h-4 w-4 flex-shrink-0 ${isOn ? 'text-blue-400' : entity.state === 'unavailable' ? 'text-amber-500/50' : 'text-muted-foreground'}`} />
      <span className={`text-sm flex-1 truncate ${entity.state === 'unavailable' ? 'text-muted-foreground/60' : ''}`}>
        {valve ? valve.label : friendlyZoneName(entity)}
      </span>
      {valve && (
        <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground/70 flex-shrink-0">
          C{valve.clockId}·V{valve.valveNumber}
        </span>
      )}
      {isOn && <span className="text-xs text-blue-400 font-medium">Running</span>}
      {entity.state === 'unavailable' && <span className="text-xs text-amber-500 font-medium">Offline</span>}
      <Button
        variant={isOn ? 'default' : 'outline'}
        size="sm"
        className="h-7 px-2"
        onClick={handleToggle}
        disabled={busy}
        data-testid={`button-toggle-${entity.entity_id}`}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
      </Button>
    </div>
  );
}

function PlaceholderValveRow({
  valve,
  isSelected,
  onSelect,
}: {
  valve: ValveDef;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 opacity-50 cursor-pointer transition-colors ${
        isSelected ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/10 hover:opacity-70'
      }`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }}}
      data-testid={`zone-row-placeholder-${valve.svgId}`}
    >
      <StatusDot state="disconnected" />
      <span className="text-sm flex-1 truncate text-muted-foreground">{valve.label}</span>
      <span className="text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded bg-muted/30 text-muted-foreground/50 flex-shrink-0">
        C{valve.clockId}·V{valve.valveNumber}
      </span>
      <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-muted-foreground">Not connected</Badge>
    </div>
  );
}

/* ─────────────────────────────────────────
   Clock group (collapsible)
───────────────────────────────────────── */

const CLOCK_COLORS: Record<number, string> = {
  1: 'text-green-400',
  2: 'text-cyan-400',
  3: 'text-amber-400',
};

function ClockGroup({
  clockId,
  clockName,
  valves,
  entityByValve,
  selectedValve,
  onSelectValve,
  onRefresh,
}: {
  clockId: number;
  clockName: string;
  valves: ValveDef[];
  entityByValve: Map<string, HAEntity>;
  selectedValve: ValveDef | null;
  onSelectValve: (v: ValveDef | null) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(true);
  const connectedCount = valves.filter(v => entityByValve.has(v.svgId)).length;
  const runningCount = valves.filter(v => entityByValve.get(v.svgId)?.state === 'on').length;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
        data-testid={`button-clock-group-${clockId}`}
      >
        <Droplets className={`h-4 w-4 ${CLOCK_COLORS[clockId]}`} />
        <span className="text-sm font-semibold flex-1">{clockName}</span>
        <div className="flex items-center gap-1.5">
          {runningCount > 0 && (
            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px] h-4 px-1.5">
              {runningCount} running
            </Badge>
          )}
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            {connectedCount}/{valves.length}
          </Badge>
          {open ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </div>
      </button>
      {open && (
        <div className="space-y-1.5 p-2">
          {valves.map(valve => {
            const entity = entityByValve.get(valve.svgId);
            const isSelected = selectedValve?.svgId === valve.svgId;
            if (entity) {
              return (
                <ZoneRow
                  key={valve.svgId}
                  entity={entity}
                  valve={valve}
                  isSelected={isSelected}
                  onRefresh={onRefresh}
                  onSelect={() => onSelectValve(isSelected ? null : valve)}
                />
              );
            }
            return (
              <PlaceholderValveRow
                key={valve.svgId}
                valve={valve}
                isSelected={isSelected}
                onSelect={() => onSelectValve(isSelected ? null : valve)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────
   Schedule section
───────────────────────────────────────── */

function ScheduleSection({ calendarEntities }: { calendarEntities: HAEntity[] }) {
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const fetchSchedule = useCallback(async () => {
    const cals = calendarEntities;
    if (cals.length === 0) { setLoading(false); return; }
    try {
      const now = new Date();
      const start = now.toISOString();
      const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const allEvents: ScheduleEvent[] = [];
      for (const cal of cals) {
        try {
          const url = `/api/calendars/${cal.entity_id}?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
          const data = await haProxy(url);
          if (Array.isArray(data)) allEvents.push(...data);
        } catch {
          // ignore per-calendar errors; continue with others
        }
      }
      if (allEvents.length === 0) {
        for (const cal of cals) {
          const attrs = cal.attributes;
          const startTime = attrs?.start_time as string | undefined;
          const endTime = attrs?.end_time as string | undefined;
          const summary = (attrs?.message as string) || (attrs?.friendly_name as string) || cal.state;
          if (startTime) allEvents.push({ start: { dateTime: startTime }, end: { dateTime: endTime || startTime }, summary: summary || 'Scheduled' });
        }
      }
      allEvents.sort((a, b) => new Date(resolveDateTime(a.start)).getTime() - new Date(resolveDateTime(b.start)).getTime());
      setEvents(allEvents);
    } catch {
      // ignore overall schedule fetch errors
    } finally {
      setLoading(false);
    }
  }, [calendarEntities]);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  if (loading) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
      <Loader2 className="h-3 w-3 animate-spin" />Loading schedule…
    </div>
  );

  if (events.length === 0) {
    const calState = calendarEntities.find(c => c.state && c.state !== 'unavailable' && c.state !== 'unknown');
    if (calState) return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Calendar className="h-3 w-3" />{(calState.attributes?.friendly_name as string) || calState.entity_id}: {calState.state}
      </div>
    );
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <Calendar className="h-3 w-3" />No upcoming irrigation scheduled
      </div>
    );
  }

  const visibleEvents = expanded ? events : events.slice(0, 3);
  const grouped: Record<string, ScheduleEvent[]> = {};
  for (const evt of visibleEvents) {
    const dk = formatEventDate(resolveDateTime(evt.start));
    if (!grouped[dk]) grouped[dk] = [];
    grouped[dk].push(evt);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Calendar className="h-3 w-3" />Upcoming Schedule
      </div>
      {Object.entries(grouped).map(([date, dayEvents]) => (
        <div key={date}>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{date}</p>
          <div className="space-y-1">
            {dayEvents.map((evt, i) => (
              <div key={i} className="flex items-center gap-2 rounded border border-border bg-muted/10 px-2.5 py-1.5 text-xs">
                <span className="text-muted-foreground w-14 flex-shrink-0">
                  {evt.start.dateTime ? formatEventTime(evt.start.dateTime) : 'All day'}
                </span>
                <span className="flex-1 truncate">{evt.summary}</span>
                {evt.start.dateTime && evt.end.dateTime && (
                  <span className="text-muted-foreground flex-shrink-0">{durationMinutes(evt.start.dateTime, evt.end.dateTime)}min</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {events.length > 3 && (
        <Button variant="ghost" size="sm" className="w-full h-6 text-xs text-muted-foreground"
          onClick={() => setExpanded(!expanded)} data-testid="button-schedule-expand">
          {expanded ? <><ChevronUp className="h-3 w-3 mr-1"/>Show less</> : <><ChevronDown className="h-3 w-3 mr-1"/>{events.length - 3} more</>}
        </Button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────
   Activity log section
───────────────────────────────────────── */

/** Compact gallons figure for table cells: 1 decimal below 10, whole above. */
function formatGallonsValue(gallons: number): string {
  return gallons >= 10 ? String(Math.round(gallons)) : gallons.toFixed(1);
}

interface ZoneActivityLog { entityId: string; zoneName: string; sessions: WateringSession[]; }

function ActivityLogSection({ zones, gpmForEntity }: { zones: HAEntity[]; gpmForEntity: (entityId: string) => number | null }) {
  const [logs, setLogs] = useState<ZoneActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const LOOKBACK_HOURS = 72;

  const fetchHistory = useCallback(async () => {
    const zoneList = zones;
    if (zoneList.length === 0) { setLoading(false); return; }
    setLoading(true); setFetchError(false);
    try {
      const entityIds = zoneList.map(z => z.entity_id).join(',');
      const rawHistory = await getEntityHistory(entityIds, LOOKBACK_HOURS);
      const result: ZoneActivityLog[] = [];
      if (Array.isArray(rawHistory)) {
        for (const entityHistory of rawHistory) {
          if (!Array.isArray(entityHistory) || entityHistory.length === 0) continue;
          const entityId = entityHistory[0]?.entity_id as string;
          if (!entityId) continue;
          const zone = zoneList.find(z => z.entity_id === entityId);
          if (!zone) continue;
          result.push({
            entityId,
            zoneName: friendlyZoneName(zone),
            sessions: parseWateringSessions(entityHistory as Array<{ state: string; last_changed: string }>, zone.state),
          });
        }
      }
      result.sort((a, b) => (b.sessions[0]?.startTime ?? '').localeCompare(a.sessions[0]?.startTime ?? ''));
      setLogs(result);
    } catch { setFetchError(true); } finally { setLoading(false); }
  }, [zones]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  if (loading) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
      <Loader2 className="h-3 w-3 animate-spin"/>Loading activity…
    </div>
  );

  if (fetchError) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="activity-error">
      <History className="h-3 w-3"/>Could not load activity history
    </div>
  );

  const allSessions: Array<WateringSession & { zoneName: string; entityId: string }> = [];
  for (const log of logs) {
    for (const s of log.sessions) {
      allSessions.push({ ...s, zoneName: log.zoneName, entityId: log.entityId });
    }
  }
  allSessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

  if (allSessions.length === 0) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
      <History className="h-3 w-3"/>No watering activity in the last {LOOKBACK_HOURS}h
    </div>
  );

  const INITIAL_SHOW = 5;
  const visibleSessions = expanded ? allSessions : allSessions.slice(0, INITIAL_SHOW);
  const grouped: Record<string, typeof visibleSessions> = {};
  for (const s of visibleSessions) {
    const dk = formatSessionDate(s.startTime);
    if (!grouped[dk]) grouped[dk] = [];
    grouped[dk].push(s);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <History className="h-3 w-3"/>Recent Activity<span className="text-[10px] text-muted-foreground/60">({LOOKBACK_HOURS}h)</span>
      </div>
      {Object.entries(grouped).map(([date, sessions]) => (
        <div key={date}>
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{date}</p>
          <div className="space-y-1">
            {sessions.map((s, i) => (
              <div key={`${s.entityId}-${s.startTime}-${i}`}
                className="flex items-center gap-2 rounded border border-border bg-muted/10 px-2.5 py-1.5 text-xs"
                data-testid={`activity-session-${s.entityId}-${i}`}
              >
                <Droplets className={`h-3 w-3 flex-shrink-0 ${s.stopTime === null ? 'text-blue-400' : 'text-muted-foreground'}`} />
                <span className="flex-1 truncate font-medium">{s.zoneName}</span>
                <span className="text-muted-foreground flex-shrink-0">{formatEventTime(s.startTime)}</span>
                <span className="text-muted-foreground/60 flex-shrink-0">→</span>
                {s.stopTime ? (
                  <span className="text-muted-foreground flex-shrink-0">{formatEventTime(s.stopTime)}</span>
                ) : (
                  <span className="text-blue-400 flex-shrink-0 font-medium">Running</span>
                )}
                {s.durationMs !== null ? (
                  <>
                    <Badge variant="secondary" className="text-[10px] h-4 px-1.5 flex-shrink-0">{formatDuration(s.durationMs)}</Badge>
                    {gpmForEntity(s.entityId) !== null && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] h-4 px-1.5 flex-shrink-0 bg-blue-500/15 text-blue-400"
                        data-testid={`activity-gallons-${s.entityId}-${i}`}
                      >
                        ≈{formatGallonsValue(estimateGallons(gpmForEntity(s.entityId) as number, s.durationMs))} gal
                      </Badge>
                    )}
                  </>
                ) : (
                  <Badge variant="secondary" className="text-[10px] h-4 px-1.5 flex-shrink-0 bg-blue-500/20 text-blue-400">
                    {formatDuration(Date.now() - new Date(s.startTime).getTime())}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {allSessions.length > INITIAL_SHOW && (
        <Button variant="ghost" size="sm" className="w-full h-6 text-xs text-muted-foreground"
          onClick={() => setExpanded(!expanded)} data-testid="button-activity-expand">
          {expanded ? <><ChevronUp className="h-3 w-3 mr-1"/>Show less</> : <><ChevronDown className="h-3 w-3 mr-1"/>{allSessions.length - INITIAL_SHOW} more</>}
        </Button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────
   Water usage summary — per-zone estimated gallons (today / last 7 days)
───────────────────────────────────────── */

interface ZoneGallonsRow {
  entityId: string;
  zoneName: string;
  todayGal: number;
  weekGal: number;
}

/** Minutes of [startMs, endMs) that fall inside [winStartMs, winEndMs). */
function overlapMinutes(startMs: number, endMs: number, winStartMs: number, winEndMs: number): number {
  const s = Math.max(startMs, winStartMs);
  const e = Math.min(endMs, winEndMs);
  return e > s ? (e - s) / 60000 : 0;
}

function WaterUsageSummarySection({
  zones,
  gpmForEntity,
}: {
  zones: HAEntity[];
  gpmForEntity: (entityId: string) => number | null;
}) {
  const [rows, setRows] = useState<ZoneGallonsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const LOOKBACK_HOURS = 168; // 7 days

  const fetchSummary = useCallback(async () => {
    const zoneList = zones;
    if (zoneList.length === 0) { setLoading(false); return; }
    setLoading(true); setFetchError(false);
    try {
      const entityIds = zoneList.map(z => z.entity_id).join(',');
      const rawHistory = await getEntityHistory(entityIds, LOOKBACK_HOURS);
      const now = Date.now();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayStartMs = todayStart.getTime();
      const weekStartMs = now - LOOKBACK_HOURS * 3600 * 1000;

      const result: ZoneGallonsRow[] = [];
      if (Array.isArray(rawHistory)) {
        for (const entityHistory of rawHistory) {
          if (!Array.isArray(entityHistory) || entityHistory.length === 0) continue;
          const entityId = entityHistory[0]?.entity_id as string;
          if (!entityId) continue;
          const zone = zoneList.find(z => z.entity_id === entityId);
          if (!zone) continue;
          const gpm = gpmForEntity(entityId);
          if (gpm === null) continue; // no flow config → can't estimate
          const sessions = parseWateringSessions(
            entityHistory as Array<{ state: string; last_changed: string }>,
            zone.state,
          );
          let todayMin = 0;
          let weekMin = 0;
          for (const s of sessions) {
            const startMs = new Date(s.startTime).getTime();
            const endMs = s.stopTime ? new Date(s.stopTime).getTime() : now;
            todayMin += overlapMinutes(startMs, endMs, todayStartMs, now);
            weekMin += overlapMinutes(startMs, endMs, weekStartMs, now);
          }
          if (weekMin <= 0) continue;
          result.push({
            entityId,
            zoneName: friendlyZoneName(zone),
            todayGal: +(gpm * todayMin).toFixed(1),
            weekGal: +(gpm * weekMin).toFixed(1),
          });
        }
      }
      result.sort((a, b) => b.weekGal - a.weekGal);
      setRows(result);
    } catch { setFetchError(true); } finally { setLoading(false); }
  }, [zones, gpmForEntity]);

  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  if (loading) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
      <Loader2 className="h-3 w-3 animate-spin"/>Loading water usage…
    </div>
  );

  if (fetchError) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="water-summary-error">
      <Droplets className="h-3 w-3"/>Could not load water usage
    </div>
  );

  if (rows.length === 0) return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="water-summary-empty">
      <Droplets className="h-3 w-3"/>No watering in the last 7 days
    </div>
  );

  const todayTotal = rows.reduce((sum, r) => sum + r.todayGal, 0);
  const weekTotal = rows.reduce((sum, r) => sum + r.weekGal, 0);
  const INITIAL_SHOW = 5;
  const visibleRows = expanded ? rows : rows.slice(0, INITIAL_SHOW);

  return (
    <div className="space-y-2" data-testid="water-usage-summary">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Droplets className="h-3 w-3"/>Water Usage
        <span className="text-[10px] text-muted-foreground/60">(estimated)</span>
        <span className="ml-auto flex items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5" data-testid="badge-water-today-total">
            Today ≈{formatGallonsValue(todayTotal)} gal
          </Badge>
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5" data-testid="badge-water-week-total">
            7d ≈{formatGallonsValue(weekTotal)} gal
          </Badge>
        </span>
      </div>
      <div className="space-y-1">
        <div className="flex items-center gap-2 px-2.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          <span className="flex-1">Zone</span>
          <span className="w-14 text-right">Today</span>
          <span className="w-14 text-right">7 days</span>
        </div>
        {visibleRows.map(r => (
          <div
            key={r.entityId}
            className="flex items-center gap-2 rounded border border-border bg-muted/10 px-2.5 py-1.5 text-xs"
            data-testid={`water-summary-row-${r.entityId}`}
          >
            <span className="flex-1 truncate font-medium">{r.zoneName}</span>
            <span className="w-14 text-right text-muted-foreground">
              {r.todayGal > 0 ? `${formatGallonsValue(r.todayGal)} gal` : '—'}
            </span>
            <span className="w-14 text-right text-muted-foreground">{formatGallonsValue(r.weekGal)} gal</span>
          </div>
        ))}
      </div>
      {rows.length > INITIAL_SHOW && (
        <Button variant="ghost" size="sm" className="w-full h-6 text-xs text-muted-foreground"
          onClick={() => setExpanded(!expanded)} data-testid="button-water-summary-expand">
          {expanded ? <><ChevronUp className="h-3 w-3 mr-1"/>Show less</> : <><ChevronDown className="h-3 w-3 mr-1"/>{rows.length - INITIAL_SHOW} more</>}
        </Button>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────
   Main card
───────────────────────────────────────── */

interface LabelPositionRow {
  svgId: string;
  x: number;
  y: number;
}

interface ZoneNameRow {
  svgId: string;
  name: string;
}

export function HARainBirdCard() {
  const { toast } = useToast();
  const { isAdmin } = useUserRole();
  const queryClient = useQueryClient();
  const { entitiesByDomain, loading, unavailable, refetch } = useHADomains(['switch', 'binary_sensor', 'number', 'calendar']);
  const [runningAll, setRunningAll] = useState(false);
  const [selectedValve, setSelectedValve] = useState<ValveDef | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [nextEvent, setNextEvent] = useState<{ summary: string; start: string } | null>(null);

  // Per-zone flow rates (GPM) for estimating gallons from run durations.
  const { gpmForEntity, gpmForSvgId } = useValveConfigs();

  // Admin-repositionable zone-label overrides. Read by everyone; written by admins.
  const { data: labelPositionsData } = useQuery({
    queryKey: ['/api/irrigation/label-positions'],
    queryFn: () => apiClient.get<{ positions: LabelPositionRow[] }>('/api/irrigation/label-positions'),
    staleTime: 5 * 60_000,
  });

  const savedPositions = useMemo(() => {
    const map: Record<string, [number, number]> = {};
    for (const row of labelPositionsData?.positions ?? []) {
      map[row.svgId] = [Number(row.x), Number(row.y)];
    }
    return map;
  }, [labelPositionsData]);

  const saveLabelPosition = useMutation({
    mutationFn: ({ svgId, x, y }: { svgId: string; x: number; y: number }) =>
      apiClient.request(`/api/irrigation/label-positions/${encodeURIComponent(svgId)}`, { method: 'PUT', body: { x, y } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/irrigation/label-positions'] }),
    onError: (err: unknown) =>
      toast({ title: 'Could not save label', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' }),
  });

  const resetLabelPosition = useMutation({
    mutationFn: (svgId: string) =>
      apiClient.del(`/api/irrigation/label-positions/${encodeURIComponent(svgId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/irrigation/label-positions'] }),
    onError: (err: unknown) =>
      toast({ title: 'Could not reset label', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' }),
  });

  // Admin-editable zone names (irrigation_zone_names). Read by everyone; written
  // by admins. CLOCK_DEFS labels act purely as fallbacks for unrenamed zones.
  const { data: zoneNamesData } = useQuery({
    queryKey: ['/api/irrigation/zone-names'],
    queryFn: () => apiClient.get<{ names: ZoneNameRow[] }>('/api/irrigation/zone-names'),
    staleTime: 5 * 60_000,
  });

  const zoneNameOverrides = useMemo(() => {
    const map: Record<string, string> = {};
    for (const row of zoneNamesData?.names ?? []) {
      if (row.name?.trim()) map[row.svgId] = row.name.trim();
    }
    return map;
  }, [zoneNamesData]);

  const clockDefs = useMemo(() => applyZoneNameOverrides(CLOCK_DEFS, zoneNameOverrides), [zoneNameOverrides]);

  const saveZoneName = useMutation({
    mutationFn: ({ svgId, name }: { svgId: string; name: string }) =>
      apiClient.request(`/api/irrigation/zone-names/${encodeURIComponent(svgId)}`, { method: 'PUT', body: { name } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/irrigation/zone-names'] }),
    onError: (err: unknown) =>
      toast({ title: 'Could not save name', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' }),
  });

  const resetZoneName = useMutation({
    mutationFn: (svgId: string) =>
      apiClient.del(`/api/irrigation/zone-names/${encodeURIComponent(svgId)}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/irrigation/zone-names'] }),
    onError: (err: unknown) =>
      toast({ title: 'Could not reset name', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' }),
  });

  const zones = useMemo(() => [...(entitiesByDomain['switch'] || [])].filter(isRainBirdZone), [entitiesByDomain]);
  const rainSensors = [...(entitiesByDomain['binary_sensor'] || [])].filter(isRainSensor);
  const rainDelays = [...(entitiesByDomain['number'] || [])].filter(isRainDelay);
  const calendars = useMemo(() => [...(entitiesByDomain['calendar'] || [])].filter(isRainBirdCalendar), [entitiesByDomain]);

  const rainDetected = rainSensors.some(s => s.state === 'on');
  const rainDelay = rainDelays.length > 0 ? rainDelays[0] : null;
  const rainDelayDays = rainDelay ? Number(rainDelay.state) : 0;

  // Fetch the next scheduled irrigation event for the ValveDetailPanel.
  // calendarKey (entity IDs joined) is the only dep so the effect doesn't reference the `calendars` array directly.
  const calendarKey = calendars.map(c => c.entity_id).join(',');
  useEffect(() => {
    if (!calendarKey) return;
    let cancelled = false;
    const calIds = calendarKey.split(',');
    (async () => {
      try {
        const now = new Date();
        const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const allEvents: ScheduleEvent[] = [];
        for (const entityId of calIds) {
          try {
            const url = `/api/calendars/${entityId}?start=${encodeURIComponent(now.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;
            const data = await haProxy(url);
            if (Array.isArray(data)) allEvents.push(...data);
          } catch {
            // ignore individual calendar errors
          }
        }
        allEvents.sort((a, b) => new Date(resolveDateTime(a.start)).getTime() - new Date(resolveDateTime(b.start)).getTime());
        if (!cancelled && allEvents.length > 0) {
          const first = allEvents[0];
          setNextEvent({ summary: first.summary, start: resolveDateTime(first.start) });
        }
      } catch {
        // ignore overall schedule fetch errors
      }
    })();
    return () => { cancelled = true; };
  }, [calendarKey]);

  // Build entity → valve mapping. If two entities claim the same valve, the second goes to unmatched.
  const entityByValve = new Map<string, HAEntity>();
  const valveByEntity = new Map<string, ValveDef>();
  const unmatchedZones: HAEntity[] = [];

  for (const entity of zones) {
    const valve = matchEntityToValve(entity.entity_id, entity.attributes?.friendly_name as string);
    if (valve && !entityByValve.has(valve.svgId)) {
      entityByValve.set(valve.svgId, entity);
      valveByEntity.set(entity.entity_id, valve);
    } else {
      unmatchedZones.push(entity);
    }
  }

  const totalValves = ALL_VALVES.length;
  const activeZones = zones.filter(z => z.state === 'on').length;

  // Resolve the selected entity
  const selectedEntity = selectedValve ? entityByValve.get(selectedValve.svgId) : undefined;

  const handleRunAll = async () => {
    if (zones.length === 0) return;
    setRunningAll(true);
    try {
      for (const zone of zones) {
        if (zone.state !== 'on') {
          await callService('switch', 'turn_on', { entity_id: zone.entity_id });
        }
      }
      toast({ title: 'Irrigation', description: `Started ${zones.length} zones` });
      setTimeout(() => refetch(), 1000);
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setRunningAll(false);
    }
  };

  const handleStopAll = async () => {
    setRunningAll(true);
    try {
      for (const zone of zones) {
        if (zone.state === 'on') {
          await callService('switch', 'turn_off', { entity_id: zone.entity_id });
        }
      }
      toast({ title: 'Irrigation', description: 'All zones stopped' });
      setTimeout(() => refetch(), 1000);
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setRunningAll(false);
    }
  };

  if (!loading && !unavailable && zones.length === 0 && rainSensors.length === 0 && calendars.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Droplets className="h-5 w-5 text-blue-500" />
            Irrigation
          </CardTitle>
          <div className="flex items-center gap-2">
            {unavailable ? (
              <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
            ) : (
              <>
                {rainDetected && (
                  <Badge variant="secondary" className="bg-blue-500/20 text-blue-400">
                    <CloudRain className="h-3 w-3 mr-1"/>Rain
                  </Badge>
                )}
                {rainDelayDays > 0 && (
                  <Badge variant="secondary" className="bg-amber-500/20 text-amber-400">
                    <Timer className="h-3 w-3 mr-1"/>{rainDelayDays}d delay
                  </Badge>
                )}
                <Badge variant="secondary" data-testid="badge-zones-active">
                  {activeZones}/{totalValves} on
                </Badge>
              </>
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
        ) : (
          <div className="space-y-4">
            {/* Schedule */}
            {calendars.length > 0 && <ScheduleSection calendarEntities={calendars} />}

            {/* Map toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Property Map</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-muted-foreground px-2"
                onClick={() => setShowMap(m => !m)}
                data-testid="button-map-toggle"
              >
                {showMap ? <><ChevronUp className="h-3 w-3 mr-1"/>Hide</> : <><ChevronDown className="h-3 w-3 mr-1"/>Show</>}
              </Button>
            </div>

            {/* Interactive map + detail panel (responsive: side-by-side on lg+, stacked on mobile) */}
            {showMap && (
              <div className="flex flex-col lg:flex-row gap-3 items-start">
                <div className="flex-1 min-w-0">
                  <IrrigationMap
                    clockDefs={clockDefs}
                    entityByValve={entityByValve}
                    selectedSvgId={selectedValve?.svgId ?? null}
                    onSelectValve={v => setSelectedValve(v)}
                    savedPositions={savedPositions}
                    isAdmin={isAdmin}
                    onSavePosition={(svgId, x, y) => saveLabelPosition.mutate({ svgId, x, y })}
                    onResetPosition={svgId => resetLabelPosition.mutate(svgId)}
                  />
                </div>
                {selectedValve && (
                  <div className="w-full lg:w-64 xl:w-72 shrink-0">
                    <ValveDetailPanel
                      valve={withZoneNameOverride(selectedValve, zoneNameOverrides)}
                      entity={selectedEntity}
                      onClose={() => setSelectedValve(null)}
                      onRefresh={refetch}
                      nextEvent={nextEvent}
                      isAdmin={isAdmin}
                      hasCustomName={!!zoneNameOverrides[selectedValve.svgId]}
                      onRenameZone={(svgId, name) => saveZoneName.mutate({ svgId, name })}
                      onResetZoneName={svgId => resetZoneName.mutate(svgId)}
                      renamePending={saveZoneName.isPending || resetZoneName.isPending}
                      gpm={selectedEntity ? gpmForEntity(selectedEntity.entity_id) : gpmForSvgId(selectedValve.svgId)}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Grouped zone list — 3 clocks (always rendered so placeholder rows show even without HA) */}
            <div className="space-y-2">
              {clockDefs.map(clock => (
                <ClockGroup
                  key={clock.id}
                  clockId={clock.id}
                  clockName={clock.name}
                  valves={clock.valves}
                  entityByValve={entityByValve}
                  selectedValve={selectedValve}
                  onSelectValve={v => {
                    setSelectedValve(v);
                    if (v && !showMap) setShowMap(true);
                  }}
                  onRefresh={refetch}
                />
              ))}

              {/* Unassigned zones — entities that matched no known valve */}
              {unmatchedZones.length > 0 && (
                <div className="rounded-lg border border-amber-500/30 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-amber-500/5">
                    <Wifi className="h-4 w-4 text-amber-400" />
                    <span className="text-sm font-semibold flex-1 text-amber-400">Unassigned zones</span>
                    <Badge variant="outline" className="text-amber-400 border-amber-500/30 text-[10px] h-4 px-1.5">
                      {unmatchedZones.length}
                    </Badge>
                  </div>
                  <div className="space-y-1.5 p-2">
                    {unmatchedZones.map(entity => (
                      <ZoneRow
                        key={entity.entity_id}
                        entity={entity}
                        valve={undefined}
                        isSelected={false}
                        onRefresh={refetch}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Run All / Stop All */}
            {zones.length > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={handleRunAll}
                  disabled={runningAll || activeZones === zones.length}
                  data-testid="button-run-all"
                >
                  {runningAll ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Droplets className="h-3 w-3 mr-1" />}
                  Run All Zones
                </Button>
                {activeZones > 0 && (
                  <Button
                    variant="destructive"
                    size="sm"
                    className="flex-1"
                    onClick={handleStopAll}
                    disabled={runningAll}
                    data-testid="button-stop-all"
                  >
                    {runningAll ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Power className="h-3 w-3 mr-1" />}
                    Stop All
                  </Button>
                )}
              </div>
            )}

            {/* Water usage summary (estimated gallons per zone) */}
            {zones.length > 0 && (
              <div className="border-t border-border pt-4">
                <WaterUsageSummarySection zones={zones} gpmForEntity={gpmForEntity} />
              </div>
            )}

            {/* Activity log */}
            {zones.length > 0 && (
              <div className="border-t border-border pt-4">
                <ActivityLogSection zones={zones} gpmForEntity={gpmForEntity} />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
