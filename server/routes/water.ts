/**
 * Water Cost Intelligence API
 * ───────────────────────────────
 * REST routes for live water cost, interior vs irrigation breakdown, history,
 * and a daily snapshot that records prior-day usage into water_usage_daily.
 *
 * Two non-overlapping sources (no double count):
 *   • interior   → FloLogic whole-property gallons (server/lib/floLogic.ts)
 *   • irrigation → Rain Bird per-zone gallons = GPM × runtime minutes
 *                  (runtime read from HA switch history; GPM from
 *                   server/lib/irrigationFlow.ts)
 *
 * Cost model is LADWP Schedule A tiered (server/lib/ladwpWater.ts). Because Tony
 * runs irrigation deep into the upper tiers, the headline is the marginal $/gal.
 *
 * Mirrors server/routes/electricity.ts patterns; electricity behaviour is
 * untouched (water is purely additive).
 */

import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLog.js';
import { safeErrorJson } from '../lib/errorSanitizer.js';
import { fetchT } from '../lib/fetchWithTimeout.js';
import { getEntityCache } from '../lib/haWebSocket.js';
import { storage } from '../storage.js';
import {
  computeWaterBill,
  getCurrentWaterTierRate,
  gallonsToHcf,
  GALLONS_PER_HCF,
} from '../lib/ladwpWater.js';
import {
  ZONE_FLOW_CONFIG,
  getZoneEntityIds,
  getZoneFlow,
  gallonsFromRuntime,
} from '../lib/irrigationFlow.js';
import {
  getInteriorUsage,
  getLiveInteriorFlow,
  isFloLogicAvailable,
} from '../lib/floLogic.js';

const router = Router();

interface WaterBillRow {
  billing_period_start: string | Date;
  billing_period_end: string | Date;
  ladwp_hcf: number | string;
  ladwp_gallons: number | string;
  water_usd: number | string;
  sewer_usd: number | string | null;
  solid_waste_usd: number | string | null;
  total_new_charges_usd: number | string | null;
  prior_year_hcf: number | string | null;
  prior_year_days: number | string | null;
  raw_bill_data: Record<string, unknown> | string | null;
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

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

// ── Cron/admin gate (mirrors electricity.ts) ───────────────────────────────
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

// ── LA-local day bounds (mirrors electricity.ts) ────────────────────────────
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

// ── Rain Bird runtime from HA history ───────────────────────────────────────
// Reuse the HA history approach used by HARainBirdCard / haStatistics: read the
// switch state changes over a window and sum on→off durations per zone.
interface HaHistoryEntry { state: string; last_changed?: string; last_updated?: string }

/**
 * Fetch per-zone "on" minutes for the given window from HA's history API.
 * Returns a map entityId → minutes. Never throws — returns {} on any failure or
 * when HA is not configured, so the snapshot degrades to zero irrigation rather
 * than crashing.
 */
async function getZoneRuntimeMinutes(
  entityIds: string[],
  start: Date,
  end: Date,
): Promise<Record<string, number>> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  const result: Record<string, number> = {};
  if (!haUrl || !haToken || entityIds.length === 0) return result;

  const filter = entityIds.join(',');
  const path =
    `/api/history/period/${start.toISOString()}` +
    `?end_time=${encodeURIComponent(end.toISOString())}` +
    `&filter_entity_id=${encodeURIComponent(filter)}` +
    `&minimal_response`;

  try {
    const res = await fetchT(
      `${haUrl.replace(/\/$/, '')}${path}`,
      { headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' } },
      30_000,
    );
    if (!res.ok) return result;
    const data = (await res.json()) as HaHistoryEntry[][];
    if (!Array.isArray(data)) return result;

    const windowStartMs = start.getTime();
    const windowEndMs = end.getTime();

    for (const series of data) {
      if (!Array.isArray(series) || series.length === 0) continue;
      // minimal_response keeps entity_id only on the first entry.
      const entityId = (series[0] as unknown as { entity_id?: string }).entity_id;
      if (!entityId) continue;

      let onMs = 0;
      let onSince: number | null = null;
      for (const entry of series) {
        const ts = new Date(entry.last_changed || entry.last_updated || 0).getTime();
        if (!Number.isFinite(ts)) continue;
        const clamped = Math.min(Math.max(ts, windowStartMs), windowEndMs);
        if (entry.state === 'on' && onSince === null) {
          onSince = clamped;
        } else if (entry.state !== 'on' && onSince !== null) {
          onMs += Math.max(0, clamped - onSince);
          onSince = null;
        }
      }
      // Still on at window end → count through end of window.
      if (onSince !== null) onMs += Math.max(0, windowEndMs - onSince);

      result[entityId] = +(onMs / 60000).toFixed(2);
    }
  } catch (err) {
    console.warn('[water] zone runtime history fetch failed:', err instanceof Error ? err.message : err);
  }
  return result;
}

// Currently-running irrigation zones from the live entity cache.
function getRunningZones(): Array<{ entityId: string; label: string; gpm: number }> {
  const cache = getEntityCache();
  const byId = new Map(cache.map(e => [e.entity_id, e]));
  const running: Array<{ entityId: string; label: string; gpm: number }> = [];
  for (const z of ZONE_FLOW_CONFIG) {
    const e = byId.get(z.entityId);
    if (e && e.state === 'on') running.push({ entityId: z.entityId, label: z.label, gpm: z.gpm });
  }
  return running;
}

// ── GET /live ────────────────────────────────────────────────────────────
// Current interior flow (FloLogic if available) + any irrigation running now,
// plus the marginal $/gal headline and a live $/hr estimate.
router.get('/live', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const t0 = Date.now();

    // Cycle-to-date HCF (from water_usage_daily) determines the marginal tier.
    const cycleHcf = await getCycleHcf();
    const tier = getCurrentWaterTierRate(cycleHcf);

    // Interior live flow (null until FloLogic integration lands).
    const interiorFlow = await getLiveInteriorFlow().catch(() => null);

    // Irrigation running now.
    const runningZones = getRunningZones();
    const irrigationGpm = runningZones.reduce((s, z) => s + z.gpm, 0);
    const interiorGpm = interiorFlow?.gpm ?? 0;
    const liveGpm = +(interiorGpm + irrigationGpm).toFixed(2);

    // $/hr = gallons-per-hour × marginal $/gal.
    const dollarsPerHour = +(liveGpm * 60 * tier.ratePerGallon).toFixed(2);

    const result = {
      timestamp: new Date().toISOString(),
      marginalRate: {
        tier: tier.tier,
        label: tier.label,
        perHcf: tier.ratePerHcf,
        perGallon: tier.ratePerGallon,
      },
      live: {
        gpm: liveGpm,
        gallonsPerHour: +(liveGpm * 60).toFixed(1),
        dollarsPerHour,
      },
      interior: {
        available: isFloLogicAvailable(),
        gpm: interiorGpm,
        source: interiorFlow?.source ?? null,
      },
      irrigation: {
        zonesRunning: runningZones.length,
        gpm: +irrigationGpm.toFixed(2),
        zones: runningZones,
      },
      cycleHcfToDate: +cycleHcf.toFixed(2),
    };

    logAudit('water-api', {
      category: 'home', event_type: 'water_live', severity: 'info',
      actor_id: 'system', channel: 'api',
      summary: `Water live: ${liveGpm} GPM (${
        runningZones.length === 0
          ? 'no zones'
          : runningZones.length <= 3
            ? runningZones.map(z => z.label).join(', ')
            : `${runningZones.slice(0, 3).map(z => z.label).join(', ')} +${runningZones.length - 3} more`
      }) · marginal $${tier.ratePerGallon}/gal`,
      duration_ms: Date.now() - t0,
      status: 'success',
    }).catch((e) => console.warn(`[audit] write failed: ${e instanceof Error ? e.message : e}`));

    res.json(result);
  } catch (err) {
    console.error('[water] live error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /breakdown ──────────────────────────────────────────────────────
// HCF + $ split interior vs irrigation (+ per-zone) for ?range=cycle|today.
router.get('/breakdown', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const t0 = Date.now();
    const range = (req.query.range as string) === 'today' ? 'today' : 'cycle';

    const where = range === 'today'
      ? `WHERE usage_date = (now() AT TIME ZONE 'America/Los_Angeles')::date`
      : `WHERE usage_date > COALESCE(
           (SELECT MAX(billing_period_end) FROM water_bills),
           (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '60 days'
         )`;

    let rows: Array<Record<string, unknown>> = [];
    try {
      const r = await storage.query(
        `SELECT source, zone,
                ROUND(SUM(gallons)::numeric, 2) AS gallons,
                ROUND(SUM(hcf)::numeric, 4)     AS hcf,
                ROUND(SUM(dollars)::numeric, 2) AS dollars
         FROM water_usage_daily ${where}
         GROUP BY source, zone
         ORDER BY dollars DESC`,
        [],
      );
      rows = r.rows;
    } catch { /* table may not exist yet */ }

    const interiorRows = rows.filter(r => r.source === 'interior');
    const irrigationRows = rows.filter(r => r.source === 'irrigation');

    const sum = (rs: Array<Record<string, unknown>>, k: string) =>
      +rs.reduce((s, r) => s + Number(r[k] ?? 0), 0).toFixed(k === 'hcf' ? 4 : 2);

    const interior = { gallons: sum(interiorRows, 'gallons'), hcf: sum(interiorRows, 'hcf'), dollars: sum(interiorRows, 'dollars') };
    const irrigation = {
      gallons: sum(irrigationRows, 'gallons'),
      hcf: sum(irrigationRows, 'hcf'),
      dollars: sum(irrigationRows, 'dollars'),
      zones: irrigationRows.map(r => ({
        zone: r.zone,
        label: getZoneFlow(String(r.zone))?.label ?? String(r.zone),
        gallons: +Number(r.gallons).toFixed(2),
        hcf: +Number(r.hcf).toFixed(4),
        dollars: +Number(r.dollars).toFixed(2),
      })),
    };

    const totalGallons = +(interior.gallons + irrigation.gallons).toFixed(2);
    const totalHcf = +(interior.hcf + irrigation.hcf).toFixed(4);
    const totalDollars = +(interior.dollars + irrigation.dollars).toFixed(2);

    logAudit('water-api', {
      category: 'home', event_type: 'water_breakdown', severity: 'info',
      actor_id: 'system', channel: 'api',
      summary: `Water breakdown (${range}): ${totalGallons} gal · interior $${interior.dollars} / irrigation $${irrigation.dollars}`,
      duration_ms: Date.now() - t0,
      status: 'success',
    }).catch((e) => console.warn(`[audit] write failed: ${e instanceof Error ? e.message : e}`));

    res.json({ range, totalGallons, totalHcf, totalDollars, interior, irrigation });
  } catch (err) {
    console.error('[water] breakdown error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /history ──────────────────────────────────────────────────────────
// Aggregated history from water_usage_daily.
//   ?months=6            trailing months (default 6, max 36)
//   ?groupBy=source|zone default 'source'
//   ?granularity=month|day default 'month'
router.get('/history', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const groupBy = (req.query.groupBy as string) === 'zone' ? 'zone' : 'source';
    const granularity = (req.query.granularity as string) === 'day' ? 'day' : 'month';
    const months = Math.min(Math.max(parseInt(req.query.months as string) || 6, 1), 36);
    const periodExpr = granularity === 'day'
      ? `to_char(usage_date, 'YYYY-MM-DD')`
      : `to_char(usage_date, 'YYYY-MM')`;
    const dim = groupBy === 'zone' ? 'zone' : 'source';

    let rows: Array<Record<string, unknown>> = [];
    try {
      const r = await storage.query(
        `SELECT ${periodExpr} AS period,
                COALESCE(${dim}, 'interior') AS key,
                ROUND(SUM(gallons)::numeric, 2) AS gallons,
                ROUND(SUM(hcf)::numeric, 4)     AS hcf,
                ROUND(SUM(dollars)::numeric, 2) AS dollars,
                COUNT(DISTINCT usage_date) AS days
         FROM water_usage_daily
         WHERE usage_date >= (date_trunc('month', (now() AT TIME ZONE 'America/Los_Angeles')) - (($1)::text || ' months')::interval)
         GROUP BY period, key
         ORDER BY period DESC, dollars DESC`,
        [months - 1],
      );
      rows = r.rows;
    } catch { /* table may not exist yet */ }

    const totals = new Map<string, { gallons: number; dollars: number }>();
    for (const r of rows) {
      const p = String(r.period);
      const t = totals.get(p) ?? { gallons: 0, dollars: 0 };
      t.gallons += Number(r.gallons ?? 0);
      t.dollars += Number(r.dollars ?? 0);
      totals.set(p, t);
    }

    res.json({
      groupBy,
      granularity,
      rows,
      periodTotals: Array.from(totals.entries())
        .map(([period, v]) => ({ period, gallons: +v.gallons.toFixed(2), dollars: +v.dollars.toFixed(2) }))
        .sort((a, b) => (a.period < b.period ? 1 : -1)),
    });
  } catch (err) {
    console.error('[water] history error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /insights ─────────────────────────────────────────────────────────
// Actual-bill trend alerts plus current telemetry-based savings opportunities.
// Recomputed on every request so the card actively tracks changing behavior.
router.get('/insights', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    let latest: WaterBillRow | undefined;
    try {
      const { rows } = await storage.query<WaterBillRow>(
        `SELECT billing_period_start, billing_period_end, ladwp_hcf, ladwp_gallons,
                water_usd, sewer_usd, solid_waste_usd, total_new_charges_usd,
                prior_year_hcf, prior_year_days, raw_bill_data
         FROM water_bills
         ORDER BY billing_period_start DESC
         LIMIT 1`,
        [],
      );
      latest = rows[0];
    } catch {
      // Migration may not have reached this environment yet.
    }

    let recentGallons = 0;
    let recentDays = 0;
    let previousGallons = 0;
    let previousDays = 0;
    try {
      const { rows } = await storage.query<{
        recent_gallons: number | string;
        recent_days: number | string;
        previous_gallons: number | string;
        previous_days: number | string;
      }>(
        `SELECT
           COALESCE(SUM(gallons) FILTER (
             WHERE usage_date >= (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '7 days'
           ), 0) AS recent_gallons,
           COUNT(DISTINCT usage_date) FILTER (
             WHERE usage_date >= (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '7 days'
           ) AS recent_days,
           COALESCE(SUM(gallons) FILTER (
             WHERE usage_date >= (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '14 days'
               AND usage_date < (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '7 days'
           ), 0) AS previous_gallons,
           COUNT(DISTINCT usage_date) FILTER (
             WHERE usage_date >= (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '14 days'
               AND usage_date < (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '7 days'
           ) AS previous_days
         FROM water_usage_daily`,
        [],
      );
      recentGallons = Number(rows[0]?.recent_gallons ?? 0);
      recentDays = Number(rows[0]?.recent_days ?? 0);
      previousGallons = Number(rows[0]?.previous_gallons ?? 0);
      previousDays = Number(rows[0]?.previous_days ?? 0);
    } catch {
      // Daily telemetry is optional until enough snapshots accumulate.
    }

    const raw = asRecord(latest?.raw_bill_data);
    const days = Number(raw.days ?? 0);
    const currentHcf = Number(latest?.ladwp_hcf ?? 0);
    const currentGallons = Number(latest?.ladwp_gallons ?? 0);
    const priorYearHcf = Number(latest?.prior_year_hcf ?? 0);
    const priorYearDays = Number(latest?.prior_year_days ?? 0);
    const currentDailyGallons = days > 0 ? currentGallons / days : 0;
    const priorDailyGallons = priorYearDays > 0
      ? (priorYearHcf * GALLONS_PER_HCF) / priorYearDays
      : 0;
    const dailyDeltaPct = priorDailyGallons > 0
      ? +(((currentDailyGallons / priorDailyGallons) - 1) * 100).toFixed(1)
      : 0;
    const usageDeltaPct = priorYearHcf > 0
      ? +(((currentHcf - priorYearHcf) / priorYearHcf) * 100).toFixed(1)
      : 0;
    const normalizedPriorYearHcf = priorYearDays > 0
      ? (priorYearHcf / priorYearDays) * days
      : 0;
    const normalizedExcessHcf = Math.max(0, currentHcf - normalizedPriorYearHcf);

    const tier4Hcf = Math.max(0, currentHcf - 202);
    const tier4Rate = Number(raw.tier4_rate ?? 15.36933);
    const tier4Gallons = +(tier4Hcf * GALLONS_PER_HCF).toFixed(0);
    const tier4Savings = +(tier4Hcf * tier4Rate).toFixed(2);
    const extraCapacityRefuse = Number(raw.extra_capacity_refuse_usd ?? 0);

    const suggestions: Array<{
      category: string;
      headline: string;
      detail: string;
      potentialSavingsPerCycle: number;
    }> = [];

    if (tier4Hcf > 0) {
      suggestions.push({
        category: 'Water tier',
        headline: `Stay below Tier 4 next cycle`,
        detail: `The latest bill was ${tier4Hcf.toFixed(0)} HCF (${tier4Gallons.toLocaleString()} gallons) over the 202 HCF Tier 4 threshold. Cutting that amount would have saved $${tier4Savings.toFixed(2)} in water charges.`,
        potentialSavingsPerCycle: tier4Savings,
      });
    }
    if (dailyDeltaPct >= 3) {
      suggestions.push({
        category: 'Bill trend',
        headline: `Water use rose ${dailyDeltaPct}% per day year over year`,
        detail: `${currentHcf.toFixed(0)} HCF this cycle versus ${priorYearHcf.toFixed(0)} HCF last year. After normalizing both periods to ${days} days, usage was ${normalizedExcessHcf.toFixed(1)} HCF higher. Check irrigation runtimes and the highest-cost zones first.`,
        potentialSavingsPerCycle: +(normalizedExcessHcf * tier4Rate).toFixed(2),
      });
    }
    if (extraCapacityRefuse > 0) {
      suggestions.push({
        category: 'Utility bill',
        headline: 'Review extra trash capacity',
        detail: `This bill includes $${extraCapacityRefuse.toFixed(2)} for Extra Capacity Refuse. If the additional container capacity is no longer needed, reducing it is a direct recurring savings opportunity.`,
        potentialSavingsPerCycle: extraCapacityRefuse,
      });
    }

    const recentDaily = recentDays > 0 ? recentGallons / recentDays : 0;
    const previousDaily = previousDays > 0 ? previousGallons / previousDays : 0;
    const recentDeltaPct = previousDaily > 0
      ? +(((recentDaily / previousDaily) - 1) * 100).toFixed(1)
      : null;

    res.json({
      latestBill: latest ? {
        periodStart: dateOnly(latest.billing_period_start),
        periodEnd: dateOnly(latest.billing_period_end),
        days,
        hcf: currentHcf,
        gallons: currentGallons,
        waterUsd: Number(latest.water_usd),
        sewerUsd: Number(latest.sewer_usd ?? 0),
        solidWasteUsd: Number(latest.solid_waste_usd ?? 0),
        totalNewChargesUsd: Number(latest.total_new_charges_usd ?? 0),
      } : null,
      billTrend: latest ? {
        priorYearHcf,
        usageDeltaPct,
        currentDailyGallons: +currentDailyGallons.toFixed(0),
        priorDailyGallons: +priorDailyGallons.toFixed(0),
        dailyDeltaPct,
      } : null,
      tier4Opportunity: {
        thresholdHcf: 202,
        hcfToCut: +tier4Hcf.toFixed(2),
        gallonsToCut: tier4Gallons,
        savingsPerCycle: tier4Savings,
      },
      recentTrend: recentDays >= 3 && previousDays >= 3 ? {
        recentDailyGallons: +recentDaily.toFixed(0),
        previousDailyGallons: +previousDaily.toFixed(0),
        deltaPct: recentDeltaPct,
        recentDays,
        previousDays,
      } : null,
      suggestions,
      totalPotentialCycleSavings: +suggestions
        .filter(s => s.category !== 'Bill trend')
        .reduce((sum, s) => sum + s.potentialSavingsPerCycle, 0)
        .toFixed(2),
      dataQuality: {
        interiorAvailable: isFloLogicAvailable(),
        recentDaysCollected: recentDays,
        note: isFloLogicAvailable()
          ? 'Whole-property interior and irrigation telemetry available.'
          : 'Live/daily totals currently include irrigation; whole-property interior flow is not connected.',
      },
    });
  } catch (err) {
    console.error('[water] insights error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── POST /snapshot-daily ────────────────────────────────────────────────────
// Compute the prior LA-local day's interior (FloLogic) + per-zone irrigation
// (Rain Bird runtime × GPM) gallons → HCF → tiered $ → upsert water_usage_daily.
// Cron/admin gated. Pass { date: 'YYYY-MM-DD' } or { daysBack: N } to backfill.
// Idempotent via (usage_date, source, COALESCE(zone,'')) upsert.
router.post('/snapshot-daily', async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!isCronAuthorized(req)) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid cron secret required.' });
    }

    const explicitDate = (req.body?.date as string | undefined)?.trim();
    const bounds = explicitDate && /^\d{4}-\d{2}-\d{2}$/.test(explicitDate)
      ? laDayBoundsForDate(explicitDate)
      : laDayBounds(Math.max(1, Math.min(parseInt(String(req.body?.daysBack ?? '1'), 10) || 1, 400)));

    // Marginal tier rate is keyed to cycle-to-date HCF so attributed $ reflects
    // Tony's upper-tier position (irrigation gallons price at the margin).
    const cycleHcf = await getCycleHcf(bounds.usageDate);
    const tier = getCurrentWaterTierRate(cycleHcf);
    const marginalPerHcf = tier.ratePerHcf;

    let rowsWritten = 0;
    let totalGallons = 0;
    let totalDollars = 0;

    // ── Interior (FloLogic) ──
    const interior = await getInteriorUsage(bounds.usageDate).catch(() => null);
    const interiorGallons = interior?.gallons ?? 0;
    {
      const hcf = gallonsToHcf(interiorGallons);
      const dollars = +(hcf * marginalPerHcf).toFixed(2);
      await upsertWaterRow(bounds.usageDate, 'interior', null, interiorGallons, hcf, dollars);
      rowsWritten++;
      totalGallons += interiorGallons;
      totalDollars += dollars;
    }

    // ── Irrigation (Rain Bird runtime × GPM) ──
    const zoneIds = getZoneEntityIds();
    const runtimeMin = await getZoneRuntimeMinutes(zoneIds, bounds.start, bounds.end);
    for (const entityId of zoneIds) {
      const minutes = runtimeMin[entityId] ?? 0;
      const gallons = gallonsFromRuntime(entityId, minutes);
      const hcf = gallonsToHcf(gallons);
      const dollars = +(hcf * marginalPerHcf).toFixed(2);
      await upsertWaterRow(bounds.usageDate, 'irrigation', entityId, gallons, hcf, dollars);
      rowsWritten++;
      totalGallons += gallons;
      totalDollars += dollars;
    }

    totalGallons = +totalGallons.toFixed(2);
    totalDollars = +totalDollars.toFixed(2);

    logAudit('water-snapshot', {
      category: 'home', event_type: 'water_usage_daily_snapshot', severity: 'info',
      actor_id: 'system', channel: 'cron',
      summary: `Water snapshot ${bounds.usageDate}: ${rowsWritten} rows · ${totalGallons} gal · $${totalDollars} (interior ${interiorGallons} gal)`,
      detail: {
        usage_date: bounds.usageDate, rows: rowsWritten,
        total_gallons: totalGallons, total_dollars: totalDollars,
        interior_gallons: interiorGallons, interior_available: isFloLogicAvailable(),
        marginal_per_hcf: marginalPerHcf, tier: tier.tier,
      },
      status: 'success',
    }).catch(() => {});

    res.json({
      ok: true,
      usageDate: bounds.usageDate,
      rows: rowsWritten,
      totalGallons,
      totalHcf: +gallonsToHcf(totalGallons).toFixed(4),
      totalDollars,
      interiorGallons,
      interiorAvailable: isFloLogicAvailable(),
      marginalTier: tier.tier,
    });
  } catch (err) {
    console.error('[water] snapshot-daily error:', err);
    res.status(500).json(safeErrorJson(err));
  }
});

// ── GET /rates ────────────────────────────────────────────────────────────
// Current tiered water rate schedule + the verified Aug 2026 bill.
router.get('/rates', requireAuth, (_req: AuthenticatedRequest, res: Response) => {
  const cycleHcf = 0;
  const tier = getCurrentWaterTierRate(cycleHcf);
  const exampleBill = computeWaterBill(217, 58, { includeSewer: false });
  res.json({
    gallonsPerHcf: GALLONS_PER_HCF,
    currentMarginal: { tier: tier.tier, perHcf: tier.ratePerHcf, perGallon: tier.ratePerGallon },
    schedule: exampleBill.tiers.map(t => ({ tier: t.tier, label: t.label, ratePerHcf: t.ratePerHcf })),
    referenceBill: {
      hcf: 217,
      commodity: exampleBill.commoditySubtotal,
      note: 'Aug 2026 actual: 217 HCF → $3,179.32 water commodity (sewer additive)',
    },
    billingFrequency: 'bi-monthly',
    schedule_name: 'LADWP Schedule A · Single-Dwelling · Temp Zone MEDIUM',
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

// Sum cycle-to-date HCF from water_usage_daily, anchored immediately after the
// latest actual bill end date. Falls back to 60 days before bill history exists.
async function getCycleHcf(uptoDate?: string): Promise<number> {
  try {
    const params: unknown[] = [];
    let dateClause = `usage_date > COALESCE(
      (SELECT MAX(billing_period_end) FROM water_bills),
      (now() AT TIME ZONE 'America/Los_Angeles')::date - interval '60 days'
    )`;
    if (uptoDate && /^\d{4}-\d{2}-\d{2}$/.test(uptoDate)) {
      params.push(uptoDate);
      dateClause = `usage_date <= $1::date AND usage_date > COALESCE(
        (SELECT MAX(billing_period_end) FROM water_bills WHERE billing_period_end < $1::date),
        $1::date - interval '60 days'
      )`;
    }
    const { rows } = await storage.query(
      `SELECT COALESCE(SUM(hcf), 0) AS hcf FROM water_usage_daily WHERE ${dateClause}`,
      params,
    );
    return +Number(rows[0]?.hcf ?? 0).toFixed(4);
  } catch {
    return 0;
  }
}

async function upsertWaterRow(
  usageDate: string,
  source: 'interior' | 'irrigation',
  zone: string | null,
  gallons: number,
  hcf: number,
  dollars: number,
): Promise<void> {
  // COALESCE(zone,'') matches the unique index in migration 0038.
  await storage.query(
    `INSERT INTO water_usage_daily (usage_date, source, zone, gallons, hcf, dollars)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (usage_date, source, COALESCE(zone, ''))
     DO UPDATE SET gallons = EXCLUDED.gallons, hcf = EXCLUDED.hcf,
                   dollars = EXCLUDED.dollars, captured_at = now()`,
    [usageDate, source, zone, gallons, hcf, dollars],
  );
}

export default router;
