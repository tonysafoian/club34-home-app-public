import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, Loader2, LogOut } from 'lucide-react';
import { useGoogleConnectionStatus, useGoogleConnect, useGoogleDisconnect } from '@/hooks/useGoogleCalendar';

export default function GoogleServicesCard() {
  const { data: status, isLoading } = useGoogleConnectionStatus();
  const connect = useGoogleConnect();
  const disconnect = useGoogleDisconnect();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
          </div>
          <div className="flex-1">
            <CardTitle className="flex items-center gap-2">
              Google Services
              {status?.connected && (
                <span className="flex items-center gap-1 text-xs font-normal text-primary">
                  <CheckCircle2 className="w-3 h-3" />
                  Connected
                </span>
              )}
            </CardTitle>
            <CardDescription>
              Connect Google Calendar, Gmail, Drive & Contacts
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
            <div className="rounded-lg bg-primary/10 border border-primary/20 p-4">
              <p className="text-sm text-primary">
                Connected as <span className="font-medium">{status.google_email}</span>
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Disconnecting...</>
              ) : (
                <><LogOut className="mr-2 h-4 w-4" />Disconnect Google</>
              )}
            </Button>
          </>
        ) : (
          <Button
            onClick={() => connect.mutate()}
            disabled={connect.isPending}
          >
            {connect.isPending ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Connecting...</>
            ) : (
              'Connect Google Account'
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
