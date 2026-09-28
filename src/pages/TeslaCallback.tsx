import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { apiClient } from '@/lib/apiClient';
import { Loader2 } from 'lucide-react';

export default function TeslaCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');

    if (!code) {
      setError('No authorization code received from Tesla.');
      return;
    }

    // Validate CSRF state parameter (stored in localStorage to survive cross-tab redirects)
    let storedState: string | null = null;
    try {
      storedState = localStorage.getItem('tesla_oauth_state');
      const storedTs = localStorage.getItem('tesla_oauth_state_ts');
      localStorage.removeItem('tesla_oauth_state');
      localStorage.removeItem('tesla_oauth_state_ts');

      const tsNum = storedTs ? parseInt(storedTs, 10) : NaN;
      if (isNaN(tsNum) || Date.now() - tsNum > 10 * 60 * 1000) {
        storedState = null;
      }
    } catch (e) {
      console.error('Failed to read OAuth state:', e);
    }

    if (!state || !storedState || state !== storedState) {
      setError('OAuth state mismatch — possible CSRF attack. Please try again.');
      return;
    }

    (async () => {
      try {
        await apiClient.invokeFn('tesla-setup', { action: 'exchange-code', code });
        navigate('/home-systems?section=vehicles', { replace: true });
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    })();
  }, [searchParams, navigate]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <p className="text-destructive font-medium">{error}</p>
          <a href="/home-systems?section=vehicles" className="text-primary underline">Back to Teslas</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
        <p className="text-muted-foreground">Completing Tesla authorization...</p>
      </div>
    </div>
  );
}
