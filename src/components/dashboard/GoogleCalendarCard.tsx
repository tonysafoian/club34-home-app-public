import { useMemo, useState } from 'react';
import { format, startOfDay, endOfDay, addDays, subDays, isToday, isTomorrow, isYesterday } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar, ExternalLink, Loader2, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { useGoogleConnectionStatus, useGoogleCalendarEvents, useGoogleConnect } from '@/hooks/useGoogleCalendar';

const DAYS_VISIBLE = 3;

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  colorId?: string;
  htmlLink?: string;
}

// Parse date string as local (not UTC) to avoid timezone shift
function parseEventDate(dateStr: string): Date {
  // Date-only strings like "2026-02-16" should be local, not UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(dateStr);
}

function EventRow({ event }: { event: CalendarEvent }) {
  const startStr = event.start?.dateTime || event.start?.date;
  const isAllDay = !event.start?.dateTime;
  const startTime = startStr ? (isAllDay ? 'All day' : format(parseEventDate(startStr), 'h:mm a')) : '';
  const endStr = event.end?.dateTime;
  const endTime = endStr ? format(parseEventDate(endStr), 'h:mm a') : '';

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 px-3 py-2 transition-colors hover:bg-muted/30">
      <div className="w-1 h-7 rounded-full bg-primary shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium truncate block">{event.summary || 'No title'}</span>
        <span className="text-xs text-muted-foreground">
          {isAllDay ? 'All day' : `${startTime} – ${endTime}`}
        </span>
      </div>
      {event.htmlLink && (
        <a href={event.htmlLink} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors shrink-0">
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

function dayLabel(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'EEE, MMM d');
}

export function GoogleCalendarCard() {
  const { data: status, isLoading: statusLoading } = useGoogleConnectionStatus();
  const connect = useGoogleConnect();
  const [startOffset, setStartOffset] = useState(0);

  // Memoize date boundaries so query keys stay stable across renders
  const { now, fetchMin, fetchMax } = useMemo(() => {
    const n = new Date();
    return {
      now: n,
      fetchMin: startOfDay(subDays(n, 1)).toISOString(),
      fetchMax: endOfDay(addDays(n, 21)).toISOString(),
    };
  }, []);

  const { data: events, isLoading: eventsLoading, isError: eventsError } = useGoogleCalendarEvents(fetchMin, fetchMax);

  // Build the 3 visible days
  const visibleDays = useMemo(() => {
    const days: { date: Date; key: string; events: CalendarEvent[] }[] = [];
    for (let i = 0; i < DAYS_VISIBLE; i++) {
      const d = addDays(startOfDay(now), startOffset + i);
      const key = format(d, 'yyyy-MM-dd');
      const dayEvents = (events || []).filter((e: CalendarEvent) => {
        const s = e.start?.dateTime || e.start?.date;
        if (!s) return false;
        return format(parseEventDate(s), 'yyyy-MM-dd') === key;
      });
      days.push({ date: d, key, events: dayEvents });
    }
    return days;
  }, [events, startOffset, now]);

  const goBack = () => setStartOffset((o) => o - DAYS_VISIBLE);
  const goForward = () => setStartOffset((o) => o + DAYS_VISIBLE);
  const goToday = () => setStartOffset(0);

  if (statusLoading) {
    return (
      <Card className="glass">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!status?.connected) {
    return (
      <Card className="glass">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calendar className="h-4 w-4 text-primary" />
            Google Calendar
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 space-y-3">
            <p className="text-sm text-muted-foreground">Connect your Google account to see your calendar here.</p>
            <Button size="sm" onClick={() => connect.mutate()} disabled={connect.isPending}>
              {connect.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Connect Google
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Calendar className="h-4 w-4 text-primary" />
            Calendar
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goBack}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {startOffset !== 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={goToday}>
                Today
              </Button>
            )}
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goForward}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {eventsLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : eventsError ? (
          <div className="flex flex-col items-center justify-center py-8 gap-2 text-center" data-testid="calendar-error">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-muted-foreground">Couldn't load events</p>
            <p className="text-xs text-muted-foreground/70">Try reconnecting your Google account</p>
          </div>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory scrollbar-hide sm:grid sm:grid-cols-3 sm:overflow-visible sm:pb-0">
            {visibleDays.map(({ date, key, events: dayEvents }) => {
              const today = isToday(date);
              return (
                <div key={key} className="min-w-[calc(50%-6px)] sm:min-w-0 snap-start shrink-0">
                  {/* Day header */}
                  <div className="flex flex-col items-center mb-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {format(date, 'EEE')}
                    </span>
                    <span
                      className={`text-2xl font-bold leading-tight mt-0.5 ${
                        today
                          ? 'bg-primary text-primary-foreground w-10 h-10 rounded-full flex items-center justify-center'
                          : 'text-foreground'
                      }`}
                    >
                      {format(date, 'd')}
                    </span>
                  </div>
                  {/* Events column */}
                  <div
                    className={`rounded-lg border p-2 min-h-[140px] ${
                      today ? 'border-primary/40 bg-primary/5' : 'border-border/40 bg-card/30'
                    }`}
                  >
                    {dayEvents.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center pt-4">No events</p>
                    ) : (
                      <div className="space-y-1.5">
                        {dayEvents.map((event: CalendarEvent) => (
                          <EventRow key={event.id} event={event} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
