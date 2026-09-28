import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Droplets,
  Gauge,
  Lightbulb,
  Loader2,
  Waves,
} from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';

interface WaterLive {
  marginalRate: { tier: number; label: string; perHcf: number; perGallon: number };
  live: { gpm: number; gallonsPerHour: number; dollarsPerHour: number };
  interior: { available: boolean; gpm: number; source: string | null };
  irrigation: {
    zonesRunning: number;
    gpm: number;
    zones: Array<{ entityId: string; label: string; gpm: number }>;
  };
  cycleHcfToDate: number;
}

interface WaterBreakdown {
  totalGallons: number;
  totalHcf: number;
  totalDollars: number;
  interior: { gallons: number; hcf: number; dollars: number };
  irrigation: {
    gallons: number;
    hcf: number;
    dollars: number;
    zones: Array<{ zone: string; label: string; gallons: number; hcf: number; dollars: number }>;
  };
}

interface WaterInsights {
  latestBill: {
    periodStart: string;
    periodEnd: string;
    days: number;
    hcf: number;
    gallons: number;
    waterUsd: number;
    sewerUsd: number;
    solidWasteUsd: number;
    totalNewChargesUsd: number;
  } | null;
  billTrend: {
    priorYearHcf: number;
    usageDeltaPct: number;
    currentDailyGallons: number;
    priorDailyGallons: number;
    dailyDeltaPct: number;
  } | null;
  tier4Opportunity: {
    thresholdHcf: number;
    hcfToCut: number;
    gallonsToCut: number;
    savingsPerCycle: number;
  };
  recentTrend: {
    recentDailyGallons: number;
    previousDailyGallons: number;
    deltaPct: number | null;
    recentDays: number;
    previousDays: number;
  } | null;
  suggestions: Array<{
    category: string;
    headline: string;
    detail: string;
    potentialSavingsPerCycle: number;
  }>;
  totalPotentialCycleSavings: number;
  dataQuality: {
    interiorAvailable: boolean;
    recentDaysCollected: number;
    note: string;
  };
}

function usd(value: number): string {
  return value >= 1000
    ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${value.toFixed(2)}`;
}

function number(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function period(start: string, end: string): string {
  const s = new Date(`${start}T12:00:00Z`);
  const e = new Date(`${end}T12:00:00Z`);
  return `${s.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}–${e.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
}

export function WaterIntelligenceCard() {
  const live = useQuery({
    queryKey: ['water-live'],
    queryFn: () => apiClient.get<WaterLive>('/api/water/live', { timeoutMs: 30000 }),
    refetchInterval: 60 * 1000,
    staleTime: 30 * 1000,
  });
  const breakdown = useQuery({
    queryKey: ['water-breakdown'],
    queryFn: () => apiClient.get<WaterBreakdown>('/api/water/breakdown?range=cycle', { timeoutMs: 30000 }),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });
  const insights = useQuery({
    queryKey: ['water-insights'],
    queryFn: () => apiClient.get<WaterInsights>('/api/water/insights', { timeoutMs: 30000 }),
    refetchInterval: 30 * 60 * 1000,
    staleTime: 15 * 60 * 1000,
  });

  const latest = insights.data?.latestBill;
  const trend = insights.data?.billTrend;
  const opportunity = insights.data?.tier4Opportunity;
  const topZones = breakdown.data?.irrigation.zones.slice(0, 5) ?? [];
  const loading = live.isLoading || insights.isLoading;
  const unavailable = Boolean(live.error && insights.error);
  const liveUnavailable = Boolean(live.error || !live.data);

  return (
    <SystemCard
      title="Water Intelligence"
      icon={<Droplets className="h-6 w-6 text-cyan-400" />}
      status={loading ? 'idle' : unavailable ? 'offline' : 'online'}
      statusText={
        loading ? 'Loading…'
          : liveUnavailable && latest ? `Latest bill ${latest.hcf} HCF · live flow unavailable`
          : latest
            ? `Latest bill ${latest.hcf} HCF · ${usd(latest.waterUsd)}`
            : 'Gathering water data'
      }
      accentColor="bg-cyan-500/10"
      defaultExpanded={true}
      metrics={[
        { label: 'Flow now', value: live.data ? `${live.data.live.gpm.toFixed(1)} GPM` : 'Unavailable' },
        { label: 'Cycle tracked', value: live.data ? `${live.data.cycleHcfToDate.toFixed(1)} HCF` : '—' },
        { label: 'Last water bill', value: latest ? usd(latest.waterUsd) : '—' },
      ]}
    >
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : unavailable ? (
        <div className="flex flex-col items-center gap-2 py-8">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Water intelligence is temporarily unavailable.</p>
        </div>
      ) : (
        <div className="space-y-5 pt-1">
          {trend && trend.dailyDeltaPct >= 3 && latest && (
            <div className="rounded-xl border border-orange-500/35 bg-orange-500/10 p-4">
              <div className="flex items-start gap-3">
                <ArrowUpRight className="h-5 w-5 text-orange-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-orange-300">
                    Water use rose {trend.dailyDeltaPct}% per day year over year
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {period(latest.periodStart, latest.periodEnd)} averaged {number(trend.currentDailyGallons)} gal/day
                    {' '}vs {number(trend.priorDailyGallons)} last year. Total use was {latest.hcf} HCF,
                    {' '}up {trend.usageDeltaPct}% even with a shorter billing period.
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-cyan-500/10 via-card to-card p-4 sm:p-5">
            <div className="flex items-end justify-between gap-4 flex-wrap">
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium flex items-center gap-1.5">
                  <Waves className="h-3 w-3 text-cyan-400" /> Live water flow
                </p>
                <p className="text-4xl sm:text-5xl font-bold tabular-nums text-cyan-400">
                  {live.data ? live.data.live.gpm.toFixed(1) : '—'}
                  <span className="text-base text-muted-foreground font-medium ml-1.5">
                    {live.data ? 'GPM' : 'Unavailable'}
                  </span>
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Live cost</p>
                <p className="text-2xl font-bold tabular-nums">
                  {live.data ? `${usd(live.data.live.dollarsPerHour)}/hr` : 'Unavailable'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-4 flex-wrap">
              {live.data ? (
                <Badge variant="outline" className="bg-cyan-500/15 text-cyan-300 border-cyan-500/30">
                  Tier {live.data.marginalRate.tier} · ${live.data.marginalRate.perGallon.toFixed(4)}/gal
                </Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground border-border">
                  Live telemetry unavailable
                </Badge>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto">
                {!live.data
                  ? 'No live state available'
                  : live.data.irrigation.zonesRunning
                  ? `${live.data.irrigation.zonesRunning} irrigation zone${live.data.irrigation.zonesRunning === 1 ? '' : 's'} running`
                  : 'No irrigation running'}
              </span>
            </div>
          </div>

          {latest && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <Metric label="Latest Bill" value={usd(latest.waterUsd)} detail={`${latest.hcf} HCF · ${number(latest.gallons)} gal`} />
              <Metric label="Daily Average" value={`${number(latest.gallons / latest.days)} gal`} detail={`${usd(latest.waterUsd / latest.days)}/day`} />
              <Metric label="Sewer" value={usd(latest.sewerUsd)} detail="separate from water" />
              <Metric label="Full Utility Bill" value={usd(latest.totalNewChargesUsd)} detail="power, water, sewer & trash" />
            </div>
          )}

          {opportunity && opportunity.hcfToCut > 0 && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
              <div className="flex items-start gap-3">
                <ArrowDownRight className="h-5 w-5 text-emerald-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold">Next-cycle target: stay at or below {opportunity.thresholdHcf} HCF</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Cut {number(opportunity.gallonsToCut)} gallons ({opportunity.hcfToCut.toFixed(0)} HCF)
                    {' '}to avoid Tier 4 and save about {usd(opportunity.savingsPerCycle)} per bill.
                  </p>
                </div>
              </div>
            </div>
          )}

          {insights.data?.recentTrend && (
            <div className="rounded-xl bg-muted/20 border border-border/50 p-3 flex items-center gap-3">
              <Gauge className="h-4 w-4 text-cyan-400 shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-medium">Recent daily pace</p>
                <p className="text-[11px] text-muted-foreground">
                  {number(insights.data.recentTrend.recentDailyGallons)} gal/day vs
                  {' '}{number(insights.data.recentTrend.previousDailyGallons)} in the prior week
                </p>
              </div>
              {insights.data.recentTrend.deltaPct != null && (
                <Badge variant="outline" className={insights.data.recentTrend.deltaPct > 0
                  ? 'text-orange-400 border-orange-500/30 bg-orange-500/10'
                  : 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'}>
                  {insights.data.recentTrend.deltaPct > 0 ? '+' : ''}{insights.data.recentTrend.deltaPct}%
                </Badge>
              )}
            </div>
          )}

          {topZones.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Highest-cost irrigation zones this cycle</p>
              <div className="divide-y divide-border/30">
                {topZones.map(zone => (
                  <div key={zone.zone} className="flex items-center gap-3 py-2">
                    <span className="text-sm flex-1 truncate">{zone.label}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{number(zone.gallons)} gal</span>
                    <span className="text-xs text-cyan-300 font-medium tabular-nums">{usd(zone.dollars)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {insights.data && insights.data.suggestions.length > 0 && (
            <div className="space-y-2.5">
              <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Lightbulb className="h-3.5 w-3.5 text-amber-400" /> Active savings suggestions
              </p>
              {insights.data.suggestions.map(suggestion => (
                <div key={suggestion.headline} className="rounded-lg bg-muted/20 border border-border/50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold">{suggestion.headline}</p>
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{suggestion.detail}</p>
                    </div>
                    <Badge variant="outline" className="text-emerald-400 border-emerald-500/30 bg-emerald-500/10 shrink-0">
                      {usd(suggestion.potentialSavingsPerCycle)}/bill
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          )}

          {insights.data && !insights.data.dataQuality.interiorAvailable && (
            <p className="text-[10px] text-muted-foreground/70 text-center">
              {insights.data.dataQuality.note} Bill-level totals remain authoritative.
            </p>
          )}
        </div>
      )}
    </SystemCard>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl bg-muted/20 border border-border/50 p-3">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">{label}</p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{detail}</p>
    </div>
  );
}