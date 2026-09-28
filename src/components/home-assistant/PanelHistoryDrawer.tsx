import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/apiClient';
import { cn } from '@/lib/utils';

// Range options for the history chart. 24h aggregates hourly; 7d/30d aggregate
// daily (matching the native Emporia app's history tab).
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Loader2, LayoutGrid, TrendingUp, TrendingDown, Minus } from 'lucide-react';
type RangeKey = '24h' | '7d' | '30d';
const RANGES: Record<RangeKey, { label: string; hours: number; period: 'hour' | 'day' }> = {
  '24h': { label: '24h', hours: 24, period: 'hour' },
  '7d': { label: '7d', hours: 7 * 24, period: 'day' },
  '30d': { label: '30d', hours: 30 * 24, period: 'day' },
};

// Per-panel descriptor used to render the stacked whole-house breakdown.
export interface PanelHistoryBreakdownEntry {
  energyEntityId: string;
  label: string;
  color: string;               // tailwind text color class (e.g. 'text-orange-400')
}

export interface PanelHistoryTarget {
  energyEntityIds: string[];   // one panel-main energy entity, or all 5 for whole-house
  label: string;
  color: string;               // tailwind text color class
  // When present (whole-house view), the chart stacks one colored segment per
  // panel and shows a legend mapping colors → panels.
  breakdown?: PanelHistoryBreakdownEntry[];
}

interface HistoryPoint {
  start: string;   // ISO timestamp (hour bucket start)
  kwh: number;
}

interface HistorySeries {
  entityId: string;
  label: string;
  points: HistoryPoint[];
}

interface PreviousWindow {
  startTime: string;
  endTime: string;
  totalKwh: number;
  points: HistoryPoint[];
}
interface PanelHistoryResponse {
  entityId: string;
  label: string;
  hours: number;
  period: 'hour' | 'day';
  startTime: string;
  endTime: string;
  totalKwh: number;
  currentRate: number;
  points: HistoryPoint[];
  series?: HistorySeries[];
  previous?: PreviousWindow;
}

// Tailwind text-color class → hex, so panel colors stay consistent between the
// header/list and the stacked chart fills (recharts needs concrete colors).
const PANEL_COLOR_HEX: Record<string, string> = {
  'text-orange-400': '#fb923c',
  'text-blue-400': '#60a5fa',
  'text-green-400': '#4ade80',
  'text-violet-400': '#a78bfa',
  'text-cyan-400': '#22d3ee',
  'text-amber-400': '#fbbf24',
  'text-yellow-400': '#facc15',
  'text-slate-400': '#94a3b8',
};
function panelHex(colorClass: string): string {
  return PANEL_COLOR_HEX[colorClass] ?? '#fbbf24';
}

interface TooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: Record<string, number | string>;
}
interface StackedTooltipProps {
  active?: boolean;
  label?: string;
  payload?: TooltipEntry[];
  stacked: boolean;
  percentMode?: boolean;
  panels: Array<{ key: string; label: string; hex: string }>;
}

// Custom tooltip: for the stacked whole-house chart it lists each panel's kWh
// (largest first) plus the bucket total; for a single panel it shows one value.
// In percent mode (100%-stacked) each row shows kWh plus its share of the bucket.
// The previous-period overlay (dataKey 'prevKwh') is shown as its own footer
// row so it never mixes into the current window's panel rows or total.
function StackedTooltip({ active, label, payload, stacked, percentMode, panels }: StackedTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const labelFor = (key: string | number | undefined) =>
    panels.find(p => p.key === key)?.label ?? String(key ?? '');

  const prevEntry = payload.find(e => e.dataKey === 'prevKwh');
  const prevValue = prevEntry != null && prevEntry.value != null ? Number(prevEntry.value) : null;

  const rows = payload
    .filter(e => e.dataKey !== 'prevKwh')
    .map(e => {
      const value = Number(e.value) || 0;
      // Percent-mode rows carry the original kWh alongside the % value.
      const kwh = percentMode
        ? Number(e.payload?.[`__kwh_${String(e.dataKey ?? '')}`]) || 0
        : value;
      return {
        label: stacked ? labelFor(e.dataKey) : 'Usage',
        value,
        kwh,
        color: e.color,
      };
    })
    .filter(r => r.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = rows.reduce((s, r) => s + r.kwh, 0);

  return (
    <div
      className="rounded-lg border border-border bg-background px-3 py-2 text-xs shadow-md"
      data-testid="tooltip-panel-history"
    >
      <p className="font-medium mb-1">{label}</p>
      <div className="space-y-0.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5">
              {stacked && (
                <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: r.color }} />
              )}
              <span className="text-muted-foreground">{r.label}</span>
            </span>
            <span className="font-mono tabular-nums">
              {percentMode ? `${r.kwh.toFixed(2)} kWh (${r.value.toFixed(1)}%)` : `${r.value.toFixed(2)} kWh`}
            </span>
          </div>
        ))}
      </div>
      {stacked && rows.length > 1 && (
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/60 pt-1">
          <span className="font-medium">Total</span>
          <span className="font-mono tabular-nums font-semibold">{total.toFixed(2)} kWh</span>
        </div>
      )}
      {prevValue != null && Number.isFinite(prevValue) && (
        <div className="mt-1 flex items-center justify-between gap-3 border-t border-border/60 pt-1">
          <span className="text-muted-foreground/70">Prev period</span>
          <span className="font-mono tabular-nums text-muted-foreground/70">{prevValue.toFixed(2)} kWh</span>
        </div>
      )}
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  panel: PanelHistoryTarget | null;
}

// Format an ISO hour-bucket to an LA-local "h a" label (e.g. "3 PM").
function formatHour(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: 'numeric',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

// Format an ISO day-bucket to an LA-local "M/D" label (e.g. "6/21").
function formatDay(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'numeric',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(5, 10);
  }
}

export function PanelHistoryDrawer({ open, onClose, panel }: Props) {
  const [range, setRange] = useState<RangeKey>('24h');
  // Whole-house chart mode: absolute stacked kWh vs 100%-stacked share per bucket.
  const [stackMode, setStackMode] = useState<'absolute' | 'percent'>('absolute');
  const { hours, period } = RANGES[range];

  // Whole-house stacked view: panels the user has hidden via the legend
  // (keyed by energy entity id). Reset whenever the drawer target changes
  // or the drawer is reopened.
  const [hiddenPanels, setHiddenPanels] = useState<Set<string>>(new Set());
  const panelKey = panel?.energyEntityIds.join(',') ?? '';
  useEffect(() => {
    setHiddenPanels(new Set());
  }, [panelKey, open]);

  const { data, isLoading } = useQuery({
    queryKey: ['panel-history', panel?.energyEntityIds, range],
    queryFn: () => apiClient.get<PanelHistoryResponse>(
      `/api/electricity/panel-history?entityIds=${encodeURIComponent((panel!.energyEntityIds).join(','))}&hours=${hours}&period=${period}&compare=previous`,
      { timeoutMs: 30000 },
    ),
    enabled: open && !!panel && !!panel.energyEntityIds.length,
    staleTime: 5 * 60 * 1000,
  });

  const isDaily = period === 'day';
  const rangeWindowLabel = range === '24h' ? 'last 24 hours' : range === '7d' ? 'last 7 days' : 'last 30 days';

  // Previous-window points sorted chronologically; overlaid on the chart by
  // POSITION (bucket #1 of last week under bucket #1 of this week) since the
  // actual timestamps are from the earlier window.
  const prevPoints = useMemo(() => {
    const pts = (data?.previous?.points ?? []).map(p => ({ start: p.start, kwh: Number(p.kwh) || 0 }));
    pts.sort((a, b) => (a.start < b.start ? -1 : 1));
    return pts;
  }, [data]);
  const hasPrev = prevPoints.length > 0;

  const chart = useMemo(() => {
    return (data?.points ?? []).map((p, i) => ({
      hour: isDaily ? formatDay(p.start) : formatHour(p.start),
      iso: p.start,
      kwh: Number(p.kwh) || 0,
      prevKwh: prevPoints[i]?.kwh,
    }));
  }, [data, isDaily, prevPoints]);

  // Whole-house view stacks one colored segment per panel. We only stack when a
  // breakdown was supplied AND the API returned per-entity series.
  const breakdown = panel?.breakdown;
  const isStacked = !!breakdown && breakdown.length > 1 && (data?.series?.length ?? 0) > 1;

  // Map each panel-energy entity id → { key, label, color } for stacking + legend.
  const stackPanels = useMemo(() => {
    if (!breakdown) return [];
    return breakdown.map(b => ({
      key: b.energyEntityId,
      label: b.label,
      hex: panelHex(b.color),
    }));
  }, [breakdown]);

  // Panels currently shown in the stacked chart (legend toggles hide panels).
  const visibleStackPanels = useMemo(
    () => stackPanels.filter(sp => !hiddenPanels.has(sp.key)),
    [stackPanels, hiddenPanels],
  );

  // Legend click: toggle one panel on/off. Hiding the last visible panel
  // resets back to "all panels" instead of leaving an empty chart.
  const togglePanel = (key: string) => {
    setHiddenPanels(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if (next.size >= stackPanels.length) return new Set<string>();
      }
      return next;
    });
  };

  // Legend double-click: isolate a single panel (hide all others), or restore
  // all panels if it is already the only one visible.
  const isolatePanel = (key: string) => {
    setHiddenPanels(prev => {
      const others = stackPanels.filter(sp => sp.key !== key).map(sp => sp.key);
      const alreadyIsolated = prev.size === others.length && others.every(k => prev.has(k));
      return alreadyIsolated ? new Set<string>() : new Set(others);
    });
  };

  // Merge per-entity series into one row per time bucket: { hour, iso, [entityId]: kwh }.
  const stackedChart = useMemo(() => {
    if (!isStacked || !data?.series) return [];
    const byStart = new Map<string, Record<string, number | string>>();
    for (const s of data.series) {
      for (const p of s.points) {
        let row = byStart.get(p.start);
        if (!row) {
          row = { iso: p.start, hour: isDaily ? formatDay(p.start) : formatHour(p.start) };
          byStart.set(p.start, row);
        }
        row[s.entityId] = Number(p.kwh) || 0;
      }
    }
    const rows = Array.from(byStart.values()).sort((a, b) => ((a.iso as string) < (b.iso as string) ? -1 : 1));
    // Overlay the previous window by position (same as the single-panel chart).
    rows.forEach((row, i) => {
      if (prevPoints[i] !== undefined) row.prevKwh = prevPoints[i].kwh;
    });
    return rows;
  }, [isStacked, data, isDaily, prevPoints]);

  // 100%-stacked variant: each bucket's segments as % of that bucket's total,
  // with the original kWh kept under `__kwh_<entityId>` for the tooltip.
  // Only visible (non-hidden) panels participate, so hiding a panel re-bases
  // the percentages on what's actually shown.
  const percentChart = useMemo(() => {
    if (!isStacked) return [];
    return stackedChart.map(row => {
      const bucketTotal = visibleStackPanels.reduce((s, sp) => s + (Number(row[sp.key]) || 0), 0);
      const out: Record<string, number | string> = { iso: row.iso, hour: row.hour };
      for (const sp of visibleStackPanels) {
        const kwh = Number(row[sp.key]) || 0;
        out[sp.key] = bucketTotal > 0 ? (kwh / bucketTotal) * 100 : 0;
        out[`__kwh_${sp.key}`] = kwh;
      }
      return out;
    });
  }, [isStacked, stackedChart, visibleStackPanels]);

  // Per-panel total kWh + % share for the selected window. Hidden panels are
  // excluded so the shares always describe what the chart is showing.
  const panelTotals = useMemo(() => {
    if (!isStacked || !data?.series) return [];
    const totals = visibleStackPanels.map(sp => {
      const series = data.series?.find(s => s.entityId === sp.key);
      const kwh = series ? series.points.reduce((sum, p) => sum + (Number(p.kwh) || 0), 0) : 0;
      return { ...sp, kwh };
    });
    const windowTotal = totals.reduce((s, t) => s + t.kwh, 0);
    return totals
      .map(t => ({ ...t, share: windowTotal > 0 ? (t.kwh / windowTotal) * 100 : 0 }))
      .sort((a, b) => b.kwh - a.kwh);
  }, [isStacked, data, visibleStackPanels]);

  const isPercentMode = isStacked && stackMode === 'percent';

  // The previous-period series is a whole-window sum (not per-panel), so the
  // comparison is only shown when the chart itself shows the full window:
  // hidden in percent mode (raw kWh doesn't fit a 0–100% axis) and when any
  // panels are hidden (a subset vs. full-window comparison would mislead).
  const compareApplies = !isStacked || hiddenPanels.size === 0;
  const showPrevOverlay = hasPrev && !isPercentMode && compareApplies;

  // Data the stats reflect: when panels are hidden in the stacked view, the
  // totals below the chart track only the visible panels so they match what
  // the chart shows.
  const statsChart = useMemo(() => {
    if (!isStacked || hiddenPanels.size === 0) return chart;
    return stackedChart.map(row => ({
      hour: String(row.hour),
      kwh: visibleStackPanels.reduce((s, sp) => s + (Number(row[sp.key]) || 0), 0),
    }));
  }, [isStacked, hiddenPanels, chart, stackedChart, visibleStackPanels]);

  const stats = useMemo(() => {
    const totalKwh = statsChart.reduce((s, d) => s + d.kwh, 0);
    const rate = data?.currentRate ?? 0;
    const peak = statsChart.reduce((m, d) => (d.kwh > m.kwh ? d : m), { kwh: 0, hour: '—' } as { kwh: number; hour: string });
    // Trend vs the prior equivalent window, always based on the FULL current
    // window (all panels) since the previous series is a whole-window sum.
    // Only meaningful when the previous window actually has usage — otherwise
    // the % would divide by ~zero.
    const fullTotalKwh = chart.reduce((s, d) => s + d.kwh, 0);
    const prevTotalKwh = data?.previous?.totalKwh ?? 0;
    const deltaPct = prevTotalKwh > 0.01 ? ((fullTotalKwh - prevTotalKwh) / prevTotalKwh) * 100 : null;
    // Estimated $ difference vs the previous window, using the same all-in
    // marginal rate as the Est. Cost card. Null when there's no rate to price with.
    const deltaCost = deltaPct != null && rate > 0 ? (fullTotalKwh - prevTotalKwh) * rate : null;
    return {
      totalKwh,
      cost: totalKwh * rate,
      avgKwh: statsChart.length ? totalKwh / statsChart.length : 0,
      peakKwh: peak.kwh,
      peakHour: peak.hour,
      rate,
      prevTotalKwh,
      deltaPct,
      deltaCost,
    };
  }, [statsChart, chart, data]);

  return (
    <Sheet open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {panel && (
          <>
            <SheetHeader>
              <div className="flex items-center gap-2">
                <LayoutGrid className={cn('h-5 w-5', panel.color)} />
                <SheetTitle data-testid="text-panel-history-title">{panel.label}</SheetTitle>
              </div>
              <SheetDescription className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] px-2 py-0">
                  {isDaily ? 'Daily history' : 'Hourly history'}
                </Badge>
                <span className="font-mono text-xs">{rangeWindowLabel}</span>
              </SheetDescription>
            </SheetHeader>

            {/* Range selector */}
            <div className="mt-4 inline-flex items-center gap-1 rounded-lg border border-border/50 bg-muted/20 p-1" role="group" aria-label="History range">
              {(Object.keys(RANGES) as RangeKey[]).map(key => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRange(key)}
                  aria-pressed={range === key}
                  data-testid={`button-range-${key}`}
                  className={cn(
                    'px-3 py-1 text-xs font-medium rounded-md transition-colors',
                    range === key
                      ? 'bg-amber-400 text-black'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                  )}
                >
                  {RANGES[key].label}
                </button>
              ))}
            </div>

            {/* History chart */}
            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">{isDaily ? 'Daily Usage' : 'Hourly Usage'} ({rangeWindowLabel})</p>
                {isStacked && (
                  <div className="inline-flex items-center rounded-md border border-border/50 bg-muted/20 p-0.5" role="group" aria-label="Chart mode">
                    {([['absolute', 'kWh'], ['percent', '%']] as const).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setStackMode(mode)}
                        aria-pressed={stackMode === mode}
                        data-testid={`button-stack-${mode}`}
                        className={cn(
                          'px-2 py-0.5 text-[10px] font-medium rounded transition-colors',
                          stackMode === mode
                            ? 'bg-amber-400 text-black'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {isLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : chart.length === 0 ? (
                <div className="rounded-lg bg-muted/20 border border-border/50 p-6 text-center" data-testid="status-panel-history-empty">
                  <p className="text-sm text-muted-foreground">No {isDaily ? 'daily' : 'hourly'} history available.</p>
                  <p className="text-[11px] text-muted-foreground/60 mt-1">
                    Home Assistant statistics aren't available for this panel yet.
                  </p>
                </div>
              ) : (
                <>
                  <div className="h-52 w-full" data-testid="chart-panel-history">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={isStacked ? (isPercentMode ? percentChart : stackedChart) : chart} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis
                          dataKey="hour"
                          tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                          interval="preserveStartEnd"
                          minTickGap={16}
                        />
                        <YAxis
                          tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                          width={40}
                          domain={isPercentMode ? [0, 100] : undefined}
                          tickFormatter={isPercentMode ? (v: number) => `${v}%` : undefined}
                        />
                        <Tooltip
                          cursor={{ fill: 'hsl(var(--muted) / 0.3)' }}
                          content={<StackedTooltip stacked={isStacked} percentMode={isPercentMode} panels={stackPanels} />}
                        />
                        {isStacked ? (
                          visibleStackPanels.map((sp, i) => (
                            <Bar
                              key={sp.key}
                              dataKey={sp.key}
                              name={sp.label}
                              stackId="panels"
                              fill={sp.hex}
                              radius={i === visibleStackPanels.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
                            />
                          ))
                        ) : (
                          <Bar dataKey="kwh" fill="#fbbf24" radius={[3, 3, 0, 0]} />
                        )}
                        {/* Faint previous-period overlay, aligned by bucket position */}
                        {showPrevOverlay && (
                          <Line
                            type="monotone"
                            dataKey="prevKwh"
                            name="Previous period"
                            stroke="hsl(var(--muted-foreground) / 0.45)"
                            strokeWidth={1.5}
                            strokeDasharray="4 3"
                            dot={false}
                            activeDot={false}
                            connectNulls
                          />
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Previous-period overlay caption */}
                  {showPrevOverlay && (
                    <div className="mt-2 flex items-center gap-1.5" data-testid="caption-prev-period">
                      <span className="inline-block w-4 border-t border-dashed border-muted-foreground/50" />
                      <span className="text-[10px] text-muted-foreground/60">Previous {range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days'}</span>
                    </div>
                  )}

                  {/* Legend: color → panel (whole-house stacked view only).
                      Click toggles a panel; double-click isolates it. */}
                  {isStacked && (
                    <>
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="legend-panel-history">
                        {stackPanels.map(sp => {
                          const hidden = hiddenPanels.has(sp.key);
                          return (
                            <button
                              key={sp.key}
                              type="button"
                              onClick={e => { if (e.detail <= 1) togglePanel(sp.key); }}
                              onDoubleClick={() => isolatePanel(sp.key)}
                              aria-pressed={!hidden}
                              title={hidden ? `Show ${sp.label}` : `Hide ${sp.label} (double-click to isolate)`}
                              data-testid={`legend-item-${sp.key}`}
                              className={cn(
                                'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5 transition-colors hover:bg-muted/40',
                                hidden && 'opacity-40',
                              )}
                            >
                              <span
                                className="inline-block h-2.5 w-2.5 rounded-sm"
                                style={hidden ? { border: `1px solid ${sp.hex}` } : { backgroundColor: sp.hex }}
                              />
                              <span className={cn('text-[11px] text-muted-foreground', hidden && 'line-through')}>{sp.label}</span>
                            </button>
                          );
                        })}
                        {hiddenPanels.size > 0 && (
                          <button
                            type="button"
                            onClick={() => setHiddenPanels(new Set())}
                            data-testid="button-legend-reset"
                            className="text-[11px] font-medium text-amber-400 hover:text-amber-300 transition-colors px-1.5 py-0.5"
                          >
                            Show all
                          </button>
                        )}
                      </div>
                      <p className="mt-1.5 text-[10px] text-muted-foreground/50">
                        Click a panel to hide it · double-click to isolate
                      </p>
                    </>
                  )}

                  {/* Per-panel share of the whole-house total for the selected window */}
                  {isStacked && panelTotals.length > 0 && (
                    <div className="mt-5" data-testid="panel-share-breakdown">
                      <p className="text-xs font-medium text-muted-foreground mb-2">Panel Share ({rangeWindowLabel})</p>
                      <div className="space-y-1.5">
                        {panelTotals.map(t => (
                          <div key={t.key} className="flex items-center gap-2" data-testid={`panel-share-${t.key}`}>
                            <span className="inline-block h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: t.hex }} />
                            <span className="text-xs w-24 truncate shrink-0">{t.label}</span>
                            <div className="flex-1 h-1.5 rounded-full bg-muted/30 overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${Math.min(100, t.share)}%`, backgroundColor: t.hex }}
                              />
                            </div>
                            <span className="text-[11px] font-mono tabular-nums text-muted-foreground w-16 text-right shrink-0">{t.kwh.toFixed(1)} kWh</span>
                            <span className="text-[11px] font-mono tabular-nums font-semibold w-11 text-right shrink-0">{t.share.toFixed(1)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Delta vs the prior equivalent window (e.g. this week vs last week).
                Hidden when panels are filtered out, since the previous series
                always covers the full window. */}
            {chart.length > 0 && stats.deltaPct != null && compareApplies && (
              <div
                className={cn(
                  'mt-4 flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2',
                  stats.deltaPct > 2
                    ? 'border-red-500/30 bg-red-500/10 text-red-400'
                    : stats.deltaPct < -2
                      ? 'border-green-500/30 bg-green-500/10 text-green-400'
                      : 'border-border/50 bg-muted/20 text-muted-foreground',
                )}
                data-testid="text-panel-history-delta"
              >
                {stats.deltaPct > 2 ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : stats.deltaPct < -2 ? (
                  <TrendingDown className="h-3.5 w-3.5" />
                ) : (
                  <Minus className="h-3.5 w-3.5" />
                )}
                <span className="text-xs font-semibold tabular-nums">
                  {stats.deltaPct > 0 ? '+' : ''}{stats.deltaPct.toFixed(0)}%
                </span>
                {stats.deltaCost != null && Math.abs(stats.deltaCost) >= 0.005 && (
                  <span className="text-xs font-semibold tabular-nums" data-testid="text-panel-history-delta-cost">
                    ({stats.deltaCost > 0 ? '+' : '\u2212'}${Math.abs(stats.deltaCost).toFixed(2)})
                  </span>
                )}
                <span className="text-[11px] text-muted-foreground">
                  vs previous {range === '24h' ? '24 hours' : range === '7d' ? '7 days' : '30 days'} ({stats.prevTotalKwh.toFixed(1)} kWh)
                </span>
              </div>
            )}

            {/* Window totals */}
            {chart.length > 0 && (
              <>
                <div className="grid grid-cols-3 gap-2 mt-5">
                  <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Total</p>
                    <p className="text-base font-bold tabular-nums" data-testid="text-panel-history-total">{stats.totalKwh.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">kWh</span></p>
                  </div>
                  <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{isDaily ? 'Daily Avg' : 'Hourly Avg'}</p>
                    <p className="text-base font-bold tabular-nums">{stats.avgKwh.toFixed(isDaily ? 1 : 2)} <span className="text-xs font-normal text-muted-foreground">kWh</span></p>
                  </div>
                  <div className="rounded-lg bg-muted/20 border border-border/50 p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Est. Cost</p>
                    <p className="text-base font-bold tabular-nums text-amber-400">${stats.cost.toFixed(2)}</p>
                  </div>
                </div>
                {stats.peakKwh > 0 && (
                  <p className="text-[11px] text-muted-foreground mt-3 text-center">
                    {isDaily ? 'Peak day' : 'Peak hour'}: <span className="font-semibold text-foreground">{stats.peakHour}</span> at {stats.peakKwh.toFixed(2)} kWh
                  </p>
                )}
              </>
            )}

            {stats.rate > 0 && (
              <p className="text-[10px] text-muted-foreground/50 text-center mt-4">
                Cost estimated at all-in marginal rate of ${stats.rate.toFixed(4)}/kWh
              </p>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
