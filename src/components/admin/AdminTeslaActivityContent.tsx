import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw, Zap, Plug, Unplug, Moon, Sun, AlertTriangle, CheckCircle, Car } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

type TeslaActivityLog = {
  id: string;
  vehicle_id: string;
  vehicle_name: string | null;
  event_type: string;
  details: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
};

const EVENT_META: Record<string, { label: string; icon: React.ReactNode; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  charging_started:  { label: 'Charging Started',  icon: <Zap className="h-4 w-4 text-[hsl(var(--status-online))]" />,   variant: 'default' },
  charging_stopped:  { label: 'Charging Stopped',  icon: <Zap className="h-4 w-4 text-muted-foreground" />, variant: 'secondary' },
  charging_complete: { label: 'Charging Complete', icon: <CheckCircle className="h-4 w-4 text-[hsl(var(--status-online))]" />, variant: 'default' },
  plugged_in:        { label: 'Plugged In',         icon: <Plug className="h-4 w-4 text-primary" />,    variant: 'secondary' },
  unplugged:         { label: 'Unplugged',          icon: <Unplug className="h-4 w-4 text-[hsl(var(--status-warning))]" />, variant: 'secondary' },
  vehicle_woke:      { label: 'Vehicle Woke',       icon: <Sun className="h-4 w-4 text-[hsl(var(--janus-amber))]" />,   variant: 'outline' },
  vehicle_slept:     { label: 'Vehicle Slept',      icon: <Moon className="h-4 w-4 text-muted-foreground" />, variant: 'outline' },
  low_battery_alert: { label: 'Low Battery Alert',  icon: <AlertTriangle className="h-4 w-4 text-[hsl(var(--status-offline))]" />, variant: 'destructive' },
  battery_snapshot:  { label: 'Battery Snapshot',   icon: <Car className="h-4 w-4 text-muted-foreground" />,  variant: 'outline' },
};

function EventBadge({ eventType }: { eventType: string }) {
  const meta = EVENT_META[eventType];
  if (!meta) return <Badge variant="outline">{eventType}</Badge>;
  return (
    <span className="flex items-center gap-1.5">
      {meta.icon}
      <Badge variant={meta.variant} className="text-xs">{meta.label}</Badge>
    </span>
  );
}

function DetailLine({ details, eventType }: { details: Record<string, unknown>; eventType: string }) {
  const parts: string[] = [];
  if (details.battery_level != null) parts.push(`${details.battery_level}% battery`);
  if (details.range_miles != null) parts.push(`${details.range_miles} mi range`);
  if (details.charging_state) parts.push(`state: ${details.charging_state}`);
  if (details.previous_state) parts.push(`from: ${details.previous_state}`);
  if (details.new_state) parts.push(`→ ${details.new_state}`);
  if (details.current_state && (eventType === 'vehicle_woke' || eventType === 'vehicle_slept')) {
    parts.push(`now: ${details.current_state}`);
  }
  if (Array.isArray(details.alert_sent_to)) parts.push(`alerted: ${(details.alert_sent_to as string[]).join(', ')}`);
  return parts.length > 0 ? (
    <p className="text-xs text-muted-foreground mt-0.5">{parts.join(' · ')}</p>
  ) : null;
}

export function AdminTeslaActivityContent() {
  const [vehicleFilter, setVehicleFilter] = useState<string>('all');
  const [eventFilter, setEventFilter] = useState<string>('all');

  const { data: logs, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['tesla-activity-logs'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<TeslaActivityLog[]>({ table: 'tesla_activity_logs', select: '*', order: { column: 'occurred_at', ascending: false }, limit: 300 });
      return (data ?? []) as TeslaActivityLog[];
    },
  });

  // Derive unique vehicle names for filter
  const vehicles = [...new Set((logs || []).map(l => l.vehicle_name || l.vehicle_id))];

  const filtered = (logs || []).filter(l => {
    const name = l.vehicle_name || l.vehicle_id;
    if (vehicleFilter !== 'all' && name !== vehicleFilter) return false;
    if (eventFilter !== 'all' && l.event_type !== eventFilter) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tesla Activity Logs</h2>
          <p className="text-sm text-muted-foreground">Charging, plug, and sleep events detected every 30 minutes</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <Select value={vehicleFilter} onValueChange={setVehicleFilter}>
          <SelectTrigger className="w-44 h-8 text-xs">
            <SelectValue placeholder="All Vehicles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Vehicles</SelectItem>
            {vehicles.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={eventFilter} onValueChange={setEventFilter}>
          <SelectTrigger className="w-52 h-8 text-xs">
            <SelectValue placeholder="All Events" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Events</SelectItem>
            {Object.entries(EVENT_META).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(vehicleFilter !== 'all' || eventFilter !== 'all') && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => { setVehicleFilter('all'); setEventFilter('all'); }}>
            Clear
          </Button>
        )}
      </div>

      {/* Log list */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <Car className="h-8 w-8" />
          <p className="text-sm">No events yet — logs will appear after the next monitor run</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 overflow-hidden divide-y divide-border/40">
          {filtered.map(log => (
            <div key={log.id} className="flex items-start gap-4 px-4 py-3 hover:bg-muted/20 transition-colors">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <EventBadge eventType={log.event_type} />
                  <span className="text-xs font-medium text-foreground">{log.vehicle_name || log.vehicle_id}</span>
                </div>
                <DetailLine details={log.details} eventType={log.event_type} />
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(log.occurred_at), { addSuffix: true })}</p>
                <p className="text-xs text-muted-foreground/60">{format(new Date(log.occurred_at), 'MMM d, h:mm a')}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {filtered.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          Showing {filtered.length} of {logs?.length} events
        </p>
      )}
    </div>
  );
}
