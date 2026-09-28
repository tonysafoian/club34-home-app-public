/**
 * LADWP R-1A Residential Electric Rate Engine
 * ─────────────────────────────────────────────
 * Calibrated against 4 actual bills for account 106 612 1000
 * Zone 1 · Bi-monthly billing · PAC Tier 3
 *
 * Encodes seasonal tiered rates, Power Access Charge,
 * 10% LA City Utility Tax, and State Energy Surcharge.
 */

// ── Rate schedule ──────────────────────────────────────────────────────
// Each entry covers a season window (months 1-indexed, inclusive) for a given
// LADWP rate year. Rates sourced directly from parsed LADWP bills (R-1A, zone 1).
//
// LADWP revises rates roughly once a year, so the SAME season can carry
// different tier rates in different years (e.g. the Summer Tier-3 rate fell
// from 0.36109 in 2025 to 0.33308 in 2026). `year` disambiguates those: the
// season-window months are identical across years and `year` selects which
// revision applies (see `getSeasonalRate` / `pickRateByYear`).
export interface SeasonalRate {
  label: string;
  year: number;             // LADWP rate year this revision applies to
  startMonth: number;       // 1-indexed
  startDay: number;
  endMonth: number;
  endDay: number;
  tier1: number;            // $/kWh
  tier2: number;
  tier3: number;
  isSummer: boolean;
}

const RATE_SCHEDULE: SeasonalRate[] = [
  // ── 2025 rate year ────────────────────────────────────────────────────
  // Summer: higher Tier 3 rate kicks in (Aug–Oct 2025 bill)
  { label: 'Summer', year: 2025, startMonth: 6, startDay: 1,  endMonth: 9, endDay: 30,
    tier1: 0.24404, tier2: 0.30263, tier3: 0.36109, isSummer: true },
  // Fall (Oct–Dec 2025 bill)
  { label: 'Fall',   year: 2025, startMonth: 10, startDay: 1, endMonth: 12, endDay: 31,
    tier1: 0.24606, tier2: 0.30463, tier3: 0.30463, isSummer: false },

  // ── 2026 rate year ────────────────────────────────────────────────────
  // Winter (Dec 2025 – Feb 2026 bill)
  { label: 'Winter', year: 2026, startMonth: 1, startDay: 1, endMonth: 3, endDay: 31,
    tier1: 0.24747, tier2: 0.30606, tier3: 0.30606, isSummer: false },
  // Spring (Feb–Apr 2026 bill)
  { label: 'Spring', year: 2026, startMonth: 4, startDay: 1, endMonth: 5, endDay: 31,
    tier1: 0.24620, tier2: 0.30479, tier3: 0.30479, isSummer: false },
  // Summer: 2026 revision — Tier 3 dropped to 0.33308 (Apr–Jun 2026 bill)
  { label: 'Summer', year: 2026, startMonth: 6, startDay: 1, endMonth: 9, endDay: 30,
    tier1: 0.24361, tier2: 0.30221, tier3: 0.33308, isSummer: true },
];

// ── Zone 1, bi-monthly tier allotments ─────────────────────────────────
export const TIER_ALLOTMENTS = {
  tier1: 700,   // kWh — first 700 kWh of the bi-monthly cycle
  tier2: 1400,  // kWh — next 1,400 kWh
  // tier3 = everything above tier1 + tier2 = above 2,100 kWh
};

// ── Power Access Charge (PAC) ──────────────────────────────────────────
// Based on highest monthly kWh over prior 12 months.
// Tony's bills consistently show PAC Tier 3 (peak month ~10,007 kWh).
const PAC_TIERS = [
  { label: 'Tier 1', maxMonthlyKwh: 350,  monthlyCharge: 2.30 },
  { label: 'Tier 2', maxMonthlyKwh: 1050, monthlyCharge: 7.90 },
  { label: 'Tier 3', maxMonthlyKwh: Infinity, monthlyCharge: 22.70 },
];

// ── Constants ──────────────────────────────────────────────────────────
const LA_UTILITY_TAX_RATE = 0.10;   // 10%
const STATE_ENERGY_SURCHARGE = 0.0003;  // $/kWh

// ── Helper: does (month, day) fall inside a rate entry's season window? ──
function withinSeasonWindow(r: SeasonalRate, m: number, d: number): boolean {
  // Season windows here never wrap the year boundary.
  if (m < r.startMonth || (m === r.startMonth && d < r.startDay)) return false;
  if (m > r.endMonth || (m === r.endMonth && d > r.endDay)) return false;
  return true;
}

// ── Helper: among same-season entries, pick the revision for a given year ─
// Picks the entry whose `year` is the greatest year ≤ the target year (so a
// 2027 date with no 2027 revision reuses the latest known rates). If every
// entry is in the future relative to the target, falls back to the earliest.
function pickRateByYear(entries: SeasonalRate[], year: number): SeasonalRate {
  const past = entries.filter(e => e.year <= year).sort((a, b) => b.year - a.year);
  if (past.length) return past[0];
  return [...entries].sort((a, b) => a.year - b.year)[0];
}

// ── Helper: get seasonal rate for a given date ─────────────────────────
export function getSeasonalRate(date: Date): SeasonalRate {
  const m = date.getMonth() + 1; // 1-indexed
  const d = date.getDate();
  const y = date.getFullYear();
  const inSeason = RATE_SCHEDULE.filter(r => withinSeasonWindow(r, m, d));
  if (inSeason.length === 0) {
    // Shouldn't happen — windows tile the whole year — but stay safe.
    return pickRateByYear(RATE_SCHEDULE, y);
  }
  return pickRateByYear(inSeason, y);
}

// ── Helper: get the seasonal rate that LADWP applies to a whole bill ───
// A bi-monthly bill spans two seasons. LADWP does NOT pro-rate: it applies the
// SUMMER (high) season rate to any bill whose period overlaps the Jun 1–Sep 30
// summer window at all (verified against the Aug–Oct 2025 and Apr–Jun 2026
// bills, both of which were billed flat at the summer Tier-3 rate even though
// only part of each period was in summer). Non-summer bills are rated by their
// END date's season — the representative meter-read date — which reconciles the
// Oct–Dec, Dec–Feb, and Feb–Apr bills exactly. This replaces the old midpoint
// classification, which mis-rated cross-season cycles (e.g. an Apr–Jun bill
// whose ~May-21 midpoint fell in Spring, missing the summer rate entirely).
export function getSeasonalRateForPeriod(start: Date, end: Date): SeasonalRate {
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    const summerStart = new Date(y, 5, 1).getTime();           // Jun 1
    const summerEnd = new Date(y, 8, 30, 23, 59, 59).getTime(); // Sep 30
    if (start.getTime() <= summerEnd && end.getTime() >= summerStart) {
      return pickRateByYear(RATE_SCHEDULE.filter(r => r.isSummer), y);
    }
  }
  return getSeasonalRate(end);
}

// ── Bill computation result ────────────────────────────────────────────
export interface LadwpBillBreakdown {
  totalKwh: number;
  days: number;
  seasonLabel: string;
  isSummer: boolean;

  tier1Kwh: number;
  tier2Kwh: number;
  tier3Kwh: number;
  tier1Rate: number;
  tier2Rate: number;
  tier3Rate: number;
  tier1Cost: number;
  tier2Cost: number;
  tier3Cost: number;
  subtotalEnergy: number;

  pacTier: string;
  pacMonthlyCharge: number;
  pacTotal: number;          // monthly charge × months in cycle

  utilityTax: number;
  stateEnergySurcharge: number;

  totalElectricCharges: number;

  // Per-unit costs
  effectiveRate: number;     // $/kWh all-in
  dailyCost: number;
  monthlyCost: number;
}

/**
 * Compute an LADWP bill estimate given total kWh and billing period.
 */
export function computeLadwpBill(
  totalKwh: number,
  periodStartDate: Date,
  periodEndDate: Date,
  peakMonthlyKwh?: number,
): LadwpBillBreakdown {
  const days = Math.max(1, Math.round((periodEndDate.getTime() - periodStartDate.getTime()) / (1000 * 60 * 60 * 24)));
  const months = Math.max(1, Math.round(days / 30));

  // Determine the seasonal rate LADWP applies to the whole bill. Bi-monthly
  // cycles span two seasons; LADWP applies the summer rate flat to any cycle
  // overlapping summer, otherwise the END-date season (see helper).
  const rate = getSeasonalRateForPeriod(periodStartDate, periodEndDate);

  // Tier allocation
  const tier1Kwh = Math.min(totalKwh, TIER_ALLOTMENTS.tier1);
  const tier2Kwh = Math.min(Math.max(totalKwh - TIER_ALLOTMENTS.tier1, 0), TIER_ALLOTMENTS.tier2);
  const tier3Kwh = Math.max(totalKwh - TIER_ALLOTMENTS.tier1 - TIER_ALLOTMENTS.tier2, 0);

  const tier1Cost = +(tier1Kwh * rate.tier1).toFixed(2);
  const tier2Cost = +(tier2Kwh * rate.tier2).toFixed(2);
  const tier3Cost = +(tier3Kwh * rate.tier3).toFixed(2);
  const subtotalEnergy = +(tier1Cost + tier2Cost + tier3Cost).toFixed(2);

  // PAC — use default PAC Tier 3 unless caller overrides peak monthly kWh
  const peakKwh = peakMonthlyKwh ?? 10007; // From actual bills
  const pacTier = PAC_TIERS.find(t => peakKwh <= t.maxMonthlyKwh) ?? PAC_TIERS[2];
  const pacTotal = +(pacTier.monthlyCharge * months).toFixed(2);

  // Tax base = energy subtotal + PAC
  const taxableAmount = subtotalEnergy + pacTotal;
  const utilityTax = +(taxableAmount * LA_UTILITY_TAX_RATE).toFixed(2);
  const stateEnergySurcharge = +(totalKwh * STATE_ENERGY_SURCHARGE).toFixed(2);

  const totalElectricCharges = +(subtotalEnergy + pacTotal + utilityTax + stateEnergySurcharge).toFixed(2);

  const effectiveRate = totalKwh > 0 ? +(totalElectricCharges / totalKwh).toFixed(5) : 0;
  const dailyCost = +(totalElectricCharges / days).toFixed(2);
  const monthlyCost = +(totalElectricCharges / months).toFixed(2);

  return {
    totalKwh, days,
    seasonLabel: rate.label,
    isSummer: rate.isSummer,
    tier1Kwh, tier2Kwh, tier3Kwh,
    tier1Rate: rate.tier1, tier2Rate: rate.tier2, tier3Rate: rate.tier3,
    tier1Cost, tier2Cost, tier3Cost,
    subtotalEnergy,
    pacTier: pacTier.label,
    pacMonthlyCharge: pacTier.monthlyCharge,
    pacTotal,
    utilityTax, stateEnergySurcharge,
    totalElectricCharges,
    effectiveRate, dailyCost, monthlyCost,
  };
}

/**
 * Get the current marginal $/kWh rate — i.e. the tier you're currently
 * drawing from given your accumulated kWh this billing cycle.
 */
export function getCurrentTierRate(
  accumulatedKwhThisCycle: number,
  date?: Date,
): { tier: number; rate: number; label: string; nextTierAt: number | null } {
  const seasonRate = getSeasonalRate(date ?? new Date());

  if (accumulatedKwhThisCycle <= TIER_ALLOTMENTS.tier1) {
    return {
      tier: 1,
      rate: seasonRate.tier1,
      label: `Tier 1 — $${seasonRate.tier1.toFixed(4)}/kWh`,
      nextTierAt: TIER_ALLOTMENTS.tier1,
    };
  }
  if (accumulatedKwhThisCycle <= TIER_ALLOTMENTS.tier1 + TIER_ALLOTMENTS.tier2) {
    return {
      tier: 2,
      rate: seasonRate.tier2,
      label: `Tier 2 — $${seasonRate.tier2.toFixed(4)}/kWh`,
      nextTierAt: TIER_ALLOTMENTS.tier1 + TIER_ALLOTMENTS.tier2,
    };
  }
  return {
    tier: 3,
    rate: seasonRate.tier3,
    label: `Tier 3 — $${seasonRate.tier3.toFixed(4)}/kWh`,
    nextTierAt: null,
  };
}

/**
 * Top-N savings opportunities based on circuit-level consumption patterns.
 * Returns canned recommendations parameterised with real consumption data.
 */
export interface SavingsSuggestion {
  category: string;
  headline: string;
  detail: string;
  potentialSavingsPerMonth: number;
}

export function generateSavingsSuggestions(
  circuitData: Array<{ label: string; entityId: string; dailyKwh: number }>,
  currentTier: number,
  seasonRate: SeasonalRate,
): SavingsSuggestion[] {
  const suggestions: SavingsSuggestion[] = [];
  const sorted = [...circuitData].sort((a, b) => b.dailyKwh - a.dailyKwh);

  // Find EV chargers
  const evCircuits = sorted.filter(c =>
    c.entityId.includes('charger') || c.label.toLowerCase().includes('charger')
  );
  for (const ev of evCircuits) {
    if (ev.dailyKwh > 5) {
      // Shifting EV charging from Tier 3 to Tier 2 or off-peak
      const tierDiff = seasonRate.tier3 - seasonRate.tier2;
      const monthlySavings = +(ev.dailyKwh * 30 * tierDiff).toFixed(2);
      if (monthlySavings > 5) {
        suggestions.push({
          category: 'ev_charging',
          headline: `Shift ${ev.label} to off-peak hours`,
          detail: `${ev.label} uses ~${ev.dailyKwh.toFixed(0)} kWh/day. Charging during lower-demand periods (late night) could reduce your tier exposure.`,
          potentialSavingsPerMonth: monthlySavings,
        });
      }
    }
  }

  // Find HVAC
  const hvacCircuits = sorted.filter(c =>
    c.entityId.includes('ac_') || c.entityId.includes('hvac') || c.label.toLowerCase().includes('ac ')
  );
  const totalHvacDaily = hvacCircuits.reduce((s, c) => s + c.dailyKwh, 0);
  if (totalHvacDaily > 20 && seasonRate.isSummer) {
    const savingsPerDegree = totalHvacDaily * 0.03 * 30 * seasonRate.tier3; // ~3% per degree
    suggestions.push({
      category: 'hvac',
      headline: 'Raise AC set points by 1–2°F in summer',
      detail: `HVAC uses ~${totalHvacDaily.toFixed(0)} kWh/day across ${hvacCircuits.length} units. Each degree warmer saves ~3% on cooling.`,
      potentialSavingsPerMonth: +savingsPerDegree.toFixed(2),
    });
  }

  // Pool/spa heater
  const poolCircuits = sorted.filter(c =>
    c.entityId.includes('pool') || c.entityId.includes('spa') || c.label.toLowerCase().includes('pool')
  );
  for (const pool of poolCircuits) {
    if (pool.dailyKwh > 10) {
      const reducedHours = pool.dailyKwh * 0.2 * 30 * seasonRate.tier3;
      suggestions.push({
        category: 'pool_heater',
        headline: `Reduce ${pool.label} run time by 20%`,
        detail: `${pool.label} consumes ~${pool.dailyKwh.toFixed(0)} kWh/day. Reducing heating by ~1 hr/day could save ~$${reducedHours.toFixed(0)}/month.`,
        potentialSavingsPerMonth: +reducedHours.toFixed(2),
      });
    }
  }

  // Sauna
  const saunaCircuits = sorted.filter(c =>
    c.entityId.includes('sauna') || c.label.toLowerCase().includes('sauna')
  );
  for (const sauna of saunaCircuits) {
    if (sauna.dailyKwh > 5) {
      const savings = sauna.dailyKwh * 0.15 * 30 * seasonRate.tier3;
      suggestions.push({
        category: 'sauna',
        headline: 'Optimise sauna preheat time',
        detail: `Sauna uses ~${sauna.dailyKwh.toFixed(0)} kWh/day. Reducing preheat by 10–15 min saves ~$${savings.toFixed(0)}/month at Tier 3 rates.`,
        potentialSavingsPerMonth: +savings.toFixed(2),
      });
    }
  }

  // Top power hog alert
  const topHog = sorted[0];
  if (topHog && topHog.dailyKwh > 15 && !suggestions.some(s => s.headline.includes(topHog.label))) {
    suggestions.push({
      category: 'device_audit',
      headline: `Audit ${topHog.label} — top power consumer`,
      detail: `${topHog.label} draws ~${topHog.dailyKwh.toFixed(0)} kWh/day (${(topHog.dailyKwh * 30).toFixed(0)} kWh/month). At $${seasonRate.tier3.toFixed(3)}/kWh, that's ~$${(topHog.dailyKwh * 30 * seasonRate.tier3).toFixed(0)}/month.`,
      potentialSavingsPerMonth: +(topHog.dailyKwh * 30 * seasonRate.tier3 * 0.1).toFixed(2), // 10% reduction
    });
  }

  return suggestions.sort((a, b) => b.potentialSavingsPerMonth - a.potentialSavingsPerMonth);
}
