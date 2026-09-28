import { describe, expect, it } from 'vitest';
import {
  analyzeEnergyInsights,
  findingOccurrenceId,
  measurementScopeForFinding,
  measureRealizedSavings,
  type EnergyDailyRow,
} from '../energyInsights.js';

const END = '2026-05-30';
const IDS = ['circuit.a', 'circuit.b'];

function dateAt(offset: number): string {
  const end = new Date(`${END}T00:00:00Z`);
  return new Date(end.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

function rowsFor(
  values: (day: number, entity: string) => number | string,
  options: { skip?: Set<number>; partial?: Set<number> } = {},
): EnergyDailyRow[] {
  const rows: EnergyDailyRow[] = [];
  for (let day = -29; day <= 0; day += 1) {
    if (options.skip?.has(day)) continue;
    for (const entity of IDS) {
      if (options.partial?.has(day) && entity === IDS[1]) continue;
      rows.push({
        date: dateAt(day),
        entity,
        label: entity === IDS[0] ? 'Circuit A' : 'Circuit B',
        category: entity === IDS[0] ? 'One' : 'Two',
        kWh: values(day, entity),
      });
    }
  }
  return rows;
}

function analyze(rows: EnergyDailyRow[], rate: number | string = 0.4) {
  return analyzeEnergyInsights({
    rows,
    canonicalLeafIds: IDS,
    endDate: END,
    marginalRate: rate,
    currentTierContext: { tier: 3 },
  });
}

describe('energy insights analysis engine', () => {
  it('excludes missing and partial dates from complete-day comparisons', () => {
    const result = analyze(rowsFor(() => 10, {
      skip: new Set([-2, -10]),
      partial: new Set([-3]),
    }));

    expect(result.dataQuality.usableFullDays).toBe(27);
    expect(result.dataQuality.missingDates).toContain(dateAt(-2));
    expect(result.dataQuality.missingDates).toContain(dateAt(-10));
    expect(result.dataQuality.partialDates).toContain(dateAt(-3));
    expect(result.summary.usableDays).toBe(27);
    expect(result.summary.totalAverageKwhPerDay).toBe(20);
  });

  it('uses robust percentiles rather than one isolated maximum for base load', () => {
    const result = analyze(rowsFor((day) => day === -8 ? 1_000 : 10));

    expect(result.summary.baseLoadKwhPerDay).toBe(20);
    expect(result.summary.variability.p90KwhPerDay).toBe(20);
    expect(result.summary.variability.medianKwhPerDay).toBe(20);
    expect(result.summary.unusualHighUseDays.map(day => day.date)).toEqual([dateAt(-8)]);
  });

  it('rejects a zeroed upstream snapshot instead of lowering the measured base load', () => {
    const result = analyze(rowsFor((day) => day === -8 ? 0 : 10));

    expect(result.dataQuality.partialDates).toContain(dateAt(-8));
    expect(result.dataQuality.usableFullDays).toBe(29);
    expect(result.summary.baseLoadKwhPerDay).toBe(20);
  });

  it('does not invent a finding for a genuinely flat load', () => {
    const result = analyze(rowsFor(() => 10));

    expect(result.ready).toBe(true);
    expect(result.summary.variability.madKwhPerDay).toBe(0);
    expect(result.findings.some(finding => finding.type === 'recent-change')).toBe(false);
    expect(result.findings.some(finding => finding.type === 'unusual-day')).toBe(false);
  });

  it('finds a recent measured trend and its circuit/category driver', () => {
    const result = analyze(rowsFor((day, entity) => {
      if (day >= -6 && entity === IDS[0]) return 20;
      return entity === IDS[0] ? 10 : 5;
    }));

    expect(result.summary.recentVsPrior.deltaKwhPerDay).toBe(10);
    expect(result.summary.circuitDrivers[0].entityId).toBe(IDS[0]);
    expect(result.summary.categoryDrivers[0].category).toBe('One');
    expect(result.findings.some(finding => finding.id === 'recent-use-increase')).toBe(true);
  });

  it('caps findings and uses unique stable ids when patterns overlap', () => {
    const result = analyze(rowsFor((day, entity) => {
      if (day >= -6 && entity === IDS[0]) return 30;
      if (day === -12 && entity === IDS[1]) return 100;
      return 5;
    }));
    const ids = result.findings.map(finding => finding.id);

    expect(ids.length).toBeLessThanOrEqual(4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(result.findings.every(finding => finding.estimatedSavings === finding.savingsRange)).toBe(true);
    expect(result.findings.map(finding => finding.savingsRange.high))
      .toEqual([...result.findings.map(finding => finding.savingsRange.high)].sort((a, b) => b - a));
    expect(result.findings.every(finding => Number(finding.evidence.metrics.measuredMonthlyCost) >= 0)).toBe(true);
  });

  it('coerces numeric database strings and applies the supplied all-in rate', () => {
    const result = analyze(rowsFor(() => '2.5'), '0.50');

    expect(result.summary.totalAverageKwhPerDay).toBe(5);
    expect(result.marginalRatePerKwh).toBe(0.5);
    expect(result.summary.baseLoadMonthlyCost).toBe(75);
    expect(result.currentTier).toBe(3);
  });

  it('reports a conservative range that changes with the tariff context', () => {
    const rows = rowsFor((day, entity) => day >= -6 && entity === IDS[0] ? 20 : 5);
    const lowRate = analyze(rows, 0.2);
    const highRate = analyze(rows, 0.6);
    const lowTrend = lowRate.findings.find(finding => finding.id === 'recent-use-increase');
    const highTrend = highRate.findings.find(finding => finding.id === 'recent-use-increase');

    expect(lowTrend).toBeDefined();
    expect(highTrend).toBeDefined();
    expect(highTrend!.savingsRange.high).toBeGreaterThan(lowTrend!.savingsRange.high);
    expect(highTrend!.savingsRange.low).toBeLessThanOrEqual(highTrend!.savingsRange.high);
  });

  it('does not make time-of-use or off-peak claims', () => {
    const result = analyze(rowsFor((day) => day === -1 ? 50 : 5));
    const text = JSON.stringify(result).toLowerCase();

    expect(text).not.toContain('off-peak');
    expect(text).not.toContain('late-night');
    expect(text).not.toContain('time-of-use');
  });

  it('adds aligned context only when sample and quality thresholds are met', () => {
    const rows = rowsFor(day => 40 + day);
    const dailyContext = Array.from({ length: 30 }, (_, index) => {
      const day = index - 29;
      return {
        date: dateAt(day),
        averageOutdoorTempF: 70 + day,
        occupiedHours: 12 + day / 10,
        occupancyCoverageHours: 24,
      };
    });
    const result = analyzeEnergyInsights({
      rows,
      dailyContext,
      canonicalLeafIds: IDS,
      endDate: END,
      marginalRate: 0.4,
      currentTierContext: { tier: 3 },
    });
    const recent = result.findings.find(finding => finding.id === 'recent-use-increase');

    expect(recent?.context?.map(context => context.signal)).toEqual([
      'outdoor-temperature',
      'occupancy',
    ]);
    expect(recent?.context?.every(context => context.sampleDays === 30)).toBe(true);
  });

  it('omits sparse, flat, and poorly covered context', () => {
    const rows = rowsFor((day, entity) => day >= -6 && entity === IDS[0] ? 20 : 5);
    const dailyContext = Array.from({ length: 12 }, (_, index) => ({
      date: dateAt(index - 11),
      averageOutdoorTempF: 72,
      occupiedHours: index,
      occupancyCoverageHours: 10,
    }));
    const result = analyzeEnergyInsights({
      rows,
      dailyContext,
      canonicalLeafIds: IDS,
      endDate: END,
      marginalRate: 0.4,
      currentTierContext: { tier: 3 },
    });

    expect(result.findings.every(finding => !finding.context?.length)).toBe(true);
  });
});

describe('realized energy savings', () => {
  it('compares complete matched periods and separates the result from normal variability', () => {
    const actionDate = '2026-05-15';
    const rows: EnergyDailyRow[] = [];
    for (let offset = -14; offset <= 14; offset += 1) {
      if (offset === 0) continue;
      const date = new Date(new Date(`${actionDate}T00:00:00Z`).getTime() + offset * 86_400_000).toISOString().slice(0, 10);
      for (const entity of IDS) rows.push({
        date, entity, label: entity, category: 'Test', kWh: offset < 0 ? 10 : 8,
      });
    }
    const result = measureRealizedSavings({
      rows, canonicalLeafIds: IDS, actionDate, latestCompleteDate: '2026-05-29', marginalRate: 0.5,
    });
    expect(result.status).toBe('measured');
    expect(result.beforeAverageKwhPerDay).toBe(20);
    expect(result.afterAverageKwhPerDay).toBe(16);
    expect(result.realizedSavingsPerMonth).toBe(60);
    expect(result.exceedsNormalVariability).toBe(true);
  });

  it('keeps recurring findings as separate occurrences', () => {
    const first = analyze(rowsFor((day, entity) => day >= -6 && entity === IDS[0] ? 20 : 5))
      .findings.find(finding => finding.id === 'recent-use-increase')!;
    const recurring = { ...first, evidence: { ...first.evidence, windowStart: '2026-06-01', windowEnd: '2026-06-30' } };
    expect(findingOccurrenceId(first)).not.toBe(findingOccurrenceId(recurring));
  });

  it('measures a circuit finding against only that circuit', () => {
    const finding = analyze(rowsFor((day, entity) => day >= -6 && entity === IDS[0] ? 20 : 5))
      .findings.find(item => item.id === 'recent-use-increase')!;
    const circuitFinding = {
      ...finding,
      id: `circuit-driver-${IDS[0]}`,
      type: 'circuit-driver' as const,
      evidence: { ...finding.evidence, metrics: { ...finding.evidence.metrics, entityId: IDS[0] } },
    };
    expect(measurementScopeForFinding(circuitFinding, IDS, [
      { entityId: IDS[0], label: 'Circuit A', category: 'One' },
      { entityId: IDS[1], label: 'Circuit B', category: 'Two' },
    ])).toEqual({ type: 'circuit', label: 'Circuit A', entityIds: [IDS[0]] });
  });

  it('does not estimate savings from incomplete periods', () => {
    const result = measureRealizedSavings({
      rows: [], canonicalLeafIds: IDS, actionDate: '2026-05-15',
      latestCompleteDate: '2026-05-29', marginalRate: 0.5,
    });
    expect(result.status).toBe('incomplete-data');
    expect(result.realizedSavingsPerMonth).toBeNull();
  });
});
