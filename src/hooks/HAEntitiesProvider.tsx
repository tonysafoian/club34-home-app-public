import { useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { getAllStatesFromCache, getAllStates, getGoveeEntityIds, HAEntity, HAUnavailableError } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { acquireBackendSocket, releaseBackendSocket } from '@/lib/api/backendSocket';
import { HAEntitiesContext } from '@/hooks/useHAEntitiesContext';

const SAFETY_SYNC_INTERVAL = 24 * 60 * 60 * 1000;

export function HAEntitiesProvider({ children }: { children: ReactNode }) {
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const { user, loading: authLoading } = useAuth();
  const isAuthenticated = !authLoading && user !== null;
  const [allEntities, setAllEntities] = useState<HAEntity[]>([]);
  const [goveeEntityIds, setGoveeEntityIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const safetyIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasFetchedRef = useRef(false);
  const goveeFetchedRef = useRef(false);

  const fetchAll = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);

      let data: HAEntity[];
      try {
        data = await getAllStatesFromCache();
      } catch {
        data = await getAllStates() as HAEntity[];
        if (!Array.isArray(data)) data = [];
      }

      setAllEntities(data);
      setLastUpdated(new Date());
      setError(null);
      setUnavailable(false);

      if (!goveeFetchedRef.current) {
        goveeFetchedRef.current = true;
        getGoveeEntityIds().then(ids => {
          if (ids.length > 0) setGoveeEntityIds(new Set(ids));
        });
      }
    } catch (err) {
      if (err instanceof HAUnavailableError) {
        setUnavailable(true);
        setLoading(false);
        setError(null);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to load';
      setError(msg);
      if (!silent) toastRef.current({ title: 'Home Assistant error', description: msg, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      hasFetchedRef.current = false;
      return;
    }

    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchAll();
    }

    safetyIntervalRef.current = setInterval(() => {
      if (!document.hidden) {
        fetchAll(true);
      }
    }, SAFETY_SYNC_INTERVAL);

    return () => {
      if (safetyIntervalRef.current) clearInterval(safetyIntervalRef.current);
    };
  }, [fetchAll, isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) return;

    const socket = acquireBackendSocket();

    const handleStateChanged = (payload: { entity_id: string; new_state: HAEntity | null }) => {
      const { entity_id, new_state } = payload;
      setAllEntities(prev => {
        if (new_state === null) {
          return prev.filter(e => e.entity_id !== entity_id);
        }
        const idx = prev.findIndex(e => e.entity_id === entity_id);
        if (idx === -1) {
          return [...prev, new_state];
        }
        const next = [...prev];
        next[idx] = new_state;
        return next;
      });
      setLastUpdated(new Date());
    };

    socket.on('ha:state_changed', handleStateChanged);

    return () => {
      socket.off('ha:state_changed', handleStateChanged);
      releaseBackendSocket();
    };
  }, [isAuthenticated]);

  const getByDomain = useCallback((domain: string) => {
    return allEntities.filter(e => e.entity_id.startsWith(`${domain}.`));
  }, [allEntities]);

  const value = useMemo(() => ({
    allEntities, goveeEntityIds, loading, error, unavailable, lastUpdated, refetch: fetchAll, getByDomain,
  }), [allEntities, goveeEntityIds, loading, error, unavailable, lastUpdated, fetchAll, getByDomain]);

  return (
    <HAEntitiesContext.Provider value={value}>
      {children}
    </HAEntitiesContext.Provider>
  );
}
