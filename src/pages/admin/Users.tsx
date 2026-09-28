import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWithAuth } from '@/lib/api/fetchWithAuth';
import { apiClient } from '@/lib/apiClient';
import { useUserRole } from '@/hooks/useUserRole';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ArrowLeft, Check, X, MoreHorizontal, Users, Loader2, Shield, User, Mail, Bot } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import { InviteUserForm } from '@/components/admin/InviteUserForm';

interface UserProfile {
  id: string;
  user_id: string;
  display_name: string | null;
  approval_status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  email?: string;
  role?: 'admin' | 'member' | 'guest';
}

export default function AdminUsers() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { isAdmin, loading: roleLoading } = useUserRole();
  const { toast } = useToast();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!roleLoading && !isAdmin) {
      navigate('/');
    }
  }, [isAdmin, roleLoading, navigate]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);

    try {
      const [profilesResult, rolesResult] = await Promise.all([
        apiClient.dbQuery<Record<string, unknown>[]>({
          table: 'profiles',
          select: '*',
          order: { column: 'created_at', ascending: false },
          limit: 200,
        }),
        apiClient.dbQuery<{ user_id: string; role: string }[]>({
          table: 'user_roles',
          select: 'user_id, role',
        }),
      ]);

      const usersWithRoles = (profilesResult.data || []).map(profile => ({
        ...profile,
        role: rolesResult.data?.find(r => r.user_id === profile.user_id)?.role,
      }));

      setUsers(usersWithRoles as UserProfile[]);
    } catch (err) {
      console.error('Error fetching users:', err);
      toast({ title: 'Error', description: 'Failed to fetch users', variant: 'destructive' });
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    if (isAdmin) {
      fetchUsers();
    }
  }, [isAdmin, fetchUsers]);

  async function updateApprovalStatus(userId: string, status: 'approved' | 'rejected') {
    try {
      await apiClient.dbUpdate('profiles', { approval_status: status }, [{ column: 'user_id', op: 'eq', value: userId }]);
    } catch (err) {
      console.error('Error updating status:', err);
      toast({ title: 'Error', description: 'Failed to update user status', variant: 'destructive' });
      return;
    }

    toast({
      title: 'Success',
      description: `User ${status === 'approved' ? 'approved' : 'rejected'} successfully`,
    });

    fetchUsers();
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'approved':
        return <Badge className="bg-green-500/10 text-green-600 hover:bg-green-500/20">Approved</Badge>;
      case 'pending':
        return <Badge className="bg-amber-500/10 text-amber-600 hover:bg-amber-500/20">Pending</Badge>;
      case 'rejected':
        return <Badge className="bg-red-500/10 text-red-600 hover:bg-red-500/20">Rejected</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getRoleBadge = (role?: string) => {
    switch (role) {
      case 'admin':
        return (
          <Badge variant="outline" className="gap-1">
            <Shield className="h-3 w-3" />
            Admin
          </Badge>
        );
      case 'member':
        return (
          <Badge variant="outline" className="gap-1">
            <User className="h-3 w-3" />
            Member
          </Badge>
        );
      default:
        return <Badge variant="outline">{role || 'None'}</Badge>;
    }
  };

  if (roleLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return null;
  }

  const pendingUsers = users.filter(u => u.approval_status === 'pending');
  const approvedUsers = users.filter(u => u.approval_status === 'approved');
  const rejectedUsers = users.filter(u => u.approval_status === 'rejected');

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Users className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">User Management</h1>
              <p className="text-xs text-muted-foreground">Approve and manage user access</p>
            </div>
          </div>
        </div>
      </header>

      <main className="container py-6 space-y-6">
        {/* Admin Quick Links */}
        <div className="flex gap-3">
          <Button variant="outline" className="gap-2" onClick={() => navigate('/admin/email-logs')}>
            <Mail className="h-4 w-4" />
            Email Logs
          </Button>
          <Button variant="outline" className="gap-2" onClick={() => navigate('/admin/janus-access')}>
            <Bot className="h-4 w-4" />
            Janus Access Control
          </Button>
        </div>

        {/* Invite Users */}
        <InviteUserForm />

        {/* Pending Approvals */}
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
                  {pendingUsers.map(userProfile => (
                    <TableRow key={userProfile.id}>
                      <TableCell className="font-medium">
                        {userProfile.display_name || 'No name'}
                      </TableCell>
                      <TableCell>
                        {format(new Date(userProfile.created_at), 'MMM d, yyyy')}
                      </TableCell>
                      <TableCell>{getStatusBadge(userProfile.approval_status)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => updateApprovalStatus(userProfile.user_id, 'approved')}
                          >
                            <Check className="h-4 w-4" />
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1 text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => updateApprovalStatus(userProfile.user_id, 'rejected')}
                          >
                            <X className="h-4 w-4" />
                            Reject
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

        {/* All Users */}
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
                {users.map(userProfile => (
                  <TableRow key={userProfile.id}>
                    <TableCell className="font-medium">
                      {userProfile.display_name || 'No name'}
                      {userProfile.user_id === user?.userId && (
                        <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                      )}
                    </TableCell>
                    <TableCell>{getRoleBadge(userProfile.role)}</TableCell>
                    <TableCell>{getStatusBadge(userProfile.approval_status)}</TableCell>
                    <TableCell>
                      {format(new Date(userProfile.created_at), 'MMM d, yyyy')}
                    </TableCell>
                    <TableCell className="text-right">
                      {userProfile.user_id !== user?.userId && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {userProfile.approval_status !== 'approved' && (
                              <DropdownMenuItem 
                                onClick={() => updateApprovalStatus(userProfile.user_id, 'approved')}
                              >
                                <Check className="mr-2 h-4 w-4 text-green-600" />
                                Approve
                              </DropdownMenuItem>
                            )}
                            {userProfile.approval_status !== 'rejected' && (
                              <DropdownMenuItem 
                                onClick={() => updateApprovalStatus(userProfile.user_id, 'rejected')}
                              >
                                <X className="mr-2 h-4 w-4 text-red-600" />
                                Reject
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
      </main>
    </div>
  );
}
