/**
 * FloLogic adapter — whole-property INTERIOR water usage.
 * ─────────────────────────────────────────────────────────
 * FloLogic is the property's main-line flow/shutoff device. It measures REAL
 * interior gallons (everything downstream of the meter EXCEPT irrigation, which
 * Rain Bird runs on its own line). FloLogic is NOT yet integrated into Home
 * Assistant — the device sits on the LAN at 10.0.22.190 with no HA entity and
 * no wired-up cloud credentials.
 *
 * This module defines the adapter INTERFACE the rest of the water framework
 * codes against. Today every reader returns null (data unavailable) so callers
 * fall back gracefully and nothing crashes. When the integration lands, fill in
 * one of the TODO paths below and the live/snapshot endpoints light up with no
 * other changes.
 *
 * TODO(flologic-integration): choose and implement ONE source —
 *   1. Cloud API: FloLogic FloProtect cloud (OAuth / API key) → daily totals
 *      and instantaneous flow. Preferred if the account exposes a usage API.
 *   2. Local: poll the device at http://10.0.22.190 on the LAN (or via an HA
 *      REST/MQTT integration once added) → read meter totalizer + flow.
 *   Whichever is chosen, implement getInteriorUsage()/getLiveInteriorFlow()
 *   and getCurrentTotalizerGallons() to return real numbers; keep the null
 *   fallbacks so the framework degrades cleanly when the source is down.
 */

export const FLOLOGIC_DEVICE_HOST = '10.0.22.190';

/** Interior gallons consumed over a single LA-local calendar day. */
export interface InteriorDailyUsage {
  usageDate: string;   // YYYY-MM-DD (LA-local)
  gallons: number;
  source: 'flologic-cloud' | 'flologic-local' | 'manual';
}

/** Instantaneous interior flow snapshot for the live view. */
export interface InteriorLiveFlow {
  gpm: number;             // current flow, gallons per minute
  asOf: string;            // ISO timestamp of the reading
  source: 'flologic-cloud' | 'flologic-local';
}

/**
 * Return interior (non-irrigation) gallons for a given LA-local day, or null
 * when FloLogic is unavailable. Never throws.
 *
 * Manual/seed override: a daily total can be injected via the
 * FLOLOGIC_MANUAL_USAGE env var as JSON {"YYYY-MM-DD": gallons, ...} so an
 * interior figure can be backfilled from a paper meter read before the live
 * integration exists.
 */
export async function getInteriorUsage(usageDate: string): Promise<InteriorDailyUsage | null> {
  // Manual seed path (optional) — lets us populate interior usage before the
  // device integration exists, without touching the snapshot route.
  const manual = readManualUsage();
  if (manual && typeof manual[usageDate] === 'number') {
    return { usageDate, gallons: Math.max(0, manual[usageDate]), source: 'manual' };
  }

  // TODO(flologic-integration): replace with a real cloud/local fetch.
  return null;
}

/**
 * Current interior flow rate (GPM) for the live hero, or null if unavailable.
 * Never throws.
 */
export async function getLiveInteriorFlow(): Promise<InteriorLiveFlow | null> {
  // TODO(flologic-integration): read instantaneous flow from cloud/local API.
  return null;
}

/**
 * Cumulative lifetime totalizer (gallons) if the device/cloud exposes it.
 * Returns null today. Useful later for deriving daily deltas without a
 * per-day API. Never throws.
 */
export async function getCurrentTotalizerGallons(): Promise<number | null> {
  // TODO(flologic-integration): read totalizer from cloud/local API.
  return null;
}

/** Whether a live FloLogic source is wired up. Currently always false. */
export function isFloLogicAvailable(): boolean {
  return false;
}

function readManualUsage(): Record<string, number> | null {
  const raw = process.env.FLOLOGIC_MANUAL_USAGE;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : null;
  } catch {
    return null;
  }
}
