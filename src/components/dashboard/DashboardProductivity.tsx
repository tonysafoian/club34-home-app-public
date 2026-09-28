import { NotionActivityChart } from '@/components/notion/NotionActivityChart';
import { ProductivityTodayCard } from '@/components/notion/ProductivityTodayCard';
import { useUserRole } from '@/hooks/useUserRole';
import { TrendingUp } from 'lucide-react';

export function DashboardProductivity() {
  const { isAdmin } = useUserRole();

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Productivity
          </h2>
          <p className="text-sm text-muted-foreground">
            Notion activity &amp; task tracking
          </p>
        </div>
      </div>

      <ProductivityTodayCard />

      {/* Wrap in a container that disables pointer events for non-admins on interactive controls */}
      <div className={!isAdmin ? 'pointer-events-none' : undefined}>
        <NotionActivityChart />
      </div>
    </div>
  );
}
