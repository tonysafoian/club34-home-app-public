import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/hooks/use-toast';
import { ArrowLeft, Save, X, Pencil, Plus, Trash2, HeartPulse, Sparkles, RefreshCw, Download, Upload } from 'lucide-react';
import { format } from 'date-fns';

interface SystemPrompt {
  id: string;
  slug: string;
  label: string;
  content: string;
  description: string | null;
  updated_at: string;
  created_at: string;
}

interface SyncStatus {
  soulHash: string;
  dbHash: string;
  inSync: boolean;
  soulLength: number;
  dbLength: number;
}

const CORE_SOUL_SLUG = 'janus-core';

async function callSyncSoul(action: string): Promise<unknown> {
  if (action === "export-from-db") {
    const res = await fetch('/api/functions/invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ functionName: 'sync-soul', body: { action } }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const result = await res.json();
    return typeof result === 'string' ? result : JSON.stringify(result);
  }
  return apiClient.invokeFn('sync-soul', { action });
}

export function AdminPromptsContent() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<SystemPrompt | null>(null);
  const [editContent, setEditContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [newPrompt, setNewPrompt] = useState({ slug: '', label: '', description: '', content: '' });
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);

  const fetchSyncStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      setSyncLoading(true);
      const status = await callSyncSoul("status") as SyncStatus;
      if (!signal?.aborted) setSyncStatus(status);
    } catch (e) {
      console.error("Failed to fetch sync status:", e);
    } finally {
      if (!signal?.aborted) setSyncLoading(false);
    }
  }, []);

  // Fetch sync status on mount
  useEffect(() => {
    const ac = new AbortController();
    fetchSyncStatus(ac.signal);
    return () => ac.abort();
  }, [fetchSyncStatus]);

  // Refresh on window focus
  useEffect(() => {
    const onFocus = () => fetchSyncStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchSyncStatus]);

  const { data: prompts, isLoading } = useQuery({
    queryKey: ['system-prompts'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<SystemPrompt[]>({ table: 'system_prompts', select: '*', order: { column: 'created_at', ascending: true } });
      return (data ?? []) as SystemPrompt[];
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      await apiClient.dbUpdate('system_prompts', { content }, [{ column: 'id', op: 'eq', value: id }]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-prompts'] });
      toast({ title: 'Prompt saved', description: 'Changes take effect immediately' });
      setEditing(null);
      fetchSyncStatus();
    },
    onError: (e) => toast({ title: 'Error', description: `Failed to save: ${e.message}`, variant: 'destructive' }),
  });

  const createMutation = useMutation({
    mutationFn: async (prompt: typeof newPrompt) => {
      await apiClient.dbInsert('system_prompts', prompt);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-prompts'] });
      toast({ title: 'Prompt created' });
      setCreating(false);
      setNewPrompt({ slug: '', label: '', description: '', content: '' });
    },
    onError: (e) => toast({ title: 'Error', description: `Failed to create: ${e.message}`, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.dbDelete('system_prompts', [{ column: 'id', op: 'eq', value: id }]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['system-prompts'] });
      toast({ title: 'Prompt deleted' });
    },
    onError: (e) => toast({ title: 'Error', description: `Failed to delete: ${e.message}`, variant: 'destructive' }),
  });

  const handleSyncToDb = async () => {
    try {
      setSyncLoading(true);
      const result = await callSyncSoul("sync-to-db") as { message?: string; chars?: number };
      toast({ title: 'Synced', description: `${result.message} (${result.chars} chars)` });
      queryClient.invalidateQueries({ queryKey: ['system-prompts'] });
      await fetchSyncStatus();
    } catch (e: unknown) {
      toast({ title: 'Error', description: `Sync failed: ${e instanceof Error ? e.message : String(e)}`, variant: 'destructive' });
    } finally {
      setSyncLoading(false);
    }
  };

  const handleExportFromDb = async () => {
    try {
      const content = await callSyncSoul("export-from-db") as string;
      const blob = new Blob([content], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "SOUL.md";
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Exported SOUL.md' });
    } catch (e: unknown) {
      toast({ title: 'Error', description: `Export failed: ${e instanceof Error ? e.message : String(e)}`, variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}
      </div>
    );
  }

  const coreSoul = prompts?.find(p => p.slug === CORE_SOUL_SLUG);
  const otherPrompts = prompts?.filter(p => p.slug !== CORE_SOUL_SLUG);

  // Editing view
  if (editing) {
    const isCoreSoul = editing.slug === CORE_SOUL_SLUG;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => setEditing(null)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              {isCoreSoul && <HeartPulse className="h-5 w-5 text-primary" />}
              <div>
                <h2 className="text-lg font-semibold">{editing.label}</h2>
                <p className="text-sm text-muted-foreground">{editing.slug}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{editContent.length} chars</span>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => updateMutation.mutate({ id: editing.id, content: editContent })}
              disabled={updateMutation.isPending}
            >
              <Save className="h-4 w-4 mr-1" /> Save
            </Button>
          </div>
        </div>
        {isCoreSoul && (
          <p className="text-xs text-muted-foreground bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
            <HeartPulse className="h-3.5 w-3.5 inline mr-1.5 -mt-0.5" />
            The Soul defines who Janus is — personality, principles, rules, and knowledge. It's injected into every conversation across all channels.
          </p>
        )}
        <Textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="min-h-[60vh] font-mono text-sm"
          placeholder="Enter system prompt content..."
        />
      </div>
    );
  }

  // Creating view
  if (creating) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => setCreating(false)}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-lg font-semibold">New Prompt</h2>
        </div>
        <div className="grid gap-3">
          <Input placeholder="Slug (e.g. janus-morning-brief)" value={newPrompt.slug} onChange={e => setNewPrompt(p => ({ ...p, slug: e.target.value }))} />
          <Input placeholder="Label (e.g. Janus — Morning Brief)" value={newPrompt.label} onChange={e => setNewPrompt(p => ({ ...p, label: e.target.value }))} />
          <Input placeholder="Description (optional)" value={newPrompt.description} onChange={e => setNewPrompt(p => ({ ...p, description: e.target.value }))} />
          <Textarea
            value={newPrompt.content}
            onChange={e => setNewPrompt(p => ({ ...p, content: e.target.value }))}
            className="min-h-[40vh] font-mono text-sm"
            placeholder="Prompt content..."
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          <Button onClick={() => createMutation.mutate(newPrompt)} disabled={!newPrompt.slug || !newPrompt.label || createMutation.isPending}>
            <Plus className="h-4 w-4 mr-1" /> Create
          </Button>
        </div>
      </div>
    );
  }

  // List view
  return (
    <div className="space-y-6">
      {/* Sync Status Banner */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          {syncLoading ? (
            <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
          ) : syncStatus?.inSync ? (
            <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 shrink-0">
              ✓ Soul in sync
            </Badge>
          ) : syncStatus ? (
            <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 border-amber-500/20 shrink-0">
              ⚠ Out of sync
            </Badge>
          ) : null}
          {syncStatus && (
            <span className="text-xs text-muted-foreground truncate">
              {syncStatus.inSync
                ? `${syncStatus.soulLength.toLocaleString()} chars`
                : `File: ${syncStatus.soulLength.toLocaleString()} · DB: ${syncStatus.dbLength.toLocaleString()} chars`}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {syncStatus && !syncStatus.inSync && (
            <Button size="sm" onClick={handleSyncToDb} disabled={syncLoading}>
              <Upload className="h-3.5 w-3.5 mr-1" /> Sync Soul → DB
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={handleExportFromDb}>
            <Download className="h-3.5 w-3.5 mr-1" /> Export
          </Button>
        </div>
      </div>

      {/* Janus Soul Section */}
      {coreSoul && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5 text-primary" />
            <h3 className="text-base font-semibold">Janus Soul</h3>
            <Badge variant="secondary" className="text-[10px]">ALL CHANNELS</Badge>
          </div>
          <Card className="border-primary/30 bg-primary/[0.02]">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />
                    {coreSoul.label}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    {coreSoul.description}
                  </CardDescription>
                </div>
                <Badge variant="secondary" className="font-mono text-xs">{coreSoul.slug}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono">
                {coreSoul.content.slice(0, 800)}{coreSoul.content.length > 800 ? '...' : ''}
              </pre>
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-muted-foreground">
                  Updated {format(new Date(coreSoul.updated_at), 'MMM d, yyyy h:mm a')} · {coreSoul.content.length} chars
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setEditing(coreSoul); setEditContent(coreSoul.content); }}
                >
                  <Pencil className="h-4 w-4 mr-1" /> Edit Soul
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Channel & Task Prompts */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">Channel & Task Prompts</h3>
            <p className="text-sm text-muted-foreground">
              Edit system prompts live — changes take effect immediately, no redeploy needed.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Prompt
          </Button>
        </div>

        {otherPrompts?.map((prompt) => (
          <Card key={prompt.id} className="group">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base">{prompt.label}</CardTitle>
                  <CardDescription className="mt-1">
                    {prompt.description}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="font-mono text-xs">{prompt.slug}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <pre className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap font-mono">
                {prompt.content.slice(0, 500)}{prompt.content.length > 500 ? '...' : ''}
              </pre>
              <div className="flex items-center justify-between mt-3">
                <span className="text-xs text-muted-foreground">
                  Updated {format(new Date(prompt.updated_at), 'MMM d, yyyy h:mm a')} · {prompt.content.length} chars
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete "${prompt.label}"?`)) deleteMutation.mutate(prompt.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setEditing(prompt); setEditContent(prompt.content); }}
                  >
                    <Pencil className="h-4 w-4 mr-1" /> Edit
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}