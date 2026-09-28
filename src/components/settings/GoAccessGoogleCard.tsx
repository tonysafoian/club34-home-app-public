import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, Loader2, LogOut, DoorOpen } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useAuth } from '@/hooks/useAuth';
import { toast } from '@/hooks/use-toast';

export default function GoAccessGoogleCard() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery({
    queryKey: ['goaccess-connection-status'],
    queryFn: async () => {
      const result = await apiClient.post('/api/goaccess/auth', { action: 'status' });
      return result as { connected: boolean; google_email: string | null };
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  const connect = useMutation({
    mutationFn: async () => {
      const result = await apiClient.post('/api/goaccess/auth', { action: 'authorize' }) as { success: boolean; url: string };
      if (!result.success) throw new Error('Failed to get auth URL');
      window.location.href = result.url;
    },
    onError: (error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiClient.post('/api/goaccess/auth', { action: 'disconnect' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['goaccess-connection-status'] });
      toast({ title: 'GoAccess Google account disconnected' });
    },
    onError: (error) => {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
            <DoorOpen className="w-5 h-5 text-orange-500" />
          </div>
          <div className="flex-1">
            <CardTitle className="flex items-center gap-2">
              GoAccess Gate
              {status?.connected && (
                <span className="flex items-center gap-1 text-xs font-normal text-primary">
                  <CheckCircle2 className="w-3 h-3" />
                  Connected
                </span>
              )}
            </CardTitle>
            <CardDescription>
              Connect gate-notifications@example.com for gate check-in notifications
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking connection...
          </div>
        ) : status?.connected ? (
          <>
            <div className="rounded-lg bg-orange-500/10 border border-orange-500/20 p-4">
              <p className="text-sm text-orange-700 dark:text-orange-400">
                Connected as <span className="font-medium">{status.google_email}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Gate check-in emails are being polled automatically every 5 minutes.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              data-testid="disconnect-goaccess"
            >
              {disconnect.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Disconnecting...</>
              ) : (
                <><LogOut className="mr-2 h-4 w-4" />Disconnect</>
              )}
            </Button>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connect the gate-notifications@example.com account to import gate check-in notifications from GoAccess.
            </p>
            <Button
              onClick={() => connect.mutate()}
              disabled={connect.isPending}
              data-testid="connect-goaccess"
            >
              {connect.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Connecting...</>
              ) : (
                'Connect Google Account'
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
