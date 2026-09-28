import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

/**
 * Per-zone flow config (GPM) served by /api/irrigation/zone-flows.
 * GPM values are type-based defaults from the server (rotor/spray/drip) until
 * zones are field-calibrated; `isDefault` flags uncalibrated values.
 */
export interface ZoneFlowRow {
  svgId: string;
  entityId: string;
  gpm: number;
  headType: 'rotor' | 'spray' | 'drip';
  isDefault: boolean;
}

/** Estimated gallons for a run: GPM × runtime minutes, rounded to 1 decimal. */
export function estimateGallons(gpm: number, durationMs: number): number {
  const minutes = Math.max(0, durationMs) / 60000;
  return +(gpm * minutes).toFixed(1);
}

/** Compact gallons label, e.g. "≈ 24 gal". */
export function formatGallons(gallons: number): string {
  const rounded = gallons >= 10 ? Math.round(gallons) : +gallons.toFixed(1);
  return `≈ ${rounded} gal`;
}

/**
 * Fetch the per-zone GPM map and expose lookups by HA entity_id and svgId.
 * Returns null from the lookups until the config loads (or for unknown zones)
 * so callers can simply hide gallons rather than show a made-up number.
 */
export function useValveConfigs() {
  const { data, isLoading } = useQuery({
    queryKey: ['/api/irrigation/zone-flows'],
    queryFn: () => apiClient.get<{ flows: ZoneFlowRow[] }>('/api/irrigation/zone-flows'),
    staleTime: 30 * 60_000,
  });

  const flows = useMemo(() => data?.flows ?? [], [data]);

  const byEntityId = useMemo(() => {
    const map = new Map<string, ZoneFlowRow>();
    for (const f of flows) map.set(f.entityId, f);
    return map;
  }, [flows]);

  const bySvgId = useMemo(() => {
    const map = new Map<string, ZoneFlowRow>();
    for (const f of flows) map.set(f.svgId, f);
    return map;
  }, [flows]);

  const gpmForEntity = useMemo(
    () => (entityId: string): number | null => byEntityId.get(entityId)?.gpm ?? null,
    [byEntityId],
  );

  const gpmForSvgId = useMemo(
    () => (svgId: string): number | null => bySvgId.get(svgId)?.gpm ?? null,
    [bySvgId],
  );

  return { flows, byEntityId, bySvgId, gpmForEntity, gpmForSvgId, isLoading };
}
