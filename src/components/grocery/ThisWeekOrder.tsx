import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Lock, ShoppingCart, Clock, CheckCircle2, AlertTriangle, Ban, SkipForward, Plus } from 'lucide-react';
import { apiClient } from '@/lib/apiClient';
import { GroceryThumb } from '@/lib/groceryImage';
import { useAuth } from '@/hooks/useAuth';
import { useSocketEvent } from '@/hooks/useRealtimeSocket';
import { useToast } from '@/hooks/use-toast';

const CATEGORY_ORDER = ['produce', 'dairy', 'bakery'];

const CATEGORIES: Record<string, string> = {
  produce: 'Produce',
  dairy: 'Dairy',
  bakery: 'Bakery',
  meat: 'Meat',
  beverages: 'Beverages',
  snacks: 'Snacks',
  frozen: 'Frozen',
  pantry: 'Pantry',
  household: 'Household',
  'personal-care': 'Personal Care',
  general: 'General',
};

export interface GroceryRun {
  id: string;
  status: 'open' | 'locked' | 'submitted' | 'skipped' | 'cancelled';
  item_count: number;
  cycle_start_at: string;
  cycle_lock_at: string;
  delivery_date: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  locked_at?: string | null;
  submitted_at?: string | null;
  submission_log?: unknown;
  auto_ordered?: boolean;
}

export interface GroceryOrderItem {
  id: string;
  run_id: string;
  staple_id: string | null;
  amazon_asin: string | null;
  name: string;
  category: string;
  brand: string | null;
  size: string | null;
  image_url: string | null;
  unit_price: number | null;
  quantity: number;
  added_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

interface GroceryStaple {
  id: string;
  name: string;
  brand: string | null;
  size: string | null;
  default_quantity: number;
  category: string;
  amazon_asin: string | null;
  amazon_url: string | null;
  image_url: string | null;
  unit_price: number | null;
  is_active: boolean;
}

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

interface CurrentCycleResponse {
  run: GroceryRun;
  items: GroceryOrderItem[];
  audit: AuditRow[];
}

/**
 * A merged row that combines a catalog staple with its current run item.
 * inRun=false means this staple has no run item yet (qty=0).
 */
interface MergedRow {
  staple: GroceryStaple;
  runItem: GroceryOrderItem | null;
  quantity: number;
  /** True if there's a real grocery_order_items row for this staple in the current run */
  inRun: boolean;
}

function formatCountdown(lockAt: string): string {
  const diff = new Date(lockAt).getTime() - Date.now();
  if (diff <= 0) return 'Locked';
  const totalSecs = Math.floor(diff / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (days > 0) return `Locks in ${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `Locks in ${hours}h ${mins}m`;
  return `Locks in ${mins}m`;
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

function formatCycleSubline(run: GroceryRun): string {
  const lockFormatted = run?.cycle_lock_at
    ? new Date(run.cycle_lock_at).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    : '—';
  const deliveryFormatted = run?.delivery_date
    ? new Date(run.delivery_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    : '—';
  return `Opens Saturday · closes ${lockFormatted} 4:00 PM PT · delivers ${deliveryFormatted}`;
}

function formatDeliveryDate(run: GroceryRun): string {
  if (!run.delivery_date) return 'this cycle';
  return new Date(run.delivery_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function toPrice(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function computeTotal(rows: MergedRow[]): number {
  return rows.reduce((sum, row) => {
    const price = toPrice(row.runItem?.unit_price ?? row.staple.unit_price);
    if (price != null && row.quantity > 0) return sum + price * row.quantity;
    return sum;
  }, 0);
}

function sortCategories(categories: string[]): string[] {
  const priority = new Map(CATEGORY_ORDER.map((c, i) => [c, i]));
  return [...categories].sort((a, b) => {
    const pa = priority.has(a) ? priority.get(a)! : 99;
    const pb = priority.has(b) ? priority.get(b)! : 99;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

interface HouseholdMember {
  id: string;
  display_name: string;
  supabase_uuid: string | null;
  role: string;
  is_active: boolean;
}

function getMemberName(actorUserId: string | null, currentUserId: string, memberMap: Map<string, HouseholdMember>): string {
  if (!actorUserId) return 'System';
  if (actorUserId === currentUserId) return 'You';
  const member = memberMap.get(actorUserId);
  if (member) return member.display_name.split(' ')[0];
  return 'Household';
}

function getMemberInitials(actorUserId: string | null, memberMap: Map<string, HouseholdMember>): string {
  if (!actorUserId) return '?';
  const member = memberMap.get(actorUserId);
  if (member) {
    const parts = member.display_name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  return actorUserId.slice(0, 2).toUpperCase();
}

function getActionVerb(action: AuditRow['action']): string {
  if (action === 'added') return 'added';
  if (action === 'qty_changed') return 'changed';
  return 'removed';
}

interface StepperProps {
  row: MergedRow;
  runId: string;
  currentUserId: string;
  disabled: boolean;
  onOptimisticUpdate: (stapleId: string, newQty: number) => void;
  onRollback: (stapleId: string, oldQty: number) => void;
  onRefresh: () => void;
}

function Stepper({ row, runId, currentUserId, disabled, onOptimisticUpdate, onRollback, onRefresh }: StepperProps) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const { staple, runItem, quantity, inRun } = row;

  const handleChange = async (delta: number) => {
    if (pending || disabled) return;
    const newQty = quantity + delta;
    onOptimisticUpdate(staple.id, newQty);
    setPending(true);
    try {
      if (!inRun) {
        if (newQty > 0) {
          await apiClient.post('/api/grocery-order/items', {
            runId,
            stapleId: staple.id,
            quantity: newQty,
          });
        }
      } else if (runItem) {
        await apiClient.patch(`/api/grocery-order/items/${runItem.id}`, { quantity: newQty });
      }
      onRefresh();
    } catch {
      onRollback(staple.id, quantity);
      toast({ title: 'Update failed', description: 'Could not update quantity', variant: 'destructive' });
    } finally {
      setPending(false);
    }
  };

  const isPicked = quantity > 0;
  const itemId = runItem?.id ?? staple.id;

  return (
    <div
      className={`flex items-center gap-1 rounded-lg p-0.5 transition-all ${
        isPicked ? 'janus-gradient janus-glow-soft' : 'bg-secondary'
      }`}
      data-testid={`stepper-${itemId}`}
    >
      <button
        className="flex items-center justify-center w-7 h-7 rounded-md bg-background/80 text-foreground hover:bg-background transition-colors disabled:opacity-50 min-w-[28px] min-h-[28px]"
        onClick={() => handleChange(-1)}
        disabled={disabled || pending || quantity === 0}
        aria-label={`Decrease ${staple.name} quantity`}
        data-testid={`stepper-${itemId}-minus`}
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="text-sm font-bold">−</span>}
      </button>
      <span
        className={`w-6 text-center text-sm font-bold select-none ${
          isPicked ? 'text-primary-foreground' : 'text-foreground'
        }`}
      >
        {quantity}
      </span>
      <button
        className="flex items-center justify-center w-7 h-7 rounded-md bg-background/80 text-foreground hover:bg-background transition-colors disabled:opacity-50 min-w-[28px] min-h-[28px]"
        onClick={() => handleChange(1)}
        disabled={disabled || pending}
        aria-label={`Increase ${staple.name} quantity`}
        data-testid={`stepper-${itemId}-plus`}
      >
        {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <span className="text-sm font-bold">+</span>}
      </button>
    </div>
  );
}

interface ItemRowProps {
  row: MergedRow;
  runId: string;
  currentUserId: string;
  memberMap: Map<string, HouseholdMember>;
  readonly: boolean;
  onOptimisticUpdate: (stapleId: string, newQty: number) => void;
  onRollback: (stapleId: string, oldQty: number) => void;
  onRefresh: () => void;
}

function ItemRow({ row, runId, currentUserId, memberMap, readonly, onOptimisticUpdate, onRollback, onRefresh }: ItemRowProps) {
  const { staple, runItem, quantity } = row;
  const isPicked = quantity > 0;
  const price = toPrice(runItem?.unit_price ?? staple.unit_price);
  const lineTotal = price != null && quantity > 1 ? `$${(price * quantity).toFixed(2)}` : null;
  const altText = [staple.brand, staple.name, staple.size].filter(Boolean).join(' ');
  const rowId = staple.amazon_asin ?? staple.id;
  const editorId = runItem?.added_by_user_id ?? null;
  const editorLabel = editorId ? getMemberName(editorId, currentUserId, memberMap) : null;
  const editorInitials = editorId ? getMemberInitials(editorId, memberMap) : null;

  return (
    <div
      className={`flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 rounded-lg transition-all ${
        isPicked
          ? 'bg-primary/[0.07] dark:bg-primary/10 border border-primary/20'
          : 'hover:bg-muted/40 border border-transparent'
      }`}
      data-testid={`grocery-row-${rowId}`}
    >
      <GroceryThumb
        imageUrl={staple.image_url}
        alt={altText}
        href={staple.amazon_url || (staple.amazon_asin ? `https://www.amazon.com/dp/${staple.amazon_asin}` : null)}
        wrapperClassName="flex items-center justify-center w-14 h-14 rounded-md overflow-hidden bg-muted/60 shrink-0"
        testId={`grocery-thumb-${rowId}`}
      />

      <div className="flex-1 min-w-0">
        {staple.brand && (
          <p className="text-xs text-accent font-medium truncate">{staple.brand}</p>
        )}
        <p className="text-sm font-medium leading-tight">{staple.name}</p>
        {staple.size && (
          <p className="text-xs text-muted-foreground">{staple.size}</p>
        )}
      </div>

      <div className="text-right hidden sm:block w-16 shrink-0">
        {price != null && (
          <p className="text-sm font-mono">${price.toFixed(2)}</p>
        )}
        {lineTotal && (
          <p className="text-xs text-muted-foreground font-mono">{lineTotal}</p>
        )}
      </div>

      <div className="hidden md:flex items-center gap-1.5 w-24 shrink-0">
        {editorLabel ? (
          <>
            <Avatar className="w-5 h-5 shrink-0">
              <AvatarFallback className="text-[9px] bg-primary/15 text-primary">{editorInitials}</AvatarFallback>
            </Avatar>
            <span className="text-xs text-muted-foreground truncate">{editorLabel}</span>
          </>
        ) : null}
      </div>

      <div className="flex items-center justify-end shrink-0">
        {readonly ? (
          <span className="text-sm font-medium text-muted-foreground px-2">×{quantity}</span>
        ) : (
          <Stepper
            row={row}
            runId={runId}
            currentUserId={currentUserId}
            disabled={readonly}
            onOptimisticUpdate={onOptimisticUpdate}
            onRollback={onRollback}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </div>
  );
}

interface CategoryGroupProps {
  category: string;
  rows: MergedRow[];
  runId: string;
  currentUserId: string;
  memberMap: Map<string, HouseholdMember>;
  readonly: boolean;
  onOptimisticUpdate: (stapleId: string, newQty: number) => void;
  onRollback: (stapleId: string, oldQty: number) => void;
  onRefresh: () => void;
}

function CategoryGroup({ category, rows, runId, currentUserId, memberMap, readonly, onOptimisticUpdate, onRollback, onRefresh }: CategoryGroupProps) {
  const pickedCount = rows.filter(r => r.quantity > 0).length;
  const catTotal = rows.reduce((sum, r) => {
    const price = toPrice(r.runItem?.unit_price ?? r.staple.unit_price);
    if (price != null && r.quantity > 0) return sum + price * r.quantity;
    return sum;
  }, 0);

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between px-2 pt-2 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground font-display">
          {CATEGORIES[category] ?? category} ({rows.length})
        </h3>
        {pickedCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {pickedCount} picked{catTotal > 0 ? ` · $${catTotal.toFixed(2)}` : ''}
          </p>
        )}
      </div>
      {rows.map(row => (
        <ItemRow
          key={row.staple.id}
          row={row}
          runId={runId}
          currentUserId={currentUserId}
          memberMap={memberMap}
          readonly={readonly}
          onOptimisticUpdate={onOptimisticUpdate}
          onRollback={onRollback}
          onRefresh={onRefresh}
        />
      ))}
    </div>
  );
}

interface AdhocItemForm {
  name: string;
  brand: string;
  quantity: number;
  category: string;
}

const DEFAULT_ADHOC_FORM: AdhocItemForm = {
  name: '',
  brand: '',
  quantity: 1,
  category: 'general',
};

interface ThisWeekOrderProps {
  onLockAndSubmit?: () => void;
}

export default function ThisWeekOrder({ onLockAndSubmit }: ThisWeekOrderProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [optimisticQtys, setOptimisticQtys] = useState<Record<string, number>>({});
  const [countdown, setCountdown] = useState('');
  const [locking, setLocking] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [showAdhocModal, setShowAdhocModal] = useState(false);
  const [adhocForm, setAdhocForm] = useState<AdhocItemForm>(DEFAULT_ADHOC_FORM);
  const [submittingAdhoc, setSubmittingAdhoc] = useState(false);

  const { data: cycleData, isLoading: cycleLoading, error: cycleError, refetch } = useQuery<CurrentCycleResponse>({
    queryKey: ['/api/grocery-order/current'],
    queryFn: () => apiClient.get('/api/grocery-order/current'),
    refetchInterval: 15000,
  });

  const { data: staplesData, isLoading: staplesLoading } = useQuery<{ staples: GroceryStaple[] }>({
    queryKey: ['/api/grocery-staples'],
    queryFn: () => apiClient.get('/api/grocery-staples'),
    staleTime: 60 * 1000,
  });

  const { data: membersData } = useQuery<{ members: HouseholdMember[] }>({
    queryKey: ['/api/data/household-members'],
    queryFn: () => apiClient.get('/api/data/household-members'),
    staleTime: 5 * 60 * 1000,
  });

  const memberMap = useMemo<Map<string, HouseholdMember>>(() => {
    const map = new Map<string, HouseholdMember>();
    for (const m of membersData?.members ?? []) {
      if (m.supabase_uuid) map.set(m.supabase_uuid, m);
    }
    return map;
  }, [membersData]);

  const { run, items: runItems = [], audit = [] } = cycleData ?? {};
  const allStaples = (staplesData?.staples ?? []).filter(s => s.is_active);

  const mergedRows = useMemo<MergedRow[]>(() => {
    const stapleById = new Map(allStaples.map(s => [s.id, s]));
    const seenStapleIds = new Set<string>();

    const runItemRows: MergedRow[] = runItems.map(item => {
      const matchedStaple = item.staple_id ? stapleById.get(item.staple_id) : undefined;
      if (item.staple_id) seenStapleIds.add(item.staple_id);

      const staple: GroceryStaple = matchedStaple ?? {
        id: item.staple_id ?? item.id,
        name: item.name,
        brand: item.brand ?? null,
        size: item.size ?? null,
        default_quantity: 1,
        category: item.category,
        amazon_asin: item.amazon_asin ?? null,
        amazon_url: null,
        image_url: item.image_url ?? null,
        unit_price: item.unit_price ?? null,
        is_active: true,
      };

      const rowKey = staple.id;
      const baseQty = item.quantity;
      const optimisticQty = optimisticQtys[rowKey];
      const quantity = optimisticQty !== undefined ? optimisticQty : baseQty;
      return { staple, runItem: item, quantity, inRun: true };
    });

    const catalogOnlyRows: MergedRow[] = allStaples
      .filter(s => !seenStapleIds.has(s.id))
      .map(s => {
        const optimisticQty = optimisticQtys[s.id];
        const quantity = optimisticQty !== undefined ? optimisticQty : 0;
        return { staple: s, runItem: null, quantity, inRun: false };
      });

    return [...runItemRows, ...catalogOnlyRows];
  }, [allStaples, runItems, optimisticQtys]);

  const handleOptimisticUpdate = useCallback((stapleId: string, newQty: number) => {
    setOptimisticQtys(prev => ({ ...prev, [stapleId]: Math.max(0, newQty) }));
  }, []);

  const handleRollback = useCallback((stapleId: string, oldQty: number) => {
    setOptimisticQtys(prev => ({ ...prev, [stapleId]: oldQty }));
  }, []);

  const handleRefresh = useCallback(() => {
    setOptimisticQtys({});
    queryClient.invalidateQueries({ queryKey: ['/api/grocery-order/current'] });
  }, [queryClient]);

  useSocketEvent('grocery:item-changed', () => {
    setOptimisticQtys({});
    queryClient.invalidateQueries({ queryKey: ['/api/grocery-order/current'] });
  });

  useSocketEvent('grocery:run-skipped', () => {
    queryClient.invalidateQueries({ queryKey: ['/api/grocery-order/current'] });
    queryClient.invalidateQueries({ queryKey: ['/api/grocery-order/runs'] });
  });

  useEffect(() => {
    if (!run?.cycle_lock_at) return;
    setCountdown(formatCountdown(run.cycle_lock_at));
    const id = setInterval(() => setCountdown(formatCountdown(run.cycle_lock_at)), 30000);
    return () => clearInterval(id);
  }, [run?.cycle_lock_at]);

  const handleResubmit = async () => {
    if (!run) return;
    setResubmitting(true);
    try {
      await apiClient.post(`/api/grocery-order/runs/${run.id}/resubmit`);
      toast({ title: 'Resubmitting', description: 'Order queued for resubmission.' });
      handleRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not resubmit order';
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setResubmitting(false);
    }
  };

  const handleLockEarly = async () => {
    if (!run) return;
    setLocking(true);
    try {
      await apiClient.post(`/api/grocery-order/runs/${run.id}/lock-early`);
      toast({ title: 'Order locked', description: 'Your order has been locked and queued for submission.' });
      handleRefresh();
      onLockAndSubmit?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not lock order';
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setLocking(false);
    }
  };

  const handleSkip = async () => {
    if (!run) return;
    setSkipping(true);
    try {
      await apiClient.post(`/api/grocery-order/runs/${run.id}/skip`);
      toast({ title: 'Week skipped', description: 'This cycle has been marked as skipped.' });
      setShowSkipConfirm(false);
      handleRefresh();
      queryClient.invalidateQueries({ queryKey: ['/api/grocery-order/runs'] });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not skip this week';
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setSkipping(false);
    }
  };

  const handleAdhocSubmit = async () => {
    if (!run || !adhocForm.name.trim()) return;
    setSubmittingAdhoc(true);
    try {
      await apiClient.post('/api/grocery-order/items/adhoc', {
        runId: run.id,
        name: adhocForm.name.trim(),
        brand: adhocForm.brand.trim() || null,
        quantity: adhocForm.quantity,
        category: adhocForm.category,
      });
      toast({ title: 'Item added', description: `${adhocForm.name} added to this week's order.` });
      setShowAdhocModal(false);
      setAdhocForm(DEFAULT_ADHOC_FORM);
      handleRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Could not add item';
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setSubmittingAdhoc(false);
    }
  };

  const isLoading = cycleLoading || staplesLoading;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  // Error state — show retry block
  if (cycleError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">Could not load this week's order.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  // No open cycle — calm empty state
  if (!run) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <ShoppingCart className="h-10 w-10 text-muted-foreground/40" />
        <p className="text-base font-semibold font-display">Next cycle opens Saturday morning.</p>
        <p className="text-sm text-muted-foreground">Nothing to pick right now — check back Saturday.</p>
        <button
          className="text-xs text-primary underline-offset-2 hover:underline mt-1"
          onClick={() => {
            const el = document.getElementById('past-orders');
            el?.scrollIntoView({ behavior: 'smooth' });
          }}
          data-testid="link-past-orders"
        >
          View Past Orders
        </button>
      </div>
    );
  }

  const isReadonly = run.status !== 'open';
  const pickedRows = mergedRows.filter(r => r.quantity > 0);
  const total = computeTotal(pickedRows);
  const totalDisplay = total > 0 ? `$${total.toFixed(2)}` : null;
  const isAdmin = user?.roles.includes('admin') ?? false;
  const canLockEarly = isAdmin && run.status === 'open' && pickedRows.length > 0;

  const grouped = mergedRows.reduce<Record<string, MergedRow[]>>((acc, row) => {
    const cat = row.staple.category || 'general';
    (acc[cat] = acc[cat] || []).push(row);
    return acc;
  }, {});
  const sortedCategories = sortCategories(Object.keys(grouped));

  const uniqueActors = [...new Set(
    runItems.map(i => i.added_by_user_id).filter((id): id is string => id != null)
  )];

  const showMobileStickyBar = run.status === 'open' && pickedRows.length > 0;

  return (
    <div className={`space-y-4 ${showMobileStickyBar ? 'pb-24 md:pb-4' : 'pb-4'}`}>
      {/* Hero card */}
      <div className="rounded-xl border border-border/60 bg-card p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl janus-gradient shrink-0">
              <span className="text-xl font-black font-display text-primary-foreground leading-none">34</span>
            </div>
            <div>
              <h2 className="text-xl font-bold font-display tracking-tight">This Week's Order</h2>
              <p className="text-xs text-muted-foreground mt-0.5">{formatCycleSubline(run)}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Skip this week — admin + open only */}
            {run.status === 'open' && isAdmin && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground h-8 px-2 text-xs gap-1"
                onClick={() => setShowSkipConfirm(true)}
                data-testid="button-skip-week"
              >
                <SkipForward className="h-3.5 w-3.5" />
                Skip week
              </Button>
            )}
            {uniqueActors.length > 0 && (
              <div className="flex -space-x-2" title={uniqueActors.map(id => getMemberName(id, user?.userId ?? '', memberMap)).join(', ')}>
                {uniqueActors.slice(0, 4).map(actorId => (
                  <Avatar key={actorId} className="w-7 h-7 border-2 border-background" title={getMemberName(actorId, user?.userId ?? '', memberMap)}>
                    <AvatarImage src={actorId === user?.userId ? (user?.avatarUrl ?? undefined) : undefined} />
                    <AvatarFallback className="text-[10px] bg-primary/20 text-primary">
                      {getMemberInitials(actorId, memberMap)}
                    </AvatarFallback>
                  </Avatar>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <RunStatusBadge status={run.status} />
          <Badge variant="secondary" className="text-xs">
            {pickedRows.length} item{pickedRows.length !== 1 ? 's' : ''} picked
            {totalDisplay ? ` · ${totalDisplay}` : ''}
          </Badge>
          {run.status === 'open' && (
            <Badge variant="outline" className="text-xs flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {countdown || formatCountdown(run.cycle_lock_at)}
            </Badge>
          )}
        </div>
      </div>

      {/* Status banners */}
      {run.status === 'locked' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 flex items-start gap-3">
          <Lock className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium">
              {run.submitted_at
                ? 'Order submitted Friday 4:00 PM. Delivering Monday.'
                : 'Cycle locked — pending submission.'}
            </p>
            {isAdmin && !run.submitted_at && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 border-amber-500/40 text-amber-700 dark:text-amber-400"
                onClick={handleResubmit}
                disabled={resubmitting}
                data-testid="button-resubmit"
              >
                {resubmitting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Resubmit
              </Button>
            )}
          </div>
        </div>
      )}

      {run.status === 'submitted' && (
        <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-4 flex items-start gap-3">
          <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">
              Order submitted Friday 4:00 PM. Delivering Monday morning.
            </p>
            {run.submission_log && typeof run.submission_log === 'object' &&
              (run.submission_log as Record<string, unknown>).order_id && (
              <p className="text-xs text-muted-foreground mt-1">
                Amazon order #{String((run.submission_log as Record<string, unknown>).order_id)}
              </p>
            )}
          </div>
        </div>
      )}

      {run.status === 'skipped' && (
        <div className="rounded-xl border border-muted/60 bg-muted/20 p-4 flex items-start gap-3">
          <Ban className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-sm text-muted-foreground">
            No order this week. Cart was empty at lock time. Next cycle opens Saturday.
          </p>
        </div>
      )}

      {/* Empty pick state */}
      {run.status === 'open' && pickedRows.length === 0 && (
        <div className="rounded-xl border border-border/50 bg-card p-8 text-center space-y-2">
          <ShoppingCart className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="font-semibold text-base font-display">Your week is wide open.</p>
          <p className="text-sm text-muted-foreground">
            Pick what you need — quantities start at 0.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            You have until Friday 4:00 PM. We'll email everyone Thursday with what's been picked.
          </p>
        </div>
      )}

      {/* Catalog rows grouped by category */}
      {sortedCategories.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
          {sortedCategories.map((cat, i) => (
            <div key={cat} className={i > 0 ? 'border-t border-border/40' : ''}>
              <CategoryGroup
                category={cat}
                rows={grouped[cat]}
                runId={run.id}
                currentUserId={user?.userId ?? ''}
                memberMap={memberMap}
                readonly={isReadonly}
                onOptimisticUpdate={handleOptimisticUpdate}
                onRollback={handleRollback}
                onRefresh={handleRefresh}
              />
            </div>
          ))}
        </div>
      )}

      {/* Add one-time item — admin, open run only */}
      {run.status === 'open' && isAdmin && (
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground gap-1.5 text-xs"
            onClick={() => { setAdhocForm(DEFAULT_ADHOC_FORM); setShowAdhocModal(true); }}
            data-testid="button-add-adhoc"
          >
            <Plus className="h-3.5 w-3.5" />
            Add one-time item
          </Button>
        </div>
      )}

      {/* Desktop lock button — md+ only */}
      {run.status === 'open' && (
        <div className="hidden md:flex justify-end">
          <Button
            size="sm"
            className="janus-gradient text-primary-foreground"
            disabled={!canLockEarly || locking}
            onClick={handleLockEarly}
            title={!isAdmin ? 'Only admins can lock the order early' : undefined}
            data-testid="button-lock-early-desktop"
          >
            {locking ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
            Lock & submit early
          </Button>
        </div>
      )}

      {/* Recent activity */}
      {audit.length > 0 && (
        <div className="pt-2 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">Recent Activity</h3>
          <div className="space-y-1">
            {audit.slice(0, 10).map(entry => {
              const itemName = (entry.detail as Record<string, unknown>)?.name as string ?? 'item';
              const qty = entry.new_qty ?? entry.old_qty ?? 1;
              const actor = getMemberName(entry.actor_user_id, user?.userId ?? '', memberMap);
              const verb = getActionVerb(entry.action);
              return (
                <p key={entry.id} className="text-xs text-muted-foreground px-1">
                  <span className="font-medium text-foreground/70">{actor}</span>{' '}
                  {verb} {qty} × {itemName} — {formatTimeAgo(entry.created_at)}
                </p>
              );
            })}
          </div>
        </div>
      )}

      {/* Mobile sticky bottom bar — md:hidden, only when items picked */}
      {showMobileStickyBar && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t border-border/60 bg-background/95 backdrop-blur-xl px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex items-center justify-between gap-4">
          <div aria-live="polite">
            <p className="text-sm font-semibold">
              {pickedRows.length} item{pickedRows.length !== 1 ? 's' : ''}{totalDisplay ? ` · ${totalDisplay}` : ''}
            </p>
            <p className="text-xs text-muted-foreground">{countdown}</p>
          </div>
          <div
            title={!isAdmin ? 'Only admins can lock the order early' : undefined}
          >
            <Button
              size="sm"
              className="janus-gradient text-primary-foreground"
              disabled={!isAdmin || locking}
              onClick={handleLockEarly}
              data-testid="button-lock-early-mobile"
            >
              {locking ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
              Lock & Submit
            </Button>
          </div>
        </div>
      )}

      {/* Skip confirmation dialog */}
      <Dialog open={showSkipConfirm} onOpenChange={setShowSkipConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Skip this week's order?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will mark the {formatDeliveryDate(run)} delivery as skipped. No order will be placed for this cycle.
          </p>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowSkipConfirm(false)} data-testid="button-skip-cancel">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleSkip}
              disabled={skipping}
              data-testid="button-skip-confirm"
            >
              {skipping ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Skip this week
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Ad-hoc item dialog */}
      <Dialog open={showAdhocModal} onOpenChange={setShowAdhocModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add one-time item</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="adhoc-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="adhoc-name"
                placeholder="e.g. Sparkling water"
                value={adhocForm.name}
                onChange={e => setAdhocForm(f => ({ ...f, name: e.target.value }))}
                data-testid="input-adhoc-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="adhoc-brand">Brand</Label>
              <Input
                id="adhoc-brand"
                placeholder="e.g. LaCroix"
                value={adhocForm.brand}
                onChange={e => setAdhocForm(f => ({ ...f, brand: e.target.value }))}
                data-testid="input-adhoc-brand"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="adhoc-quantity">Quantity</Label>
                <Input
                  id="adhoc-quantity"
                  type="number"
                  min={1}
                  value={adhocForm.quantity}
                  onChange={e => setAdhocForm(f => ({ ...f, quantity: Math.max(1, parseInt(e.target.value) || 1) }))}
                  data-testid="input-adhoc-quantity"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="adhoc-category">Category</Label>
                <Select
                  value={adhocForm.category}
                  onValueChange={v => setAdhocForm(f => ({ ...f, category: v }))}
                >
                  <SelectTrigger id="adhoc-category" data-testid="select-adhoc-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORIES).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setShowAdhocModal(false)} data-testid="button-adhoc-cancel">
              Cancel
            </Button>
            <Button
              onClick={handleAdhocSubmit}
              disabled={!adhocForm.name.trim() || submittingAdhoc}
              data-testid="button-adhoc-submit"
            >
              {submittingAdhoc ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Add item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function RunStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    open: { label: 'Open', className: 'bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30' },
    locked: { label: 'Locked', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' },
    submitted: { label: 'Submitted', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30' },
    skipped: { label: 'Skipped', className: 'bg-muted/60 text-muted-foreground border-border' },
    cancelled: { label: 'Cancelled', className: 'bg-destructive/15 text-destructive border-destructive/30' },
  };
  const c = config[status] ?? config.open;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${c.className}`}>
      {c.label}
    </span>
  );
}
