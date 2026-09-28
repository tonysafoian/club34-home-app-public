import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { apiClient } from '@/lib/apiClient';
import { queryNotionDatabase } from '@/lib/api/notion';
import { getGoogleConnectionStatus, listGoogleEvents } from '@/lib/api/google';
import { startOfDay, endOfDay, subDays, addDays } from 'date-fns';

const TIGERDEN_DATABASE_ID = '2b8e96d8-93fa-80cc-b1fa-fa4eef48c6fe';

interface NotionSyncConfigRow {
  notion_database_id: string;
}

export function useDashboardPrefetch() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user?.userId) return;
    // Fire all prefetches in parallel — these populate the cache
    // so components render instantly instead of waiting in sequence.

    queryClient.prefetchQuery({
      queryKey: ['user-profile', user.userId],
      queryFn: async () => {
        const [profileRes, roleRes] = await Promise.all([
          apiClient.dbQuery<{ display_name: string | null; avatar_url: string | null; approval_status: string | null }>({
            table: 'profiles',
            select: 'display_name, avatar_url, approval_status',
            filters: [{ column: 'user_id', op: 'eq', value: user.userId }],
            single: true,
          }),
          apiClient.dbQuery<{ role: string }>({
            table: 'user_roles',
            select: 'role',
            filters: [{ column: 'user_id', op: 'eq', value: user.userId }],
            single: true,
          }),
        ]);
        return {
          displayName: profileRes.data?.display_name ?? null,
          avatarUrl: profileRes.data?.avatar_url ?? null,
          approvalStatus: profileRes.data?.approval_status ?? null,
          role: roleRes.data?.role ?? null,
        };
      },
      staleTime: 5 * 60_000,
    });

    queryClient.prefetchQuery({
      queryKey: ['notion-sync-configs', user.userId],
      queryFn: async () => {
        const { data } = await apiClient.dbQuery({
          table: 'notion_sync_config',
          select: '*',
          order: { column: 'created_at', ascending: false },
        });
        return data;
      },
      staleTime: 5 * 60_000,
    });

    queryClient.prefetchQuery({
      queryKey: ['latest-updates'],
      queryFn: async () => {
        const { data } = await apiClient.dbQuery({
          table: 'system_updates',
          select: '*',
          filters: [{ column: 'published_at', op: 'lte', value: new Date().toISOString() }],
          order: { column: 'published_at', ascending: false },
          limit: 2,
        });
        return data;
      },
      staleTime: 5 * 60_000,
    });

    queryClient.prefetchQuery({
      queryKey: ['notion-recurring-tasks-prefetch'],
      queryFn: async () => {
        let syncConfigs = queryClient.getQueryData<NotionSyncConfigRow[]>(['notion-sync-configs', user.userId]);
        if (!syncConfigs) {
          const { data } = await apiClient.dbQuery({
            table: 'notion_sync_config',
            select: '*',
            order: { column: 'created_at', ascending: false },
          });
          syncConfigs = (data as NotionSyncConfigRow[]) || [];
        }
        if (!syncConfigs.length) return [];
        const configsToFetch = syncConfigs.filter((c) => c.notion_database_id !== TIGERDEN_DATABASE_ID);
        await Promise.allSettled(
          configsToFetch.map((config) => queryNotionDatabase(config.notion_database_id))
        );
        return true;
      },
      staleTime: 5 * 60_000,
    });

    queryClient.prefetchQuery({
      queryKey: ['google-connection-status', user.userId],
      queryFn: async () => {
        const result = await getGoogleConnectionStatus();
        if (!result.success) throw new Error(result.error);
        return result as { connected: boolean; google_email: string | null; scopes: string[] };
      },
      staleTime: 60_000,
    });

    const now = new Date();
    const fetchMin = startOfDay(subDays(now, 1)).toISOString();
    const fetchMax = endOfDay(addDays(now, 21)).toISOString();
    queryClient.prefetchQuery({
      queryKey: ['google-calendar-events', user.userId, fetchMin, fetchMax],
      queryFn: async () => {
        const result = await listGoogleEvents('primary', fetchMin, fetchMax);
        if (!result.success) throw new Error(result.error);
        return result.events;
      },
      staleTime: 2 * 60_000,
    });

    queryClient.prefetchQuery({
      queryKey: ['weather-strip'],
      queryFn: async () => {
        return apiClient.post('/api/weather-dashboard');
      },
      staleTime: 10 * 60_000,
    });
  }, [user?.userId, queryClient]);

  useEffect(() => {
    if (!user?.userId) return;

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        queryClient.invalidateQueries({
          predicate: (query) => {
            const age = Date.now() - (query.state.dataUpdatedAt || 0);
            return age > 2 * 60 * 1000;
          }
        });
      }
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [user?.userId, queryClient]);
}
