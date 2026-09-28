import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Package, AlertTriangle } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { GroceryProductImage } from '@/lib/groceryImage';
import { useAuth } from '@/hooks/useAuth';
import { RunStatusBadge } from '@/components/grocery/ThisWeekOrder';
import type { GroceryRun, GroceryOrderItem } from '@/components/grocery/ThisWeekOrder';

interface AuditRow {
  id: string;
  item_id: string | null;
  run_id: string;
  action: 'added' | 'qty_changed' | 'removed';
  actor_user_id: string | null;
  old_qty: number | null;
  new_qty: number | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

interface RunDetailResponse {
  run: GroceryRun;
  items: GroceryOrderItem[];
  audit: AuditRow[];
}

const CATEGORY_ORDER = ['produce', 'dairy', 'bakery'];
const CATEGORIES: Record<string, string> = {
  produce: 'Produce', dairy: 'Dairy', bakery: 'Bakery', meat: 'Meat',
  beverages: 'Beverages', snacks: 'Snacks', frozen: 'Frozen', pantry: 'Pantry',
  household: 'Household', 'personal-care': 'Personal Care', general: 'General',
};

function sortCategories(cats: string[]): string[] {
  const priority = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));
  return [...cats].sort((a, b) => {
    const pa = priority.has(a) ? priority.get(a)! : 99;
    const pb = priority.has(b) ? priority.get(b)! : 99;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getActorLabel(actorUserId: string | null, currentUserId: string): string {
  if (!actorUserId) return 'System';
  if (actorUserId === currentUserId) return 'You';
  return 'Household';
}

function getActionVerb(action: AuditRow['action']): string {
  if (action === 'added') return 'added';
  if (action === 'qty_changed') return 'changed';
  return 'removed';
}

function toPrice(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function ReadOnlyItemRow({ item }: { item: GroceryOrderItem }) {
  const altText = [item.brand, item.name, item.size].filter(Boolean).join(' ');
  const price = toPrice(item.unit_price);
  return (
    <div
      className="grid grid-cols-[44px_1fr_auto_auto] sm:grid-cols-[44px_1fr_80px_80px] gap-x-3 items-center px-3 py-2.5 rounded-lg border border-transparent"
      data-testid={`run-detail-row-${item.staple_id ?? item.amazon_asin ?? item.id}`}
    >
      <div className="flex items-center justify-center w-11 h-11 rounded-md overflow-hidden bg-muted/60 shrink-0">
        <GroceryProductImage url={item.image_url} alt={altText} />
      </div>
      <div className="min-w-0">
        {item.brand && <p className="text-xs text-accent font-medium truncate">{item.brand}</p>}
        <p className="text-sm font-medium leading-tight">{item.name}</p>
        {item.size && <p className="text-xs text-muted-foreground">{item.size}</p>}
      </div>
      <div className="text-right hidden sm:block">
        {price != null && (
          <p className="text-sm font-mono">${price.toFixed(2)}</p>
        )}
        {price != null && item.quantity > 1 && (
          <p className="text-xs text-muted-foreground font-mono">
            ${(price * item.quantity).toFixed(2)}
          </p>
        )}
      </div>
      <div className="text-right">
        <span className="text-sm font-medium text-muted-foreground">×{item.quantity}</span>
      </div>
    </div>
  );
}

export default function GroceryOrderRunDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data, isLoading, error } = useQuery<RunDetailResponse>({
    queryKey: ['/api/grocery-order/runs', id],
    queryFn: () => apiClient.get(`/api/grocery-order/runs/${id}`),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl">
          <div className="container flex h-12 md:h-14 items-center gap-4">
            <Skeleton className="h-8 w-8 rounded-md" />
            <Skeleton className="h-5 w-40" />
          </div>
        </header>
        <main className="container py-6 space-y-4 max-w-3xl">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </main>
      </div>
    );
  }

  if (error || !data?.run) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Run not found or failed to load.</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/common-tasks/grocery')}>
          Back to Grocery
        </Button>
      </div>
    );
  }

  const { run, items, audit } = data;

  const grouped = items.reduce<Record<string, GroceryOrderItem[]>>((acc, item) => {
    const cat = item.category || 'general';
    (acc[cat] = acc[cat] || []).push(item);
    return acc;
  }, {});
  const sortedCategories = sortCategories(Object.keys(grouped));

  const total = items.reduce((sum, item) => {
    const p = toPrice(item.unit_price);
    if (p != null) return sum + p * item.quantity;
    return sum;
  }, 0);

  const delivDate = run.delivery_date
    ? new Date(run.delivery_date + 'T00:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    : null;

  const lockDate = run.cycle_lock_at
    ? new Date(run.cycle_lock_at).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
      })
    : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/common-tasks/grocery')}
            data-testid="button-run-detail-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold font-display">Order History</h1>
            {delivDate && (
              <p className="text-xs text-muted-foreground">Delivery: {delivDate}</p>
            )}
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-6 max-w-3xl pb-12">
        <div className="rounded-xl border border-border/60 bg-card p-5 space-y-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl janus-gradient shrink-0">
              <span className="text-xl font-black font-display text-primary-foreground leading-none">34</span>
            </div>
            <div>
              <h2 className="text-lg font-bold font-display">Order Run</h2>
              <p className="text-xs text-muted-foreground">
                {lockDate ? `Cycle ended ${lockDate}` : 'Historical run'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <Badge variant="secondary" className="text-xs">
              {items.length} item{items.length !== 1 ? 's' : ''}
            </Badge>
            {total > 0 && (
              <Badge variant="outline" className="text-xs font-mono">
                Total: ${total.toFixed(2)}
              </Badge>
            )}
            {run.auto_ordered && (
              <Badge variant="outline" className="text-xs">Auto-ordered</Badge>
            )}
          </div>
          {run.submission_log && typeof run.submission_log === 'object' && (run.submission_log as Record<string, unknown>).order_id && (
            <p className="text-xs text-muted-foreground">
              Amazon order #{String((run.submission_log as Record<string, unknown>).order_id)}
            </p>
          )}
        </div>

        {sortedCategories.length > 0 ? (
          <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
            <div className="px-4 pt-4 pb-2 border-b border-border/40">
              <h3 className="text-sm font-semibold font-display">Cart Items</h3>
            </div>
            <div className="p-3 space-y-4">
              {sortedCategories.map(cat => (
                <div key={cat} className="space-y-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">
                    {CATEGORIES[cat] ?? cat}
                  </h4>
                  <div className="space-y-0.5">
                    {grouped[cat].map(item => (
                      <ReadOnlyItemRow key={item.id} item={item} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-border/50 bg-card p-8 text-center text-muted-foreground">
            <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No items in this run</p>
          </div>
        )}

        {audit.length > 0 && (
          <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
            <div className="px-4 pt-4 pb-2 border-b border-border/40">
              <h3 className="text-sm font-semibold font-display">Audit Trail</h3>
            </div>
            <div className="p-4 space-y-1.5">
              {audit.map(entry => {
                const itemName = (entry.detail as Record<string, unknown>)?.name as string ?? 'item';
                const qty = entry.new_qty ?? entry.old_qty ?? 1;
                const actor = getActorLabel(entry.actor_user_id, user?.userId ?? '');
                const verb = getActionVerb(entry.action);
                return (
                  <p key={entry.id} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground/70">{actor}</span>{' '}
                    {verb} {qty} × {itemName} — {formatTimeAgo(entry.created_at)}
                  </p>
                );
              })}
            </div>
          </div>
        )}

        {run.submission_log && (
          <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
            <div className="px-4 pt-4 pb-2 border-b border-border/40">
              <h3 className="text-sm font-semibold font-display">Submission Log</h3>
            </div>
            <div className="p-4">
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                {JSON.stringify(run.submission_log, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
