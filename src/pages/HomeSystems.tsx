import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useIsMobile } from '@/hooks/use-mobile';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardNav } from '@/components/dashboard/DashboardNav';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { MobileChipNav, DesktopSidebar } from '@/components/shared/SectionNav';
import type { SectionGroup } from '@/components/shared/SectionNav';
import { IaqualinkCard } from '@/components/dashboard/systems/IaqualinkCard';
import { PoolTempChart } from '@/components/dashboard/systems/PoolTempChart';
import { PrintersCard } from '@/components/dashboard/systems/PrintersCard';
import { SaunaLogicCard } from '@/components/dashboard/systems/SaunaLogicCard';
import { JanusStatusCard } from '@/components/dashboard/systems/JanusStatusCard';
import { GeneracCard } from '@/components/dashboard/systems/GeneracCard';
import { TeslaSection } from '@/components/tesla/TeslaSection';
import { CrestronThermostatsCard } from '@/components/dashboard/systems/CrestronThermostatsCard';
import { CrestronLightsCard } from '@/components/dashboard/systems/CrestronLightsCard';
import { CrestronFireplacesCard } from '@/components/dashboard/systems/CrestronFireplacesCard';
import { SystemHardwareCard } from '@/components/dashboard/systems/SystemHardwareCard';
import { HAUpdatesCard } from '@/components/dashboard/systems/HAUpdatesCard';
import { SystemsOverview } from '@/components/dashboard/systems/SystemsOverview';
import { HARainBirdCard } from '@/components/home-assistant/HARainBirdCard';
import { HAAlarmCard } from '@/components/home-assistant/HAAlarmCard';
import { HALocksCard } from '@/components/home-assistant/HALocksCard';
import { HAAlarmSensorsCard } from '@/components/home-assistant/HAAlarmSensorsCard';
import { HAGoveeLightsCard } from '@/components/home-assistant/HAGoveeLightsCard';
import { HAGoveeSensorsCard } from '@/components/home-assistant/HAGoveeSensorsCard';
import { WattsHeatersCard } from '@/components/home-assistant/WattsHeatersCard';
import { EmporiaEnergyCard } from '@/components/home-assistant/EmporiaEnergyCard';
import { ElectricityCostCard } from '@/components/home-assistant/ElectricityCostCard';
import { EnergyInsightsCard } from '@/components/home-assistant/EnergyInsightsCard';
import { WaterIntelligenceCard } from '@/components/home-assistant/WaterIntelligenceCard';
import { VerkadaCard } from '@/components/dashboard/systems/VerkadaCard';
import { VerkadaDailyTracker } from '@/components/dashboard/systems/VerkadaDailyTracker';
import { VerkadaPeopleTracker } from '@/components/dashboard/systems/VerkadaPeopleTracker';
import { VerkadaPeopleTrackerSummary } from '@/components/dashboard/systems/VerkadaPeopleTrackerSummary';
import { VerkadaVehicleTracker } from '@/components/dashboard/systems/VerkadaVehicleTracker';
import { NetworkDashboard } from '@/components/dashboard/systems/NetworkDashboard';
import { GoAccessLogCard } from '@/components/dashboard/systems/GoAccessLogCard';
import { GoAccessVisitorChart } from '@/components/dashboard/systems/GoAccessVisitorChart';
import { Waves, Flame, Car, Printer, Zap, Activity, Home, Lightbulb, Thermometer, Server, LayoutDashboard, Droplets, Shield, Users, Camera, Lock, DoorClosed, DoorOpen, Wifi, RefreshCw, DollarSign } from 'lucide-react';

const SYSTEMS_GROUPS: SectionGroup[] = [
  {
    group: 'Overview',
    items: [
      { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    ],
  },
  {
    group: 'Security',
    items: [
      { id: 'security', label: 'Security & Alarm', icon: Shield },
      { id: 'security-activity', label: 'Activity', icon: Activity },
      { id: 'security-people', label: 'People Tracker', icon: Users },
      { id: 'security-cars', label: 'Car Tracker', icon: Car },
      { id: 'security-cameras', label: 'Cameras', icon: Camera },
      { id: 'locks', label: 'Locks', icon: Lock },
      { id: 'security-sensors', label: 'Sensors', icon: DoorClosed },
      { id: 'goaccess', label: 'GoAccess', icon: DoorOpen },
    ],
  },
  {
    group: 'Lights',
    items: [
      { id: 'lights', label: 'House Lights', icon: Lightbulb },
      { id: 'govee', label: 'Govee', icon: Lightbulb },
    ],
  },
  {
    group: 'Fireplaces',
    items: [
      { id: 'fireplaces', label: 'Fireplaces & Switches', icon: Flame },
    ],
  },
  {
    group: 'Thermostats',
    items: [
      { id: 'thermostats', label: 'Climate & Thermostats', icon: Thermometer },
      { id: 'bath-heaters', label: 'Primary Bath Floors/Benches', icon: Thermometer },
    ],
  },
  {
    group: 'Outdoor',
    items: [
      { id: 'pool-spa', label: 'Pool & Spa', icon: Waves },
      { id: 'irrigation', label: 'Irrigation', icon: Droplets },
      { id: 'sauna', label: 'Sauna', icon: Flame },
    ],
  },
  {
    group: 'Vehicles',
    items: [
      { id: 'vehicles', label: 'Teslas', icon: Car },
    ],
  },
  {
    group: 'Water & Power',
    items: [
      { id: 'electricity-cost', label: 'Electricity Costs', icon: DollarSign },
      { id: 'water-cost', label: 'Water Costs', icon: Droplets },
      { id: 'energy', label: 'Circuit Monitor', icon: Zap },
      { id: 'energy-insights', label: 'Power Insights', icon: Lightbulb },
    ],
  },
  {
    group: 'Office & Utilities',
    items: [
      { id: 'printers', label: 'Printers', icon: Printer },
      { id: 'generator', label: 'Generator', icon: Zap },
    ],
  },
  {
    group: 'Software',
    items: [
      { id: 'app-health', label: 'App Health', icon: Activity },
    ],
  },
  {
    group: 'Network',
    items: [
      { id: 'network', label: 'Network', icon: Wifi },
    ],
  },
  {
    group: 'Monitoring',
    items: [
      { id: 'system-hardware', label: 'System Hardware', icon: Server },
      { id: 'software-updates', label: 'Software Updates', icon: RefreshCw },
    ],
  },
];

const LEGACY_ALIASES: Record<string, string> = {
  teslas: 'vehicles',
  spectrum: 'network',
  lan: 'network',
  starlink: 'network',
};

export default function HomeSystems() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const rawSection = searchParams.get('section') || 'overview';
  const resolved = LEGACY_ALIASES[rawSection] ?? rawSection;
  const activeSection = resolved;

  useEffect(() => {
    if (LEGACY_ALIASES[rawSection]) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('section', LEGACY_ALIASES[rawSection]);
        return next;
      }, { replace: true });
    }
  }, [rawSection, setSearchParams]);

  const allItems = SYSTEMS_GROUPS.flatMap(g => g.items);
  const activeLabel = allItems.find(i => i.id === activeSection)?.label ?? 'Systems';

  function setSection(id: string) {
    setSearchParams({ section: id });
  }

  const SECTION_CONTENT: Record<string, React.ReactNode> = {
    'overview': <SystemsOverview onNavigate={setSection} />,
    'security-activity': <VerkadaDailyTracker />,
    'security-people': <VerkadaPeopleTracker />,
    'security-cars': <VerkadaVehicleTracker />,
    'security-cameras': (
      <div className="space-y-4">
        <VerkadaPeopleTrackerSummary onViewAll={() => setSection('security-people')} />
        <VerkadaCard />
      </div>
    ),
    'security': (
      <div className="space-y-4">
        <ErrorBoundary name="ha-alarm"><HAAlarmCard /></ErrorBoundary>
        <ErrorBoundary name="ha-locks"><HALocksCard /></ErrorBoundary>
        <ErrorBoundary name="ha-sensors"><HAAlarmSensorsCard /></ErrorBoundary>
      </div>
    ),
    'locks': <HALocksCard />,
    'security-sensors': <HAAlarmSensorsCard />,
    'goaccess': (
      <div className="space-y-4">
        <GoAccessVisitorChart />
        <GoAccessLogCard />
      </div>
    ),
    'lights': <CrestronLightsCard />,
    'govee': (
      <div className="space-y-4">
        <HAGoveeSensorsCard />
        <HAGoveeLightsCard />
      </div>
    ),
    'fireplaces': <CrestronFireplacesCard />,
    'thermostats': <CrestronThermostatsCard />,
    'bath-heaters': <WattsHeatersCard />,
    'pool-spa': <><IaqualinkCard /><div className="mt-4"><PoolTempChart /></div></>,
    'irrigation': <HARainBirdCard />,
    'sauna': <SaunaLogicCard />,
    'vehicles': <TeslaSection />,
    'electricity-cost': (
      <div className="space-y-4">
        <ErrorBoundary name="electricity-cost"><ElectricityCostCard /></ErrorBoundary>
      </div>
    ),
    'water-cost': <ErrorBoundary name="water-cost"><WaterIntelligenceCard /></ErrorBoundary>,
    'energy': <EmporiaEnergyCard />,
    'energy-insights': <EnergyInsightsCard />,
    'printers': <PrintersCard />,
    'generator': <GeneracCard />,
    'app-health': <JanusStatusCard />,
    'network': <NetworkDashboard />,
    'system-hardware': <SystemHardwareCard />,
    'software-updates': <HAUpdatesCard />,
  };

  return (
    <div className="min-h-screen bg-background pb-16 md:pb-0">
      <DashboardHeader />
      <DashboardNav />

      {/* Mobile chip nav */}
      {isMobile && (
        <MobileChipNav
          groups={SYSTEMS_GROUPS}
          activeSection={activeSection}
          onSectionChange={setSection}
        />
      )}

      <div className="flex">
        {/* Desktop sidebar */}
        {!isMobile && (
          <DesktopSidebar
            groups={SYSTEMS_GROUPS}
            activeSection={activeSection}
            onSectionChange={setSection}
          />
        )}

        {/* Content */}
        <main className="flex-1 min-w-0 container py-6 px-3 md:px-4">
          <div className="flex items-center gap-3 mb-6">
            <Home className="h-6 w-6 text-primary" />
            <div>
              <h1 className="text-2xl font-bold">Systems</h1>
              {!isMobile && <p className="text-sm text-muted-foreground">{activeLabel}</p>}
            </div>
          </div>
          <div className="max-w-3xl">
            <ErrorBoundary name={`system-${activeSection}`}>
              {SECTION_CONTENT[activeSection] ?? <p className="text-muted-foreground">Select a system.</p>}
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <MobileBottomNav />
    </div>
  );
}
