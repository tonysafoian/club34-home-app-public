import type { ConnectedDevice } from './types';

// Canonical list of device categories recognised by the classifier, shared by
// the Devices tab edit popover and the Traffic tab inline category picker.
export const DEVICE_CATEGORIES = [
  'Network Infrastructure',
  'Security Cameras',
  'Smart TVs & Streaming',
  'Smart Speakers',
  'Thermostats',
  'Lighting & Switches',
  'AV Systems',
  'Printers',
  'Gaming Consoles',
  'Virtual Machines',
  'Cars',
  'Computers & Laptops',
  'Mobile Phones & Tablets',
  'People / Personal Devices',
  'Electricity Monitoring',
  'IoT Devices',
  'Smart Gate Devices',
  'Smart Sprinklers',
  'Primary Systems',
  'Unknown / Uncategorized',
];

const PERSONAL_DEVICES_CATEGORY = 'People / Personal Devices';
const UNKNOWN_CATEGORY = 'Unknown / Uncategorized';

// Resolve the category the edit popover should pre-fill. For randomized-MAC
// devices, anchor to "People / Personal Devices" unless a meaningful category is
// already set (override or classifier match). This ensures saving a rename always
// persists the category so the device doesn't bounce back to "Unknown" when the
// classifier re-runs.
export function resolveInitialCategory(
  device: Pick<ConnectedDevice, 'is_random' | 'category'>,
): string {
  if (device.is_random) {
    return device.category && device.category !== UNKNOWN_CATEGORY
      ? device.category
      : PERSONAL_DEVICES_CATEGORY;
  }
  return device.category || '';
}

// Resolve the category persisted on save. Always anchor a category for
// randomized-MAC devices so the override survives a classifier re-run and the
// device never bounces back to "Unknown".
export function resolveCategoryToSave(
  categoryValue: string,
  device: Pick<ConnectedDevice, 'is_random'>,
): string | null {
  return categoryValue || (device.is_random ? PERSONAL_DEVICES_CATEGORY : null);
}
