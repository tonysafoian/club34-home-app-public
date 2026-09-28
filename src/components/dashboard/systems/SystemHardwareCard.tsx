import { useMemo } from 'react';
import { Server, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Loader2 } from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { HAEntity } from '@/lib/api/homeAssistant';
import { useSharedHAAllEntities } from '@/hooks/useHAEntitiesContext';
import { cn } from '@/lib/utils';

const ENTITY_IDS = [
  'sensor.system_monitor_processor_use',
  'sensor.system_monitor_processor_temperature',
  'sensor.system_monitor_load_1_min',
  'sensor.system_monitor_load_5_min',
  'sensor.system_monitor_load_15_min',
  'sensor.system_monitor_memory_usage',
  'sensor.system_monitor_memory_use',
  'sensor.system_monitor_memory_free',
  'sensor.system_monitor_disk_usage',
  'sensor.system_monitor_disk_use',
  'sensor.system_monitor_disk_free',
  'sensor.system_monitor_swap_usage',
  'sensor.system_monitor_swap_use',
  'sensor.system_monitor_swap_free',
  'sensor.system_monitor_ipv4_address_end0',
  'sensor.system_monitor_network_throughput_in_end0',
  'sensor.system_monitor_network_throughput_out_end0',
  'sensor.system_monitor_network_in_end0',
  'sensor.system_monitor_network_out_end0',
  'sensor.system_monitor_last_boot',
];

const ENTITY_SET = new Set(ENTITY_IDS);

function val(entities: Record<string, HAEntity>, id: string): string {
  return entities[id]?.state ?? '—';
}

function num(entities: Record<string, HAEntity>, id: string): number {
  const v = parseFloat(entities[id]?.state ?? '');
  return isNaN(v) ? 0 : v;
}

function progressColor(pct: number): string {
  if (pct >= 80) return 'bg-red-500';
  if (pct >= 60) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

function formatUptime(bootIso: string): string {
  const boot = new Date(bootIso);
  if (isNaN(boot.getTime())) return '—';
  const diff = Date.now() - boot.getTime();
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 mt-1">
      {children}
    </p>
  );
}

function ProgressRow({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{pct.toFixed(1)}%</span>
      </div>
      <div className="relative h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', progressColor(pct))}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">{detail}</p>
    </div>
  );
}

export function SystemHardwareCard() {
  const { allEntities, loading } = useSharedHAAllEntities();

  const entities = useMemo(() => {
    const map: Record<string, HAEntity> = {};
    for (const e of allEntities) {
      if (ENTITY_SET.has(e.entity_id)) map[e.entity_id] = e;
    }
    return map;
  }, [allEntities]);

  const ip = val(entities, 'sensor.system_monitor_ipv4_address_end0');
  const cpuPct = num(entities, 'sensor.system_monitor_processor_use');
  const cpuTemp = val(entities, 'sensor.system_monitor_processor_temperature');
  const load1 = val(entities, 'sensor.system_monitor_load_1_min');
  const load5 = val(entities, 'sensor.system_monitor_load_5_min');
  const load15 = val(entities, 'sensor.system_monitor_load_15_min');

  const memPct = num(entities, 'sensor.system_monitor_memory_usage');
  const memUsed = val(entities, 'sensor.system_monitor_memory_use');
  const memFree = val(entities, 'sensor.system_monitor_memory_free');

  const diskPct = num(entities, 'sensor.system_monitor_disk_usage');
  const diskUsed = val(entities, 'sensor.system_monitor_disk_use');
  const diskFree = val(entities, 'sensor.system_monitor_disk_free');

  const swapPct = num(entities, 'sensor.system_monitor_swap_usage');
  const swapUsed = val(entities, 'sensor.system_monitor_swap_use');
  const swapFree = val(entities, 'sensor.system_monitor_swap_free');

  const netIn = val(entities, 'sensor.system_monitor_network_throughput_in_end0');
  const netOut = val(entities, 'sensor.system_monitor_network_throughput_out_end0');
  const totalIn = val(entities, 'sensor.system_monitor_network_in_end0');
  const totalOut = val(entities, 'sensor.system_monitor_network_out_end0');

  const bootIso = val(entities, 'sensor.system_monitor_last_boot');
  const uptime = bootIso !== '—' ? formatUptime(bootIso) : '—';

  return (
    <SystemCard
      title="HA Server"
      icon={<Server className="h-6 w-6 text-violet-400" />}
      status={loading ? 'idle' : 'online'}
      statusText={loading ? 'Loading…' : ip !== '—' ? ip : 'Connected'}
      accentColor="bg-violet-500/10"
      metrics={[
        { label: 'CPU', value: loading ? '…' : `${cpuPct.toFixed(0)}%` },
        { label: 'Mem', value: loading ? '…' : `${memPct.toFixed(0)}%` },
        { label: 'Uptime', value: loading ? '…' : uptime },
      ]}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : Object.keys(entities).length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
          <div className="rounded-full bg-violet-500/10 p-3">
            <Server className="h-6 w-6 text-violet-400" />
          </div>
          <div>
            <p className="text-sm font-semibold">No System Monitor Data</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              System Monitor integration must be enabled in Home Assistant.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <SectionLabel>CPU</SectionLabel>
            <ProgressRow label="Usage" pct={cpuPct} detail={`Temp: ${cpuTemp}°F`} />
            <p className="text-[10px] text-muted-foreground mt-1 font-mono">
              Load: {load1} / {load5} / {load15}
            </p>
          </div>

          <div className="border-t border-border" />

          <div>
            <SectionLabel>Memory</SectionLabel>
            <ProgressRow
              label="Usage"
              pct={memPct}
              detail={`${parseFloat(memUsed).toFixed(0)} MiB / ${(parseFloat(memUsed) + parseFloat(memFree)).toFixed(0)} MiB`}
            />
          </div>

          <div className="border-t border-border" />

          <div>
            <SectionLabel>Disk</SectionLabel>
            <ProgressRow
              label="Usage"
              pct={diskPct}
              detail={`${parseFloat(diskUsed).toFixed(1)} GiB / ${(parseFloat(diskUsed) + parseFloat(diskFree)).toFixed(1)} GiB`}
            />
          </div>

          <div className="border-t border-border" />

          <div>
            <SectionLabel>Swap</SectionLabel>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">Usage:</span>
              <span className="font-mono tabular-nums">{swapPct.toFixed(1)}%</span>
              <span className="text-muted-foreground">Used:</span>
              <span className="font-mono tabular-nums">{parseFloat(swapUsed).toFixed(0)} MiB</span>
              <span className="text-muted-foreground">Free:</span>
              <span className="font-mono tabular-nums">{parseFloat(swapFree).toFixed(0)} MiB</span>
            </div>
          </div>

          <div className="border-t border-border" />

          <div>
            <SectionLabel>Network</SectionLabel>
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="outline" className="text-[10px] font-mono">{ip}</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-1">
                <ArrowDown className="h-3 w-3 text-emerald-400" />
                <span className="text-muted-foreground">In:</span>
                <span className="font-mono tabular-nums">{parseFloat(netIn).toFixed(2)} MB/s</span>
              </div>
              <div className="flex items-center gap-1">
                <ArrowUp className="h-3 w-3 text-blue-400" />
                <span className="text-muted-foreground">Out:</span>
                <span className="font-mono tabular-nums">{parseFloat(netOut).toFixed(2)} MB/s</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground mt-1">
              <span>Total ↓ {parseFloat(totalIn).toFixed(1)} MiB</span>
              <span>Total ↑ {parseFloat(totalOut).toFixed(1)} MiB</span>
            </div>
          </div>

          <div className="border-t border-border" />

          <div>
            <SectionLabel>System</SectionLabel>
            <p className="text-xs">
              <span className="text-muted-foreground">Uptime: </span>
              <span className="font-semibold">{uptime}</span>
            </p>
          </div>
        </div>
      )}
    </SystemCard>
  );
}
