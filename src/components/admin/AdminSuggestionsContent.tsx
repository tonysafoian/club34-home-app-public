import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { ChevronDown, ChevronUp, Mail, RotateCcw } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

interface Suggestion {
  id: string;
  user_id: string;
  user_display_name: string | null;
  user_email: string;
  content: string;
  status: 'pending' | 'acknowledged' | 'completed';
  admin_note: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_BADGE: Record<Suggestion['status'], { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'bg-warning/10 text-warning border-warning/20' },
  acknowledged: { label: 'Acknowledged', className: 'bg-primary/10 text-primary border-primary/20' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success border-success/20' },
};

export function AdminSuggestionsContent() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [adminNotes, setAdminNotes] = useState<Record<string, string>>({});

  const { data: suggestions, isLoading } = useQuery({
    queryKey: ['suggestions'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<Suggestion[]>({ table: 'suggestions', select: '*', order: { column: 'created_at', ascending: false } });
      return (data ?? []) as Suggestion[];
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      status,
      admin_note,
    }: {
      id: string;
      status: Suggestion['status'];
      admin_note: string;
    }) => {
      await apiClient.dbUpdate('suggestions', { status, admin_note }, [{ column: 'id', op: 'eq', value: id }]);

      if (status === 'acknowledged' || status === 'completed') {
        await apiClient.invokeFn('suggest-submit', { action: 'notify', suggestion_id: id });
      }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] });
      const label = variables.status === 'acknowledged' ? 'Acknowledged' : variables.status === 'completed' ? 'Completed' : 'Updated';
      const notified = variables.status === 'acknowledged' || variables.status === 'completed';
      toast({ title: `${label}${notified ? ' — submitter notified by email' : ''}` });
      setExpandedId(null);
    },
    onError: (e) => toast({ title: 'Error', description: `Failed to update: ${e.message}`, variant: 'destructive' }),
  });

  function getNote(suggestion: Suggestion): string {
    return adminNotes[suggestion.id] ?? suggestion.admin_note ?? '';
  }

  function toggleExpand(id: string, suggestion: Suggestion) {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      // Pre-fill note from DB if not already edited
      if (adminNotes[id] === undefined && suggestion.admin_note) {
        setAdminNotes(prev => ({ ...prev, [id]: suggestion.admin_note! }));
      }
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
      </div>
    );
  }

  const pending = suggestions?.filter(s => s.status === 'pending') ?? [];
  const rest = suggestions?.filter(s => s.status !== 'pending') ?? [];
  const sorted = [...pending, ...rest];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {suggestions?.length ?? 0} suggestion{(suggestions?.length ?? 0) !== 1 ? 's' : ''} total
        {pending.length > 0 && (
          <span className="ml-2 text-warning font-medium">· {pending.length} pending</span>
        )}
      </p>

      {sorted.length === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm">
          No suggestions yet.
        </div>
      )}

      {sorted.map((suggestion) => {
        const isExpanded = expandedId === suggestion.id;
        const badge = STATUS_BADGE[suggestion.status];
        const note = getNote(suggestion);
        const isUpdating = updateMutation.isPending && updateMutation.variables?.id === suggestion.id;

        return (
          <Card key={suggestion.id} className={cn('transition-all', isExpanded && 'ring-1 ring-border')}>
            <CardContent className="p-4">
              {/* Header row */}
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">
                      {suggestion.user_display_name || suggestion.user_email}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {suggestion.user_email}
                    </span>
                    <Badge variant="outline" className={cn('text-xs shrink-0', badge.className)}>
                      {badge.label}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {format(new Date(suggestion.created_at), 'MMM d, yyyy h:mm a')}
                  </p>
                  <p className="text-sm text-foreground/80 mt-2 line-clamp-2">
                    {suggestion.content.length > 120
                      ? `${suggestion.content.slice(0, 120)}…`
                      : suggestion.content}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleExpand(suggestion.id, suggestion)}
                  className="shrink-0 text-muted-foreground"
                >
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  <span className="ml-1 text-xs">{isExpanded ? 'Close' : 'Review'}</span>
                </Button>
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="mt-4 space-y-3 border-t border-border/50 pt-4">
                  {/* Full content */}
                  <div className="bg-muted/50 rounded-lg p-3 text-sm leading-relaxed whitespace-pre-wrap">
                    {suggestion.content}
                  </div>

                  {/* Admin note */}
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                      Note for submitter (optional — included in notification email)
                    </label>
                    <Textarea
                      value={note}
                      onChange={(e) =>
                        setAdminNotes(prev => ({ ...prev, [suggestion.id]: e.target.value }))
                      }
                      placeholder="Add a note for the submitter…"
                      className="min-h-[80px] resize-none text-sm"
                    />
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 flex-wrap">
                    {suggestion.status !== 'acknowledged' && suggestion.status !== 'completed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-primary/30 text-primary hover:bg-primary/10"
                        disabled={isUpdating}
                        onClick={() =>
                          updateMutation.mutate({ id: suggestion.id, status: 'acknowledged', admin_note: note })
                        }
                      >
                        <Mail className="h-4 w-4 mr-1.5" />
                        Mark Acknowledged
                      </Button>
                    )}
                    {suggestion.status !== 'completed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-border text-foreground hover:bg-muted"
                        disabled={isUpdating}
                        onClick={() =>
                          updateMutation.mutate({ id: suggestion.id, status: 'completed', admin_note: note })
                        }
                      >
                        <Mail className="h-4 w-4 mr-1.5" />
                        Mark Completed
                      </Button>
                    )}
                    {suggestion.status === 'completed' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        disabled={isUpdating}
                        onClick={() =>
                          updateMutation.mutate({ id: suggestion.id, status: 'pending', admin_note: note })
                        }
                      >
                        <RotateCcw className="h-4 w-4 mr-1.5" />
                        Reopen
                      </Button>
                    )}
                    {isUpdating && (
                      <span className="text-xs text-muted-foreground ml-1">Updating…</span>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
