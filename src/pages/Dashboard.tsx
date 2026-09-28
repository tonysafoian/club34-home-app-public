import { useRef, useState, useCallback, useEffect, lazy, Suspense, memo } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useQueryClient } from '@tanstack/react-query';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardNav } from '@/components/dashboard/DashboardNav';
import { DashboardGreeting } from '@/components/dashboard/DashboardGreeting';
import { DashboardToday } from '@/components/dashboard/DashboardToday';
import { DashboardLookingAhead } from '@/components/dashboard/DashboardLookingAhead';
import { LazySection } from '@/components/dashboard/LazySection';
import { GoogleCalendarCard } from '@/components/dashboard/GoogleCalendarCard';
import { PWAInstallBanner } from '@/components/dashboard/PWAInstallBanner';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { RefreshCw, Loader2 } from 'lucide-react';

const DashboardProductivity = lazy(() => import('@/components/dashboard/DashboardProductivity').then(m => ({ default: m.DashboardProductivity })));

const PULL_THRESHOLD = 72; // px to pull before triggering refresh

// Memoize data-driven cards to avoid re-renders during pull-to-refresh gesture
const MemoGreeting = memo(DashboardGreeting);
const MemoToday = memo(DashboardToday);
const MemoCalendar = memo(GoogleCalendarCard);
const MemoLookingAhead = memo(DashboardLookingAhead);

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartY = useRef<number | null>(null);
  const mainRef = useRef<HTMLElement>(null);

  // Preload DashboardProductivity chunk during idle time
  useEffect(() => {
    const ric = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(cb, 1));
    const cic = window.cancelIdleCallback ?? window.clearTimeout;
    const id = ric(() => {
      import('@/components/dashboard/DashboardProductivity');
    });
    return () => cic(id);
  }, []);

  const triggerRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['google-calendar-events'] }),
      queryClient.invalidateQueries({ queryKey: ['family-calendar-events'] }),
      queryClient.invalidateQueries({ queryKey: ['google-connection-status'] }),
      queryClient.invalidateQueries({ queryKey: ['notion-recurring-tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['notion-activity-stats'] }),
      queryClient.invalidateQueries({ queryKey: ['notion-day-events'] }),
      queryClient.invalidateQueries({ queryKey: ['user-profile'] }),
    ]);
    setTimeout(() => setRefreshing(false), 800);
  }, [refreshing, queryClient]);

  const onTouchStart = (e: React.TouchEvent) => {
    // Only activate when scrolled to top
    if (window.scrollY === 0) {
      touchStartY.current = e.touches[0].clientY;
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (touchStartY.current === null || refreshing) return;
    const delta = e.touches[0].clientY - touchStartY.current;
    if (delta > 0 && window.scrollY === 0) {
      setPullDistance(Math.min(delta * 0.4, PULL_THRESHOLD + 16));
    }
  };

  const onTouchEnd = () => {
    if (pullDistance >= PULL_THRESHOLD) triggerRefresh();
    setPullDistance(0);
    touchStartY.current = null;
  };

  return (
    <div className="min-h-screen bg-background pb-16 md:pb-0">
      <DashboardHeader />
      <DashboardNav />
      <main
        ref={mainRef}
        className="container py-4 md:py-6 space-y-4 md:space-y-6 px-3 md:px-4 relative"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Pull-to-refresh indicator */}
        {(pullDistance > 0 || refreshing) && (
          <div
            className="md:hidden absolute left-1/2 -translate-x-1/2 flex items-center justify-center transition-all duration-200"
            style={{ top: refreshing ? 8 : Math.max(pullDistance - 40, -32), opacity: refreshing ? 1 : pullDistance / PULL_THRESHOLD }}
          >
            <div className="bg-card border border-border rounded-full p-2 shadow-md">
              <RefreshCw className={`h-4 w-4 text-primary ${refreshing ? 'animate-spin' : ''}`} style={{ transform: !refreshing ? `rotate(${(pullDistance / PULL_THRESHOLD) * 360}deg)` : undefined }} />
            </div>
          </div>
        )}
        <PWAInstallBanner />
        <ErrorBoundary name="greeting"><MemoGreeting /></ErrorBoundary>
        <ErrorBoundary name="today"><MemoToday /></ErrorBoundary>
        <ErrorBoundary name="calendar"><MemoCalendar /></ErrorBoundary>
        <LazySection height="300px">
          <ErrorBoundary name="looking-ahead"><MemoLookingAhead /></ErrorBoundary>
        </LazySection>
        <LazySection height="250px">
          <ErrorBoundary name="productivity">
            <Suspense fallback={<div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
              <DashboardProductivity />
            </Suspense>
          </ErrorBoundary>
        </LazySection>
      </main>
      <MobileBottomNav />
    </div>
  );
}

