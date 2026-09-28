import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Loader2, RefreshCw, CheckCircle2, ChevronDown, AlertTriangle, Clock, Inbox,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { toast } from '@/hooks/use-toast';

interface ActionItem {
  id: string;
  created_at: string;
  event_type: string;
  category: string | null;
  severity: 'info' | 'warn' | 'critical' | string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  correlation_id: string | null;
}

interface ActionableAuditResponse {
  window: { since: string; until: string };
  total: number;
  by_event_type: { event_type: string; count: number }[];
  recent: ActionItem[];
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  warn: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
};

export function AdminActionItemsContent() {
  const queryClient = useQueryClient();

  const { data, isLoading, isRefetching } = useQuery({
    queryKey: ['admin-action-items'],
    queryFn: async () => (await apiClient.get('/api/admin/actionable-audit')) as ActionableAuditResponse,
    refetchInterval: 60_000,
  });

  const resolveMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.post(`/api/admin/actionable-audit/${id}/resolve`, {});
    },
    onSuccess: () => {
      toast({ title: 'Marked as resolved' });
      queryClient.invalidateQueries({ queryKey: ['admin-action-items'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Could not resolve', description: error.message, variant: 'destructive' });
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const items = data?.recent ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground" data-testid="text-action-items-count">
            {total} action {total === 1 ? 'item' : 'items'} in the last 7 days
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['admin-action-items'] })}
          disabled={isRefetching}
          data-testid="button-refresh-action-items"
        >
          <RefreshCw className={cn('h-4 w-4 mr-1', isRefetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Breakdown by type */}
      {data && data.by_event_type.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.by_event_type.map((b) => (
            <Badge key={b.event_type} variant="outline" className="text-[11px]">
              {b.event_type.replace(/_/g, ' ')}: {b.count}
            </Badge>
          ))}
        </div>
      )}

      {/* Empty state */}
      {items.length === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          <Inbox className="h-8 w-8 mx-auto mb-2 text-emerald-500/50" />
          No action items — nothing needs attention right now.
        </Card>
      )}

      {/* Items */}
      {items.map((item) => (
        <ActionItemCard
          key={item.id}
          item={item}
          onResolve={() => resolveMutation.mutate(item.id)}
          resolving={resolveMutation.isPending}
        />
      ))}
    </div>
  );
}

function ActionItemCard({
  item,
  onResolve,
  resolving,
}: {
  item: ActionItem;
  onResolve: () => void;
  resolving: boolean;
}) {
  const severity = (item.severity ?? 'info') as string;
  return (
    <Card className="p-3 space-y-2" data-testid={`card-action-item-${item.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle
            className={cn(
              'h-4 w-4 shrink-0',
              severity === 'critical' ? 'text-red-400' : severity === 'warn' ? 'text-yellow-400' : 'text-blue-400',
            )}
          />
          <span className="text-sm font-medium truncate">{item.summary}</span>
          <Badge variant="outline" className={cn('text-[10px] shrink-0', SEVERITY_STYLE[severity])}>
            {severity}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 shrink-0"
          onClick={onResolve}
          disabled={resolving}
          data-testid={`button-resolve-${item.id}`}
        >
          {resolving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div className="flex items-center gap-3 text-[10px] text-muted-foreground pl-6">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatDistanceToNow(new Date(item.created_at), { addSuffix: true })}
        </span>
        <span>{item.event_type.replace(/_/g, ' ')}</span>
        {item.category && <span>· {item.category}</span>}
        {item.detail && (
          <Collapsible>
            <CollapsibleTrigger className="underline hover:text-foreground">details</CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1 text-[10px] text-muted-foreground/70 whitespace-pre-wrap max-h-32 overflow-auto">
                {JSON.stringify(item.detail, null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </Card>
  );
}
