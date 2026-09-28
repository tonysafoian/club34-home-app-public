import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/apiClient';
import { BarChart2 } from 'lucide-react';
import { format, subDays, startOfDay } from 'date-fns';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

interface CheckinRecord {
  id: string;
  guest_name: string;
  company_name: string | null;
  checked_in_at: string;
  raw_email_subject: string | null;
}

function buildLast14Days(checkins: CheckinRecord[]): { date: string; visitors: number }[] {
  const today = startOfDay(new Date());
  const days: { date: string; visitors: number }[] = [];

  for (let i = 13; i >= 0; i--) {
    const d = subDays(today, i);
    days.push({ date: format(d, 'MMM d'), visitors: 0 });
  }

  const cutoff = subDays(today, 13);

  for (const c of checkins) {
    const d = startOfDay(new Date(c.checked_in_at));
    if (d < cutoff) continue;
    const label = format(d, 'MMM d');
    const entry = days.find(x => x.date === label);
    if (entry) entry.visitors += 1;
  }

  return days;
}

export function GoAccessVisitorChart() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['/api/goaccess/checkins', '30days'],
    queryFn: async () => {
      const result = await apiClient.get('/api/goaccess/checkins?filter=30days');
      return result as { success: boolean; checkins: CheckinRecord[] };
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const chartData = useMemo(() => {
    if (!data?.checkins) return [];
    return buildLast14Days(data.checkins);
  }, [data]);

  const totalVisitors = useMemo(() => chartData.reduce((s, d) => s + d.visitors, 0), [chartData]);

  return (
    <Card className="border-border bg-card" data-testid="goaccess-visitor-chart">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <BarChart2 className="h-4 w-4 text-primary" />
            Visitors Per Day
          </CardTitle>
          {!isLoading && !isError && (
            <span className="text-xs text-muted-foreground" data-testid="chart-total-visitors">
              {totalVisitors} total over 14 days
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Gate check-ins per day for the last 14 days
        </p>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="text-center py-6">
            <BarChart2 className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Unable to load visitor data</p>
          </div>
        ) : isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-40 rounded-lg" />
          </div>
        ) : (
          <div className="h-44" data-testid="chart-bar-container">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ left: -8, right: 4, top: 4, bottom: 4 }}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  horizontal
                  vertical={false}
                  stroke="hsl(var(--border))"
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                  interval={0}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  width={28}
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'hsl(var(--foreground))' }}
                  itemStyle={{ color: 'hsl(var(--muted-foreground))' }}
                  formatter={(value: number) => [value, 'Visitors']}
                />
                <Bar
                  dataKey="visitors"
                  fill="hsl(var(--primary))"
                  radius={[3, 3, 0, 0]}
                  name="Visitors"
                  data-testid="chart-bar"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
