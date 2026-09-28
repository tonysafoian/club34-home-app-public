import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchWithAuth, setStoredToken } from '@/lib/api/fetchWithAuth';

export default function AuthGoogleCallback() {
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const code = searchParams.get('code');
    const error = searchParams.get('error');

    if (error) {
      setStatus('error');
      setErrorMsg(error === 'access_denied' ? 'Access was denied' : error);
      return;
    }

    if (!code) {
      setStatus('error');
      setErrorMsg('No authorization code received');
      return;
    }

    fetchWithAuth('/api/auth/google/exchange', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
      .then(async (resp) => {
        const data = await resp.json();
        if (resp.ok && data.success) {
          if (data.token) {
            setStoredToken(data.token);
          }
          setStatus('success');
          setTimeout(() => {
            window.location.href = '/';
          }, 1000);
        } else {
          setStatus('error');
          setErrorMsg(data.error || 'Login failed');
        }
      })
      .catch((err) => {
        setStatus('error');
        setErrorMsg(err.message || 'Login failed');
      });
  }, [searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md mx-auto px-6">
        {status === 'loading' && (
          <>
            <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" data-testid="icon-loading" />
            <h2 className="text-lg font-semibold" data-testid="text-status">Signing in...</h2>
            <p className="text-sm text-muted-foreground">Please wait while we complete authentication.</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" data-testid="icon-success" />
            <h2 className="text-lg font-semibold" data-testid="text-status">Signed In!</h2>
            <p className="text-sm text-muted-foreground">Redirecting to dashboard...</p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="h-12 w-12 text-destructive mx-auto" data-testid="icon-error" />
            <h2 className="text-lg font-semibold" data-testid="text-status">Sign In Failed</h2>
            <p className="text-sm text-muted-foreground">{errorMsg}</p>
            <Button onClick={() => (window.location.href = '/')} variant="outline" className="mt-4" data-testid="button-retry">
              Try Again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
