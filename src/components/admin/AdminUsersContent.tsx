import { useState, useEffect } from 'react';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Check, X, MoreHorizontal, Loader2, Shield, User } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { InviteUserForm } from '@/components/admin/InviteUserForm';

interface UserProfile {
  id: string;
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  approval_status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  email?: string;
  role?: 'admin' | 'member' | 'guest';
}

export function AdminUsersContent() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchUsers(); }, []);

  async function fetchUsers() {
    setLoading(true);
    // Parallelize both queries and select only needed columns
    const [{ data: profiles }, { data: roles }] = await Promise.all([
      apiClient.dbQuery<Record<string, unknown>[]>({ table: 'profiles', select: 'id, user_id, display_name, avatar_url, approval_status, created_at', order: { column: 'created_at', ascending: false } }),
      apiClient.dbQuery<{ user_id: string; role: string }[]>({ table: 'user_roles', select: 'user_id, role' }),
    ]);
    const usersWithRoles = (profiles || []).map(profile => ({
      ...profile,
      role: roles?.find(r => r.user_id === profile.user_id)?.role,
    }));
    setUsers(usersWithRoles as UserProfile[]);
    setLoading(false);
  }

  async function updateApprovalStatus(userId: string, status: 'approved' | 'rejected') {
    try {
      await apiClient.dbUpdate('profiles', { approval_status: status }, [{ column: 'user_id', op: 'eq', value: userId }]);
    } catch {
      toast({ title: 'Error', description: 'Failed to update user status', variant: 'destructive' });
      return;
    }
    toast({ title: 'Success', description: `User ${status} successfully` });
    fetchUsers();
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'approved': return <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20">Approved</Badge>;
      case 'pending': return <Badge className="bg-amber-500/10 text-amber-600 hover:bg-amber-500/20">Pending</Badge>;
      case 'rejected': return <Badge className="bg-red-500/10 text-red-600 hover:bg-red-500/20">Rejected</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getRoleBadge = (role?: string) => {
    switch (role) {
      case 'admin': return <Badge variant="outline" className="gap-1"><Shield className="h-3 w-3" />Admin</Badge>;
      case 'member': return <Badge variant="outline" className="gap-1"><User className="h-3 w-3" />Member</Badge>;
      default: return <Badge variant="outline">{role || 'None'}</Badge>;
    }
  };

  const getUserInitials = (name: string | null) => {
    if (!name) return '?';
    return name.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  };

  const UserAvatar = ({ u, size = 'sm' }: { u: UserProfile; size?: 'sm' | 'md' }) => (
    <Avatar className={size === 'sm' ? 'h-7 w-7' : 'h-8 w-8'}>
      <AvatarImage src={u.avatar_url || undefined} alt={u.display_name || ''} referrerPolicy="no-referrer" />
      <AvatarFallback className="text-xs font-semibold">{getUserInitials(u.display_name)}</AvatarFallback>
    </Avatar>
  );

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  const pendingUsers = users.filter(u => u.approval_status === 'pending');

  return (
    <div className="space-y-6">
      <InviteUserForm />

      {pendingUsers.length > 0 && (
        <Card className="border-amber-500/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
              Pending Approvals ({pendingUsers.length})
            </CardTitle>
            <CardDescription>New users waiting for your approval</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Signed Up</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingUsers.map(u => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <UserAvatar u={u} />
                        {u.display_name || 'No name'}
                      </div>
                    </TableCell>
                    <TableCell>{format(new Date(u.created_at), 'MMM d, yyyy')}</TableCell>
                    <TableCell>{getStatusBadge(u.approval_status)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" className="gap-1 text-green-600 hover:text-green-700 hover:bg-green-50" onClick={() => updateApprovalStatus(u.user_id, 'approved')}>
                          <Check className="h-4 w-4" />Approve
                        </Button>
                        <Button size="sm" variant="outline" className="gap-1 text-red-600 hover:text-red-700 hover:bg-red-50" onClick={() => updateApprovalStatus(u.user_id, 'rejected')}>
                          <X className="h-4 w-4" />Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>All Users ({users.length})</CardTitle>
          <CardDescription>Manage all registered users</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Signed Up</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map(u => (
                <TableRow key={u.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      <UserAvatar u={u} />
                      <span>
                        {u.display_name || 'No name'}
                        {u.user_id === user?.userId && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{getRoleBadge(u.role)}</TableCell>
                  <TableCell>{getStatusBadge(u.approval_status)}</TableCell>
                  <TableCell>{format(new Date(u.created_at), 'MMM d, yyyy')}</TableCell>
                  <TableCell className="text-right">
                    {u.user_id !== user?.userId && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon"><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {u.approval_status !== 'approved' && (
                            <DropdownMenuItem onClick={() => updateApprovalStatus(u.user_id, 'approved')}>
                              <Check className="mr-2 h-4 w-4 text-green-600" />Approve
                            </DropdownMenuItem>
                          )}
                          {u.approval_status !== 'rejected' && (
                            <DropdownMenuItem onClick={() => updateApprovalStatus(u.user_id, 'rejected')}>
                              <X className="mr-2 h-4 w-4 text-red-600" />Reject
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
