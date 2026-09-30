/**
 * Name Sanitizer & Aliasing System
 * 
 * Ensures all entity, room, and system display names are generic, clean,
 * and free of hardcoded personal names. Supports user-defined overrides.
 */

const KNOWN_NAME_MAPPINGS: Record<string, string> = {
  "emme's room": "Bedroom 1",
  "emme room": "Bedroom 1",
  "emmes room": "Bedroom 1",
  "enzo's room": "Bedroom 2",
  "enzo room": "Bedroom 2",
  "enzos room": "Bedroom 2",
  "isla's room": "Bedroom 3",
  "isla room": "Bedroom 3",
  "islas room": "Bedroom 3",
  "emme's sconces": "Bedroom 1 Sconces",
  "emme's hall recessed": "Upstairs Hall Recessed",
  "emme's hall": "Upstairs Hall",
  "lana's bench": "Primary Bench 1",
  "tony's bench": "Primary Bench 2",
  "lana's car charger": "EV Charger 2",
  "tony's office": "Main Office",
};

/**
 * Sanitizes entity and device display names by replacing hardcoded personal names
 * with generic, professional estate terms.
 */
export function sanitizeDeviceName(rawName: string): string {
  if (!rawName) return '';
  const trimmed = rawName.trim();
  const lower = trimmed.toLowerCase();

  // Check direct exact mapping
  if (KNOWN_NAME_MAPPINGS[lower]) {
    return KNOWN_NAME_MAPPINGS[lower];
  }

  // Check prefix or substring matches
  let sanitized = trimmed;

  // Replace specific phrases
  sanitized = sanitized
    .replace(/\bEmme['’]s Room\b/gi, 'Bedroom 1')
    .replace(/\bEnzo['’]s Room\b/gi, 'Bedroom 2')
    .replace(/\bIsla['’]s Room\b/gi, 'Bedroom 3')
    .replace(/\bEmme['’]s\b/gi, 'Bedroom 1')
    .replace(/\bEnzo['’]s\b/gi, 'Bedroom 2')
    .replace(/\bIsla['’]s\b/gi, 'Bedroom 3')
    .replace(/\bLana['’]s\b/gi, 'Primary')
    .replace(/\bTony['’]s\b/gi, 'Executive')
    .replace(/\bEmme\b/gi, 'Bedroom 1')
    .replace(/\bEnzo\b/gi, 'Bedroom 2')
    .replace(/\bIsla\b/gi, 'Bedroom 3')
    .replace(/\bLana\b/gi, 'Primary')
    .replace(/\bTony\b/gi, 'Primary');

  // Clean up any double spaces
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}

/**
 * Sanitizes room group names for lights, thermostats, and sensors.
 */
export function sanitizeRoomName(room: string): string {
  if (!room) return 'Other';
  const lower = room.toLowerCase().trim();

  if (lower.includes('emme') || lower.includes('emmes')) return 'Bedroom 1';
  if (lower.includes('enzo') || lower.includes('enzos')) return 'Bedroom 2';
  if (lower.includes('isla') || lower.includes('islas')) return 'Bedroom 3';
  if (lower.includes('lana') || lower.includes('lanas')) return 'Primary Suite';

  return sanitizeDeviceName(room);
}
