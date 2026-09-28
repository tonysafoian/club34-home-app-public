import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  DollarSign, Zap, TrendingUp, TrendingDown,
  Calendar, BarChart3, Lightbulb, ArrowRight,
  Loader2, ChevronDown, ChevronRight, AlertTriangle, Flame,
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────
interface TierInfo { tier: number; rate: number; label: string; nextTierAt: number | null }
interface ConsumptionBlock { kwh: number; estimatedCost: number }
interface TierBreakdownItem { kwh: number; cost: number; rate: number }
interface LiveCostData {
  timestamp: string;
  billingCycle: { start: string; daysElapsed: number; totalDays: number; daysRemaining: number };
  currentTier: TierInfo;
  marginalRate: { tierRate: number; allInPerKwh: number; utilityTaxRate: number; stateSurcharge: number };
  live: { watts: number; kw: number; dollarsPerHour: number };
  consumption: { today: ConsumptionBlock; thisWeek: ConsumptionBlock; billingCycleToDate: ConsumptionBlock };
  billEstimate: {
    soFar: number; projected: number; projectedLow: number; projectedHigh: number;
    projectedKwh: number; dailyCost: number; avgDailyKwh: number; lastCycleActual: number | null;
  };
  tierBreakdown: { tier1: TierBreakdownItem; tier2: TierBreakdownItem; tier3: TierBreakdownItem };
  seasonLabel: string;
  isSummer: boolean;
}

interface CircuitBreakdownItem {
  entityId: string; label: string; category: string;
  kwh: number; estimatedCost: number; dailyAvg?: number; pctOfTotal?: number;
}
interface BreakdownData {
  range: string; totalKwh: number; totalEstimatedCost: number;
  currentRate: number; currentTier: number; source?: string;
  topConsumers: CircuitBreakdownItem[];
  circuits: CircuitBreakdownItem[];
}

interface SavingsSuggestion {
  category: string; headline: string; detail: string;
  potentialSavingsPerMonth: number;
}
interface SavingsData {
  currentTier: TierInfo; season: string; isSummer: boolean;
  billTrend: {
    period: string; currentKwh: number; priorYearKwh: number;
    usageDeltaPct: number; dailyDeltaPct: number; excessCostThisCycle: number;
  } | null;
  suggestions: SavingsSuggestion[];
  totalPotentialMonthlySavings: number;
}

// ── Formatting helpers ─────────────────────────────────────────────────
function fmtUSD(n: number): string {
  if (n >= 1000) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}
function fmtKwh(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}
function tierColor(tier: number): string {
  if (tier === 1) return 'text-green-400';
  if (tier === 2) return 'text-yellow-400';
  return 'text-red-400';
}
function tierBg(tier: number): string {
  if (tier === 1) return 'bg-green-500/15 border-green-500/30 text-green-400';
  if (tier === 2) return 'bg-yellow-500/15 border-yellow-500/30 text-yellow-400';
  return 'bg-red-500/15 border-red-500/30 text-red-400';
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

// ── Live Cost Hero ─────────────────────────────────────────────────────
function LiveCostHero({ data }: { data: LiveCostData }) {
  const dph = data.live.dollarsPerHour;
  const marginal = data.marginalRate.allInPerKwh;
  const tier = data.currentTier.tier;
  const low = data.billEstimate.projectedLow;
  const high = data.billEstimate.projectedHigh;

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 via-card to-card p-4 sm:p-5 space-y-4">
      {/* Top row: burn rate + live kW */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium flex items-center gap-1.5">
            <Flame className="h-3 w-3 text-amber-400" /> Live burn rate
          </p>
          <div className="flex items-baseline gap-1.5">
            <span className="text-4xl sm:text-5xl font-bold tabular-nums text-amber-400">
              {fmtUSD(dph)}
            </span>
            <span className="text-base text-muted-foreground font-medium">/hr</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">Live load</p>
          <p className="text-2xl font-bold tabular-nums text-foreground">{data.live.kw} kW</p>
        </div>
      </div>

      {/* Marginal rate chip */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={cn('text-[11px] px-2.5 py-1 font-semibold', tierBg(tier))}>
          Tier {tier} · ${marginal.toFixed(3)}/kWh all-in
        </Badge>
        <Badge variant="outline" className={cn(
          'text-[10px] px-2 py-0.5',
          data.isSummer ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
            : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
        )}>
          {data.seasonLabel} rates
        </Badge>
        <span className="text-[10px] text-muted-foreground ml-auto">true cost of the next kWh</span>
      </div>

      {/* Bottom row: MTD + projected range */}
      <div className="grid grid-cols-2 gap-3 pt-1">
        <div className="rounded-xl bg-muted/20 border border-border/40 p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Cycle to date</p>
          <p className="text-xl font-bold tabular-nums">{fmtUSD(data.billEstimate.soFar)}</p>
          <p className="text-[10px] text-muted-foreground tabular-nums">{fmtKwh(data.consumption.billingCycleToDate.kwh)} kWh</p>
        </div>
        <div className="rounded-xl bg-muted/20 border border-border/40 p-3">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Projected bill</p>
          <p className="text-xl font-bold tabular-nums">{fmtUSD(data.billEstimate.projected)}</p>
          <p className="text-[10px] text-muted-foreground tabular-nums">{fmtUSD(low)}–{fmtUSD(high)} range</p>
        </div>
      </div>
    </div>
  );
}

// ── Cost gauge (scaled to projected / last-cycle) ──────────────────────
function BillGauge({ current, projected, lastCycle, label }: {
  current: number; projected: number; lastCycle: number | null; label: string;
}) {
  // Scale to the larger of projected or last-cycle actual (plus headroom) so
  // ~$25 early in a cycle isn't dwarfed by a fixed $12k axis.
  const target = Math.max(projected, lastCycle ?? 0, current * 1.2, 1);
  const max = target * 1.15;
  const pct = Math.min((current / max) * 100, 100);
  const projPct = Math.min((projected / max) * 100, 100);
  const lastPct = lastCycle ? Math.min((lastCycle / max) * 100, 100) : null;

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">{label}</p>
          <p className="text-3xl font-bold tabular-nums text-foreground">{fmtUSD(current)}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground">projected</p>
          <p className="text-lg font-semibold tabular-nums text-muted-foreground">{fmtUSD(projected)}</p>
        </div>
      </div>
      <div className="relative h-3 rounded-full bg-muted/40 overflow-hidden">
        {/* Last-cycle marker */}
        {lastPct != null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-sky-400/70 z-10"
            style={{ left: `${lastPct}%` }}
            title={`Last cycle ${fmtUSD(lastCycle!)}`}
          />
        )}
        {/* Projected marker */}
        <div
          className="absolute h-full border-r-2 border-dashed border-muted-foreground/50"
          style={{ width: `${projPct}%` }}
        />
        {/* Current fill */}
        <div
          className={cn(
            'h-full rounded-full transition-all duration-700',
            pct > 75 ? 'bg-gradient-to-r from-orange-500 to-red-500'
              : pct > 50 ? 'bg-gradient-to-r from-yellow-500 to-orange-500'
              : 'bg-gradient-to-r from-emerald-500 to-amber-500'
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground/60 tabular-nums">
        <span>$0</span>
        <span>{fmtUSD(max * 0.5)}</span>
        <span>{fmtUSD(max)}</span>
      </div>
      {lastPct != null && (
        <p className="text-[9px] text-sky-400/80 flex items-center gap-1">
          <span className="inline-block h-2 w-0.5 bg-sky-400/70" /> last cycle {fmtUSD(lastCycle!)}
        </p>
      )}
    </div>
  );
}

// ── Tier progress ──────────────────────────────────────────────────────
function TierProgress({ kwh, tier1Max, tier2Max }: { kwh: number; tier1Max: number; tier2Max: number }) {
  const totalMax = Math.max(tier2Max * 1.5, kwh * 1.1);
  const t1Pct = Math.min((tier1Max / totalMax) * 100, 100);
  const t2Pct = Math.min(((tier2Max - tier1Max) / totalMax) * 100, 100);
  const usedPct = Math.min((kwh / totalMax) * 100, 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Tier Usage This Cycle</span>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">{fmtKwh(kwh)} kWh used</span>
      </div>
      <div className="relative h-2.5 rounded-full overflow-hidden flex">
        <div className="h-full bg-green-500/30" style={{ width: `${t1Pct}%` }} />
        <div className="h-full bg-yellow-500/30" style={{ width: `${t2Pct}%` }} />
        <div className="h-full bg-red-500/20 flex-1" />
        <div
          className="absolute h-full rounded-full bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 transition-all duration-700"
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <div className="flex text-[9px] text-muted-foreground/60">
        <span style={{ width: `${t1Pct}%` }} className="text-center">Tier 1</span>
        <span style={{ width: `${t2Pct}%` }} className="text-center">Tier 2</span>
        <span className="flex-1 text-center">Tier 3</span>
      </div>
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────
function StatCard({ label, value, subtext, icon: Icon, accentClass }: {
  label: string; value: string; subtext?: string;
  icon: React.ElementType; accentClass?: string;
}) {
  return (
    <div className="p-3 rounded-xl bg-muted/20 border border-border/50 space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className={cn('h-3.5 w-3.5', accentClass ?? 'text-muted-foreground')} />
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">{label}</p>
      </div>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      {subtext && <p className="text-[10px] text-muted-foreground">{subtext}</p>}
    </div>
  );
}

// ── Top consumers list ─────────────────────────────────────────────────
function TopConsumers({ consumers, maxKwh }: { consumers: CircuitBreakdownItem[]; maxKwh: number }) {
  return (
    <div className="space-y-0">
      <div className="flex items-center gap-2 py-2 border-b border-border/50 mb-1">
        <Badge variant="outline" className="text-[10px] px-2 py-0 bg-red-500/10 text-red-400 border-red-500/30">
          Top Power Consumers
        </Badge>
        <span className="text-[10px] text-muted-foreground ml-auto">This billing cycle</span>
      </div>
      <div className="divide-y divide-border/30">
        {consumers.map((c, i) => (
          <div key={c.entityId} className="py-2.5 space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground/60 w-4 tabular-nums">{i + 1}.</span>
              <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0', CATEGORY_COLORS[c.category] ?? 'text-slate-400')}>
                {c.category}
              </Badge>
              <span className="text-sm flex-1 truncate">{c.label}</span>
              <span className="text-sm font-mono font-semibold tabular-nums text-foreground">{fmtUSD(c.estimatedCost)}</span>
            </div>
            <div className="ml-6">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-muted/40 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-orange-500/70 to-red-500/70 transition-all duration-700"
                    style={{ width: `${maxKwh > 0 ? Math.min((c.kwh / maxKwh) * 100, 100) : 0}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground tabular-nums">{fmtKwh(c.kwh)} kWh</span>
                {c.pctOfTotal != null && (
                  <span className="text-[10px] text-muted-foreground/70 tabular-nums w-9 text-right">{c.pctOfTotal}%</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Savings suggestions ────────────────────────────────────────────────
function SavingsPanel({ data }: { data: SavingsData }) {
  const [expanded, setExpanded] = useState(false);

  if (!data.suggestions.length) return null;

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <Lightbulb className="h-4 w-4 text-amber-400" />
        <span className="text-sm font-semibold flex-1">Savings Opportunities</span>
        <Badge variant="outline" className="text-[10px] px-2 py-0 bg-emerald-500/10 text-emerald-400 border-emerald-500/30">
          ~{fmtUSD(data.totalPotentialMonthlySavings)}/mo
        </Badge>
        {expanded
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        }
      </button>
      {expanded && (
        <div className="space-y-3 pl-1">
          {data.suggestions.map((s, i) => (
            <div key={i} className="p-3 rounded-lg bg-muted/20 border border-border/40 space-y-1">
              <div className="flex items-start gap-2">
                <ArrowRight className="h-3.5 w-3.5 text-emerald-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{s.headline}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{s.detail}</p>
                </div>
                <span className="text-xs font-semibold text-emerald-400 tabular-nums whitespace-nowrap">
                  ~{fmtUSD(s.potentialSavingsPerMonth)}/mo
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Bill comparison ────────────────────────────────────────────────────
function BillHistory() {
  const { data } = useQuery({
    queryKey: ['electricity-comparison'],
    queryFn: () => apiClient.get<{
      comparisons: Array<{
        period: string; kwh: number; days: number;
        ladwpActual: number; ourEstimate: number; variance: string;
      }>;
    }>('/api/electricity/comparison'),
    refetchInterval: 10 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
  });

  if (!data?.comparisons?.length) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Bill History & Accuracy</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border/50">
              <th className="text-left py-1.5 text-muted-foreground font-medium">Period</th>
              <th className="text-right py-1.5 text-muted-foreground font-medium">kWh</th>
              <th className="text-right py-1.5 text-muted-foreground font-medium">LADWP</th>
              <th className="text-right py-1.5 text-muted-foreground font-medium">Ours</th>
              <th className="text-right py-1.5 text-muted-foreground font-medium">Δ</th>
            </tr>
          </thead>
          <tbody>
            {data.comparisons.map((row, i) => (
              <tr key={i} className="border-b border-border/20">
                <td className="py-1.5 text-muted-foreground">{row.period.replace(/\s*–\s*/g, '→').slice(0, 22)}</td>
                <td className="py-1.5 text-right tabular-nums">{row.kwh.toLocaleString()}</td>
                <td className="py-1.5 text-right tabular-nums font-medium">{fmtUSD(row.ladwpActual)}</td>
                <td className="py-1.5 text-right tabular-nums">{fmtUSD(row.ourEstimate)}</td>
                <td className={cn(
                  'py-1.5 text-right tabular-nums font-semibold',
                  row.variance.startsWith('+') ? 'text-red-400' : row.variance.startsWith('-') ? 'text-green-400' : 'text-muted-foreground'
                )}>
                  {row.variance}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main card ──────────────────────────────────────────────────────────
export function ElectricityCostCard() {
  const { data: liveCost, isLoading: loadingCost } = useQuery({
    queryKey: ['electricity-live-cost'],
    queryFn: () => apiClient.get<LiveCostData>('/api/electricity/live-cost', { timeoutMs: 30000 }),
    refetchInterval: 60 * 1000,
    staleTime: 30 * 1000,
  });

  const { data: breakdown } = useQuery({
    queryKey: ['electricity-breakdown'],
    queryFn: () => apiClient.get<BreakdownData>('/api/electricity/breakdown?range=cycle', { timeoutMs: 30000 }),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  const { data: savings } = useQuery({
    queryKey: ['electricity-savings'],
    queryFn: () => apiClient.get<SavingsData>('/api/electricity/savings-suggestions', { timeoutMs: 30000 }),
    refetchInterval: 30 * 60 * 1000,
    staleTime: 15 * 60 * 1000,
  });

  const tier = liveCost?.currentTier?.tier ?? 0;
  const daysElapsed = liveCost?.billingCycle?.daysElapsed ?? 0;
  const daysRemaining = liveCost?.billingCycle?.daysRemaining ?? 0;
  const cyclePct = liveCost ? Math.round((daysElapsed / liveCost.billingCycle.totalDays) * 100) : 0;

  const topConsumers = breakdown?.topConsumers ?? [];
  const maxKwh = topConsumers.length > 0 ? topConsumers[0].kwh : 1;

  return (
    <SystemCard
      title="Electricity Intelligence"
      icon={<DollarSign className="h-6 w-6 text-amber-400" />}
      status={loadingCost ? 'idle' : 'online'}
      statusText={
        loadingCost
          ? 'Loading…'
          : liveCost
            ? `Tier ${tier} · ${fmtUSD(liveCost.live.dollarsPerHour)}/hr · ${fmtUSD(liveCost.billEstimate.soFar)} so far`
            : 'Unavailable'
      }
      accentColor="bg-amber-500/10"
      defaultExpanded={true}
      metrics={[
        { label: '$/hour now', value: loadingCost ? '…' : liveCost ? fmtUSD(liveCost.live.dollarsPerHour) : '—' },
        { label: 'Today', value: loadingCost ? '…' : liveCost ? fmtUSD(liveCost.consumption.today.estimatedCost) : '—' },
        { label: 'Projected', value: loadingCost ? '…' : liveCost ? fmtUSD(liveCost.billEstimate.projected) : '—' },
      ]}
    >
      {loadingCost ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : !liveCost ? (
        <div className="flex flex-col items-center gap-2 py-8">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Unable to load electricity data</p>
          <p className="text-[10px] text-muted-foreground/60">Check HA connection and Emporia energy sensors</p>
        </div>
      ) : (
        <div className="space-y-5 pt-1">
          {/* Live cost hero */}
          <LiveCostHero data={liveCost} />

          {/* Actual LADWP bill trend — intentionally prominent when a material
              whole-house change appears, even before circuit history matures. */}
          {savings?.billTrend && savings.billTrend.dailyDeltaPct >= 10 && (
            <div className="rounded-xl border border-red-500/35 bg-red-500/10 p-4">
              <div className="flex items-start gap-3">
                <TrendingUp className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-red-300">
                    Electricity use jumped {savings.billTrend.dailyDeltaPct}% per day
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {savings.billTrend.period}: {savings.billTrend.currentKwh.toLocaleString()} kWh
                    {' '}vs {savings.billTrend.priorYearKwh.toLocaleString()} kWh last year
                    {' '}({savings.billTrend.usageDeltaPct > 0 ? '+' : ''}{savings.billTrend.usageDeltaPct}% total).
                    The extra usage cost roughly {fmtUSD(savings.billTrend.excessCostThisCycle)} this cycle.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Bill gauge */}
          <div className="p-4 rounded-xl bg-muted/20 border border-border/50">
            <BillGauge
              current={liveCost.billEstimate.soFar}
              projected={liveCost.billEstimate.projected}
              lastCycle={liveCost.billEstimate.lastCycleActual}
              label="Billing Cycle Cost"
            />
          </div>

          {/* Quick stats grid — responsive 2/4 cols, fills cleanly */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <StatCard
              label="Today"
              value={fmtUSD(liveCost.consumption.today.estimatedCost)}
              subtext={`${fmtKwh(liveCost.consumption.today.kwh)} kWh`}
              icon={Zap}
              accentClass="text-amber-400"
            />
            <StatCard
              label="Daily Avg"
              value={fmtUSD(liveCost.billEstimate.dailyCost)}
              subtext={`${liveCost.billEstimate.avgDailyKwh} kWh/day`}
              icon={TrendingUp}
              accentClass="text-blue-400"
            />
            <StatCard
              label="Cycle So Far"
              value={fmtUSD(liveCost.consumption.billingCycleToDate.estimatedCost)}
              subtext={`Day ${daysElapsed} of ${liveCost.billingCycle.totalDays} · ${daysRemaining} left`}
              icon={Calendar}
              accentClass="text-violet-400"
            />
            <StatCard
              label="Marginal Rate"
              value={`$${liveCost.marginalRate.allInPerKwh.toFixed(3)}`}
              subtext={`Tier ${tier} all-in /kWh`}
              icon={BarChart3}
              accentClass={tierColor(tier)}
            />
          </div>

          {/* Season badge + cycle progress */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={cn(
              'text-[10px] px-2 py-0',
              liveCost.isSummer
                ? 'bg-orange-500/15 text-orange-400 border-orange-500/30'
                : 'bg-blue-500/15 text-blue-400 border-blue-500/30'
            )}>
              {liveCost.seasonLabel} Rates
            </Badge>
            <Badge variant="outline" className={cn('text-[10px] px-2 py-0', tierBg(tier))}>
              Tier {tier} — {fmtKwh(liveCost.consumption.billingCycleToDate.kwh)} of {tier === 1 ? '700' : tier === 2 ? '2,100' : '∞'} kWh
            </Badge>
            <span className="text-[10px] text-muted-foreground ml-auto">{cyclePct}% of cycle</span>
          </div>

          {/* Tier progress bar */}
          <TierProgress kwh={liveCost.consumption.billingCycleToDate.kwh} tier1Max={700} tier2Max={2100} />

          {/* Tier cost breakdown */}
          <div className="grid grid-cols-3 gap-2">
            {(['tier1', 'tier2', 'tier3'] as const).map((key, i) => {
              const t = liveCost.tierBreakdown[key];
              const label = `Tier ${i + 1}`;
              return (
                <div key={key} className="p-2.5 rounded-lg bg-muted/15 border border-border/30 text-center space-y-0.5">
                  <p className={cn('text-[10px] font-medium', tierColor(i + 1))}>{label}</p>
                  <p className="text-sm font-bold tabular-nums">{fmtUSD(t.cost)}</p>
                  <p className="text-[9px] text-muted-foreground tabular-nums">{fmtKwh(t.kwh)} kWh · ${t.rate.toFixed(3)}</p>
                </div>
              );
            })}
          </div>

          {/* Daily trend */}
          <div className="p-3 rounded-xl bg-muted/20 border border-border/50 space-y-1">
            <div className="flex items-center gap-2">
              {liveCost.billEstimate.projected > liveCost.billEstimate.soFar * 2
                ? <TrendingUp className="h-3.5 w-3.5 text-red-400" />
                : <TrendingDown className="h-3.5 w-3.5 text-green-400" />
              }
              <span className="text-xs font-medium">Daily Pace</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Averaging <span className="font-semibold text-foreground">{liveCost.billEstimate.avgDailyKwh} kWh/day</span>
              {' '}({fmtUSD(liveCost.billEstimate.dailyCost)}/day).
              At this pace, the bi-monthly bill will be ~<span className="font-semibold text-foreground">{fmtUSD(liveCost.billEstimate.projected)}</span>.
            </p>
          </div>

          {/* Top power consumers */}
          {topConsumers.length > 0 && (
            <TopConsumers consumers={topConsumers} maxKwh={maxKwh} />
          )}

          {/* Savings suggestions */}
          {savings && savings.suggestions.length > 0 && (
            <SavingsPanel data={savings} />
          )}

          {/* Bill comparison table */}
          <BillHistory />

          {/* Footer */}
          <p className="text-[10px] text-muted-foreground/50 text-center pt-1">
            LADWP R-1A · Zone 1 · Bi-monthly · Updated every minute via Emporia Vue
          </p>
        </div>
      )}
    </SystemCard>
  );
}
