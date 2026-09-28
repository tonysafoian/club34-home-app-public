export interface ValveDef {
  clockId: number;
  clockName: string;
  valveNumber: number;
  label: string;
  svgId: string;
  haEntityIdHints: string[];
}

export interface ClockDef {
  id: number;
  name: string;
  shortName: string;
  ip?: string;
  // Rain Bird model exposed in HA, when integrated.
  model?: string;
  // Whether this controller's zones actually exist as HA entities today.
  // Clocks 1 & 2 do (19 zones total). Clock 3 does NOT — see TODO below.
  inHomeAssistant: boolean;
  valves: ValveDef[];
}

// ---------------------------------------------------------------------------
// Controller → SVG zone name mapping
//
// HA REALITY (verified): Home Assistant exposes 2 Rain Bird controllers /
// 19 zones total:
//   • ESP-TM2 (Clock 1, "Main Garden", IP 10.0.22.90) — 12 zones
//       switch.rain_bird_sprinkler_1 … switch.rain_bird_sprinkler_12
//   • ESP-ME3 (Clock 2, "Pool Equipment 2", IP 10.0.22.154) — 7 zones
//       switch.rain_bird_sprinkler_1_2 … switch.rain_bird_sprinkler_7_2
//
// TODO(3rd-controller): Janus historically assumed a 3rd clock ("Garage Timer",
// IP 10.0.22.209, pool deck & NE plantings, ~12 zones) for ~29 zones total, but
// that controller is NOT exposed in Home Assistant — it has no switch.* entities,
// so its zones can never connect and have no runtime/flow data. It is kept below
// (inHomeAssistant:false) so the UI still shows its planned zones as "Not
// connected" placeholders rather than silently dropping them, and so the water
// framework ignores it (only ESP-TM2 + ESP-ME3 zones are metered). Resolve by
// either adding the 3rd controller to HA or removing it from the plan.
// ---------------------------------------------------------------------------

const CLOCK1_ZONE_NAMES: Record<number, string> = {
  1:  'SW Front Lawn',
  2:  'SE Front Lawn',
  3:  'Gate Left Planting',
  4:  'Gate Right Planting',
  5:  'Entry Left Strip',
  6:  'Entry Right Strip',
  7:  'Rear Garden East',
  8:  'Rear Garden West',
  9:  'Service Yard',
  10: 'North Lawn Left',
  11: 'North Lawn Right',
  12: 'Back Border',
};

const CLOCK2_ZONE_NAMES: Record<number, string> = {
  1:  'NW Corner Garden',
  2:  'North Left Strip',
  3:  'West Side Corridor',
  4:  'West Garden Mid',
  5:  'West Garden Lower',
  6:  'House East Trim (Upper)',
  7:  'House East Trim (Lower)',
  8:  'North Above House',
  9:  'Far East Boundary',
  10: 'Motor Court Side Strip',
};

const CLOCK3_ZONE_NAMES: Record<number, string> = {
  1:  'NE Top Band',
  2:  'Pool Terrace North',
  3:  'Pool West Strip',
  4:  'Pool North Strip',
  5:  'Pool East Strip',
  6:  'Pool South Strip',
  7:  'Pool South Left',
  8:  'Pool South Far East',
  9:  'NE Upper Planting',
  10: 'NE Lower Planting',
  11: 'Pool South Mid',
  12: 'Pool Equipment Area',
};

const ZONE_NAMES: Record<number, Record<number, string>> = {
  1: CLOCK1_ZONE_NAMES,
  2: CLOCK2_ZONE_NAMES,
  3: CLOCK3_ZONE_NAMES,
};

function makeValve(
  clockId: number,
  clockName: string,
  n: number,
  suffix: string,
): ValveDef {
  const customName = ZONE_NAMES[clockId]?.[n];
  return {
    clockId,
    clockName,
    valveNumber: n,
    label: customName ?? `${clockName} · Zone ${n}`,
    svgId: `clock-${clockId}-valve-${n}`,
    haEntityIdHints: [
      `rain_bird_sprinkler_${n}${suffix}`,
      `sprinkler_${n}${suffix}`,
    ],
  };
}

export const CLOCK_DEFS: ClockDef[] = [
  {
    id: 1,
    name: 'Main Garden',
    shortName: 'MG',
    ip: '10.0.22.90',
    model: 'ESP-TM2',
    inHomeAssistant: true, // 12 zones: switch.rain_bird_sprinkler_1 … _12
    valves: Array.from({ length: 12 }, (_, i) => makeValve(1, 'Main Garden', i + 1, '')),
  },
  {
    id: 2,
    name: 'Pool Equipment 2',
    shortName: 'PE2',
    ip: '10.0.22.154',
    model: 'ESP-ME3',
    inHomeAssistant: true, // 7 zones: switch.rain_bird_sprinkler_1_2 … _7_2
    valves: Array.from({ length: 7 }, (_, i) => makeValve(2, 'Pool Equipment 2', i + 1, '_2')),
  },
  {
    // TODO(3rd-controller): not exposed in HA — kept as placeholders only.
    id: 3,
    name: 'Garage Timer',
    shortName: 'GT',
    ip: '10.0.22.209',
    inHomeAssistant: false,
    valves: Array.from({ length: 12 }, (_, i) => makeValve(3, 'Garage Timer', i + 1, '_3')),
  },
];

export const ALL_VALVES: ValveDef[] = CLOCK_DEFS.flatMap(c => c.valves);

/**
 * Apply admin-saved zone-name overrides (from the irrigation_zone_names DB
 * table, keyed by svgId) on top of a single valve's hardcoded default label.
 * A missing/blank override leaves the default in place.
 */
export function withZoneNameOverride(valve: ValveDef, overrides?: Record<string, string>): ValveDef {
  const name = overrides?.[valve.svgId]?.trim();
  return name ? { ...valve, label: name } : valve;
}

/**
 * Return CLOCK_DEFS with any DB zone-name overrides applied to valve labels.
 * Used by the frontend so the hardcoded names act purely as fallbacks.
 */
export function applyZoneNameOverrides(
  clocks: ClockDef[],
  overrides?: Record<string, string>,
): ClockDef[] {
  if (!overrides || Object.keys(overrides).length === 0) return clocks;
  return clocks.map(c => ({ ...c, valves: c.valves.map(v => withZoneNameOverride(v, overrides)) }));
}

/**
 * Match a discovered HA entity to a valve definition.
 * Clock 2 & 3 are checked first (their hints carry `_2`/`_3` suffixes).
 * Clock 1 is checked second (plain `sprinkler_N` hints).
 * Trailing-number fallback for Clock 1 (zones 1–12), guarded against `_N_2`/`_N_3` patterns.
 */
function matchesHint(text: string, hint: string): boolean {
  if (/\d$/.test(hint)) {
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped + '(?!\\d)').test(text);
  }
  return text.includes(hint);
}

export function matchEntityToValve(entityId: string, friendlyName?: string): ValveDef | undefined {
  const id = entityId.toLowerCase();
  const name = (friendlyName ?? '').toLowerCase();

  for (const clock of [CLOCK_DEFS[1], CLOCK_DEFS[2]]) {
    for (const valve of clock.valves) {
      for (const hint of valve.haEntityIdHints) {
        if (matchesHint(id, hint) || matchesHint(name, hint)) return valve;
      }
    }
  }

  for (const valve of CLOCK_DEFS[0].valves) {
    for (const hint of valve.haEntityIdHints) {
      if (matchesHint(id, hint) || matchesHint(name, hint)) return valve;
    }
  }

  // Fallback: trailing _N (1–12) → Clock 1, only if no _N_2/_N_3 suffix present
  if (!/_\d+_\d+/.test(id)) {
    const numMatch = id.match(/[_\s](\d+)$/) ?? id.match(/(\d+)$/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      if (n >= 1 && n <= 12) return CLOCK_DEFS[0].valves[n - 1];
    }
  }

  return undefined;
}
