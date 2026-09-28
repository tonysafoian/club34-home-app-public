import { createContext, useContext, useMemo } from 'react';
import { HAEntity } from '@/lib/api/homeAssistant';

export interface HAEntitiesContextValue {
  allEntities: HAEntity[];
  goveeEntityIds: Set<string>;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  lastUpdated: Date | null;
  refetch: (silent?: boolean) => Promise<void>;
  getByDomain: (domain: string) => HAEntity[];
}

export const HAEntitiesContext = createContext<HAEntitiesContextValue | null>(null);

/** Use entities for a specific domain from the shared context */
export function useSharedHAEntities(domain: string) {
  const ctx = useContext(HAEntitiesContext);
  if (!ctx) throw new Error('useSharedHAEntities must be used within HAEntitiesProvider');
  const { getByDomain } = ctx;
  const entities = useMemo(() => getByDomain(domain), [getByDomain, domain]);
  return { entities, loading: ctx.loading, error: ctx.error, unavailable: ctx.unavailable, lastUpdated: ctx.lastUpdated, refetch: ctx.refetch };
}

/** Use all entities from the shared context */
export function useSharedHAAllEntities() {
  const ctx = useContext(HAEntitiesContext);
  if (!ctx) throw new Error('useSharedHAAllEntities must be used within HAEntitiesProvider');
  return ctx;
}

/** Use the set of Govee entity IDs from the shared context */
export function useGoveeEntityIds() {
  const ctx = useContext(HAEntitiesContext);
  if (!ctx) throw new Error('useGoveeEntityIds must be used within HAEntitiesProvider');
  return ctx.goveeEntityIds;
}
