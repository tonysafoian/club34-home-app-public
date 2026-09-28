/**
 * Energy Savings automations — turns off lights that were left on.
 *
 *  1. Fountains Off at 9 PM   — all fountain lights off nightly at 9:00 PM PT
 *  2. Closet Light Timer      — any closet light off after 30 minutes
 *  3. Bathroom Light Timer    — bathroom lights off after 15 minutes,
 *                               except the Primary Bath which gets 1 hour
 *
 * Entities are discovered at runtime by name so newly added lights are
 * covered automatically:
 *   - "fountain" in the name                    → fountain rule
 *   - "closet" (but NOT "water closet")         → closet rule
 *   - "bath" / "powder" / "water closet"        → bathroom rule
 *     ("water closet" = toilet room, part of a bathroom, not a clothes closet)
 *   - bathroom entities containing "primary"    → 1-hour Primary allowance
 *
 * Exclusions: each timer's family_automations row can carry an admin-editable
 * `config.excluded_terms` list (managed from the Automations page). Any light
 * whose entity_id or friendly name contains one of the terms (case-insensitive
 * substring) is skipped by that timer — e.g. the seeded "enzo" term keeps
 * Enzo's bathroom out of the 15-minute bathroom rule.
 *
 * How long a light has been on comes from HA's `last_changed` timestamp
 * (resets only when the on/off state flips, not on brightness changes).
 * Both endpoints are cron-driven (see server/routes/cron.ts) and honor
 * their family_automations vacation toggle. Fail-open: a missing DB row
 * never blocks the automation, matching the school-broadcast pattern.
 */
import { Router } from 'express';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { requireRole, getAuthUser } from '../auth.js';
import { logAudit } from '../lib/auditLog.js';
import { fetchT } from '../lib/fetchWithTimeout.js';
import { query } from '../lib/db.js';
import type { AutomationConfigRow } from '../../shared/dbRows.js';
import { getEntityCache, isCacheReady } from '../lib/haWebSocket.js';

const router = Router();

// ── Thresholds ──
const CLOSET_MAX_MS = 30 * 60 * 1000;        // 30 minutes
const BATHROOM_MAX_MS = 15 * 60 * 1000;      // 15 minutes
const PRIMARY_BATH_MAX_MS = 60 * 60 * 1000;  // 1 hour

// ── Automation row names (family_automations) ──
const FOUNTAIN_AUTOMATION = 'Fountains Off at 9 PM';
const CLOSET_AUTOMATION = 'Closet Light Timer';
const BATHROOM_AUTOMATION = 'Bathroom Light Timer';

export interface LightState {
  entity_id: string;
  state: string;
  friendly_name: string;
  last_changed: string;
}

function isHAConfigured(): boolean {
  return !!(process.env.HA_URL || process.env.HOME_ASSISTANT_URL)
    && !!(process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN);
}

/** All light.* / switch.* states — WS cache when warm, REST fallback. */
async function getLightStates(): Promise<LightState[]> {
  let raw: Array<{ entity_id: string; state: string; attributes?: Record<string, unknown>; last_changed?: string }>;
  if (isCacheReady()) {
    raw = getEntityCache();
  } else {
    const haUrl = (process.env.HA_URL || process.env.HOME_ASSISTANT_URL || '').replace(/\/$/, '');
    const haToken = process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN;
    const r = await fetchT(`${haUrl}/api/states`, { headers: { Authorization: `Bearer ${haToken}` } });
    if (!r.ok) throw new Error(`HA /api/states returned ${r.status}`);
    raw = await r.json();
  }
  return raw
    .filter((e) => e.entity_id.startsWith('light.') || e.entity_id.startsWith('switch.'))
    .map((e) => ({
      entity_id: e.entity_id,
      state: e.state,
      friendly_name: String((e.attributes as Record<string, unknown> | undefined)?.friendly_name ?? ''),
      last_changed: e.last_changed ?? '',
    }));
}

// ── Name classification (exported for server/tests/light-timer-exclusions.test.ts) ──
function nameOf(e: LightState): string {
  return `${e.entity_id} ${e.friendly_name}`.toLowerCase();
}
function isFountain(e: LightState): boolean {
  return nameOf(e).includes('fountain');
}
function isWaterCloset(e: LightState): boolean {
  return /water[_ ]closet/.test(nameOf(e));
}
export function isCloset(e: LightState): boolean {
  // "water closet" = toilet room → bathroom rule, not the clothes-closet rule
  return nameOf(e).includes('closet') && !isWaterCloset(e);
}
export function isBathroom(e: LightState): boolean {
  const n = nameOf(e);
  // "bath" also covers "bathroom" and the "bathroon" typo in HA;
  // powder room and water closets count as bathrooms too.
  return n.includes('bath') || n.includes('powder') || isWaterCloset(e);
}
export function isPrimaryBath(e: LightState): boolean {
  return isBathroom(e) && nameOf(e).includes('primary');
}

// ── Exclusions (admin-editable, per timer) ──

/**
 * Normalized `config.excluded_terms` from a timer's family_automations row.
 * Malformed/missing config yields [] — the timer covers everything, matching
 * the fail-open pattern of the vacation lookup.
 */
export function excludedTerms(automation: AutomationConfigRow | null): string[] {
  const cfg = automation?.config;
  const raw = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg.excluded_terms : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** True when the light's entity_id or friendly name contains any excluded term. */
export function isExcluded(e: LightState, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const n = nameOf(e);
  return terms.some((t) => n.includes(t));
}

/** Minutes a light has been in its current state (Infinity if unknown). */
function onForMs(e: LightState, now: number): number {
  const t = Date.parse(e.last_changed);
  if (Number.isNaN(t)) return -1; // unknown — treated as "not eligible yet"
  return now - t;
}

async function turnOff(entityId: string, maxAttempts = 3): Promise<boolean> {
  const haUrl = (process.env.HA_URL || process.env.HOME_ASSISTANT_URL || '').replace(/\/$/, '');
  const haToken = process.env.HA_TOKEN || process.env.HOME_ASSISTANT_TOKEN;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetchT(`${haUrl}/api/services/homeassistant/turn_off`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_id: entityId }),
      });
      if (r.ok) return true;
      console.warn(`[energy] turn_off ${entityId} attempt ${attempt}/${maxAttempts}: HTTP ${r.status}`);
    } catch (err) {
      console.warn(`[energy] turn_off ${entityId} attempt ${attempt}/${maxAttempts}:`, err instanceof Error ? err.message : err);
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** Fail-open vacation check: null row → proceed; is_active=false → skip. */
async function getAutomation(name: string): Promise<AutomationConfigRow | null> {
  try {
    const { rows } = await query<AutomationConfigRow>(
      `SELECT id, is_active, config FROM family_automations WHERE name = $1 LIMIT 1`, [name],
    );
    return rows[0] ?? null;
  } catch (err) {
    console.warn(`[energy] vacation lookup failed for "${name}" — failing open:`, err instanceof Error ? err.message : err);
    return null;
  }
}

async function logRun(automationId: string | null, status: string, output: Record<string, unknown>, errorMessage?: string) {
  if (!automationId) return;
  const now = new Date().toISOString();
  try {
    await query(
      `INSERT INTO family_automation_logs (automation_id, status, output, error_message, started_at, completed_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [automationId, status, JSON.stringify(output), errorMessage || null, now, now],
    );
    await query(`UPDATE family_automations SET last_run_at = $1 WHERE id = $2`, [now, automationId]);
  } catch (err) {
    console.warn('[energy] failed to write automation log:', err instanceof Error ? err.message : err);
  }
}

async function touchLastRun(automationId: string | null) {
  if (!automationId) return;
  try {
    await query(`UPDATE family_automations SET last_run_at = $1 WHERE id = $2`, [new Date().toISOString(), automationId]);
  } catch { /* non-fatal */ }
}

// ── 9 PM fountains off ──
router.post('/api/energy/fountains-off', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  const automation = await getAutomation(FOUNTAIN_AUTOMATION);
  if (automation && !automation.is_active) {
    await logRun(automation.id, 'skipped', { skipped: true, reason: 'vacation_mode' });
    return res.json({ success: true, skipped: true, reason: 'vacation_mode' });
  }
  if (!isHAConfigured()) {
    console.log('[energy] fountains-off: Home Assistant not configured — skipping.');
    return res.json({ success: true, skipped: true, reason: 'ha_not_configured' });
  }

  try {
    const lights = await getLightStates();
    const fountains = lights.filter(isFountain);
    const turnedOff: string[] = [];
    const failed: string[] = [];
    let alreadyOff = 0;

    for (const f of fountains) {
      if (f.state !== 'on') { alreadyOff++; continue; }
      const label = f.friendly_name || f.entity_id;
      if (await turnOff(f.entity_id)) turnedOff.push(label);
      else failed.push(label);
    }

    const output = { matched: fountains.length, turnedOff, alreadyOff, failed };
    await logRun(automation?.id ?? null, failed.length > 0 ? 'error' : 'success', output,
      failed.length > 0 ? `Failed to turn off: ${failed.join(', ')}` : undefined);

    logAudit('energy-fountains-off', {
      category: 'automation', event_type: 'fountains_off', severity: failed.length > 0 ? 'warning' : 'info',
      actor_id: 'system', actor_name: 'Cron', channel: 'cron',
      summary: turnedOff.length > 0
        ? `Fountains off at 9 PM: turned off ${turnedOff.length} (${turnedOff.join(', ')})`
        : `Fountains off at 9 PM: all ${fountains.length} already off`,
      detail: output,
      status: failed.length > 0 ? 'error' : 'success',
    });

    return res.json({ success: failed.length === 0, ...output });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[energy] fountains-off failed:', message);
    await logRun(automation?.id ?? null, 'error', { error: message }, message);
    logAudit('energy-fountains-off', {
      category: 'automation', event_type: 'fountains_off', severity: 'error',
      actor_id: 'system', actor_name: 'Cron', channel: 'cron',
      summary: `Fountains off failed: ${message}`, status: 'error',
    });
    return res.status(500).json({ success: false, error: message });
  }
});

// ── Closet (30 min) + bathroom (15 min / Primary 1 hr) timers, every 5 min ──

/**
 * Re-check an entity against the live WS cache right before turning it off.
 * Guards against acting on a stale snapshot (e.g. the user toggled the light
 * off→on while earlier candidates were being processed). Returns true when
 * the entity is still on and still past its limit — or when the cache can't
 * answer (REST-snapshot path), in which case the original snapshot stands.
 */
function stillEligible(entityId: string, limitMs: number, now: number): boolean {
  if (!isCacheReady()) return true;
  const live = getEntityCache().find((e) => e.entity_id === entityId);
  if (!live) return false;
  if (live.state !== 'on') return false;
  const t = Date.parse(live.last_changed);
  if (Number.isNaN(t)) return false;
  return now - t > limitMs;
}

// In-process run lock — a slow HA can make one tick outlast the 5-minute
// cron interval; overlapping runs would act on stale snapshots.
let timersRunning = false;

router.post('/api/energy/light-timers', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  if (timersRunning) {
    return res.json({ success: true, skipped: true, reason: 'previous_run_still_in_progress' });
  }
  const [closetAuto, bathAuto] = await Promise.all([
    getAutomation(CLOSET_AUTOMATION),
    getAutomation(BATHROOM_AUTOMATION),
  ]);
  const closetEnabled = !closetAuto || closetAuto.is_active;
  const bathEnabled = !bathAuto || bathAuto.is_active;

  if (!closetEnabled && !bathEnabled) {
    return res.json({ success: true, skipped: true, reason: 'vacation_mode' });
  }
  if (!isHAConfigured()) {
    return res.json({ success: true, skipped: true, reason: 'ha_not_configured' });
  }

  timersRunning = true;
  try {
    const now = Date.now();
    const lights = await getLightStates();

    const closetExclusions = excludedTerms(closetAuto);
    const bathExclusions = excludedTerms(bathAuto);

    type Candidate = { light: LightState; kind: 'closet' | 'bathroom'; limitMs: number };
    const candidates: Candidate[] = [];
    for (const l of lights) {
      if (l.state !== 'on') continue;
      // Classify first, then apply that timer's exclusion list — an excluded
      // closet light must not fall through to the bathroom rule (or vice versa).
      if (isCloset(l)) {
        if (closetEnabled && !isExcluded(l, closetExclusions)) {
          candidates.push({ light: l, kind: 'closet', limitMs: CLOSET_MAX_MS });
        }
      } else if (isBathroom(l)) {
        if (bathEnabled && !isExcluded(l, bathExclusions)) {
          candidates.push({ light: l, kind: 'bathroom', limitMs: isPrimaryBath(l) ? PRIMARY_BATH_MAX_MS : BATHROOM_MAX_MS });
        }
      }
    }

    const turnedOff: Record<'closet' | 'bathroom', string[]> = { closet: [], bathroom: [] };
    const failed: string[] = [];
    for (const c of candidates) {
      const ms = onForMs(c.light, now);
      if (ms < 0 || ms <= c.limitMs) continue;
      // Revalidate against the live cache just before acting — the user may
      // have toggled the light while earlier candidates were processed.
      if (!stillEligible(c.light.entity_id, c.limitMs, Date.now())) continue;
      const label = c.light.friendly_name || c.light.entity_id;
      // Single attempt: the next 5-minute tick is the natural retry, and
      // blind retries after an ambiguous timeout risk double-acting.
      if (await turnOff(c.light.entity_id, 1)) {
        turnedOff[c.kind].push(label);
        console.log(`[energy] ${c.kind} timer: turned off "${label}" after ${Math.round(ms / 60000)} min (limit ${c.limitMs / 60000} min)`);
      } else {
        failed.push(label);
      }
    }

    // Keep "last run" fresh in the UI without flooding the logs — detailed
    // rows are only written when a light was actually turned off or failed.
    await Promise.all([
      closetEnabled ? touchLastRun(closetAuto?.id ?? null) : Promise.resolve(),
      bathEnabled ? touchLastRun(bathAuto?.id ?? null) : Promise.resolve(),
    ]);

    if (turnedOff.closet.length > 0 || failed.length > 0) {
      const output = { turnedOff: turnedOff.closet, failed };
      await logRun(closetAuto?.id ?? null, failed.length > 0 ? 'error' : 'success', output);
      logAudit('energy-closet-timer', {
        category: 'automation', event_type: 'closet_light_timeout', severity: failed.length > 0 ? 'warning' : 'info',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: `Closet timer: turned off ${turnedOff.closet.join(', ') || '(none)'}${failed.length > 0 ? ` — failed: ${failed.join(', ')}` : ''} (30 min limit)`,
        detail: output, status: failed.length > 0 ? 'error' : 'success',
      });
    }
    if (turnedOff.bathroom.length > 0 || failed.length > 0) {
      const output = { turnedOff: turnedOff.bathroom, failed };
      await logRun(bathAuto?.id ?? null, failed.length > 0 ? 'error' : 'success', output);
      logAudit('energy-bathroom-timer', {
        category: 'automation', event_type: 'bathroom_light_timeout', severity: failed.length > 0 ? 'warning' : 'info',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: `Bathroom timer: turned off ${turnedOff.bathroom.join(', ') || '(none)'}${failed.length > 0 ? ` — failed: ${failed.join(', ')}` : ''} (15 min / Primary 1 hr)`,
        detail: output, status: failed.length > 0 ? 'error' : 'success',
      });
    }

    return res.json({
      success: failed.length === 0,
      checked: candidates.length,
      turnedOff,
      failed,
      closetEnabled,
      bathEnabled,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[energy] light-timers failed:', message);
    logAudit('energy-light-timers', {
      category: 'automation', event_type: 'light_timer_error', severity: 'error',
      actor_id: 'system', actor_name: 'Cron', channel: 'cron',
      summary: `Light timers failed: ${message}`, status: 'error',
    });
    return res.status(500).json({ success: false, error: message });
  } finally {
    timersRunning = false;
  }
});

// ── Admin editor for a timer's exclusion list ──
//
// The Automations page manages config.excluded_terms through this scoped,
// ADMIN-ONLY endpoint. The generic /api/db/update proxy deliberately rejects
// non-admin family_automations.config writes (see server/routes/proxy.ts),
// so hiding the editor in the UI is backed by real server-side enforcement.

const EXCLUDABLE_AUTOMATIONS = [CLOSET_AUTOMATION, BATHROOM_AUTOMATION];
const MAX_EXCLUSION_TERMS = 50;
const MAX_TERM_LENGTH = 100;

router.put('/api/energy/exclusions', requireRole('admin'), async (req: AuthenticatedRequest, res: Response) => {
  const body = (req.body ?? {}) as { automationName?: unknown; excludedTerms?: unknown };

  const automationName = body.automationName;
  if (typeof automationName !== 'string' || !EXCLUDABLE_AUTOMATIONS.includes(automationName)) {
    return res.status(400).json({ error: `automationName must be one of: ${EXCLUDABLE_AUTOMATIONS.join(', ')}` });
  }
  const rawTerms = body.excludedTerms;
  if (!Array.isArray(rawTerms) || rawTerms.some((t) => typeof t !== 'string')) {
    return res.status(400).json({ error: 'excludedTerms must be an array of strings' });
  }
  // Normalize the same way the timers match: trimmed, lowercased, deduped.
  const terms = [...new Set(rawTerms.map((t: string) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  if (terms.length > MAX_EXCLUSION_TERMS) {
    return res.status(400).json({ error: `At most ${MAX_EXCLUSION_TERMS} exclusion terms are allowed` });
  }
  if (terms.some((t) => t.length > MAX_TERM_LENGTH)) {
    return res.status(400).json({ error: `Each term must be at most ${MAX_TERM_LENGTH} characters` });
  }

  try {
    // jsonb_set only touches excluded_terms — any other config keys survive.
    const { rows } = await query<AutomationConfigRow>(
      `UPDATE family_automations
       SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{excluded_terms}', $1::jsonb, true),
           updated_at = NOW()
       WHERE name = $2
       RETURNING id, is_active, config`,
      [JSON.stringify(terms), automationName],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: `Automation "${automationName}" not found` });
    }

    const actor = getAuthUser(req);
    // Log under the timer's own edge-function name so the change shows up in
    // that routine's Recent Log on the Automations page.
    const auditFn = automationName === CLOSET_AUTOMATION ? 'energy-closet-timer' : 'energy-bathroom-timer';
    logAudit(auditFn, {
      category: 'config', event_type: 'light_timer_exclusions_updated', severity: 'info',
      actor_id: actor?.userId || 'UNKNOWN', actor_name: actor?.displayName || actor?.email || 'UNKNOWN', actor_role: 'admin',
      channel: 'web',
      summary: `${automationName}: exclusion list set to [${terms.join(', ') || 'empty'}]`,
      detail: { automationName, excluded_terms: terms },
      status: 'success',
    });

    return res.json({ success: true, excluded_terms: excludedTerms(rows[0]) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[energy] exclusions update failed:', message);
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;
