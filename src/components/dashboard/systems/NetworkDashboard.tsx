import { Wifi, Network, Satellite, Shield } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SpectrumCard } from './SpectrumCard';
import { LanSpeedCard } from './LanSpeedCard';
import { StarlinkCard } from './StarlinkCard';
import { FortiGateCard } from './FortiGateCard';

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      {icon}
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground" data-testid={`text-network-section-${title.toLowerCase().replace(/\s+/g, '-')}`}>
        {title}
      </h2>
    </div>
  );
}

export function NetworkDashboard() {
  return (
    <div className="space-y-8" data-testid="network-dashboard">
      <section>
        <SectionHeader
          icon={<Wifi className="h-4 w-4 text-blue-400" />}
          title="Spectrum Internet"
        />
        <ErrorBoundary name="spectrum">
          <SpectrumCard />
        </ErrorBoundary>
      </section>

      <section>
        <SectionHeader
          icon={<Network className="h-4 w-4 text-teal-400" />}
          title="LAN & Network"
        />
        <ErrorBoundary name="lan">
          <LanSpeedCard />
        </ErrorBoundary>
      </section>

      <section>
        <SectionHeader
          icon={<Satellite className="h-4 w-4 text-sky-400" />}
          title="Starlink"
        />
        <ErrorBoundary name="starlink">
          <StarlinkCard />
        </ErrorBoundary>
      </section>

      <section>
        <SectionHeader
          icon={<Shield className="h-4 w-4 text-orange-400" />}
          title="FortiGate Firewall"
        />
        <ErrorBoundary name="fortigate">
          <FortiGateCard />
        </ErrorBoundary>
      </section>
    </div>
  );
}
