import { useState, useEffect } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Activity, Users, Wifi, Network, TrendingUp, Globe, Shield, Database,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NetworkTab } from './network/types';
import { NetworkHealthStrip } from './network/shared';
import { OverviewTab } from './network/OverviewTab';
import { DevicesTab } from './network/DevicesTab';
import { TrafficTab } from './network/TrafficTab';
import { TopSitesTab } from './network/TopSitesTab';
import { SecurityTab } from './network/SecurityTab';
import { InterfacesTab } from './network/InterfacesTab';
import { WiFiNetworksTab } from './network/WiFiNetworksTab';
import { DnsDhcpTab } from './network/DnsDhcpTab';

export function AdminNetworkContent({ initialTab = 'overview' }: { initialTab?: NetworkTab }) {
  const [activeTab, setActiveTab] = useState<NetworkTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const tabs: { key: NetworkTab; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <Activity className="h-4 w-4" /> },
    { key: 'devices', label: 'Devices', icon: <Users className="h-4 w-4" /> },
    { key: 'wifi-networks', label: 'WiFi Networks', icon: <Wifi className="h-4 w-4" /> },
    { key: 'interfaces', label: 'Interfaces', icon: <Network className="h-4 w-4" /> },
    { key: 'traffic', label: 'Traffic', icon: <TrendingUp className="h-4 w-4" /> },
    { key: 'top-sites', label: 'Top Sites', icon: <Globe className="h-4 w-4" /> },
    { key: 'security', label: 'Security', icon: <Shield className="h-4 w-4" /> },
    { key: 'dns-dhcp', label: 'DNS & DHCP', icon: <Database className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-4">
      {/* Tab navigation */}
      <div className="flex flex-wrap gap-1 border-b border-border/50 pb-0">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
              activeTab === tab.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            )}
            data-testid={`tab-${tab.key}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Persistent network health strip — isolated so a crash here doesn't kill the tabs */}
      <ErrorBoundary name="network-health-strip">
        <NetworkHealthStrip />
      </ErrorBoundary>

      {/* Tab content — each tab is isolated so one crash doesn't kill the whole section */}
      <div className="min-h-[400px]">
        {activeTab === 'overview' && (
          <ErrorBoundary name="fw-overview-tab" showDetails>
            <OverviewTab onNavigate={setActiveTab} />
          </ErrorBoundary>
        )}
        {activeTab === 'devices' && (
          <ErrorBoundary name="fw-devices-tab">
            <DevicesTab />
          </ErrorBoundary>
        )}
        {activeTab === 'wifi-networks' && (
          <ErrorBoundary name="fw-wifi-tab">
            <WiFiNetworksTab />
          </ErrorBoundary>
        )}
        {activeTab === 'interfaces' && (
          <ErrorBoundary name="fw-interfaces-tab">
            <InterfacesTab />
          </ErrorBoundary>
        )}
        {activeTab === 'traffic' && (
          <ErrorBoundary name="fw-traffic-tab">
            <TrafficTab onNavigate={setActiveTab} />
          </ErrorBoundary>
        )}
        {activeTab === 'top-sites' && (
          <ErrorBoundary name="fw-topsites-tab">
            <TopSitesTab />
          </ErrorBoundary>
        )}
        {activeTab === 'security' && (
          <ErrorBoundary name="fw-security-tab">
            <SecurityTab />
          </ErrorBoundary>
        )}
        {activeTab === 'dns-dhcp' && (
          <ErrorBoundary name="fw-dnsDhcp-tab">
            <DnsDhcpTab />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
