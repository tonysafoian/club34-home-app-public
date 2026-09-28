import { useMemo } from 'react';
import { HAEntity } from '@/lib/api/homeAssistant';
import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';

export function useHAEntities(domain?: string, _refreshInterval = 15000) {
  const { allEntities, loading, refetch } = useSharedHAAllEntities();

  const entities = useMemo(() => {
    if (!domain) return allEntities;
    return allEntities.filter(e => e.entity_id.startsWith(`${domain}.`));
  }, [allEntities, domain]);

  return {
    entities,
    loading,
    error: null as string | null,
    unavailable: false,
    lastUpdated: null as Date | null,
    refetch,
  };
}

export function useHADomains(domains: string[], _refreshInterval = 15000) {
  const { allEntities, loading, refetch } = useSharedHAAllEntities();

  const domainsKey = domains.join(',');
  const entitiesByDomain = useMemo(() => {
    const result: Record<string, HAEntity[]> = {};
    const list = domainsKey ? domainsKey.split(',') : [];
    for (const d of list) {
      result[d] = allEntities.filter(e => e.entity_id.startsWith(`${d}.`));
    }
    return result;
  }, [allEntities, domainsKey]);

  return {
    entitiesByDomain,
    loading,
    unavailable: false,
    lastUpdated: null as Date | null,
    refetch,
  };
}
