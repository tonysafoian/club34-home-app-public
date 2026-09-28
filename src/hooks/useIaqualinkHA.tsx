import { useMemo } from 'react';
import { HAEntity } from '@/lib/api/homeAssistant';
import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';

const ENTITY_IDS = {
  poolTemp: 'sensor.pool_temp',
  spaTemp: 'sensor.spa_temp',
  airTemp: 'sensor.air_temp',
  poolClimate: 'climate.pool',
  spaClimate: 'climate.spa',
  poolLight: 'light.pool_light',
  spaLight: 'light.spa_light',
  laminarLed: 'light.laminar_led_lt',
  poolPump: 'switch.pool_pump',
  spaPump: 'switch.spa_pump',
  boosterPump: 'switch.booster_pump',
  poolHeater: 'switch.pool_heater',
  spaHeater: 'switch.spa_heater',
  solarHeater: 'switch.solar_heater',
  laminarJets: 'switch.laminar_jets',
  bubbler: 'switch.bubbler',
  freezeProtection: 'binary_sensor.freeze_protection',
} as const;

const ALL_IDS = new Set<string>(Object.values(ENTITY_IDS));

export const LIGHT_EFFECTS = [
  'Alpine White', 'Sky Blue', 'Cobalt Blue', 'Caribbean Blue',
  'Spring Green', 'Emerald Green', 'Emerald Rose', 'Magenta',
  'Violet', 'Slow Splash', 'Fast Splash', 'USA!', 'Fat Tuesday', 'Disco Tech',
];

function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

function fahrenheitToCelsius(f: number): number {
  return Math.round(((f - 32) * 5) / 9);
}

function isCelsius(unit: string | undefined | null): boolean {
  if (!unit) return false;
  const normalized = unit.trim().toLowerCase();
  return normalized === '°c' || normalized === 'c' || normalized === 'celsius';
}

function getTempInFahrenheit(entity: HAEntity | undefined): string | null {
  if (!entity) return null;
  const raw = entity.state;
  if (!raw || raw === 'unknown' || raw === 'unavailable') return null;
  const num = parseFloat(raw);
  if (isNaN(num)) return null;
  const unit = (entity.attributes?.unit_of_measurement ?? '').toString().trim().toLowerCase();
  if ((unit === '°f' || unit === 'f') && num > 150) {
    return String(Math.round((num - 32) * 5 / 9));
  }
  if (unit === '°c' || unit === 'c') {
    return String(celsiusToFahrenheit(num));
  }
  return String(Math.round(num));
}

function getSetPointInFahrenheit(entity: HAEntity | undefined): string | null {
  if (!entity) return null;
  const temp = entity.attributes?.temperature;
  if (temp == null) return null;
  const num = typeof temp === 'number' ? temp : parseFloat(String(temp));
  if (isNaN(num)) return null;
  const unit = (entity.attributes?.temperature_unit ?? entity.attributes?.unit_of_measurement ?? '').toString().trim().toLowerCase();
  if ((unit === '°f' || unit === 'f') && num > 150) {
    return String(Math.round((num - 32) * 5 / 9));
  }
  if (unit === '°c' || unit === 'c') {
    return String(celsiusToFahrenheit(num));
  }
  return String(Math.round(num));
}

function getClimateUnit(entity: HAEntity | undefined): string {
  if (!entity) return '°F';
  const unit = entity.attributes?.temperature_unit as string | undefined;
  const unitOfMeasurement = entity.attributes?.unit_of_measurement as string | undefined;
  return unit || unitOfMeasurement || '°F';
}

export interface IaqualinkHA {
  loading: boolean;
  connected: boolean;
  entities: Map<string, HAEntity>;
  temperatures: {
    pool: string | null;
    spa: string | null;
    air: string | null;
    poolSetPoint: string | null;
    spaSetPoint: string | null;
  };
  climateUnits: {
    pool: string;
    spa: string;
  };
  freezeProtection: boolean;
  refetch: (silent?: boolean) => Promise<void>;
}

export function useIaqualinkHA(_refreshInterval = 30000): IaqualinkHA {
  const { allEntities, loading, refetch } = useSharedHAAllEntities();

  const entities = useMemo(() => {
    const map = new Map<string, HAEntity>();
    for (const e of allEntities) {
      if (ALL_IDS.has(e.entity_id)) {
        map.set(e.entity_id, e);
      }
    }
    return map;
  }, [allEntities]);

  const connected = !loading && entities.size > 0;

  const temperatures = useMemo(() => ({
    pool: getTempInFahrenheit(entities.get(ENTITY_IDS.poolTemp)),
    spa: getTempInFahrenheit(entities.get(ENTITY_IDS.spaTemp)),
    air: getTempInFahrenheit(entities.get(ENTITY_IDS.airTemp)),
    poolSetPoint: getSetPointInFahrenheit(entities.get(ENTITY_IDS.poolClimate)),
    spaSetPoint: getSetPointInFahrenheit(entities.get(ENTITY_IDS.spaClimate)),
  }), [entities]);

  const climateUnits = useMemo(() => ({
    pool: getClimateUnit(entities.get(ENTITY_IDS.poolClimate)),
    spa: getClimateUnit(entities.get(ENTITY_IDS.spaClimate)),
  }), [entities]);

  const freezeProtection = entities.get(ENTITY_IDS.freezeProtection)?.state === 'on';

  return {
    loading,
    connected,
    entities,
    temperatures,
    climateUnits,
    freezeProtection,
    refetch,
  };
}

export { celsiusToFahrenheit, fahrenheitToCelsius, isCelsius };
