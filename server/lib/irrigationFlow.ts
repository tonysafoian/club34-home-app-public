/**
 * Irrigation flow configuration — per-zone GPM map for Rain Bird zones.
 * ──────────────────────────────────────────────────────────────────────
 * Rain Bird controllers expose RUNTIME ONLY (zone on/off) — there is no flow
 * meter. We estimate irrigation gallons as:  gallons = zoneGPM × runtimeMinutes.
 *
 * The GPM values below are TYPE-BASED DEFAULTS (rotor ~12, spray ~8, drip ~2)
 * inferred from each zone's name. They are NOT calibrated measurements — they
 * exist so the framework produces sane numbers today. Replacing them with
 * field-measured / catch-cup GPM per zone is a follow-up (see TODO).
 *
 * Keyed by HA entity_id. 19 real zones in HA:
 *   ESP-TM2  → switch.rain_bird_sprinkler_1   … switch.rain_bird_sprinkler_12   (12)
 *   ESP-ME3  → switch.rain_bird_sprinkler_1_2 … switch.rain_bird_sprinkler_7_2  (7)
 */

// Default GPM by sprinkler head type — clearly marked as DEFAULTS, editable.
export const DEFAULT_GPM_BY_TYPE = {
  rotor: 12, // lawn rotors — high flow, large coverage
  spray: 8,  // fixed spray heads — medium flow
  drip: 2,   // drip/bubbler — low flow, plantings
} as const;

export type HeadType = keyof typeof DEFAULT_GPM_BY_TYPE;

export interface ZoneFlowConfig {
  entityId: string;
  svgId: string;      // stable zone key shared with the frontend + DB overrides
  label: string;      // default label; overridden by irrigation_zone_names rows
  controller: 'ESP-TM2' | 'ESP-ME3';
  headType: HeadType;
  gpm: number;        // editable — currently seeded from headType default
  isDefault: boolean; // true until field-calibrated
}

// Per-zone seed. headType picked from the zone's role (lawn → rotor,
// strip/trim/border → spray, planting/garden/corridor → drip). All flagged
// isDefault:true until measured. TODO(calibration): replace gpm with measured
// flow per zone (catch-cup test or FloLogic delta while a single zone runs).
// svgId is the zone's stable identifier ('clock-N-valve-M'), matching
// src/lib/irrigation/controllers.ts so DB name overrides (irrigation_zone_names)
// resolve identically on server and frontend.
function zone(
  entityId: string,
  svgId: string,
  label: string,
  controller: ZoneFlowConfig['controller'],
  headType: HeadType,
): ZoneFlowConfig {
  return { entityId, svgId, label, controller, headType, gpm: DEFAULT_GPM_BY_TYPE[headType], isDefault: true };
}

export const ZONE_FLOW_CONFIG: ZoneFlowConfig[] = [
  // ── ESP-TM2 (switch.rain_bird_sprinkler_1 … _12) → clock-1-valve-N ──
  zone('switch.rain_bird_sprinkler_1',  'clock-1-valve-1',  'SW Front Lawn',          'ESP-TM2', 'rotor'),
  zone('switch.rain_bird_sprinkler_2',  'clock-1-valve-2',  'SE Front Lawn',          'ESP-TM2', 'rotor'),
  zone('switch.rain_bird_sprinkler_3',  'clock-1-valve-3',  'Gate Left Planting',     'ESP-TM2', 'drip'),
  zone('switch.rain_bird_sprinkler_4',  'clock-1-valve-4',  'Gate Right Planting',    'ESP-TM2', 'drip'),
  zone('switch.rain_bird_sprinkler_5',  'clock-1-valve-5',  'Entry Left Strip',       'ESP-TM2', 'spray'),
  zone('switch.rain_bird_sprinkler_6',  'clock-1-valve-6',  'Entry Right Strip',      'ESP-TM2', 'spray'),
  zone('switch.rain_bird_sprinkler_7',  'clock-1-valve-7',  'Rear Garden East',       'ESP-TM2', 'drip'),
  zone('switch.rain_bird_sprinkler_8',  'clock-1-valve-8',  'Rear Garden West',       'ESP-TM2', 'drip'),
  zone('switch.rain_bird_sprinkler_9',  'clock-1-valve-9',  'Service Yard',           'ESP-TM2', 'spray'),
  zone('switch.rain_bird_sprinkler_10', 'clock-1-valve-10', 'North Lawn Left',        'ESP-TM2', 'rotor'),
  zone('switch.rain_bird_sprinkler_11', 'clock-1-valve-11', 'North Lawn Right',       'ESP-TM2', 'rotor'),
  zone('switch.rain_bird_sprinkler_12', 'clock-1-valve-12', 'Back Border',            'ESP-TM2', 'spray'),

  // ── ESP-ME3 (switch.rain_bird_sprinkler_1_2 … _7_2) → clock-2-valve-N ──
  zone('switch.rain_bird_sprinkler_1_2', 'clock-2-valve-1', 'NW Corner Garden',          'ESP-ME3', 'drip'),
  zone('switch.rain_bird_sprinkler_2_2', 'clock-2-valve-2', 'North Left Strip',          'ESP-ME3', 'spray'),
  zone('switch.rain_bird_sprinkler_3_2', 'clock-2-valve-3', 'West Side Corridor',        'ESP-ME3', 'drip'),
  zone('switch.rain_bird_sprinkler_4_2', 'clock-2-valve-4', 'West Garden Mid',           'ESP-ME3', 'drip'),
  zone('switch.rain_bird_sprinkler_5_2', 'clock-2-valve-5', 'West Garden Lower',         'ESP-ME3', 'drip'),
  zone('switch.rain_bird_sprinkler_6_2', 'clock-2-valve-6', 'House East Trim (Upper)',   'ESP-ME3', 'spray'),
  zone('switch.rain_bird_sprinkler_7_2', 'clock-2-valve-7', 'House East Trim (Lower)',   'ESP-ME3', 'spray'),
];

const BY_ENTITY = new Map(ZONE_FLOW_CONFIG.map(z => [z.entityId, z]));

// ── Admin name overrides (irrigation_zone_names), keyed by svgId ──
// getZoneFlow() is synchronous (called inline by water.ts + the Janus tool
// layer), so overrides are kept in a module-level cache refreshed at boot and
// after every admin write. A missing entry falls back to the hardcoded default
// label above, so the system always renders sane names even before the cache
// loads.
let NAME_OVERRIDES: Map<string, string> = new Map();

/**
 * Reload zone-name overrides from the DB into the in-memory cache.
 * Called at server boot and after each admin rename/reset. Storage is injected
 * to avoid a static import cycle (storage.ts → schema, irrigationFlow is leaf).
 */
export async function refreshZoneNames(
  loader: () => Promise<Array<{ svgId: string; name: string }>>,
): Promise<void> {
  const rows = await loader();
  const next = new Map<string, string>();
  for (const r of rows) {
    if (r.svgId && typeof r.name === 'string' && r.name.trim()) {
      next.set(r.svgId, r.name.trim());
    }
  }
  NAME_OVERRIDES = next;
}

/** Resolve a zone's effective label (DB override → hardcoded default). */
function effectiveLabel(z: ZoneFlowConfig): string {
  return NAME_OVERRIDES.get(z.svgId) ?? z.label;
}

/** All configured irrigation zone entity_ids (the 19 real HA zones). */
export function getZoneEntityIds(): string[] {
  return ZONE_FLOW_CONFIG.map(z => z.entityId);
}

/**
 * Look up a zone's flow config by HA entity_id, with its label resolved against
 * the admin name-override cache (falls back to the hardcoded default).
 */
export function getZoneFlow(entityId: string): ZoneFlowConfig | undefined {
  const z = BY_ENTITY.get(entityId);
  if (!z) return undefined;
  return { ...z, label: effectiveLabel(z) };
}

/** GPM for a zone — falls back to the spray default for any unknown zone. */
export function getZoneGpm(entityId: string): number {
  return BY_ENTITY.get(entityId)?.gpm ?? DEFAULT_GPM_BY_TYPE.spray;
}

/**
 * Estimate gallons for a zone given its on-time in minutes.
 *   gallons = GPM × runtime minutes
 * Unknown zones fall back to the spray default so we never silently drop usage.
 */
export function gallonsFromRuntime(entityId: string, minutes: number): number {
  const gpm = getZoneGpm(entityId);
  const safeMinutes = Math.max(0, minutes);
  return +(gpm * safeMinutes).toFixed(2);
}
