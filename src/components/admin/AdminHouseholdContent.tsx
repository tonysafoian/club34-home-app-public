import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Pencil, Power, PowerOff, Users, AlertTriangle, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';

interface HouseholdMember {
  id: string;
  displayName: string;
  email: string | null;
  whatsappNumber: string | null;
  notionUuid: string | null;
  supabaseUuid: string | null;
  role: string;
  aliases: string[] | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_MEMBER: Omit<HouseholdMember, 'id' | 'createdAt' | 'updatedAt'> = {
  displayName: '',
  email: null,
  whatsappNumber: null,
  notionUuid: null,
  supabaseUuid: null,
  role: 'member',
  aliases: [],
  isActive: true,
};

export function AdminHouseholdContent() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editingMember, setEditingMember] = useState<HouseholdMember | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [formData, setFormData] = useState<typeof EMPTY_MEMBER>(EMPTY_MEMBER);
  const [aliasInput, setAliasInput] = useState('');

  const { data: members, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['household-members'],
    queryFn: async () => {
      const res = await fetchWithAuth('/api/data/household-members');
      if (!res.ok) throw new Error('Failed to fetch household members');
      return (await res.json()) as HouseholdMember[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: { id?: string; payload: typeof EMPTY_MEMBER }) => {
      const url = data.id
        ? `/api/data/household-members/${data.id}`
        : '/api/data/household-members';
      const method = data.id ? 'PATCH' : 'POST';
      const res = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(data.payload),
      });
      if (!res.ok) throw new Error('Failed to save household member');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['household-members'] });
      setEditingMember(null);
      setIsAdding(false);
      setFormData(EMPTY_MEMBER);
      setAliasInput('');
      toast({ title: 'Saved', description: 'Household member updated.' });
    },
    onError: (e: Error) => {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await fetchWithAuth(`/api/data/household-members/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) throw new Error('Failed to toggle member status');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['household-members'] });
    },
    onError: (e: Error) => {
      toast({ title: 'Error', description: e.message, variant: 'destructive' });
    },
  });

  function openEdit(member: HouseholdMember) {
    setEditingMember(member);
    setFormData({
      displayName: member.displayName,
      email: member.email,
      whatsappNumber: member.whatsappNumber,
      notionUuid: member.notionUuid,
      supabaseUuid: member.supabaseUuid,
      role: member.role,
      aliases: member.aliases || [],
      isActive: member.isActive,
    });
    setAliasInput('');
  }

  function openAdd() {
    setIsAdding(true);
    setFormData(EMPTY_MEMBER);
    setAliasInput('');
  }

  function addAlias() {
    const alias = aliasInput.trim().toLowerCase();
    if (!alias) return;
    setFormData((prev) => ({ ...prev, aliases: [...(prev.aliases || []), alias] }));
    setAliasInput('');
  }

  function removeAlias(alias: string) {
    setFormData((prev) => ({ ...prev, aliases: (prev.aliases || []).filter((a) => a !== alias) }));
  }

  function handleSave() {
    const payload = {
      ...formData,
      email: formData.email?.trim() || null,
      whatsappNumber: formData.whatsappNumber?.trim() || null,
      notionUuid: formData.notionUuid?.trim() || null,
      supabaseUuid: formData.supabaseUuid?.trim() || null,
      aliases: formData.aliases?.filter(Boolean) || [],
    };
    saveMutation.mutate({ id: editingMember?.id, payload });
  }

  const isDialogOpen = isAdding || !!editingMember;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Users className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold font-display">Household Members</h2>
            <p className="text-sm text-muted-foreground">
              Single source of truth — changes propagate to all Janus channels instantly
            </p>
          </div>
        </div>
        <Button onClick={openAdd} size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Add Member
        </Button>
      </div>

      {/* Info Banner */}
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-400">
        <strong>Tip:</strong> Updating a Notion UUID here immediately fixes Notion assignments across Web Chat, WhatsApp, and Email — no code deploy needed.
      </div>

      {/* Table */}
      {isError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-6 text-center space-y-3" data-testid="error-household-members">
          <AlertTriangle className="h-8 w-8 text-destructive mx-auto" />
          <p className="text-sm text-destructive font-medium">
            Failed to load household members
          </p>
          <p className="text-xs text-muted-foreground">
            {error instanceof Error ? error.message : 'An unexpected error occurred'}
          </p>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()} data-testid="button-retry-household">
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading members…</div>
      ) : (
        <div className="rounded-lg border border-border/50 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>WhatsApp</TableHead>
                <TableHead>Notion UUID</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Aliases</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(members || []).map((member) => (
                <TableRow key={member.id} className={!member.isActive ? 'opacity-40' : ''}>
                  <TableCell className="font-medium">{member.displayName}</TableCell>
                  <TableCell className="text-muted-foreground text-xs font-mono">
                    {member.email || <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs font-mono">
                    {member.whatsappNumber || <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                  <TableCell>
                    {member.notionUuid ? (
                      <span className="text-xs font-mono text-green-400/80">
                        {member.notionUuid.slice(0, 8)}…
                      </span>
                    ) : (
                      <Badge variant="outline" className="text-xs text-yellow-500/70 border-yellow-500/30">
                        No Notion seat
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={member.role === 'admin' ? 'default' : 'secondary'}
                      className="text-xs"
                    >
                      {member.role}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-[160px]">
                      {(member.aliases || []).slice(0, 3).map((a) => (
                        <Badge key={a} variant="outline" className="text-xs px-1 py-0">
                          {a}
                        </Badge>
                      ))}
                      {(member.aliases || []).length > 3 && (
                        <span className="text-xs text-muted-foreground">+{member.aliases!.length - 3}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={member.isActive ? 'default' : 'outline'}
                      className={`text-xs ${member.isActive ? 'bg-green-500/20 text-green-400 border-green-500/30' : ''}`}
                    >
                      {member.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEdit(member)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => toggleActiveMutation.mutate({ id: member.id, isActive: !member.isActive })}
                        title={member.isActive ? 'Deactivate' : 'Activate'}
                      >
                        {member.isActive ? (
                          <PowerOff className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <Power className="h-3.5 w-3.5 text-green-400" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Edit / Add Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={(open) => { if (!open) { setEditingMember(null); setIsAdding(false); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isAdding ? 'Add Household Member' : `Edit ${editingMember?.displayName}`}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="displayName">Display Name *</Label>
                <Input
                  id="displayName"
                  value={formData.displayName}
                  onChange={(e) => setFormData((p) => ({ ...p, displayName: e.target.value }))}
                  placeholder="Jesse"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role">Role</Label>
                <Select value={formData.role} onValueChange={(v) => setFormData((p) => ({ ...p, role: v }))}>
                  <SelectTrigger id="role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">admin</SelectItem>
                    <SelectItem value="member">member</SelectItem>
                    <SelectItem value="guest">guest</SelectItem>
                    <SelectItem value="staff">staff</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={formData.email || ''}
                onChange={(e) => setFormData((p) => ({ ...p, email: e.target.value || null }))}
                placeholder="member@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="whatsapp">WhatsApp Number</Label>
              <Input
                id="whatsapp"
                value={formData.whatsappNumber || ''}
                onChange={(e) => setFormData((p) => ({ ...p, whatsappNumber: e.target.value || null }))}
                placeholder="+15550100"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notionUuid">
                Notion UUID{' '}
                <span className="text-muted-foreground font-normal text-xs">(leave blank if no Notion seat)</span>
              </Label>
              <Input
                id="notionUuid"
                value={formData.notionUuid || ''}
                onChange={(e) => setFormData((p) => ({ ...p, notionUuid: e.target.value || null }))}
                placeholder="2b8d872b-594c-811f-93c5-0002e2fc9856"
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="supabaseUuid">
                Supabase UUID{' '}
                <span className="text-muted-foreground font-normal text-xs">(from auth users)</span>
              </Label>
              <Input
                id="supabaseUuid"
                value={formData.supabaseUuid || ''}
                onChange={(e) => setFormData((p) => ({ ...p, supabaseUuid: e.target.value || null }))}
                placeholder="9adf55fe-8dc2-4dd3-97e6-bde6975fe961"
                className="font-mono text-sm"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Name Aliases <span className="text-muted-foreground font-normal text-xs">(Janus uses these for Notion lookups)</span></Label>
              <div className="flex gap-2">
                <Input
                  value={aliasInput}
                  onChange={(e) => setAliasInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addAlias())}
                  placeholder="jesse b, the builder…"
                  className="flex-1"
                />
                <Button type="button" variant="outline" size="sm" onClick={addAlias}>
                  Add
                </Button>
              </div>
              {(formData.aliases || []).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {formData.aliases!.map((a) => (
                    <Badge
                      key={a}
                      variant="secondary"
                      className="cursor-pointer hover:bg-destructive/20"
                      onClick={() => removeAlias(a)}
                    >
                      {a} ✕
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => { setEditingMember(null); setIsAdding(false); }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSave}
                disabled={!formData.displayName || saveMutation.isPending}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
