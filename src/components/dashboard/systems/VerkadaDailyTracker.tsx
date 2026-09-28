import { useMemo, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSocketEvent } from '@/hooks/useRealtimeSocket';
import {
  useVerkadaActivitySummary,
  useVerkadaWebhookHealth,
} from '@/hooks/useVerkada';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, Camera, Car, ChevronDown, RefreshCw, Eye, Users, Wifi, WifiOff } from 'lucide-react';
import { format } from 'date-fns';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

export function VerkadaDailyTracker() {
  const queryClient = useQueryClient();
  const now = useMemo(() => new Date(), []);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

  const { data: activity, isLoading, isError, error } = useVerkadaActivitySummary();
  const { data: webhookHealth } = useVerkadaWebhookHealth();

  const handleSighting = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['verkada-activity-summary'] });
    setLastUpdated(new Date());
  }, [queryClient]);
  useSocketEvent('verkada:sighting', handleSighting);
  useSocketEvent('verkada:vehicle', handleSighting);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ['verkada-activity-summary'] });
    await queryClient.invalidateQueries({ queryKey: ['verkada-webhook-health'] });
    setLastUpdated(new Date());
    setIsRefreshing(false);
  };

  const stats = useMemo(() => {
    if (!activity) return null;
    const activeCameras = activity.per_camera?.filter(c => c.total_events > 0).length ?? 0;
    const totalCameras = activity.total_cameras ?? activity.per_camera?.length ?? 0;
    return {
      uniquePeople: activity.unique_people,
      uniqueVehicles: activity.unique_vehicles,
      sightings: activity.sightings,
      totalEvents: activity.total_events,
      activeCameras,
      totalCameras,
      hourly: activity.hourly ?? [],
      peakCount: activity.peak_hour_count,
      busiestHour: activity.busiest_hour,
      perCamera: (activity.per_camera ?? [])
        .filter(c => c.total_events > 0)
        .sort((a, b) => b.total_events - a.total_events)
        .map(c => ({
          name: c.camera_name.replace(/^(Camera|Cam)\s*/i, '').trim().slice(0, 24),
          people: c.unique_people,
          vehicles: c.unique_vehicles,
          total: c.total_events,
        })),
      recentSightings: activity.recent_sightings ?? [],
    };
  }, [activity]);

  return (
    <Card className="border-border bg-card" data-testid="verkada-activity-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            Activity
          </CardTitle>
          <div className="flex items-center gap-2">
            {webhookHealth && (
              <div className="flex items-center gap-1" title={webhookHealth.is_healthy ? 'Webhook connected' : 'No recent events'}>
                {webhookHealth.is_healthy ? (
                  <Wifi className="h-3 w-3 text-green-500" />
                ) : (
                  <WifiOff className="h-3 w-3 text-destructive" />
                )}
                {webhookHealth.minutes_since_last_event !== null && (
                  <span className="text-[10px] text-muted-foreground">
                    {webhookHealth.minutes_since_last_event < 1 ? 'just now' : `${webhookHealth.minutes_since_last_event}m ago`}
                  </span>
                )}
              </div>
            )}
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {format(lastUpdated, 'h:mm a')}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh data"
              data-testid="refresh-activity"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Badge variant="outline" className="text-xs">
              {format(now, 'MMM d, yyyy')}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Unique people &amp; vehicles detected across all cameras today
        </p>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="text-center py-6 space-y-2">
            <Activity className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              Unable to load activity data
            </p>
            <Button variant="outline" size="sm" onClick={handleRefresh} data-testid="retry-activity">
              Try again
            </Button>
          </div>
        ) : isLoading || !stats ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-32 rounded-lg" />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <Users className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground" data-testid="unique-people-count">
                  {stats.uniquePeople > 0 ? stats.uniquePeople : '—'}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium text-center leading-tight">
                  People
                </span>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <Car className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground" data-testid="unique-vehicles-count">
                  {stats.uniqueVehicles != null ? stats.uniqueVehicles : '—'}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium text-center leading-tight">
                  Vehicles
                </span>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <Eye className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground" data-testid="sightings-count">
                  {stats.sightings > 0 ? stats.sightings : '—'}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium text-center leading-tight">
                  Sightings
                </span>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <Camera className="h-4 w-4 text-primary" />
                <span className="text-2xl font-bold text-foreground" data-testid="active-cameras-count">
                  {stats.activeCameras}/{stats.totalCameras}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium text-center leading-tight">
                  Cameras
                </span>
              </div>
            </div>

            {stats.peakCount > 0 && (
              <p className="text-xs text-muted-foreground px-1">
                Peak activity: <span className="font-semibold text-foreground">{stats.peakCount}</span> unique detections at <span className="font-semibold text-foreground">{stats.busiestHour}</span>
              </p>
            )}

            {stats.recentSightings.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5 px-1">
                  <Eye className="h-3.5 w-3.5 text-primary" />
                  Recent Sightings
                </p>
                <div className="space-y-0.5">
                  {stats.recentSightings.slice(0, 8).map((s, i) => (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-muted/20">
                      <Eye className="h-3 w-3 text-primary shrink-0" />
                      <span className="font-medium min-w-[60px]">{s.person_label || 'Unknown'}</span>
                      <span className="text-muted-foreground truncate flex-1">{s.camera_name}</span>
                      <span className="text-muted-foreground shrink-0 tabular-nums">
                        {format(new Date(s.occurred_at), 'h:mm a')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {stats.hourly.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5 px-1">
                  <Activity className="h-3.5 w-3.5" />
                  Hourly breakdown (unique)
                </p>
                <div className="h-40">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={stats.hourly} margin={{ left: -8, right: 4, top: 4, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        width={36}
                        allowDecimals={false}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '8px',
                          fontSize: 12,
                        }}
                        labelStyle={{ color: 'hsl(var(--foreground))' }}
                      />
                      <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
                      <Bar dataKey="people" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} name="People" />
                      <Bar dataKey="vehicles" stackId="a" fill="hsl(var(--primary) / 0.4)" radius={[3, 3, 0, 0]} name="Vehicles" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {stats.perCamera.length > 0 && (
              <Collapsible open={cameraOpen} onOpenChange={setCameraOpen}>
                <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium px-1 hover:text-foreground transition-colors w-full">
                  <Camera className="h-3.5 w-3.5" />
                  All {stats.perCamera.length} active cameras
                  <ChevronDown className={`h-3.5 w-3.5 ml-auto transition-transform ${cameraOpen ? 'rotate-180' : ''}`} />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="mt-2 max-h-[400px] overflow-y-auto rounded-lg border border-border">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card z-10">
                        <tr className="border-b border-border">
                          <th className="text-left px-3 py-2 font-medium text-muted-foreground">Camera</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">People</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Vehicles</th>
                          <th className="text-right px-3 py-2 font-medium text-muted-foreground">Events</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.perCamera.map((cam, i) => (
                          <tr key={i} className="border-b border-border/50 hover:bg-muted/20">
                            <td className="px-3 py-1.5 font-medium truncate max-w-[180px]">{cam.name}</td>
                            <td className="text-right px-3 py-1.5 tabular-nums">{cam.people > 0 ? cam.people : '—'}</td>
                            <td className="text-right px-3 py-1.5 tabular-nums text-muted-foreground">{cam.vehicles > 0 ? cam.vehicles : '—'}</td>
                            <td className="text-right px-3 py-1.5 tabular-nums font-semibold">{cam.total}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}

            {stats.hourly.length === 0 && stats.perCamera.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-2">
                No activity detected around the house yet today.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
