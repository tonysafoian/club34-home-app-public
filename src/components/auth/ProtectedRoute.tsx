import { ReactNode } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useApprovalStatus } from '@/hooks/useApprovalStatus';
import { AuthPage } from '@/components/auth/AuthPage';
import { PendingApproval } from '@/components/auth/PendingApproval';
import { Loader2 } from 'lucide-react';
import { JanusLogo } from '@/components/brand/JanusLogo';

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

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const { isApproved, isPending, isRejected, loading: approvalLoading } = useApprovalStatus();

  if (authLoading) return <BrandedSplash />;
  if (!user) return <AuthPage />;
  if (approvalLoading) return <BrandedSplash />;
  if (isPending) return <PendingApproval />;
  if (isRejected) return <PendingApproval isRejected />;
  if (!isApproved) return <BrandedSplash />;

  return <>{children}</>;
}
