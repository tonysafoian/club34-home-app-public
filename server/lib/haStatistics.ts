/**
 * Home Assistant Long-Term Statistics Fetcher
 * ────────────────────────────────────────────
 * Uses the existing HA WebSocket connection (haWebSocket.ts) to query
 * the recorder/statistics_during_period endpoint for kWh data from
 * Emporia Vue energy sensors.
 */

import { sendHAWSCommand, getEntityCache } from './haWebSocket.js';
import { query } from './db.js';

// ── Emporia circuit entity map ─────────────────────────────────────────
// These are the _energy_today_ entities (kWh, total_increasing) — not the power (W) entities.
// HA's Emporia integration exposes sensor.<name>_energy_today and _energy_this_month
// (there is no bare sensor.<name>_energy). HA auto-records long-term statistics for these,
// so they are valid statistic_ids for recorder/statistics_during_period.
// Numeric duplicate suffix goes at the END, e.g. sensor.balance_energy_today_2.

export interface CircuitMeta {
  entityId: string;       // energy entity (kWh)
  powerEntityId: string;  // power entity (W) — for real-time display
  label: string;
  category: string;
  panel?: string;         // parent panel id (matches PANEL_CATALOG ids in the frontend)
}

export const ENERGY_CIRCUITS: CircuitMeta[] = [
  { entityId: 'sensor.av_room_panel_energy_today', powerEntityId: 'sensor.av_room_panel_power_minute_average', label: 'AV Room Panel', category: 'Panels', panel: 'av_room' },
  { entityId: 'sensor.balance_energy_today', powerEntityId: 'sensor.balance_power_minute_average', label: 'Balance (GP1)', category: 'Panels', panel: 'garage1' },
  { entityId: 'sensor.balance_energy_today_2', powerEntityId: 'sensor.balance_power_minute_average_2', label: 'Balance (GP2)', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.balance_energy_today_3', powerEntityId: 'sensor.balance_power_minute_average_3', label: 'Balance (AV)', category: 'Panels', panel: 'av_room' },
  { entityId: 'sensor.balance_energy_today_4', powerEntityId: 'sensor.balance_power_minute_average_4', label: 'Balance (GH)', category: 'Panels', panel: 'guest_house' },
  { entityId: 'sensor.balance_energy_today_5', powerEntityId: 'sensor.balance_power_minute_average_5', label: 'Balance (ERC)', category: 'Panels', panel: 'equipment_room' },
  { entityId: 'sensor.garage_panel_1_energy_today', powerEntityId: 'sensor.garage_panel_1_power_minute_average', label: 'Garage Panel #1', category: 'Panels', panel: 'garage1' },
  { entityId: 'sensor.garage_panel_2_energy_today', powerEntityId: 'sensor.garage_panel_2_power_minute_average', label: 'Garage Panel #2', category: 'Panels', panel: 'garage2' },
  // GP2 Slot 2-8: raw Emporia Vue 2 internal bus-channel readings for Garage Panel #2.
  // These are NOT separate circuit loads — each slot corresponds to one of the named
  // GP2 circuits already listed in the panel catalog (ac_primary_bedroom, etc.).
  // Kept here for backend historical-query compatibility only; they are intentionally
  // excluded from the frontend circuit list and panel-breakdown panel catalog to
  // avoid double-counting.  The PANEL_CATALOG uses the named circuit entities.
  { entityId: 'sensor.garage_panel_2_energy_today_2', powerEntityId: 'sensor.garage_panel_2_power_minute_average_2', label: 'GP2 Slot 2', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.garage_panel_2_energy_today_3', powerEntityId: 'sensor.garage_panel_2_power_minute_average_3', label: 'GP2 Slot 3', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.garage_panel_2_energy_today_4', powerEntityId: 'sensor.garage_panel_2_power_minute_average_4', label: 'GP2 Slot 4', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.garage_panel_2_energy_today_5', powerEntityId: 'sensor.garage_panel_2_power_minute_average_5', label: 'GP2 Slot 5', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.garage_panel_2_energy_today_6', powerEntityId: 'sensor.garage_panel_2_power_minute_average_6', label: 'GP2 Slot 6', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.garage_panel_2_energy_today_7', powerEntityId: 'sensor.garage_panel_2_power_minute_average_7', label: 'GP2 Slot 7', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.garage_panel_2_energy_today_8', powerEntityId: 'sensor.garage_panel_2_power_minute_average_8', label: 'GP2 Slot 8', category: 'Panels', panel: 'garage2' },
  { entityId: 'sensor.guest_house_sub_panel_energy_today', powerEntityId: 'sensor.guest_house_sub_panel_power_minute_average', label: 'Guest House Panel', category: 'Panels', panel: 'guest_house' },
  { entityId: 'sensor.ac_package_unit_energy_today', powerEntityId: 'sensor.ac_package_unit_power_minute_average', label: 'AC Package Unit', category: 'HVAC', panel: 'garage2' },
  { entityId: 'sensor.ac_package_unit_join_cir_1_energy_today', powerEntityId: 'sensor.ac_package_unit_join_cir_1_power_minute_average', label: 'AC Package Unit (Cir1)', category: 'HVAC', panel: 'garage2' },
  { entityId: 'sensor.ac_primary_bedroom_energy_today', powerEntityId: 'sensor.ac_primary_bedroom_power_minute_average', label: 'AC Primary Bedroom', category: 'HVAC', panel: 'garage2' },
  { entityId: 'sensor.ac_compressor_rooftop_30amp_energy_today', powerEntityId: 'sensor.ac_compressor_rooftop_30amp_power_minute_average', label: 'AC Compressor Rooftop 30amp', category: 'HVAC', panel: 'garage2' },
  { entityId: 'sensor.ac_compressor_rooftop_50amp_energy_today', powerEntityId: 'sensor.ac_compressor_rooftop_50amp_power_minute_average', label: 'AC Compressor Rooftop 50amp', category: 'HVAC', panel: 'garage2' },
  { entityId: 'sensor.ac_unit_40amp_energy_today', powerEntityId: 'sensor.ac_unit_40amp_power_minute_average', label: 'AC Unit (40amp)', category: 'HVAC', panel: 'garage2' },
  { entityId: 'sensor.ac_wine_cellar_energy_today', powerEntityId: 'sensor.ac_wine_cellar_power_minute_average', label: 'AC Wine Cellar', category: 'HVAC', panel: 'av_room' },
  { entityId: 'sensor.gh_ac_energy_today', powerEntityId: 'sensor.gh_ac_power_minute_average', label: 'GH AC', category: 'HVAC', panel: 'guest_house' },
  { entityId: 'sensor.gh_furnace_energy_today', powerEntityId: 'sensor.gh_furnace_power_minute_average', label: 'GH Furnace', category: 'HVAC', panel: 'guest_house' },
  { entityId: 'sensor.gym_ac_energy_today', powerEntityId: 'sensor.gym_ac_power_minute_average', label: 'Gym AC', category: 'HVAC', panel: 'guest_house' },
  { entityId: 'sensor.gym_furnace_energy_today', powerEntityId: 'sensor.gym_furnace_power_minute_average', label: 'Gym Furnace', category: 'HVAC', panel: 'guest_house' },
  { entityId: 'sensor.lana_s_car_charger_energy_today', powerEntityId: 'sensor.lana_s_car_charger_power_minute_average', label: "Lana's Car Charger", category: 'Vehicles', panel: 'guest_house' },
  { entityId: 'sensor.tony_s_car_charger_energy_today', powerEntityId: 'sensor.tony_s_car_charger_power_minute_average', label: "Tony's Car Charger", category: 'Vehicles', panel: 'guest_house' },
  { entityId: 'sensor.equipment_room_cabana_energy_today', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average', label: 'ERC Panel (Main)', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_2',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_2',  label: 'ERC Breaker 2',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_3',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_3',  label: 'ERC Breaker 3',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_4',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_4',  label: 'ERC Breaker 4',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_5',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_5',  label: 'ERC Breaker 5',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_6',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_6',  label: 'ERC Breaker 6',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_7',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_7',  label: 'ERC Breaker 7',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_8',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_8',  label: 'ERC Breaker 8',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_9',  powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_9',  label: 'ERC Breaker 9',  category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_10', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_10', label: 'ERC Breaker 10', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_11', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_11', label: 'ERC Breaker 11', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_12', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_12', label: 'ERC Breaker 12', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_13', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_13', label: 'ERC Breaker 13', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_14', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_14', label: 'ERC Breaker 14', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_15', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_15', label: 'ERC Breaker 15', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_16', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_16', label: 'ERC Breaker 16', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.equipment_room_cabana_energy_today_17', powerEntityId: 'sensor.equipment_room_cabana_power_minute_average_17', label: 'ERC Breaker 17', category: 'Outdoor', panel: 'equipment_room' },
  { entityId: 'sensor.ext_gate_motors_energy_today', powerEntityId: 'sensor.ext_gate_motors_power_minute_average', label: 'Ext Gate Motors', category: 'Outdoor', panel: 'av_room' },
  { entityId: 'sensor.roof_top_receptacle_energy_today', powerEntityId: 'sensor.roof_top_receptacle_power_minute_average', label: 'Roof Top Receptacle', category: 'Outdoor', panel: 'garage2' },
  { entityId: 'sensor.sauna_energy_today', powerEntityId: 'sensor.sauna_power_minute_average', label: 'Sauna', category: 'Outdoor', panel: 'guest_house' },
  { entityId: 'sensor.sauna_energy_today_2', powerEntityId: 'sensor.sauna_power_minute_average_2', label: 'Sauna', category: 'Outdoor', panel: 'guest_house' },
  { entityId: 'sensor.sump_pump_energy_today', powerEntityId: 'sensor.sump_pump_power_minute_average', label: 'Sump Pump', category: 'Outdoor', panel: 'av_room' },
  { entityId: 'sensor.sump_pump_energy_today_2', powerEntityId: 'sensor.sump_pump_power_minute_average_2', label: 'Sump Pump', category: 'Outdoor', panel: 'av_room' },
  { entityId: 'sensor.bar_refrigerator_energy_today', powerEntityId: 'sensor.bar_refrigerator_power_minute_average', label: 'Bar Refrigerator', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.dishwashers_energy_today', powerEntityId: 'sensor.dishwashers_power_minute_average', label: 'Dishwashers', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.gh_counter_outlets_energy_today', powerEntityId: 'sensor.gh_counter_outlets_power_minute_average', label: 'GH Counter Outlets', category: 'Kitchen', panel: 'guest_house' },
  { entityId: 'sensor.gh_kitchen_outlets_energy_today', powerEntityId: 'sensor.gh_kitchen_outlets_power_minute_average', label: 'GH Kitchen Outlets', category: 'Kitchen', panel: 'guest_house' },
  { entityId: 'sensor.gh_refrigerator_energy_today', powerEntityId: 'sensor.gh_refrigerator_power_minute_average', label: 'GH Refrigerator', category: 'Kitchen', panel: 'guest_house' },
  { entityId: 'sensor.garbage_disposal_energy_today', powerEntityId: 'sensor.garbage_disposal_power_minute_average', label: 'Garbage Disposal', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.kitchen_counter_gfcis_energy_today', powerEntityId: 'sensor.kitchen_counter_gfcis_power_minute_average', label: 'Kitchen Counter GFCIs', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.kitchen_double_oven_energy_today', powerEntityId: 'sensor.kitchen_double_oven_power_minute_average', label: 'Kitchen Double Oven', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.kitchen_island_sub_zeros_energy_today', powerEntityId: 'sensor.kitchen_island_sub_zeros_power_minute_average', label: 'Kitchen Island Sub Zeros', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.kitchen_sub_zero_energy_today', powerEntityId: 'sensor.kitchen_sub_zero_power_minute_average', label: 'Kitchen Sub Zero', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.kitchen_sub_zero_freezer_energy_today', powerEntityId: 'sensor.kitchen_sub_zero_freezer_power_minute_average', label: 'Kitchen Sub Zero Freezer', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.stove_hood_energy_today', powerEntityId: 'sensor.stove_hood_power_minute_average', label: 'Stove Hood', category: 'Kitchen', panel: 'garage1' },
  { entityId: 'sensor.crestron_lighting_energy_today', powerEntityId: 'sensor.crestron_lighting_power_minute_average', label: 'Crestron Lighting', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.crestron_lighting_energy_today_2', powerEntityId: 'sensor.crestron_lighting_power_minute_average_2', label: 'Crestron Lighting 2', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.crestron_lighting_energy_today_3', powerEntityId: 'sensor.crestron_lighting_power_minute_average_3', label: 'Crestron Lighting 3', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.crestron_lighting_energy_today_4', powerEntityId: 'sensor.crestron_lighting_power_minute_average_4', label: 'Crestron Lighting 4', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.crestron_lighting_energy_today_5', powerEntityId: 'sensor.crestron_lighting_power_minute_average_5', label: 'Crestron Lighting 5', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.crestron_lighting_panel_energy_today', powerEntityId: 'sensor.crestron_lighting_panel_power_minute_average', label: 'Crestron Lighting Panel', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.first_floor_lighting_energy_today', powerEntityId: 'sensor.first_floor_lighting_power_minute_average', label: 'First Floor Lighting', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.second_floor_lighting_energy_today', powerEntityId: 'sensor.second_floor_lighting_power_minute_average', label: 'Second Floor Lighting', category: 'Lighting', panel: 'av_room' },
  { entityId: 'sensor.av_rack_energy_today', powerEntityId: 'sensor.av_rack_power_minute_average', label: 'AV Rack', category: 'Other', panel: 'av_room' },
  { entityId: 'sensor.av_rack_energy_today_2', powerEntityId: 'sensor.av_rack_power_minute_average_2', label: 'AV Rack 2', category: 'Other', panel: 'av_room' },
  { entityId: 'sensor.av_rack_energy_today_3', powerEntityId: 'sensor.av_rack_power_minute_average_3', label: 'AV Rack 3', category: 'Other', panel: 'av_room' },
  { entityId: 'sensor.elevator_energy_today', powerEntityId: 'sensor.elevator_power_minute_average', label: 'Elevator', category: 'Other', panel: 'av_room' },
  { entityId: 'sensor.gh_garage_opener_energy_today', powerEntityId: 'sensor.gh_garage_opener_power_minute_average', label: 'GH Garage Opener', category: 'Other', panel: 'guest_house' },
  { entityId: 'sensor.gh_garage_outlets_energy_today', powerEntityId: 'sensor.gh_garage_outlets_power_minute_average', label: 'GH Garage Outlets', category: 'Other', panel: 'guest_house' },
  { entityId: 'sensor.gh_washer_dryer_energy_today', powerEntityId: 'sensor.gh_washer_dryer_power_minute_average', label: 'GH Washer Dryer', category: 'Other', panel: 'guest_house' },
  { entityId: 'sensor.garage_ceiling_cord_plugs_energy_today', powerEntityId: 'sensor.garage_ceiling_cord_plugs_power_minute_average', label: 'Garage Ceiling Cord Plugs', category: 'Other', panel: 'garage1' },
  { entityId: 'sensor.garage_doors_energy_today', powerEntityId: 'sensor.garage_doors_power_minute_average', label: 'Garage Doors', category: 'Other', panel: 'garage1' },
  { entityId: 'sensor.garage_gfcis_energy_today', powerEntityId: 'sensor.garage_gfcis_power_minute_average', label: 'Garage GFCIs', category: 'Other', panel: 'garage1' },
  { entityId: 'sensor.table_saw_energy_today', powerEntityId: 'sensor.table_saw_power_minute_average', label: 'Table Saw', category: 'Other', panel: 'garage1' },
  { entityId: 'sensor.garage_wall_plugs_energy_today', powerEntityId: 'sensor.garage_wall_plugs_power_minute_average', label: 'Garage Wall Plugs', category: 'Other', panel: 'garage2' },
  { entityId: 'sensor.garage_wall_plugs_energy_today_2', powerEntityId: 'sensor.garage_wall_plugs_power_minute_average_2', label: 'Garage Wall Plugs', category: 'Other', panel: 'garage2' },
  { entityId: 'sensor.gym_outlets_energy_today', powerEntityId: 'sensor.gym_outlets_power_minute_average', label: 'Gym Outlets', category: 'Other', panel: 'guest_house' },
  { entityId: 'sensor.gym_outlets_energy_today_2', powerEntityId: 'sensor.gym_outlets_power_minute_average_2', label: 'Gym Outlets', category: 'Other', panel: 'guest_house' },
  { entityId: 'sensor.washer_dryer_1_energy_today', powerEntityId: 'sensor.washer_dryer_1_power_minute_average', label: 'Washer & Dryer (1)', category: 'Other', panel: 'garage1' },
  { entityId: 'sensor.washer_dryer_2_energy_today', powerEntityId: 'sensor.washer_dryer_2_power_minute_average', label: 'Washer & Dryer (2)', category: 'Other', panel: 'garage1' },
  { entityId: 'sensor.wen_air_purifier_energy_today', powerEntityId: 'sensor.wen_air_purifier_power_minute_average', label: 'Wen Air Purifier', category: 'Other', panel: 'garage1' },
];

export const PANEL_MAIN_ENERGY_ENTITY_IDS = [
  'sensor.garage_panel_1_energy_today',
  'sensor.garage_panel_2_energy_today',
  'sensor.av_room_panel_energy_today',
  'sensor.guest_house_sub_panel_energy_today',
  'sensor.equipment_room_cabana_energy_today',
] as const;

// Raw duplicate channels and intermediate parents are retained in ENERGY_CIRCUITS
// for compatibility, but are not independent members of the canonical hierarchy.
const CANONICAL_NON_LEAF_ENERGY_IDS = new Set([
  ...PANEL_MAIN_ENERGY_ENTITY_IDS,
  'sensor.crestron_lighting_panel_energy_today',
  ...Array.from({ length: 7 }, (_, i) => `sensor.garage_panel_2_energy_today_${i + 2}`),
]);

export const CANONICAL_LEAF_ENERGY_ENTITY_IDS = ENERGY_CIRCUITS
  .map(circuit => circuit.entityId)
  .filter(entityId => !CANONICAL_NON_LEAF_ENERGY_IDS.has(entityId));

// A trustworthy historical day needs both the non-overlapping insight leaves
// and the five panel mains used to determine whole-house tariff context.
export const CANONICAL_ENERGY_HIERARCHY_IDS = [
  ...PANEL_MAIN_ENERGY_ENTITY_IDS,
  ...CANONICAL_LEAF_ENERGY_ENTITY_IDS,
];

// ── Types ──────────────────────────────────────────────────────────────
export interface StatisticsPoint {
  start: string;    // ISO timestamp
  end: string;
  state: number;    // raw sensor value at end of period
  sum: number;      // cumulative total since stats started
  change: number;   // kWh consumed in this period
}

export interface CircuitEnergyData {
  entityId: string;
  label: string;
  category: string;
  totalKwh: number;
  points: StatisticsPoint[];
}

export interface CompleteDailyEnergyStatistics {
  usageDate: string;
  complete: boolean;
  values: Map<string, number>;
  missingEntityIds: string[];
  invalidEntityIds: string[];
}

// ── Fetch statistics from HA ───────────────────────────────────────────

/**
 * Get energy statistics for specified circuits over a time range.
 * Uses HA WebSocket's `recorder/statistics_during_period` message.
 *
 * @param entityIds - Entity IDs to query (must be energy/kWh sensors)
 * @param startTime - ISO timestamp or Date
 * @param endTime - ISO timestamp or Date (optional, defaults to now)
 * @param period - 'hour' | 'day' | 'week' | 'month'
 */
export async function getEnergyStatistics(
  entityIds: string[],
  startTime: Date | string,
  endTime?: Date | string,
  period: 'hour' | 'day' | 'week' | 'month' = 'hour',
): Promise<Record<string, StatisticsPoint[]>> {
  const start = startTime instanceof Date ? startTime.toISOString() : startTime;
  const end = endTime
    ? (endTime instanceof Date ? endTime.toISOString() : endTime)
    : new Date().toISOString();

  try {
    const result = await sendHAWSCommand({
      type: 'recorder/statistics_during_period',
      start_time: start,
      end_time: end,
      statistic_ids: entityIds,
      period,
      types: ['change', 'state', 'sum'],
      units: { energy: 'kWh' },
    }, 30_000);

    return (result as Record<string, StatisticsPoint[]>) ?? {};
  } catch (err) {
    console.error('[haStatistics] Failed to fetch statistics:', err);
    return {};
  }
}

/**
 * Validate one HA daily-statistics response against the canonical hierarchy.
 * A zero is accepted only when HA supplied a real point whose `change` is the
 * finite number zero; absent, malformed, and wrong-day points never become 0.
 */
export function validateCompleteDailyEnergyStatistics(
  stats: Record<string, StatisticsPoint[]>,
  usageDate: string,
  requiredEntityIds: readonly string[] = CANONICAL_ENERGY_HIERARCHY_IDS,
): CompleteDailyEnergyStatistics {
  const values = new Map<string, number>();
  const missingEntityIds: string[] = [];
  const invalidEntityIds: string[] = [];

  for (const entityId of requiredEntityIds) {
    const pointsForDate = (stats[entityId] ?? []).filter(point =>
      typeof point.start === 'string' && laDateString(point.start) === usageDate
    );
    if (pointsForDate.length === 0) {
      missingEntityIds.push(entityId);
      continue;
    }

    let total = 0;
    let valid = true;
    for (const point of pointsForDate) {
      const change: unknown = point.change;
      if (typeof change !== 'number' || !Number.isFinite(change) || change < 0) {
        valid = false;
        break;
      }
      total += change;
    }
    if (!valid) {
      invalidEntityIds.push(entityId);
      continue;
    }
    values.set(entityId, +total.toFixed(4));
  }

  return {
    usageDate,
    complete: missingEntityIds.length === 0 && invalidEntityIds.length === 0,
    values,
    missingEntityIds,
    invalidEntityIds,
  };
}

/**
 * Get total grid consumption (all circuits combined) for a time range.
 */
export async function getGridConsumption(
  startTime: Date,
  endTime?: Date,
  period: 'hour' | 'day' | 'week' | 'month' = 'day',
): Promise<{ totalKwh: number; circuits: CircuitEnergyData[] }> {
  const entityIds = ENERGY_CIRCUITS.map(c => c.entityId);
  const stats = await getEnergyStatistics(entityIds, startTime, endTime, period);

  const circuits: CircuitEnergyData[] = [];
  let totalKwh = 0;

  for (const circuit of ENERGY_CIRCUITS) {
    const points = stats[circuit.entityId] ?? [];
    const circuitKwh = points.reduce((sum, p) => sum + (p.change || 0), 0);
    totalKwh += circuitKwh;
    circuits.push({
      entityId: circuit.entityId,
      label: circuit.label,
      category: circuit.category,
      totalKwh: +circuitKwh.toFixed(3),
      points,
    });
  }

  return { totalKwh: +totalKwh.toFixed(3), circuits };
}

/**
 * Get kWh consumed today so far (since midnight LA time).
 */
export async function getTodayConsumption(): Promise<{ totalKwh: number; circuits: CircuitEnergyData[] }> {
  // Midnight in LA timezone
  const now = new Date();
  const laFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = laFormatter.formatToParts(now);
  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const d = parts.find(p => p.type === 'day')!.value;
  const midnightLA = new Date(`${y}-${m}-${d}T00:00:00-07:00`);

  return getGridConsumption(midnightLA, now, 'hour');
}

/**
 * Get kWh consumed this billing cycle so far.
 * LADWP bi-monthly cycles start on approximately the 21st–23rd of every other month.
 * For simplicity, we estimate the cycle start based on the last known cycle boundary.
 */
export function estimateBillingCycleStart(now?: Date): Date {
  const current = now ?? new Date();
  // Known cycle boundaries from bills:
  // 2/23, 4/21, 6/17 (estimated), 8/18, 10/21, 12/22
  // These are ~57-64 day cycles. Approximate by using the known boundaries.
  const boundaries = [
    { month: 0, day: 22 },  // Jan 22 (estimated)
    { month: 1, day: 23 },  // Feb 23
    { month: 3, day: 21 },  // Apr 21
    { month: 5, day: 17 },  // Jun 17
    { month: 7, day: 18 },  // Aug 18
    { month: 9, day: 21 },  // Oct 21
    { month: 11, day: 22 }, // Dec 22
  ];

  const year = current.getFullYear();
  // Find the most recent boundary before 'now'.
  // Build boundary dates at noon UTC so the calendar day is identical in every
  // timezone — the comparison vs `current` is absolute-timestamp based, and
  // downstream (getSeasonalRate via midDate.getMonth()) only cares about the
  // calendar month, which is stable under noon-UTC + PT formatting.
  let best: Date | null = null;
  for (const b of boundaries) {
    for (const y of [year, year - 1]) {
      const candidate = new Date(Date.UTC(y, b.month, b.day, 12));
      if (candidate <= current) {
        if (!best || candidate > best) best = candidate;
      }
    }
  }

  return best ?? new Date(Date.UTC(year, current.getUTCMonth(), 1, 12));
}

/**
 * Get billing-cycle-to-date consumption and cost.
 */
export async function getBillingCycleConsumption(): Promise<{
  cycleStart: Date;
  daysInCycle: number;
  totalKwh: number;
  circuits: CircuitEnergyData[];
}> {
  const cycleStart = estimateBillingCycleStart();
  const now = new Date();
  const daysInCycle = Math.max(1, Math.round((now.getTime() - cycleStart.getTime()) / (1000 * 60 * 60 * 24)));
  const { totalKwh, circuits } = await getGridConsumption(cycleStart, now, 'day');

  return { cycleStart, daysInCycle, totalKwh, circuits };
}

// ── Robust live-state sources ──────────────────────────────────────────
// The HA recorder/statistics_during_period endpoint is unreliable/empty for
// these Emporia _energy_today sensors, which made the Cost Intelligence view
// show $0 despite a live ~31 kW load. These helpers read the CURRENT STATE of
// the daily total-increasing _energy_today counters from the live entity cache
// (the same source the live-power UI uses) and read completed days from the
// Club34-owned circuit_energy_daily table.

export interface CircuitTodayKwh {
  entityId: string;
  label: string;
  category: string;
  kwh: number;
}

/**
 * Today's kWh per circuit, derived from the current STATE of each
 * sensor.<x>_energy_today counter (resets at LA midnight, total_increasing).
 * Reads from the live HA WS entity cache — no recorder query involved.
 */
export function getTodayConsumptionFromStates(): {
  totalKwh: number;
  circuits: CircuitTodayKwh[];
} {
  const cache = getEntityCache();
  const byId = new Map(cache.map(e => [e.entity_id, e]));

  const circuits: CircuitTodayKwh[] = [];
  let totalKwh = 0;

  for (const circuit of ENERGY_CIRCUITS) {
    const entity = byId.get(circuit.entityId);
    const raw = entity ? parseFloat(entity.state) : NaN;
    const kwh = Number.isFinite(raw) && raw >= 0 ? raw : 0;
    totalKwh += kwh;
    circuits.push({
      entityId: circuit.entityId,
      label: circuit.label,
      category: circuit.category,
      kwh: +kwh.toFixed(3),
    });
  }

  return { totalKwh: +totalKwh.toFixed(3), circuits };
}

/**
 * Per-circuit kWh for completed days of the current billing cycle, summed from
 * the circuit_energy_daily table. Excludes today (which is read live from
 * _energy_today state and added separately) to avoid double counting.
 */
export async function getCycleConsumptionFromDb(cycleStart: Date): Promise<{
  totalKwh: number;
  circuits: CircuitTodayKwh[];
  daysWithData: number;
  coveredDates: string[];
}> {
  // LA-local date strings for the cycle window [cycleStart, today).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const cycleStartDate = fmt.format(cycleStart);     // YYYY-MM-DD
  const todayDate = fmt.format(new Date());

  const labelById = new Map(ENERGY_CIRCUITS.map(c => [c.entityId, c]));
  const circuits: CircuitTodayKwh[] = [];
  let totalKwh = 0;
  let daysWithData = 0;
  const coveredDates: string[] = [];

  try {
    const { rows } = await query<{ entity_id: string; label: string | null; category: string | null; kwh: string | number | null; days: number }>(
      `SELECT entity_id, MAX(label) AS label, MAX(category) AS category,
              SUM(kwh) AS kwh, COUNT(DISTINCT usage_date) AS days
       FROM circuit_energy_daily
       WHERE usage_date >= $1::date AND usage_date < $2::date
       GROUP BY entity_id`,
      [cycleStartDate, todayDate],
    );

    let maxDays = 0;
    for (const r of rows) {
      const meta = labelById.get(r.entity_id);
      const kwh = Number(r.kwh) || 0;
      totalKwh += kwh;
      maxDays = Math.max(maxDays, Number(r.days) || 0);
      circuits.push({
        entityId: r.entity_id,
        label: meta?.label ?? r.label ?? r.entity_id,
        category: meta?.category ?? r.category ?? 'Other',
        kwh: +kwh.toFixed(3),
      });
    }
    daysWithData = maxDays;

    // Which LA-local dates does the DB actually cover? Used so the HA-stats
    // fallback only fills the elapsed days the DB is MISSING (no double count).
    if (rows.length > 0) {
      const { rows: dateRows } = await query<{ d: string | null }>(
        `SELECT DISTINCT to_char(usage_date, 'YYYY-MM-DD') AS d
         FROM circuit_energy_daily
         WHERE usage_date >= $1::date AND usage_date < $2::date
         ORDER BY d`,
        [cycleStartDate, todayDate],
      );
      for (const dr of dateRows) if (dr.d) coveredDates.push(dr.d);
    }
  } catch (err) {
    console.warn('[haStatistics] getCycleConsumptionFromDb failed:', err instanceof Error ? err.message : err);
  }

  return { totalKwh: +totalKwh.toFixed(3), circuits, daysWithData, coveredDates };
}

/**
 * Map an ISO timestamp (a statistics period start) to its LA-local calendar
 * date string (YYYY-MM-DD). HA returns day-period buckets aligned to local
 * midnight, so this groups each `change` to the day it belongs to.
 */
function laDateString(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(iso));
}

/**
 * Per-circuit kWh for ELAPSED cycle days that circuit_energy_daily does NOT yet
 * cover, recovered from HA long-term statistics (recorder/statistics_during_period
 * with day periods). HA retains these statistics for the _energy_today sensors
 * long after the recorder's short-term purge, so the elapsed days are
 * recoverable even when the Club34 snapshot table is empty.
 *
 * Returns per-circuit summed kWh over the filled days plus the set of LA-local
 * dates that were actually filled (so the daily-average denominator can count
 * real elapsed days, not a stale row count). `excludeDates` are days already in
 * the DB; `excludeToday` is the current LA date (read live elsewhere). Both are
 * skipped to avoid double-counting.
 */
export async function getCycleConsumptionFromStats(
  cycleStart: Date,
  excludeDates: Set<string>,
  excludeToday: string,
): Promise<{ circuits: CircuitTodayKwh[]; filledDates: string[] }> {
  const labelById = new Map(ENERGY_CIRCUITS.map(c => [c.entityId, c]));
  const perCircuit = new Map<string, number>();
  const filled = new Set<string>();

  try {
    const entityIds = ENERGY_CIRCUITS.map(c => c.entityId);
    // Query [cycleStart, now); HA buckets by local day. We then drop any day the
    // DB already owns and today (live), summing only the genuinely-missing days.
    const stats = await getEnergyStatistics(entityIds, cycleStart, new Date(), 'day');

    for (const circuit of ENERGY_CIRCUITS) {
      const points = stats[circuit.entityId] ?? [];
      let kwh = 0;
      for (const p of points) {
        if (!p.start) continue;
        const day = laDateString(p.start);
        if (excludeDates.has(day) || day === excludeToday) continue;
        if (day < laDateString(cycleStart.toISOString())) continue;
        const change = Number(p.change) || 0;
        if (change <= 0) continue;
        kwh += change;
        filled.add(day);
      }
      if (kwh > 0) perCircuit.set(circuit.entityId, +kwh.toFixed(3));
    }
  } catch (err) {
    console.warn('[haStatistics] getCycleConsumptionFromStats failed:', err instanceof Error ? err.message : err);
  }

  const circuits: CircuitTodayKwh[] = [];
  for (const [entityId, kwh] of perCircuit) {
    const meta = labelById.get(entityId);
    circuits.push({
      entityId,
      label: meta?.label ?? entityId,
      category: meta?.category ?? 'Other',
      kwh,
    });
  }

  return { circuits, filledDates: Array.from(filled) };
}

/**
 * Robust per-circuit cycle-to-date kWh:
 *   completed days from circuit_energy_daily
 *   + elapsed days the DB is missing, recovered from HA long-term statistics
 *   + today's partial from live _energy_today state.
 * This is the authoritative source for the Cost Intelligence breakdown and Top
 * Consumers. It stays correct even when circuit_energy_daily is brand-new/empty,
 * because the HA-stats fallback fills every elapsed cycle day the DB lacks.
 *
 * `daysWithData` reflects the number of ELAPSED cycle days actually covered
 * (distinct DB days ∪ stats-filled days, + 1 for today) so daily-average math
 * divides by real elapsed days rather than a stale count.
 */
export async function getCycleConsumptionRobust(cycleStart: Date): Promise<{
  totalKwh: number;
  circuits: CircuitTodayKwh[];
  daysWithData: number;
  source: 'db+live' | 'db+stats+live' | 'stats+live' | 'live-only';
}> {
  const db = await getCycleConsumptionFromDb(cycleStart);
  const today = getTodayConsumptionFromStates();

  const todayDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  const dbDates = new Set(db.coveredDates);
  // Fill elapsed cycle days the DB does not cover from HA long-term statistics.
  const stats = await getCycleConsumptionFromStats(cycleStart, dbDates, todayDate);

  const merged = new Map<string, CircuitTodayKwh>();
  const add = (c: CircuitTodayKwh) => {
    const existing = merged.get(c.entityId);
    if (existing) existing.kwh = +(existing.kwh + c.kwh).toFixed(3);
    else merged.set(c.entityId, { ...c });
  };

  for (const c of db.circuits) add(c);
  for (const c of stats.circuits) add(c);
  for (const t of today.circuits) add(t);

  // Ensure every known circuit is represented (even at 0) for a stable UI.
  for (const circuit of ENERGY_CIRCUITS) {
    if (!merged.has(circuit.entityId)) {
      merged.set(circuit.entityId, {
        entityId: circuit.entityId, label: circuit.label,
        category: circuit.category, kwh: 0,
      });
    }
  }

  const circuits = Array.from(merged.values());
  const totalKwh = +circuits.reduce((s, c) => s + c.kwh, 0).toFixed(3);

  // Elapsed days covered: distinct DB days + distinct stats-filled days + today.
  const coveredElapsed = new Set<string>([...dbDates, ...stats.filledDates]);
  const daysWithData = coveredElapsed.size + 1; // + today (partial)

  const hasDb = db.totalKwh > 0;
  const hasStats = stats.circuits.length > 0;
  let source: 'db+live' | 'db+stats+live' | 'stats+live' | 'live-only';
  if (hasDb && hasStats) source = 'db+stats+live';
  else if (hasDb) source = 'db+live';
  else if (hasStats) source = 'stats+live';
  else source = 'live-only';

  return { totalKwh, circuits, daysWithData, source };
}
