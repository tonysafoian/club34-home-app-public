import { apiClient } from '@/lib/apiClient';

export class HAUnavailableError extends Error {
  constructor(reason = 'not_configured') {
    super(`Home Assistant unavailable: ${reason}`);
    this.name = 'HAUnavailableError';
  }
}

const HA_NOT_CONFIGURED_SENTINEL = 'ha_not_configured';

async function callProxy(body: Record<string, unknown>) {
  try {
    return await apiClient.post('/api/home-assistant', body);
  } catch (err) {
    if (
      err instanceof Error &&
      'status' in err &&
      (err as { status: number }).status === 503 &&
      err.message === HA_NOT_CONFIGURED_SENTINEL
    ) {
      throw new HAUnavailableError();
    }
    throw err;
  }
}

export interface HAConnectionResult {
  connected: boolean;
  data?: { version?: string };
}

export async function testHAConnection(): Promise<HAConnectionResult> {
  return callProxy({ action: 'test-connection' }) as Promise<HAConnectionResult>;
}

export async function getHAConfig() {
  return callProxy({ action: 'get-config' });
}

export async function getAllStates() {
  return callProxy({ action: 'get-states' });
}

export async function getAllStatesFromCache(): Promise<HAEntity[]> {
  const data = await apiClient.get('/api/home-assistant/states');
  return Array.isArray(data) ? data : [];
}

export async function getFilteredStates(entityIds: string[]) {
  if (!entityIds.length) return [];
  return callProxy({ action: 'get-states', entity_ids: entityIds });
}

export async function getEntityState(entity_id: string) {
  return callProxy({ action: 'get-state', entity_id });
}

export async function getDomainStates(domain: string) {
  return callProxy({ action: 'get-domain', domain });
}

export async function callService(domain: string, service: string, service_data?: Record<string, unknown>) {
  return callProxy({ action: 'call-service', domain, service, service_data });
}

export async function turnLightOn(entity_id: string, brightness?: number, color_temp?: number) {
  return callService('light', 'turn_on', {
    entity_id,
    ...(brightness !== undefined && { brightness }),
    ...(color_temp !== undefined && { color_temp }),
  });
}

export async function turnLightOff(entity_id: string) {
  return callService('light', 'turn_off', { entity_id });
}

export async function toggleLight(entity_id: string) {
  return callService('light', 'toggle', { entity_id });
}

export async function turnSwitchOn(entity_id: string) {
  return callService('switch', 'turn_on', { entity_id });
}

export async function turnSwitchOff(entity_id: string) {
  return callService('switch', 'turn_off', { entity_id });
}

export async function toggleSwitch(entity_id: string) {
  return callService('switch', 'toggle', { entity_id });
}

export async function setClimateTemp(entity_id: string, temperature: number) {
  return callService('climate', 'set_temperature', { entity_id, temperature });
}

export async function setClimateMode(entity_id: string, hvac_mode: string) {
  return callService('climate', 'set_hvac_mode', { entity_id, hvac_mode });
}

export async function openCover(entity_id: string) {
  return callService('cover', 'open_cover', { entity_id });
}

export async function closeCover(entity_id: string) {
  return callService('cover', 'close_cover', { entity_id });
}

export async function setCoverPosition(entity_id: string, position: number) {
  return callService('cover', 'set_cover_position', { entity_id, position });
}

export async function alarmArmAway(entity_id: string, code?: string) {
  return callService('alarm_control_panel', 'alarm_arm_away', { entity_id, ...(code && { code }) });
}

export async function alarmArmHome(entity_id: string, code?: string) {
  return callService('alarm_control_panel', 'alarm_arm_home', { entity_id, ...(code && { code }) });
}

export async function alarmArmNight(entity_id: string, code?: string) {
  return callService('alarm_control_panel', 'alarm_arm_night', { entity_id, ...(code && { code }) });
}

export async function alarmDisarm(entity_id: string, code?: string) {
  return callService('alarm_control_panel', 'alarm_disarm', { entity_id, ...(code && { code }) });
}

export async function lockLock(entity_id: string) {
  return callService('lock', 'lock', { entity_id });
}

export async function lockUnlock(entity_id: string) {
  return callService('lock', 'unlock', { entity_id });
}

export async function activateScene(entity_id: string) {
  return callService('scene', 'turn_on', { entity_id });
}

export async function triggerAutomation(entity_id: string) {
  return callService('automation', 'trigger', { entity_id });
}

export async function getEntityHistory(entity_id?: string, hours = 24) {
  return callProxy({ action: 'get-history', entity_id, hours });
}

export async function getLogbook(hours = 24, entity_id?: string) {
  return callProxy({ action: 'get-logbook', hours, entity_id });
}

export async function haProxy(path: string, method = 'GET', payload?: unknown) {
  return callProxy({ action: 'proxy', path, method, payload });
}

export async function getGoveeEntityIds(): Promise<string[]> {
  try {
    const data = await apiClient.get('/api/home-assistant/govee-ids');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export interface HAEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HALogbookEntry {
  entity_id: string;
  name: string;
  message: string;
  when: string;
  domain: string;
}

export async function broadcastAll(message: string, volume?: number) {
  return callProxy({ action: 'broadcast-all', message, ...(volume !== undefined && { volume }) });
}

export async function broadcastBedrooms(message: string, volume?: number) {
  return callProxy({ action: 'broadcast-bedrooms', message, ...(volume !== undefined && { volume }) });
}

export const broadcastGirls = broadcastBedrooms;

export async function broadcastGoogleHome(message: string, volume?: number) {
  return callProxy({ action: 'broadcast-google-home', message, ...(volume !== undefined && { volume }) });
}
