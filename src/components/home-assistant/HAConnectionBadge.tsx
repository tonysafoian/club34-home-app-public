import { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Wifi, WifiOff, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { testHAConnection, HAConnectionResult, HAUnavailableError } from '@/lib/api/homeAssistant';

type ConnectionState = 'checking' | 'connected' | 'disconnected' | 'unavailable';

export function HAConnectionBadge({ onRefresh }: { onRefresh?: () => void }) {
  const [state, setState] = useState<ConnectionState>('checking');
  const [haVersion, setHAVersion] = useState<string | null>(null);

  const check = async () => {
    setState('checking');
    try {
      const result: HAConnectionResult = await testHAConnection();
      setHAVersion(result.data?.version ?? null);
      setState(result.connected ? 'connected' : 'disconnected');
    } catch (err) {
      setHAVersion(null);
      setState(err instanceof HAUnavailableError ? 'unavailable' : 'disconnected');
    }
  };

  useEffect(() => { check(); }, []);

  if (state === 'checking') return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="h-3 w-3 animate-spin" />
      Connecting...
    </Badge>
  );

  return (
    <div className="flex items-center gap-2">
      <Badge
        variant={state === 'connected' ? 'default' : state === 'unavailable' ? 'outline' : 'destructive'}
        className={state === 'unavailable' ? 'gap-1 text-muted-foreground' : 'gap-1'}
      >
        {state === 'connected' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
        {state === 'connected'
          ? `Home Assistant${haVersion ? ` v${haVersion}` : ''}`
          : state === 'unavailable'
            ? 'Not configured'
            : 'Disconnected'}
      </Badge>
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { check(); onRefresh?.(); }}>
        <RefreshCw className="h-3 w-3" />
      </Button>
    </div>
  );
}
