import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink, RefreshCw, AlertTriangle, Link } from 'lucide-react';

interface PairingRequiredProps {
  loading: boolean;
  onRetry: () => void;
  onReregisterAndReauth: () => void;
  onShowSetup: () => void;
}

export function PairingRequired({ loading, onRetry, onReregisterAndReauth, onShowSetup }: PairingRequiredProps) {
  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="font-display flex items-center gap-2">
          <Link className="h-5 w-5 text-[hsl(var(--status-warning))]" />
          Fleet Key Pairing Required
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Your Tesla account needs to approve the Club 34 fleet key before vehicles can be loaded.
          This is a one-time step.
        </p>
        <ol className="list-decimal list-inside text-sm space-y-1 text-muted-foreground">
          <li>Tap the button below to open the Tesla pairing page</li>
          <li>Sign in and approve access for <strong>{import.meta.env.VITE_APP_DOMAIN || "example.com"}</strong></li>
          <li>Come back here and tap <strong>Retry</strong></li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" asChild className="gap-1">
            <a href={`https://tesla.com/_ak/${import.meta.env.VITE_APP_DOMAIN || "example.com"}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3 w-3" /> Open Tesla Pairing
            </a>
          </Button>
          <Button size="sm" variant="outline" onClick={onRetry} disabled={loading} className="gap-1">
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
          <Button size="sm" variant="secondary" onClick={onReregisterAndReauth} disabled={loading} className="gap-1">
            <RefreshCw className="h-3 w-3" /> Re-register & Re-authorize
          </Button>
          <Button size="sm" variant="ghost" onClick={onShowSetup} className="gap-1">
            <AlertTriangle className="h-3 w-3" /> Full Setup
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
