import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, Zap } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/apiClient';
import { cn } from '@/lib/utils';

interface CircuitLike {
  entityId: string;
  energyEntityId: string;
  label: string;
  category: string;
  color: string;
  watts: number;
  todayKwh: number;
  todayCost: number;
}

interface HistoryRow {
  period: string;   // YYYY-MM-DD
  key: string;      // entity_id
  label: string;
  kwh: number | string;
  days: number;
}

interface HistoryResponse {
  groupBy: string;
  granularity: string;
  rows: HistoryRow[];
}

const CATEGORY_COLORS: Record<string, string> = {
  Panels:   'bg-violet-500/15 text-violet-400 border-violet-500/30',
  HVAC:     'bg-blue-500/15 text-blue-400 border-blue-500/30',
  Vehicles: 'bg-green-500/15 text-green-400 border-green-500/30',
  Outdoor:  'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  Kitchen:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  Lighting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  Other:    'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

function formatWatts(w: number): string {
  if (w >= 1000) return `${(w / 1000).toFixed(1)} kW`;
  return `${Math.round(w)} W`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  circuit: CircuitLike | null;
  marginalRate?: number;
}

export function CircuitDetailDrawer({ open, onClose, circuit, marginalRate }: Props) {
  // Pull ~2 months of daily per-circuit kWh; we filter & slice to the last 30 days.
  const { data, isLoading } = useQuery({
    queryKey: ['circuit-history-day', circuit?.energyEntityId],
    queryFn: () => apiClient.get<HistoryResponse>(
      '/api/electricity/circuit-history?groupBy=circuit&granularity=day&months=2',
      { timeoutMs: 30000 },
    ),
    enabled: open && !!circuit,
    staleTime: 5 * 60 * 1000,
  });

  const chart = useMemo(() => {
    if (!circuit || !data?.rows) return [];
    return data.rows
      .filter(r => r.key === circuit.energyEntityId)
      .map(r => ({ date: r.period, kwh: Number(r.kwh) || 0 }))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-30);
  }, [data, circuit]);

  const cycleStats = useMemo(() => {
    const totalKwh = chart.reduce((s, d) => s + d.kwh, 0);
    const rate = marginalRate ?? 0;
    return {
      totalKwh,
      cost: totalKwh * rate,
      avgKwh: chart.length ? totalKwh / chart.length : 0,
      days: chart.length,
    };
  }, [chart, marginalRate]);

  return (
    <Sheet open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {circuit && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <Zap className={cn('h-5 w-5', circuit.color)} />
                <SheetTitle>{circuit.label}</SheetTitle>
              </div>
              <SheetDescription className="flex items-center gap-2">
                <Badge variant="outline" className={cn('text-[10px] px-2 py-0', CATEGORY_COLORS[circuit.category] ?? '')}>
                  {circuit.category}
                </Badge>
                <span className="font-mono text-xs">{circuit.entityId}</span>
              </SheetDescription>
            </SheetHeader>

            {/* Live + today */}
            <div className="grid grid-cols-3 gap-2 mt-5">
              <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Live</p>
                <p className="text-lg font-bold tabular-nums">{formatWatts(circuit.watts)}</p>
              </div>
              <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Today</p>
                <p className="text-lg font-bold tabular-nums">{circuit.todayKwh.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">kWh</span></p>
              </div>
              <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Today $</p>
                <p className="text-lg font-bold tabular-nums text-amber-400">${circuit.todayCost.toFixed(2)}</p>
              </div>
            </div>

            {/* Daily history chart */}
            <div className="mt-6">
              <p className="text-xs font-medium text-muted-foreground mb-2">Daily Usage (last {cycleStats.days || 30} days)</p>
              {isLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : chart.length === 0 ? (
                <div className="rounded-lg bg-muted/20 border border-border/50 p-6 text-center">
                  <p className="text-sm text-muted-foreground">No daily history yet.</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-1">
                    Per-circuit history accrues one completed day at a time.
                  </p>
                </div>
              ) : (
                <div className="h-52 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                        tickFormatter={(d: string) => d.slice(5)}
                        interval="preserveStartEnd"
                        minTickGap={20}
                      />
                      <YAxis
                        tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                        width={40}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'hsl(var(--background))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(v: number) => [`${Number(v).toFixed(2)} kWh`, 'Usage']}
                        labelFormatter={(d: string) => d}
                      />
                      <Bar dataKey="kwh" fill="#fbbf24" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* Cycle / window totals */}
            {chart.length > 0 && (
              <div className="grid grid-cols-3 gap-2 mt-5">
                <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total</p>
                  <p className="text-base font-bold tabular-nums">{cycleStats.totalKwh.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">kWh</span></p>
                </div>
                <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Daily Avg</p>
                  <p className="text-base font-bold tabular-nums">{cycleStats.avgKwh.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">kWh</span></p>
                </div>
                <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Est. Cost</p>
                  <p className="text-base font-bold tabular-nums text-amber-400">${cycleStats.cost.toFixed(2)}</p>
                </div>
              </div>
            )}

            {marginalRate != null && (
              <p className="text-[10px] text-muted-foreground/50 text-center mt-4">
                Cost estimated at all-in marginal rate of ${marginalRate.toFixed(4)}/kWh
              </p>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
