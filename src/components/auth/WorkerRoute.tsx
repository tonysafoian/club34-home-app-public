import { ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { AuthPage } from '@/components/auth/AuthPage';
import { Loader2 } from 'lucide-react';
import { JanusLogo } from '@/components/brand/JanusLogo';
import { resolveAppPath } from '@/lib/ingress';

function BrandedSplash() {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-6"
      style={{ background: '#141519' }}
    >
      <div className="janus-glow-soft rounded-full">
        <JanusLogo size="xl" variant="icon" />
      </div>
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}

// Allows workers OR admins (for admin preview). Blocks guests/members.
export function WorkerRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <BrandedSplash />;
  if (!user) return <AuthPage />;

  const isWorker = user.roles.includes('worker');
  const isAdmin = user.roles.includes('admin');

  if (!isWorker && !isAdmin) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 px-6"
        style={{ background: '#141519' }}
      >
        <JanusLogo size="xl" variant="icon" />
        <h1 className="text-xl font-semibold text-foreground">Access Restricted</h1>
        <p className="text-muted-foreground text-center max-w-sm">
          Janus Time is only available to registered workers. Contact the estate administrator if you believe this is an error.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

// Only allows Janus admins (standard 'admin' role from the JWT — there is no
// separate Time admin list; the server enforces the same role on /api/time/admin/*).
// Workers use /time. Household members see an access-denied screen.
export function TimeAdminRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <BrandedSplash />;
  if (!user) return <AuthPage />;

  const isAdmin = user.roles.includes('admin');
  const isWorker = user.roles.includes('worker');

  // Workers are redirected to their own time page
  if (isWorker && !isAdmin) {
    window.location.href = resolveAppPath('/time');
    return <BrandedSplash />;
  }

  if (!isAdmin) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4 px-6"
        style={{ background: '#141519' }}
      >
        <JanusLogo size="xl" variant="icon" />
        <h1 className="text-xl font-semibold text-foreground">Admin Only</h1>
        <p className="text-muted-foreground text-center max-w-sm">
          This page is only accessible to Janus Time administrators.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
