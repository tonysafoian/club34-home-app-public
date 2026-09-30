import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RecentRequestsFeed } from './RecentRequests';
import { RecentUserActionsFeed } from './RecentUserActions';
import { useHAEntities } from '@/hooks/useHAEntities';
import { useIaqualinkHA } from '@/hooks/useIaqualinkHA';
import { useTesla } from '@/hooks/useTesla';
import {
  Lightbulb, Flame, Waves, Car, Printer, Server, Activity,
  Clock, ChevronRight, Droplets, Shield, Lock, ShieldAlert, ListChecks, Thermometer,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  AV_CLOSET_WARN_TEMP,
  AV_CLOSET_CRITICAL_TEMP,
} from '@shared/avCloset';
import { useAvClosetReading } from '@/hooks/useAvClosetReading';

interface GlanceTileProps {
  icon: React.ElementType;
  title: string;
  value: string;
  subtitle?: string;
  status?: 'ok' | 'warning' | 'error' | 'idle';
  onClick: () => void;
  children?: React.ReactNode;
}

function GlanceTile({ icon: Icon, title, value, subtitle, status = 'idle', onClick, children }: GlanceTileProps) {
  const statusColor = status === 'ok' ? 'text-green-500' : status === 'warning' ? 'text-yellow-500' : status === 'error' ? 'text-destructive' : 'text-muted-foreground';

  return (
    <Card
      className="cursor-pointer hover:bg-muted/40 transition-colors group focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      tabIndex={0}
      role="button"
      aria-label={`${title}: ${value}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10">
            <Icon className="h-4.5 w-4.5 text-primary" />
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <p className="text-xs font-medium text-muted-foreground mb-0.5">{title}</p>
        <p className={cn('text-sm font-semibold', statusColor)}>{value}</p>
        {subtitle && <p className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</p>}
        {children}
      </CardContent>
    </Card>
  );
}


export function SystemsOverview({ onNavigate }: { onNavigate: (section: string) => void }) {
  // ── HA entities for lights, climate, switches ──
  const { entities: allEntities, loading: haLoading, unavailable: haUnavailable } = useHAEntities(undefined, 30000);

  const lightsOn = allEntities.filter(e => e.entity_id.startsWith('light.') && e.state === 'on').length;
  const totalLights = allEntities.filter(e => e.entity_id.startsWith('light.')).length;

  // Climate — HVAC thermostats
  const climateEntities = allEntities.filter(e => e.entity_id.startsWith('climate.') && !/pool|spa/i.test(e.entity_id));
  const activeClimate = climateEntities.filter(e => e.state !== 'off' && e.state !== 'unavailable').length;

  // Security – alarm control panel entities
  const alarmPanels = allEntities.filter(e => e.entity_id.startsWith('alarm_control_panel.'));
  const alarmArmed = alarmPanels.filter(e => e.state.startsWith('armed')).length;
  const alarmTriggered = alarmPanels.filter(e => e.state === 'triggered').length;
  const alarmState = alarmTriggered > 0 ? 'TRIGGERED' :
    alarmArmed > 0 ? (alarmPanels.find(e => e.state.startsWith('armed'))?.state.replace('armed_', 'Armed ').replace(/\b\w/g, c => c.toUpperCase()) || 'Armed') :
    alarmPanels.length > 0 ? 'Disarmed' : 'N/A';

  // Locks
  const locks = allEntities.filter(e => e.entity_id.startsWith('lock.'));
  const lockedCount = locks.filter(e => e.state === 'locked').length;

  // Irrigation – Rain Bird sprinkler zone switches
  const irrigationZones = allEntities.filter(e =>
    (e.entity_id.startsWith('switch.rain_bird') || e.entity_id.startsWith('switch.rainbird'))
  );
  const irrigationActive = irrigationZones.filter(e => e.state === 'on').length;

  // Fireplaces – switches containing 'fireplace'
  const fireplaces = allEntities.filter(e => e.entity_id.startsWith('switch.') && e.entity_id.includes('fireplace'));
  const fireplacesOn = fireplaces.filter(e => e.state === 'on').length;

  // Printers — HP
  const hpPrinterEntities = allEntities.filter(e =>
    e.entity_id.startsWith('sensor.hp_color_laserjet') && !e.entity_id.includes('cartridge')
  );
  const hpStatuses = hpPrinterEntities.map(e => e.state?.toLowerCase() ?? 'unknown');
  const hpHasError = hpStatuses.some(s => s !== 'idle' && s !== 'printing');

  const bambuSignatureSuffixes = ['print_status', 'current_stage', 'print_progress', 'nozzle_temperature', 'nozzle_temp', 'bed_temperature', 'bed_temp'];
  const bambuPrefixes = new Set<string>();
  for (const e of allEntities) {
    for (const suffix of bambuSignatureSuffixes) {
      const match = e.entity_id.match(new RegExp(`^sensor\\.(.+?)_${suffix}$`));
      if (match && !match[1].startsWith('hp_color_laserjet')) {
        bambuPrefixes.add(match[1]);
        break;
      }
    }
  }
  const bambuStatusEntities = allEntities.filter(e => {
    for (const prefix of bambuPrefixes) {
      if (e.entity_id === `sensor.${prefix}_print_status` || e.entity_id === `sensor.${prefix}_current_stage` || e.entity_id === `sensor.${prefix}_status`) return true;
    }
    return false;
  });
  const bambuStatuses = bambuStatusEntities.map(e => e.state?.toLowerCase() ?? 'unknown');
  const bambuPrinting = bambuStatuses.some(s => s === 'printing' || s === 'running');
  const bambuError = bambuStatuses.some(s => s === 'error' || s === 'failed' || s === 'fault');

  const allStatuses = [...hpStatuses, ...bambuStatuses];
  const printerSummary = allStatuses.length === 0 ? 'N/A' :
    bambuError || hpHasError ? 'Error' :
    bambuPrinting || hpStatuses.some(s => s === 'printing') ? 'Printing' :
    allStatuses.every(s => s === 'idle' || s === 'standby') ? 'All Idle' : 'Mixed';
  const printerStatus: 'ok' | 'warning' | 'error' = allStatuses.length === 0 ? 'warning' as const :
    bambuError || hpHasError ? 'error' :
    printerSummary === 'All Idle' ? 'ok' : 'warning';

  // AV Closet temperature — read straight from Govee (HA's Govee integration
  // double-converts and reports a bogus ~155°F). Tile shows only when Govee
  // returns a real reading.
  const { data: avReading } = useAvClosetReading();
  const avClosetTempValue = avReading?.tempF != null && Number.isFinite(avReading.tempF) ? avReading.tempF : NaN;
  const avClosetHumidity = avReading?.humidity != null && Number.isFinite(avReading.humidity) ? avReading.humidity : NaN;
  const avClosetUnit = '°F';
  // Govee-reported offline (dead battery / lost link) — surface as an error tile.
  const avClosetOffline = avReading?.online === false;
  const hasReadingTemp = Number.isFinite(avClosetTempValue) && !avClosetOffline;
  const hasAvCloset = hasReadingTemp || avClosetOffline;
  const avClosetSubtitle = avClosetOffline
    ? 'Sensor offline'
    : Number.isFinite(avClosetHumidity)
    ? `${Math.round(avClosetHumidity)}% humidity`
    : 'Temperature';
  const avClosetStatus: 'ok' | 'warning' | 'error' =
    avClosetOffline ? 'error' :
    !hasReadingTemp ? 'ok' :
    avClosetTempValue >= AV_CLOSET_CRITICAL_TEMP ? 'error' :
    avClosetTempValue >= AV_CLOSET_WARN_TEMP ? 'warning' : 'ok';

  // System hardware
  const cpuEntity = allEntities.find(e => e.entity_id === 'sensor.system_monitor_processor_use');
  const memEntity = allEntities.find(e => e.entity_id === 'sensor.system_monitor_memory_usage');
  const cpuPct = cpuEntity ? parseFloat(cpuEntity.state) || 0 : 0;
  const memPct = memEntity ? parseFloat(memEntity.state) || 0 : 0;

  // ── Pool & Spa ──
  const iaqualink = useIaqualinkHA(60000);
  const poolTemp = iaqualink.temperatures.pool;

  // ── Vehicles ──
  const tesla = useTesla();

  // Fetch vehicles on mount so the tile shows the correct count
  useEffect(() => {
    (async () => {
      const s = await tesla.fetchStatus();
      if (s?.user_authenticated) {
        tesla.fetchVehicles();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── App Health ──
  const { data: healthLatest } = useQuery({
    queryKey: ['janus-health-latest'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<{ overall_status: string; created_at: string }>({
        table: 'janus_health_logs',
        select: 'overall_status,created_at',
        order: { column: 'created_at', ascending: false },
        limit: 1,
      });
      return data;
    },
    refetchInterval: 5 * 60 * 1000,
  });

  const appStatus = healthLatest?.overall_status ?? 'unknown';

  return (
    <div className="space-y-6">
      {/* System Glance Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <GlanceTile
          icon={Shield}
          title="Security"
          value="Verkada"
          subtitle="Cameras & People"
          status="ok"
          onClick={() => onNavigate('security-activity')}
        />

        <GlanceTile
          icon={alarmTriggered > 0 ? ShieldAlert : Shield}
          title="Alarm"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : alarmState}
          subtitle={haLoading ? undefined : haUnavailable ? 'Not connected' : alarmPanels.length > 0 ? 'Home Assistant' : 'Not connected'}
          status={haUnavailable ? 'idle' : alarmTriggered > 0 ? 'error' : alarmArmed > 0 ? 'ok' : alarmPanels.length > 0 ? 'warning' : 'idle'}
          onClick={() => onNavigate('security')}
        />

        <GlanceTile
          icon={Lock}
          title="Locks"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : locks.length > 0 ? `${lockedCount}/${locks.length} Locked` : 'N/A'}
          subtitle={haLoading ? undefined : haUnavailable ? 'Not connected' : lockedCount === locks.length && locks.length > 0 ? 'All secure' : locks.length > 0 ? 'Some unlocked' : undefined}
          status={haUnavailable ? 'idle' : locks.length === 0 ? 'idle' : lockedCount === locks.length ? 'ok' : 'warning'}
          onClick={() => onNavigate('locks')}
        />

        <GlanceTile
          icon={Lightbulb}
          title="House Lights"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : `${lightsOn} On`}
          subtitle={haLoading ? undefined : haUnavailable ? 'Not connected' : `of ${totalLights}`}
          status={haUnavailable ? 'idle' : lightsOn > 0 ? 'warning' : 'ok'}
          onClick={() => onNavigate('lights')}
        />

        <GlanceTile
          icon={Thermometer}
          title="Climate"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : climateEntities.length > 0 ? `${activeClimate} Active` : 'None'}
          subtitle={haLoading ? undefined : haUnavailable ? 'Not connected' : `${climateEntities.length} zones`}
          status={haUnavailable ? 'idle' : activeClimate > 0 ? 'ok' : 'idle'}
          onClick={() => onNavigate('thermostats')}
        />

        <GlanceTile
          icon={Flame}
          title="Fireplaces"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : fireplacesOn > 0 ? `${fireplacesOn} On` : 'All Off'}
          status={haUnavailable ? 'idle' : fireplacesOn > 0 ? 'warning' : 'ok'}
          onClick={() => onNavigate('fireplaces')}
        />

        <GlanceTile
          icon={Waves}
          title="Pool & Spa"
          value={iaqualink.loading ? '…' : poolTemp ? `${poolTemp}°F` : iaqualink.connected ? 'Standby' : 'None'}
          subtitle={iaqualink.connected ? 'Equipment online' : 'Not configured'}
          status={iaqualink.connected ? 'ok' : 'idle'}
          onClick={() => onNavigate('pool-spa')}
        />

        {hasAvCloset && (
          <GlanceTile
            icon={Thermometer}
            title="AV Closet"
            value={avClosetOffline ? 'Offline' : `${avClosetTempValue.toFixed(0)}${avClosetUnit}`}
            subtitle={avClosetSubtitle}
            status={avClosetStatus}
            onClick={() => onNavigate('govee')}
          />
        )}

        <GlanceTile
          icon={Droplets}
          title="Irrigation"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : irrigationActive > 0 ? `${irrigationActive} Running` : 'All Off'}
          subtitle={haLoading ? undefined : haUnavailable ? 'Not connected' : `${irrigationZones.length} zones`}
          status={haUnavailable ? 'idle' : irrigationActive > 0 ? 'ok' : 'idle'}
          onClick={() => onNavigate('irrigation')}
        />

        <GlanceTile
          icon={Flame}
          title="Sauna"
          value="Standby"
          status="idle"
          onClick={() => onNavigate('sauna')}
        />

        <GlanceTile
          icon={Car}
          title="Vehicles"
          value={tesla.loading ? '…' : `${tesla.vehicles.length} Vehicle${tesla.vehicles.length !== 1 ? 's' : ''}`}
          subtitle={tesla.pairingRequired ? 'Pairing needed' : undefined}
          status={tesla.pairingRequired ? 'warning' : tesla.vehicles.length > 0 ? 'ok' : 'idle'}
          onClick={() => onNavigate('vehicles')}
        />

        <GlanceTile
          icon={Printer}
          title="Printers"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : printerSummary}
          subtitle={haLoading ? undefined : haUnavailable ? 'Not connected' : bambuStatusEntities.length > 0 ? `HP + Bambu Lab` : 'HP LaserJet'}
          status={haLoading ? 'idle' : haUnavailable ? 'idle' : printerStatus}
          onClick={() => onNavigate('printers')}
        />

        <GlanceTile
          icon={Server}
          title="Server"
          value={haLoading ? '…' : haUnavailable ? 'N/A' : `CPU ${cpuPct.toFixed(0)}%`}
          subtitle={haLoading ? undefined : haUnavailable ? 'Not connected' : `RAM ${memPct.toFixed(0)}%`}
          status={haUnavailable ? 'idle' : cpuPct > 80 || memPct > 80 ? 'warning' : 'ok'}
          onClick={() => onNavigate('system-hardware')}
        >
          {!haLoading && !haUnavailable && (
            <div className="space-y-1 mt-2">
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-muted-foreground w-6">CPU</span>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full', cpuPct >= 80 ? 'bg-red-500' : cpuPct >= 60 ? 'bg-yellow-500' : 'bg-emerald-500')}
                    style={{ width: `${Math.min(cpuPct, 100)}%` }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 text-[10px]">
                <span className="text-muted-foreground w-6">RAM</span>
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full', memPct >= 80 ? 'bg-red-500' : memPct >= 60 ? 'bg-yellow-500' : 'bg-emerald-500')}
                    style={{ width: `${Math.min(memPct, 100)}%` }}
                  />
                </div>
              </div>
            </div>
          )}
        </GlanceTile>

        <GlanceTile
          icon={Activity}
          title="App Health"
          value={appStatus === 'ok' ? 'All OK' : appStatus === 'degraded' ? 'Degraded' : appStatus === 'error' ? 'Outage' : '—'}
          status={appStatus === 'ok' ? 'ok' : appStatus === 'degraded' ? 'warning' : appStatus === 'error' ? 'error' : 'idle'}
          onClick={() => onNavigate('app-health')}
        />
      </div>

      {/* Recent Requests Feed */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Recent Activity
          </CardTitle>
          <p className="text-xs text-muted-foreground">Latest system events across all channels</p>
        </CardHeader>
        <CardContent className="pt-0">
          <RecentRequestsFeed limit={8} />
        </CardContent>
      </Card>

      {/* User Actions Log — last 20 actual user-initiated actions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            Action Log
          </CardTitle>
          <p className="text-xs text-muted-foreground">Last 20 user-initiated actions with success/failure status</p>
        </CardHeader>
        <CardContent className="pt-0">
          <RecentUserActionsFeed limit={20} />
        </CardContent>
      </Card>
    </div>
  );
}
