import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

export interface GeneracGenerator {
  id: number;
  name: string;
  serialNumber: string;
  isConnected: boolean;
  apparatusStatus: number;
  statusText: string;
  batteryVoltage: string | null;
  runHours: number | null;
  lastSeen: string | null;
  heroImageUrl: string | null;
  address: string | null;
  weather: unknown;
  properties: { name: string; value: unknown; type: number }[];
}

async function fetchGenerators(): Promise<GeneracGenerator[]> {
  const data = await apiClient.get<{ generators?: GeneracGenerator[] }>('/api/generac');
  return data?.generators || [];
}

export function useGenerac() {
  return useQuery({
    queryKey: ['generac-generators'],
    queryFn: fetchGenerators,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
    retry: 1,
  });
}
