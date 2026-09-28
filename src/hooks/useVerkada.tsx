import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listCameras,
  getCameraThumbnail,
  getCameraLivestreamThumbnail,
  getCameraStreamLink,
  listDoors,
  unlockDoor,
  getAccessEvents,
  listAlarmSites,
  getPersonsOfInterest,
  getPeopleCounts,
  getActivitySummary,
  getWebhookHealth,
  getSightingHealth,
  getVehicleProfiles,
  getVehicleSightings,
  createVehicleProfile,
  updateVehicleProfile,
  deleteVehicleProfile,
  getConnectionStatus,
} from '@/lib/api/verkada';
import type { ActivitySummary, WebhookHealth, SightingHealth, VehicleProfilesResponse, VehicleSightings, VerkadaConnectionStatus } from '@/lib/api/verkada';
import { toast } from '@/hooks/use-toast';

export function useVerkadaCameras() {
  return useQuery({
    queryKey: ['verkada-cameras'],
    queryFn: async () => {
      const result = await listCameras();
      if (!result.success) throw new Error(result.error);
      return result.cameras as VerkadaCamera[];
    },
    staleTime: 5 * 60_000, // 5 min — camera list rarely changes
  });
}

export function useVerkadaThumbnail(cameraId: string | null) {
  return useQuery({
    queryKey: ['verkada-thumbnail', cameraId],
    queryFn: async () => {
      if (!cameraId) return null;
      const result = await getCameraThumbnail(cameraId);
      if (!result.success) throw new Error(result.error);
      return result.thumbnail as string;
    },
    enabled: !!cameraId,
    staleTime: 2 * 60 * 1000, // refresh every 2 min — thumbnails don't change frequently
    refetchInterval: 2 * 60 * 1000,
  });
}

export function useVerkadaStreamLink(cameraId: string | null) {
  return useQuery({
    queryKey: ['verkada-stream-link', cameraId],
    queryFn: async () => {
      if (!cameraId) return null;
      const result = await getCameraStreamLink(cameraId);
      if (!result.success) throw new Error(result.error);
      return result.url as string;
    },
    enabled: !!cameraId,
    staleTime: 20 * 60 * 1000,
    retry: 1,
  });
}

export function useVerkadaLivestreamThumbnail(cameraId: string | null, enabled: boolean = true) {
  return useQuery({
    queryKey: ['verkada-livestream-thumbnail', cameraId],
    queryFn: async () => {
      if (!cameraId) return null;
      const result = await getCameraLivestreamThumbnail(cameraId);
      if (!result.success) throw new Error(result.error);
      return result.thumbnail as string;
    },
    enabled: !!cameraId && enabled,
    staleTime: 3000,
    refetchInterval: enabled ? 4000 : false,
  });
}

export function useVerkadaDoors() {
  return useQuery({
    queryKey: ['verkada-doors'],
    queryFn: async () => {
      const result = await listDoors();
      if (!result.success) throw new Error(result.error);
      return result.doors as VerkadaDoor[];
    },
    staleTime: 5 * 60_000,
  });
}

export function useVerkadaUnlockDoor() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (doorId: string) => {
      const result = await unlockDoor(doorId);
      if (!result.success) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      toast({ title: 'Door unlocked successfully' });
      queryClient.invalidateQueries({ queryKey: ['verkada-doors'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: `Failed to unlock door: ${error.message}`, variant: 'destructive' });
    },
  });
}

export function useVerkadaAccessEvents(startTime?: string, endTime?: string, pageSize = 200) {
  return useQuery({
    queryKey: ['verkada-access-events', startTime, endTime, pageSize],
    queryFn: async () => {
      const result = await getAccessEvents(startTime, endTime, pageSize);
      if (!result.success) throw new Error(result.error);
      return result.events as VerkadaAccessEvent[];
    },
  });
}

export function useVerkadaAlarmSites() {
  return useQuery({
    queryKey: ['verkada-alarm-sites'],
    queryFn: async () => {
      const result = await listAlarmSites();
      if (!result.success) throw new Error(result.error);
      return result.sites as VerkadaAlarmSite[];
    },
  });
}

export function useVerkadaPersonsOfInterest() {
  return useQuery({
    queryKey: ['verkada-persons-of-interest'],
    queryFn: async () => {
      const result = await getPersonsOfInterest();
      if (!result.success) throw new Error(result.error);
      return result.persons as VerkadaPersonOfInterest[];
    },
    staleTime: 4 * 60 * 1000, // data is fresh for 4 min
    refetchInterval: 5 * 60 * 1000, // refresh every 5 minutes
  });
}

export function useVerkadaPeopleCounts(cameraId: string | null, startTime?: string, endTime?: string) {
  return useQuery({
    queryKey: ['verkada-people-counts', cameraId, startTime, endTime],
    queryFn: async () => {
      if (!cameraId) return null;
      const result = await getPeopleCounts(cameraId, startTime, endTime);
      if (!result.success) throw new Error(result.error);
      return result.counts as VerkadaPeopleCounts;
    },
    enabled: !!cameraId,
    staleTime: 4 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useVerkadaActivitySummary() {
  return useQuery<ActivitySummary>({
    queryKey: ['verkada-activity-summary'],
    queryFn: async () => {
      const result = await getActivitySummary();
      if (!result.success) throw new Error('Failed to fetch activity summary');
      return result;
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}

export function useVerkadaWebhookHealth() {
  return useQuery<WebhookHealth>({
    queryKey: ['verkada-webhook-health'],
    queryFn: async () => {
      const result = await getWebhookHealth();
      if (!result.success) throw new Error('Failed to fetch webhook health');
      return result;
    },
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
  });
}

export function useVerkadaSightingHealth() {
  return useQuery<SightingHealth>({
    queryKey: ['verkada-sighting-health'],
    queryFn: async () => {
      const result = await getSightingHealth();
      if (!result.success) throw new Error('Failed to fetch sighting health');
      return result;
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}

export function useVehicleProfiles() {
  return useQuery<VehicleProfilesResponse>({
    queryKey: ['vehicle-profiles'],
    queryFn: async () => {
      const result = await getVehicleProfiles();
      if (!result.success) throw new Error('Failed to fetch vehicle profiles');
      return result;
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}

export function useVehicleSightings() {
  return useQuery<VehicleSightings>({
    queryKey: ['vehicle-sightings'],
    queryFn: async () => {
      const result = await getVehicleSightings();
      if (!result.success) throw new Error('Failed to fetch vehicle sightings');
      return result;
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}

export function useCreateVehicleProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ plate, label }: { plate: string; label?: string }) => {
      const result = await createVehicleProfile(plate, label);
      if (!result.success) throw new Error((result as unknown as { error?: string }).error || 'Failed to add vehicle');
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-profiles'] });
      toast({ title: 'Vehicle added successfully' });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
}

export function useUpdateVehicleProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, label }: { id: string; label: string }) => {
      const result = await updateVehicleProfile(id, label);
      if (!result.success) throw new Error((result as unknown as { error?: string }).error || 'Failed to update vehicle');
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-profiles'] });
      toast({ title: 'Vehicle updated' });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
}

export function useDeleteVehicleProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const result = await deleteVehicleProfile(id);
      if (!result.success) throw new Error((result as unknown as { error?: string }).error || 'Failed to delete vehicle');
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vehicle-profiles'] });
      toast({ title: 'Vehicle removed' });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });
}

export function useVerkadaConnectionStatus() {
  return useQuery<VerkadaConnectionStatus>({
    queryKey: ['verkada-connection-status'],
    queryFn: getConnectionStatus,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
}

// --- Types ---

export interface VerkadaCamera {
  camera_id: string;
  device_id?: string;
  name: string;
  location?: string;
  model?: string;
  serial?: string;
  status?: string;
  site?: string;
  firmware?: string;
}

export interface VerkadaDoor {
  door_id: string;
  name: string;
  site_name?: string;
  lock_status?: string;
  door_status?: string;
}

export interface VerkadaAccessEvent {
  event_id?: string;
  timestamp?: number;
  event_type?: string;
  actor_name?: string;
  door_name?: string;
  credential_type?: string;
  granted?: boolean;
}

export interface VerkadaAlarmSite {
  site_id: string;
  name: string;
  arm_state?: string;
  sensor_count?: number;
}

export interface VerkadaPersonOfInterest {
  person_id: string;
  label?: string;
  last_seen?: number;
  created_at?: number;
  thumbnail_url?: string;
}

export interface VerkadaPeopleCounts {
  object_counts?: Array<{
    timestamp: number;
    people_count: number;
    vehicle_count?: number;
  }>;
  [key: string]: unknown;
}

