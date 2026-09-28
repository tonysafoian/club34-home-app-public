import { useQuery } from '@tanstack/react-query';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Thermometer } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';

interface TempDataPoint {
  date: string;
  pool: number | null;
  spa: number | null;
}

export function PoolTempChart() {
  const { data, isLoading, error } = useQuery<{ success: boolean; data: TempDataPoint[] }>({
    queryKey: ['/api/pool/temp-history'],
    queryFn: () => apiClient.get('/api/pool/temp-history'),
  });

  const chartData = data?.data ?? [];

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <Card data-testid="card-pool-temp-history">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Thermometer className="h-5 w-5 text-blue-500" />
          Temperature History (30 Days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center h-[250px]" data-testid="loader-temp-chart">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground" data-testid="error-temp-chart">
            Unable to load temperature history
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex items-center justify-center h-[250px] text-sm text-muted-foreground" data-testid="empty-temp-chart">
            No temperature data available
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="date"
                tickFormatter={formatDate}
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fontSize: 11 }}
                className="fill-muted-foreground"
                label={{ value: '°F', position: 'insideTopLeft', offset: 10, style: { fontSize: 11 } }}
              />
              <Tooltip
                labelFormatter={(label) => {
                  const d = new Date(label + 'T00:00:00');
                  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                }}
                formatter={(value: number) => [`${value}°F`]}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line
                type="monotone"
                dataKey="pool"
                name="Pool"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="spa"
                name="Spa"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
