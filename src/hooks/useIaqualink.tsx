import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listDevices, getDeviceStatus, setAux, setTemperature } from '@/lib/api/iaqualink';
import { toast } from '@/hooks/use-toast';

// --- Types ---

export interface IaqualinkDevice {
  serial_number: string;
  device_type?: string;
  name?: string;
  owner_name?: string;
  created_at?: string;
  updated_at?: string;
}

export interface IaqualinkDeviceStatus {
  pool_temp?: string;
  spa_temp?: string;
  air_temp?: string;
  pool_set_point?: string;
  spa_set_point?: string;
  freeze_protection?: string;
  [key: string]: unknown;
}

// --- Hooks ---

export function useIaqualinkDevices() {
  return useQuery({
    queryKey: ['iaqualink-devices'],
    queryFn: async () => {
      const result = await listDevices();
      if (!result.success) throw new Error(result.error);
      // The API returns an array of device objects or an object with devices array
      const devices = Array.isArray(result.devices)
        ? result.devices
        : result.devices?.devices || [];
      return devices as IaqualinkDevice[];
    },
  });
}

export function useIaqualinkStatus(serialNumber: string | null) {
  return useQuery({
    queryKey: ['iaqualink-status', serialNumber],
    queryFn: async () => {
      if (!serialNumber) return null;
      const result = await getDeviceStatus(serialNumber);
      if (!result.success) throw new Error(result.error);
      return result.status as IaqualinkDeviceStatus;
    },
    enabled: !!serialNumber,
    refetchInterval: 60 * 1000, // refresh every minute
  });
}

export function useIaqualinkSetAux() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      serialNumber,
      auxId,
      value,
    }: {
      serialNumber: string;
      auxId: string;
      value: string;
    }) => {
      const result = await setAux(serialNumber, auxId, value);
      if (!result.success) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      toast({ title: 'Equipment toggled' });
      queryClient.invalidateQueries({ queryKey: ['iaqualink-status'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: `Failed to toggle equipment: ${error.message}`, variant: 'destructive' });
    },
  });
}

export function useIaqualinkSetTemperature() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      serialNumber,
      tempType,
      value,
    }: {
      serialNumber: string;
      tempType: string;
      value: number;
    }) => {
      const result = await setTemperature(serialNumber, tempType, value);
      if (!result.success) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      toast({ title: 'Temperature updated' });
      queryClient.invalidateQueries({ queryKey: ['iaqualink-status'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Error', description: `Failed to update temperature: ${error.message}`, variant: 'destructive' });
    },
  });
}
