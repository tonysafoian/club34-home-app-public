import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { ChevronRight, ShoppingCart, RotateCcw, Loader2 } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import type { GroceryRun } from './ThisWeekOrder';

const STATUS_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  open: { label: 'Open', variant: 'default' },
  locked: { label: 'Locked', variant: 'outline' },
  submitted: { label: 'Submitted', variant: 'secondary' },
  skipped: { label: 'Skipped', variant: 'outline' },
  cancelled: { label: 'Cancelled', variant: 'destructive' },
};

function formatDelivDate(run: GroceryRun): string {
  if (!run.delivery_date) return 'this run';
  return new Date(run.delivery_date + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function RunHistory() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmRun, setConfirmRun] = useState<GroceryRun | null>(null);
  const [reordering, setReordering] = useState(false);

  const isAdmin = user?.roles.includes('admin') ?? false;

  const { data, isLoading } = useQuery<{ runs: GroceryRun[] }>({
    queryKey: ['/api/grocery-order/runs'],
    queryFn: () => apiClient.get('/api/grocery-order/runs'),
    staleTime: 60 * 1000,
  });

  const handleReorder = async () => {
    if (!confirmRun) return;
    setReordering(true);
    try {
      const result = await apiClient.post(`/api/grocery-order/runs/${confirmRun.id}/copy-to-current`, {});
      const { copied, skipped } = result as { copied: number; skipped: number };
      toast({
        title: 'Items copied',
        description: `${copied} item${copied !== 1 ? 's' : ''} added${skipped > 0 ? `, ${skipped} already in cart (skipped)` : ''}.`,
      });
      setConfirmRun(null);
      queryClient.invalidateQueries({ queryKey: ['/api/grocery-order/current'] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not copy items';
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setReordering(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const runs = data?.runs?.slice(0, 8) ?? [];

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center py-8 gap-2 text-muted-foreground">
        <ShoppingCart className="h-6 w-6 opacity-40" />
        <p className="text-sm">No past cycles yet</p>
      </div>
    );
  }

  const completedStatuses = new Set(['submitted', 'locked', 'skipped', 'cancelled']);

  return (
    <>
      <div className="space-y-1">
        {runs.map(run => {
          const sc = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.open;
          const delivDate = formatDelivDate(run);
          const canReorder = isAdmin && completedStatuses.has(run.status) && run.item_count > 0;

          return (
            <div
              key={run.id}
              className="flex items-center gap-1 rounded-lg hover:bg-muted/50 transition-colors group"
              data-testid={`run-history-row-${run.id}`}
            >
              {/* Navigable area — takes up all available space */}
              <button
                className="flex-1 flex items-center gap-2 px-3 py-2.5 text-left min-w-0"
                onClick={() => navigate(`/common-tasks/grocery/runs/${run.id}`)}
                aria-label={`View run for ${delivDate}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant={sc.variant} className="text-xs shrink-0">{sc.label}</Badge>
                    <span className="text-sm font-medium">{run.item_count} items</span>
                    {run.auto_ordered && (
                      <Badge variant="outline" className="text-xs">auto</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">Delivery: {delivDate}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/50 shrink-0 group-hover:text-muted-foreground transition-colors" />
              </button>

              {/* Reorder action — separate from navigate area */}
              {canReorder && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 mr-2 text-xs text-muted-foreground hover:text-foreground gap-1 shrink-0"
                  onClick={() => setConfirmRun(run)}
                  data-testid={`button-reorder-${run.id}`}
                >
                  <RotateCcw className="h-3 w-3" />
                  Reorder
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {/* Reorder confirmation dialog */}
      <Dialog open={!!confirmRun} onOpenChange={open => { if (!open) setConfirmRun(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reorder from {confirmRun ? formatDelivDate(confirmRun) : ''}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Copy all {confirmRun?.item_count ?? 0} items from this run into the current open cycle. Items already in the cart will be skipped.
          </p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setConfirmRun(null)} data-testid="button-reorder-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleReorder}
              disabled={reordering}
              data-testid="button-reorder-confirm"
            >
              {reordering ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Copy items
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
