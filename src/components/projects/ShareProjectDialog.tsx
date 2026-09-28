import { useState, useEffect, useCallback } from 'react';
import { Users, X, Loader2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/apiClient';

interface Props {
  projectId: string;
  projectName: string;
}

interface ApprovedUser {
  user_id: string;
  display_name: string | null;
}

interface Share {
  id: string;
  shared_with_user_id: string;
  display_name: string | null;
}

export function ShareProjectDialog({ projectId, projectName }: Props) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<ApprovedUser[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [loading, setLoading] = useState(false);
  const [sharingInProgress, setSharingInProgress] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    // Parallelize both queries — they're independent
    const [profilesResult, sharesResult] = await Promise.all([
      apiClient.dbQuery<ApprovedUser[]>({
        table: 'profiles',
        select: 'user_id, display_name',
        filters: [{ column: 'approval_status', op: 'eq', value: 'approved' }],
      }),
      apiClient.dbQuery<{ id: string; shared_with_user_id: string }[]>({
        table: 'janus_project_shares',
        select: 'id, shared_with_user_id',
        filters: [{ column: 'project_id', op: 'eq', value: projectId }],
      }),
    ]);

    const approvedUsers = (profilesResult.data || [])
      .filter(p => p.user_id !== user?.userId);
    setUsers(approvedUsers);

    const shareList = sharesResult.data || [];

    // Enrich with display names
    const enriched: Share[] = shareList.map(s => {
      const u = approvedUsers.find(a => a.user_id === s.shared_with_user_id);
      return { ...s, display_name: u?.display_name || 'Unknown' };
    });
    setShares(enriched);
    setLoading(false);
  }, [projectId, user]);

  useEffect(() => {
    if (!open || !user) return;
    loadData();
  }, [open, user, loadData]);

  const handleShare = async () => {
    if (!selectedUserId || !user) return;
    setSharingInProgress(true);

    const { data: myProfile } = await apiClient.dbMaybeSingle<{ display_name?: string | null }>({
      table: 'profiles',
      select: 'display_name',
      filters: [{ column: 'user_id', op: 'eq', value: user.userId }],
    });

    const myName = myProfile?.display_name || user.email || 'Someone';

    try {
      await apiClient.dbInsert('janus_project_shares', {
        project_id: projectId,
        shared_with_user_id: selectedUserId,
        shared_by_user_id: user.userId,
      });
    } catch (err) {
      toast({ title: 'Error sharing', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
      setSharingInProgress(false);
      return;
    }

    try {
      await apiClient.invokeFn('project-share-notify', {
        project_id: projectId,
        shared_with_user_id: selectedUserId,
        shared_by_name: myName,
        project_name: projectName,
      });
    } catch (e) {
      console.error('Notification failed:', e);
    }
    toast({ title: 'Project shared!' });
    setSelectedUserId('');
    setSharingInProgress(false);
    loadData();
  };

  const handleRevoke = async (shareId: string) => {
    await apiClient.dbDelete('janus_project_shares', [{ column: 'id', op: 'eq', value: shareId }]);
    toast({ title: 'Access revoked' });
    loadData();
  };

  const availableUsers = users.filter(u => !shares.some(s => s.shared_with_user_id === u.user_id));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground">
          <Users className="h-4 w-4 mr-1.5" />
          <span className="hidden sm:inline">Share</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share Project</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {/* Share with new user */}
            <div className="flex gap-2">
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select a user..." />
                </SelectTrigger>
                <SelectContent>
                  {availableUsers.map(u => (
                    <SelectItem key={u.user_id} value={u.user_id}>
                      {u.display_name || 'Unnamed'}
                    </SelectItem>
                  ))}
                  {availableUsers.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">No users available</div>
                  )}
                </SelectContent>
              </Select>
              <Button onClick={handleShare} disabled={!selectedUserId || sharingInProgress} size="sm">
                {sharingInProgress ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4 mr-1" />}
                Share
              </Button>
            </div>

            {/* Current shares */}
            {shares.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Shared with</p>
                {shares.map(s => (
                  <div key={s.id} className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/50">
                    <span className="text-sm">{s.display_name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRevoke(s.id)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
