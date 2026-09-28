import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Plus, Pencil, Trash2, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { toast } from '@/hooks/use-toast';

interface SystemUpdate {
  id: string;
  version: string;
  title: string;
  description: string;
  update_type: string;
  published_at: string;
  access_hint: string | null;
  suggested_by: string | null;
  created_at: string;
}

const EMPTY_FORM = {
  version: '',
  title: '',
  description: '',
  update_type: 'feature',
  access_hint: '',
  suggested_by: '',
  published_at: new Date().toISOString().slice(0, 16),
};

const TYPE_BADGE: Record<string, string> = {
  feature: 'bg-emerald-500/15 text-emerald-400',
  improvement: 'bg-blue-500/15 text-blue-400',
  fix: 'bg-amber-500/15 text-amber-400',
};

export function AdminUpdatesContent() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const { data: updates = [], isLoading } = useQuery({
    queryKey: ['admin-system-updates'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<SystemUpdate[]>({ table: 'system_updates', select: '*', order: { column: 'published_at', ascending: false } });
      return (data ?? []) as SystemUpdate[];
    },
  });

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
  }

  function editEntry(entry: SystemUpdate) {
    setEditingId(entry.id);
    setForm({
      version: entry.version,
      title: entry.title,
      description: entry.description,
      update_type: entry.update_type,
      access_hint: entry.access_hint ?? '',
      suggested_by: entry.suggested_by ?? '',
      published_at: entry.published_at.slice(0, 16),
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.version || !form.title) return;
    setSaving(true);

    const payload = {
      version: form.version,
      title: form.title,
      description: form.description,
      update_type: form.update_type,
      access_hint: form.access_hint || null,
      suggested_by: form.suggested_by || null,
      published_at: new Date(form.published_at).toISOString(),
    };

    try {
      if (editingId) {
        await apiClient.dbUpdate('system_updates', payload, [{ column: 'id', op: 'eq', value: editingId }]);
        toast({ title: 'Update edited' });
      } else {
        await apiClient.dbInsert('system_updates', payload);
        toast({ title: 'Update published' });
      }
      queryClient.invalidateQueries({ queryKey: ['admin-system-updates'] });
      queryClient.invalidateQueries({ queryKey: ['system-updates'] });
      resetForm();
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await apiClient.dbDelete('system_updates', [{ column: 'id', op: 'eq', value: id }]);
    } catch (err: unknown) {
      toast({ title: 'Error', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
      return;
    }
    toast({ title: 'Deleted' });
    queryClient.invalidateQueries({ queryKey: ['admin-system-updates'] });
    queryClient.invalidateQueries({ queryKey: ['system-updates'] });
    if (editingId === id) resetForm();
  }

  return (
    <div className="space-y-6">
      {/* Form */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg font-display">
              {editingId ? 'Edit Update' : 'Publish New Update'}
            </CardTitle>
            {editingId && (
              <Button variant="ghost" size="sm" onClick={resetForm}>
                <X className="h-4 w-4 mr-1" /> Cancel
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="grid gap-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Version</Label>
                <Input placeholder="v3.2.0" value={form.version} onChange={e => setForm(p => ({ ...p, version: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={form.update_type} onValueChange={v => setForm(p => ({ ...p, update_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="feature">Feature</SelectItem>
                    <SelectItem value="improvement">Improvement</SelectItem>
                    <SelectItem value="fix">Fix</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input placeholder="Project Sharing" value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} required />
            </div>

            <div className="space-y-1.5">
              <Label>Description (markdown bullets)</Label>
              <Textarea
                placeholder={"- Share projects with other users\n- Email and in-app notifications\n- \"Saved by\" attribution on artifacts"}
                value={form.description}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                rows={5}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Access Hint (optional)</Label>
                <Input placeholder="Navigate to Projects" value={form.access_hint} onChange={e => setForm(p => ({ ...p, access_hint: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Suggested By (optional)</Label>
                <Input placeholder="Suggested by a member" value={form.suggested_by} onChange={e => setForm(p => ({ ...p, suggested_by: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Publish Date</Label>
              <Input type="datetime-local" value={form.published_at} onChange={e => setForm(p => ({ ...p, published_at: e.target.value }))} />
            </div>

            <Button type="submit" disabled={saving} className="w-full">
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingId ? 'Save Changes' : 'Publish Update'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-2">
          {updates.map(entry => (
            <div key={entry.id} className="flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-card/50">
              <Badge variant="outline" className={TYPE_BADGE[entry.update_type] ?? ''}>
                {entry.update_type}
              </Badge>
              <span className="text-xs font-mono text-muted-foreground">{entry.version}</span>
              <span className="flex-1 text-sm font-medium truncate">{entry.title}</span>
              <span className="text-xs text-muted-foreground hidden sm:inline">
                {format(parseISO(entry.published_at), 'MMM d, yyyy')}
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => editEntry(entry)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(entry.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
