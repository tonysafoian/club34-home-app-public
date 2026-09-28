// AV Closet temperature sensor — a Govee thermometer surfaced in Home Assistant
// as a `sensor.` (temperature) entity, NOT a `climate.` thermostat. These helpers
// keep the frontend (thermostats view) and backend (monitor + logger) matching the
// exact same entity and thresholds.

export const AV_CLOSET_WARN_TEMP = 90; // °F — email Tony, Sandra & Jesse above this
export const AV_CLOSET_CRITICAL_TEMP = 100; // °F — WhatsApp Tony above this

// Shared copy so the persistent AV Closet card reads the same on every page,
// whether the Govee H5103 sensor has been discovered in HA yet or not.
export const AV_CLOSET_PLACEHOLDER_TITLE = 'Not connected yet';
export const AV_CLOSET_PLACEHOLDER_DETAIL =
  'Waiting for the AV Closet sensor in Home Assistant. This card fills in automatically once the Govee H5103 is discovered.';
export const AV_CLOSET_THRESHOLD_NOTE =
  `Alerts: email above ${AV_CLOSET_WARN_TEMP}°F, WhatsApp above ${AV_CLOSET_CRITICAL_TEMP}°F.`;

export interface AvClosetCandidate {
  entity_id: string;
  state: string;
  attributes?: {
    friendly_name?: string;
    device_class?: string;
    unit_of_measurement?: string;
  } | null;
}

/** True when the entity looks like the AV Closet temperature sensor. */
export function isAvClosetTempSensor(
  entityId: string,
  friendlyName?: string | null,
  deviceClass?: string | null,
  unit?: string | null,
): boolean {
  if (!entityId.startsWith('sensor.')) return false;
  const isTemp = deviceClass === 'temperature' || unit === '°F' || unit === '°C';
  if (!isTemp) return false;
  const hay = `${entityId} ${friendlyName || ''}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  // Primary match: "AV Closet" in name/entity_id
  if (hay.includes('av closet') || (hay.includes('closet') && /\bav\b/.test(hay))) {
    return true;
  }
  // Secondary match: Govee H5103 model marker — catches generic HA names like
  // "Govee H5103 1A2B" before the user renames the device in HA.
  if (hay.includes('h5103')) {
    return true;
  }
  // Tertiary match: the AV Closet Govee currently surfaces in HA as the generic
  // "Wifi Thermometer" (entity_id sensor.wifi_thermometer_temperature). Match it
  // until the user renames the device in HA to something AV-Closet specific.
  if (hay.includes('wifi thermometer')) {
    return true;
  }
  return false;
}

/**
 * Find the AV Closet temperature sensor from a list of HA states. An optional
 * `preferredEntityId` (e.g. from an env override) takes precedence when present.
 */
export function findAvClosetTempSensor<T extends AvClosetCandidate>(
  states: T[],
  preferredEntityId?: string | null,
): T | undefined {
  if (preferredEntityId) {
    const exact = states.find(s => s.entity_id === preferredEntityId);
    if (exact) return exact;
  }
  return states.find(s => {
    if (s.state === 'unavailable' || s.state === 'unknown') return false;
    return isAvClosetTempSensor(
      s.entity_id,
      s.attributes?.friendly_name,
      s.attributes?.device_class,
      s.attributes?.unit_of_measurement,
    );
  });
}
