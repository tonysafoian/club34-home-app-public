/**
 * Pure analysis of completed, per-circuit daily energy snapshots.
 *
 * This module deliberately knows nothing about Home Assistant, the database, or
 * circuit names.  In particular, callers must provide the canonical leaf
 * circuit ids.  That is what keeps a panel total and its child circuits from
 * being counted together.
 */

export type NumericValue = number | string;
export type DateValue = string | Date;

export interface EnergyDailyRow {
  date: DateValue;
  entity: string;
  label: string;
  category: string;
  kWh: NumericValue;
}

/** Useful when passing rows directly from a database result. */
export interface EnergyDailyDbRow {
  date?: DateValue;
  usage_date?: DateValue;
  entity?: string;
  entityId?: string;
  entity_id?: string;
  label?: string;
  category?: string;
  kWh?: NumericValue;
  kwh?: NumericValue;
}

export interface MarginalRateContext {
  /** All-in marginal dollars per kWh, including applicable taxes/surcharges. */
  ratePerKwh?: NumericValue;
  marginalRatePerKwh?: NumericValue;
  rate?: NumericValue;
  currentTier?: number | string;
  tier?: number | string;
  label?: string;
}

export interface EnergyInsightsInput {
  rows: readonly (EnergyDailyRow | EnergyDailyDbRow)[];
  canonicalLeafIds?: readonly string[];
  /** Alias accepted for callers that use the API wording. */
  expectedCanonicalLeafIds?: readonly string[];
  /** Alias accepted by callers that distinguish the analysis date from the query date. */
  canonicalLeafCircuitIds?: readonly string[];
  endDate?: DateValue;
  analysisEndDate?: DateValue;
  marginalRate?: NumericValue | MarginalRateContext;
  marginalAllInRate?: NumericValue | MarginalRateContext;
  currentTierContext?: MarginalRateContext | number | string;
  dailyContext?: readonly EnergyDailyContextRow[];
}

export interface EnergyDailyContextRow {
  date: DateValue;
  averageOutdoorTempF?: NumericValue;
  occupiedHours?: NumericValue;
  occupancyCoverageHours?: NumericValue;
}

export interface EnergyCorrelationContext {
  signal: 'outdoor-temperature' | 'occupancy';
  label: string;
  correlation: number;
  sampleDays: number;
  coveragePct: number;
  direction: 'aligned' | 'inverse';
  summary: string;
}

export type FindingConfidence = 'high' | 'medium' | 'low';
export type DataQualityLevel = 'good' | 'limited' | 'poor';

export interface SavingsRange {
  low: number;
  high: number;
  unit: 'dollars_per_month';
}

export interface FindingEvidence {
  windowStart: string;
  windowEnd: string;
  metrics: Record<string, number | string>;
}

export interface EnergyFinding {
  /** Stable identifier; it must not contain a display label. */
  id: string;
  type: 'base-load' | 'recent-change' | 'unusual-day' | 'weekday-weekend' | 'circuit-driver' | 'category-driver';
  observation: string;
  whyItMatters: string;
  evidence: FindingEvidence;
  confidence: FindingConfidence;
  dataQuality: DataQualityLevel;
  suggestedAction: string;
  savingsRange: SavingsRange;
  /** Compatibility-friendly alias for consumers that call this an opportunity. */
  estimatedSavings: SavingsRange;
  context?: EnergyCorrelationContext[];
}

export interface FindingMeasurementScope {
  type: 'property' | 'circuit' | 'category';
  label: string;
  entityIds: string[];
}
export interface CircuitSummary {
  entityId: string;
  label: string;
  category: string;
  averageKwhPerDay: number;
  baseKwhPerDay: number;
  recentAverageKwhPerDay: number | null;
  priorAverageKwhPerDay: number | null;
  deltaKwhPerDay: number | null;
  deltaPct: number | null;
}

export interface CategorySummary {
  category: string;
  averageKwhPerDay: number;
  recentAverageKwhPerDay: number | null;
  priorAverageKwhPerDay: number | null;
  deltaKwhPerDay: number | null;
}

export interface EnergyDataQuality {
  expectedDays: number;
  observedDays: number;
  usableFullDays: number;
  missingDates: string[];
  partialDates: string[];
  coveragePct: number;
  level: DataQualityLevel;
  message: string;
}

export interface EnergyInsightsResult {
  ready: boolean;
  endDate: string;
  windowStart: string;
  windowEnd: string;
  marginalRatePerKwh: number;
  currentTier: number | null;
  dataQuality: EnergyDataQuality;
  summary: {
    usableDays: number;
    totalAverageKwhPerDay: number;
    baseLoadKwhPerDay: number;
    baseLoadMonthlyCost: number;
    variability: {
      medianKwhPerDay: number;
      p10KwhPerDay: number;
      p90KwhPerDay: number;
      madKwhPerDay: number;
      robustRangeKwhPerDay: number;
    };
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
    circuitDrivers: CircuitSummary[];
    categoryDrivers: CategorySummary[];
  };
  findings: EnergyFinding[];
}

export interface RealizedSavingsResult {
  status: 'measured' | 'awaiting-after-period' | 'incomplete-data';
  actionDate: string;
  beforeStart: string;
  beforeEnd: string;
  afterStart: string;
  afterEnd: string;
  daysPerPeriod: 14;
  marginalRatePerKwh: number;
  beforeAverageKwhPerDay: number | null;
  afterAverageKwhPerDay: number | null;
  measuredChangeKwhPerDay: number | null;
  measuredChangePct: number | null;
  realizedSavingsPerMonth: number | null;
  normalVariabilityKwhPerDay: number | null;
  exceedsNormalVariability: boolean | null;
  interpretation: string;
}

export function findingOccurrenceId(finding: Pick<EnergyFinding, 'id' | 'evidence'>): string {
  return `${finding.id}:${finding.evidence.windowStart}:${finding.evidence.windowEnd}`;
}
interface NormalizedRow {
  date: string;
  entityId: string;
  label: string;
  category: string;
  kwh: number;
}

interface UsableDay {
  date: string;
  values: Map<string, NormalizedRow>;
  total: number;
}

const DAY_MS = 86_400_000;
const MAX_FINDINGS = 4;
const MIN_READY_DAYS = 14;
const MIN_CONTEXT_DAYS = 14;
const MIN_CONTEXT_COVERAGE = 0.8;
const MIN_CONTEXT_CORRELATION = 0.35;

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isoDate(value: unknown): string | null {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  // Date-only values are parsed as UTC.  For timestamps, use the instant's UTC
  // date; callers querying LA-local rows should pass the date column itself.
  const dateOnly = value.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  if (dateOnly) {
    const candidate = dateOnly[1];
    const parsed = new Date(`${candidate}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
      ? candidate
      : null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function addDays(date: string, amount: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(d.getTime() + amount * DAY_MS).toISOString().slice(0, 10);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function percentile(input: readonly number[], p: number): number {
  if (!input.length) return 0;
  const values = [...input].sort((a, b) => a - b);
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function median(input: readonly number[]): number {
  return percentile(input, 0.5);
}

function average(input: readonly number[]): number | null {
  return input.length ? input.reduce((sum, value) => sum + value, 0) / input.length : null;
}

function correlation(pairs: readonly [number, number][]): number | null {
  if (pairs.length < MIN_CONTEXT_DAYS) return null;
  const xs = pairs.map(([x]) => x);
  const ys = pairs.map(([, y]) => y);
  const xMean = average(xs) ?? 0;
  const yMean = average(ys) ?? 0;
  const numerator = pairs.reduce((sum, [x, y]) => sum + (x - xMean) * (y - yMean), 0);
  const xSpread = Math.sqrt(xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0));
  const ySpread = Math.sqrt(ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0));
  if (xSpread < 0.000001 || ySpread < 0.000001) return null;
  return numerator / (xSpread * ySpread);
}

function deltaPct(recent: number | null, prior: number | null): number | null {
  if (recent === null || prior === null || Math.abs(prior) < 0.000001) return null;
  return (recent - prior) / Math.abs(prior) * 100;
}

function getRate(input: EnergyInsightsInput): number {
  const source = input.marginalRate ?? input.marginalAllInRate ?? input.currentTierContext;
  if (typeof source === 'object' && source !== null) {
    return finiteNumber(source.ratePerKwh ?? source.marginalRatePerKwh ?? source.rate) ?? 0;
  }
  return finiteNumber(source) ?? 0;
}

function getTier(input: EnergyInsightsInput): number | null {
  const source = input.currentTierContext;
  const context = typeof source === 'object' && source !== null ? source : input.marginalRate;
  if (typeof context === 'object' && context !== null) {
    return finiteNumber(context.currentTier ?? context.tier);
  }
  return finiteNumber(context);
}

function qualityFor(usable: number, expected: number): DataQualityLevel {
  if (usable >= Math.max(MIN_READY_DAYS, expected * 0.8)) return 'good';
  if (usable >= 7) return 'limited';
  return 'poor';
}

function confidenceFor(usable: number, effect: number, baseline: number): FindingConfidence {
  const relative = baseline > 0 ? Math.abs(effect) / baseline : 0;
  if (usable >= 21 && relative >= 0.15) return 'high';
  if (usable >= 14 && relative >= 0.08) return 'medium';
  return 'low';
}

function exposureRange(rate: number, monthlyKwhExposure: number): SavingsRange {
  const base = Math.max(0, monthlyKwhExposure) * Math.max(0, rate);
  return {
    low: 0,
    high: round(base),
    unit: 'dollars_per_month',
  };
}

function noSavings(): SavingsRange {
  return { low: 0, high: 0, unit: 'dollars_per_month' };
}

function actionFor(entityId: string, label: string): string {
  return `Review the measured daily pattern for ${label || entityId} and verify its schedule, controls, and operating state before changing anything.`;
}

function finding(
  values: Omit<EnergyFinding, 'estimatedSavings'>,
): EnergyFinding {
  return { ...values, estimatedSavings: values.savingsRange };
}

/**
 * Compare matched two-week periods around an admin-recorded change date.
 * The change date is excluded, each period has the same weekday mix, and no
 * result is measured unless every canonical circuit exists on all 28 days.
 */
export function measureRealizedSavings(input: {
  rows: readonly (EnergyDailyRow | EnergyDailyDbRow)[];
  canonicalLeafIds: readonly string[];
  actionDate: DateValue;
  marginalRate: NumericValue;
  latestCompleteDate?: DateValue;
}): RealizedSavingsResult {
  const actionDate = isoDate(input.actionDate) ?? '';
  const latestCompleteDate = isoDate(input.latestCompleteDate) ?? new Date().toISOString().slice(0, 10);
  const beforeStart = actionDate ? addDays(actionDate, -14) : '';
  const beforeEnd = actionDate ? addDays(actionDate, -1) : '';
  const afterStart = actionDate ? addDays(actionDate, 1) : '';
  const afterEnd = actionDate ? addDays(actionDate, 14) : '';
  const rate = Math.max(0, finiteNumber(input.marginalRate) ?? 0);
  const base = {
    actionDate, beforeStart, beforeEnd, afterStart, afterEnd, daysPerPeriod: 14 as const,
    marginalRatePerKwh: round(rate, 5),
    beforeAverageKwhPerDay: null, afterAverageKwhPerDay: null,
    measuredChangeKwhPerDay: null, measuredChangePct: null,
    realizedSavingsPerMonth: null, normalVariabilityKwhPerDay: null,
    exceedsNormalVariability: null,
  };
  if (!actionDate || latestCompleteDate < afterEnd) {
    return {
      ...base,
      status: 'awaiting-after-period',
      interpretation: `Waiting for the complete after period through ${afterEnd}.`,
    };
  }

  const ids = [...new Set(input.canonicalLeafIds.filter(Boolean))];
  const totals = new Map<string, Map<string, number>>();
  for (const raw of input.rows) {
    const row = raw as EnergyDailyDbRow;
    const date = isoDate(row.date ?? row.usage_date);
    const entityId = String(row.entity ?? row.entityId ?? row.entity_id ?? '');
    const kwh = finiteNumber(row.kWh ?? row.kwh);
    if (!date || date < beforeStart || date > afterEnd || date === actionDate || !ids.includes(entityId) || kwh === null || kwh < 0) continue;
    const values = totals.get(date) ?? new Map<string, number>();
    if (!values.has(entityId)) values.set(entityId, kwh);
    totals.set(date, values);
  }
  const periodTotals = (start: string) => Array.from({ length: 14 }, (_, offset) => addDays(start, offset))
    .map(date => {
      const values = totals.get(date);
      return values && ids.length > 0 && ids.every(id => values.has(id))
        ? ids.reduce((sum, id) => sum + (values.get(id) ?? 0), 0)
        : null;
    });
  const before = periodTotals(beforeStart);
  const after = periodTotals(afterStart);
  if (before.some(value => value === null) || after.some(value => value === null)) {
    return {
      ...base,
      status: 'incomplete-data',
      interpretation: 'The matched periods contain missing or partial circuit days, so realized savings are not estimated.',
    };
  }
  const beforeValues = before as number[];
  const afterValues = after as number[];
  const beforeAverage = average(beforeValues) ?? 0;
  const afterAverage = average(afterValues) ?? 0;
  const change = afterAverage - beforeAverage;
  const variability = median(beforeValues.map(value => Math.abs(value - median(beforeValues))));
  const exceeds = Math.abs(change) > Math.max(variability * 2, beforeAverage * 0.05);
  const monthlySavings = Math.max(0, -change * 30 * rate);
  return {
    ...base,
    status: 'measured',
    beforeAverageKwhPerDay: round(beforeAverage),
    afterAverageKwhPerDay: round(afterAverage),
    measuredChangeKwhPerDay: round(change),
    measuredChangePct: round(deltaPct(afterAverage, beforeAverage) ?? 0, 1),
    realizedSavingsPerMonth: round(monthlySavings),
    normalVariabilityKwhPerDay: round(variability),
    exceedsNormalVariability: exceeds,
    interpretation: exceeds
      ? 'The measured change is larger than normal baseline variability, but the action cannot be treated as the only cause.'
      : 'The measured change is within normal baseline variability, so savings cannot be separated from unrelated variation.',
  };
}
/**
 * Analyze the inclusive 30-day window ending at `endDate`.
 *
 * A day is usable only when every canonical leaf circuit has one valid,
 * non-negative reading.  Missing/partial days are reported but never filled or
 * silently treated as zero.
 */
export function analyzeEnergyInsights(input: EnergyInsightsInput): EnergyInsightsResult {
  const end = isoDate(input.endDate ?? input.analysisEndDate) ?? new Date().toISOString().slice(0, 10);
  const windowStart = addDays(end, -29);
  const expectedIds = [...new Set((input.canonicalLeafIds ?? input.expectedCanonicalLeafIds ?? input.canonicalLeafCircuitIds ?? []).filter(Boolean))];
  const rowsByDate = new Map<string, Map<string, NormalizedRow>>();
  const observedDates = new Set<string>();

  for (const raw of input.rows ?? []) {
    const row = raw as EnergyDailyDbRow;
    const date = isoDate(row.date ?? row.usage_date);
    const entityId = String(row.entity ?? row.entityId ?? row.entity_id ?? '');
    const kwh = finiteNumber(row.kWh ?? row.kwh);
    if (!date || date < windowStart || date > end || !entityId || kwh === null || kwh < 0) continue;
    observedDates.add(date);
    if (!expectedIds.includes(entityId)) continue;
    const values = rowsByDate.get(date) ?? new Map<string, NormalizedRow>();
    // Duplicate rows for the same leaf/day are not allowed to inflate totals.
    // Keep the first valid snapshot, as there is no timestamp with which to
    // establish an ordering.
    if (!values.has(entityId)) {
      values.set(entityId, {
        date,
        entityId,
        label: String(row.label ?? entityId),
        category: String(row.category ?? 'Other'),
        kwh,
      });
    }
    rowsByDate.set(date, values);
  }

  const missingDates: string[] = [];
  const partialDates: string[] = [];
  const completeCandidates: UsableDay[] = [];
  for (let offset = 0; offset < 30; offset += 1) {
    const date = addDays(windowStart, offset);
    const values = rowsByDate.get(date);
    if (!values) {
      missingDates.push(date);
      continue;
    }
    if (expectedIds.length === 0 || expectedIds.some(id => !values.has(id))) {
      partialDates.push(date);
      continue;
    }
    const total = expectedIds.reduce((sum, id) => sum + (values.get(id)?.kwh ?? 0), 0);
    completeCandidates.push({ date, values, total });
  }

  // Snapshot jobs can successfully write every canonical row as zero when the
  // upstream recorder returns no data. Treat a severe whole-property drop as a
  // partial capture, not as a real low-use day. The median makes this resistant
  // to one outage and the 25% floor is deliberately conservative.
  const candidateMedian = median(completeCandidates.map(day => day.total));
  const circuitMedians = new Map(expectedIds.map(id => [
    id,
    median(completeCandidates.map(day => day.values.get(id)?.kwh ?? 0)),
  ]));
  const usableDays = completeCandidates.filter(day => {
    const unexpectedlyZeroCircuits = expectedIds.filter(id => {
      const typical = circuitMedians.get(id) ?? 0;
      return typical >= 0.25 && (day.values.get(id)?.kwh ?? 0) < typical * 0.05;
    }).length;
    const widespreadZeroThreshold = Math.max(3, Math.ceil(expectedIds.length * 0.1));
    const looksPartial = candidateMedian > 1 && (
      day.total < candidateMedian * 0.25
      || unexpectedlyZeroCircuits >= widespreadZeroThreshold
    );
    if (looksPartial) partialDates.push(day.date);
    return !looksPartial;
  });
  partialDates.sort();

  const contextByDate = new Map<string, EnergyDailyContextRow>();
  for (const row of input.dailyContext ?? []) {
    const date = isoDate(row.date);
    if (date && date >= windowStart && date <= end) contextByDate.set(date, row);
  }

  const totals = usableDays.map(day => day.total);
  const p10 = percentile(totals, 0.1);
  const p50 = percentile(totals, 0.5);
  const p90 = percentile(totals, 0.9);
  const mad = median(totals.map(value => Math.abs(value - p50)));
  const qualityLevel = qualityFor(usableDays.length, 30);
  const coveragePct = round(usableDays.length / 30 * 100, 1);
  const qualityMessage = usableDays.length < MIN_READY_DAYS
    ? `Only ${usableDays.length} complete day${usableDays.length === 1 ? '' : 's'} are available; at least ${MIN_READY_DAYS} are needed for confident comparisons.`
    : `${usableDays.length} complete days analyzed; ${missingDates.length} missing and ${partialDates.length} partial days were excluded.`;

  const recent = usableDays.slice(-7);
  const prior = usableDays.slice(Math.max(0, usableDays.length - 14), Math.max(0, usableDays.length - 7));
  const recentAverage = average(recent.map(day => day.total));
  const priorAverage = average(prior.map(day => day.total));
  const totalAverage = average(totals) ?? 0;

  const labels = new Map<string, { label: string; category: string }>();
  for (const day of usableDays) {
    for (const [id, row] of day.values) labels.set(id, { label: row.label, category: row.category });
  }
  const circuitDrivers: CircuitSummary[] = expectedIds.map(entityId => {
    const all = usableDays.map(day => day.values.get(entityId)?.kwh ?? 0);
    const recentValues = recent.map(day => day.values.get(entityId)?.kwh ?? 0);
    const priorValues = prior.map(day => day.values.get(entityId)?.kwh ?? 0);
    const recentMean = average(recentValues);
    const priorMean = average(priorValues);
    return {
      entityId,
      label: labels.get(entityId)?.label ?? entityId,
      category: labels.get(entityId)?.category ?? 'Other',
      averageKwhPerDay: round(average(all) ?? 0),
      baseKwhPerDay: round(percentile(all, 0.1)),
      recentAverageKwhPerDay: recentMean === null ? null : round(recentMean),
      priorAverageKwhPerDay: priorMean === null ? null : round(priorMean),
      deltaKwhPerDay: recentMean !== null && priorMean !== null ? round(recentMean - priorMean) : null,
      deltaPct: recentMean !== null && priorMean !== null ? round(deltaPct(recentMean, priorMean) ?? 0, 1) : null,
    };
  }).sort((a, b) => (b.deltaKwhPerDay ?? -Infinity) - (a.deltaKwhPerDay ?? -Infinity));

  const categoryNames = [...new Set(circuitDrivers.map(circuit => circuit.category))];
  const categoryDrivers: CategorySummary[] = categoryNames.map(category => {
    const ids = circuitDrivers.filter(circuit => circuit.category === category).map(circuit => circuit.entityId);
    const all = usableDays.map(day => ids.reduce((sum, id) => sum + (day.values.get(id)?.kwh ?? 0), 0));
    const recentValues = recent.map(day => ids.reduce((sum, id) => sum + (day.values.get(id)?.kwh ?? 0), 0));
    const priorValues = prior.map(day => ids.reduce((sum, id) => sum + (day.values.get(id)?.kwh ?? 0), 0));
    const recentMean = average(recentValues);
    const priorMean = average(priorValues);
    return {
      category,
      averageKwhPerDay: round(average(all) ?? 0),
      recentAverageKwhPerDay: recentMean === null ? null : round(recentMean),
      priorAverageKwhPerDay: priorMean === null ? null : round(priorMean),
      deltaKwhPerDay: recentMean !== null && priorMean !== null ? round(recentMean - priorMean) : null,
    };
  }).sort((a, b) => (b.deltaKwhPerDay ?? -Infinity) - (a.deltaKwhPerDay ?? -Infinity));

  // Tukey's upper fence is robust against a single very large day.  MAD is
  // included as a second guard for small/flat samples.
  const q1 = percentile(totals, 0.25);
  const q3 = percentile(totals, 0.75);
  const upperFence = q3 + 1.5 * (q3 - q1);
  const madFence = p50 + 3 * Math.max(mad, 0.01);
  const highThreshold = Math.max(upperFence, madFence);
  const unusualHighUseDays = usableDays
    .filter(day => day.total > highThreshold && day.total > p50)
    .map(day => ({ date: day.date, kwh: round(day.total), excessKwh: round(day.total - p50) }))
    .sort((a, b) => b.kwh - a.kwh)
    .slice(0, 5);

  const weekdays = usableDays.filter(day => {
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  }).map(day => day.total);
  const weekends = usableDays.filter(day => {
    const weekday = new Date(`${day.date}T00:00:00Z`).getUTCDay();
    return weekday === 0 || weekday === 6;
  }).map(day => day.total);
  const weekdayAverage = average(weekdays);
  const weekendAverage = average(weekends);

  const rate = Math.max(0, getRate(input));
  const tier = getTier(input);
  const dataQuality: EnergyDataQuality = {
    expectedDays: 30,
    observedDays: observedDates.size,
    usableFullDays: usableDays.length,
    missingDates,
    partialDates,
    coveragePct,
    level: qualityLevel,
    message: qualityMessage,
  };
  const recentDelta = recentAverage !== null && priorAverage !== null ? recentAverage - priorAverage : null;
  const recentPct = deltaPct(recentAverage, priorAverage);
  const baseLoad = p10;
  const result: EnergyInsightsResult = {
    ready: usableDays.length >= MIN_READY_DAYS,
    endDate: end,
    windowStart,
    windowEnd: end,
    marginalRatePerKwh: round(rate, 5),
    currentTier: tier === null ? null : round(tier),
    dataQuality,
    summary: {
      usableDays: usableDays.length,
      totalAverageKwhPerDay: round(totalAverage),
      baseLoadKwhPerDay: round(baseLoad),
      baseLoadMonthlyCost: round(baseLoad * 30 * rate),
      variability: {
        medianKwhPerDay: round(p50),
        p10KwhPerDay: round(p10),
        p90KwhPerDay: round(p90),
        madKwhPerDay: round(mad),
        robustRangeKwhPerDay: round(p90 - p10),
      },
      recentVsPrior: {
        recentDays: recent.length,
        priorDays: prior.length,
        recentAverageKwhPerDay: recentAverage === null ? null : round(recentAverage),
        priorAverageKwhPerDay: priorAverage === null ? null : round(priorAverage),
        deltaKwhPerDay: recentDelta === null ? null : round(recentDelta),
        deltaPct: recentPct === null ? null : round(recentPct, 1),
      },
      weekdayWeekend: {
        weekdayDays: weekdays.length,
        weekendDays: weekends.length,
        weekdayAverageKwhPerDay: weekdayAverage === null ? null : round(weekdayAverage),
        weekendAverageKwhPerDay: weekendAverage === null ? null : round(weekendAverage),
        deltaKwhPerDay: weekdayAverage !== null && weekendAverage !== null
          ? round(weekendAverage - weekdayAverage)
          : null,
      },
      unusualHighUseDays,
      circuitDrivers,
      categoryDrivers,
    },
    findings: [],
  };

  if (!result.ready) return result;
  const contextualCorrelations: EnergyCorrelationContext[] = [];
  const addContext = (
    signal: EnergyCorrelationContext['signal'],
    label: string,
    values: (row: EnergyDailyContextRow) => number | null,
  ) => {
    const pairs: [number, number][] = [];
    for (const day of usableDays) {
      const row = contextByDate.get(day.date);
      if (!row) continue;
      const value = values(row);
      if (value !== null) pairs.push([value, day.total]);
    }
    const coverage = usableDays.length ? pairs.length / usableDays.length : 0;
    const coefficient = coverage >= MIN_CONTEXT_COVERAGE ? correlation(pairs) : null;
    if (coefficient === null || Math.abs(coefficient) < MIN_CONTEXT_CORRELATION) return;
    contextualCorrelations.push({
      signal,
      label,
      correlation: round(coefficient, 2),
      sampleDays: pairs.length,
      coveragePct: round(coverage * 100, 1),
      direction: coefficient >= 0 ? 'aligned' : 'inverse',
      summary: `${label} and whole-property energy moved ${coefficient >= 0 ? 'in the same direction' : 'in opposite directions'} across ${pairs.length} complete, aligned days (r=${round(coefficient, 2)}).`,
    });
  };
  addContext('outdoor-temperature', 'Outdoor temperature', row => finiteNumber(row.averageOutdoorTempF));
  addContext('occupancy', 'Occupied hours', row => {
    const occupied = finiteNumber(row.occupiedHours);
    const coverage = finiteNumber(row.occupancyCoverageHours);
    return occupied !== null && coverage !== null && coverage >= 20 ? occupied : null;
  });
  const findings: EnergyFinding[] = [];
  const evidenceWindow = { windowStart, windowEnd: end };
  const confidence = (effect: number, baseline = totalAverage): FindingConfidence =>
    confidenceFor(usableDays.length, effect, baseline);
  const quality = qualityLevel;

  if (baseLoad > 0 && baseLoad >= p50 * 0.35) {
    const monthlyExposureKwh = baseLoad * 30;
    const range = exposureRange(rate, monthlyExposureKwh);
    findings.push(finding({
      id: 'sustained-base-load',
      type: 'base-load',
      observation: `The robust daily floor was about ${round(baseLoad)} kWh/day (10th percentile across ${usableDays.length} complete days).`,
      whyItMatters: `This recurring floor represents about ${round(baseLoad * 30 * rate)} dollars/month at the supplied marginal all-in rate, whether or not the source is identified.`,
      evidence: { ...evidenceWindow, metrics: { baseKwhPerDay: round(baseLoad), monthlyExposureKwh: round(monthlyExposureKwh), measuredMonthlyCost: round(monthlyExposureKwh * rate), percentile: 10, days: usableDays.length, marginalRatePerKwh: round(rate, 5) } },
      confidence: confidence(baseLoad, p50),
      dataQuality: quality,
      suggestedAction: 'Review the circuits contributing to the lowest-use complete days and verify which loads genuinely need to remain on.',
      savingsRange: range,
      context: contextualCorrelations,
    }));
  }

  if (recentDelta !== null && recentDelta > Math.max(0.5, totalAverage * 0.08)) {
    const driver = circuitDrivers.find(circuit => (circuit.deltaKwhPerDay ?? 0) > 0);
    const monthlyExposureKwh = recentDelta * 30;
    const range = exposureRange(rate, monthlyExposureKwh);
    findings.push(finding({
      id: 'recent-use-increase',
      type: 'recent-change',
      observation: `The latest ${recent.length} usable days averaged ${round(recentAverage ?? 0)} kWh/day, ${round(recentDelta)} kWh/day above the preceding ${prior.length}.`,
      whyItMatters: `If the increase persists, it adds about ${round(recentDelta * 30)} kWh/month before any action is taken.`,
      evidence: { ...evidenceWindow, metrics: { recentAverageKwhPerDay: round(recentAverage ?? 0), priorAverageKwhPerDay: round(priorAverage ?? 0), deltaKwhPerDay: round(recentDelta), monthlyExposureKwh: round(monthlyExposureKwh), measuredMonthlyCost: round(monthlyExposureKwh * rate), driverEntityId: driver?.entityId ?? 'none' } },
      confidence: confidence(recentDelta, totalAverage),
      dataQuality: quality,
      suggestedAction: driver ? actionFor(driver.entityId, driver.label) : 'Compare recent circuit readings with the preceding period and investigate the largest measured change.',
      savingsRange: range,
      context: contextualCorrelations,
    }));
  }

  if (unusualHighUseDays.length > 0) {
    const excess = unusualHighUseDays.reduce((sum, day) => sum + day.excessKwh, 0) / unusualHighUseDays.length;
    const monthlyEvents = unusualHighUseDays.length / usableDays.length * 30;
    const monthlyExposureKwh = excess * monthlyEvents;
    const range = exposureRange(rate, monthlyExposureKwh);
    findings.push(finding({
      id: 'unusual-high-use-days',
      type: 'unusual-day',
      observation: `${unusualHighUseDays.length} complete day${unusualHighUseDays.length === 1 ? '' : 's'} exceeded the robust high-use threshold of about ${round(highThreshold)} kWh.`,
      whyItMatters: `The flagged days were about ${round(excess)} kWh/day above the typical median; repeating that pattern can materially raise monthly cost.`,
      evidence: { ...evidenceWindow, metrics: { thresholdKwhPerDay: round(highThreshold), medianKwhPerDay: round(p50), averageExcessKwh: round(excess), flaggedDays: unusualHighUseDays.length, projectedMonthlyEvents: round(monthlyEvents, 1), monthlyExposureKwh: round(monthlyExposureKwh), measuredMonthlyCost: round(monthlyExposureKwh * rate), largestDate: unusualHighUseDays[0].date } },
      confidence: confidenceFor(usableDays.length, excess, p50),
      dataQuality: quality,
      suggestedAction: 'Compare the flagged dates with schedules or operating events and verify the circuit readings before changing equipment settings.',
      savingsRange: range,
    }));
  }

  const dayDelta = result.summary.weekdayWeekend.deltaKwhPerDay;
  if (dayDelta !== null && Math.abs(dayDelta) > Math.max(1, totalAverage * 0.12)
    && weekdays.length >= 4 && weekends.length >= 2) {
    const larger = Math.abs(dayDelta);
    const higherDaysPerMonth = dayDelta >= 0 ? 8.7 : 21.7;
    const monthlyExposureKwh = larger * higherDaysPerMonth;
    const range = exposureRange(rate, monthlyExposureKwh);
    findings.push(finding({
      id: 'weekday-weekend-difference',
      type: 'weekday-weekend',
      observation: `Weekend days averaged ${round(weekendAverage ?? 0)} kWh/day versus ${round(weekdayAverage ?? 0)} on weekdays (${dayDelta >= 0 ? '+' : ''}${round(dayDelta)} kWh/day on weekends).`,
      whyItMatters: 'A repeatable calendar-day difference can help narrow the schedule or operating conditions worth checking, but does not establish causation by itself.',
      evidence: { ...evidenceWindow, metrics: { weekdayAverageKwhPerDay: round(weekdayAverage ?? 0), weekendAverageKwhPerDay: round(weekendAverage ?? 0), deltaKwhPerDay: round(dayDelta), weekdayDays: weekdays.length, weekendDays: weekends.length, monthlyExposureKwh: round(monthlyExposureKwh), measuredMonthlyCost: round(monthlyExposureKwh * rate) } },
      confidence: confidenceFor(usableDays.length, larger, totalAverage),
      dataQuality: quality,
      suggestedAction: 'Compare the higher-use day type with occupancy and operating schedules; validate any suspected circuit before making a change.',
      savingsRange: range,
    }));
  }

  // If several patterns compete, add only the strongest measured driver.  This
  // keeps a circuit driver from duplicating the whole-property trend card.
  const strongestDriver = circuitDrivers.find(circuit => (circuit.deltaKwhPerDay ?? 0) > Math.max(0.5, totalAverage * 0.08));
  if (strongestDriver && findings.length < MAX_FINDINGS && !findings.some(item => item.type === 'recent-change')) {
    const effect = strongestDriver.deltaKwhPerDay ?? 0;
    const monthlyExposureKwh = effect * 30;
    const range = exposureRange(rate, monthlyExposureKwh);
    findings.push(finding({
      id: `circuit-driver-${strongestDriver.entityId}`,
      type: 'circuit-driver',
      observation: `${strongestDriver.label} was the largest measured circuit increase, up ${round(effect)} kWh/day between the comparison periods.`,
      whyItMatters: 'A circuit-level driver narrows the investigation to a measured source instead of assuming what an unlabeled load does.',
      evidence: { ...evidenceWindow, metrics: { entityId: strongestDriver.entityId, category: strongestDriver.category, recentKwhPerDay: strongestDriver.recentAverageKwhPerDay ?? 0, priorKwhPerDay: strongestDriver.priorAverageKwhPerDay ?? 0, deltaKwhPerDay: round(effect), monthlyExposureKwh: round(monthlyExposureKwh), measuredMonthlyCost: round(monthlyExposureKwh * rate) } },
      confidence: confidence(effect, strongestDriver.averageKwhPerDay),
      dataQuality: quality,
      suggestedAction: actionFor(strongestDriver.entityId, strongestDriver.label),
      savingsRange: range,
    }));
  }

  // Stable score ordering; ties use stable ids so repeated analyses are
  // deterministic.  A finding's evidence effect is used rather than a label.
  result.findings = findings
    .sort((a, b) => {
      return b.savingsRange.high - a.savingsRange.high || a.id.localeCompare(b.id);
    })
    .slice(0, MAX_FINDINGS);
  return result;
}

/** Short alias for callers that prefer a verb without the API noun. */
export const analyzeEnergy = analyzeEnergyInsights;
export const analyzeEnergyHistory = analyzeEnergyInsights;
export const buildEnergyInsights = analyzeEnergyInsights;

export function measurementScopeForFinding(
  finding: EnergyFinding,
  canonicalLeafIds: readonly string[],
  circuitMetadata: readonly { entityId: string; label: string; category: string }[],
): FindingMeasurementScope {
  if (finding.type === 'circuit-driver') {
    const entityId = String(finding.evidence.metrics.entityId ?? '');
    const circuit = circuitMetadata.find(item => item.entityId === entityId);
    if (entityId && canonicalLeafIds.includes(entityId)) {
      return { type: 'circuit', label: circuit?.label ?? entityId, entityIds: [entityId] };
    }
  }
  if (finding.type === 'category-driver') {
    const category = String(finding.evidence.metrics.category ?? '');
    const entityIds = circuitMetadata
      .filter(item => item.category === category && canonicalLeafIds.includes(item.entityId))
      .map(item => item.entityId);
    if (entityIds.length) return { type: 'category', label: category, entityIds };
  }
  return { type: 'property', label: 'Whole property', entityIds: [...canonicalLeafIds] };
}
