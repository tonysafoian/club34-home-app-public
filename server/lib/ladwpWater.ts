/**
 * LADWP Water — Schedule A Tiered Rate Engine
 * ─────────────────────────────────────────────
 * Single-Dwelling, Temperature Zone MEDIUM, bi-monthly billing.
 * Mirrors the philosophy of ladwpRates.ts (electricity): a tiered commodity
 * engine with a calibration path so modeled totals can be pinned to actual bills.
 *
 * Current schedule is calibrated from the Aug 19, 2026 bill:
 * 217 HCF → $3,179.32 water commodity. Sewer is additive on top.
 *
 * Tony sits in the upper tiers (Tier 3/4) for most of the cycle because of
 * irrigation, so the HEADLINE figure is the marginal $/HCF (and $/gal) — the
 * true cost of the next unit of water.
 *
 * 1 HCF = 748 gallons.
 */

export const GALLONS_PER_HCF = 748;

// ── Schedule A tiered commodity rates ($/HCF, bi-monthly) ──────────────────
// Tier widths are the HCF allotment for each tier within a bi-monthly cycle.
export interface WaterTier {
  tier: number;
  label: string;
  ratePerHcf: number;
  // Cumulative HCF at which this tier ENDS (null = unbounded top tier).
  endsAtHcf: number | null;
}

export const WATER_TIERS: WaterTier[] = [
  { tier: 1, label: 'Tier 1', ratePerHcf: 11.89,    endsAtHcf: 16 },   // first 16 HCF
  { tier: 2, label: 'Tier 2', ratePerHcf: 14.33355, endsAtHcf: 78 },   // next 62 HCF
  { tier: 3, label: 'Tier 3', ratePerHcf: 15.07952, endsAtHcf: 202 },  // next 124 HCF
  { tier: 4, label: 'Tier 4', ratePerHcf: 15.36933, endsAtHcf: null }, // > 202 HCF
];

// ── Sewer (Sewerage Service Charge / SCM) ──────────────────────────────────
// LADWP bills sewer on assumed wastewater use: a per-day water-use allotment
// (WWU) times a sewer commodity rate. These are calibration-based defaults
// pending exact verification against more bills (see calibrate()).
export const SEWER_WWU_HCF_PER_DAY = 1.53146;   // Aug 2026 assessed 88.82452 HCF / 58 days
export const SEWER_RATE_PER_HCF = 10.13;         // current rate after July 1, 2026

// ── Constants ──────────────────────────────────────────────────────────────
const DEFAULT_BIMONTHLY_DAYS = 61;

// ── Calibration ─────────────────────────────────────────────────────────────
// Same philosophy as ladwpRates.ts: when an actual bill is known, store a
// per-cycle effective $/HCF so modeled totals reconcile to reality. Keyed by
// billing-period start (YYYY-MM-DD). Empty by default — the tiered engine alone
// already reproduces the reference bill.
export interface WaterCalibration {
  periodStart: string;          // YYYY-MM-DD
  effectiveCommodityPerHcf: number;
}
const CALIBRATIONS: WaterCalibration[] = [];

/**
 * Register/replace a calibration point (e.g. parsed from an imported bill).
 * Returns the resulting effective commodity $/HCF for that cycle.
 */
export function calibrate(periodStart: string, actualCommodityUsd: number, hcf: number): number {
  const effective = hcf > 0 ? +(actualCommodityUsd / hcf).toFixed(5) : 0;
  const existing = CALIBRATIONS.find(c => c.periodStart === periodStart);
  if (existing) existing.effectiveCommodityPerHcf = effective;
  else CALIBRATIONS.push({ periodStart, effectiveCommodityPerHcf: effective });
  return effective;
}

function getCalibration(periodStart?: string): WaterCalibration | undefined {
  if (!periodStart) return undefined;
  return CALIBRATIONS.find(c => c.periodStart === periodStart);
}

// ── Tiered commodity allocation ──────────────────────────────────────────────
export interface WaterTierAllocation {
  tier: number;
  label: string;
  hcf: number;
  ratePerHcf: number;
  cost: number;
}

/**
 * Split a total HCF across the tier schedule and price each slice.
 */
export function allocateTiers(totalHcf: number): WaterTierAllocation[] {
  const out: WaterTierAllocation[] = [];
  let priorEnd = 0;
  for (const t of WATER_TIERS) {
    const upper = t.endsAtHcf ?? Infinity;
    const widthAvailable = upper - priorEnd;
    const hcfInTier = Math.max(0, Math.min(totalHcf - priorEnd, widthAvailable));
    out.push({
      tier: t.tier,
      label: t.label,
      hcf: +hcfInTier.toFixed(4),
      ratePerHcf: t.ratePerHcf,
      cost: +(hcfInTier * t.ratePerHcf).toFixed(2),
    });
    priorEnd = upper;
    if (!Number.isFinite(upper)) break;
  }
  return out;
}

// ── Bill computation ─────────────────────────────────────────────────────────
export interface WaterBillBreakdown {
  totalHcf: number;
  totalGallons: number;
  days: number;

  tiers: WaterTierAllocation[];
  commoditySubtotal: number;        // tiered water usage charges

  sewerWwuHcf: number;              // assumed wastewater HCF over the period
  sewerCharge: number;              // sewer commodity charge

  totalWaterCharges: number;        // commodity + sewer

  // Per-unit
  effectiveCommodityPerHcf: number; // commoditySubtotal / totalHcf
  effectivePerHcf: number;          // totalWaterCharges / totalHcf
  effectivePerGallon: number;       // totalWaterCharges / totalGallons
  dailyCost: number;
}

/**
 * Compute an LADWP water bill estimate from total HCF and billing-period days.
 * `includeSewer` defaults true. `periodStart` (YYYY-MM-DD) opts into any
 * registered calibration for that cycle.
 */
export function computeWaterBill(
  totalHcf: number,
  days: number = DEFAULT_BIMONTHLY_DAYS,
  opts: { includeSewer?: boolean; periodStart?: string } = {},
): WaterBillBreakdown {
  const includeSewer = opts.includeSewer ?? true;
  const safeHcf = Math.max(0, totalHcf);
  const safeDays = Math.max(1, days);

  const tiers = allocateTiers(safeHcf);
  let commoditySubtotal = +tiers.reduce((s, t) => s + t.cost, 0).toFixed(2);

  // If this cycle is calibrated, override the commodity with the effective rate.
  const cal = getCalibration(opts.periodStart);
  if (cal) commoditySubtotal = +(safeHcf * cal.effectiveCommodityPerHcf).toFixed(2);

  const sewerWwuHcf = +(SEWER_WWU_HCF_PER_DAY * safeDays).toFixed(4);
  const sewerCharge = includeSewer ? +(sewerWwuHcf * SEWER_RATE_PER_HCF).toFixed(2) : 0;

  const totalWaterCharges = +(commoditySubtotal + sewerCharge).toFixed(2);
  const totalGallons = +(safeHcf * GALLONS_PER_HCF).toFixed(0);

  return {
    totalHcf: +safeHcf.toFixed(4),
    totalGallons,
    days: safeDays,
    tiers,
    commoditySubtotal,
    sewerWwuHcf,
    sewerCharge,
    totalWaterCharges,
    effectiveCommodityPerHcf: safeHcf > 0 ? +(commoditySubtotal / safeHcf).toFixed(5) : 0,
    effectivePerHcf: safeHcf > 0 ? +(totalWaterCharges / safeHcf).toFixed(5) : 0,
    effectivePerGallon: totalGallons > 0 ? +(totalWaterCharges / totalGallons).toFixed(6) : 0,
    dailyCost: +(totalWaterCharges / safeDays).toFixed(2),
  };
}

// ── Marginal rate (the headline) ──────────────────────────────────────────────
export interface WaterTierRate {
  tier: number;
  label: string;
  ratePerHcf: number;       // marginal commodity $/HCF for the next unit
  ratePerGallon: number;    // marginal commodity $/gal for the next unit
  nextTierAtHcf: number | null;
}

/**
 * Given cumulative HCF already consumed this cycle, return the tier the NEXT
 * unit of water falls into and its marginal $/HCF and $/gal. This is the
 * headline cost figure for Tony (upper-tier irrigation user).
 */
export function getCurrentWaterTierRate(accumulatedHcfThisCycle: number): WaterTierRate {
  const hcf = Math.max(0, accumulatedHcfThisCycle);
  for (const t of WATER_TIERS) {
    const upper = t.endsAtHcf ?? Infinity;
    if (hcf < upper) {
      return {
        tier: t.tier,
        label: t.label,
        ratePerHcf: t.ratePerHcf,
        ratePerGallon: +(t.ratePerHcf / GALLONS_PER_HCF).toFixed(6),
        nextTierAtHcf: t.endsAtHcf,
      };
    }
  }
  const top = WATER_TIERS[WATER_TIERS.length - 1];
  return {
    tier: top.tier,
    label: top.label,
    ratePerHcf: top.ratePerHcf,
    ratePerGallon: +(top.ratePerHcf / GALLONS_PER_HCF).toFixed(6),
    nextTierAtHcf: null,
  };
}

// ── Unit helpers ──────────────────────────────────────────────────────────────
export function gallonsToHcf(gallons: number): number {
  return +(gallons / GALLONS_PER_HCF).toFixed(6);
}

export function hcfToGallons(hcf: number): number {
  return +(hcf * GALLONS_PER_HCF).toFixed(2);
}
