import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { format, isSameDay, startOfDay, endOfDay } from 'date-fns';
import { Activity as ActivityIcon, RefreshCw, Loader2 } from 'lucide-react';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { ActivityEventItem } from '@/components/activity/ActivityEventItem';
import { ActivityFilters } from '@/components/activity/ActivityFilters';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/apiClient';
import type { ActivityEvent, ActivityEventType } from '@/types/activity';

export default function Activity() {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedType, setSelectedType] = useState<ActivityEventType | 'all'>('all');
  const [selectedZone, setSelectedZone] = useState<string | 'all'>('all');

  // Fetch real activity events from DB
  const { data: events = [], isLoading, refetch } = useQuery({
    queryKey: ['activity-events', selectedDate.toISOString().slice(0, 10)],
    queryFn: async () => {
      const dayStart = startOfDay(selectedDate).toISOString();
      const dayEnd = endOfDay(selectedDate).toISOString();
      const { data } = await apiClient.dbQuery<ActivityEvent[]>({
        table: 'activity_events',
        select: '*',
        filters: [
          { column: 'occurred_at', op: 'gte', value: dayStart },
          { column: 'occurred_at', op: 'lte', value: dayEnd },
        ],
        order: { column: 'occurred_at', ascending: false },
        limit: 500,
      });
      return data ?? [];
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false, // don't poll when tab is hidden
  });

  // Get unique zones from events
  const availableZones = useMemo(() => {
    const zones = new Set<string>();
    events.forEach((event) => {
      if (event.zone) zones.add(event.zone);
    });
    return Array.from(zones).sort();
  }, [events]);

  // Filter events
  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (selectedType !== 'all' && event.event_type !== selectedType) return false;
      if (selectedZone !== 'all' && event.zone !== selectedZone) return false;
      return true;
    });
  }, [events, selectedType, selectedZone]);

  // Group events by hour
  const groupedEvents = useMemo(() => {
    const groups: Record<string, typeof filteredEvents> = {};
    filteredEvents.forEach((event) => {
      const hour = format(new Date(event.occurred_at), 'h:00 a');
      if (!groups[hour]) groups[hour] = [];
      groups[hour].push(event);
    });
    return groups;
  }, [filteredEvents]);

  const isToday = isSameDay(selectedDate, new Date());

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />

      <ErrorBoundary name="activity">
      <main className="container py-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <ActivityIcon className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Activity Log</h1>
              <p className="text-sm text-muted-foreground">{format(selectedDate, 'EEEE, MMMM d, yyyy')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isToday && (
              <Button variant="outline" size="sm" onClick={() => setSelectedDate(new Date())}>
                Today
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="mb-6">
          <ActivityFilters
            selectedDate={selectedDate}
            onDateChange={setSelectedDate}
            selectedType={selectedType}
            onTypeChange={setSelectedType}
            selectedZone={selectedZone}
            onZoneChange={setSelectedZone}
            availableZones={availableZones}
          />
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-6">
          <div className="bg-card border rounded-lg p-4 text-center">
            <p className="text-2xl font-bold">{filteredEvents.length}</p>
            <p className="text-xs text-muted-foreground">Total Events</p>
          </div>
          <div className="bg-card border rounded-lg p-4 text-center">
            <p className="text-2xl font-bold">{filteredEvents.filter(e => e.event_type === 'camera').length}</p>
            <p className="text-xs text-muted-foreground">Camera</p>
          </div>
          <div className="bg-card border rounded-lg p-4 text-center">
            <p className="text-2xl font-bold">{filteredEvents.filter(e => e.event_type === 'motion').length}</p>
            <p className="text-xs text-muted-foreground">Motion</p>
          </div>
          <div className="bg-card border rounded-lg p-4 text-center">
            <p className="text-2xl font-bold">{filteredEvents.filter(e => e.metadata?.is_known === true).length}</p>
            <p className="text-xs text-muted-foreground">Known People</p>
          </div>
          <div className="bg-card border rounded-lg p-4 text-center">
            <p className="text-2xl font-bold text-status-warning">{filteredEvents.filter(e => e.severity === 'warning' || e.severity === 'alert').length}</p>
            <p className="text-xs text-muted-foreground">Alerts</p>
          </div>
        </div>

        {/* Timeline */}
        <div className="space-y-6">
          {isLoading ? (
            <div className="text-center py-12 bg-card border rounded-lg">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mx-auto mb-4" />
              <p className="text-muted-foreground">Loading activity...</p>
            </div>
          ) : Object.keys(groupedEvents).length === 0 ? (
            <div className="text-center py-12 bg-card border rounded-lg">
              <ActivityIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No activity found</h3>
              <p className="text-muted-foreground">
                {isToday
                  ? 'No events recorded today yet'
                  : 'No events recorded for this date'}
              </p>
            </div>
          ) : (
            Object.entries(groupedEvents).map(([hour, hourEvents]) => (
              <div key={hour}>
                <h3 className="text-sm font-medium text-muted-foreground mb-3 sticky top-0 bg-background py-2">
                  {hour}
                </h3>
                <div className="space-y-3">
                  {hourEvents.map((event) => (
                    <ActivityEventItem key={event.id} event={event} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </main>
      </ErrorBoundary>
    </div>
  );
}
