import { useAuth } from '@/hooks/useAuth';
import { useApprovalStatus } from '@/hooks/useApprovalStatus';
import { AuthPage } from '@/components/auth/AuthPage';
import { PendingApproval } from '@/components/auth/PendingApproval';
import { useLocation } from 'react-router-dom';
import { lazy, Suspense } from 'react';

const Dashboard = lazy(() => import('./Dashboard'));
const HomePage = lazy(() => import('./HomePage'));
const ProductivityDay = lazy(() => import('./ProductivityDay'));
import { Loader2 } from 'lucide-react';
import { Club34Logo } from '@/components/brand/Club34Logo';

const BrandedSplash = () => (
  <div
    className="min-h-screen flex flex-col items-center justify-center gap-6"
    style={{ background: '#141519' }}
  >
    <div className="club34-glow-soft rounded-full">
      <Club34Logo size="xl" variant="icon" />
    </div>
    <Loader2 className="h-6 w-6 animate-spin text-primary" />
  </div>
);

const Index = () => {
  const { user, loading: authLoading } = useAuth();
  const { isApproved, isPending, isRejected, loading: approvalLoading } = useApprovalStatus();
  const location = useLocation();
  

  if (authLoading) {
    return <BrandedSplash />;
  }

  if (!user) {
    return <AuthPage />;
  }

  // User is logged in, check approval status
  if (approvalLoading) {
    return <BrandedSplash />;
  }

  if (isPending) {
    return <PendingApproval />;
  }

  if (isRejected) {
    return <PendingApproval isRejected />;
  }

  const isProductivity = location.pathname === '/productivity';
  const isDayDetail = location.pathname.startsWith('/productivity/day/');

  return (
    <Suspense fallback={<BrandedSplash />}>
      {isDayDetail ? <ProductivityDay /> : isProductivity ? <Dashboard /> : <HomePage />}
    </Suspense>
  );
};

export default Index;
