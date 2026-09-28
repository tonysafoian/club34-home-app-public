import { lazy, Suspense, useEffect, useState, useCallback } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Toaster } from "@/components/ui/toaster";
import { initGlobalErrorListeners, hardReload } from '@/lib/errorReporter';
// Eagerly imported so a failed chunk fetch can never lock users out of the
// post-OAuth landing — this page only runs once per sign-in and is tiny.
import AuthGoogleCallback from "./pages/AuthGoogleCallback";

import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AuthProvider } from "@/hooks/AuthProvider";
import { ThemeProvider } from "@/hooks/ThemeProvider";
import { HAEntitiesProvider } from "@/hooks/HAEntitiesProvider";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { WorkerRoute, TimeAdminRoute } from "@/components/auth/WorkerRoute";
import { Loader2 } from "lucide-react";
import { useGoogleCacheReset } from '@/hooks/useGoogleCalendar';
import { useDashboardPrefetch } from '@/hooks/useDashboardPrefetch';
import { ServiceWorkerUpdater } from '@/components/ServiceWorkerUpdater';

// Lazy-load JanusDrawer — it pulls in mammoth + xlsx (~50-80KB)
const LazyJanusDrawer = lazy(() => import('@/components/janus/JanusDrawer').then(m => ({ default: m.JanusDrawer })));

// Lazy-loaded routes for code splitting
const Index = lazy(() => import("./pages/Index"));
const Settings = lazy(() => import("./pages/Settings"));
const Activity = lazy(() => import("./pages/Activity"));
const Automations = lazy(() => import("./pages/Automations"));
const AmazonOrder = lazy(() => import("./pages/AmazonOrder"));
const GroceryOrder = lazy(() => import("./pages/GroceryOrder"));
const GroceryOrderRunDetail = lazy(() => import("./pages/GroceryOrderRunDetail"));
const FoodDeliveryOrder = lazy(() => import("./pages/FoodDeliveryOrder"));
const Admin = lazy(() => import("./pages/Admin"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Install = lazy(() => import("./pages/Install"));
// Security pages now live under HomeSystems; kept for legacy redirect
const Iaqualink = lazy(() => import("./pages/Iaqualink"));
// Teslas page removed — content now lives in HomeSystems
const TeslaCallback = lazy(() => import("./pages/TeslaCallback"));
const Family = lazy(() => import("./pages/Family"));
const HomeSystems = lazy(() => import("./pages/HomeSystems"));
const GoogleCallback = lazy(() => import("./pages/GoogleCallback"));
const Weather = lazy(() => import("./pages/Weather"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Search = lazy(() => import("./pages/Search"));
const Projects = lazy(() => import("./pages/Projects"));
const ProjectWorkspace = lazy(() => import("./pages/ProjectWorkspace"));
const Updates = lazy(() => import("./pages/Updates"));
const JanusFullscreen = lazy(() => import("./pages/JanusFullscreen"));
const SecurityCameras = lazy(() => import("./pages/SecurityCameras"));
const Ball = lazy(() => import("./pages/Ball"));
const Time = lazy(() => import("./pages/Time"));
const TimeAdmin = lazy(() => import("./pages/TimeAdmin"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: 'always',
    },
  },
});

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
    </div>
  );
}

function JanusFAB() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [janusReady, setJanusReady] = useState(false);
  useGoogleCacheReset();
  useDashboardPrefetch();

  // Routes where Janus chat must NOT appear (public-facing experiences + worker-only pages)
  const isPublicSurface =
    location.pathname.startsWith('/ball') ||
    location.pathname.startsWith('/google/callback') ||
    location.pathname.startsWith('/auth/google/callback') ||
    location.pathname.startsWith('/time');


  // Global worker fence: worker-role sessions must stay on /time*
  useEffect(() => {
    if (!user) return;
    const isWorker = Array.isArray(user.roles) && user.roles.includes('worker');
    if (isWorker && !location.pathname.startsWith('/time')) {
      navigate('/time', { replace: true });
    }
  }, [user, location.pathname, navigate]);

  // Preload JanusDrawer chunk during idle time
  useEffect(() => {
    if (!user) return;
    const ric = window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(cb, 1));
    const cic = window.cancelIdleCallback ?? window.clearTimeout;
    const id = ric(() => setJanusReady(true));
    return () => cic(id);
  }, [user]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        navigate('/search');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  if (!user) return null;
  if (isPublicSurface) return null;

  // Render lazy JanusDrawer once idle preload is ready (or on first interaction)
  return janusReady ? (
    <ErrorBoundary name="janus-drawer">
      <Suspense fallback={null}>
        <LazyJanusDrawer />
      </Suspense>
    </ErrorBoundary>
  ) : null;
}

const GlobalErrorInit = () => {
  useEffect(() => {
    initGlobalErrorListeners();
  }, []);
  return null;
};

const App = () => (
  <QueryClientProvider client={queryClient}>
    <GlobalErrorInit />
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <HAEntitiesProvider>
          <BrowserRouter>
            <ServiceWorkerUpdater />
            <ErrorBoundary name="app-root" fallback={
              <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4">
                <h1 className="text-lg font-semibold">Something went wrong</h1>
                <button onClick={() => void hardReload()} className="text-sm text-primary underline">Reload</button>
              </div>
            }>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Index />} />
                <Route path="/productivity" element={<Index />} />
                <Route path="/productivity/day/:date" element={<Index />} />
                <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
                <Route path="/activity" element={<ProtectedRoute><Activity /></ProtectedRoute>} />
                <Route path="/automations" element={<ProtectedRoute><Automations /></ProtectedRoute>} />
                <Route path="/common-tasks/amazon" element={<ProtectedRoute><AmazonOrder /></ProtectedRoute>} />
                <Route path="/common-tasks/grocery" element={<ProtectedRoute><GroceryOrder /></ProtectedRoute>} />
                <Route path="/common-tasks/grocery/runs/:id" element={<ProtectedRoute><GroceryOrderRunDetail /></ProtectedRoute>} />
                <Route path="/common-tasks/food" element={<ProtectedRoute><FoodDeliveryOrder /></ProtectedRoute>} />
                <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
                {/* Legacy admin routes redirect to unified admin */}
                <Route path="/admin/users" element={<Navigate to="/admin?section=users" replace />} />
                <Route path="/admin/email-logs" element={<Navigate to="/admin?section=email-logs" replace />} />
                <Route path="/admin/janus-access" element={<Navigate to="/admin?section=janus-access" replace />} />
                <Route path="/admin/enter-exit" element={<Navigate to="/admin?section=people-tracker" replace />} />
                <Route path="/notion" element={<Navigate to="/admin?section=notion" replace />} />
                <Route path="/reset-password" element={<ResetPassword />} />
                {/* Legacy security routes redirect to Systems → Security */}
                <Route path="/security" element={<Navigate to="/home-systems?section=security-activity" replace />} />
                <Route path="/security/cameras" element={<ProtectedRoute><SecurityCameras /></ProtectedRoute>} />
                <Route path="/teslas" element={<Navigate to="/home-systems" replace />} />
                <Route path="/tesla-callback" element={<TeslaCallback />} />
                <Route path="/family" element={<ProtectedRoute><Family /></ProtectedRoute>} />
                <Route path="/home-systems" element={<ProtectedRoute><HomeSystems /></ProtectedRoute>} />
                <Route path="/install" element={<ProtectedRoute><Install /></ProtectedRoute>} />
                <Route path="/weather" element={<ProtectedRoute><Weather /></ProtectedRoute>} />
                <Route path="/search" element={<ProtectedRoute><Search /></ProtectedRoute>} />
                <Route path="/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
                <Route path="/projects/:id" element={<ProtectedRoute><ProjectWorkspace /></ProtectedRoute>} />
                <Route path="/updates" element={<ProtectedRoute><Updates /></ProtectedRoute>} />
                <Route path="/janus" element={<ProtectedRoute><JanusFullscreen /></ProtectedRoute>} />
                <Route path="/ball" element={
                  <ErrorBoundary name="ball" fallback={
                    <div style={{ minHeight: '100svh', background: '#0a0a0a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
                      <span style={{ fontSize: 40 }}>🏀</span>
                      <p style={{ color: '#e5e0d8', fontFamily: 'Inter, sans-serif', fontWeight: 600, margin: 0 }}>We couldn't load your RSVP page</p>
                      <p style={{ color: '#9c9086', fontFamily: 'Inter, sans-serif', fontSize: 14, margin: 0 }}>Try reloading — if it keeps happening, reach out to Tony.</p>
                      <button onClick={() => void hardReload()} style={{ marginTop: 8, padding: '8px 20px', background: '#d4882a', color: '#0a0a0a', border: 'none', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Reload</button>
                    </div>
                  }>
                    <Ball />
                  </ErrorBoundary>
                } />
                <Route path="/ball/p/:token" element={
                  <ErrorBoundary name="ball-player" fallback={
                    <div style={{ minHeight: '100svh', background: '#0a0a0a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }}>
                      <span style={{ fontSize: 40 }}>🏀</span>
                      <p style={{ color: '#e5e0d8', fontFamily: 'Inter, sans-serif', fontWeight: 600, margin: 0 }}>We couldn't load your RSVP page</p>
                      <p style={{ color: '#9c9086', fontFamily: 'Inter, sans-serif', fontSize: 14, margin: 0 }}>Try reloading — if it keeps happening, reach out to Tony.</p>
                      <button onClick={() => void hardReload()} style={{ marginTop: 8, padding: '8px 20px', background: '#d4882a', color: '#0a0a0a', border: 'none', borderRadius: 8, fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Reload</button>
                    </div>
                  }>
                    <Ball />
                  </ErrorBoundary>
                } />
                {/* Club34 Time — worker + admin routes (worker-fenced, no Janus FAB) */}
                <Route path="/time" element={<WorkerRoute><Time /></WorkerRoute>} />
                <Route path="/time/admin" element={<TimeAdminRoute><TimeAdmin /></TimeAdminRoute>} />
                <Route path="/google/callback" element={<GoogleCallback />} />
                <Route path="/auth/google/callback" element={<AuthGoogleCallback />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
            <JanusFAB />
            </ErrorBoundary>
          </BrowserRouter>
          </HAEntitiesProvider>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  </QueryClientProvider>
);

export default App;
