import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, Gauge, Lightbulb, Loader2, TrendingUp } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUserRole } from '@/hooks/useUserRole';

type Confidence = 'high' | 'medium' | 'low';

interface DataQuality {
  expectedDays: number;
  observedDays: number;
  usableFullDays: number;
  missingDates: string[];
  partialDates: string[];
  coveragePct: number;
  level: 'good' | 'limited' | 'poor';
  message: string;
}

interface InsightsNotReady {
  ready: false;
  daysCollected: number;
  minDays: number;
  targetDays: number;
  message: string;
  dataQuality?: DataQuality;
  investigatedFindings?: Finding[];
}

interface Finding {
  id: string;

  type: string;

  observation: string;

  whyItMatters: string;

  evidence: { windowStart: string; windowEnd: string; metrics: Record<string, number | string> };

  confidence: Confidence;

  dataQuality: DataQuality['level'];

  suggestedAction: string;

  savingsRange: { low: number; high: number; unit: 'dollars_per_month' };

  context?: Array<{
    signal: 'outdoor-temperature' | 'occupancy';
    label: string;
    correlation: number;
    sampleDays: number;
    coveragePct: number;
    direction: 'aligned' | 'inverse';
    summary: string;

  }>;

  investigation?: {
    actionDate: string;
    investigatedAt: string;
    realized: {
      status: 'measured' | 'awaiting-after-period' | 'incomplete-data';
      marginalRatePerKwh: number;
      beforeStart: string; beforeEnd: string; afterStart: string; afterEnd: string;
      beforeAverageKwhPerDay: number | null; afterAverageKwhPerDay: number | null;
      measuredChangeKwhPerDay: number | null; measuredChangePct: number | null;
      realizedSavingsPerMonth: number | null; normalVariabilityKwhPerDay: number | null;
      exceedsNormalVariability: boolean | null; interpretation: string;
    };
  };

  occurrenceId: string;

  tariffTier: number;

  measurementScope: { type: 'property' | 'circuit' | 'category'; label: string; entityIds: string[] };
}

interface CircuitDriver {
  entityId: string;
  label: string;
  category: string;
  averageKwhPerDay: number;
  baseKwhPerDay: number;
  deltaKwhPerDay: number | null;
}

interface InsightsReady {
  ready: true;
  season: string;
  targetDays: number;
  windowStart: string;
  windowEnd: string;
  marginalRatePerKwh: number;
  currentTier: number | null;
  dataQuality: DataQuality;
  findings: Finding[];
  investigatedFindings: Finding[];
  summary: {
    usableDays: number;
    totalAverageKwhPerDay: number;
    baseLoadKwhPerDay: number;
    baseLoadMonthlyCost: number;
    variability: { medianKwhPerDay: number; p10KwhPerDay: number; p90KwhPerDay: number; robustRangeKwhPerDay: number };
    recentVsPrior: {
      recentDays: number;
      priorDays: number;
      recentAverageKwhPerDay: number | null;
      priorAverageKwhPerDay: number | null;
      deltaKwhPerDay: number | null;
      deltaPct: number | null;
    };
    weekdayWeekend: {
      weekdayDays: number;
      weekendDays: number;
      weekdayAverageKwhPerDay: number | null;
      weekendAverageKwhPerDay: number | null;
      deltaKwhPerDay: number | null;
    };
    unusualHighUseDays: Array<{ date: string; kwh: number; excessKwh: number }>;
    circuitDrivers: CircuitDriver[];
  };
}

type InsightsData = InsightsNotReady | InsightsReady;

function isReady(data: InsightsData): data is InsightsReady {
  return data.ready;
}

function confidenceStyle(confidence: Confidence) {
  if (confidence === 'high') return 'border-green-500/30 bg-green-500/10 text-green-400';
  if (confidence === 'medium') return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
  return 'border-slate-500/30 bg-slate-500/10 text-slate-300';
}

function formatDate(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function EnergyInsightsCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['energy-insights'],
    queryFn: () => apiClient.get<InsightsData>('/api/electricity/insights', { timeoutMs: 30000 }),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  return (
    <SystemCard
      title="Energy Insights"
      icon={<Lightbulb className="h-6 w-6 text-amber-400" />}
      status={isLoading ? 'idle' : error ? 'offline' : 'online'}
      statusText={isLoading ? 'Loading…' : error ? 'Unavailable' : data?.ready ? `${data.findings.length} findings` : 'Gathering data'}
      accentColor="bg-amber-500/10"
      defaultExpanded
    >
      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : error || !data ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Insights are temporarily unavailable.</p>
      ) : isReady(data) ? <ReadyInsights data={data} /> : <GatheringData data={data} />}
    </SystemCard>
  );
}

function GatheringData({ data }: { data: InsightsNotReady }) {
  const { isAdmin } = useUserRole();
  const pct = Math.min((data.daysCollected / data.targetDays) * 100, 100);
  return (
    <div className="space-y-4 py-6 text-center">
      <CalendarDays className="mx-auto h-10 w-10 text-amber-400/60" />
      <div>
        <p className="font-semibold">Gathering complete daily readings</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{data.message}</p>
      </div>
      <div className="mx-auto max-w-xs space-y-1.5">
        <div className="h-2 overflow-hidden rounded-full bg-muted/50">
          <div className="h-full rounded-full bg-amber-500" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs tabular-nums text-muted-foreground">
          {data.daysCollected} complete days · analysis starts at {data.minDays}
        </p>
      </div>
      {data.dataQuality && (data.dataQuality.partialDates.length > 0 || data.dataQuality.missingDates.length > 0) && (
        <p className="mx-auto max-w-md text-xs text-muted-foreground">
          {data.dataQuality.partialDates.length} partial and {data.dataQuality.missingDates.length} missing days are excluded rather than counted as zero.
        </p>
      )}
      {data.investigatedFindings && data.investigatedFindings.length > 0 && (
        <div className="space-y-2 pt-4 text-left">
          <p className="text-sm font-semibold">Investigated findings</p>
          {data.investigatedFindings.map(finding => (
            <FindingCard key={finding.occurrenceId} finding={finding} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReadyInsights({ data }: { data: InsightsReady }) {
  const { isAdmin } = useUserRole();
  const trend = data.summary.recentVsPrior;
  const topBase = [...data.summary.circuitDrivers].sort((a, b) => b.baseKwhPerDay - a.baseKwhPerDay).slice(0, 4);

  return (
    <div className="space-y-6 pt-1">
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric icon={<Gauge className="h-4 w-4" />} label="Robust base load" value={`${data.summary.baseLoadKwhPerDay.toFixed(1)} kWh/day`} detail={`≈ $${data.summary.baseLoadMonthlyCost.toFixed(0)}/month at current margin`} />
        <Metric icon={<TrendingUp className="h-4 w-4" />} label="Recent change" value={trend.deltaPct == null ? 'Not enough data' : `${trend.deltaPct >= 0 ? '+' : ''}${trend.deltaPct.toFixed(0)}%`} detail={`${trend.recentDays} recent vs ${trend.priorDays} prior complete days`} />
        <Metric icon={<CalendarDays className="h-4 w-4" />} label="Usable history" value={`${data.dataQuality.usableFullDays} of 30 days`} detail={`${data.dataQuality.coveragePct.toFixed(0)}% complete coverage`} />
      </div>

      {data.dataQuality.level !== 'good' && (
        <div className="flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <span>{data.dataQuality.message} Findings are shown with reduced confidence.</span>
        </div>
      )}

      <section className="space-y-2.5">
        <div>
          <p className="text-sm font-semibold">Prioritized findings</p>
          <p className="text-xs text-muted-foreground">Measured observations are separated from actions to investigate.</p>
        </div>
        {data.findings.length === 0 ? (
          <div className="rounded-lg border border-border/50 bg-muted/20 p-4 text-sm text-muted-foreground">
            No material pattern crossed the evidence thresholds in this window.
          </div>
        ) : data.findings.map(finding => <FindingCard key={finding.id} finding={finding} isAdmin={isAdmin} />)}
      </section>

      {data.investigatedFindings.length > 0 && (
        <section className="space-y-2.5">
          <div>
            <p className="text-sm font-semibold">Investigated findings</p>
            <p className="text-xs text-muted-foreground">Saved occurrences remain here even after the original pattern is no longer active.</p>
          </div>
          {data.investigatedFindings.map(finding => (
            <FindingCard key={finding.occurrenceId} finding={finding} isAdmin={isAdmin} />
          ))}
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Base-load contributors</p>
          {topBase.map(circuit => (
            <div key={circuit.entityId} className="flex items-center gap-2 border-b border-border/30 py-2 last:border-0">
              <span className="min-w-0 flex-1 truncate text-sm">{circuit.label}</span>
              <Badge variant="outline" className="text-[9px]">{circuit.category}</Badge>
              <span className="text-xs tabular-nums text-muted-foreground">{circuit.baseKwhPerDay.toFixed(1)} kWh/d</span>
            </div>
          ))}
        </section>
        <section className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Unusual complete days</p>
          {data.summary.unusualHighUseDays.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No robust high-use outliers found.</p>
          ) : data.summary.unusualHighUseDays.slice(0, 4).map(day => (
            <div key={day.date} className="flex justify-between border-b border-border/30 py-2 text-sm last:border-0">
              <span>{formatDate(day.date)}</span>
              <span className="tabular-nums text-muted-foreground">{day.kwh.toFixed(1)} kWh · +{day.excessKwh.toFixed(1)} vs median</span>
            </div>
          ))}
        </section>
      </div>

      <p className="text-center text-[10px] text-muted-foreground/60">
        {formatDate(data.windowStart)}–{formatDate(data.windowEnd)} · LADWP Tier {data.currentTier ?? '—'} all-in marginal rate ${data.marginalRatePerKwh.toFixed(4)}/kWh · no time-of-use discount assumed
      </p>
    </div>
  );
}

function Metric({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
      <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{icon}{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function FindingCard({ finding, isAdmin }: { finding: Finding; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [actionDate, setActionDate] = useState(finding.investigation?.actionDate ?? '');
  const save = useMutation({
    mutationFn: () => apiClient.patch(`/api/electricity/insights/${encodeURIComponent(finding.id)}/investigation`, {
      actionDate,
      occurrenceId: finding.occurrenceId,
      tariffTier: finding.tariffTier,
      finding: {
        id: finding.id,
        type: finding.type,
        observation: finding.observation,
        whyItMatters: finding.whyItMatters,
        evidence: finding.evidence,
        confidence: finding.confidence,
        dataQuality: finding.dataQuality,
        suggestedAction: finding.suggestedAction,
        savingsRange: finding.savingsRange,
        estimatedSavings: finding.savingsRange,
      },
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['energy-insights'] }),
  });
  const measuredCost = Number(finding.evidence.metrics.measuredMonthlyCost ?? 0);
  const measuredKwh = Number(finding.evidence.metrics.monthlyExposureKwh ?? 0);
  const realized = finding.investigation?.realized;
  return (
    <article className="rounded-lg border border-border/50 bg-muted/20 p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-sm font-semibold">{finding.observation}</p>
        <div className="flex gap-1.5">
          <Badge variant="outline" className={`text-[9px] capitalize ${confidenceStyle(finding.confidence)}`}>{finding.confidence} confidence</Badge>
          {finding.savingsRange.high > 0 && (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[9px] text-amber-400">
              $0–${finding.savingsRange.high.toFixed(0)}/mo to verify
            </Badge>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{finding.whyItMatters}</p>
      {finding.context && finding.context.length > 0 && (
        <div className="mt-2 rounded-md border border-sky-500/20 bg-sky-500/5 p-2.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-sky-300">Context, not proof of causation</p>
          {finding.context.map(context => (
            <p key={context.signal} className="mt-1 text-xs text-muted-foreground">
              {context.summary} Coverage: {context.coveragePct.toFixed(0)}%.
            </p>
          ))}
        </div>
      )}
      {(measuredCost > 0 || measuredKwh > 0) && (
        <p className="mt-2 text-xs font-medium tabular-nums">
          Measured impact: {measuredKwh.toFixed(0)} kWh · ${measuredCost.toFixed(0)} per month if the observed pattern continues
        </p>
      )}
      <div className="mt-3 rounded-md border border-border/30 bg-background/30 p-2.5">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Suggested next step</p>
        <p className="mt-1 text-xs">{finding.suggestedAction}</p>
      </div>
      {finding.investigation && realized && (
        <div className="mt-3 rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-xs">
          <p className="font-medium">Investigated · change recorded {formatDate(finding.investigation.actionDate)}</p>
          <p className="mt-1 text-muted-foreground">Measurement scope: {finding.measurementScope.label}</p>
          {realized.status === 'measured' ? (
            <>
              <p className="mt-1 tabular-nums">
                {realized.beforeAverageKwhPerDay?.toFixed(1)} → {realized.afterAverageKwhPerDay?.toFixed(1)} kWh/day
                {' '}({(realized.measuredChangePct ?? 0) >= 0 ? '+' : ''}{realized.measuredChangePct?.toFixed(1)}%)
              </p>
              <p className="mt-1 font-medium">
                Measured realized savings: ${(realized.realizedSavingsPerMonth ?? 0).toFixed(0)}/month at the matched-period tariff (${realized.marginalRatePerKwh.toFixed(4)}/kWh)
              </p>
              <p className="mt-1 text-muted-foreground">{realized.interpretation}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Matched complete periods: {formatDate(realized.beforeStart)}–{formatDate(realized.beforeEnd)} vs {formatDate(realized.afterStart)}–{formatDate(realized.afterEnd)} · baseline variability ±{realized.normalVariabilityKwhPerDay?.toFixed(1)} kWh/day
              </p>
            </>
          ) : <p className="mt-1 text-muted-foreground">{realized.interpretation}</p>}
        </div>
      )}
      {isAdmin && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Change date
            <Input className="h-8 w-40 text-xs" type="date" value={actionDate} onChange={event => setActionDate(event.target.value)} />
          </label>
          <Button size="sm" variant="outline" className="h-8" disabled={!actionDate || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : finding.investigation ? 'Update investigation' : 'Mark investigated'}
          </Button>
          {save.isError && <span className="text-xs text-red-400">Could not save the investigation.</span>}
        </div>
      )}
      <p className="mt-2 text-[10px] text-muted-foreground/70">
        Evidence: {formatDate(finding.evidence.windowStart)}–{formatDate(finding.evidence.windowEnd)} · savings range is $0 to the measured cost exposure, not a forecast
      </p>
    </article>
  );
}
