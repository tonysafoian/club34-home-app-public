import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Users, Shield, ShieldAlert, ShieldCheck, MessageSquare, Phone, Pencil, Plus, X } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

interface GroupConfig {
  id: string;
  group_id: string;
  channel: string;
  tier: string;
  group_name: string | null;
  notes: string | null;
  trusted_phones: string[];
  message_count: number;
  created_at: string;
  updated_at: string;
}

const TIER_CONFIG = {
  A: {
    label: 'Family-Only',
    description: 'All members are household users. Full capabilities.',
    color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    icon: ShieldCheck,
  },
  B: {
    label: 'Trusted Mixed',
    description: 'Household + recognized guests. No sensitive data.',
    color: 'bg-amber-500/10 text-amber-600 border-amber-500/20',
    icon: Shield,
  },
  C: {
    label: 'Public Mixed',
    description: 'Unknown outsiders present. Strict privacy mode.',
    color: 'bg-destructive/10 text-destructive border-destructive/20',
    icon: ShieldAlert,
  },
} as const;

export function AdminGroupConfigsContent() {
  const queryClient = useQueryClient();
  const [editingGroup, setEditingGroup] = useState<GroupConfig | null>(null);
  const [newPhone, setNewPhone] = useState('');
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupId, setNewGroupId] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupTier, setNewGroupTier] = useState<'A' | 'B' | 'C'>('C');

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['janus-group-configs'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<GroupConfig[]>({ table: 'janus_group_configs', select: '*', order: { column: 'updated_at', ascending: false } });
      return (data ?? []) as GroupConfig[];
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (updates: Partial<GroupConfig> & { id: string }) => {
      const { id, ...rest } = updates;
      await apiClient.dbUpdate('janus_group_configs', rest, [{ column: 'id', op: 'eq', value: id }]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['janus-group-configs'] });
      toast({ title: 'Group config updated' });
      setEditingGroup(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: `Failed: ${e.message}`, variant: 'destructive' }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      await apiClient.dbInsert('janus_group_configs', { group_id: newGroupId.trim(), group_name: newGroupName.trim() || null, tier: newGroupTier });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['janus-group-configs'] });
      toast({ title: 'Group config pre-configured' });
      setIsAddingGroup(false);
      setNewGroupId('');
      setNewGroupName('');
      setNewGroupTier('C');
    },
    onError: (e: Error) => toast({ title: 'Error', description: `Failed: ${e.message}`, variant: 'destructive' }),
  });

  function handleSave() {
    if (!editingGroup) return;
    updateMutation.mutate({
      id: editingGroup.id,
      tier: editingGroup.tier,
      group_name: editingGroup.group_name || null,
      notes: editingGroup.notes || null,
      trusted_phones: editingGroup.trusted_phones,
    });
  }

  function addPhone() {
    if (!editingGroup || !newPhone.trim()) return;
    const normalized = newPhone.replace(/[^\d]/g, '');
    if (!normalized) return;
    if (editingGroup.trusted_phones.includes(normalized)) {
      toast({ title: 'Phone already in list', variant: 'destructive' });
      return;
    }
    setEditingGroup({ ...editingGroup, trusted_phones: [...editingGroup.trusted_phones, normalized] });
    setNewPhone('');
  }

  function removePhone(phone: string) {
    if (!editingGroup) return;
    setEditingGroup({ ...editingGroup, trusted_phones: editingGroup.trusted_phones.filter(p => p !== phone) });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold font-display">WhatsApp Group Configs</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Pre-configure groups before adding Janus, or review auto-detected groups.
          </p>
        </div>
        <Button onClick={() => setIsAddingGroup(true)} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Pre-configure Group
        </Button>
      </div>

      {/* Tier Legend */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(Object.entries(TIER_CONFIG) as [string, typeof TIER_CONFIG['A']][]).map(([tier, cfg]) => {
          const Icon = cfg.icon;
          return (
            <Card key={tier} className="border-border/50">
              <CardContent className="p-4 flex items-start gap-3">
                <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border', cfg.color)}>
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-muted-foreground">Tier {tier}</span>
                    <span className="text-sm font-medium">{cfg.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{cfg.description}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Groups Table */}
      {groups.length === 0 ? (
        <Card className="border-border/50">
          <CardContent className="py-12 text-center">
            <MessageSquare className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No groups detected yet. Groups appear here automatically when Janus receives a message in a group chat.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border/50">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Group</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead className="hidden sm:table-cell">Trusted Numbers</TableHead>
                <TableHead className="hidden md:table-cell">Messages</TableHead>
                <TableHead className="hidden md:table-cell">Last Activity</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => {
                const tier = group.tier as 'A' | 'B' | 'C';
                const tierCfg = TIER_CONFIG[tier] || TIER_CONFIG.C;
                const Icon = tierCfg.icon;
                return (
                  <TableRow key={group.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{group.group_name || <span className="text-muted-foreground italic">Unnamed</span>}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{group.group_id}</p>
                        {group.notes && (
                          <p className="text-xs text-muted-foreground mt-1 italic">{group.notes}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('gap-1.5 text-xs font-medium border', tierCfg.color)}>
                        <Icon className="h-3 w-3" />
                        Tier {tier} — {tierCfg.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {group.trusted_phones.length > 0 ? (
                        <div className="flex flex-wrap gap-1">
                          {group.trusted_phones.slice(0, 3).map(p => (
                            <Badge key={p} variant="secondary" className="text-xs font-mono">+{p}</Badge>
                          ))}
                          {group.trusted_phones.length > 3 && (
                            <Badge variant="secondary" className="text-xs">+{group.trusted_phones.length - 3} more</Badge>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex items-center gap-1.5 text-sm">
                        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                        {group.message_count}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                      {format(new Date(group.updated_at), 'MMM d, h:mm a')}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setEditingGroup({ ...group })}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editingGroup} onOpenChange={(open) => !open && setEditingGroup(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Group Config</DialogTitle>
          </DialogHeader>
          {editingGroup && (
            <div className="space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Group ID</label>
                <p className="text-sm font-mono mt-1 text-muted-foreground">{editingGroup.group_id}</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Display Name</label>
                <Input
                  placeholder="e.g. Estate Contractor Group"
                  value={editingGroup.group_name || ''}
                  onChange={(e) => setEditingGroup({ ...editingGroup, group_name: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tier</label>
                <Select
                  value={editingGroup.tier}
                  onValueChange={(v) => setEditingGroup({ ...editingGroup, tier: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A">Tier A — Family-Only (full access)</SelectItem>
                    <SelectItem value="B">Tier B — Trusted Mixed (no sensitive data)</SelectItem>
                    <SelectItem value="C">Tier C — Public Mixed (strict privacy)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {TIER_CONFIG[editingGroup.tier as 'A' | 'B' | 'C']?.description}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes</label>
                <Textarea
                  placeholder="Private notes about this group..."
                  value={editingGroup.notes || ''}
                  onChange={(e) => setEditingGroup({ ...editingGroup, notes: e.target.value })}
                  rows={2}
                />
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Trusted Phone Numbers (Tier B whitelist)
                </label>
                <p className="text-xs text-muted-foreground">Legacy field — no longer grants elevated access. All non-household numbers are treated as outsiders regardless of tier.</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="+1 818 555 0100"
                    value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addPhone()}
                  />
                  <Button variant="outline" size="sm" onClick={addPhone}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {editingGroup.trusted_phones.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {editingGroup.trusted_phones.map(phone => (
                      <div key={phone} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1">
                        <Phone className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs font-mono">+{phone}</span>
                        <button onClick={() => removePhone(phone)} className="text-muted-foreground hover:text-destructive ml-1">
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setEditingGroup(null)}>Cancel</Button>
                <Button onClick={handleSave} disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Group Dialog */}
      <Dialog open={isAddingGroup} onOpenChange={setIsAddingGroup}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pre-configure Group</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Set up a group config before adding Janus to it. Get the group ID from WATI or the WhatsApp group info.
            </p>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Group ID</label>
              <Input
                placeholder="e.g. 120363412345678901@g.us"
                value={newGroupId}
                onChange={(e) => setNewGroupId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Display Name</label>
              <Input
                placeholder="e.g. Estate Contractor Group"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Initial Tier</label>
              <Select value={newGroupTier} onValueChange={(v) => setNewGroupTier(v as 'A' | 'B' | 'C')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="A">Tier A — Family-Only</SelectItem>
                  <SelectItem value="B">Tier B — Trusted Mixed</SelectItem>
                  <SelectItem value="C">Tier C — Public Mixed (default)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsAddingGroup(false)}>Cancel</Button>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={!newGroupId.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? 'Creating...' : 'Create Config'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
