import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, ChevronRight } from 'lucide-react';
import { useSocketEvent } from '@/hooks/useRealtimeSocket';
import { apiClient } from '@/lib/apiClient';

const TYPE_DOT: Record<string, string> = {
  feature: 'bg-emerald-500',
  improvement: 'bg-blue-500',
  fix: 'bg-amber-500',
};

export function LatestUpdateStrip() {
  const navigate = useNavigate();

  const { data: updates } = useQuery({
    queryKey: ['latest-updates'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<Array<{ id: string; update_type: string; title: string; version: string }>>({
        table: 'system_updates',
        select: '*',
        filters: [{ column: 'published_at', op: 'lte', value: new Date().toISOString() }],
        order: { column: 'published_at', ascending: false },
        limit: 2,
      });
      return data;
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 60 * 60 * 1000,
  });

  const queryClient = useQueryClient();

  const handleSystemUpdate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['latest-updates'] });
    queryClient.invalidateQueries({ queryKey: ['system-updates'] });
  }, [queryClient]);
  useSocketEvent('system:update', handleSystemUpdate);

  if (!updates?.length) return null;

  return (
    <div
      className="w-full border-b border-border/40 bg-background/80 backdrop-blur-xl cursor-pointer hover:bg-background/95 transition-colors"
      onClick={() => navigate('/updates')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate('/updates')}
    >
      <div className="container">
        <div className="flex items-center gap-2 py-1.5 overflow-x-auto scrollbar-hide">
          <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 animate-pulse" />
          <span className="text-[11px] font-semibold text-primary uppercase tracking-wide shrink-0">New</span>

          {updates.map((u, i) => (
            <div key={u.id} className="flex items-center gap-1.5 shrink-0">
              {i > 0 && <span className="text-border mx-1">|</span>}
              <span className={`h-1.5 w-1.5 rounded-full ${TYPE_DOT[u.update_type] ?? 'bg-muted-foreground'}`} />
              <span className="text-xs text-foreground font-medium">{u.title}</span>
              <span className="text-[10px] text-muted-foreground font-mono">{u.version}</span>
            </div>
          ))}

          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0 ml-auto" />
        </div>
      </div>
    </div>
  );
}
