import { useState } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { UserPlus, Mail, Trash2, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

const emailSchema = z.string().trim().email('Please enter a valid email address').max(255);

interface InvitedEmail {
  id: string;
  email: string;
}

export function InviteUserForm() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');

  const { data: invites = [], isLoading } = useQuery({
    queryKey: ['invited-emails'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<InvitedEmail[]>({ table: 'invited_emails', select: '*', order: { column: 'created_at', ascending: false } });
      return data ?? [];
    },
  });

  const addInvite = useMutation({
    mutationFn: async (newEmail: string) => {
      await apiClient.dbInsert('invited_emails', { email: newEmail.toLowerCase().trim(), invited_by: user!.userId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invited-emails'] });
      setEmail('');
      toast({ title: 'Invite added', description: 'User will be auto-approved on sign in.' });
    },
    onError: (err: Error) => {
      const msg = err.message?.includes('duplicate') ? 'This email has already been invited.' : 'Failed to add invite.';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    },
  });

  const removeInvite = useMutation({
    mutationFn: async (id: string) => {
      await apiClient.dbDelete('invited_emails', [{ column: 'id', op: 'eq', value: id }]);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invited-emails'] });
      toast({ title: 'Invite removed' });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const result = emailSchema.safeParse(email);
    if (!result.success) {
      toast({ title: 'Invalid email', description: result.error.errors[0].message, variant: 'destructive' });
      return;
    }
    addInvite.mutate(result.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="h-5 w-5" />
          Invite Users
        </CardTitle>
        <CardDescription>Add emails to auto-approve when they sign in with Google</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            type="email"
            placeholder="email@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            className="flex-1"
          />
          <Button type="submit" disabled={addInvite.isPending || !email.trim()}>
            {addInvite.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Invite'}
          </Button>
        </form>

        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : invites.length > 0 ? (
          <div className="space-y-2">
            {invites.map(invite => (
              <div key={invite.id} className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">{invite.email}</span>
                  <Badge variant="outline" className="text-xs">Pending sign-in</Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => removeInvite.mutate(invite.id)}
                  disabled={removeInvite.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-2">No pending invites</p>
        )}
      </CardContent>
    </Card>
  );
}
