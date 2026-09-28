import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';

export interface AuditEntry {
  id: string;
  created_at: string;
  category: string;
  event_type: string;
  severity: string;
  actor_name: string | null;
  channel: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  status: string;
  edge_function: string | null;
}

export function useRecentRequests(limit = 100) {
  return useQuery({
    queryKey: ['audit-recent-requests', 'last-hour', limit],
    queryFn: async () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { data } = await apiClient.dbQuery<AuditEntry[]>({
        table: 'system_audit_log',
        select: 'id,created_at,category,event_type,severity,actor_name,channel,summary,detail,duration_ms,status,edge_function',
        filters: [{ column: 'created_at', op: 'gte', value: oneHourAgo }],
        order: { column: 'created_at', ascending: false },
        limit,
      });
      return data ?? [];
    },
    refetchInterval: 30 * 1000,
  });
}
