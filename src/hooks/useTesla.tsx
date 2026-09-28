import { useState, useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';
import { resolveApiUrl } from '@/lib/api/fetchWithAuth';

interface TeslaStatus {
  credentials_configured: boolean;
  keypair_generated: boolean;
  partner_registered: boolean;
  user_authenticated: boolean;
  token_valid: boolean;
}

interface TeslaVehicle {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: string;
}

interface TeslaVehicleData {
  charge_state?: {
    battery_level: number;
    battery_range: number;
    charging_state: string;
    charge_limit_soc: number;
  };
  climate_state?: {
    inside_temp: number | null;
    outside_temp: number | null;
    is_climate_on: boolean;
  };
  drive_state?: {
    latitude: number | null;
    longitude: number | null;
    speed: number | null;
  };
  vehicle_state?: {
    locked: boolean;
    odometer: number;
    car_version: string;
  };
}

function getErrorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

const BASE = resolveApiUrl('/functions/v1');
export function useTesla() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<TeslaStatus | null>(null);
  const [vehicles, setVehicles] = useState<TeslaVehicle[]>([]);
  const [vehicleData, setVehicleData] = useState<Record<number, TeslaVehicleData>>({});
  const [pairingRequired, setPairingRequired] = useState(false);
  const { toast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const data = await apiClient.get<TeslaStatus>('/api/tesla/setup?action=status');
      setStatus(data);
      return data;
    } catch (err) {
      console.error('Failed to fetch Tesla status:', err);
      return null;
    }
  }, []);

  const generateKeypair = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ public_key_pem?: string }>('/api/tesla/setup?action=generate-key');
      if (data?.public_key_pem) {
        toast({ title: 'Keypair generated', description: 'Copy the public key PEM to your domain.' });
      }
      return data;
    } catch (err: unknown) {
      toast({ title: 'Error', description: getErrorMessage(err), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const registerPartner = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get('/api/tesla/setup?action=register-partner');
      toast({ title: 'Partner registered', description: 'Domain registered with Tesla successfully.' });
      return data;
    } catch (err: unknown) {
      toast({ title: 'Registration failed', description: getErrorMessage(err), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const getAuthUrl = useCallback(async () => {
    try {
      const data = await apiClient.get<{ auth_url: string; state: string }>('/api/tesla/setup?action=auth-url');
      try {
        localStorage.setItem('tesla_oauth_state', data.state);
        localStorage.setItem('tesla_oauth_state_ts', Date.now().toString());
      } catch (e) {
        console.error('Failed to store OAuth state:', e);
      }
      return data.auth_url;
    } catch (err: unknown) {
      toast({ title: 'Error', description: getErrorMessage(err), variant: 'destructive' });
      return null;
    }
  }, [toast]);

  const fetchVehicles = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ vehicles?: TeslaVehicle[]; pairing_required?: boolean }>('/api/tesla/proxy?action=vehicles');
      if (data?.pairing_required) {
        setPairingRequired(true);
        toast({
          title: 'Pairing required',
          description: 'Your Tesla needs to be paired with this app. Please check your Tesla app for a pairing request.',
        });
      }
      setVehicles(data?.vehicles || []);
      return data?.vehicles || [];
    } catch (err: unknown) {
      const status = (err as { status?: number } | null)?.status;
      const message = getErrorMessage(err);
      if (status === 412 || message?.includes('pairing_required')) {
        setPairingRequired(true);
        toast({
          title: 'Pairing required',
          description: 'Your Tesla needs to be paired with this app. Please check your Tesla app for a pairing request.',
        });
      } else {
        toast({ title: 'Error', description: message, variant: 'destructive' });
      }
      setVehicles([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const fetchVehicleData = useCallback(async (vehicleId: number) => {
    try {
      const data = await apiClient.get<{ response?: TeslaVehicleData }>(`/api/tesla/proxy?action=vehicle-data&id=${vehicleId}`);
      if (data?.response) {
        setVehicleData((prev) => ({ ...prev, [vehicleId]: data.response! }));
      }
      return data?.response;
    } catch (err: unknown) {
      console.error('Failed to fetch vehicle data:', err);
      return null;
    }
  }, []);

  const wakeVehicle = useCallback(async (vehicleId: number) => {
    try {
      await apiClient.post(`/api/tesla/proxy?action=wake&id=${vehicleId}`);
      toast({ title: 'Wake command sent' });
    } catch (err: unknown) {
      toast({ title: 'Error', description: getErrorMessage(err), variant: 'destructive' });
    }
  }, [toast]);

  return {
    loading,
    status,
    vehicles,
    vehicleData,
    pairingRequired,
    fetchStatus,
    generateKeypair,
    registerPartner,
    getAuthUrl,
    fetchVehicles,
    fetchVehicleData,
    wakeVehicle,
  };
}
