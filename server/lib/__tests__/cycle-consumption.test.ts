import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the DB layer: getCycleConsumptionFromDb issues a GROUP BY query over
// circuit_energy_daily (per-entity completed-day totals) and, when that returns
// rows, a follow-up DISTINCT-dates query. We return controlled values for each.
let dbRows: Array<{ entity_id: string; label: string; category: string; kwh: number; days: number }> = [];
let dbDates: string[] = []; // LA-local YYYY-MM-DD strings the DB covers
const queryMock = vi.fn(async (sql: string, _params?: unknown[]) => {
  if (typeof sql === 'string' && sql.includes('DISTINCT to_char(usage_date')) {
    return { rows: dbDates.map(d => ({ d })), rowCount: dbDates.length };
  }
  return { rows: dbRows, rowCount: dbRows.length };
});
vi.mock('../db.js', () => ({ query: (...args: any[]) => queryMock(args[0], args[1]) }));

// Mock the HA entity cache: getTodayConsumptionFromStates reads the current
// state of each *_energy_today counter. We return controlled "today" values.
let cacheEntities: Array<{ entity_id: string; state: string }> = [];
// Mock the HA long-term statistics WS reply (recorder/statistics_during_period).
// The fallback path queries this for day-bucketed `change` per circuit when the
// DB is missing elapsed cycle days. Keyed by statistic_id → day points.
let haStats: Record<string, Array<{ start: string; change: number }>> = {};
const sendHAWSCommandMock = vi.fn(async () => haStats);
vi.mock('../haWebSocket.js', () => ({
  getEntityCache: () => cacheEntities,
  sendHAWSCommand: (...args: any[]) => sendHAWSCommandMock(...(args as [])),
}));

const { getCycleConsumptionRobust, ENERGY_CIRCUITS } = await import('../haStatistics.js');

beforeEach(() => {
  dbRows = [];
  dbDates = [];
  cacheEntities = [];
  haStats = {};
  queryMock.mockClear();
  sendHAWSCommandMock.mockClear();
});

describe('getCycleConsumptionRobust', () => {
  it('sums completed-day DB kWh with today\'s live partial without double-counting', async () => {
    const c = ENERGY_CIRCUITS[0]; // e.g. sensor.av_room_panel_energy_today
    // 3 completed days already in circuit_energy_daily totalling 30 kWh…
    dbRows = [{ entity_id: c.entityId, label: c.label, category: c.category, kwh: 30, days: 3 }];
    dbDates = ['2026-05-01', '2026-05-02', '2026-05-03'];
    // …plus today's live partial of 4 kWh from the _energy_today counter.
    cacheEntities = [{ entity_id: c.entityId, state: '4' }];

    const result = await getCycleConsumptionRobust(new Date('2026-05-01T00:00:00Z'));

    const circuit = result.circuits.find(x => x.entityId === c.entityId);
    expect(circuit?.kwh).toBeCloseTo(34, 3); // 30 completed + 4 today, summed once
    expect(result.source).toBe('db+live');
  });

  it('represents every known circuit even when it has no DB or live data', async () => {
    const c = ENERGY_CIRCUITS[0];
    dbRows = [{ entity_id: c.entityId, label: c.label, category: c.category, kwh: 10, days: 1 }];
    cacheEntities = []; // no live states at all

    const result = await getCycleConsumptionRobust(new Date('2026-05-01T00:00:00Z'));

    expect(result.circuits).toHaveLength(ENERGY_CIRCUITS.length);
    // A circuit absent from both sources is present at 0 (stable UI).
    const untouched = ENERGY_CIRCUITS[1];
    expect(result.circuits.find(x => x.entityId === untouched.entityId)?.kwh).toBe(0);
  });

  it('falls back to live-only when the DB has no completed days', async () => {
    const c = ENERGY_CIRCUITS[0];
    dbRows = [];
    cacheEntities = [{ entity_id: c.entityId, state: '2.5' }];

    const result = await getCycleConsumptionRobust(new Date('2026-05-01T00:00:00Z'));

    expect(result.source).toBe('live-only');
    expect(result.circuits.find(x => x.entityId === c.entityId)?.kwh).toBeCloseTo(2.5, 3);
    // Total equals the single live partial (no phantom DB contribution).
    expect(result.totalKwh).toBeCloseTo(2.5, 3);
  });

  // ── Regression: the production bug ──────────────────────────────────────
  // When circuit_energy_daily is brand-new/empty (snapshot cron hasn't run),
  // the elapsed cycle days MUST be recovered from HA long-term statistics, not
  // collapsed to "today only". Otherwise cycle-to-date undercounts ~40×, the
  // tier sticks at Tier 1, and the projected bill is absurdly low.
  it('fills elapsed cycle days from HA statistics when the DB is empty', async () => {
    // Cycle started ~42 days before "now" so daysInCycle ≈ 42.
    const now = new Date();
    const cycleStart = new Date(now.getTime() - 42 * 24 * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const todayStr = fmt.format(now);

    // DB is EMPTY — no completed-day snapshots yet.
    dbRows = [];
    dbDates = [];

    // HA retains day-bucketed long-term statistics: 41 elapsed days (cycleStart
    // .. yesterday) at 300 kWh/day across one circuit. Today is excluded (read
    // live). We attribute it all to the first circuit for simplicity.
    const c = ENERGY_CIRCUITS[0];
    const dayPoints: Array<{ start: string; change: number }> = [];
    for (let i = 0; i < 42; i++) {
      const day = new Date(cycleStart.getTime() + i * 24 * 60 * 60 * 1000);
      const dayStr = fmt.format(day);
      if (dayStr === todayStr) continue; // today is live, not from stats
      // noon-LA so the bucket maps unambiguously to its calendar day
      dayPoints.push({ start: `${dayStr}T12:00:00-07:00`, change: 300 });
    }
    haStats = { [c.entityId]: dayPoints };

    // Today's live partial: 200 kWh so far.
    cacheEntities = [{ entity_id: c.entityId, state: '200' }];

    const result = await getCycleConsumptionRobust(cycleStart);

    // Cycle-to-date = ~41 elapsed days × 300 + 200 today ≈ 12,300+ kWh — the
    // realistic figure, NOT ~380 kWh (today only).
    expect(result.totalKwh).toBeGreaterThan(11_000);
    expect(result.source).toBe('stats+live');

    // Daily-average denominator counts the elapsed days actually covered plus
    // today — so avg ≈ 300 kWh/day, never the absurd ~9 kWh/day from the bug.
    expect(result.daysWithData).toBeGreaterThanOrEqual(40);
    const avgDaily = result.totalKwh / result.daysWithData;
    expect(avgDaily).toBeGreaterThan(250);
    expect(avgDaily).toBeLessThan(350);

    // No double-counting: today's date is not also pulled from stats.
    const circuit = result.circuits.find(x => x.entityId === c.entityId);
    expect(circuit?.kwh).toBeCloseTo(result.totalKwh, 1);
  });

  it('prefers DB for completed days and only fills the gap from stats', async () => {
    const now = new Date();
    const cycleStart = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const c = ENERGY_CIRCUITS[0];

    // DB covers the first 2 days (200 kWh total).
    const d0 = fmt.format(cycleStart);
    const d1 = fmt.format(new Date(cycleStart.getTime() + 24 * 60 * 60 * 1000));
    dbRows = [{ entity_id: c.entityId, label: c.label, category: c.category, kwh: 200, days: 2 }];
    dbDates = [d0, d1];

    // HA stats also report those 2 days (must be ignored — DB wins) plus more.
    const dayPoints: Array<{ start: string; change: number }> = [];
    for (let i = 0; i < 9; i++) {
      const day = new Date(cycleStart.getTime() + i * 24 * 60 * 60 * 1000);
      dayPoints.push({ start: `${fmt.format(day)}T12:00:00-07:00`, change: 100 });
    }
    haStats = { [c.entityId]: dayPoints };
    cacheEntities = [{ entity_id: c.entityId, state: '50' }];

    const result = await getCycleConsumptionRobust(cycleStart);

    // DB days (200) + stats-filled gap days (days 2..8 = 7 days × 100 = 700)
    // + today live (50) = 950. Days 0,1 NOT double-counted from stats.
    const circuit = result.circuits.find(x => x.entityId === c.entityId);
    expect(circuit?.kwh).toBeCloseTo(950, 1);
    expect(result.source).toBe('db+stats+live');
  });
});
