import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Thermometer, Zap, Lock, Unlock, Car, RefreshCw, Power, ChevronDown, MapPin, Activity } from 'lucide-react';
import { BatteryBar } from './BatteryBar';
import { stateColor } from './stateColor';
import { formatDistanceToNow, format } from 'date-fns';

const EVENT_LABELS: Record<string, { emoji: string; label: string }> = {
  drive_started: { emoji: '🚗', label: 'Started driving' },
  drive_stopped: { emoji: '🅿️', label: 'Stopped' },
  plugged_in: { emoji: '🔌', label: 'Plugged in' },
  unplugged: { emoji: '🔋', label: 'Unplugged' },
  charging_started: { emoji: '⚡', label: 'Charging started' },
  charging_stopped: { emoji: '⏹', label: 'Charging stopped' },
  charging_complete: { emoji: '✅', label: 'Charge complete' },
  low_battery_alert: { emoji: '🪫', label: 'Low battery alert' },
  battery_recovered: { emoji: '✅', label: 'Battery OK' },
  vehicle_woke: { emoji: '👀', label: 'Vehicle woke up' },
  vehicle_slept: { emoji: '💤', label: 'Vehicle went to sleep' },
};

function VehicleActivityLog({ vehicleId }: { vehicleId: string }) {
  const { data: logs, isLoading } = useQuery({
    queryKey: ['tesla-activity-log', vehicleId],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<Array<{
        id: string;
        event_type: string;
        details: Record<string, unknown> | null;
        occurred_at: string;
      }>>({
        table: 'tesla_activity_logs',
        select: '*',
        filters: [{ column: 'vehicle_id', op: 'eq', value: vehicleId }],
        order: { column: 'occurred_at', ascending: false },
        limit: 20,
      });
      return data ?? [];
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return <p className="text-xs text-muted-foreground text-center py-3">Loading activity...</p>;
  }

  if (!logs || logs.length === 0) {
    return <p className="text-xs text-muted-foreground text-center py-3">No activity recorded yet.</p>;
  }

  return (
    <div className="space-y-1 max-h-64 overflow-y-auto">
      {logs.map((log) => {
        const meta = EVENT_LABELS[log.event_type] || { emoji: '📋', label: log.event_type };
        const location = log.details?.location as string | undefined;
        return (
          <div key={log.id} className="flex items-start gap-2 px-1 py-1.5 rounded text-xs hover:bg-muted/30">
            <span className="text-sm shrink-0">{meta.emoji}</span>
            <div className="flex-1 min-w-0">
              <span className="font-medium">{meta.label}</span>
              {location && (
                <span className="text-muted-foreground flex items-center gap-0.5 mt-0.5">
                  <MapPin className="h-2.5 w-2.5" />{location}
                </span>
              )}
            </div>
            <span className="text-muted-foreground shrink-0 text-[10px]">
              {formatDistanceToNow(new Date(log.occurred_at), { addSuffix: true }).replace('about ', '')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface VehicleData {
  charge_state?: {
    battery_level: number;
    battery_range: number;
    charging_state: string;
  };
  climate_state?: {
    inside_temp: number | null;
  };
  vehicle_state?: {
    locked: boolean;
  };
}

export function VehicleCard({ vehicle, data, onRefresh, onWake }: {
  vehicle: { id: number; display_name: string; vin: string; state: string };
  data: VehicleData | undefined;
  onRefresh: () => void;
  onWake: () => void;
}) {
  const charge = data?.charge_state;
  const climate = data?.climate_state;
  const vState = data?.vehicle_state;
  const [logOpen, setLogOpen] = useState(false);

  return (
    <Card className="glass">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Car className="h-5 w-5 sm:h-6 sm:w-6 text-primary shrink-0" />
            <div className="min-w-0">
              <CardTitle className="text-base sm:text-lg font-display truncate">{vehicle.display_name || 'Tesla'}</CardTitle>
              <p className="text-[10px] sm:text-xs text-muted-foreground font-mono truncate">{vehicle.vin}</p>
            </div>
          </div>
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            <Badge className={`text-[10px] sm:text-xs ${stateColor(vehicle.state)}`}>{vehicle.state}</Badge>
            {vehicle.state === 'asleep' && (
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onWake} title="Wake up">
                <Power className="h-3.5 w-3.5" />
              </Button>
            )}
            <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onRefresh} title="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {charge ? (
          <>
            <BatteryBar level={charge.battery_level} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3">
              <div className="flex items-center gap-2 text-sm">
                <Zap className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Range</span>
                <span className="ml-auto font-medium">{Math.round(charge.battery_range)} mi</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Zap className={`h-4 w-4 ${charge.charging_state === 'Charging' ? 'text-[hsl(var(--status-online))]' : 'text-muted-foreground'}`} />
                <span className="text-muted-foreground">Charging</span>
                <span className="ml-auto font-medium">{charge.charging_state}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                {vState?.locked ? (
                  <Lock className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Unlock className="h-4 w-4 text-[hsl(var(--status-warning))]" />
                )}
                <span className="text-muted-foreground">Locked</span>
                <span className="ml-auto font-medium">{vState?.locked ? 'Yes' : 'No'}</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Thermometer className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Interior</span>
                <span className="ml-auto font-medium">
                  {climate?.inside_temp != null ? `${Math.round(climate.inside_temp * 9 / 5 + 32)}°F` : '—'}
                </span>
              </div>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {vehicle.state === 'asleep' ? 'Vehicle is asleep. Wake it to see data.' : 'Loading vehicle data...'}
          </p>
        )}

        {/* Activity Log */}
        <Collapsible open={logOpen} onOpenChange={setLogOpen}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-2 w-full text-xs font-medium text-muted-foreground hover:text-foreground transition-colors py-1">
              <Activity className="h-3.5 w-3.5" />
              Activity Log
              <ChevronDown className={`h-3 w-3 ml-auto transition-transform ${logOpen ? 'rotate-180' : ''}`} />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <VehicleActivityLog vehicleId={String(vehicle.id)} />
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}
