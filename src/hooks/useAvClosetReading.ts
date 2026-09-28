import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

// Corrected AV Closet temperature, read straight from the Govee Cloud API by the
// backend (Home Assistant's Govee integration double-converts the reading and
// reports a bogus ~155°F). `tempF` is null when Govee is unavailable.
export interface AvClosetReading {
  tempF: number | null;
  humidity: number | null;
  // Device online flag from Govee. `false` means the sensor is offline (dead
  // battery / lost connectivity); `null` when not reported or Govee is down.
  online?: boolean | null;
  source: string;
  fetchedAt?: string;
  configured?: boolean;
  error?: string;
}

export function useAvClosetReading() {
  return useQuery<AvClosetReading>({
    queryKey: ['av-closet-reading'],
    queryFn: () => apiClient.get<AvClosetReading>('/api/govee/av-closet'),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
