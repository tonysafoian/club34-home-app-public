import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardNav } from '@/components/dashboard/DashboardNav';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { IaqualinkCard } from '@/components/dashboard/systems/IaqualinkCard';
import { PoolTempChart } from '@/components/dashboard/systems/PoolTempChart';

export default function Iaqualink() {
  return (
    <div className="min-h-screen bg-background pb-16 md:pb-0">
      <DashboardHeader />
      <DashboardNav />
      <main className="container py-4 md:py-6 space-y-4 md:space-y-6 px-3 md:px-4">
        <div className="grid gap-4 md:grid-cols-2">
          <IaqualinkCard />
        </div>
        <PoolTempChart />
      </main>
      <MobileBottomNav />
    </div>
  );
}
