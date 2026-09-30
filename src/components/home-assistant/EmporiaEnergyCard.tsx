import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Zap, AlertTriangle, Loader2, Search, ArrowDownUp, ChevronDown, ChevronRight, LayoutGrid, List, BarChart3 } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useHAEntities } from '@/hooks/useHAEntities';
import { apiClient } from '@/lib/apiClient';
import { cn } from '@/lib/utils';
import { CircuitDetailDrawer } from './CircuitDetailDrawer';
import { PanelHistoryDrawer, type PanelHistoryTarget } from './PanelHistoryDrawer';

// ── Circuit configuration ─────────────────────────────────────────────
interface CircuitConfig {
  entityId: string;       // power (W) entity
  energyEntityId: string; // energy_today (kWh) entity
  label: string;
  category: string;
  color: string;
}

// power → energy entity id: _power_minute_average → _energy_today (suffix preserved)
function energyIdFor(powerId: string): string {
  return powerId.replace('_power_minute_average', '_energy_today');
}

const RAW_CIRCUITS: Array<Omit<CircuitConfig, 'energyEntityId'>> = [
  { entityId: 'sensor.av_room_panel_power_minute_average', label: 'AV Room Panel', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.balance_power_minute_average', label: 'Balance (GP1)', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.balance_power_minute_average_2', label: 'Balance (GP2)', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.balance_power_minute_average_3', label: 'Balance (AV)', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.balance_power_minute_average_4', label: 'Balance (GH)', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.balance_power_minute_average_5', label: 'Balance (ERC)', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.garage_panel_1_power_minute_average', label: 'Garage Panel #1', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.garage_panel_2_power_minute_average', label: 'Garage Panel #2', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.guest_house_sub_panel_power_minute_average', label: 'Guest House Panel', category: 'Panels', color: 'text-violet-400' },
  { entityId: 'sensor.ac_package_unit_power_minute_average', label: 'AC Package Unit', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.ac_package_unit_join_cir_1_power_minute_average', label: 'AC Package Unit (Cir1)', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.ac_primary_bedroom_power_minute_average', label: 'AC Primary Bedroom', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.ac_compressor_rooftop_30amp_power_minute_average', label: 'AC Compressor Rooftop 30amp', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.ac_compressor_rooftop_50amp_power_minute_average', label: 'AC Compressor Rooftop 50amp', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.ac_unit_40amp_power_minute_average', label: 'AC Unit (40amp)', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.ac_wine_cellar_power_minute_average', label: 'AC Wine Cellar', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.gh_ac_power_minute_average', label: 'GH AC', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.gh_furnace_power_minute_average', label: 'GH Furnace', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.gym_ac_power_minute_average', label: 'Gym AC', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.gym_furnace_power_minute_average', label: 'Gym Furnace', category: 'HVAC', color: 'text-blue-400' },
  { entityId: 'sensor.lana_s_car_charger_power_minute_average', label: 'EV Charger 1', category: 'Vehicles', color: 'text-green-400' },
  { entityId: 'sensor.tony_s_car_charger_power_minute_average', label: 'EV Charger 2', category: 'Vehicles', color: 'text-green-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average', label: 'ERC Panel (Main)', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_2',  label: 'ERC Breaker 2',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_3',  label: 'ERC Breaker 3',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_4',  label: 'ERC Breaker 4',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_5',  label: 'ERC Breaker 5',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_6',  label: 'ERC Breaker 6',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_7',  label: 'ERC Breaker 7',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_8',  label: 'ERC Breaker 8',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_9',  label: 'ERC Breaker 9',  category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_10', label: 'ERC Breaker 10', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_11', label: 'ERC Breaker 11', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_12', label: 'ERC Breaker 12', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_13', label: 'ERC Breaker 13', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_14', label: 'ERC Breaker 14', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_15', label: 'ERC Breaker 15', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_16', label: 'ERC Breaker 16', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.equipment_room_cabana_power_minute_average_17', label: 'ERC Breaker 17', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.ext_gate_motors_power_minute_average', label: 'Ext Gate Motors', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.roof_top_receptacle_power_minute_average', label: 'Roof Top Receptacle', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.sauna_power_minute_average', label: 'Sauna', category: 'Outdoor', color: 'text-orange-400' },
  { entityId: 'sensor.sauna_power_minute_average_2', label: 'Sauna', category: 'Outdoor', color: 'text-orange-400' },
  { entityId: 'sensor.sump_pump_power_minute_average', label: 'Sump Pump', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.sump_pump_power_minute_average_2', label: 'Sump Pump', category: 'Outdoor', color: 'text-cyan-400' },
  { entityId: 'sensor.bar_refrigerator_power_minute_average', label: 'Bar Refrigerator', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.dishwashers_power_minute_average', label: 'Dishwashers', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.gh_counter_outlets_power_minute_average', label: 'GH Counter Outlets', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.gh_kitchen_outlets_power_minute_average', label: 'GH Kitchen Outlets', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.gh_refrigerator_power_minute_average', label: 'GH Refrigerator', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.garbage_disposal_power_minute_average', label: 'Garbage Disposal', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.kitchen_counter_gfcis_power_minute_average', label: 'Kitchen Counter GFCIs', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.kitchen_double_oven_power_minute_average', label: 'Kitchen Double Oven', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.kitchen_island_sub_zeros_power_minute_average', label: 'Kitchen Island Sub Zeros', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.kitchen_sub_zero_power_minute_average', label: 'Kitchen Sub Zero', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.kitchen_sub_zero_freezer_power_minute_average', label: 'Kitchen Sub Zero Freezer', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.stove_hood_power_minute_average', label: 'Stove Hood', category: 'Kitchen', color: 'text-amber-400' },
  { entityId: 'sensor.crestron_lighting_power_minute_average', label: 'Crestron Lighting', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.crestron_lighting_power_minute_average_2', label: 'Crestron Lighting 2', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.crestron_lighting_power_minute_average_3', label: 'Crestron Lighting 3', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.crestron_lighting_power_minute_average_4', label: 'Crestron Lighting 4', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.crestron_lighting_power_minute_average_5', label: 'Crestron Lighting 5', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.crestron_lighting_panel_power_minute_average', label: 'Crestron Lighting Panel', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.first_floor_lighting_power_minute_average', label: 'First Floor Lighting', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.second_floor_lighting_power_minute_average', label: 'Second Floor Lighting', category: 'Lighting', color: 'text-yellow-400' },
  { entityId: 'sensor.av_rack_power_minute_average', label: 'AV Rack', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.av_rack_power_minute_average_2', label: 'AV Rack 2', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.av_rack_power_minute_average_3', label: 'AV Rack 3', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.elevator_power_minute_average', label: 'Elevator', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.gh_garage_opener_power_minute_average', label: 'GH Garage Opener', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.gh_garage_outlets_power_minute_average', label: 'GH Garage Outlets', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.gh_washer_dryer_power_minute_average', label: 'GH Washer Dryer', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.garage_ceiling_cord_plugs_power_minute_average', label: 'Garage Ceiling Cord Plugs', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.garage_doors_power_minute_average', label: 'Garage Doors', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.garage_gfcis_power_minute_average', label: 'Garage GFCIs', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.table_saw_power_minute_average', label: 'Table Saw', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.garage_wall_plugs_power_minute_average', label: 'Garage Wall Plugs', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.garage_wall_plugs_power_minute_average_2', label: 'Garage Wall Plugs', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.gym_outlets_power_minute_average', label: 'Gym Outlets', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.gym_outlets_power_minute_average_2', label: 'Gym Outlets', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.washer_dryer_1_power_minute_average', label: 'Washer & Dryer (1)', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.washer_dryer_2_power_minute_average', label: 'Washer & Dryer (2)', category: 'Other', color: 'text-slate-400' },
  { entityId: 'sensor.wen_air_purifier_power_minute_average', label: 'Wen Air Purifier', category: 'Other', color: 'text-slate-400' },
];

const CIRCUITS: CircuitConfig[] = RAW_CIRCUITS.map(c => ({ ...c, energyEntityId: energyIdFor(c.entityId) }));

// ── Panel Catalog ─────────────────────────────────────────────────────
// Authoritative mapping of each panel → its named child circuits.
// Panel mains are NOT included in their own child list (they include children by definition).
// The Balance row is computed: panel_main - sum(measured_children), matching the native Emporia app.
// Whole-house totals ALWAYS sum only the 5 panel mains to avoid double-counting.

interface PanelDef {
  id: string;
  label: string;
  mainEntityId: string;        // power (W) entity for the panel main
  childEntityIds: string[];    // ordered child power entity IDs (named circuits from native app)
  /** Optional display-name overrides for specific child entity IDs (e.g. temporary labels
   *  for Emporia channels whose native-app names aren't yet reflected in HA entity friendly_names).
   *  Used by PanelCard; falls back to circuit.label from the main circuit catalog. */
  childLabelMap?: Record<string, string>;
  color: string;               // text color for the panel header value
  borderColor: string;         // border accent
  bgColor: string;             // header bg accent
}

const PANEL_CATALOG: PanelDef[] = [
  {
    id: 'garage1',
    label: 'Garage Panel #1',
    mainEntityId: 'sensor.garage_panel_1_power_minute_average',
    color: 'text-orange-400',
    borderColor: 'border-orange-500/40',
    bgColor: 'bg-orange-500/8',
    childEntityIds: [
      'sensor.garage_ceiling_cord_plugs_power_minute_average',
      'sensor.garage_doors_power_minute_average',
      'sensor.kitchen_sub_zero_freezer_power_minute_average',
      'sensor.kitchen_sub_zero_power_minute_average',
      'sensor.kitchen_counter_gfcis_power_minute_average',
      'sensor.bar_refrigerator_power_minute_average',
      'sensor.garage_gfcis_power_minute_average',
      'sensor.table_saw_power_minute_average',
      'sensor.kitchen_double_oven_power_minute_average',
      'sensor.kitchen_island_sub_zeros_power_minute_average',
      'sensor.washer_dryer_1_power_minute_average',
      'sensor.washer_dryer_2_power_minute_average',
      'sensor.wen_air_purifier_power_minute_average',
      'sensor.dishwashers_power_minute_average',
      'sensor.garbage_disposal_power_minute_average',
      'sensor.stove_hood_power_minute_average',
    ],
  },
  {
    id: 'garage2',
    label: 'Garage Panel #2',
    mainEntityId: 'sensor.garage_panel_2_power_minute_average',
    color: 'text-blue-400',
    borderColor: 'border-blue-500/40',
    bgColor: 'bg-blue-500/8',
    childEntityIds: [
      'sensor.ac_primary_bedroom_power_minute_average',
      'sensor.ac_unit_40amp_power_minute_average',
      'sensor.garage_wall_plugs_power_minute_average',
      'sensor.ac_compressor_rooftop_30amp_power_minute_average',
      'sensor.roof_top_receptacle_power_minute_average',
      'sensor.ac_compressor_rooftop_50amp_power_minute_average',
      'sensor.ac_package_unit_power_minute_average',
      'sensor.ac_package_unit_join_cir_1_power_minute_average',
      'sensor.garage_wall_plugs_power_minute_average_2',
    ],
  },
  {
    id: 'guest_house',
    label: 'Guest House Sub Panel',
    mainEntityId: 'sensor.guest_house_sub_panel_power_minute_average',
    color: 'text-green-400',
    borderColor: 'border-green-500/40',
    bgColor: 'bg-green-500/8',
    childEntityIds: [
      'sensor.gh_refrigerator_power_minute_average',
      'sensor.gym_outlets_power_minute_average',
      'sensor.gym_furnace_power_minute_average',
      'sensor.gym_outlets_power_minute_average_2',
      'sensor.gh_furnace_power_minute_average',
      'sensor.gh_counter_outlets_power_minute_average',
      'sensor.gh_washer_dryer_power_minute_average',
      'sensor.gh_ac_power_minute_average',
      'sensor.tony_s_car_charger_power_minute_average',
      'sensor.gym_ac_power_minute_average',
      'sensor.sauna_power_minute_average',
      'sensor.sauna_power_minute_average_2',
      'sensor.gh_garage_opener_power_minute_average',
      'sensor.lana_s_car_charger_power_minute_average',
      'sensor.gh_garage_outlets_power_minute_average',
      'sensor.gh_kitchen_outlets_power_minute_average',
    ],
  },
  {
    id: 'av_room',
    label: 'AV Room Panel',
    mainEntityId: 'sensor.av_room_panel_power_minute_average',
    color: 'text-violet-400',
    borderColor: 'border-violet-500/40',
    bgColor: 'bg-violet-500/8',
    childEntityIds: [
      'sensor.av_rack_power_minute_average',
      'sensor.ac_wine_cellar_power_minute_average',
      'sensor.av_rack_power_minute_average_2',
      'sensor.crestron_lighting_power_minute_average',
      'sensor.ext_gate_motors_power_minute_average',
      'sensor.crestron_lighting_power_minute_average_2',
      'sensor.av_rack_power_minute_average_3',
      'sensor.first_floor_lighting_power_minute_average',
      'sensor.elevator_power_minute_average',
      'sensor.crestron_lighting_panel_power_minute_average',
      'sensor.second_floor_lighting_power_minute_average',
      'sensor.sump_pump_power_minute_average',
      'sensor.sump_pump_power_minute_average_2',
      'sensor.crestron_lighting_power_minute_average_3',
      'sensor.crestron_lighting_power_minute_average_4',
      'sensor.crestron_lighting_power_minute_average_5',
    ],
  },
  {
    id: 'equipment_room',
    label: 'Equipment Room & Cabana',
    mainEntityId: 'sensor.equipment_room_cabana_power_minute_average',
    color: 'text-cyan-400',
    borderColor: 'border-cyan-500/40',
    bgColor: 'bg-cyan-500/8',
    // The ERC Emporia Vue 2 device exposes 16 numbered channel sensors in HA (channels 2-17).
    // childLabelMap labels them by channel number; update entries here once the Emporia
    // app's native ERC circuit names are confirmed from the native Emporia app.
    childLabelMap: {
      'sensor.equipment_room_cabana_power_minute_average_2':  'ERC Breaker 2',
      'sensor.equipment_room_cabana_power_minute_average_3':  'ERC Breaker 3',
      'sensor.equipment_room_cabana_power_minute_average_4':  'ERC Breaker 4',
      'sensor.equipment_room_cabana_power_minute_average_5':  'ERC Breaker 5',
      'sensor.equipment_room_cabana_power_minute_average_6':  'ERC Breaker 6',
      'sensor.equipment_room_cabana_power_minute_average_7':  'ERC Breaker 7',
      'sensor.equipment_room_cabana_power_minute_average_8':  'ERC Breaker 8',
      'sensor.equipment_room_cabana_power_minute_average_9':  'ERC Breaker 9',
      'sensor.equipment_room_cabana_power_minute_average_10': 'ERC Breaker 10',
      'sensor.equipment_room_cabana_power_minute_average_11': 'ERC Breaker 11',
      'sensor.equipment_room_cabana_power_minute_average_12': 'ERC Breaker 12',
      'sensor.equipment_room_cabana_power_minute_average_13': 'ERC Breaker 13',
      'sensor.equipment_room_cabana_power_minute_average_14': 'ERC Breaker 14',
      'sensor.equipment_room_cabana_power_minute_average_15': 'ERC Breaker 15',
      'sensor.equipment_room_cabana_power_minute_average_16': 'ERC Breaker 16',
      'sensor.equipment_room_cabana_power_minute_average_17': 'ERC Breaker 17',
    },
    childEntityIds: [
      'sensor.equipment_room_cabana_power_minute_average_2',
      'sensor.equipment_room_cabana_power_minute_average_3',
      'sensor.equipment_room_cabana_power_minute_average_4',
      'sensor.equipment_room_cabana_power_minute_average_5',
      'sensor.equipment_room_cabana_power_minute_average_6',
      'sensor.equipment_room_cabana_power_minute_average_7',
      'sensor.equipment_room_cabana_power_minute_average_8',
      'sensor.equipment_room_cabana_power_minute_average_9',
      'sensor.equipment_room_cabana_power_minute_average_10',
      'sensor.equipment_room_cabana_power_minute_average_11',
      'sensor.equipment_room_cabana_power_minute_average_12',
      'sensor.equipment_room_cabana_power_minute_average_13',
      'sensor.equipment_room_cabana_power_minute_average_14',
      'sensor.equipment_room_cabana_power_minute_average_15',
      'sensor.equipment_room_cabana_power_minute_average_16',
      'sensor.equipment_room_cabana_power_minute_average_17',
    ],
  },
];

// Category display order (for circuit view)
const CATEGORY_ORDER = ['Panels', 'HVAC', 'Vehicles', 'Outdoor', 'Kitchen', 'Lighting', 'Other'];

const CATEGORY_COLORS: Record<string, string> = {
  Panels:   'bg-violet-500/15 text-violet-400 border-violet-500/30',
  HVAC:     'bg-blue-500/15 text-blue-400 border-blue-500/30',
  Vehicles: 'bg-green-500/15 text-green-400 border-green-500/30',
  Outdoor:  'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  Kitchen:  'bg-amber-500/15 text-amber-400 border-amber-500/30',
  Lighting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  Other:    'bg-slate-500/15 text-slate-400 border-slate-500/30',
};

type SortMode = 'watts' | 'name' | 'category';
type ViewMode = 'panel' | 'circuit';
type TimeRange = 'live' | 'hour' | 'today' | 'week' | 'month' | 'cycle' | 'year';

// ── Watts formatting ──────────────────────────────────────────────────
function formatWatts(w: number): string {
  if (w >= 1000) return `${(w / 1000).toFixed(1)} kW`;
  return `${Math.round(w)} W`;
}

function getWattageColor(w: number): string {
  if (w >= 3000) return 'text-red-400';
  if (w >= 1500) return 'text-orange-400';
  if (w >= 500)  return 'text-yellow-400';
  if (w > 0)     return 'text-green-400';
  return 'text-muted-foreground';
}

function getValueColor(v: number, isLive: boolean): string {
  if (!isLive) return v > 0 ? 'text-amber-400' : 'text-muted-foreground';
  return getWattageColor(v);
}

// ── Power bar ─────────────────────────────────────────────────────────
function PowerBar({ value, maxValue, isLive = true }: { value: number; maxValue: number; isLive?: boolean }) {
  const pct = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0;
  const barColor = isLive
    ? (value >= 3000 ? 'bg-red-500/70' : value >= 1500 ? 'bg-orange-500/70' : value >= 500 ? 'bg-yellow-500/70' : value > 0 ? 'bg-green-500/70' : 'bg-muted')
    : (value > 0 ? 'bg-amber-500/70' : 'bg-muted');
  return (
    <div className="w-full h-1.5 rounded-full bg-muted/40 overflow-hidden">
      <div
        className={cn('h-full rounded-full transition-all duration-700', barColor)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

interface CircuitData extends CircuitConfig {
  watts: number;
  available: boolean;
  todayKwh: number;
  todayCost: number;
}

// ── Circuit row (flat/category view) ─────────────────────────────────
function CircuitRow({ circuit, maxValue, onClick }: {
  circuit: CircuitData; maxValue: number; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left py-2.5 space-y-1 hover:bg-muted/20 rounded-lg px-1.5 -mx-1.5 transition-colors"
    >
      <div className="flex items-center gap-2">
        <Zap className={cn('h-3.5 w-3.5 shrink-0', circuit.watts > 0 ? circuit.color : 'text-muted-foreground/40')} />
        <span className="text-sm flex-1 truncate">{circuit.label}</span>
        {!circuit.available && <AlertTriangle className="h-3 w-3 text-muted-foreground/50" />}
        <span className={cn('text-sm font-mono font-semibold tabular-nums', getWattageColor(circuit.watts))}>
          {circuit.available ? formatWatts(circuit.watts) : '—'}
        </span>
      </div>
      <div className="ml-5 flex items-center gap-2">
        <div className="flex-1"><PowerBar value={circuit.watts} maxValue={maxValue} /></div>
        {circuit.todayKwh > 0 && (
          <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap">
            {circuit.todayKwh.toFixed(1)} kWh · ${circuit.todayCost.toFixed(2)} today
          </span>
        )}
      </div>
    </button>
  );
}

// ── Category section (collapsible) ────────────────────────────────────
function CategorySection({ category, circuits, maxValue, collapsed, onToggle, onSelect }: {
  category: string;
  circuits: CircuitData[];
  maxValue: number;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (c: CircuitData) => void;
}) {
  const totalWatts = circuits.reduce((sum, c) => sum + c.watts, 0);
  const activeCount = circuits.filter(c => c.watts > 10).length;

  return (
    <div className="space-y-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 py-2 border-b border-border/50 mb-1 w-full text-left"
      >
        {collapsed
          ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        <Badge variant="outline" className={cn('text-[10px] px-2 py-0', CATEGORY_COLORS[category] ?? '')}>
          {category}
        </Badge>
        <span className="text-[10px] text-muted-foreground ml-auto">
          {activeCount} active · {formatWatts(totalWatts)}
        </span>
      </button>
      {!collapsed && (
        <div className="divide-y divide-border/30">
          {circuits.map(c => (
            <CircuitRow key={c.entityId} circuit={c} maxValue={maxValue} onClick={() => onSelect(c)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Total power gauge ─────────────────────────────────────────────────
function TotalPowerGauge({ totalWatts }: { totalWatts: number }) {
  const MAX_SERVICE_WATTS = 48000;
  const pct = Math.min((totalWatts / MAX_SERVICE_WATTS) * 100, 100);
  const gaugeColor = pct > 75 ? 'bg-red-500' : pct > 50 ? 'bg-orange-500' : pct > 25 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div className="space-y-2 p-4 rounded-xl bg-muted/20 border border-border/50">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Total Live Load</p>
          <p className={cn('text-3xl font-bold tabular-nums', getWattageColor(totalWatts))}>
            {formatWatts(totalWatts)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-muted-foreground">of 48 kW service</p>
          <p className="text-lg font-semibold text-muted-foreground">{pct.toFixed(1)}%</p>
        </div>
      </div>
      <div className="h-2.5 rounded-full bg-muted/50 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-700', gaugeColor)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground/60">
        <span>0</span><span>12 kW</span><span>24 kW</span><span>36 kW</span><span>48 kW</span>
      </div>
    </div>
  );
}

// ── Panel child row (panel control view) ─────────────────────────────
function PanelCircuitRow({ label, value, cost = 0, pct, panelMax, isLive, isBalance, onClick }: {
  label: string;
  value: number;
  cost?: number;
  pct: number;
  panelMax: number;
  isLive: boolean;
  isBalance?: boolean;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? 'button' : 'div';
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'w-full text-left py-2 space-y-1 px-2 -mx-2 rounded-md transition-colors',
        onClick ? 'hover:bg-muted/20 cursor-pointer' : 'cursor-default',
        isBalance ? 'opacity-60' : '',
      )}
    >
      <div className="flex items-center gap-2">
        {isBalance
          ? <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide w-3.5 shrink-0 text-center">≈</span>
          : <Zap className="h-3 w-3 shrink-0 text-muted-foreground/50" />}
        <span className={cn('text-sm flex-1 truncate', isBalance ? 'italic text-muted-foreground' : '')}>
          {label}
        </span>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums w-8 text-right shrink-0">
          {pct > 0 ? `${Math.round(pct)}%` : '0%'}
        </span>
        <span className="min-w-[4.5rem] text-right leading-tight">
          <span className={cn(
            'block text-sm font-mono font-semibold tabular-nums',
            isBalance ? 'text-muted-foreground' : getValueColor(value, isLive),
          )}>
            {isLive ? formatWatts(Math.max(0, value)) : value > 0 ? `${value.toFixed(2)} kWh` : '—'}
          </span>
          {!isLive && !isBalance && cost > 0 && (
            <span className="block text-[10px] font-mono font-medium tabular-nums text-muted-foreground">
              ${cost.toFixed(2)}
            </span>
          )}
        </span>
      </div>
      {!isBalance && value > 0 && (
        <div className="ml-5">
          <PowerBar value={value} maxValue={panelMax} isLive={isLive} />
        </div>
      )}
    </Wrapper>
  );
}

// ── Panel card (collapsible) ──────────────────────────────────────────
interface PanelCardProps {
  panel: PanelDef;
  mainValue: number;
  mainCost: number;                   // estimated $ cost for this panel (non-live ranges)
  childValues: Map<string, number>;   // entityId → value (watts or kWh)
  childCosts: Map<string, number>;    // entityId → estimated $ cost (non-live ranges)
  houseTotal: number;
  isLive: boolean;
  circuitLookup: Map<string, CircuitData>;
  onCircuitClick: (c: CircuitData) => void;
  onHistoryClick: (p: PanelDef) => void;
}

function PanelCard({ panel, mainValue, mainCost, childValues, childCosts, houseTotal, isLive, circuitLookup, onCircuitClick, onHistoryClick }: PanelCardProps) {
  const [collapsed, setCollapsed] = useState(false);

  const childrenSum = panel.childEntityIds.reduce((s, id) => s + (childValues.get(id) ?? 0), 0);
  const balance = Math.max(0, mainValue - childrenSum);
  const housePct = houseTotal > 0 ? (mainValue / houseTotal) * 100 : 0;

  const sortedChildren = [...panel.childEntityIds]
    .map(id => ({ id, value: childValues.get(id) ?? 0 }))
    .sort((a, b) => b.value - a.value);

  return (
    <div className={cn('rounded-xl border p-3 space-y-0', panel.borderColor, panel.bgColor)}>
      {/* Panel header */}
      <div className="flex items-center gap-2 pb-2 border-b border-border/30 mb-1">
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          className="flex-1 text-left flex items-center gap-2 min-w-0"
          data-testid={`panel-header-${panel.id}`}
        >
          {collapsed
            ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
          <span className="font-semibold text-sm flex-1 truncate">{panel.label}</span>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {houseTotal > 0 ? `${housePct.toFixed(0)}% of house` : ''}
          </span>
          <span className="ml-2 text-right leading-tight">
            <span className={cn('block text-sm font-mono font-bold tabular-nums', panel.color)}>
              {isLive ? formatWatts(mainValue) : mainValue > 0 ? `${mainValue.toFixed(2)} kWh` : '—'}
            </span>
            {!isLive && mainCost > 0 && (
              <span
                className="block text-[10px] font-mono font-medium tabular-nums text-muted-foreground"
                data-testid={`panel-cost-${panel.id}`}
              >
                ${mainCost.toFixed(2)}
              </span>
            )}
          </span>
        </button>
        <button
          type="button"
          onClick={() => onHistoryClick(panel)}
          className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          title="Hourly history"
          aria-label={`${panel.label} hourly history`}
          data-testid={`button-panel-history-${panel.id}`}
        >
          <BarChart3 className="h-4 w-4" />
        </button>
      </div>

      {/* Child circuits */}
      {!collapsed && (
        <div className="divide-y divide-border/20 pt-1">
          {sortedChildren.map(({ id, value }) => {
            const circuit = circuitLookup.get(id);
            const label = panel.childLabelMap?.[id] ?? circuit?.label ?? id.replace('sensor.', '').replace(/_power_minute_average/g, '').replace(/_/g, ' ');
            const pct = mainValue > 0 ? (value / mainValue) * 100 : 0;
            return (
              <PanelCircuitRow
                key={id}
                label={label}
                value={value}
                cost={childCosts.get(id) ?? 0}
                pct={pct}
                panelMax={mainValue}
                isLive={isLive}
                onClick={circuit ? () => onCircuitClick(circuit) : undefined}
              />
            );
          })}

          {/* Balance row */}
          <PanelCircuitRow
            label="Balance (unmonitored)"
            value={balance}
            pct={mainValue > 0 ? (balance / mainValue) * 100 : 0}
            panelMax={mainValue}
            isLive={isLive}
            isBalance={true}
          />
        </div>
      )}
    </div>
  );
}

// ── Top circuits by cost (house-wide, non-live ranges) ───────────────
interface TopCircuitEntry {
  entityId: string;      // power entity id of the circuit
  label: string;
  panelLabel: string;
  kwh: number;
  cost: number;
}

function TopCircuitsList({ entries, rangeLabel, circuitLookup, onCircuitClick }: {
  entries: TopCircuitEntry[];
  rangeLabel: string;
  circuitLookup: Map<string, CircuitData>;
  onCircuitClick: (c: CircuitData) => void;
}) {
  if (entries.length === 0) return null;
  const maxCost = entries[0].cost;

  return (
    <div className="rounded-xl border border-amber-500/40 bg-amber-500/8 p-3 space-y-0" data-testid="top-circuits-card">
      <div className="flex items-center gap-2 pb-2 border-b border-border/30 mb-1">
        <BarChart3 className="h-4 w-4 text-amber-400 shrink-0" />
        <span className="font-semibold text-sm flex-1 truncate">Top Circuits by Cost</span>
        <span className="text-[10px] text-muted-foreground">{rangeLabel} · all panels</span>
      </div>
      <div className="divide-y divide-border/20 pt-1">
        {entries.map((entry, i) => {
          const circuit = circuitLookup.get(entry.entityId);
          const Wrapper = circuit ? 'button' : 'div';
          return (
            <Wrapper
              key={entry.entityId}
              type={circuit ? 'button' : undefined}
              onClick={circuit ? () => onCircuitClick(circuit) : undefined}
              className={cn(
                'w-full text-left py-2 space-y-1 px-2 -mx-2 rounded-md transition-colors',
                circuit ? 'hover:bg-muted/20 cursor-pointer' : 'cursor-default',
              )}
              data-testid={`top-circuit-row-${i}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold text-amber-400/80 tabular-nums w-4 shrink-0 text-center">
                  {i + 1}
                </span>
                <span className="text-sm truncate">{entry.label}</span>
                <span className="text-[10px] text-muted-foreground/60 truncate flex-1">
                  {entry.panelLabel}
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums whitespace-nowrap shrink-0">
                  {entry.kwh.toFixed(2)} kWh
                </span>
                <span className="text-sm font-mono font-semibold tabular-nums text-amber-400 min-w-[3.5rem] text-right shrink-0">
                  ${entry.cost.toFixed(2)}
                </span>
              </div>
              <div className="ml-6 h-1.5 rounded-full bg-muted/40 overflow-hidden">
                <div
                  className="h-full rounded-full bg-amber-500/70 transition-all duration-700"
                  style={{ width: `${maxCost > 0 ? Math.min((entry.cost / maxCost) * 100, 100) : 0}%` }}
                />
              </div>
            </Wrapper>
          );
        })}
      </div>
    </div>
  );
}

// ── Time range selector ───────────────────────────────────────────────
const TIME_RANGES: { id: TimeRange; label: string }[] = [
  { id: 'live',  label: 'Live' },
  { id: 'hour',  label: 'Hr' },
  { id: 'today', label: 'Day' },
  { id: 'week',  label: 'Wk' },
  { id: 'month', label: 'Mo' },
  { id: 'year',  label: 'Yr' },
];

function TimeRangeSelector({ value, onChange }: { value: TimeRange; onChange: (v: TimeRange) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-muted/30 rounded-lg p-0.5 border border-border/40">
      {TIME_RANGES.map(r => (
        <button
          key={r.id}
          type="button"
          onClick={() => onChange(r.id)}
          className={cn(
            'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
            value === r.id
              ? 'bg-background border border-border/60 shadow-sm text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid={`time-range-${r.id}`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// ── Breakdown response types ──────────────────────────────────────────
interface TodayBreakdown {
  circuits: Array<{ entityId: string; kwh: number; estimatedCost: number }>;
  currentRate: number;
}

// ── Main card ─────────────────────────────────────────────────────────
export function EmporiaEnergyCard() {
  const { entities, loading } = useHAEntities('sensor');
  const [viewMode, setViewMode] = useState<ViewMode>('panel');
  const [timeRange, setTimeRange] = useState<TimeRange>('live');
  const [search, setSearch] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('watts');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<CircuitData | null>(null);
  const [historyPanel, setHistoryPanel] = useState<PanelHistoryTarget | null>(null);

  // Per-circuit today kWh + $ from the breakdown endpoint (keyed by energy entity id).
  const { data: todayData } = useQuery({
    queryKey: ['energy-breakdown-today'],
    queryFn: () => apiClient.get<TodayBreakdown>('/api/electricity/breakdown?range=today', { timeoutMs: 30000 }),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
  });

  const { data: hourData } = useQuery({
    queryKey: ['energy-breakdown-hour'],
    queryFn: () => apiClient.get<TodayBreakdown>('/api/electricity/breakdown?range=hour', { timeoutMs: 30000 }),
    refetchInterval: 5 * 60 * 1000,
    staleTime: 2 * 60 * 1000,
    enabled: timeRange === 'hour' && viewMode === 'panel',
  });

  const { data: weekData } = useQuery({
    queryKey: ['energy-breakdown-week'],
    queryFn: () => apiClient.get<TodayBreakdown>('/api/electricity/breakdown?range=week', { timeoutMs: 30000 }),
    refetchInterval: 10 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    enabled: timeRange === 'week' && viewMode === 'panel',
  });

  const { data: monthData } = useQuery({
    queryKey: ['energy-breakdown-month'],
    queryFn: () => apiClient.get<TodayBreakdown>('/api/electricity/breakdown?range=month', { timeoutMs: 30000 }),
    refetchInterval: 10 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    enabled: timeRange === 'month' && viewMode === 'panel',
  });

  const { data: cycleData } = useQuery({
    queryKey: ['energy-breakdown-cycle'],
    queryFn: () => apiClient.get<TodayBreakdown>('/api/electricity/breakdown?range=cycle', { timeoutMs: 30000 }),
    refetchInterval: 10 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    enabled: timeRange === 'cycle' && viewMode === 'panel',
  });

  const { data: yearData } = useQuery({
    queryKey: ['energy-breakdown-year'],
    queryFn: () => apiClient.get<TodayBreakdown>('/api/electricity/breakdown?range=year', { timeoutMs: 30000 }),
    refetchInterval: 30 * 60 * 1000,
    staleTime: 15 * 60 * 1000,
    enabled: timeRange === 'year' && viewMode === 'panel',
  });

  const todayByEntity = useMemo(() => {
    const m = new Map<string, { kwh: number; cost: number }>();
    for (const c of todayData?.circuits ?? []) m.set(c.entityId, { kwh: c.kwh, cost: c.estimatedCost });
    return m;
  }, [todayData]);

  const circuitData: CircuitData[] = useMemo(() => {
    return CIRCUITS.map(cfg => {
      const entity = entities.find(e => e.entity_id === cfg.entityId);
      const raw = entity ? parseFloat(entity.state) : NaN;
      const watts = isNaN(raw) || raw < 0 ? 0 : raw;
      const t = todayByEntity.get(cfg.energyEntityId);
      return {
        ...cfg,
        watts,
        available: !!entity && entity.state !== 'unavailable',
        todayKwh: t?.kwh ?? 0,
        todayCost: t?.cost ?? 0,
      };
    });
  }, [entities, todayByEntity]);

  // Lookup map: power entity ID → CircuitData
  const circuitByPowerId = useMemo(() => {
    const m = new Map<string, CircuitData>();
    for (const c of circuitData) m.set(c.entityId, c);
    return m;
  }, [circuitData]);

  // Live house total = sum of 5 panel mains only (no double-counting)
  const liveTotalWatts = useMemo(() => {
    return PANEL_CATALOG.reduce((sum, p) => {
      const c = circuitByPowerId.get(p.mainEntityId);
      return sum + (c?.watts ?? 0);
    }, 0);
  }, [circuitByPowerId]);

  // For non-live panel view: build kWh lookup from the appropriate breakdown dataset
  const kwhByEnergyId = useMemo(() => {
    let source: TodayBreakdown | undefined;
    if (timeRange === 'hour')       source = hourData;
    else if (timeRange === 'today') source = todayData;
    else if (timeRange === 'week')  source = weekData;
    else if (timeRange === 'month') source = monthData;
    else if (timeRange === 'cycle') source = cycleData;
    else if (timeRange === 'year')  source = yearData;
    const m = new Map<string, number>();
    for (const c of source?.circuits ?? []) m.set(c.entityId, c.kwh);
    return m;
  }, [timeRange, hourData, todayData, weekData, monthData, cycleData, yearData]);

  // Per-circuit estimated $ cost (keyed by energy entity id) from the same
  // breakdown source — used for the per-panel cost label in non-live ranges.
  const costByEnergyId = useMemo(() => {
    let source: TodayBreakdown | undefined;
    if (timeRange === 'hour')       source = hourData;
    else if (timeRange === 'today') source = todayData;
    else if (timeRange === 'week')  source = weekData;
    else if (timeRange === 'month') source = monthData;
    else if (timeRange === 'cycle') source = cycleData;
    else if (timeRange === 'year')  source = yearData;
    const m = new Map<string, number>();
    for (const c of source?.circuits ?? []) m.set(c.entityId, c.estimatedCost);
    return m;
  }, [timeRange, hourData, todayData, weekData, monthData, cycleData, yearData]);

  // Build panel value maps for the panel control view
  const panelData = useMemo(() => {
    const isLive = timeRange === 'live';
    return PANEL_CATALOG.map(panel => {
      const mainValue = isLive
        ? (circuitByPowerId.get(panel.mainEntityId)?.watts ?? 0)
        : (kwhByEnergyId.get(energyIdFor(panel.mainEntityId)) ?? 0);

      // Panel cost = the panel main's estimatedCost (the main includes its
      // children by definition, so this represents the whole panel).
      const mainCost = isLive ? 0 : (costByEnergyId.get(energyIdFor(panel.mainEntityId)) ?? 0);

      const childValues = new Map<string, number>();
      const childCosts = new Map<string, number>();
      for (const childId of panel.childEntityIds) {
        const val = isLive
          ? (circuitByPowerId.get(childId)?.watts ?? 0)
          : (kwhByEnergyId.get(energyIdFor(childId)) ?? 0);
        childValues.set(childId, val);
        childCosts.set(childId, isLive ? 0 : (costByEnergyId.get(energyIdFor(childId)) ?? 0));
      }

      return { panel, mainValue, mainCost, childValues, childCosts };
    });
  }, [timeRange, circuitByPowerId, kwhByEnergyId, costByEnergyId]);

  const houseTotalValue = useMemo(() => {
    return panelData.reduce((s, d) => s + d.mainValue, 0);
  }, [panelData]);

  const houseTotalCost = useMemo(() => {
    return panelData.reduce((s, d) => s + d.mainCost, 0);
  }, [panelData]);

  // House-wide "Top circuits by cost" ranking across ALL panels (non-live ranges).
  // Ranks only individual child circuits (never panel mains, which include their
  // children by definition and would dominate the list).
  const topCircuits = useMemo<TopCircuitEntry[]>(() => {
    if (timeRange === 'live') return [];
    const entries: TopCircuitEntry[] = [];
    for (const panel of PANEL_CATALOG) {
      for (const childId of panel.childEntityIds) {
        const energyId = energyIdFor(childId);
        const cost = costByEnergyId.get(energyId) ?? 0;
        if (cost <= 0) continue;
        const label = panel.childLabelMap?.[childId]
          ?? circuitByPowerId.get(childId)?.label
          ?? childId.replace('sensor.', '').replace(/_power_minute_average/g, '').replace(/_/g, ' ');
        entries.push({
          entityId: childId,
          label,
          panelLabel: panel.label,
          kwh: kwhByEnergyId.get(energyId) ?? 0,
          cost,
        });
      }
    }
    return entries.sort((a, b) => b.cost - a.cost).slice(0, 8);
  }, [timeRange, costByEnergyId, kwhByEnergyId, circuitByPowerId]);

  // Circuit view stats
  const activeCircuits = useMemo(() => circuitData.filter(c => c.watts > 10).length, [circuitData]);
  const maxValue = useMemo(() => Math.max(...circuitData.map(c => c.watts), 100), [circuitData]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return circuitData;
    return circuitData.filter(c => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  }, [circuitData, search]);

  const grouped = useMemo(() => {
    if (sortMode !== 'category') return null;
    return CATEGORY_ORDER
      .map(cat => ({ category: cat, circuits: filtered.filter(c => c.category === cat).sort((a, b) => b.watts - a.watts) }))
      .filter(g => g.circuits.length > 0);
  }, [filtered, sortMode]);

  const flatSorted = useMemo(() => {
    if (sortMode === 'category') return [];
    const arr = [...filtered];
    if (sortMode === 'watts') arr.sort((a, b) => b.watts - a.watts);
    else arr.sort((a, b) => a.label.localeCompare(b.label));
    return arr;
  }, [filtered, sortMode]);

  function cycleSortMode() {
    setSortMode(m => (m === 'watts' ? 'name' : m === 'name' ? 'category' : 'watts'));
  }
  const sortLabel = sortMode === 'watts' ? 'Watts' : sortMode === 'name' ? 'Name' : 'Category';

  const statusText = loading
    ? 'Loading…'
    : viewMode === 'panel'
      ? `${PANEL_CATALOG.length} panels · ${formatWatts(liveTotalWatts)} live`
      : `${activeCircuits} active circuits · ${formatWatts(liveTotalWatts)} total`;

  const isLive = timeRange === 'live';

  return (
    <>
      <SystemCard
        title="Electrical Monitoring"
        icon={<Zap className="h-6 w-6 text-yellow-400" />}
        status={loading ? 'idle' : 'online'}
        statusText={statusText}
        accentColor="bg-yellow-500/10"
        defaultExpanded={true}
        metrics={[
          { label: 'Live Load', value: loading ? '…' : formatWatts(liveTotalWatts) },
          { label: 'Panels', value: loading ? '…' : String(PANEL_CATALOG.length) },
          { label: 'Circuits', value: loading ? '…' : String(circuitData.length) },
        ]}
      >
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            {/* Live load gauge — always visible */}
            <TotalPowerGauge totalWatts={liveTotalWatts} />

            {/* View mode toggle + time range */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-0.5 bg-muted/30 rounded-lg p-0.5 border border-border/40">
                <button
                  type="button"
                  onClick={() => setViewMode('panel')}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                    viewMode === 'panel'
                      ? 'bg-background border border-border/60 shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  data-testid="view-mode-panel"
                >
                  <LayoutGrid className="h-3 w-3" /> Panel Control
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('circuit')}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                    viewMode === 'circuit'
                      ? 'bg-background border border-border/60 shadow-sm text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  data-testid="view-mode-circuit"
                >
                  <List className="h-3 w-3" /> All Circuits
                </button>
              </div>

              {viewMode === 'panel' && (
                <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
              )}
            </div>

            {/* ── Panel Control View ──────────────────────────────── */}
            {viewMode === 'panel' && (
              <div className="space-y-3">
                {/* House-level total header */}
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    {isLive ? 'Live power by panel' : `${TIME_RANGES.find(r => r.id === timeRange)?.label} kWh by panel`}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-right leading-tight">
                      <span className={cn('block text-sm font-bold tabular-nums', isLive ? getWattageColor(houseTotalValue) : 'text-amber-400')}>
                        {isLive ? formatWatts(houseTotalValue) : houseTotalValue > 0 ? `${houseTotalValue.toFixed(1)} kWh` : '—'}
                      </span>
                      {!isLive && houseTotalCost > 0 && (
                        <span className="block text-[10px] font-medium tabular-nums text-muted-foreground" data-testid="panel-cost-house">
                          ${houseTotalCost.toFixed(2)} est.
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => setHistoryPanel({
                        energyEntityIds: PANEL_CATALOG.map(p => energyIdFor(p.mainEntityId)),
                        label: 'Whole House',
                        color: 'text-amber-400',
                        breakdown: PANEL_CATALOG.map(p => ({
                          energyEntityId: energyIdFor(p.mainEntityId),
                          label: p.label,
                          color: p.color,
                        })),
                      })}
                      className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
                      title="Whole-house hourly history"
                      aria-label="Whole-house hourly history"
                      data-testid="button-house-history"
                    >
                      <BarChart3 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Top circuits by cost — house-wide, non-live ranges only */}
                {!isLive && (
                  <TopCircuitsList
                    entries={topCircuits}
                    rangeLabel={TIME_RANGES.find(r => r.id === timeRange)?.label ?? ''}
                    circuitLookup={circuitByPowerId}
                    onCircuitClick={setSelected}
                  />
                )}

                {panelData.map(({ panel, mainValue, mainCost, childValues, childCosts }) => (
                  <PanelCard
                    key={panel.id}
                    panel={panel}
                    mainValue={mainValue}
                    mainCost={mainCost}
                    childValues={childValues}
                    childCosts={childCosts}
                    houseTotal={houseTotalValue}
                    isLive={isLive}
                    circuitLookup={circuitByPowerId}
                    onCircuitClick={setSelected}
                    onHistoryClick={(p) => setHistoryPanel({
                      energyEntityIds: [energyIdFor(p.mainEntityId)],
                      label: p.label,
                      color: p.color,
                    })}
                  />
                ))}

                <p className="text-[10px] text-muted-foreground/50 text-center pt-1">
                  Emporia Vue 3 · Balance = panel main − measured circuits · tap a circuit for history · chart icon for hourly history
                </p>
              </div>
            )}

            {/* ── Circuit Monitor View ────────────────────────────── */}
            {viewMode === 'circuit' && (
              <>
                {/* Search + sort toolbar */}
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search circuits…"
                      className="pl-8 h-9 text-sm bg-muted/20"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={cycleSortMode}
                    className="flex items-center gap-1.5 h-9 px-3 rounded-md border border-border/60 bg-muted/20 text-xs font-medium hover:bg-muted/40 transition-colors shrink-0"
                  >
                    <ArrowDownUp className="h-3.5 w-3.5 text-muted-foreground" />
                    {sortLabel}
                  </button>
                </div>

                {filtered.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No circuits match "{search}".</p>
                ) : grouped ? (
                  <div className="space-y-4">
                    {grouped.map(g => (
                      <CategorySection
                        key={g.category}
                        category={g.category}
                        circuits={g.circuits}
                        maxValue={maxValue}
                        collapsed={!!collapsed[g.category]}
                        onToggle={() => setCollapsed(c => ({ ...c, [g.category]: !c[g.category] }))}
                        onSelect={setSelected}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="divide-y divide-border/30">
                    {flatSorted.map(c => (
                      <CircuitRow key={c.entityId} circuit={c} maxValue={maxValue} onClick={() => setSelected(c)} />
                    ))}
                  </div>
                )}

                <p className="text-[10px] text-muted-foreground/50 text-center pt-1">
                  Emporia Vue 3 · {CIRCUITS.length} circuits · updates every ~60s · tap a circuit for history
                </p>
              </>
            )}
          </div>
        )}
      </SystemCard>

      <CircuitDetailDrawer
        open={!!selected}
        onClose={() => setSelected(null)}
        circuit={selected}
        marginalRate={todayData?.currentRate}
      />

      <PanelHistoryDrawer
        open={!!historyPanel}
        onClose={() => setHistoryPanel(null)}
        panel={historyPanel}
      />
    </>
  );
}
