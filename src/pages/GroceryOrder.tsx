import { useState, lazy, Suspense } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, History, Settings, ChevronDown } from 'lucide-react';
import ThisWeekOrder from '@/components/grocery/ThisWeekOrder';

const RunHistory = lazy(() => import('@/components/grocery/RunHistory'));
const CatalogManager = lazy(() => import('@/components/grocery/CatalogManager'));

function SectionSkeleton() {
  return (
    <div className="space-y-2 p-4">
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
      <Skeleton className="h-12 w-full rounded-lg" />
    </div>
  );
}

export default function GroceryOrder() {
  const navigate = useNavigate();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 w-full border-b border-border/50 bg-background/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="container flex h-12 md:h-14 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/automations')}
            data-testid="button-grocery-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold font-display">Grocery Helper</h1>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { setHistoryOpen(v => !v); setCatalogOpen(false); }}
            aria-label="Order history"
            data-testid="button-grocery-history"
          >
            <History className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => { setCatalogOpen(v => !v); setHistoryOpen(false); }}
            aria-label="Manage catalog"
            data-testid="button-grocery-settings"
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </header>

      <main className="container py-4 space-y-6 max-w-3xl">
        <ThisWeekOrder />

        <div id="past-orders" className="space-y-3">
          <button
            className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-border/60 bg-card hover:bg-muted/40 transition-colors"
            onClick={() => setHistoryOpen(v => !v)}
            aria-expanded={historyOpen}
            data-testid="button-history-collapsible"
          >
            <span className="text-sm font-semibold font-display flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              Past Orders
            </span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${historyOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {historyOpen && (
            <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
              <div className="p-3">
                <Suspense fallback={<SectionSkeleton />}>
                  <RunHistory />
                </Suspense>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <button
            className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-border/60 bg-card hover:bg-muted/40 transition-colors"
            onClick={() => setCatalogOpen(v => !v)}
            aria-expanded={catalogOpen}
            data-testid="button-catalog-collapsible"
          >
            <span className="text-sm font-semibold font-display flex items-center gap-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              Manage Staples Catalog
            </span>
            <ChevronDown
              className={`h-4 w-4 text-muted-foreground transition-transform ${catalogOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {catalogOpen && (
            <Suspense fallback={<SectionSkeleton />}>
              <CatalogManager />
            </Suspense>
          )}
        </div>
      </main>
    </div>
  );
}
