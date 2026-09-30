import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, ShieldCheck, Info, Sparkles, LogIn } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { JanusLogo } from '@/components/brand/JanusLogo';
import { resolveApiUrl } from '@/lib/api/fetchWithAuth';
import { resolveAppPath } from '@/lib/ingress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export function AuthPage() {
  const [loading, setLoading] = useState(false);
  const [showGoogleInfo, setShowGoogleInfo] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('error') === 'google_not_configured') {
      setShowGoogleInfo(true);
    }
  }, []);

  const handleDemoSignIn = async () => {
    setLoading(true);
    try {
      const res = await fetch(resolveApiUrl('/api/auth/demo'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.ok) {
        if (data.token) {
          try {
            localStorage.setItem('auth_token', data.token);
          } catch {}
        }
        window.location.href = resolveAppPath('/');
      } else {
        throw new Error(data.error || 'Sign in failed');
      }
    } catch (err: unknown) {
      toast({
        title: 'Sign in failed',
        description: err instanceof Error ? err.message : 'An unexpected error occurred',
        variant: 'destructive',
      });
      setLoading(false);
    }
  };

  const handleAppleSignIn = () => {
    setLoading(true);
    try {
      window.location.href = resolveApiUrl('/api/auth/apple');
    } catch (err: unknown) {
      toast({
        title: 'Sign in failed',
        description: err instanceof Error ? err.message : 'An unexpected error occurred',
        variant: 'destructive',
      });
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setLoading(true);
    try {
      const configRes = await fetch(resolveApiUrl('/api/auth/config')).catch(() => null);
      if (configRes && configRes.ok) {
        const config = await configRes.json();
        if (!config.googleConfigured) {
          setLoading(false);
          setShowGoogleInfo(true);
          return;
        }
      }
      window.location.href = resolveApiUrl('/api/auth/google');
    } catch {
      setLoading(false);
      setShowGoogleInfo(true);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: '#141519' }}
    >
      <div
        className="absolute -top-32 -left-32 w-96 h-96 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #f1a32914 0%, transparent 70%)' }}
      />
      <div
        className="absolute -bottom-24 -right-24 w-72 h-72 rounded-full blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(circle, #c56a1d0d 0%, transparent 70%)' }}
      />
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-72 blur-3xl pointer-events-none"
        style={{ background: 'radial-gradient(ellipse, #f1a3290a 0%, transparent 60%)' }}
      />

      <div
        className="w-full max-w-sm relative z-10 rounded-2xl shadow-2xl animate-fade-in"
        style={{
          background: 'rgba(28,29,36,0.97)',
          backdropFilter: 'blur(24px)',
          border: '1px solid rgba(241,163,41,0.10)',
          boxShadow: '0 0 60px -20px rgba(241,163,41,0.12), 0 25px 60px -15px rgba(0,0,0,0.6)',
        }}
      >
        <div className="flex flex-col items-center pt-10 pb-6 px-8 text-center">
          <div className="mb-4 janus-glow-soft rounded-full">
            <JanusLogo size="xl" variant="icon" />
          </div>
          <h1 className="font-display text-4xl font-semibold janus-text-gradient tracking-tight">
            Janus
          </h1>
          <p className="mt-1 text-sm font-body text-muted-foreground">
            Residential Estate Operating System
          </p>
          <div
            className="mt-5 w-full h-px"
            style={{ background: 'linear-gradient(to right, transparent, rgba(241,163,41,0.18), transparent)' }}
          />
        </div>

        <div className="flex flex-col gap-3 px-8 pb-8">
          {/* Primary Recommended Option for Home Assistant */}
          <div className="space-y-1.5">
            <Button
              data-testid="button-demo-sign-in"
              onClick={handleDemoSignIn}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 h-12 text-base janus-gradient text-white font-medium shadow-lg hover:opacity-95 transition-opacity"
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <ShieldCheck className="h-5 w-5 shrink-0" />
              )}
              Enter Local Access Mode
            </Button>
            <p className="text-[11px] text-center text-muted-foreground">
              Recommended for Home Assistant • 100% Local Smart Home Control
            </p>
          </div>

          <div className="relative my-3">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-white/10" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-[#1c1d24] px-2 text-muted-foreground text-[10px] tracking-wider">
                Optional Cloud Accounts
              </span>
            </div>
          </div>

          <Button
            data-testid="button-google-sign-in"
            onClick={handleGoogleSignIn}
            disabled={loading}
            variant="outline"
            className="w-full flex items-center justify-center gap-2 h-11 text-sm"
            style={{ borderColor: 'rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            )}
            Sign in with Google
          </Button>

          <Button
            data-testid="button-apple-sign-in"
            onClick={handleAppleSignIn}
            disabled={loading}
            variant="outline"
            className="w-full flex items-center justify-center gap-2 h-11 text-sm"
            style={{ borderColor: 'rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.03)' }}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true" fill="currentColor">
                <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
              </svg>
            )}
            Sign in with Apple
          </Button>
        </div>
      </div>

      {/* Helpful Google OAuth Explanation Modal */}
      <Dialog open={showGoogleInfo} onOpenChange={setShowGoogleInfo}>
        <DialogContent className="max-w-md bg-[#1c1d24] border-white/10 text-white">
          <DialogHeader>
            <div className="flex items-center gap-2 text-amber-400 mb-1">
              <Info className="h-5 w-5" />
              <DialogTitle className="text-lg font-semibold text-white">Google Sign-In is Optional</DialogTitle>
            </div>
            <DialogDescription className="text-gray-300 text-sm leading-relaxed space-y-3 pt-2">
              <p>
                <strong>You don't need Google Sign-In to use Janus!</strong>
              </p>
              <p>
                Google Sign-In is only needed if you want Janus to read your Google Calendar and Gmail for morning digests.
              </p>
              <p>
                For all of your smart lights, climate controls, locks, switches, floor plans, and Gemini voice AI, simply use <strong>Local Access Mode</strong>.
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-col sm:flex-row gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setShowGoogleInfo(false)}
              className="border-white/10 text-gray-300 hover:text-white"
            >
              Close
            </Button>
            <Button
              onClick={() => {
                setShowGoogleInfo(false);
                handleDemoSignIn();
              }}
              className="janus-gradient text-white font-medium gap-2"
            >
              <LogIn className="h-4 w-4" />
              Enter Local Access Mode
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
