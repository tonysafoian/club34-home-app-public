/**
 * Janus Time — Worker View
 * /time
 *
 * Mobile-first T&M time logging for contractors.
 * Tabs: Enter Time | My Weeks | Profile
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
  Clock, ChevronLeft, ChevronRight, Trash2,
  Pencil, CheckCircle2, XCircle, Clock3,
  DollarSign, LogOut, User, CalendarDays, Plus, AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ──────────────────────────────────────────────────────────────────

interface Category {
  id: string;
  name: string;
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

interface Worker {
  id: string;
  full_name: string;
  email: string;
  mobile: string | null;
  zelle_handle: string | null;
  can_add_expenses: boolean;
  active: boolean;
  currentRateCents: number | null;
  categories: Category[];
  windowStart: string;
  today: string;
}

interface WeekSummary {
  weekStart: string;
  weekEnd: string;
  totalHours: number;
  totalLaborCents: number;
  totalExpensesCents: number;
  totalCents: number;
  payment: PaymentRecord | null;
  byStatus: Record<string, { hours: number; laborCents: number }>;
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

// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
  });
}

function formatMoney(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
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

// ── Week Day Strip ─────────────────────────────────────────────────────────

function WeekStrip({
  weekStart,
  selectedDate,
  windowStart,
  today,
  onSelectDate,
  onPrevWeek,
  onNextWeek,
}: {
  weekStart: string;
  selectedDate: string;
  windowStart: string;
  today: string;
  onSelectDate: (d: string) => void;
  onPrevWeek: () => void;
  onNextWeek: () => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const canPrev = weekStart > windowStart;
  const canNext = weekStart < getWeekStart(today);

  return (
    <div className="bg-card border-b border-border px-2 pb-2">
      <div className="flex items-center justify-between mb-2 px-1 pt-2">
        <Button
          variant="ghost" size="sm"
          onClick={onPrevWeek}
          disabled={!canPrev}
          data-testid="btn-prev-week"
          className="h-7 w-7 p-0"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs text-muted-foreground font-medium">
          {formatDate(weekStart)} – {formatDate(addDays(weekStart, 6))}
        </span>
        <Button
          variant="ghost" size="sm"
          onClick={onNextWeek}
          disabled={!canNext}
          data-testid="btn-next-week"
          className="h-7 w-7 p-0"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const isSelected = d === selectedDate;
          const isFuture = d > today;
          const isDisabled = d < windowStart || isFuture;
          const [, , dayNum] = d.split('-');
          const dayLabel = ['M', 'T', 'W', 'T', 'F', 'S', 'S'][days.indexOf(d)];
          return (
            <button
              key={d}
              onClick={() => !isDisabled && onSelectDate(d)}
              disabled={isDisabled}
              data-testid={`day-${d}`}
              className={cn(
                'flex flex-col items-center py-1.5 rounded-lg text-xs font-medium transition-colors',
                isSelected && 'bg-primary text-primary-foreground',
                !isSelected && !isDisabled && 'hover:bg-accent text-foreground',
                isDisabled && 'opacity-30 cursor-not-allowed text-muted-foreground',
                d === today && !isSelected && 'ring-1 ring-primary',
              )}
            >
              <span className="text-[10px] opacity-70">{dayLabel}</span>
              <span>{dayNum}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Entry Form ─────────────────────────────────────────────────────────────

function EntryForm({
  worker,
  selectedDate,
  onSaved,
  editEntry,
  onCancelEdit,
}: {
  worker: Worker;
  selectedDate: string;
  onSaved: () => void;
  editEntry: TimeEntry | null;
  onCancelEdit: () => void;
}) {
  const { toast } = useToast();
  const [categoryId, setCategoryId] = useState('');
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editEntry) {
      setCategoryId(editEntry.category_id);
      setHours(String(parseFloat(editEntry.hours)));
      setNote(editEntry.note ?? '');
    } else {
      setCategoryId(worker.categories[0]?.id ?? '');
      setHours('');
      setNote('');
    }
  }, [editEntry, worker.categories]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!categoryId || !hours) {
      toast({ title: 'Please fill in all required fields', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      if (editEntry) {
        await apiClient.patch(`/api/time/entries/${editEntry.id}`, {
          hours: parseFloat(hours), note: note || undefined, category_id: categoryId,
        });
        toast({ title: 'Entry updated' });
        onCancelEdit();
      } else {
        await apiClient.post('/api/time/entries', {
          work_date: selectedDate, category_id: categoryId,
          hours: parseFloat(hours), note: note || undefined,
        });
        toast({ title: 'Hours logged' });
        setHours('');
        setNote('');
      }
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save entry';
      toast({ title: msg, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const ratePerHour = (worker.currentRateCents ?? 0) / 100;
  const previewAmount = parseFloat(hours || '0') * ratePerHour;

  return (
    <form onSubmit={handleSubmit} className="space-y-3 px-4 py-4">
      {editEntry && (
        <div className="flex items-center justify-between bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-400">
          <span>Editing entry for {formatDate(editEntry.work_date)}</span>
          <button type="button" onClick={onCancelEdit} className="underline">Cancel</button>
        </div>
      )}

      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Date</Label>
        <div className="text-sm font-medium text-foreground bg-muted px-3 py-2 rounded-lg">
          {formatDate(editEntry?.work_date ?? selectedDate)}
        </div>
      </div>

      <div className="space-y-1">
        <Label htmlFor="category" className="text-xs text-muted-foreground">Category *</Label>
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger id="category" data-testid="select-category">
            <SelectValue placeholder="Select category…" />
          </SelectTrigger>
          <SelectContent>
            {worker.categories.map((c) => (
              <SelectItem key={c.id} value={c.id} data-testid={`cat-${c.id}`}>{c.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label htmlFor="hours" className="text-xs text-muted-foreground">Hours *</Label>
        <div className="relative">
          <Input
            id="hours"
            type="number"
            step="0.25"
            min="0.25"
            max="24"
            placeholder="e.g. 4, 7.5"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            data-testid="input-hours"
            className="pr-16"
            required
          />
          {hours && parseFloat(hours) > 0 && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              ≈ {formatMoney(Math.round(previewAmount * 100))}
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">0.25 increments • max 24/day</p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="note" className="text-xs text-muted-foreground">Note (optional)</Label>
        <Textarea
          id="note"
          placeholder="What did you work on?"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="input-note"
          rows={2}
          className="resize-none text-sm"
        />
      </div>

      <Button type="submit" className="w-full" disabled={saving} data-testid="btn-submit-entry">
        {saving ? 'Saving…' : editEntry ? 'Update Entry' : 'Log Hours'}
      </Button>
    </form>
  );
}

// ── Expense Form ───────────────────────────────────────────────────────────

function ExpenseForm({ worker, selectedDate, onSaved }: { worker: Worker; selectedDate: string; onSaved: () => void }) {
  const { toast } = useToast();
  const [amountDollars, setAmountDollars] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = Math.round(parseFloat(amountDollars) * 100);
    if (!amount || isNaN(amount) || amount <= 0) {
      toast({ title: 'Enter a valid dollar amount', variant: 'destructive' });
      return;
    }
    if (!note.trim()) {
      toast({ title: 'Note is required for expenses', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await apiClient.post('/api/time/expenses', {
        expense_date: selectedDate, amount_cents: amount, note: note.trim(),
      });
      toast({ title: 'Expense submitted' });
      setAmountDollars('');
      setNote('');
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to submit expense';
      toast({ title: msg, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (!worker.can_add_expenses) return null;

  return (
    <form onSubmit={handleSubmit} className="space-y-3 px-4 pb-4">
      <div className="border-t border-border pt-3">
        <p className="text-xs font-medium text-muted-foreground mb-3">Add Expense</p>
        <div className="space-y-1">
          <Label htmlFor="amount" className="text-xs text-muted-foreground">Amount ($) *</Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0.01"
              placeholder="0.00"
              value={amountDollars}
              onChange={(e) => setAmountDollars(e.target.value)}
              data-testid="input-expense-amount"
              className="pl-7"
              required
            />
          </div>
        </div>
        <div className="space-y-1 mt-2">
          <Label htmlFor="exp-note" className="text-xs text-muted-foreground">Description *</Label>
          <Textarea
            id="exp-note"
            placeholder="What was this expense for?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="input-expense-note"
            rows={2}
            className="resize-none text-sm"
            required
          />
        </div>
        <Button type="submit" variant="outline" className="w-full mt-2" disabled={saving} data-testid="btn-submit-expense">
          {saving ? 'Submitting…' : 'Submit Expense'}
        </Button>
      </div>
    </form>
  );
}

// ── Expense Edit Form ──────────────────────────────────────────────────────

function ExpenseEditForm({ expense, onSaved, onCancel }: { expense: Expense; onSaved: () => void; onCancel: () => void }) {
  const { toast } = useToast();
  const [amountDollars, setAmountDollars] = useState((expense.amount_cents / 100).toFixed(2));
  const [note, setNote] = useState(expense.note);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amount = Math.round(parseFloat(amountDollars) * 100);
    if (!amount || isNaN(amount) || amount <= 0) {
      toast({ title: 'Enter a valid dollar amount', variant: 'destructive' });
      return;
    }
    if (!note.trim()) {
      toast({ title: 'Note is required for expenses', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await apiClient.patch(`/api/time/expenses/${expense.id}`, {
        amount_cents: amount, note: note.trim(),
      });
      toast({ title: 'Expense updated' });
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update expense';
      toast({ title: msg, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Amount ($)</Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
          <Input
            type="number" step="0.01" min="0.01"
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            className="pl-7 h-8 text-sm"
            data-testid="input-edit-expense-amount"
            required
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Description</Label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="resize-none text-sm"
          data-testid="input-edit-expense-note"
          required
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="flex-1" disabled={saving} data-testid="btn-save-expense-edit">
          {saving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} data-testid="btn-cancel-expense-edit">
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ── Day Entries List ───────────────────────────────────────────────────────

function DayEntriesList({
  entries,
  selectedDate,
  windowStart,
  today,
  onEdit,
  onDelete,
}: {
  entries: TimeEntry[];
  selectedDate: string;
  windowStart: string;
  today: string;
  onEdit: (e: TimeEntry) => void;
  onDelete: (id: string) => void;
}) {
  const dayEntries = entries.filter((e) => e.work_date === selectedDate);
  const canEdit = selectedDate >= windowStart && selectedDate <= today;

  if (dayEntries.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground italic">
        No entries for {formatDate(selectedDate)}
      </div>
    );
  }

  return (
    <div className="px-4 space-y-2 pb-2">
      {dayEntries.map((entry) => {
        const canEditEntry = canEdit && (entry.status === 'pending' || entry.status === 'rejected');
        const hours = parseFloat(entry.hours);
        const amount = hours * (entry.rate_cents / 100);
        return (
          <div key={entry.id} className={cn(
            'rounded-lg border p-3 space-y-1',
            entry.status === 'rejected' ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-card/50'
          )} data-testid={`entry-${entry.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-foreground">{entry.category_name}</span>
                {entry.is_adjustment && (
                  <Badge variant="outline" className="ml-1 text-[10px] py-0">adj</Badge>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <StatusBadge status={entry.status} />
                {canEditEntry && (
                  <>
                    <button
                      onClick={() => onEdit(entry)}
                      className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                      data-testid={`btn-edit-entry-${entry.id}`}
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => onDelete(entry.id)}
                      className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                      data-testid={`btn-delete-entry-${entry.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{hours % 1 === 0 ? hours : hours.toFixed(2)}h</span>
              <span>≈ {formatMoney(Math.round(amount * 100))}</span>
            </div>
            {entry.note && <p className="text-xs text-muted-foreground">{entry.note}</p>}
            {entry.status === 'rejected' && entry.rejected_reason && (
              <div className="flex items-start gap-1 text-xs text-red-400 mt-1">
                <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>{entry.rejected_reason}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Enter Tab ──────────────────────────────────────────────────────────────

function EnterTab({ worker }: { worker: Worker }) {
  const { toast } = useToast();
  const today = worker.today;
  const windowStart = worker.windowStart;

  const [selectedDate, setSelectedDate] = useState(today);
  const [weekStart, setWeekStart] = useState(() => getWeekStart(today));
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [editEntry, setEditEntry] = useState<TimeEntry | null>(null);
  const [editExpense, setEditExpense] = useState<Expense | null>(null);
  const [loadingEntries, setLoadingEntries] = useState(false);

  const fetchEntries = useCallback(async () => {
    setLoadingEntries(true);
    try {
      const data = await apiClient.get<{ entries: TimeEntry[]; expenses: Expense[] }>(
        `/api/time/entries?week=${weekStart}`
      );
      setEntries(data.entries);
      setExpenses(data.expenses);
    } catch {
      // silent
    } finally {
      setLoadingEntries(false);
    }
  }, [weekStart]);

  useEffect(() => { void fetchEntries(); }, [fetchEntries]);

  async function handleDelete(id: string) {
    try {
      await apiClient.del(`/api/time/entries/${id}`);
      toast({ title: 'Entry deleted' });
      void fetchEntries();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete entry';
      toast({ title: msg, variant: 'destructive' });
    }
  }

  async function handleDeleteExpense(id: string) {
    try {
      await apiClient.del(`/api/time/expenses/${id}`);
      toast({ title: 'Expense deleted' });
      void fetchEntries();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete expense';
      toast({ title: msg, variant: 'destructive' });
    }
  }

  function handlePrevWeek() {
    const prev = addDays(weekStart, -7);
    setWeekStart(prev);
    setSelectedDate(addDays(prev, 6) > today ? today : addDays(prev, 6));
  }

  function handleNextWeek() {
    const next = addDays(weekStart, 7);
    setWeekStart(next);
    setSelectedDate(next);
  }

  const dayEntries = entries.filter((e) => e.work_date === selectedDate);
  const dayHours = dayEntries.reduce((s, e) => s + parseFloat(e.hours), 0);
  const isInWindow = selectedDate >= windowStart && selectedDate <= today;

  return (
    <div className="flex flex-col h-full">
      <WeekStrip
        weekStart={weekStart}
        selectedDate={selectedDate}
        windowStart={windowStart}
        today={today}
        onSelectDate={setSelectedDate}
        onPrevWeek={handlePrevWeek}
        onNextWeek={handleNextWeek}
      />

      <div className="flex-1 overflow-y-auto">
        {/* Day summary row */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border text-xs">
          <span className="font-medium text-foreground">{formatDate(selectedDate)}</span>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{dayHours > 0 ? `${dayHours.toFixed(2)}h today` : 'No hours yet'}</span>
          </div>
        </div>

        {/* Existing entries for the day */}
        {loadingEntries ? (
          <div className="px-4 py-3 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <DayEntriesList
            entries={entries}
            selectedDate={selectedDate}
            windowStart={windowStart}
            today={today}
            onEdit={setEditEntry}
            onDelete={handleDelete}
          />
        )}

        {/* Entry form */}
        {!isInWindow ? (
          <div className="px-4 py-3 text-sm text-muted-foreground italic">
            {selectedDate > today ? 'Future dates cannot be logged' : 'Outside the 7-day submission window'}
          </div>
        ) : (
          <>
            <EntryForm
              worker={worker}
              selectedDate={selectedDate}
              onSaved={fetchEntries}
              editEntry={editEntry}
              onCancelEdit={() => setEditEntry(null)}
            />
            <ExpenseForm worker={worker} selectedDate={selectedDate} onSaved={fetchEntries} />
          </>
        )}

        {/* Day expenses */}
        {expenses.filter((e) => e.expense_date === selectedDate).length > 0 && (
          <div className="px-4 pb-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">Expenses</p>
            {expenses
              .filter((e) => e.expense_date === selectedDate)
              .map((expense) => {
                const canEdit = expense.status === 'pending' && isInWindow;
                const isEditing = editExpense?.id === expense.id;
                return (
                  <div key={expense.id} className="rounded-lg border border-border bg-card/50 p-3 mb-2" data-testid={`expense-${expense.id}`}>
                    {isEditing ? (
                      <ExpenseEditForm
                        expense={expense}
                        onSaved={() => { setEditExpense(null); void fetchEntries(); }}
                        onCancel={() => setEditExpense(null)}
                      />
                    ) : (
                      <>
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{formatMoney(expense.amount_cents)}</span>
                            <StatusBadge status={expense.status} />
                          </div>
                          {canEdit && (
                            <div className="flex gap-1">
                              <button
                                onClick={() => setEditExpense(expense)}
                                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                                data-testid={`btn-edit-expense-${expense.id}`}
                                title="Edit expense"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteExpense(expense.id)}
                                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-red-400"
                                data-testid={`btn-delete-expense-${expense.id}`}
                                title="Delete expense"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{expense.note}</p>
                        {expense.status === 'rejected' && expense.rejected_reason && (
                          <p className="text-xs text-red-400 mt-1">{expense.rejected_reason}</p>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── My Weeks Tab ───────────────────────────────────────────────────────────

function MyWeeksTab({ worker }: { worker: Worker }) {
  const [weeks, setWeeks] = useState<WeekSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedWeek, setExpandedWeek] = useState<string | null>(null);
  const [weekEntries, setWeekEntries] = useState<Record<string, TimeEntry[]>>({});

  useEffect(() => {
    apiClient.get<{ weeks: WeekSummary[] }>('/api/time/weeks?limit=26')
      .then((d) => setWeeks(d.weeks))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function loadWeekEntries(weekStart: string) {
    if (weekEntries[weekStart]) return;
    try {
      const data = await apiClient.get<{ entries: TimeEntry[] }>(`/api/time/entries?week=${weekStart}`);
      setWeekEntries((prev) => ({ ...prev, [weekStart]: data.entries }));
    } catch { /* silent */ }
  }

  function toggleWeek(ws: string) {
    if (expandedWeek === ws) {
      setExpandedWeek(null);
    } else {
      setExpandedWeek(ws);
      void loadWeekEntries(ws);
    }
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Loading…</div>;
  }

  if (weeks.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <Clock className="h-10 w-10 text-muted-foreground opacity-40" />
        <p className="text-sm text-muted-foreground">No time entries yet. Go to Enter Time to log your first hours.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
      {weeks.map((week) => {
        const isExpanded = expandedWeek === week.weekStart;
        const paid = !!week.payment;
        const pendingH = week.byStatus.pending?.hours ?? 0;
        const approvedH = week.byStatus.approved?.hours ?? 0;
        const paidH = week.byStatus.paid?.hours ?? 0;

        return (
          <div key={week.weekStart} className="rounded-xl border border-border bg-card overflow-hidden" data-testid={`week-${week.weekStart}`}>
            <button
              className="w-full text-left p-4"
              onClick={() => toggleWeek(week.weekStart)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {formatDate(week.weekStart)} – {formatDate(week.weekEnd)}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    {paid ? (
                      <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-[10px]">Paid</Badge>
                    ) : pendingH > 0 ? (
                      <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[10px]">Pending approval</Badge>
                    ) : approvedH > 0 ? (
                      <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-[10px]">Ready to pay</Badge>
                    ) : null}
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-foreground">{formatMoney(week.totalCents)}</p>
                  <p className="text-xs text-muted-foreground">{week.totalHours.toFixed(2)}h</p>
                </div>
              </div>

              {/* Mini breakdown */}
              <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                {(pendingH + approvedH + paidH) > 0 && (
                  <>
                    {paidH > 0 && <span className="text-blue-400">{paidH.toFixed(2)}h paid</span>}
                    {approvedH > 0 && <span className="text-emerald-400">{approvedH.toFixed(2)}h approved</span>}
                    {pendingH > 0 && <span className="text-amber-400">{pendingH.toFixed(2)}h pending</span>}
                  </>
                )}
                {week.totalExpensesCents > 0 && (
                  <span className="text-muted-foreground">+{formatMoney(week.totalExpensesCents)} expenses</span>
                )}
              </div>
            </button>

            {isExpanded && (
              <div className="border-t border-border">
                {paid && week.payment && (
                  <div className="px-4 py-3 bg-blue-500/5 text-xs space-y-1">
                    <p className="font-medium text-blue-400">Payment Received</p>
                    <p className="text-muted-foreground">
                      {new Date(week.payment.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} • {formatMoney(week.payment.total_cents)}
                    </p>
                    {week.payment.confirmation_ref && (
                      <p className="text-muted-foreground">Ref: {week.payment.confirmation_ref}</p>
                    )}
                  </div>
                )}
                <div className="px-4 py-2 space-y-2">
                  {weekEntries[week.weekStart] ? (
                    weekEntries[week.weekStart].length > 0 ? (
                      weekEntries[week.weekStart].map((entry) => (
                        <div key={entry.id} className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0">
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground w-20 shrink-0">{formatDate(entry.work_date)}</span>
                            <span className="text-foreground">{entry.category_name}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-foreground font-medium">{parseFloat(entry.hours).toFixed(2)}h</span>
                            <StatusBadge status={entry.status} />
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground py-2 italic">No entries for this week</p>
                    )
                  ) : (
                    <p className="text-xs text-muted-foreground py-2">Loading…</p>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground text-center py-2">Showing last 26 weeks</p>
    </div>
  );
}

// ── Profile Tab ────────────────────────────────────────────────────────────

function ProfileTab({ worker }: { worker: Worker }) {
  const { signOut } = useAuth();

  const rateDollars = worker.currentRateCents ? worker.currentRateCents / 100 : null;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
      <div className="flex items-center gap-4">
        <div className="h-14 w-14 rounded-full bg-primary/20 flex items-center justify-center">
          <User className="h-7 w-7 text-primary" />
        </div>
        <div>
          <p className="text-lg font-bold text-foreground">{worker.full_name}</p>
          <p className="text-sm text-muted-foreground">{worker.email}</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card divide-y divide-border">
        {rateDollars !== null && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Hourly Rate</span>
            <span className="text-sm font-semibold text-foreground">${rateDollars.toFixed(2)}/hr</span>
          </div>
        )}
        {worker.mobile && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Mobile</span>
            <span className="text-sm text-foreground">{worker.mobile}</span>
          </div>
        )}
        {worker.zelle_handle && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Zelle</span>
            <span className="text-sm text-foreground">{worker.zelle_handle}</span>
          </div>
        )}
        {worker.categories.length > 0 && (
          <div className="px-4 py-3">
            <span className="text-sm text-muted-foreground block mb-2">Work Categories</span>
            <div className="flex flex-wrap gap-1">
              {worker.categories.map((c) => (
                <Badge key={c.id} variant="secondary" className="text-xs">{c.name}</Badge>
              ))}
            </div>
          </div>
        )}
        {worker.can_add_expenses && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-muted-foreground">Expense Submission</span>
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">Enabled</Badge>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card px-4 py-3">
        <p className="text-xs font-medium text-muted-foreground mb-1">Submission Window</p>
        <p className="text-sm text-foreground">You can submit or edit entries for the last 7 days.</p>
        <p className="text-xs text-muted-foreground mt-1">Window: {formatDate(worker.windowStart)} – today</p>
      </div>

      <Button
        variant="outline"
        className="w-full"
        onClick={() => void signOut()}
        data-testid="btn-sign-out"
      >
        <LogOut className="h-4 w-4 mr-2" />
        Sign Out
      </Button>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

type Tab = 'enter' | 'weeks' | 'profile';

export default function Time() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('enter');
  const [worker, setWorker] = useState<Worker | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Admin-only vendor preview: /time?preview=vendor shows the real vendor UI
  // (backend auto-creates a "Test Vendor" profile linked to the admin account).
  const vendorPreview = new URLSearchParams(window.location.search).get('preview') === 'vendor';

  useEffect(() => {
    apiClient.get<{ worker: Worker; isAdmin?: boolean }>(
      vendorPreview ? '/api/time/me?preview=vendor' : '/api/time/me'
    )
      .then((d) => {
        if (d.isAdmin) {
          window.location.href = '/time/admin';
          return;
        }
        setWorker(d.worker);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load profile'))
      .finally(() => setLoading(false));
  }, [vendorPreview]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#141519' }}>
        <div className="text-center space-y-3">
          <JanusLogo size="lg" variant="icon" />
          <p className="text-sm text-muted-foreground">Loading Janus Time…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#141519' }}>
        <div className="text-center space-y-3">
          <AlertCircle className="h-10 w-10 text-red-400 mx-auto" />
          <p className="text-sm text-red-400">{error}</p>
          <Button variant="outline" onClick={() => window.location.reload()}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!worker) return null;

  return (
    <div
      className="flex flex-col h-screen max-h-screen overflow-hidden"
      style={{ background: '#141519' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <JanusLogo size="sm" variant="icon" />
          <span className="text-sm font-semibold text-foreground">Janus Time</span>
        </div>
        <span className="text-xs text-muted-foreground">{worker.full_name}</span>
      </div>

      {/* Vendor preview banner (admin testing the vendor experience) */}
      {vendorPreview && (
        <div
          className="bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 text-xs text-amber-400 flex items-center justify-between gap-2"
          data-testid="banner-vendor-preview"
        >
          <span>Vendor preview — you&apos;re seeing Janus Time as a vendor.</span>
          <a href="/time/admin" className="underline shrink-0" data-testid="link-back-to-admin">
            Back to Admin
          </a>
        </div>
      )}

      {/* Deactivated banner */}
      {!worker.active && (
        <div className="bg-red-500/20 border-b border-red-500/30 px-4 py-2 text-xs text-red-400 flex items-center gap-2">
          <AlertCircle className="h-3 w-3 shrink-0" />
          Your account has been deactivated. Contact Tony for assistance.
        </div>
      )}

      {/* Tab content */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'enter' && <EnterTab worker={worker} />}
        {tab === 'weeks' && <MyWeeksTab worker={worker} />}
        {tab === 'profile' && <ProfileTab worker={worker} />}
      </div>

      {/* Bottom tab bar */}
      <div className="border-t border-border bg-card shrink-0 pb-safe">
        <div className="grid grid-cols-3">
          {([
            { key: 'enter' as const, label: 'Enter Time', Icon: Plus },
            { key: 'weeks' as const, label: 'My Weeks', Icon: CalendarDays },
            { key: 'profile' as const, label: 'Profile', Icon: User },
          ] as Array<{ key: Tab; label: string; Icon: typeof Plus }>).map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              data-testid={`tab-${key}`}
              className={cn(
                'flex flex-col items-center py-3 gap-1 text-[10px] font-medium transition-colors',
                tab === key ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className={cn('h-5 w-5', tab === key && 'text-primary')} />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
