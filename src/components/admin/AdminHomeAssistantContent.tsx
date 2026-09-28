import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';
import { HALightsCard } from '@/components/home-assistant/HALightsCard';
import { HAClimateCard } from '@/components/home-assistant/HAClimateCard';
import { HACoversCard } from '@/components/home-assistant/HACoversCard';
import { HAScenesCard } from '@/components/home-assistant/HAScenesCard';
import { HASwitchesCard } from '@/components/home-assistant/HASwitchesCard';
import { HASensorsCard } from '@/components/home-assistant/HASensorsCard';
import { HAGoveeSensorsCard } from '@/components/home-assistant/HAGoveeSensorsCard';
import { HALogbookCard } from '@/components/home-assistant/HALogbookCard';
import { HARainBirdCard } from '@/components/home-assistant/HARainBirdCard';
import { HAConnectionBadge } from '@/components/home-assistant/HAConnectionBadge';

export function AdminHomeAssistantContent() {
  const { refetch } = useSharedHAAllEntities();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Home Assistant</h2>
          <p className="text-sm text-muted-foreground">Live device controls — admin-only while configuring</p>
        </div>
        <HAConnectionBadge onRefresh={() => refetch(false)} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <HALightsCard />
        <HAClimateCard />
        <HACoversCard />
        <HASwitchesCard />
        <HAScenesCard />
        <HASensorsCard />
        <HAGoveeSensorsCard />
        <HARainBirdCard />
        <HALogbookCard />
      </div>
    </div>
  );
}
