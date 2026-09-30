import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Users, UserPlus, Edit2, Trash2, Mail, Phone, Shield, Loader2, Sparkles } from 'lucide-react';
import { useHouseholdMembers, useCreateHouseholdMember, useUpdateHouseholdMember, useDeleteHouseholdMember, type HouseholdMember } from '@/hooks/useHouseholdMembers';
import { useUserRole } from '@/hooks/useUserRole';

const ROLE_BADGES: Record<string, { label: string; color: string }> = {
  admin: { label: 'Admin', color: 'bg-amber-500/15 text-amber-500 border-amber-500/30' },
  member: { label: 'Family Member', color: 'bg-blue-500/15 text-blue-500 border-blue-500/30' },
  worker: { label: 'Household Staff', color: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30' },
  guest: { label: 'Guest', color: 'bg-purple-500/15 text-purple-500 border-purple-500/30' },
};

export default function HouseholdMembersCard() {
  const { isAdmin } = useUserRole();
  const { data: members, isLoading } = useHouseholdMembers();
  const createMember = useCreateHouseholdMember();
  const updateMember = useUpdateHouseholdMember();
  const deleteMember = useDeleteHouseholdMember();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<HouseholdMember | null>(null);
  const [form, setForm] = useState({
    displayName: '',
    role: 'member',
    email: '',
    whatsappNumber: '',
    aliases: '',
  });

  const openAdd = () => {
    setEditingMember(null);
    setForm({
      displayName: '',
      role: 'member',
      email: '',
      whatsappNumber: '',
      aliases: '',
    });
    setDialogOpen(true);
  };

  const openEdit = (member: HouseholdMember) => {
    setEditingMember(member);
    setForm({
      displayName: member.displayName,
      role: member.role || 'member',
      email: member.email || '',
      whatsappNumber: member.whatsappNumber || '',
      aliases: (member.aliases || []).join(', '),
    });
    setDialogOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.displayName.trim()) return;

    const aliasesArray = form.aliases
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    if (editingMember) {
      await updateMember.mutateAsync({
        id: editingMember.id,
        updates: {
          displayName: form.displayName.trim(),
          role: form.role,
          email: form.email.trim() || null,
          whatsappNumber: form.whatsappNumber.trim() || null,
          aliases: aliasesArray.length > 0 ? aliasesArray : null,
        },
      });
    } else {
      await createMember.mutateAsync({
        displayName: form.displayName.trim(),
        role: form.role,
        email: form.email.trim() || null,
        whatsappNumber: form.whatsappNumber.trim() || null,
        aliases: aliasesArray.length > 0 ? aliasesArray : null,
      });
    }
    setDialogOpen(false);
  };

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to remove "${name}" from household members?`)) {
      await deleteMember.mutateAsync(id);
    }
  };

  return (
    <Card data-testid="card-household-members">
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Users className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>Household & Family Members</CardTitle>
              <CardDescription>
                Configure family members and staff without code. Used across calendars, morning briefings, travel, and notifications.
              </CardDescription>
            </div>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={openAdd} className="gap-1.5" data-testid="button-add-member">
              <UserPlus className="h-4 w-4" /> Add Member
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading household members…
          </div>
        ) : !members || members.length === 0 ? (
          <div className="text-center py-8 space-y-3 border border-dashed rounded-xl border-border/60">
            <p className="text-sm text-muted-foreground">No household members configured yet.</p>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={openAdd} className="gap-1.5">
                <UserPlus className="h-4 w-4" /> Add First Member
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {members.map(member => {
              const roleMeta = ROLE_BADGES[member.role] || ROLE_BADGES.member;
              return (
                <div
                  key={member.id}
                  className="rounded-xl border border-border/50 bg-card p-4 space-y-3 relative group hover:border-primary/40 transition-colors"
                  data-testid={`household-member-${member.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5">
                      <div className="h-9 w-9 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-semibold text-sm">
                        {member.displayName.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-sm text-foreground flex items-center gap-1.5">
                          {member.displayName}
                        </div>
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 mt-0.5 border ${roleMeta.color}`}>
                          {roleMeta.label}
                        </Badge>
                      </div>
                    </div>

                    {isAdmin && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(member)}
                          data-testid={`button-edit-member-${member.id}`}
                          title="Edit member"
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(member.id, member.displayName)}
                          data-testid={`button-delete-member-${member.id}`}
                          title="Remove member"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1 text-xs text-muted-foreground pt-1 border-t border-border/30">
                    {member.email ? (
                      <div className="flex items-center gap-1.5 truncate" title={member.email}>
                        <Mail className="h-3 w-3 shrink-0" />
                        <span className="truncate">{member.email}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-muted-foreground/50">
                        <Mail className="h-3 w-3 shrink-0" />
                        <span>No email configured</span>
                      </div>
                    )}

                    {member.whatsappNumber ? (
                      <div className="flex items-center gap-1.5">
                        <Phone className="h-3 w-3 shrink-0" />
                        <span>{member.whatsappNumber}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-muted-foreground/50">
                        <Phone className="h-3 w-3 shrink-0" />
                        <span>No phone configured</span>
                      </div>
                    )}

                    {member.aliases && member.aliases.length > 0 && (
                      <div className="flex items-center gap-1.5 pt-1 text-[11px] text-muted-foreground/80">
                        <Sparkles className="h-3 w-3 shrink-0 text-amber-500/70" />
                        <span className="truncate">Aliases: {member.aliases.join(', ')}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-medium text-foreground">💡 How Janus uses Household Members:</p>
          <ul className="list-disc list-inside space-y-0.5 pl-1">
            <li><strong>Family Calendar:</strong> Automatically aligns Google Calendar feeds with each family member's display name and color.</li>
            <li><strong>Travel Hub:</strong> Lets you assign travelers to flight &amp; hotel itineraries with one click.</li>
            <li><strong>Morning Briefings &amp; Alerts:</strong> Routes urgent announcements and reports directly to the right person's WhatsApp or email.</li>
          </ul>
        </div>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSave} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editingMember ? 'Edit Household Member' : 'Add Household Member'}</DialogTitle>
              <DialogDescription>
                {editingMember ? 'Update details for this household member.' : 'Add a new person to your household OS.'}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="memberName">Full Name *</Label>
                <Input
                  id="memberName"
                  value={form.displayName}
                  onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
                  placeholder="e.g. Alex Smith"
                  required
                  data-testid="input-member-name"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="memberRole">Role</Label>
                <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
                  <SelectTrigger id="memberRole" data-testid="select-member-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="admin">Primary Admin</SelectItem>
                    <SelectItem value="member">Family Member</SelectItem>
                    <SelectItem value="worker">Household Staff</SelectItem>
                    <SelectItem value="guest">Guest</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="memberEmail">Email Address</Label>
                <Input
                  id="memberEmail"
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="e.g. alex@example.com"
                  data-testid="input-member-email"
                />
                <p className="text-[11px] text-muted-foreground">Used for Google Calendar sync and personal daily reports.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="memberPhone">WhatsApp / Mobile Phone</Label>
                <Input
                  id="memberPhone"
                  value={form.whatsappNumber}
                  onChange={e => setForm(f => ({ ...f, whatsappNumber: e.target.value }))}
                  placeholder="e.g. +1 (555) 234-5678"
                  data-testid="input-member-phone"
                />
                <p className="text-[11px] text-muted-foreground">Used for urgent alerts, home reminders, and Janus messaging.</p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="memberAliases">Aliases (comma-separated)</Label>
                <Input
                  id="memberAliases"
                  value={form.aliases}
                  onChange={e => setForm(f => ({ ...f, aliases: e.target.value }))}
                  placeholder="e.g. Dad, Pop, Alex S"
                  data-testid="input-member-aliases"
                />
                <p className="text-[11px] text-muted-foreground">Alternative nicknames or voice trigger names Janus should recognise.</p>
              </div>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createMember.isPending || updateMember.isPending || !form.displayName.trim()}
                data-testid="button-save-member"
              >
                {(createMember.isPending || updateMember.isPending) && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                {editingMember ? 'Save Changes' : 'Add Member'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
