/**
 * Janus Time — Admin View
 * /time/admin
 *
 * Tabs: Approvals | Workers | Reports | Categories
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { apiClient } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';
import { JanusLogo } from '@/components/brand/JanusLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  CheckCircle2, XCircle, Clock3, DollarSign, Users, BarChart3,
  Tag, ChevronLeft, ChevronRight, Download, Plus, Pencil,
  ToggleLeft, ToggleRight, AlertCircle, X, ReceiptText
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
  active: boolean;
  sort_order: number;
}

interface TimeEntry {
  id: string;
  worker_id: string;
  work_date: string;
  category_id: string;
  category_name: string;
  hours: string;
  note: string | null;
  rate_cents: number;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  rejected_reason: string | null;
  is_adjustment: boolean;
}

interface Expense {
  id: string;
  expense_date: string;
  amount_cents: number;
  note: string;
  category_name: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  rejected_reason: string | null;
}

interface WorkerOverview {
  worker: {
    id: string;
    full_name: string;
    email: string;
    active: boolean;
    can_add_expenses: boolean;
    current_rate_cents: string | null;
    unpaid_labor_cents: string | null;
    unpaid_expense_cents: string | null;
    categories: Category[];
  };
  weekStart: string;
  weekEnd: string;
  entries: Array<{ status: string; cnt: string; hours: string; labor_cents: string }>;
  expenses: Array<{ status: string; cnt: string; amount_cents: string }>;
  payment: PaymentRecord | null;
  totalPendingCount: number;
}

interface PaymentRecord {
  id: string;
  week_start: string;
  hours_total: string;
  labor_cents: number;
  expenses_cents: number;
  total_cents: number;
  paid_at: string;
  confirmation_ref: string | null;
}

interface RateHistory {
  id: string;
  hourly_rate_cents: number;
  effective_from: string;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric',
  });
}

function formatMoney(cents: number | string) {
  const v = typeof cents === 'string' ? parseFloat(cents) : cents;
  return `$${(v / 100).toFixed(2)}`;
}

function getWeekStart(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  const diff = dow === 0 ? 6 : dow - 1;
  date.setUTCDate(date.getUTCDate() - diff);
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function statusColor(status: string) {
  switch (status) {
    case 'approved': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    case 'rejected': return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'paid': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    default: return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border', statusColor(status))}>
      {status === 'approved' && <CheckCircle2 className="h-3 w-3" />}
      {status === 'rejected' && <XCircle className="h-3 w-3" />}
      {status === 'paid' && <DollarSign className="h-3 w-3" />}
      {status === 'pending' && <Clock3 className="h-3 w-3" />}
      {status}
    </span>
  );
}

function todayPT() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
}

// ── Week Selector (shared) ────────────────────────────────────────────────

function WeekSelector({
  weekStart,
  onPrev,
  onNext,
  canNext,
}: { weekStart: string; onPrev: () => void; onNext: () => void; canNext: boolean }) {
  const weekEnd = addDays(weekStart, 6);
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onPrev} data-testid="btn-admin-prev-week">
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <span className="text-sm font-medium text-foreground">
        {formatDate(weekStart)} – {formatDate(weekEnd)}
      </span>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onNext} disabled={!canNext} data-testid="btn-admin-next-week">
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

// ── Reject Dialog ─────────────────────────────────────────────────────────

function RejectDialog({
  onConfirm,
  onCancel,
}: { onConfirm: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-sm p-5 space-y-4">
        <h2 className="text-base font-semibold text-foreground">Reject Entries</h2>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Reason *</Label>
          <Textarea
            placeholder="Explain why these entries are being rejected…"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="resize-none"
            data-testid="input-reject-reason"
          />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button
            variant="destructive"
            className="flex-1"
            onClick={() => { if (reason.trim()) onConfirm(reason.trim()); }}
            disabled={!reason.trim()}
            data-testid="btn-confirm-reject"
          >
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Pay Dialog ────────────────────────────────────────────────────────────

interface PayPreview {
  hoursTotal: number;
  laborCents: number;
  expensesCents: number;
  totalCents: number;
  pendingCount: number;
  canPay: boolean;
  suggestedMemo: string;
  worker: { full_name: string; zelle_handle: string | null };
}

function PayDialog({
  preview,
  workerId,
  weekStart,
  onPaid,
  onClose,
}: {
  preview: PayPreview;
  workerId: string;
  weekStart: string;
  onPaid: () => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [confirmRef, setConfirmRef] = useState('');
  const [note, setNote] = useState('');
  const [paying, setPaying] = useState(false);

  async function handlePay() {
    setPaying(true);
    try {
      await apiClient.post('/api/time/admin/payments', {
        worker_id: workerId,
        week_start: weekStart,
        confirmation_ref: confirmRef || undefined,
        note: note || undefined,
      });
      toast({ title: `Paid ${formatMoney(preview.totalCents)} to ${preview.worker.full_name}` });
      onPaid();
      onClose();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Payment failed', variant: 'destructive' });
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-sm p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Mark as Paid</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="rounded-lg bg-muted/50 p-3 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Worker</span>
            <span className="font-medium">{preview.worker.full_name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Hours</span>
            <span>{preview.hoursTotal.toFixed(2)}h</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Labor</span>
            <span>{formatMoney(preview.laborCents)}</span>
          </div>
          {preview.expensesCents > 0 && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Expenses</span>
              <span>{formatMoney(preview.expensesCents)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-border pt-1 font-bold">
            <span>Total</span>
            <span className="text-primary">{formatMoney(preview.totalCents)}</span>
          </div>
          {preview.worker.zelle_handle && (
            <div className="flex justify-between text-xs text-muted-foreground pt-1">
              <span>Zelle</span>
              <span>{preview.worker.zelle_handle}</span>
            </div>
          )}
        </div>

        <div className="bg-muted/30 rounded-lg px-3 py-2 text-xs text-muted-foreground font-mono">
          {preview.suggestedMemo}
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Zelle Confirmation Ref (optional)</Label>
          <Input
            placeholder="e.g. ZELLE_ABC123"
            value={confirmRef}
            onChange={(e) => setConfirmRef(e.target.value)}
            data-testid="input-confirm-ref"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Note (optional)</Label>
          <Input
            placeholder="Any note about this payment"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="input-pay-note"
          />
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" onClick={handlePay} disabled={paying} data-testid="btn-confirm-pay">
            {paying ? 'Processing…' : 'Confirm Payment'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Worker Detail Sheet ────────────────────────────────────────────────────

function WorkerDetailSheet({
  workerId,
  weekStart,
  onClose,
  onRefresh,
}: { workerId: string; weekStart: string; onClose: () => void; onRefresh: () => void }) {
  const { toast } = useToast();
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [selectedEntryIds, setSelectedEntryIds] = useState<string[]>([]);
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [payPreview, setPayPreview] = useState<PayPreview | null>(null);
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [bulkActioning, setBulkActioning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ entries: TimeEntry[]; expenses: Expense[] }>(
        `/api/time/admin/entries?week=${weekStart}&worker_id=${workerId}`
      );
      setEntries(data.entries);
      setExpenses(data.expenses);
    } catch {
      toast({ title: 'Failed to load entries', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [workerId, weekStart, toast]);

  useEffect(() => { void load(); }, [load]);

  const pendingEntries = entries.filter((e) => e.status === 'pending');
  const pendingExpenses = expenses.filter((e) => e.status === 'pending');
  const allPendingEntryIds = pendingEntries.map((e) => e.id);
  const allPendingExpenseIds = pendingExpenses.map((e) => e.id);
  const allSelected = allPendingEntryIds.every((id) => selectedEntryIds.includes(id)) &&
    allPendingExpenseIds.every((id) => selectedExpenseIds.includes(id));

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedEntryIds([]);
      setSelectedExpenseIds([]);
    } else {
      setSelectedEntryIds(allPendingEntryIds);
      setSelectedExpenseIds(allPendingExpenseIds);
    }
  }

  async function doAction(action: 'approve' | 'reject' | 'unapprove', reason?: string) {
    const entryIds = action === 'unapprove'
      ? entries.filter((e) => e.status === 'approved').map((e) => e.id)
      : selectedEntryIds;
    const expenseIds = action === 'unapprove'
      ? expenses.filter((e) => e.status === 'approved').map((e) => e.id)
      : selectedExpenseIds;

    if (entryIds.length === 0 && expenseIds.length === 0) {
      toast({ title: 'Nothing to ' + action, variant: 'destructive' });
      return;
    }
    setBulkActioning(true);
    try {
      await apiClient.post('/api/time/admin/entries/status', {
        entry_ids: entryIds.length > 0 ? entryIds : undefined,
        expense_ids: expenseIds.length > 0 ? expenseIds : undefined,
        action,
        reason,
      });
      toast({ title: `${action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Unapproved'} successfully` });
      setSelectedEntryIds([]);
      setSelectedExpenseIds([]);
      await load();
      onRefresh();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Action failed', variant: 'destructive' });
    } finally {
      setBulkActioning(false);
    }
  }

  async function loadPayPreview() {
    try {
      const data = await apiClient.get<PayPreview>(
        `/api/time/admin/payments/preview?worker_id=${workerId}&week=${weekStart}`
      );
      setPayPreview(data);
      setShowPayDialog(true);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Failed to load payment preview', variant: 'destructive' });
    }
  }

  const approvedEntries = entries.filter((e) => e.status === 'approved');
  const approvedExpenses = expenses.filter((e) => e.status === 'approved');
  const approvedLaborCents = approvedEntries.reduce((s, e) => s + parseFloat(e.hours) * e.rate_cents, 0);
  const approvedExpCents = approvedExpenses.reduce((s, e) => s + e.amount_cents, 0);

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-40 flex justify-end" onClick={onClose}>
        <div
          className="bg-background border-l border-border w-full max-w-md h-full overflow-y-auto flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 bg-background border-b border-border px-4 py-3 flex items-center justify-between z-10">
            <h2 className="text-sm font-semibold">Entries for week of {formatDate(weekStart)}</h2>
            <button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
          </div>

          {/* Bulk actions */}
          {(pendingEntries.length > 0 || pendingExpenses.length > 0) && (
            <div className="px-4 py-3 border-b border-border space-y-2">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="rounded"
                    data-testid="chk-select-all"
                  />
                  Select all pending ({allPendingEntryIds.length + allPendingExpenseIds.length})
                </label>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1 gap-1 bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => void doAction('approve')}
                  disabled={bulkActioning || (selectedEntryIds.length === 0 && selectedExpenseIds.length === 0)}
                  data-testid="btn-bulk-approve"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="flex-1 gap-1"
                  onClick={() => setShowRejectDialog(true)}
                  disabled={bulkActioning || (selectedEntryIds.length === 0 && selectedExpenseIds.length === 0)}
                  data-testid="btn-bulk-reject"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Reject
                </Button>
              </div>
            </div>
          )}

          {/* Entries list */}
          <div className="flex-1 px-4 py-3 space-y-2">
            {loading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
            ) : entries.length === 0 && expenses.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center italic">No entries this week</p>
            ) : (
              <>
                {entries.map((entry) => {
                  const hours = parseFloat(entry.hours);
                  const amount = hours * (entry.rate_cents / 100);
                  const isPending = entry.status === 'pending';
                  return (
                    <div
                      key={entry.id}
                      className={cn(
                        'rounded-lg border p-3 space-y-1.5 transition-colors',
                        isPending && selectedEntryIds.includes(entry.id) ? 'border-primary/50 bg-primary/5' : 'border-border bg-card/50'
                      )}
                      data-testid={`admin-entry-${entry.id}`}
                    >
                      <div className="flex items-start gap-2">
                        {isPending && (
                          <input
                            type="checkbox"
                            checked={selectedEntryIds.includes(entry.id)}
                            onChange={(e) => {
                              setSelectedEntryIds((prev) =>
                                e.target.checked ? [...prev, entry.id] : prev.filter((id) => id !== entry.id)
                              );
                            }}
                            className="rounded mt-0.5"
                            data-testid={`chk-entry-${entry.id}`}
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-muted-foreground">{formatDate(entry.work_date)}</span>
                            <span className="text-sm font-medium text-foreground">{entry.category_name}</span>
                            {entry.is_adjustment && <Badge variant="outline" className="text-[10px] py-0">adj</Badge>}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{hours.toFixed(2)}h</span>
                            <span>${(entry.rate_cents / 100).toFixed(2)}/hr</span>
                            <span>≈ ${amount.toFixed(2)}</span>
                          </div>
                          {entry.note && <p className="text-xs text-muted-foreground mt-1">{entry.note}</p>}
                          {entry.rejected_reason && (
                            <p className="text-xs text-red-400 mt-1">Rejected: {entry.rejected_reason}</p>
                          )}
                        </div>
                        <StatusBadge status={entry.status} />
                      </div>
                    </div>
                  );
                })}

                {expenses.map((expense) => {
                  const isPending = expense.status === 'pending';
                  return (
                    <div
                      key={expense.id}
                      className={cn(
                        'rounded-lg border p-3 space-y-1.5',
                        isPending && selectedExpenseIds.includes(expense.id) ? 'border-primary/50 bg-primary/5' : 'border-border bg-card/50'
                      )}
                      data-testid={`admin-expense-${expense.id}`}
                    >
                      <div className="flex items-start gap-2">
                        {isPending && (
                          <input
                            type="checkbox"
                            checked={selectedExpenseIds.includes(expense.id)}
                            onChange={(e) => {
                              setSelectedExpenseIds((prev) =>
                                e.target.checked ? [...prev, expense.id] : prev.filter((id) => id !== expense.id)
                              );
                            }}
                            className="rounded mt-0.5"
                          />
                        )}
                        <ReceiptText className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">{formatDate(expense.expense_date)}</span>
                            <span className="text-sm font-semibold text-foreground">{formatMoney(expense.amount_cents)}</span>
                          </div>
                          <p className="text-xs text-muted-foreground">{expense.note}</p>
                        </div>
                        <StatusBadge status={expense.status} />
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {/* Footer: approved summary + pay button */}
          {(approvedEntries.length > 0 || approvedExpenses.length > 0) && (
            <div className="sticky bottom-0 bg-background border-t border-border px-4 py-3 space-y-3">
              <div className="text-xs text-muted-foreground space-y-1">
                <div className="flex justify-between">
                  <span>Approved labor</span>
                  <span className="text-foreground">{formatMoney(Math.round(approvedLaborCents))}</span>
                </div>
                {approvedExpCents > 0 && (
                  <div className="flex justify-between">
                    <span>Approved expenses</span>
                    <span className="text-foreground">{formatMoney(approvedExpCents)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-sm text-foreground border-t border-border pt-1">
                  <span>Total</span>
                  <span>{formatMoney(Math.round(approvedLaborCents) + approvedExpCents)}</span>
                </div>
              </div>
              {pendingEntries.length > 0 && (
                <div className="text-xs text-amber-400 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" /> {pendingEntries.length} pending {pendingEntries.length === 1 ? 'entry' : 'entries'} — approve or reject before paying
                </div>
              )}
              <div className="flex gap-2">
                {approvedEntries.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1 text-xs"
                    onClick={() => void doAction('unapprove')}
                    disabled={bulkActioning}
                    data-testid="btn-unapprove"
                  >
                    Unapprove all
                  </Button>
                )}
                <Button
                  size="sm"
                  className="flex-1 gap-1"
                  onClick={() => void loadPayPreview()}
                  disabled={pendingEntries.length > 0 || approvedEntries.length === 0}
                  data-testid="btn-open-pay"
                >
                  <DollarSign className="h-3.5 w-3.5" />
                  Mark as Paid
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showRejectDialog && (
        <RejectDialog
          onConfirm={(reason) => { setShowRejectDialog(false); void doAction('reject', reason); }}
          onCancel={() => setShowRejectDialog(false)}
        />
      )}

      {showPayDialog && payPreview && (
        <PayDialog
          preview={payPreview}
          workerId={workerId}
          weekStart={weekStart}
          onPaid={onRefresh}
          onClose={() => setShowPayDialog(false)}
        />
      )}
    </>
  );
}

// ── Approvals Tab ─────────────────────────────────────────────────────────

function ApprovalsTab() {
  const today = todayPT();
  const [weekStart, setWeekStart] = useState(() => getWeekStart(today));
  const [workers, setWorkers] = useState<WorkerOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailWorkerId, setDetailWorkerId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ workers: WorkerOverview[] }>(
        `/api/time/admin/overview?week=${weekStart}`
      );
      setWorkers(data.workers);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [weekStart]);

  useEffect(() => { void load(); }, [load]);

  const canNext = weekStart < getWeekStart(today);
  const totalPending = workers.reduce((s, w) => s + w.totalPendingCount, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <WeekSelector
          weekStart={weekStart}
          onPrev={() => setWeekStart((prev) => addDays(prev, -7))}
          onNext={() => setWeekStart((prev) => addDays(prev, 7))}
          canNext={canNext}
        />
        {totalPending > 0 && (
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs">
            {totalPending} pending
          </Badge>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading…</div>
        ) : workers.filter((w) => w.worker.active).length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">No active workers</div>
        ) : (
          workers.filter((w) => w.worker.active).map((wo) => {
            const entry = wo.entries.find((e) => e.status === 'pending');
            const pendingHours = entry ? parseFloat(entry.hours ?? '0') : 0;
            const pendingCount = wo.totalPendingCount;
            const approvedEntry = wo.entries.find((e) => e.status === 'approved');
            const approvedHours = approvedEntry ? parseFloat(approvedEntry.hours ?? '0') : 0;
            const paid = !!wo.payment;

            return (
              <button
                key={wo.worker.id}
                className="w-full rounded-xl border border-border bg-card p-4 text-left hover:border-primary/50 transition-colors"
                onClick={() => setDetailWorkerId(wo.worker.id)}
                data-testid={`worker-card-${wo.worker.id}`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{wo.worker.full_name}</p>
                    <p className="text-xs text-muted-foreground">{wo.worker.email}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {paid && <Badge className="text-[10px] py-0 bg-blue-500/20 text-blue-400 border-blue-500/30">Paid</Badge>}
                    {pendingCount > 0 && <Badge className="text-[10px] py-0 bg-amber-500/20 text-amber-400 border-amber-500/30">{pendingCount} pending</Badge>}
                    {!paid && approvedHours > 0 && pendingCount === 0 && <Badge className="text-[10px] py-0 bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Ready to pay</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  {pendingHours > 0 && <span className="text-amber-400">{pendingHours.toFixed(2)}h pending</span>}
                  {approvedHours > 0 && <span className="text-emerald-400">{approvedHours.toFixed(2)}h approved</span>}
                  {paid && wo.payment && <span className="text-blue-400">{formatMoney(wo.payment.total_cents)} paid</span>}
                </div>
              </button>
            );
          })
        )}
      </div>

      {detailWorkerId && (
        <WorkerDetailSheet
          workerId={detailWorkerId}
          weekStart={weekStart}
          onClose={() => setDetailWorkerId(null)}
          onRefresh={load}
        />
      )}
    </div>
  );
}

// ── Workers Tab ────────────────────────────────────────────────────────────

interface WorkerFull {
  id: string;
  full_name: string;
  email: string;
  mobile: string | null;
  zelle_handle: string | null;
  can_add_expenses: boolean;
  active: boolean;
  current_rate_cents: string | null;
  unpaid_labor_cents: string | null;
  unpaid_expense_cents: string | null;
  categories: Category[];
}

function AddWorkerDialog({
  categories,
  onCreated,
  onClose,
}: { categories: Category[]; onCreated: () => void; onClose: () => void }) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    mobile: '',
    zelle_handle: '',
    can_add_expenses: false,
    hourly_rate_cents: '',
    effective_from: todayPT(),
    category_ids: [] as string[],
  });

  function toggleCat(id: string) {
    setForm((prev) => ({
      ...prev,
      category_ids: prev.category_ids.includes(id)
        ? prev.category_ids.filter((c) => c !== id)
        : [...prev.category_ids, id],
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.full_name || !form.email || !form.hourly_rate_cents) {
      toast({ title: 'Name, email, and hourly rate required', variant: 'destructive' });
      return;
    }
    const rateCents = Math.round(parseFloat(form.hourly_rate_cents) * 100);
    if (isNaN(rateCents) || rateCents <= 0) {
      toast({ title: 'Enter a valid hourly rate', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await apiClient.post('/api/time/admin/workers', {
        ...form,
        hourly_rate_cents: rateCents,
      });
      toast({ title: `Worker ${form.full_name} created. Welcome email sent.` });
      onCreated();
      onClose();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Failed to create worker', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Add Worker</h2>
          <button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">Full Name *</Label>
              <Input value={form.full_name} onChange={(e) => setForm((p) => ({ ...p, full_name: e.target.value }))} data-testid="input-worker-name" required />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs text-muted-foreground">Email *</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} data-testid="input-worker-email" required />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Mobile</Label>
              <Input value={form.mobile} onChange={(e) => setForm((p) => ({ ...p, mobile: e.target.value }))} data-testid="input-worker-mobile" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Zelle</Label>
              <Input value={form.zelle_handle} onChange={(e) => setForm((p) => ({ ...p, zelle_handle: e.target.value }))} data-testid="input-worker-zelle" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Hourly Rate ($/hr) *</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
                <Input type="number" step="0.01" min="1" placeholder="0.00" value={form.hourly_rate_cents} onChange={(e) => setForm((p) => ({ ...p, hourly_rate_cents: e.target.value }))} className="pl-7" data-testid="input-worker-rate" required />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Effective From</Label>
              <Input type="date" value={form.effective_from} onChange={(e) => setForm((p) => ({ ...p, effective_from: e.target.value }))} data-testid="input-worker-rate-from" />
            </div>
          </div>

          {categories.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Categories</Label>
              <div className="flex flex-wrap gap-2">
                {categories.filter((c) => c.active).map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => toggleCat(cat.id)}
                    className={cn(
                      'px-3 py-1 rounded-full text-xs border transition-colors',
                      form.category_ids.includes(cat.id)
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border text-muted-foreground hover:border-primary/50'
                    )}
                    data-testid={`btn-cat-${cat.id}`}
                  >
                    {cat.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={form.can_add_expenses}
              onChange={(e) => setForm((p) => ({ ...p, can_add_expenses: e.target.checked }))}
              className="rounded"
              data-testid="chk-expenses"
            />
            Allow expense submission
          </label>

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
            <Button type="submit" className="flex-1" disabled={saving} data-testid="btn-create-worker">
              {saving ? 'Creating…' : 'Create Worker'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function WorkersTab() {
  const { toast } = useToast();
  const [workers, setWorkers] = useState<WorkerFull[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rateHistory, setRateHistory] = useState<Record<string, RateHistory[]>>({});
  const [newRate, setNewRate] = useState<Record<string, { rate: string; from: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [wd, cd] = await Promise.all([
        apiClient.get<{ workers: WorkerFull[] }>('/api/time/admin/workers'),
        apiClient.get<{ categories: Category[] }>('/api/time/admin/categories'),
      ]);
      setWorkers(wd.workers);
      setCategories(cd.categories);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function loadRateHistory(workerId: string) {
    if (rateHistory[workerId]) return;
    try {
      const data = await apiClient.get<{ rates: RateHistory[] }>(`/api/time/admin/workers/${workerId}/rate-history`);
      setRateHistory((prev) => ({ ...prev, [workerId]: data.rates }));
    } catch { /* silent */ }
  }

  async function toggleActive(worker: WorkerFull) {
    try {
      await apiClient.post(`/api/time/admin/workers/${worker.id}/activate`, { active: !worker.active });
      toast({ title: `${worker.full_name} ${!worker.active ? 'activated' : 'deactivated'}` });
      await load();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Failed to update worker', variant: 'destructive' });
    }
  }

  async function addRate(workerId: string) {
    const r = newRate[workerId];
    if (!r?.rate || !r?.from) {
      toast({ title: 'Rate and effective date required', variant: 'destructive' });
      return;
    }
    const rateCents = Math.round(parseFloat(r.rate) * 100);
    if (isNaN(rateCents) || rateCents <= 0) {
      toast({ title: 'Invalid rate', variant: 'destructive' });
      return;
    }
    try {
      await apiClient.post(`/api/time/admin/workers/${workerId}/rate`, {
        hourly_rate_cents: rateCents, effective_from: r.from,
      });
      toast({ title: 'Rate updated' });
      setRateHistory((prev) => ({ ...prev, [workerId]: [] })); // clear cache to reload
      await loadRateHistory(workerId);
      setNewRate((prev) => ({ ...prev, [workerId]: { rate: '', from: todayPT() } }));
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Failed to add rate', variant: 'destructive' });
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Workers ({workers.filter((w) => w.active).length} active)</h2>
        <Button size="sm" className="gap-1" onClick={() => setShowAdd(true)} data-testid="btn-add-worker">
          <Plus className="h-3.5 w-3.5" />
          Add Worker
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading…</div>
        ) : (
          workers.map((w) => {
            const isExpanded = expandedId === w.id;
            const unpaidCents = (parseFloat(w.unpaid_labor_cents ?? '0') || 0) + (parseFloat(w.unpaid_expense_cents ?? '0') || 0);

            return (
              <div key={w.id} className="rounded-xl border border-border bg-card overflow-hidden" data-testid={`worker-row-${w.id}`}>
                <button
                  className="w-full px-4 py-3 text-left"
                  onClick={() => {
                    const next = isExpanded ? null : w.id;
                    setExpandedId(next);
                    if (next) void loadRateHistory(next);
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-foreground">{w.full_name}</p>
                        {!w.active && <Badge className="text-[10px] py-0 bg-muted text-muted-foreground">Inactive</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">{w.email}</p>
                    </div>
                    <div className="text-right">
                      {w.current_rate_cents && (
                        <p className="text-xs font-medium text-foreground">${(parseFloat(w.current_rate_cents) / 100).toFixed(2)}/hr</p>
                      )}
                      {unpaidCents > 0 && (
                        <p className="text-xs text-amber-400">{formatMoney(unpaidCents)} unpaid</p>
                      )}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border px-4 py-3 space-y-4">
                    {/* Info */}
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {w.mobile && <div><span className="text-muted-foreground">Mobile: </span>{w.mobile}</div>}
                      {w.zelle_handle && <div><span className="text-muted-foreground">Zelle: </span>{w.zelle_handle}</div>}
                      <div><span className="text-muted-foreground">Expenses: </span>{w.can_add_expenses ? 'Enabled' : 'Disabled'}</div>
                    </div>

                    {w.categories.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {w.categories.map((c) => <Badge key={c.id} variant="secondary" className="text-xs">{c.name}</Badge>)}
                      </div>
                    )}

                    {/* Rate history */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Rate History</p>
                      {rateHistory[w.id] ? (
                        <div className="space-y-1 mb-3">
                          {rateHistory[w.id].map((r) => (
                            <div key={r.id} className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">From {formatDate(r.effective_from)}</span>
                              <span className="text-foreground font-medium">${(r.hourly_rate_cents / 100).toFixed(2)}/hr</span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground mb-2">Loading…</p>
                      )}
                      {/* Add rate form */}
                      <div className="flex gap-2 items-end">
                        <div className="flex-1 space-y-1">
                          <Label className="text-[10px] text-muted-foreground">New Rate ($/hr)</Label>
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground text-xs">$</span>
                            <Input
                              type="number" step="0.01" min="1" placeholder="0.00"
                              value={newRate[w.id]?.rate ?? ''}
                              onChange={(e) => setNewRate((prev) => ({ ...prev, [w.id]: { ...prev[w.id], rate: e.target.value } }))}
                              className="pl-5 h-8 text-xs"
                              data-testid={`input-new-rate-${w.id}`}
                            />
                          </div>
                        </div>
                        <div className="flex-1 space-y-1">
                          <Label className="text-[10px] text-muted-foreground">Effective From</Label>
                          <Input
                            type="date"
                            value={newRate[w.id]?.from ?? todayPT()}
                            onChange={(e) => setNewRate((prev) => ({ ...prev, [w.id]: { ...prev[w.id], from: e.target.value } }))}
                            className="h-8 text-xs"
                          />
                        </div>
                        <Button size="sm" className="h-8" onClick={() => void addRate(w.id)} data-testid={`btn-add-rate-${w.id}`}>
                          <Plus className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 gap-1 text-xs"
                        onClick={() => void toggleActive(w)}
                        data-testid={`btn-toggle-active-${w.id}`}
                      >
                        {w.active ? <ToggleLeft className="h-3.5 w-3.5" /> : <ToggleRight className="h-3.5 w-3.5" />}
                        {w.active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {showAdd && (
        <AddWorkerDialog
          categories={categories}
          onCreated={load}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

// ── Reports Tab ───────────────────────────────────────────────────────────

function ReportsTab() {
  const [period, setPeriod] = useState('week');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [report, setReport] = useState<{
    periodStart: string;
    periodEnd: string;
    headlines: Array<{ status: string; entry_count: string; hours: string; labor_cents: string }>;
    expenseHeadlines: Array<{ status: string; amount_cents: string }>;
    byWorker: Array<{ full_name: string; status: string; hours: string; labor_cents: string; entry_count: string }>;
    byCategory: Array<{ name: string; status: string; hours: string; labor_cents: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function loadReport() {
    setLoading(true);
    try {
      const params = start && end
        ? `?period=custom&start=${start}&end=${end}`
        : `?period=${period}`;
      const data = await apiClient.get<typeof report>(`/api/time/admin/reports${params}`);
      setReport(data);
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Failed to load report', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  function downloadXlsx() {
    const params = start && end ? `?start=${start}&end=${end}` : '';
    window.open(`/api/time/admin/reports/export.xlsx${params}`, '_blank');
  }

  const approvedHours = report?.headlines.find((h) => h.status === 'approved')?.hours ?? '0';
  const paidHours = report?.headlines.find((h) => h.status === 'paid')?.hours ?? '0';
  const pendingHours = report?.headlines.find((h) => h.status === 'pending')?.hours ?? '0';
  const approvedLabor = parseInt(report?.headlines.find((h) => h.status === 'approved')?.labor_cents ?? '0');
  const paidLabor = parseInt(report?.headlines.find((h) => h.status === 'paid')?.labor_cents ?? '0');
  const approvedExp = parseInt(report?.expenseHeadlines.find((h) => h.status === 'approved')?.amount_cents ?? '0');
  const paidExp = parseInt(report?.expenseHeadlines.find((h) => h.status === 'paid')?.amount_cents ?? '0');

  const workerSummary: Record<string, { name: string; hours: number; laborCents: number }> = {};
  for (const row of report?.byWorker ?? []) {
    const key = row.full_name;
    if (!workerSummary[key]) workerSummary[key] = { name: row.full_name, hours: 0, laborCents: 0 };
    workerSummary[key].hours += parseFloat(row.hours ?? '0');
    workerSummary[key].laborCents += parseInt(row.labor_cents ?? '0');
  }
  const catSummary: Record<string, { name: string; hours: number; laborCents: number }> = {};
  for (const row of report?.byCategory ?? []) {
    const key = row.name;
    if (!catSummary[key]) catSummary[key] = { name: row.name, hours: 0, laborCents: 0 };
    catSummary[key].hours += parseFloat(row.hours ?? '0');
    catSummary[key].laborCents += parseInt(row.labor_cents ?? '0');
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
      {/* Period selector */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex gap-2 flex-wrap">
          {(['week', 'month', 'quarter', 'year'] as const).map((p) => (
            <button
              key={p}
              onClick={() => { setPeriod(p); setStart(''); setEnd(''); }}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                period === p && !start ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:border-primary/50'
              )}
              data-testid={`period-${p}`}
            >
              {p.charAt(0).toUpperCase() + p.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex gap-2 items-end">
          <div className="flex-1 space-y-1">
            <Label className="text-[10px] text-muted-foreground">Start</Label>
            <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 text-xs" data-testid="input-report-start" />
          </div>
          <div className="flex-1 space-y-1">
            <Label className="text-[10px] text-muted-foreground">End</Label>
            <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 text-xs" data-testid="input-report-end" />
          </div>
          <Button size="sm" className="h-8" onClick={loadReport} disabled={loading} data-testid="btn-run-report">
            {loading ? '…' : 'Run'}
          </Button>
          {report && (
            <Button size="sm" variant="outline" className="h-8 gap-1" onClick={downloadXlsx} data-testid="btn-download-xlsx">
              <Download className="h-3.5 w-3.5" />
              XLSX
            </Button>
          )}
        </div>
      </div>

      {report && (
        <>
          {/* Headline cards */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Approved Labor</p>
              <p className="text-xl font-bold text-foreground mt-1">{formatMoney(approvedLabor)}</p>
              <p className="text-xs text-muted-foreground">{parseFloat(approvedHours).toFixed(2)}h</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Paid Out</p>
              <p className="text-xl font-bold text-blue-400 mt-1">{formatMoney(paidLabor + paidExp)}</p>
              <p className="text-xs text-muted-foreground">{parseFloat(paidHours).toFixed(2)}h</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Pending Hours</p>
              <p className="text-xl font-bold text-amber-400 mt-1">{parseFloat(pendingHours).toFixed(2)}h</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">Approved Expenses</p>
              <p className="text-xl font-bold text-foreground mt-1">{formatMoney(approvedExp)}</p>
            </div>
          </div>

          {/* Period */}
          <p className="text-xs text-muted-foreground text-center">
            {formatDate(report.periodStart)} – {formatDate(report.periodEnd)}
          </p>

          {/* By worker */}
          {Object.values(workerSummary).length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border">
                <p className="text-xs font-semibold text-foreground">By Worker</p>
              </div>
              <div className="divide-y divide-border">
                {Object.values(workerSummary).sort((a, b) => b.laborCents - a.laborCents).map((w) => (
                  <div key={w.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-foreground">{w.name}</span>
                    <div className="text-right">
                      <span className="font-medium text-foreground">{formatMoney(w.laborCents)}</span>
                      <span className="text-xs text-muted-foreground ml-2">{w.hours.toFixed(2)}h</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By category */}
          {Object.values(catSummary).length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border">
                <p className="text-xs font-semibold text-foreground">By Category</p>
              </div>
              <div className="divide-y divide-border">
                {Object.values(catSummary).sort((a, b) => b.laborCents - a.laborCents).map((c) => (
                  <div key={c.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-foreground">{c.name}</span>
                    <div className="text-right">
                      <span className="font-medium text-foreground">{formatMoney(c.laborCents)}</span>
                      <span className="text-xs text-muted-foreground ml-2">{c.hours.toFixed(2)}h</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {!report && !loading && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          Select a period and click Run to view the report.
        </div>
      )}
    </div>
  );
}

// ── Categories Tab ─────────────────────────────────────────────────────────

function CategoriesTab() {
  const { toast } = useToast();
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.get<{ categories: Category[] }>('/api/time/admin/categories');
      setCategories(data.categories);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function addCategory() {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await apiClient.post('/api/time/admin/categories', { name: newName.trim() });
      setNewName('');
      toast({ title: 'Category created' });
      await load();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Failed to create category', variant: 'destructive' });
    } finally {
      setAdding(false);
    }
  }

  async function updateCategory(id: string, updates: Partial<Category>) {
    try {
      await apiClient.patch(`/api/time/admin/categories/${id}`, updates);
      toast({ title: 'Category updated' });
      await load();
    } catch (e) {
      toast({ title: e instanceof Error ? e.message : 'Failed to update category', variant: 'destructive' });
    }
  }

  async function saveEdit(id: string) {
    if (!editName.trim()) return;
    await updateCategory(id, { name: editName.trim() });
    setEditingId(null);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex gap-2">
          <Input
            placeholder="New category name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void addCategory(); }}
            data-testid="input-new-category"
          />
          <Button onClick={addCategory} disabled={adding || !newName.trim()} data-testid="btn-add-category">
            {adding ? '…' : <Plus className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {loading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading…</div>
        ) : categories.length === 0 ? (
          <div
            className="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center"
            data-testid="empty-state-categories"
          >
            <p className="text-sm font-medium">No work categories yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Workers need at least one category assigned before they can log hours.
              Create categories here first (e.g. General Labor, Landscaping), then assign them when adding workers.
            </p>
          </div>
        ) : (
          categories.map((cat) => (
            <div
              key={cat.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-3"
              data-testid={`category-row-${cat.id}`}
            >
              {editingId === cat.id ? (
                <div className="flex gap-2 flex-1">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void saveEdit(cat.id); if (e.key === 'Escape') setEditingId(null); }}
                    className="flex-1 h-8 text-sm"
                    autoFocus
                    data-testid={`input-edit-cat-${cat.id}`}
                  />
                  <Button size="sm" className="h-8" onClick={() => void saveEdit(cat.id)} data-testid={`btn-save-cat-${cat.id}`}>Save</Button>
                  <Button size="sm" variant="outline" className="h-8" onClick={() => setEditingId(null)}>Cancel</Button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className={cn('text-sm font-medium', !cat.active && 'text-muted-foreground line-through')}>
                      {cat.name}
                    </span>
                    {!cat.active && <Badge variant="outline" className="text-[10px] py-0">Inactive</Badge>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setEditingId(cat.id); setEditName(cat.name); }}
                      className="p-1 rounded hover:bg-accent text-muted-foreground"
                      data-testid={`btn-edit-cat-${cat.id}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => void updateCategory(cat.id, { active: !cat.active })}
                      className="p-1 rounded hover:bg-accent text-muted-foreground"
                      data-testid={`btn-toggle-cat-${cat.id}`}
                    >
                      {cat.active ? <ToggleLeft className="h-4 w-4" /> : <ToggleRight className="h-4 w-4" />}
                    </button>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Main Admin Page ────────────────────────────────────────────────────────

type AdminTab = 'approvals' | 'workers' | 'reports' | 'categories';

export default function TimeAdmin() {
  const { user, signOut } = useAuth();
  const [tab, setTab] = useState<AdminTab>('approvals');

  if (!user) return null;

  return (
    <div
      className="flex flex-col h-screen max-h-screen overflow-hidden"
      style={{ background: '#141519' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <JanusLogo size="sm" variant="icon" />
          <div>
            <span className="text-sm font-semibold text-foreground">Janus Time</span>
            <Badge variant="outline" className="ml-2 text-[10px] py-0">Admin</Badge>
          </div>
        </div>
        <button onClick={() => void signOut()} className="text-xs text-muted-foreground hover:text-foreground transition-colors" data-testid="btn-admin-sign-out">
          Sign out
        </button>
      </div>

      {/* Tab bar (top) */}
      <div className="flex border-b border-border shrink-0">
        {([
          { key: 'approvals' as const, label: 'Approvals', Icon: CheckCircle2 },
          { key: 'workers' as const, label: 'Workers', Icon: Users },
          { key: 'reports' as const, label: 'Reports', Icon: BarChart3 },
          { key: 'categories' as const, label: 'Categories', Icon: Tag },
        ] as Array<{ key: AdminTab; label: string; Icon: typeof CheckCircle2 }>).map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            data-testid={`admin-tab-${key}`}
            className={cn(
              'flex-1 flex flex-col items-center py-2.5 gap-1 text-[10px] font-medium transition-colors border-b-2',
              tab === key
                ? 'text-primary border-primary'
                : 'text-muted-foreground border-transparent hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'approvals' && <ApprovalsTab />}
        {tab === 'workers' && <WorkersTab />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'categories' && <CategoriesTab />}
      </div>
    </div>
  );
}
