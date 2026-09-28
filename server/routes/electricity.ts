/**
 * Electricity Cost Intelligence API
 * ───────────────────────────────────
 * REST routes for live cost tracking, billing comparison,
 * circuit-level breakdown, and savings suggestions.
 */

import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLog.js';
import { safeErrorJson } from '../lib/errorSanitizer.js';
import {
  computeLadwpBill,
  getCurrentTierRate,
  getSeasonalRate,
  getSeasonalRateForPeriod,
  generateSavingsSuggestions,
  TIER_ALLOTMENTS,
} from '../lib/ladwpRates.js';
import {
  analyzeEnergyInsights,
  findingOccurrenceId,
  measurementScopeForFinding,
  measureRealizedSavings,
  type EnergyDailyContextRow,
  type EnergyFinding,
} from '../lib/energyInsights.js';
import {
  getBillingCycleConsumption,
  getGridConsumption,
  getEnergyStatistics,
  getTodayConsumptionFromStates,
  getCycleConsumptionRobust,
  estimateBillingCycleStart,
  ENERGY_CIRCUITS,
  PANEL_MAIN_ENERGY_ENTITY_IDS,
  CANONICAL_LEAF_ENERGY_ENTITY_IDS,
  CANONICAL_ENERGY_HIERARCHY_IDS,
  validateCompleteDailyEnergyStatistics,
  type CircuitTodayKwh,
} from '../lib/haStatistics.js';
import { getEntityCache } from '../lib/haWebSocket.js';
import { storage } from '../storage.js';

const router = Router();

// All-in marginal $/kWh: current tier rate × (1 + LA utility tax) + state surcharge.
// "True cost of the next kWh" — used for the live hero and per-circuit $ figures.
const LA_UTILITY_TAX = 0.10;
const STATE_SURCHARGE = 0.0003;
function allInMarginalRate(tierRate: number): number {
  return +(tierRate * (1 + LA_UTILITY_TAX) + STATE_SURCHARGE).toFixed(5);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

// The 5 panel-main power entities. These mains already include their child
// circuits, so the whole-house live total is the sum of ONLY these — summing
// all 89 circuits would double-count every child against its parent main.
const PANEL_MAIN_POWER_ENTITIES = [
  'sensor.garage_panel_1_power_minute_average',
  'sensor.garage_panel_2_power_minute_average',
  'sensor.av_room_panel_power_minute_average',
  'sensor.guest_house_sub_panel_power_minute_average',
  'sensor.equipment_room_cabana_power_minute_average',
];

// Whole-house live watts from the HA entity cache — sums only the 5 panel
// mains (used for the live kW / $-per-hour hero). Per-circuit breakdowns and
// Top Consumers continue to use individual child circuits elsewhere.
function getLiveTotalWatts(): number {
  const cache = getEntityCache();
  const byId = new Map(cache.map(e => [e.entity_id, e]));
  let watts = 0;
  for (const entityId of PANEL_MAIN_POWER_ENTITIES) {
    const e = byId.get(entityId);
    const raw = e ? parseFloat(e.state) : NaN;
    if (Number.isFinite(raw) && raw > 0) watts += raw;
  }
  return Math.round(watts);
}

// Shared cron/admin secret gate (mirrors server/routes/admin.ts). Lets the
// daily snapshot cron POST without a user session while still allowing an
// admin to trigger a manual backfill from the UI.
function isCronAuthorized(req: AuthenticatedRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
  const provided =
    (req.headers['x-cron-secret'] as string | undefined) ||
    (req.headers['authorization'] as string | undefined)?.replace('Bearer ', '');
  return Boolean(
    (cronSecret && provided === cronSecret) ||
      (jwtSecret && provided === jwtSecret) ||
      req.userRole === 'admin',
  );
}

// LA-local midnight for a given offset of days back from "now". dayOffsetBack=1
// returns [startOfYesterday, startOfToday) in America/Los_Angeles.
function laDayBounds(dayOffsetBack: number): { start: Date; end: Date; usageDate: string } {
  const now = new Date();
  const laNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const offsetMs = now.getTime() - laNow.getTime();
  const startLocal = new Date(laNow.getFullYear(), laNow.getMonth(), laNow.getDate() - dayOffsetBack, 0, 0, 0, 0);
  const endLocal = new Date(laNow.getFullYear(), laNow.getMonth(), laNow.getDate() - dayOffsetBack + 1, 0, 0, 0, 0);
  const start = new Date(startLocal.getTime() + offsetMs);
  const end = new Date(endLocal.getTime() + offsetMs);
  const usageDate = `${startLocal.getFullYear()}-${String(startLocal.getMonth() + 1).padStart(2, '0')}-${String(startLocal.getDate()).padStart(2, '0')}`;
  return { start, end, usageDate };
}

// Parse a DATE column value (pg returns DATE either as a JS Date at local
// midnight or as a 'YYYY-MM-DD' string) into a timezone-stable noon-UTC Date.
// Noon UTC keeps the calendar day identical in every timezone, and downstream
// (computeLadwpBill → getSeasonalRateForPeriod) only reads the month.
function parseBillDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), 12));
  }
  if (typeof value === 'string') {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(Date.UTC(y, m - 1, d, 12));
  }
  return null;
}

const BILL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Render a billing period as e.g. "Apr 21 – Jun 22, 2026" (year shown on the
// start only when it differs from the end year). Reads UTC parts to match the
// noon-UTC Dates produced by parseBillDate.
function formatBillingPeriod(start: Date, end: Date): string {
  const sY = start.getUTCFullYear();
  const eY = end.getUTCFullYear();
  const startStr = `${BILL_MONTHS[start.getUTCMonth()]} ${start.getUTCDate()}${sY !== eY ? `, ${sY}` : ''}`;
  const endStr = `${BILL_MONTHS[end.getUTCMonth()]} ${end.getUTCDate()}, ${eY}`;
  return `${startStr} – ${endStr}`;
}

// ── GET /live-cost ─────────────────────────────────────────────────────
// Returns current billing cycle kWh, which tier you're in right now,
// cost accrued today/this week/this month, and month-end projection.
router.get('/live-cost', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const t0 = Date.now();
    const now = new Date();

    // Cycle-to-date kWh: completed days from circuit_energy_daily + today's live
    // partial from _energy_today state. Robust to the recorder being empty.
    const cycleStart = estimateBillingCycleStart();
    const daysInCycle = Math.max(1, Math.round((now.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24)));
    const robust = await getCycleConsumptionRobust(cycleStart);
    let totalKwh = robust.totalKwh;

    // Fallback: if the robust source yields ~nothing (e.g. cold cache + empty
    // table), fall back to the recorder-based grid consumption so we never
    // hard-zero the whole view.
    if (totalKwh <= 0.01) {
      try {
        const fallback = await getBillingCycleConsumption();
        if (fallback.totalKwh > totalKwh) totalKwh = fallback.totalKwh;
      } catch { /* best-effort */ }
    }

    // Current tier rate
    const tierInfo = getCurrentTierRate(totalKwh);
    const marginalAllIn = allInMarginalRate(tierInfo.rate);

    // Estimate bill so far
    const billSoFar = computeLadwpBill(totalKwh, cycleStart, now);

    // Project to end of ~60-day cycle. Daily average divides cycle kWh by the
    // number of elapsed days ACTUALLY covered (DB days + stats-filled days +
    // today), not the raw elapsed-day count — otherwise a partially-filled
    // history would understate the per-day pace. Capped at daysInCycle so a
    // stray future-dated stat can't inflate the denominator.
    const daysCovered = Math.max(1, Math.min(robust.daysWithData, daysInCycle));
    const avgDailyKwh = totalKwh / daysCovered;
    const remainingDays = Math.max(0, 60 - daysInCycle);
    const projectedTotalKwh = totalKwh + avgDailyKwh * remainingDays;
    const cycleEnd = new Date(cycleStart.getTime() + 60 * 24 * 60 * 60 * 1000);
    const projectedBill = computeLadwpBill(projectedTotalKwh, cycleStart, cycleEnd);

    // Today's consumption — live from _energy_today counter state.
    const today = getTodayConsumptionFromStates();
    const todayKwh = today.totalKwh;
    const todayCost = +(todayKwh * marginalAllIn).toFixed(2);

    // This week (last 7 days) — best-effort from recorder; not load-bearing.
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let weekKwh = 0;
    let weekCost = 0;
    try {
      const weekData = await getGridConsumption(weekAgo, now, 'day');
      weekKwh = weekData.totalKwh;
      weekCost = +(weekKwh * marginalAllIn).toFixed(2);
    } catch {
      // Best-effort
    }

    // Live burn rate for the hero.
    const liveWatts = getLiveTotalWatts();
    const liveKw = +(liveWatts / 1000).toFixed(2);
    const dollarsPerHour = +(liveKw * marginalAllIn).toFixed(2);

    // Projection range (best/worst ±10% on pace) + last cycle's actual bill so
    // the UI gauge can scale to a meaningful target rather than a fixed $12k.
    const bestBill = computeLadwpBill(projectedTotalKwh * 0.9, cycleStart, cycleEnd);
    const worstBill = computeLadwpBill(projectedTotalKwh * 1.1, cycleStart, cycleEnd);
    let lastCycleActual: number | null = null;
    try {
      const { rows } = await storage.query(
        `SELECT ladwp_total_usd FROM electricity_bills ORDER BY billing_period_start DESC LIMIT 1`,
        [],
      );
      if (rows[0]?.ladwp_total_usd != null) lastCycleActual = +Number(rows[0].ladwp_total_usd).toFixed(2);
    } catch { /* table may not exist */ }
    if (lastCycleActual == null) lastCycleActual = 6529; // most recent known bill

    const result = {
      timestamp: now.toISOString(),
      billingCycle: {
        start: cycleStart.toISOString(),
        daysElapsed: daysInCycle,
        totalDays: 60,
        daysRemaining: remainingDays,
      },
      currentTier: tierInfo,
      marginalRate: {
        tierRate: tierInfo.rate,
        allInPerKwh: marginalAllIn,
        utilityTaxRate: LA_UTILITY_TAX,
        stateSurcharge: STATE_SURCHARGE,
      },
      live: {
        watts: liveWatts,
        kw: liveKw,
        dollarsPerHour,
      },
      consumption: {
        today: { kwh: todayKwh, estimatedCost: todayCost },
        thisWeek: { kwh: weekKwh, estimatedCost: weekCost },
        billingCycleToDate: { kwh: totalKwh, estimatedCost: billSoFar.totalElectricCharges },
      },
      billEstimate: {
        soFar: billSoFar.totalElectricCharges,
        projected: projectedBill.totalElectricCharges,
        projectedLow: bestBill.totalElectricCharges,
        projectedHigh: worstBill.totalElectricCharges,
        projectedKwh: Math.round(projectedTotalKwh),
        dailyCost: billSoFar.dailyCost,
        avgDailyKwh: +avgDailyKwh.toFixed(1),
        lastCycleActual,
      },
      tierBreakdown: {
        tier1: { kwh: billSoFar.tier1Kwh, cost: billSoFar.tier1Cost, rate: billSoFar.tier1Rate },
        tier2: { kwh: billSoFar.tier2Kwh, cost: billSoFar.tier2Cost, rate: billSoFar.tier2Rate },
        tier3: { kwh: billSoFar.tier3Kwh, cost: billSoFar.tier3Cost, rate: billSoFar.tier3Rate },
      },
      seasonLabel: billSoFar.seasonLabel,
      isSummer: billSoFar.isSummer,
    };

    logAudit('electricity-api', {
      category: 'home', event_type: 'electricity_live_cost', severity: 'info',
      actor_id: 'system', channel: 'api',
      summary: `Live cost: ${totalKwh.toFixed(0)} kWh (Tier ${tierInfo.tier}) · $${billSoFar.totalElectricCharges} so far · projected $${projectedBill.totalElectricCharges}`,
      duration_ms: Date.now() - t0,
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json(result);
  } catch (err) {
    console.error('[electricity] live-cost error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /breakdown ─────────────────────────────────────────────────────
// Per-circuit kWh + cost for today / this week / billing cycle.
router.get('/breakdown', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const t0 = Date.now();
    const range = (req.query.range as string) || 'cycle';
    const now = new Date();

    // Resolve per-circuit kWh from the robust sources for cycle/today, and the
    // recorder for week. tierInfo/rate is derived from the cycle-to-date total.
    const cycleStart = estimateBillingCycleStart();
    const cycleRobust = await getCycleConsumptionRobust(cycleStart);
    const tierInfo = getCurrentTierRate(cycleRobust.totalKwh);
    const rate = allInMarginalRate(tierInfo.rate);

    let perCircuit: CircuitTodayKwh[];
    let startTime: Date;

    if (range === 'hour') {
      // Last 60 minutes via HA hourly statistics. May return zeros when the
      // recorder hasn't yet flushed the current hour — callers should handle
      // gracefully (the UI shows '—' for zero values).
      startTime = new Date(now.getTime() - 60 * 60 * 1000);
      try {
        const { circuits } = await getGridConsumption(startTime, now, 'hour');
        perCircuit = circuits.map(c => ({
          entityId: c.entityId, label: c.label, category: c.category, kwh: +c.totalKwh.toFixed(3),
        }));
      } catch {
        perCircuit = [];
      }
    } else if (range === 'today') {
      const today = getTodayConsumptionFromStates();
      perCircuit = today.circuits;
      const laFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const parts = laFormatter.formatToParts(now);
      const y = parts.find(p => p.type === 'year')!.value;
      const m = parts.find(p => p.type === 'month')!.value;
      const d = parts.find(p => p.type === 'day')!.value;
      startTime = new Date(`${y}-${m}-${d}T00:00:00-07:00`);
    } else if (range === 'week') {
      startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const { circuits } = await getGridConsumption(startTime, now, 'day');
      perCircuit = circuits.map(c => ({
        entityId: c.entityId, label: c.label, category: c.category, kwh: +c.totalKwh.toFixed(3),
      }));
    } else if (range === 'month') {
      // Current calendar month (1st → now) via HA daily statistics.
      const laFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const laParts = laFormatter.formatToParts(now);
      const laY = laParts.find(p => p.type === 'year')!.value;
      const laM = laParts.find(p => p.type === 'month')!.value;
      startTime = new Date(`${laY}-${laM}-01T00:00:00-07:00`);
      const { circuits } = await getGridConsumption(startTime, now, 'day');
      perCircuit = circuits.map(c => ({
        entityId: c.entityId, label: c.label, category: c.category, kwh: +c.totalKwh.toFixed(3),
      }));
    } else if (range === 'year') {
      // Current calendar year (Jan 1 → now) via HA monthly statistics.
      startTime = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 8));
      const { circuits } = await getGridConsumption(startTime, now, 'month');
      perCircuit = circuits.map(c => ({
        entityId: c.entityId, label: c.label, category: c.category, kwh: +c.totalKwh.toFixed(3),
      }));
    } else {
      // Fallback: billing cycle (cycle-to-date from billing start day)
      perCircuit = cycleRobust.circuits;
      startTime = cycleStart;
    }

    const totalKwh = +perCircuit.reduce((s, c) => s + c.kwh, 0).toFixed(2);
    const daysWithData = Math.max(1, cycleRobust.daysWithData);

    const circuitBreakdown = perCircuit
      .map(c => ({
        entityId: c.entityId,
        label: c.label,
        category: c.category,
        kwh: +c.kwh.toFixed(2),
        estimatedCost: +(c.kwh * rate).toFixed(2),
        pctOfTotal: totalKwh > 0 ? +((c.kwh / totalKwh) * 100).toFixed(1) : 0,
        dailyAvg: range === 'cycle' ? +(c.kwh / daysWithData).toFixed(2) : undefined,
      }))
      .filter(c => c.kwh > 0)
      .sort((a, b) => b.kwh - a.kwh);

    // Top 8 power hogs
    const topConsumers = circuitBreakdown.slice(0, 8);

    const result = {
      range,
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
      totalKwh,
      totalEstimatedCost: +(totalKwh * rate).toFixed(2),
      currentRate: rate,
      currentTier: tierInfo.tier,
      source: cycleRobust.source,
      topConsumers,
      circuits: circuitBreakdown,
    };

    logAudit('electricity-api', {
      category: 'home', event_type: 'electricity_breakdown', severity: 'info',
      actor_id: 'system', channel: 'api',
      summary: `Breakdown (${range}): ${totalKwh.toFixed(0)} kWh across ${circuitBreakdown.length} circuits`,
      duration_ms: Date.now() - t0,
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json(result);
  } catch (err) {
    console.error('[electricity] breakdown error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /projection ────────────────────────────────────────────────────
// Month-end bill projection with tier breakdown.
router.get('/projection', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const cycleStart = estimateBillingCycleStart();
    const now = new Date();
    const daysInCycle = Math.max(1, Math.round((now.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24)));
    const robust = await getCycleConsumptionRobust(cycleStart);
    const totalKwh = robust.totalKwh;
    const daysCovered = Math.max(1, Math.min(robust.daysWithData, daysInCycle));
    const avgDailyKwh = totalKwh / daysCovered;
    const cycleLength = 60; // bi-monthly
    const projectedKwh = avgDailyKwh * cycleLength;
    const cycleEnd = new Date(cycleStart.getTime() + cycleLength * 24 * 60 * 60 * 1000);
    const projected = computeLadwpBill(projectedKwh, cycleStart, cycleEnd);

    // Also compute a "best case" (10% reduction) and "worst case" (10% increase)
    const bestCase = computeLadwpBill(projectedKwh * 0.9, cycleStart, cycleEnd);
    const worstCase = computeLadwpBill(projectedKwh * 1.1, cycleStart, cycleEnd);

    res.json({
      cycleStart: cycleStart.toISOString(),
      daysElapsed: daysInCycle,
      cycleLength,
      currentPace: { avgDailyKwh: +avgDailyKwh.toFixed(1), kwhSoFar: +totalKwh.toFixed(0) },
      projected: {
        totalKwh: Math.round(projectedKwh),
        bill: projected,
      },
      bestCase: {
        totalKwh: Math.round(projectedKwh * 0.9),
        totalCost: bestCase.totalElectricCharges,
      },
      worstCase: {
        totalKwh: Math.round(projectedKwh * 1.1),
        totalCost: worstCase.totalElectricCharges,
      },
    });
  } catch (err) {
    console.error('[electricity] projection error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /history ───────────────────────────────────────────────────────
// Historical monthly kWh + estimated bill for past N months.
router.get('/history', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const months = Math.min(parseInt(req.query.months as string) || 6, 12);
    const now = new Date();
    const history: Array<{
      month: string;
      kwh: number;
      estimatedBill: number;
      dailyAvg: number;
    }> = [];

    for (let i = months - 1; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const daysInMonth = monthEnd.getDate();

      try {
        const { totalKwh } = await getGridConsumption(monthStart, monthEnd, 'day');
        // Compute cost for this month (using half a bi-monthly cycle)
        const bill = computeLadwpBill(totalKwh * 2, monthStart, new Date(monthStart.getTime() + 60 * 24 * 60 * 60 * 1000));
        const monthCost = +(bill.totalElectricCharges / 2).toFixed(2);

        history.push({
          month: monthStart.toISOString().slice(0, 7), // YYYY-MM
          kwh: +totalKwh.toFixed(0),
          estimatedBill: monthCost,
          dailyAvg: +(totalKwh / daysInMonth).toFixed(1),
        });
      } catch {
        history.push({
          month: monthStart.toISOString().slice(0, 7),
          kwh: 0,
          estimatedBill: 0,
          dailyAvg: 0,
        });
      }
    }

    // Also include imported bill data if available
    let importedBills: Array<Record<string, unknown>> = [];
    try {
      const { rows } = await storage.query(
        `SELECT * FROM electricity_bills ORDER BY billing_period_start DESC LIMIT $1`,
        [months]
      );
      importedBills = rows;
    } catch {
      // Table may not exist yet
    }

    res.json({ history, importedBills });
  } catch (err) {
    console.error('[electricity] history error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── POST /bill-import ──────────────────────────────────────────────────
// Import actual LADWP bill figures for reconciliation.
router.post('/bill-import', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      billing_period_start,
      billing_period_end,
      ladwp_kwh,
      ladwp_total_usd,
    } = req.body;

    if (!billing_period_start || !billing_period_end || !ladwp_kwh || !ladwp_total_usd) {
      res.status(400).json({ error: 'Required: billing_period_start, billing_period_end, ladwp_kwh, ladwp_total_usd' });
      return;
    }

    // Compute our estimate for the same period
    const start = new Date(billing_period_start);
    const end = new Date(billing_period_end);
    const ourBill = computeLadwpBill(parseFloat(ladwp_kwh), start, end);
    const variancePct = ladwp_total_usd > 0
      ? +(((ourBill.totalElectricCharges - parseFloat(ladwp_total_usd)) / parseFloat(ladwp_total_usd)) * 100).toFixed(2)
      : 0;

    const { rows } = await storage.query(
      `INSERT INTO electricity_bills
        (billing_period_start, billing_period_end, ladwp_kwh, ladwp_total_usd,
         our_estimate_kwh, our_estimate_usd, variance_pct, raw_bill_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        billing_period_start,
        billing_period_end,
        ladwp_kwh,
        ladwp_total_usd,
        ladwp_kwh, // Same kWh — we just apply our rate model
        ourBill.totalElectricCharges,
        variancePct,
        JSON.stringify(req.body),
      ]
    );

    logAudit('electricity-api', {
      category: 'home', event_type: 'electricity_bill_imported', severity: 'info',
      actor_id: 'system', channel: 'api',
      summary: `Bill imported: ${ladwp_kwh} kWh / $${ladwp_total_usd} (${billing_period_start} to ${billing_period_end}). Our estimate: $${ourBill.totalElectricCharges} (${variancePct > 0 ? '+' : ''}${variancePct}%)`,
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json({
      id: rows[0]?.id,
      ourEstimate: ourBill.totalElectricCharges,
      ladwpActual: parseFloat(ladwp_total_usd),
      variancePct,
      breakdown: ourBill,
    });
  } catch (err) {
    console.error('[electricity] bill-import error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /savings-suggestions ───────────────────────────────────────────
// Generate savings recommendations based on circuit consumption patterns.
router.get('/savings-suggestions', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const cycleStart = estimateBillingCycleStart();
    const { totalKwh, circuits, daysWithData } = await getCycleConsumptionRobust(cycleStart);
    const days = Math.max(1, daysWithData);

    // Build per-circuit daily kWh averages
    const circuitData = circuits.map(c => ({
      label: c.label,
      entityId: c.entityId,
      dailyKwh: c.kwh / days,
    }));

    const tierInfo = getCurrentTierRate(totalKwh);
    const seasonRate = getSeasonalRate(new Date());
    const circuitSuggestions = generateSavingsSuggestions(circuitData, tierInfo.tier, seasonRate);
    const suggestions = [...circuitSuggestions];

    // Bill-level trend detection complements live circuit analysis. This catches
    // whole-house changes that are obvious on the LADWP meter even when the
    // circuit-level daily archive is still gathering enough history.
    let billTrend: {
      period: string;
      currentKwh: number;
      priorYearKwh: number;
      usageDeltaPct: number;
      dailyDeltaPct: number;
      excessCostThisCycle: number;
    } | null = null;
    try {
      const { rows } = await storage.query(
        `SELECT billing_period_start, billing_period_end, ladwp_kwh, raw_bill_data
         FROM electricity_bills
         ORDER BY billing_period_start DESC
         LIMIT 1`,
        [],
      );
      const latest = rows[0] as Record<string, unknown> | undefined;
      const raw = asRecord(latest?.raw_bill_data);
      const currentKwh = Number(latest?.ladwp_kwh);
      const priorYearKwh = Number(raw.prior_year_kwh);
      const days = Number(raw.days);
      const priorYearDays = Number(raw.prior_year_days);
      const start = parseBillDate(latest?.billing_period_start);
      const end = parseBillDate(latest?.billing_period_end);

      if (
        start && end &&
        currentKwh > 0 && priorYearKwh > 0 &&
        days > 0 && priorYearDays > 0
      ) {
        const usageDeltaPct = +(((currentKwh - priorYearKwh) / priorYearKwh) * 100).toFixed(1);
        const dailyDeltaPct = +((((currentKwh / days) / (priorYearKwh / priorYearDays)) - 1) * 100).toFixed(1);
        // Compare like-for-like days. The current bill is 58 days while the
        // printed prior-year comparison is 59, so raw kWh subtraction
        // understates the change and conflicts with the daily YoY percentage.
        const normalizedPriorYearKwh = (priorYearKwh / priorYearDays) * days;
        const excessKwh = Math.max(0, currentKwh - normalizedPriorYearKwh);
        const latestTier3Rate = Number(raw.tier3_rate);
        const excessRate = Number.isFinite(latestTier3Rate)
          ? allInMarginalRate(latestTier3Rate)
          : allInMarginalRate(tierInfo.rate);
        const excessCostThisCycle = +(excessKwh * excessRate).toFixed(0);

        billTrend = {
          period: formatBillingPeriod(start, end),
          currentKwh,
          priorYearKwh,
          usageDeltaPct,
          dailyDeltaPct,
          excessCostThisCycle,
        };

        if (dailyDeltaPct >= 10) {
          suggestions.unshift({
            category: 'Bill trend',
            headline: `Electricity jumped ${dailyDeltaPct}% per day year over year`,
            detail: `${currentKwh.toLocaleString()} kWh this cycle versus ${priorYearKwh.toLocaleString()} kWh last year, despite a shorter billing period. After normalizing both periods to ${days} days, the excess ${Math.round(excessKwh).toLocaleString()} kWh cost roughly $${excessCostThisCycle.toLocaleString()} at the current Tier 3 all-in rate. Use Top Consumers below to isolate what changed.`,
            potentialSavingsPerMonth: +(excessCostThisCycle / 2).toFixed(2),
          });
        }
      }
    } catch {
      // Actual bill history is additive; live circuit suggestions still work
      // before the bill migration has reached an environment.
    }

    res.json({
      currentTier: tierInfo,
      season: seasonRate.label,
      isSummer: seasonRate.isSummer,
      billTrend,
      suggestions,
      // Bill-trend savings overlap with circuit suggestions, so exclude that
      // diagnostic headline from the aggregate to avoid double-counting.
      totalPotentialMonthlySavings: +suggestions
        .filter(sg => sg.category !== 'Bill trend')
        .reduce((s, sg) => s + sg.potentialSavingsPerMonth, 0)
        .toFixed(2),
    });
  } catch (err) {
    console.error('[electricity] savings-suggestions error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /comparison ────────────────────────────────────────────────────
// Side-by-side: our estimate vs LADWP bill (when available).
router.get('/comparison', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    let bills: Array<Record<string, unknown>> = [];
    try {
      const { rows } = await storage.query(
        `SELECT * FROM electricity_bills ORDER BY billing_period_start DESC LIMIT 6`,
        []
      );
      bills = rows;
    } catch {
      // Table may not exist yet
    }

    // Build the comparison rows directly from the stored bill rows (newest-first
    // from the query), computing our estimate live from the rate model using
    // each row's actual billing_period_start/end. The DB is the single source of
    // truth — adding/correcting a bill only requires inserting/editing a row.
    const comparisons = bills
      .map(bill => {
        const start = parseBillDate(bill.billing_period_start);
        const end = parseBillDate(bill.billing_period_end);
        const kwh = Number(bill.ladwp_kwh);
        const ladwp = Number(bill.ladwp_total_usd);
        if (!start || !end || !Number.isFinite(kwh) || !Number.isFinite(ladwp)) return null;

        const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
        const ourEstimate = computeLadwpBill(kwh, start, end);
        const variance = ladwp > 0
          ? +(((ourEstimate.totalElectricCharges - ladwp) / ladwp) * 100).toFixed(2)
          : 0;

        return {
          period: formatBillingPeriod(start, end),
          kwh,
          days,
          ladwpActual: ladwp,
          ourEstimate: ourEstimate.totalElectricCharges,
          variance: `${variance > 0 ? '+' : ''}${variance}%`,
          tierBreakdown: {
            tier1: { kwh: ourEstimate.tier1Kwh, cost: ourEstimate.tier1Cost },
            tier2: { kwh: ourEstimate.tier2Kwh, cost: ourEstimate.tier2Cost },
            tier3: { kwh: ourEstimate.tier3Kwh, cost: ourEstimate.tier3Cost },
          },
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    res.json({ comparisons, importedBills: bills });
  } catch (err) {
    console.error('[electricity] comparison error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /rates ─────────────────────────────────────────────────────────
// Returns the current rate schedule (useful for the UI).
router.get('/rates', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  const now = new Date();
  const current = getSeasonalRate(now);
  const tierInfo = getCurrentTierRate(0, now); // What tier 1 rate looks like

  res.json({
    current: {
      season: current.label,
      isSummer: current.isSummer,
      tier1: current.tier1,
      tier2: current.tier2,
      tier3: current.tier3,
    },
    allotments: TIER_ALLOTMENTS,
    pac: { tier: 'Tier 3', monthlyCharge: 22.70 },
    utilityTaxRate: 0.10,
    stateEnergySurcharge: 0.0003,
    zone: 1,
    billingFrequency: 'bi-monthly',
  });
});


// LA-local [start, end) bounds for an explicit YYYY-MM-DD date.
function laDayBoundsForDate(dateStr: string): { start: Date; end: Date; usageDate: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  const laNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const offsetMs = now.getTime() - laNow.getTime();
  const startLocal = new Date(y, m - 1, d, 0, 0, 0, 0);
  const endLocal = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return {
    start: new Date(startLocal.getTime() + offsetMs),
    end: new Date(endLocal.getTime() + offsetMs),
    usageDate: dateStr,
  };
}

// Snapshot ONE LA-local day of per-circuit kWh into circuit_energy_daily from
// HA long-term statistics. Idempotent via (entity_id, usage_date) upsert.
// Returns the day's total kWh and circuits written.
async function snapshotOneDay(bounds: { start: Date; end: Date; usageDate: string }): Promise<{ circuits: number; totalKwh: number }> {
  const entityIds = ENERGY_CIRCUITS.map(c => c.entityId);
  const stats = await getEnergyStatistics(entityIds, bounds.start, bounds.end, 'day');

  let written = 0;
  let totalKwh = 0;
  for (const circuit of ENERGY_CIRCUITS) {
    const points = stats[circuit.entityId] ?? [];
    // Absence is not zero usage. Skipping the row lets completeness-aware
    // consumers identify the day as partial instead of trusting fabricated 0s.
    if (points.length === 0) continue;
    const kwh = +points.reduce((s, p) => s + (p.change || 0), 0).toFixed(4);
    totalKwh += kwh;
    await storage.query(
      `INSERT INTO circuit_energy_daily (usage_date, entity_id, label, category, kwh, source_complete)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (entity_id, usage_date)
       DO UPDATE SET kwh = EXCLUDED.kwh, label = EXCLUDED.label,
                     category = EXCLUDED.category, source_complete = true, captured_at = now()`,
      [bounds.usageDate, circuit.entityId, circuit.label, circuit.category, kwh],
    );
    written++;
  }
  return { circuits: written, totalKwh: +totalKwh.toFixed(3) };
}

// POST /snapshot-daily
// Records ONE LA-local day of per-circuit kWh into circuit_energy_daily so
// Janus owns the full history independent of HA's recorder purge window.
// Defaults to yesterday (the last fully-complete day). Pass { date: 'YYYY-MM-DD' }
// or { daysBack: N } to backfill. Idempotent via (entity_id, usage_date) upsert.
// Cron- or admin-gated (no user session required).
router.post('/snapshot-daily', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid cron secret required.' });
    }

    let bounds: { start: Date; end: Date; usageDate: string };
    const explicitDate = (req.body?.date as string | undefined)?.trim();
    if (explicitDate && /^\d{4}-\d{2}-\d{2}$/.test(explicitDate)) {
      bounds = laDayBoundsForDate(explicitDate);
    } else {
      const daysBack = Math.max(1, Math.min(parseInt(String(req.body?.daysBack ?? '1'), 10) || 1, 400));
      bounds = laDayBounds(daysBack);
    }

    const { circuits, totalKwh } = await snapshotOneDay(bounds);

    logAudit('electricity-snapshot', {
      category: 'home', event_type: 'circuit_energy_daily_snapshot', severity: 'info',
      actor_id: 'system', channel: 'cron',
      summary: `Snapshotted ${circuits} circuits for ${bounds.usageDate} (${totalKwh.toFixed(1)} kWh total)`,
      detail: { usage_date: bounds.usageDate, circuits, total_kwh: totalKwh },
      status: 'success',
    }).catch(() => {});

    res.json({ ok: true, usageDate: bounds.usageDate, circuits, totalKwh });
  } catch (err) {
    console.error('[electricity] snapshot-daily error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// POST /backfill
// Re-fetches the last 30 complete LA days and writes only dates for which HA
// returned a real, valid daily statistic for the entire canonical hierarchy.
// The fixed window keeps this admin operation bounded. It is idempotent, and an
// excluded date is never updated, so legacy zero-filled rows remain quarantined.
router.post('/backfill', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid cron secret required.' });
    }

    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStr = fmt.format(yesterday);
    const fromStr = fmt.format(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const toStr = yesterdayStr;
    const fetchBounds = {
      start: laDayBoundsForDate(fromStr).start,
      end: laDayBoundsForDate(toStr).end,
    };
    const stats = await getEnergyStatistics(
      CANONICAL_ENERGY_HIERARCHY_IDS,
      fetchBounds.start,
      fetchBounds.end,
      'day',
    );
    const circuitById = new Map(ENERGY_CIRCUITS.map(circuit => [circuit.entityId, circuit]));

    let cursor = new Date(`${fromStr}T12:00:00Z`);
    const endCursor = new Date(`${toStr}T12:00:00Z`);
    let daysTrusted = 0;
    let grandTotalKwh = 0;
    let grandLeafKwh = 0;
    const dates: Array<{
      date: string;
      status: 'trusted' | 'excluded';
      circuitsWritten: number;
      totalKwh?: number;
      leafKwh?: number;
      reason?: string;
      missingEntityIds?: string[];
      invalidEntityIds?: string[];
    }> = [];

    while (cursor <= endCursor) {
      const dayStr = fmt.format(cursor);
      const validation = validateCompleteDailyEnergyStatistics(stats, dayStr);
      if (!validation.complete) {
        dates.push({
          date: dayStr,
          status: 'excluded',
          circuitsWritten: 0,
          reason: validation.invalidEntityIds.length > 0
            ? 'HA returned invalid daily statistics'
            : 'HA did not return the complete canonical hierarchy',
          missingEntityIds: validation.missingEntityIds,
          invalidEntityIds: validation.invalidEntityIds,
        });
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
        continue;
      }

      const params: unknown[] = [];
      const valueSql = CANONICAL_ENERGY_HIERARCHY_IDS.map((entityId, index) => {
        const circuit = circuitById.get(entityId);
        if (!circuit) throw new Error(`Canonical energy entity is missing from catalog: ${entityId}`);
        const offset = index * 5;
        params.push(dayStr, entityId, circuit.label, circuit.category, validation.values.get(entityId));
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, true)`;
      }).join(', ');
      await storage.query(
        `INSERT INTO circuit_energy_daily (usage_date, entity_id, label, category, kwh, source_complete)
         VALUES ${valueSql}
         ON CONFLICT (entity_id, usage_date)
         DO UPDATE SET kwh = EXCLUDED.kwh, label = EXCLUDED.label,
                       category = EXCLUDED.category, source_complete = true, captured_at = now()`,
        params,
      );
      // Panel mains are the non-overlapping whole-house total. Keep the leaf
      // total separate because summing mains and children would double-count.
      const totalKwh = +PANEL_MAIN_ENERGY_ENTITY_IDS
        .reduce((sum, entityId) => sum + (validation.values.get(entityId) ?? 0), 0)
        .toFixed(3);
      const leafKwh = +CANONICAL_LEAF_ENERGY_ENTITY_IDS
        .reduce((sum, entityId) => sum + (validation.values.get(entityId) ?? 0), 0)
        .toFixed(3);
      grandTotalKwh += totalKwh;
      grandLeafKwh += leafKwh;
      daysTrusted++;
      dates.push({
        date: dayStr,
        status: 'trusted',
        circuitsWritten: CANONICAL_ENERGY_HIERARCHY_IDS.length,
        totalKwh,
        leafKwh,
      });
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }

    const excludedDates = dates.filter(date => date.status === 'excluded');
    logAudit('electricity-snapshot', {
      category: 'home', event_type: 'circuit_energy_daily_backfill', severity: 'info',
      actor_id: 'system', channel: 'cron',
      summary: `Trusted energy backfill: ${daysTrusted}/30 days (${fromStr}…${toStr}); ${excludedDates.length} excluded`,
      detail: {
        fromDate: fromStr,
        toDate: toStr,
        days_trusted: daysTrusted,
        excluded_dates: excludedDates.map(date => date.date),
        panel_main_kwh: +grandTotalKwh.toFixed(3),
        canonical_leaf_kwh: +grandLeafKwh.toFixed(3),
      },
      status: excludedDates.length ? 'partial' : 'success',
    }).catch(() => {});

    res.json({
      ok: true,
      fromDate: fromStr,
      toDate: toStr,
      daysRequested: 30,
      daysProcessed: dates.length,
      daysTrusted,
      daysExcluded: excludedDates.length,
      totalKwh: +grandTotalKwh.toFixed(3),
      leafKwh: +grandLeafKwh.toFixed(3),
      canonicalCircuitsRequired: CANONICAL_ENERGY_HIERARCHY_IDS.length,
      dates,
    });
  } catch (err) {
    console.error('[electricity] backfill error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// GET /circuit-history
// Per-circuit / per-category monthly (or daily) report from the Janus-owned
// circuit_energy_daily table. Works for ANY past month, indefinitely.
//   ?months=12                  trailing months (default 6, max 36)
//   ?from=YYYY-MM&to=YYYY-MM     explicit month range (overrides ?months)
//   ?groupBy=circuit|category    default 'category'
//   ?granularity=month|day       default 'month'
router.get('/circuit-history', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const groupBy = (req.query.groupBy as string) === 'circuit' ? 'circuit' : 'category';
    const granularity = (req.query.granularity as string) === 'day' ? 'day' : 'month';
    const groupExpr = granularity === 'day'
      ? `to_char(usage_date, 'YYYY-MM-DD')`
      : `to_char(usage_date, 'YYYY-MM')`;
    const dim = groupBy === 'circuit' ? 'entity_id' : 'category';
    const labelCol = groupBy === 'circuit' ? 'label' : 'category';

    const from = (req.query.from as string)?.match(/^\d{4}-\d{2}$/)?.[0];
    const to = (req.query.to as string)?.match(/^\d{4}-\d{2}$/)?.[0];
    const params: unknown[] = [];
    let where = '';
    if (from && to) {
      where = `WHERE usage_date >= ($1 || '-01')::date
               AND usage_date < (($2 || '-01')::date + interval '1 month')`;
      params.push(from, to);
    } else {
      const months = Math.min(Math.max(parseInt(req.query.months as string) || 6, 1), 36);
      where = `WHERE usage_date >= (date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')) - (($1)::text || ' months')::interval)`;
      params.push(months - 1);
    }

    const { rows } = await storage.query(
      `SELECT ${groupExpr} AS period,
              ${dim} AS key,
              MAX(${labelCol}) AS label,
              ROUND(SUM(kwh)::numeric, 3) AS kwh,
              COUNT(DISTINCT usage_date) AS days
       FROM circuit_energy_daily
       ${where}
       GROUP BY period, ${dim}
       ORDER BY period DESC, kwh DESC`,
      params,
    );

    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.period, (totals.get(r.period) || 0) + Number(r.kwh));

    res.json({
      groupBy,
      granularity,
      rows,
      periodTotals: Array.from(totals.entries())
        .map(([period, kwh]) => ({ period, kwh: +kwh.toFixed(3) }))
        .sort((a, b) => (a.period < b.period ? 1 : -1)),
    });
  } catch (err) {
    console.error('[electricity] circuit-history error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// The 5 panel-main energy entities (kWh). Summing ONLY these gives the
// whole-house hourly total without double-counting children (the mains
// already include their child circuits). Mirrors PANEL_MAIN_POWER_ENTITIES.
const PANEL_MAIN_ENERGY_ENTITIES = [...PANEL_MAIN_ENERGY_ENTITY_IDS];

// ── GET /panel-history ─────────────────────────────────────────────────
// Hourly kWh history for a single panel (or any known energy circuit) over
// the last N hours, via HA recorder/statistics_during_period (period='hour').
// Mirrors the native Emporia app "History" tab. Falls back gracefully to an
// empty points array when HA statistics aren't available for the entity.
//   ?entityId=sensor.garage_panel_1_energy_today   (single, must be known)
//   ?entityIds=a,b,c                               (multiple; summed per bucket)
//   ?target=house                                  (sums the 5 panel mains)
//   ?hours=24                                        (default 24)
//   ?period=hour|day                                 (default hour)
// `period=hour` aggregates per-hour and caps the window at 168 h (7 d);
// `period=day` aggregates per-day and caps the window at 90 d (2160 h), so the
// drawer can offer 24 h / 7 d / 30 d ranges like the native Emporia app.
// When multiple entities are requested the per-bucket kWh values are summed so
// the chart shows combined load (e.g. whole-house = sum of the 5 panel mains).
router.get('/panel-history', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const t0 = Date.now();
    const target = ((req.query.target as string) || '').trim().toLowerCase();
    const rawIds = ((req.query.entityIds as string) || (req.query.entityId as string) || '').trim();

    // Resolve the requested entity ID list. `target=house` is a convenience
    // alias for the 5 panel mains; otherwise parse comma-separated entityIds.
    let entityIds: string[];
    if (target === 'house') {
      entityIds = [...PANEL_MAIN_ENERGY_ENTITIES];
    } else {
      entityIds = rawIds.split(',').map(s => s.trim()).filter(Boolean);
    }

    if (entityIds.length === 0) {
      res.status(400).json({ error: 'entityId, entityIds, or target=house is required' });
      return;
    }

    // Validate every requested id against the known energy-circuit catalog so
    // we never run an arbitrary statistic query against an unexpected id.
    const circuits = entityIds.map(id => ENERGY_CIRCUITS.find(c => c.entityId === id));
    const unknownIdx = circuits.findIndex(c => !c);
    if (unknownIdx !== -1) {
      res.status(400).json({ error: `Unknown entityId: ${entityIds[unknownIdx]}` });
      return;
    }

    // Daily aggregation (period=day) allows longer windows (up to 90 d) so the
    // drawer can offer 7 d / 30 d ranges; hourly stays capped at 168 h (7 d).
    const period: 'hour' | 'day' = ((req.query.period as string) || '').trim().toLowerCase() === 'day' ? 'day' : 'hour';
    const maxHours = period === 'day' ? 90 * 24 : 168;
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), maxHours);
    const now = new Date();
    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);

    // ?compare=previous also returns the prior equivalent window (the N hours
    // immediately before `start`) so the UI can show a trend delta ("+12% vs
    // last 7 days") and overlay the previous period on the chart. Both windows
    // are fetched in ONE statistics call spanning 2×N hours, then split at
    // `start` — one HA round trip instead of two.
    const compareRaw = ((req.query.compare as string) || '').trim().toLowerCase();
    const compare = compareRaw === 'previous' || compareRaw === '1' || compareRaw === 'true';
    const fetchStart = compare ? new Date(start.getTime() - hours * 60 * 60 * 1000) : start;

    // Fetch all requested entities in one statistics call, then sum each
    // entity's per-bucket kWh into a single bucket keyed by the bucket-start ISO.
    // Also keep each entity's own per-bucket series so the whole-house chart can
    // render a stacked breakdown (one segment per panel) instead of just the sum.
    let points: Array<{ start: string; kwh: number }> = [];
    let series: Array<{ entityId: string; label: string; points: Array<{ start: string; kwh: number }> }> = [];
    let prevPoints: Array<{ start: string; kwh: number }> = [];
    try {
      const stats = await getEnergyStatistics(entityIds, fetchStart, now, period);
      const splitMs = start.getTime();
      const splitIso = start.toISOString();
      const fetchStartMs = fetchStart.getTime();
      const buckets = new Map<string, number>();
      const prevBuckets = new Map<string, number>();
      // Buckets that started before the current window belong to the comparison
      // (previous) window. Prefer parsed-timestamp comparison (robust to any
      // ISO offset format); fall back to lexicographic if a start is unparseable.
      const isPrevBucket = (bucketStart: string): boolean => {
        const t = new Date(bucketStart).getTime();
        return Number.isFinite(t) ? t < splitMs : bucketStart < splitIso;
      };
      // HA's statistics_during_period can return the bucket that STRADDLES the
      // range start (observed with period=day: a request starting mid-day gets
      // the full-day bucket for that calendar day). Its `change` covers the
      // whole bucket — mostly outside the requested window — so counting it
      // adds an extra full day to the (previous) window: 31 buckets vs 30,
      // an inflated previous total, and a one-bucket positional shift in the
      // overlay. Drop any bucket that starts before the fetch window.
      const isOutsideWindow = (bucketStart: string): boolean => {
        const t = new Date(bucketStart).getTime();
        return Number.isFinite(t) && t < fetchStartMs;
      };
      for (let i = 0; i < entityIds.length; i++) {
        const id = entityIds[i];
        const entPoints: Array<{ start: string; kwh: number }> = [];
        for (const p of stats[id] ?? []) {
          if (isOutsideWindow(p.start)) continue;
          const change = p.change || 0;
          if (compare && isPrevBucket(p.start)) {
            prevBuckets.set(p.start, (prevBuckets.get(p.start) ?? 0) + change);
            continue;
          }
          buckets.set(p.start, (buckets.get(p.start) ?? 0) + change);
          entPoints.push({ start: p.start, kwh: +change.toFixed(3) });
        }
        entPoints.sort((a, b) => (a.start < b.start ? -1 : 1));
        series.push({ entityId: id, label: circuits[i]!.label, points: entPoints });
      }
      points = Array.from(buckets.entries())
        .map(([s, kwh]) => ({ start: s, kwh: +kwh.toFixed(3) }))
        .sort((a, b) => (a.start < b.start ? -1 : 1));
      prevPoints = Array.from(prevBuckets.entries())
        .map(([s, kwh]) => ({ start: s, kwh: +kwh.toFixed(3) }))
        .sort((a, b) => (a.start < b.start ? -1 : 1));
    } catch {
      points = [];
      series = [];
      prevPoints = [];
    }

    const totalKwh = +points.reduce((s, p) => s + p.kwh, 0).toFixed(3);
    const previous = compare
      ? {
          startTime: fetchStart.toISOString(),
          endTime: start.toISOString(),
          totalKwh: +prevPoints.reduce((s, p) => s + p.kwh, 0).toFixed(3),
          points: prevPoints,
        }
      : undefined;

    // Single-entity requests keep the catalog label; multi-entity / house
    // requests use a combined label.
    const isHouse = target === 'house' || entityIds.length === PANEL_MAIN_ENERGY_ENTITIES.length
      && PANEL_MAIN_ENERGY_ENTITIES.every(id => entityIds.includes(id));
    const label = entityIds.length === 1
      ? circuits[0]!.label
      : isHouse ? 'Whole House' : `${entityIds.length} circuits`;

    // Current all-in marginal rate for a cost estimate (best-effort).
    let rate = 0;
    try {
      const cycleStart = estimateBillingCycleStart();
      const cycleRobust = await getCycleConsumptionRobust(cycleStart);
      rate = allInMarginalRate(getCurrentTierRate(cycleRobust.totalKwh).rate);
    } catch { /* best-effort */ }

    logAudit('electricity-api', {
      category: 'home', event_type: 'electricity_panel_history', severity: 'info',
      actor_id: 'system', channel: 'api',
      summary: `Panel history (${label}): ${points.length} ${period === 'day' ? 'daily' : 'hourly'} points · ${totalKwh.toFixed(1)} kWh over ${hours}h`,
      duration_ms: Date.now() - t0,
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json({
      entityId: entityIds.length === 1 ? entityIds[0] : entityIds.join(','),
      entityIds,
      label,
      hours,
      period,
      startTime: start.toISOString(),
      endTime: now.toISOString(),
      totalKwh,
      currentRate: rate,
      points,
      series,
      previous,
    });
  } catch (err) {
    console.error('[electricity] panel-history error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /live-rate ─────────────────────────────────────────────────────
// Compact payload for the Live Cost Hero: live kW, the all-in marginal
// $/kWh (true cost of the next kWh), $/hour burn, current tier and season.
router.get('/live-rate', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const cycleStart = estimateBillingCycleStart();
    const robust = await getCycleConsumptionRobust(cycleStart);
    const tierInfo = getCurrentTierRate(robust.totalKwh);
    const season = getSeasonalRate(new Date());
    const marginal = allInMarginalRate(tierInfo.rate);
    const liveWatts = getLiveTotalWatts();
    const liveKw = +(liveWatts / 1000).toFixed(2);

    res.json({
      liveKw,
      liveWatts,
      marginalRatePerKwh: marginal,
      tierRatePerKwh: tierInfo.rate,
      dollarsPerHour: +(liveKw * marginal).toFixed(2),
      tier: tierInfo.tier,
      seasonLabel: season.label,
      isSummer: season.isSummer,
    });
  } catch (err) {
    console.error('[electricity] live-rate error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /insights ──────────────────────────────────────────────────────
const INSIGHTS_MIN_DAYS = 14;
const INSIGHTS_TARGET_DAYS = 30;
const INSIGHTS_CONTEXT_CACHE_MS = 30 * 60 * 1000;
const HOME_LAT = 34.0522;
const HOME_LNG = -118.2437;
let insightsContextCache: { key: string; expiresAt: number; rows: EnergyDailyContextRow[] } | null = null;

function addIsoDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

function laMidnight(date: string): Date {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset',
  }).formatToParts(noonUtc).find(part => part.type === 'timeZoneName')?.value;
  const offset = offsetPart?.replace('GMT', '') || '-08:00';
  return new Date(`${date}T00:00:00${offset}`);
}

async function fetchInsightsContext(startDate: string, endDate: string): Promise<EnergyDailyContextRow[]> {
  const key = `${startDate}:${endDate}`;
  if (insightsContextCache?.key === key && insightsContextCache.expiresAt > Date.now()) {
    return insightsContextCache.rows;
  }
  const byDate = new Map<string, EnergyDailyContextRow>();
  const weatherUrl = new URL('https://archive-api.open-meteo.com/v1/archive');
  weatherUrl.searchParams.set('latitude', String(HOME_LAT));
  weatherUrl.searchParams.set('longitude', String(HOME_LNG));
  weatherUrl.searchParams.set('start_date', startDate);
  weatherUrl.searchParams.set('end_date', endDate);
  weatherUrl.searchParams.set('daily', 'temperature_2m_mean');
  weatherUrl.searchParams.set('temperature_unit', 'fahrenheit');
  weatherUrl.searchParams.set('timezone', 'America/Los_Angeles');

  const weatherPromise = fetch(weatherUrl, { signal: AbortSignal.timeout(8_000) })
    .then(async response => {
      if (!response.ok) throw new Error(`weather history returned ${response.status}`);
      const body = await response.json() as { daily?: { time?: unknown[]; temperature_2m_mean?: unknown[] } };
      const dates = body.daily?.time ?? [];
      const temperatures = body.daily?.temperature_2m_mean ?? [];
      dates.forEach((date, index) => {
        const value = Number(temperatures[index]);
        if (typeof date === 'string' && Number.isFinite(value)) {
          byDate.set(date, { date, averageOutdoorTempF: value });
        }
      });
    })
    .catch(error => console.warn('[electricity] weather context unavailable:', error instanceof Error ? error.message : error));

  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  const occupancyPromise = !haUrl || !haToken ? Promise.resolve() : (async () => {
    const start = laMidnight(startDate).toISOString();
    const end = laMidnight(addIsoDays(endDate, 1)).toISOString();
    const url = `${haUrl.replace(/\/$/, '')}/api/history/period/${encodeURIComponent(start)}?end_time=${encodeURIComponent(end)}&minimal_response&filter_entity_id=zone.home`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${haToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`occupancy history returned ${response.status}`);
    const body = await response.json() as Array<Array<{ state?: unknown; last_changed?: string; lu?: number }>>;
    const points = Array.isArray(body?.[0]) ? body[0] : [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const from = new Date(point.last_changed ?? Number(point.lu) * 1000);
      const to = index + 1 < points.length
        ? new Date(points[index + 1].last_changed ?? Number(points[index + 1].lu) * 1000)
        : new Date(end);
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) continue;
      const occupied = Number(point.state) > 0;
      let cursor = from;
      while (cursor < to) {
        const date = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(cursor);
        const nextDay = laMidnight(addIsoDays(date, 1));
        const segmentEnd = nextDay < to ? nextDay : to;
        const hours = (segmentEnd.getTime() - cursor.getTime()) / 3_600_000;
        const row = byDate.get(date) ?? { date };
        row.occupancyCoverageHours = Number(row.occupancyCoverageHours ?? 0) + hours;
        if (occupied) row.occupiedHours = Number(row.occupiedHours ?? 0) + hours;
        byDate.set(date, row);
        cursor = segmentEnd;
      }
    }
  })().catch(error => console.warn('[electricity] occupancy context unavailable:', error instanceof Error ? error.message : error));

  await Promise.all([weatherPromise, occupancyPromise]);
  const rows = [...byDate.values()];
  insightsContextCache = { key, expiresAt: Date.now() + INSIGHTS_CONTEXT_CACHE_MS, rows };
  return rows;
}

// These rows are parents or raw duplicate channels whose energy is already
// represented by named child circuits. They remain in the canonical HA catalog
// for live/history compatibility, but must not be summed with their children.
const INSIGHTS_LEAF_IDS = CANONICAL_LEAF_ENERGY_ENTITY_IDS;

function requireElectricityAdmin(req: AuthenticatedRequest, res: Response, next: () => void): void {
  if (req.userRole !== 'admin') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

router.get('/insights', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const yesterday = laDayBounds(1).usageDate;
    const { rows } = await storage.query(
      `SELECT to_char(usage_date, 'YYYY-MM-DD') AS usage_date,
              entity_id, label, category, kwh
       FROM circuit_energy_daily
       WHERE usage_date BETWEEN $1::date - 29 AND $1::date
         AND source_complete = true
       ORDER BY usage_date, entity_id`,
      [yesterday],
    );

    const cycleStart = estimateBillingCycleStart();
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const cycleStartDate = dateFormatter.format(cycleStart);
    const todayDate = dateFormatter.format(new Date());
    const { rows: trustedCycleRows } = await storage.query(
      `SELECT to_char(usage_date, 'YYYY-MM-DD') AS usage_date, SUM(kwh) AS kwh
       FROM circuit_energy_daily
       WHERE usage_date >= $1::date AND usage_date < $2::date
         AND source_complete = true
         AND entity_id = ANY($3::text[])
       GROUP BY usage_date
       HAVING COUNT(DISTINCT entity_id) = $4
       ORDER BY usage_date`,
      [cycleStartDate, todayDate, PANEL_MAIN_ENERGY_ENTITIES, PANEL_MAIN_ENERGY_ENTITIES.length],
    );
    const trustedCompletedKwh = trustedCycleRows.reduce(
      (sum, row) => sum + Number(row.kwh ?? 0),
      0,
    );
    const expectedCompletedDays = Math.max(0, Math.round(
      (new Date(`${todayDate}T00:00:00Z`).getTime() - new Date(`${cycleStartDate}T00:00:00Z`).getTime())
      / (24 * 60 * 60 * 1000),
    ));
    const hasFullCycleCoverage = trustedCycleRows.length >= expectedCompletedDays;
    const tier3Threshold = TIER_ALLOTMENTS.tier1 + TIER_ALLOTMENTS.tier2;
    const tierAlreadyCertain = trustedCompletedKwh > tier3Threshold;
    const liveById = new Map(getEntityCache().map(entity => [entity.entity_id, entity.state]));
    const todayPanelValues = PANEL_MAIN_ENERGY_ENTITIES.map(entityId => {
      const value = Number(liveById.get(entityId));
      return Number.isFinite(value) && value >= 0 ? value : null;
    });
    const hasCompleteTodayPanels = todayPanelValues.every((value): value is number => value !== null);
    const todayPanelKwh = hasCompleteTodayPanels
      ? todayPanelValues.reduce((sum, value) => sum + value, 0)
      : 0;
    const tariffContextReady = tierAlreadyCertain || (hasFullCycleCoverage && hasCompleteTodayPanels);
    const canonicalCycleKwh = trustedCompletedKwh
      + (hasFullCycleCoverage && hasCompleteTodayPanels ? todayPanelKwh : 0);
    const tierInfo = getCurrentTierRate(canonicalCycleKwh);
    const season = getSeasonalRate(new Date());
    const marginal = allInMarginalRate(tierInfo.rate);
    const dailyContext = await fetchInsightsContext(addIsoDays(yesterday, -29), yesterday);
    const analysis = analyzeEnergyInsights({
      rows,
      canonicalLeafIds: INSIGHTS_LEAF_IDS,
      endDate: yesterday,
      marginalRate: marginal,
      currentTierContext: { tier: tierInfo.tier },
      dailyContext,
    });
    const { rows: investigationRows } = await storage.query(
      `SELECT occurrence_id, finding_id, finding_snapshot,
              scope_type, scope_label, scope_entity_ids, tariff_tier,
              to_char(action_date, 'YYYY-MM-DD') AS action_date, investigated_at
       FROM energy_insight_investigations
       ORDER BY investigated_at DESC`,
      [],
    );
    const hydratedInvestigations = await Promise.all(investigationRows.map(async row => {
      const snapshot = asRecord(row.finding_snapshot) as unknown as EnergyFinding;
      const storedIds = Array.isArray(row.scope_entity_ids)
        ? row.scope_entity_ids.map(String).filter((id: string) => INSIGHTS_LEAF_IDS.includes(id))
        : [];
      const scopeEntityIds = storedIds.length ? storedIds : INSIGHTS_LEAF_IDS;
      const actionDate = String(row.action_date);
      const comparisonStart = new Date(`${actionDate}T12:00:00`);
      comparisonStart.setDate(comparisonStart.getDate() - 14);
      const comparisonEnd = new Date(`${actionDate}T12:00:00`);
      comparisonEnd.setDate(comparisonEnd.getDate() + 14);
      const comparisonTariff = getSeasonalRateForPeriod(comparisonStart, comparisonEnd);
      const storedTier = Number(row.tariff_tier);
      const comparisonTier = [1, 2, 3].includes(storedTier) ? storedTier : tierInfo.tier;
      const tierRate = comparisonTier === 1
        ? comparisonTariff.tier1
        : comparisonTier === 2
          ? comparisonTariff.tier2
          : comparisonTariff.tier3;
      const { rows: comparisonRows } = await storage.query(
        `SELECT to_char(usage_date, 'YYYY-MM-DD') AS usage_date, entity_id, label, category, kwh
         FROM circuit_energy_daily
         WHERE usage_date BETWEEN $1::date - 14 AND $1::date + 14
           AND usage_date <> $1::date AND source_complete = true
         ORDER BY usage_date, entity_id`,
        [actionDate],
      );
      return {
        ...snapshot,
        occurrenceId: String(row.occurrence_id),
        tariffTier: comparisonTier,
        measurementScope: {
          type: String(row.scope_type),
          label: String(row.scope_label),
          entityIds: scopeEntityIds,
        },
        investigation: {
          actionDate,
          investigatedAt: row.investigated_at,
          realized: measureRealizedSavings({
            rows: comparisonRows,
            canonicalLeafIds: scopeEntityIds,
            actionDate,
            latestCompleteDate: yesterday,
            marginalRate: allInMarginalRate(tierRate),
          }),
        },
      };
    }));

    if (!analysis.ready || !tariffContextReady) {
      const message = !analysis.ready
        ? analysis.dataQuality.message
        : `Circuit history is ready, but only ${trustedCycleRows.length} of ${expectedCompletedDays} completed billing-cycle days have all five panel mains. Cost findings will unlock when the current LADWP tier can be determined without guessing.`;
      res.json({
        ready: false,
        daysCollected: analysis.dataQuality.usableFullDays,
        minDays: INSIGHTS_MIN_DAYS,
        targetDays: INSIGHTS_TARGET_DAYS,
        message,
        dataQuality: {
          ...analysis.dataQuality,
          level: tariffContextReady ? analysis.dataQuality.level : 'limited',
          message,
        },
        investigatedFindings: hydratedInvestigations,
      });
      return;
    }

    const investigations = new Map(hydratedInvestigations.map(item => [item.occurrenceId, item]));
    const circuitMetadata = ENERGY_CIRCUITS.map(circuit => ({
      entityId: circuit.entityId, label: circuit.label, category: circuit.category,
    }));
    const findings = analysis.findings.map(finding => {
      const occurrenceId = findingOccurrenceId(finding);
      const scope = measurementScopeForFinding(finding, INSIGHTS_LEAF_IDS, circuitMetadata);
      const investigation = investigations.get(occurrenceId);
      if (!investigation) return { ...finding, occurrenceId, tariffTier: tierInfo.tier, measurementScope: scope };
      return {
        ...finding,
        occurrenceId,
        tariffTier: tierInfo.tier,
        measurementScope: scope,
        investigation: investigation.investigation,
      };
    });
    const activeOccurrenceIds = new Set(findings.map(finding => finding.occurrenceId));
    const investigatedFindings = hydratedInvestigations
      .filter(item => !activeOccurrenceIds.has(item.occurrenceId));
    res.json({ ...analysis, findings, investigatedFindings, season: season.label, targetDays: INSIGHTS_TARGET_DAYS });
  } catch (err) {
    console.error('[electricity] insights error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

router.patch('/insights/:findingId/investigation', requireAuth, requireElectricityAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const findingId = String(req.params.findingId ?? '').trim();
    const actionDate = String(req.body?.actionDate ?? '');
    const finding = req.body?.finding as EnergyFinding | undefined;
    const tariffTier = Number(req.body?.tariffTier);
    if (!findingId || !/^\d{4}-\d{2}-\d{2}$/.test(actionDate) || Number.isNaN(new Date(`${actionDate}T00:00:00Z`).getTime())) {
      res.status(400).json({ error: 'A valid actionDate in YYYY-MM-DD format is required.' });
      return;
    }
    const yesterday = laDayBounds(1).usageDate;
    if (actionDate > yesterday) {
      res.status(400).json({ error: 'The change date cannot be in the future.' });
      return;
    }
    if (!finding || finding.id !== findingId || findingOccurrenceId(finding) !== String(req.body?.occurrenceId ?? '') || ![1, 2, 3].includes(tariffTier)) {
      res.status(400).json({ error: 'The finding occurrence is missing or invalid.' });
      return;
    }
    const scope = measurementScopeForFinding(finding, INSIGHTS_LEAF_IDS, ENERGY_CIRCUITS.map(circuit => ({
      entityId: circuit.entityId, label: circuit.label, category: circuit.category,
    })));
    const occurrenceId = findingOccurrenceId(finding);
    const { rows } = await storage.query(
      `INSERT INTO energy_insight_investigations
         (occurrence_id, finding_id, action_date, finding_snapshot, scope_type, scope_label,
          scope_entity_ids, tariff_tier, investigated_by, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::text[], $8, $9, now())
       ON CONFLICT (occurrence_id) DO UPDATE
       SET action_date = EXCLUDED.action_date,
           finding_snapshot = EXCLUDED.finding_snapshot,
           scope_type = EXCLUDED.scope_type,
           scope_label = EXCLUDED.scope_label,
           scope_entity_ids = EXCLUDED.scope_entity_ids,
           tariff_tier = EXCLUDED.tariff_tier,
           investigated_by = EXCLUDED.investigated_by,
           investigated_at = now(),
           updated_at = now()
       RETURNING occurrence_id, finding_id, to_char(action_date, 'YYYY-MM-DD') AS action_date, investigated_at`,
      [occurrenceId, findingId, actionDate, JSON.stringify(finding), scope.type, scope.label, scope.entityIds, tariffTier, req.userId ?? null],
    );
    logAudit('electricity-api', {
      category: 'home', event_type: 'energy_insight_investigated', severity: 'info',
      actor_id: req.userId ?? 'admin', channel: 'api',
      summary: `Energy finding ${findingId} marked investigated with change date ${actionDate}; no equipment control was performed.`,
      status: 'success',
    }).catch(() => undefined);
    res.json(rows[0]);
  } catch (err) {
    console.error('[electricity] investigation update error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

export default router;
