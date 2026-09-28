import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, CheckCircle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Club34Logo } from '@/components/brand/Club34Logo';

export default function ResetPassword() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token') || url.hash?.match(/access_token=([^&]+)/)?.[1];
    if (token) {
      setSessionReady(true);
    } else {
      fetch('/api/auth/me', { credentials: 'include' })
        .then(r => { if (r.ok) setSessionReady(true); })
        .catch(() => {});
    }
  }, []);

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();

    if (password !== confirmPassword) {
      toast({
        title: 'Passwords do not match',
        description: 'Please make sure both passwords are the same.',
        variant: 'destructive',
      });
      return;
    }

    if (password.length < 6) {
      toast({
        title: 'Password too short',
        description: 'Password must be at least 6 characters.',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const url = new URL(window.location.href);
      const token = url.searchParams.get('token') || url.hash?.match(/access_token=([^&]+)/)?.[1] || '';
      const resp = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password, token }),
      });
      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        toast({
          title: 'Reset failed',
          description: errData.message || 'Failed to reset password',
          variant: 'destructive',
        });
      } else {
        setSuccess(true);
        toast({
          title: 'Password updated',
          description: 'Your password has been reset successfully.',
        });
        setTimeout(() => navigate('/'), 2000);
      }
    } finally {
      setLoading(false);
    }
  };

  if (!sessionReady) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="text-center space-y-4">
          <CheckCircle className="h-12 w-12 text-primary mx-auto" />
          <h2 className="text-2xl font-display text-foreground">Password Reset Successful</h2>
          <p className="text-muted-foreground">Redirecting to login...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden bg-background">
      <div className="absolute inset-0 club34-gradient opacity-10" />
      <Card className="w-full max-w-md animate-fade-in glass relative z-10 club34-glow-soft">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto club34-glow-soft rounded-full inline-block">
            <Club34Logo size="xl" variant="icon" />
          </div>
          <CardTitle className="text-3xl font-display club34-text-gradient">Reset Password</CardTitle>
          <CardDescription>Enter your new password below</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleReset} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">New Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="bg-background/50"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="bg-background/50"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Reset Password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
