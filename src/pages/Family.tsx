import { useState } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardNav } from '@/components/dashboard/DashboardNav';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { FamilyCalendarView } from '@/components/family/FamilyCalendarView';
import { TravelSection } from '@/components/family/TravelSection';
import { EntertainmentSection } from '@/components/family/EntertainmentSection';
import { MoviesSection } from '@/components/family/MoviesSection';
import { CalendarDays, Plane, Ticket, Clapperboard } from 'lucide-react';
import { cn } from '@/lib/utils';

type FamilyTab = 'today' | 'travel' | 'entertainment' | 'movies';

const TABS: { id: FamilyTab; label: string; icon: React.ElementType }[] = [
  { id: 'today', label: 'Today', icon: CalendarDays },
  { id: 'travel', label: 'Travel', icon: Plane },
  { id: 'entertainment', label: 'Live Entertainment', icon: Ticket },
  { id: 'movies', label: 'Movies & TV', icon: Clapperboard },
];

export default function Family() {
  const [activeTab, setActiveTab] = useState<FamilyTab>('today');

  return (
    <div className="min-h-screen bg-background pb-16 md:pb-0">
      <DashboardHeader />
      <DashboardNav />

      {/* Family Sub-Nav */}
      <div className="sticky top-[calc(var(--dashboard-nav-height,56px)+48px)] z-20 bg-background/80 backdrop-blur-sm border-b border-border/40">
        <div className="container px-3 md:px-4">
          <div className="flex gap-1 overflow-x-auto py-2 scrollbar-none">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all shrink-0',
                  activeTab === id
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ErrorBoundary name="family">
      <main className="container py-4 md:py-6 space-y-6 md:space-y-8 px-3 md:px-4">
        {activeTab === 'today' && (
          <FamilyCalendarView />
        )}

        {activeTab === 'travel' && (
          <ErrorBoundary name="travel-section">
            <TravelSection />
          </ErrorBoundary>
        )}

        {activeTab === 'entertainment' && (
          <ErrorBoundary name="entertainment-section">
            <EntertainmentSection />
          </ErrorBoundary>
        )}

        {activeTab === 'movies' && (
          <ErrorBoundary name="movies-section">
            <MoviesSection />
          </ErrorBoundary>
        )}
      </main>
      </ErrorBoundary>

      <MobileBottomNav />
    </div>
  );
}
