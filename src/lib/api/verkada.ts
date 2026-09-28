import { apiClient } from '@/lib/apiClient';

type VerkadaProxyResponse = { success: boolean; error?: string; [key: string]: unknown };

async function callVerkadaProxy(body: Record<string, unknown>): Promise<VerkadaProxyResponse> {
  return apiClient.invokeFn<VerkadaProxyResponse>('verkada-proxy', body);
}

export async function listCameras() {
  return callVerkadaProxy({ action: 'list-cameras' });
}

export async function getCameraThumbnail(cameraId: string) {
  return callVerkadaProxy({ action: 'camera-thumbnail', camera_id: cameraId });
}

export async function getCameraLivestreamThumbnail(cameraId: string) {
  return callVerkadaProxy({ action: 'camera-livestream-thumbnail', camera_id: cameraId });
}

export async function getCameraStreamLink(cameraId: string) {
  return callVerkadaProxy({ action: 'camera-stream-link', camera_id: cameraId });
}

export async function listDoors() {
  return callVerkadaProxy({ action: 'list-doors' });
}

export async function unlockDoor(doorId: string) {
  return callVerkadaProxy({ action: 'unlock-door', door_id: doorId });
}

export async function getAccessEvents(startTime?: string, endTime?: string, pageSize?: number) {
  return callVerkadaProxy({
    action: 'access-events',
    start_time: startTime,
    end_time: endTime,
    page_size: pageSize,
  });
}

export async function listAlarmSites() {
  return callVerkadaProxy({ action: 'list-alarms' });
}

export async function getPersonsOfInterest() {
  return callVerkadaProxy({ action: 'person-of-interest' });
}

export async function getPeopleCounts(cameraId: string, startTime?: string, endTime?: string) {
  return callVerkadaProxy({
    action: 'people-counts',
    camera_id: cameraId,
    start_time: startTime,
    end_time: endTime,
  });
}

export async function getActivitySummary(): Promise<ActivitySummary> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch('/api/verkada/activity-summary').then(r => r.json());
}

export async function getWebhookHealth(): Promise<WebhookHealth> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch('/api/verkada/webhook-health').then(r => r.json());
}

export async function getSightingHealth(): Promise<SightingHealth> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch('/api/verkada/sighting-health').then(r => r.json());
}

export async function getVehicleProfiles(): Promise<VehicleProfilesResponse> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch('/api/verkada/vehicle-profiles').then(r => r.json());
}

export async function createVehicleProfile(plate: string, label?: string): Promise<{ success: boolean; profile: VehicleProfile }> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch('/api/verkada/vehicle-profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plate, label }),
  }).then(r => r.json());
}

export async function updateVehicleProfile(id: string, label: string): Promise<{ success: boolean; profile: VehicleProfile }> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch(`/api/verkada/vehicle-profiles/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  }).then(r => r.json());
}

export async function deleteVehicleProfile(id: string): Promise<{ success: boolean }> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch(`/api/verkada/vehicle-profiles/${id}`, {
    method: 'DELETE',
  }).then(r => r.json());
}

export async function getVehicleSightings(): Promise<VehicleSightings> {
  const { apiClient } = await import('@/lib/apiClient');
  return apiClient.rawFetch('/api/verkada/vehicle-sightings').then(r => r.json());
}

export interface ActivitySummary {
  success: boolean;
  unique_people: number;
  unique_vehicles: number;
  sightings: number;
  total_events: number;
  total_cameras?: number;
  hourly: Array<{ hour: number; label: string; people: number; vehicles: number }>;
  per_camera: Array<{ camera_name: string; unique_people: number; unique_vehicles: number; total_events: number }>;
  peak_hour_count: number;
  busiest_hour: string;
  recent_sightings: Array<{ person_id: string; person_label: string; camera_name: string; occurred_at: string }>;
}

export interface WebhookHealth {
  success: boolean;
  last_event_at: string | null;
  last_webhook_at: string | null;
  minutes_since_last_event: number | null;
  is_daytime: boolean;
  is_healthy: boolean;
}

export interface SightingHealth {
  success: boolean;
  today_start: string;
  last_webhook_at: string | null;
  minutes_since_last_webhook: number | null;
  total_sightings_today: number;
  unique_people_today: number;
  total_cameras: number | null;
  by_person: Array<{
    verkada_person_id: string;
    label: string | null;
    sighting_count: number;
    first_seen: string;
    last_seen: string;
    cameras: string[];
  }>;
  all_time_by_person: Array<{
    person_key: string;
    label: string | null;
    all_time_last_seen: string;
  }>;
  by_camera: Array<{
    camera_name: string;
    sighting_count: number;
    unique_people: number;
  }>;
  recent_sightings: Array<{
    verkada_person_id: string;
    label: string | null;
    seen_at: string;
    camera_name: string | null;
  }>;
}

export interface VehicleProfile {
  id: string;
  plate: string;
  label: string | null;
  last_seen_at: string | null;
  last_seen_camera: string | null;
  created_at: string;
  updated_at: string;
}

export interface VehicleProfilesResponse {
  success: boolean;
  profiles: VehicleProfile[];
}

export interface VehicleSightings {
  success: boolean;
  unique_plates: number;
  total_sightings: number;
  cameras_with_lpr: number;
  by_plate: Array<{
    plate: string;
    sightings_today: number;
    last_seen_at: string;
    last_seen_camera: string | null;
    image_url: string | null;
  }>;
  recent_sightings: Array<{
    plate: string;
    camera_name: string | null;
    occurred_at: string;
    image_url: string | null;
  }>;
}

export interface VerkadaConnectionStatus {
  success: boolean;
  api_key_configured: boolean;
  org_id_configured: boolean;
  webhook_url: string | null;
  last_webhook_received_at: string | null;
  total_lpr_events: number;
  last_lpr_event_at: string | null;
  total_webhook_events: number;
  last_any_event_at: string | null;
}

export async function getConnectionStatus(): Promise<VerkadaConnectionStatus> {
  const { apiClient } = await import('@/lib/apiClient');
  const res = await apiClient.rawFetch('/api/verkada/connection-status');
  if (!res.ok) {
    throw new Error(`Connection status request failed: ${res.status}`);
  }
  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error || 'Connection status returned unsuccessful response');
  }
  return data as VerkadaConnectionStatus;
}
