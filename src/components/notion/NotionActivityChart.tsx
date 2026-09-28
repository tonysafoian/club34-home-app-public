import { useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  useNotionActivityStats,
  useNotionActivityRealtime,
  useNotionWebhookHealth,
} from '@/hooks/useNotionActivity';
import { TrendingUp, Plus, CheckCircle2, RefreshCw, Loader2, PlugZap } from 'lucide-react';

const RANGE_OPTIONS = [
  { label: '7 days', value: 7 },
  { label: '14 days', value: 14 },
  { label: '30 days', value: 30 },
] as const;

type Category = 'updates' | 'new' | 'completions';

const CATEGORIES: { key: Category; label: string; icon: React.ReactNode }[] = [
  { key: 'updates', label: 'Updates', icon: <RefreshCw className="h-3.5 w-3.5" /> },
  { key: 'new', label: 'New', icon: <Plus className="h-3.5 w-3.5" /> },
  { key: 'completions', label: 'Completed', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
];

const chartConfig: ChartConfig = {
  club34_updates: {
    label: 'Updates',
    color: 'hsl(var(--iaqualink))',
  },
  club34_new: {
    label: 'New',
    color: 'hsl(var(--status-online))',
  },
  club34_completions: {
    label: 'Completed',
    color: 'hsl(var(--accent))',
  },
};

export function NotionActivityChart() {
  const [days, setDays] = useState(14);
  const [visible, setVisible] = useState<Record<Category, boolean>>({
    updates: true,
    new: true,
    completions: true,
  });
  const navigate = useNavigate();

  const { data, isLoading } = useNotionActivityStats(days);
  const { data: health, isLoading: healthLoading, isError: healthError } = useNotionWebhookHealth();
  useNotionActivityRealtime();

  const toggleCategory = (key: Category) => {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleBarClick = (data: { date?: string } | undefined) => {
    if (data?.date) {
      navigate(`/productivity/day/${data.date}`);
    }
  };

  // Summary stats (Club 34 only)
  const totals = (data ?? []).reduce(
    (acc, d) => ({
      updates: acc.updates + d.club34_updates,
      new: acc.new + d.club34_new,
      completions: acc.completions + d.club34_completions,
    }),
    { updates: 0, new: 0, completions: 0 }
  );

  const hasActivity = totals.updates + totals.new + totals.completions > 0;

  return (
    <div className="space-y-4">
      {/* Summary stat cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="glass">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--iaqualink) / 0.15)' }}>
              <RefreshCw className="h-4 w-4" style={{ color: 'hsl(var(--iaqualink))' }} />
            </div>
            <div>
              <p className="text-2xl font-semibold font-display">{totals.updates}</p>
              <p className="text-xs text-muted-foreground">Updates</p>
            </div>
          </CardContent>
        </Card>
        <Card className="glass">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--status-online) / 0.15)' }}>
              <Plus className="h-4 w-4" style={{ color: 'hsl(var(--status-online))' }} />
            </div>
            <div>
              <p className="text-2xl font-semibold font-display">{totals.new}</p>
              <p className="text-xs text-muted-foreground">New Items</p>
            </div>
          </CardContent>
        </Card>
        <Card className="glass">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: 'hsl(var(--accent) / 0.15)' }}>
              <CheckCircle2 className="h-4 w-4 text-accent" />
            </div>
            <div>
              <p className="text-2xl font-semibold font-display">{totals.completions}</p>
              <p className="text-xs text-muted-foreground">Completed</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Chart card */}
      <Card className="glass">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-4 w-4 text-primary" />
              Activity Level
            </CardTitle>
            <div className="flex items-center gap-1.5">
              {RANGE_OPTIONS.map((opt) => (
                <Button
                  key={opt.value}
                  variant={days === opt.value ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 text-xs px-2.5"
                  onClick={() => setDays(opt.value)}
                >
                  {opt.label}
                </Button>
              ))}
            </div>
          </div>
          {/* Filter chips */}
          <div className="flex gap-2 pt-2">
            {CATEGORIES.map((cat) => (
              <Badge
                key={cat.key}
                variant={visible[cat.key] ? 'default' : 'outline'}
                className="cursor-pointer gap-1 text-xs select-none transition-all"
                onClick={() => toggleCategory(cat.key)}
                style={
                  visible[cat.key]
                    ? { backgroundColor: chartConfig[`club34_${cat.key}`].color, color: 'hsl(var(--primary-foreground))' }
                    : undefined
                }
              >
                {cat.icon}
                {cat.label}
              </Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center h-[260px]">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !hasActivity ? (
            <div className="flex flex-col items-center justify-center text-center h-[260px] gap-3 px-6">
              <div className="w-11 h-11 rounded-full flex items-center justify-center bg-muted">
                <PlugZap className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium" data-testid="text-activity-empty-title">
                  No Notion activity in the last {days} days
                </p>
                <p className="text-xs text-muted-foreground max-w-sm" data-testid="text-activity-empty-detail">
                  {healthLoading || healthError
                    ? `Activity will appear here once Notion sends updates.`
                    : health?.lastEventAt
                    ? `The last update was received ${formatDistanceToNow(new Date(health.lastEventAt), { addSuffix: true })}. The Notion webhook appears to have stopped sending events and may need to be reconnected in Notion's integration settings.`
                    : `No webhook events have ever been received. Connect the Notion webhook in Notion's integration settings to start tracking activity.`}
                </p>
              </div>
            </div>
          ) : (
            <ChartContainer config={chartConfig} className="aspect-[2.5/1] w-full">
              <BarChart data={data} barGap={0} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(v) => format(new Date(v + 'T12:00:00'), 'MMM d')}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={30}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(v) => format(new Date((v as string) + 'T12:00:00'), 'EEE, MMM d')}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {visible.updates && (
                  <Bar
                    dataKey="club34_updates"
                    stackId="club34"
                    fill="var(--color-club34_updates)"
                    radius={[0, 0, 0, 0]}
                    className="cursor-pointer"
                    onClick={(data) => handleBarClick(data)}
                  />
                )}
                {visible.new && (
                  <Bar
                    dataKey="club34_new"
                    stackId="club34"
                    fill="var(--color-club34_new)"
                    radius={[0, 0, 0, 0]}
                    className="cursor-pointer"
                    onClick={(data) => handleBarClick(data)}
                  />
                )}
                {visible.completions && (
                  <Bar
                    dataKey="club34_completions"
                    stackId="club34"
                    fill="var(--color-club34_completions)"
                    radius={[4, 4, 0, 0]}
                    className="cursor-pointer"
                    onClick={(data) => handleBarClick(data)}
                  />
                )}
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
