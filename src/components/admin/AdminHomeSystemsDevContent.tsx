import { GeneracCard } from '@/components/dashboard/systems/GeneracCard';
import { MyQCard } from '@/components/dashboard/systems/MyQCard';
import { SaunaLogicCard } from '@/components/dashboard/systems/SaunaLogicCard';
import { Wrench } from 'lucide-react';

export function AdminHomeSystemsDevContent() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-warning/10 flex items-center justify-center shrink-0 mt-0.5">
          <Wrench className="w-5 h-5 text-warning" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Home Systems Dev</h2>
          <p className="text-sm text-muted-foreground">
            Placeholder integrations under active development — mock data only, no real connections yet.
            Once real APIs are wired up these will move to the main Home Systems page.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <GeneracCard />
        <MyQCard />
        <SaunaLogicCard />
      </div>
    </div>
  );
}
