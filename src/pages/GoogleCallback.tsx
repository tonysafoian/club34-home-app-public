import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { exchangeGoogleCode } from '@/lib/api/google';
import { apiClient } from '@/lib/apiClient';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function GoogleCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    const code = searchParams.get('code');
    const error = searchParams.get('error');
    const state = searchParams.get('state') || '';
    const isGoAccess = state.startsWith('goaccess_');

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

    const checkAuth = async () => {
      const resp = await fetch('/api/auth/me', { credentials: 'include' });
      return resp.ok;
    };

    checkAuth()
      .then((authenticated) => {
        if (!authenticated) {
          setStatus('error');
          setErrorMsg('No active session. Please log in first, then reconnect Google.');
          return undefined;
        }
        if (isGoAccess) {
          return apiClient.post('/api/goaccess/auth', { action: 'callback', code, state }) as Promise<{ success: boolean; google_email?: string; error?: string }>;
        }
        return exchangeGoogleCode(code) as Promise<{ success: boolean; google_email?: string; error?: string }>;
      })
      .then((result) => {
        if (!result) return;
        if (result.success) {
          setStatus('success');
          setEmail(result.google_email || '');
          setTimeout(() => navigate(isGoAccess ? '/settings' : '/'), 2000);
        } else {
          setStatus('error');
          setErrorMsg(result.error || 'Unknown error');
        }
      })
      .catch((err) => {
        setStatus('error');
        setErrorMsg(err.message);
      });
  }, [searchParams, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 max-w-md mx-auto px-6">
        {status === 'loading' && (
          <>
            <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto" />
            <h2 className="text-lg font-semibold" data-testid="text-status">Connecting Google...</h2>
            <p className="text-sm text-muted-foreground">Please wait while we complete the connection.</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle2 className="h-12 w-12 text-primary mx-auto" />
            <h2 className="text-lg font-semibold" data-testid="text-status">Google Connected!</h2>
            <p className="text-sm text-muted-foreground">
              {email ? `Connected as ${email}. ` : ''}Redirecting to dashboard...
            </p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="h-12 w-12 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold" data-testid="text-status">Connection Failed</h2>
            <p className="text-sm text-muted-foreground">{errorMsg}</p>
            <Button onClick={() => navigate('/')} variant="outline" className="mt-4" data-testid="button-back">
              Back to Dashboard
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
