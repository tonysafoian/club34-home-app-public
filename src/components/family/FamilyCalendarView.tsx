import { useState, useMemo } from 'react';
import { format, startOfDay, endOfDay, addDays, isToday, differenceInMinutes, parseISO } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import { useFamilyCalendarEvents, type FamilyEvent, type FamilyEvents } from '@/hooks/useGoogleCalendar';

const FAMILY_MEMBERS = [
  { key: 'tony', name: 'Tony', color: 'hsl(217 91% 60%)', bg: 'hsl(217 91% 60% / 0.15)' },
  { key: 'lana', name: 'Lana', color: 'hsl(330 81% 60%)', bg: 'hsl(330 81% 60% / 0.15)' },
  { key: 'isla', name: 'Isla', color: 'hsl(160 60% 45%)', bg: 'hsl(160 60% 45% / 0.15)' },
  { key: 'emme', name: 'Emme', color: 'hsl(38 92% 50%)', bg: 'hsl(38 92% 50% / 0.15)' },
] as const;

const HOUR_HEIGHT = 60; // px per hour
const START_HOUR = 6;
const END_HOUR = 23;
const TOTAL_HOURS = END_HOUR - START_HOUR;

function parseEventDate(dateStr: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(dateStr);
}

interface PositionedEvent {
  event: FamilyEvent;
  memberKey: string;
  memberName: string;
  color: string;
  bg: string;
  top: number;
  height: number;
  isAllDay: boolean;
}

function getPositionedEvents(familyEvents: FamilyEvents | undefined, selectedDate: Date): { timed: PositionedEvent[]; allDay: PositionedEvent[] } {
  const timed: PositionedEvent[] = [];
  const allDay: PositionedEvent[] = [];
  const dayStart = startOfDay(selectedDate);

  for (const member of FAMILY_MEMBERS) {
    const events = familyEvents?.[member.key as keyof FamilyEvents] || [];
    for (const event of events) {
      const isAllDayEvent = !event.start?.dateTime;
      if (isAllDayEvent) {
        allDay.push({ event, memberKey: member.key, memberName: member.name, color: member.color, bg: member.bg, top: 0, height: 0, isAllDay: true });
        continue;
      }

      const startStr = event.start?.dateTime;
      const endStr = event.end?.dateTime;
      if (!startStr || !endStr) continue;

      const start = parseEventDate(startStr);
      const end = parseEventDate(endStr);

      const startMins = Math.max(differenceInMinutes(start, dayStart) - START_HOUR * 60, 0);
      const endMins = Math.min(differenceInMinutes(end, dayStart) - START_HOUR * 60, TOTAL_HOURS * 60);
      if (endMins <= 0 || startMins >= TOTAL_HOURS * 60) continue;

      const top = (startMins / 60) * HOUR_HEIGHT;
      const height = Math.max(((endMins - startMins) / 60) * HOUR_HEIGHT, 20);

      timed.push({ event, memberKey: member.key, memberName: member.name, color: member.color, bg: member.bg, top, height, isAllDay: false });
    }
  }

  return { timed, allDay };
}

// Assign columns to overlapping events
function assignColumns(events: PositionedEvent[]): (PositionedEvent & { col: number; totalCols: number })[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.top - b.top || a.height - b.height);
  
  const result: (PositionedEvent & { col: number; totalCols: number })[] = [];
  const columns: PositionedEvent[][] = [];

  for (const ev of sorted) {
    let placed = false;
    for (let c = 0; c < columns.length; c++) {
      const last = columns[c][columns[c].length - 1];
      if (last.top + last.height <= ev.top + 1) {
        columns[c].push(ev);
        result.push({ ...ev, col: c, totalCols: 0 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([ev]);
      result.push({ ...ev, col: columns.length - 1, totalCols: 0 });
    }
  }

  // Update totalCols for overlapping groups
  for (const r of result) {
    // Find all events that overlap with this one
    const overlapping = result.filter(o =>
      o.top < r.top + r.height && o.top + o.height > r.top
    );
    const maxCol = Math.max(...overlapping.map(o => o.col)) + 1;
    r.totalCols = maxCol;
  }

  // Re-normalize totalCols within each overlap group
  for (const r of result) {
    const overlapping = result.filter(o =>
      o.top < r.top + r.height && o.top + o.height > r.top
    );
    const maxCols = Math.max(...overlapping.map(o => o.totalCols));
    for (const o of overlapping) o.totalCols = maxCols;
  }

  return result;
}

function TimelineEvent({ ev, col, totalCols }: { ev: PositionedEvent; col: number; totalCols: number }) {
  const startStr = ev.event.start?.dateTime;
  const endStr = ev.event.end?.dateTime;
  const startTime = startStr ? format(parseEventDate(startStr), 'h:mm a') : '';
  const endTime = endStr ? format(parseEventDate(endStr), 'h:mm a') : '';

  const widthPct = 100 / totalCols;
  const leftPct = col * widthPct;

  return (
    <a
      href={ev.event.htmlLink || '#'}
      target="_blank"
      rel="noopener noreferrer"
      className="absolute rounded-md px-2 py-1 overflow-hidden transition-opacity hover:opacity-90 border-l-[3px] cursor-pointer group"
      style={{
        top: ev.top,
        height: ev.height,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        backgroundColor: ev.bg,
        borderLeftColor: ev.color,
      }}
    >
      <div className="flex flex-col h-full min-w-0">
        <span className="text-xs font-semibold truncate" style={{ color: ev.color }}>{ev.event.summary || 'No title'}</span>
        {ev.height > 30 && (
          <span className="text-[10px] text-muted-foreground truncate">{startTime} – {endTime}</span>
        )}
        {ev.height > 46 && (
          <span className="text-[10px] font-medium mt-auto truncate" style={{ color: ev.color }}>{ev.memberName}</span>
        )}
      </div>
    </a>
  );
}

function NowLine({ selectedDate }: { selectedDate: Date }) {
  if (!isToday(selectedDate)) return null;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes() - START_HOUR * 60;
  if (mins < 0 || mins > TOTAL_HOURS * 60) return null;
  const top = (mins / 60) * HOUR_HEIGHT;

  return (
    <div className="absolute left-0 right-0 z-20 pointer-events-none" style={{ top }}>
      <div className="flex items-center">
        <div className="w-2 h-2 rounded-full bg-destructive shrink-0 -ml-1" />
        <div className="flex-1 h-[2px] bg-destructive" />
      </div>
    </div>
  );
}

export function FamilyCalendarView() {
  const [dayOffset, setDayOffset] = useState(0);
  const selectedDate = useMemo(() => addDays(startOfDay(new Date()), dayOffset), [dayOffset]);
  const timeMin = startOfDay(selectedDate).toISOString();
  const timeMax = endOfDay(selectedDate).toISOString();

  const { data: familyEvents, isLoading } = useFamilyCalendarEvents(timeMin, timeMax);
  const today = isToday(selectedDate);

  const { timed, allDay } = useMemo(() => getPositionedEvents(familyEvents, selectedDate), [familyEvents, selectedDate]);
  const positioned = useMemo(() => assignColumns(timed), [timed]);

  const hours = Array.from({ length: TOTAL_HOURS }, (_, i) => START_HOUR + i);

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-display font-semibold">
            {today ? 'Today' : format(selectedDate, 'EEEE, MMMM d')}
          </h3>
          {today && (
            <span className="text-sm text-muted-foreground ml-1">
              {format(selectedDate, 'EEEE, MMMM d')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDayOffset(o => o - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {!today && (
            <Button variant="ghost" size="sm" className="h-8 px-3 text-xs" onClick={() => setDayOffset(0)}>
              Today
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDayOffset(o => o + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 flex-wrap">
        {FAMILY_MEMBERS.map(m => (
          <div key={m.key} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
            <span className="text-xs font-medium text-muted-foreground">{m.name}</span>
          </div>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-[400px] w-full rounded-xl" />
        </div>
      ) : (
        <>
          {/* All-day events */}
          {allDay.length > 0 && (
            <div className="flex flex-wrap gap-1.5 rounded-lg border border-border/40 bg-muted/30 p-2">
              {allDay.map((ev, i) => (
                <a
                  key={`${ev.memberKey}-${ev.event.id}-${i}`}
                  href={ev.event.htmlLink || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border-l-[3px] hover:opacity-80 transition-opacity"
                  style={{ backgroundColor: ev.bg, borderLeftColor: ev.color, color: ev.color }}
                >
                  <span className="truncate max-w-[200px]">{ev.event.summary || 'No title'}</span>
                  <span className="text-[10px] opacity-70">({ev.memberName})</span>
                </a>
              ))}
            </div>
          )}

          {/* Timeline */}
          <div className="rounded-xl border border-border/40 bg-card overflow-hidden">
            <div className="overflow-y-auto max-h-[600px]">
              <div className="relative" style={{ height: TOTAL_HOURS * HOUR_HEIGHT }}>
                {/* Hour lines */}
                {hours.map((hour, i) => (
                  <div key={hour} className="absolute left-0 right-0 flex" style={{ top: i * HOUR_HEIGHT }}>
                    <div className="w-14 shrink-0 pr-2 text-right">
                      <span className="text-[10px] text-muted-foreground -mt-2 block">
                        {format(new Date(2000, 0, 1, hour), 'h a')}
                      </span>
                    </div>
                    <div className="flex-1 border-t border-border/30" />
                  </div>
                ))}

                {/* Events container */}
                <div className="absolute top-0 bottom-0 left-14 right-2">
                  <NowLine selectedDate={selectedDate} />
                  {positioned.map((ev, i) => (
                    <TimelineEvent key={`${ev.memberKey}-${ev.event.id}-${i}`} ev={ev} col={ev.col} totalCols={ev.totalCols} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
