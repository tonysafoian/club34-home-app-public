import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Battery, BatteryLow, Mail, Clock, Play, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format, formatDistanceToNow } from 'date-fns';

interface TeslaBatteryAlert {
  id: string;
  vehicle_name: string | null;
  alert_active: boolean;
  last_range_miles: number | null;
  last_alerted_at: string | null;
}

interface BatteryMonitorRunResult {
  checked: number;
  alerts: number;
}

export function TeslaBatteryMonitorCard() {
  const { toast } = useToast();
  const [isRunning, setIsRunning] = useState(false);
  const [lastRunResult, setLastRunResult] = useState<BatteryMonitorRunResult | null>(null);

  const { data: alerts, refetch: refetchAlerts } = useQuery({
    queryKey: ['tesla-battery-alerts'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<TeslaBatteryAlert[]>({
        table: 'tesla_battery_alerts',
        select: '*',
        order: { column: 'updated_at', ascending: false },
      });
      return data ?? [];
    },
  });

  const runNow = async () => {
    setIsRunning(true);
    try {
      const data = await apiClient.invokeFn<BatteryMonitorRunResult>('tesla-battery-monitor');
      setLastRunResult(data);
      refetchAlerts();
      toast({
        title: 'Battery check complete',
        description: `Checked ${data.checked} vehicle(s), ${data.alerts} alert(s) sent.`,
      });
    } catch (e) {
      toast({
        title: 'Check failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
              <BatteryLow className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <CardTitle className="text-base">Tesla Battery Monitor</CardTitle>
              <CardDescription>
                Emails jesse-b@ &amp; sandra-w@ when range ≤ 100 mi; WhatsApps Jesse every 5 mi below 50 mi
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <Clock className="h-3 w-3" />
              Every 30m
            </Badge>
            <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Active</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Vehicle alert status */}
        {alerts && alerts.length > 0 && (
          <div className="space-y-2">
            {alerts.map((alert: TeslaBatteryAlert) => (
              <div key={alert.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border border-border/50">
                <div className="flex items-center gap-3">
                  {alert.alert_active ? (
                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{alert.vehicle_name || 'Unknown Vehicle'}</p>
                    <p className="text-xs text-muted-foreground">
                      {alert.last_range_miles != null
                        ? `${Math.round(alert.last_range_miles)} mi range`
                        : 'No data yet'}
                      {alert.last_alerted_at && (
                        <> · Last alert {formatDistanceToNow(new Date(alert.last_alerted_at), { addSuffix: true })}</>
                      )}
                    </p>
                  </div>
                </div>
                {alert.alert_active && (
                  <Badge variant="destructive" className="gap-1 text-xs">
                    <Mail className="h-3 w-3" />
                    Alert sent
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Last run result */}
        {lastRunResult && (
          <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-2.5">
            Last run: checked {lastRunResult.checked} vehicle(s), {lastRunResult.alerts} alert(s) triggered
          </div>
        )}

        {/* Manual trigger */}
        <Button
          variant="outline"
          size="sm"
          onClick={runNow}
          disabled={isRunning}
          className="w-full"
        >
          {isRunning ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-2" />Checking...</>
          ) : (
            <><Play className="h-4 w-4 mr-2" />Run Check Now</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
