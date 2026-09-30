import { useState } from 'react';
import { SystemCard } from '../SystemCard';
import { Waves, RefreshCw, Thermometer, Droplets, Power, Sun, Loader2, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useIaqualinkHA, LIGHT_EFFECTS } from '@/hooks/useIaqualinkHA';
import { toggleSwitch, toggleLight, callService, setClimateTemp } from '@/lib/api/homeAssistant';
import { useToast } from '@/hooks/use-toast';

const TEMP_BOUNDS: Record<string, { min: number; max: number }> = {
  pool: { min: 30, max: 120 },
  spa: { min: 30, max: 120 },
  air: { min: -20, max: 130 },
  setPoint: { min: 30, max: 120 },
};

function isTempOutOfBounds(value: string | null, type: string): boolean {
  if (!value) return false;
  const num = parseFloat(value);
  if (isNaN(num)) return false;
  const bounds = TEMP_BOUNDS[type] || TEMP_BOUNDS.pool;
  return num < bounds.min || num > bounds.max;
}

function ToggleRow({ label, entityId, isOn, onRefresh }: {
  label: string;
  entityId: string;
  isOn: boolean;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const handle = async () => {
    try {
      setBusy(true);
      await toggleSwitch(entityId);
      setTimeout(onRefresh, 800);
    } catch (err) {
      toast({ title: `Failed to toggle ${label}`, description: String(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm">{label}</span>
      <div className="flex items-center gap-2">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Switch checked={isOn} onCheckedChange={handle} disabled={busy} />
      </div>
    </div>
  );
}

function HeaterRow({ label, switchId, climateId, isOn, setPoint, onRefresh }: {
  label: string;
  switchId: string;
  climateId?: string;
  isOn: boolean;
  setPoint?: string | null;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    try {
      setBusy(true);
      await toggleSwitch(switchId);
      setTimeout(onRefresh, 800);
    } catch (err) {
      toast({ title: `Failed to toggle ${label}`, description: String(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const adjustTemp = async (delta: number) => {
    if (!climateId || !setPoint) return;
    try {
      setBusy(true);
      const newFahrenheit = Number(setPoint) + delta;
      await setClimateTemp(climateId, newFahrenheit);
      setTimeout(onRefresh, 800);
    } catch (err) {
      toast({ title: 'Failed to adjust temperature', description: String(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const outOfBounds = isTempOutOfBounds(setPoint ?? null, 'setPoint');

  return (
    <div className="flex items-center justify-between py-1.5 gap-2">
      <span className="text-sm shrink-0">{label}</span>
      <div className="flex items-center gap-2">
        {climateId && setPoint && (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => adjustTemp(-1)} disabled={busy} data-testid={`button-temp-down-${label.toLowerCase().replace(/\s+/g, '-')}`}>
              <span className="text-xs font-bold">−</span>
            </Button>
            <span className="text-xs font-medium w-8 text-center" data-testid={`text-setpoint-${label.toLowerCase().replace(/\s+/g, '-')}`}>
              {setPoint}°F
            </span>
            {outOfBounds && (
              <AlertTriangle className="h-3 w-3 text-amber-500" data-testid={`warning-setpoint-${label.toLowerCase().replace(/\s+/g, '-')}`} />
            )}
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => adjustTemp(1)} disabled={busy} data-testid={`button-temp-up-${label.toLowerCase().replace(/\s+/g, '-')}`}>
              <span className="text-xs font-bold">+</span>
            </Button>
          </div>
        )}
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Switch checked={isOn} onCheckedChange={handleToggle} disabled={busy} />
      </div>
    </div>
  );
}

function LightRow({ label, entityId, isOn, currentEffect, onRefresh }: {
  label: string;
  entityId: string;
  isOn: boolean;
  currentEffect?: string;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    try {
      setBusy(true);
      await toggleLight(entityId);
      setTimeout(onRefresh, 800);
    } catch (err) {
      toast({ title: `Failed to toggle ${label}`, description: String(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const handleEffect = async (effect: string) => {
    try {
      setBusy(true);
      await callService('light', 'turn_on', { entity_id: entityId, effect });
      setTimeout(onRefresh, 800);
    } catch (err) {
      toast({ title: 'Failed to set effect', description: String(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between py-1.5 gap-2">
      <span className="text-sm shrink-0">{label}</span>
      <div className="flex items-center gap-2">
        <Select value={currentEffect || ''} onValueChange={handleEffect} disabled={busy || !isOn}>
          <SelectTrigger className="h-7 w-[120px] text-xs">
            <SelectValue placeholder="Effect" />
          </SelectTrigger>
          <SelectContent>
            {LIGHT_EFFECTS.map(e => (
              <SelectItem key={e} value={e} className="text-xs">{e}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        <Switch checked={isOn} onCheckedChange={handleToggle} disabled={busy} />
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground pt-3 pb-1">{children}</p>;
}

function TempValue({ value, type, loading }: { value: string | null; type: string; loading: boolean }) {
  if (loading) return <span>…</span>;
  if (!value || value === 'unknown' || value === 'unavailable') return <span>—</span>;
  const outOfBounds = isTempOutOfBounds(value, type);
  return (
    <span className="inline-flex items-center gap-0.5">
      {value}°F
      {outOfBounds && (
        <AlertTriangle className="h-3 w-3 text-amber-500 inline" data-testid={`warning-temp-${type}`} />
      )}
    </span>
  );
}

export function IaqualinkCard() {
  const { loading, connected, entities, temperatures, freezeProtection, refetch } = useIaqualinkHA();

  const getEntity = (id: string) => entities.get(id);
  const isOn = (id: string) => getEntity(id)?.state === 'on';
  const lightEffect = (id: string) => getEntity(id)?.attributes?.effect as string | undefined;

  const metrics = [
    { label: 'Pool', value: loading ? '…' : <TempValue value={temperatures.pool} type="pool" loading={false} /> },
    { label: 'Spa', value: loading ? '…' : <TempValue value={temperatures.spa} type="spa" loading={false} /> },
    { label: 'Air', value: loading ? '…' : <TempValue value={temperatures.air} type="air" loading={false} /> },
    { label: 'Target', value: loading ? '…' : <TempValue value={temperatures.poolSetPoint} type="setPoint" loading={false} /> },
  ];

  const quickActions = [
    { label: 'Refresh', onClick: () => refetch(), icon: <RefreshCw className="h-4 w-4" /> },
  ];

  const doRefresh = () => refetch(true);

  return (
    <SystemCard
      title="Pool & Spa"
      icon={<Waves className="w-6 h-6 text-system-iaqualink" />}
      status={loading ? 'warning' : connected ? 'online' : entities.size === 0 ? 'idle' : 'offline'}
      statusText={
        loading ? 'Connecting…' : connected ? 'Connected via HA' : entities.size === 0 ? 'No pool detected' : 'Offline'
      }
      metrics={metrics}
      quickActions={quickActions}
      accentColor="bg-system-iaqualink/10"
    >
      {!loading && !connected ? (
        <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
          <div className="rounded-full bg-cyan-500/10 p-3">
            <Waves className="h-6 w-6 text-cyan-400" />
          </div>
          <div>
            <p className="text-sm font-semibold">No Pool Equipment Detected</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              No pool or spa controllers were found in Home Assistant. Connect an iAquaLink, Pentair, Hayward, or generic pool controller integration in HA to view equipment controls here.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-0.5">
          {freezeProtection && (
            <div className="flex items-center gap-2 p-2 rounded-lg bg-destructive/10 text-destructive text-sm mb-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Freeze Protection Active
            </div>
          )}

          <SectionLabel>Pumps</SectionLabel>
          <ToggleRow label="Pool Pump" entityId="switch.pool_pump" isOn={isOn('switch.pool_pump')} onRefresh={doRefresh} />
          <ToggleRow label="Spa Pump" entityId="switch.spa_pump" isOn={isOn('switch.spa_pump')} onRefresh={doRefresh} />
          <ToggleRow label="Booster Pump" entityId="switch.booster_pump" isOn={isOn('switch.booster_pump')} onRefresh={doRefresh} />

          <SectionLabel>Heaters</SectionLabel>
          <HeaterRow label="Pool Heater" switchId="switch.pool_heater" climateId="climate.pool" isOn={isOn('switch.pool_heater')} setPoint={temperatures.poolSetPoint} onRefresh={doRefresh} />
          <HeaterRow label="Spa Heater" switchId="switch.spa_heater" climateId="climate.spa" isOn={isOn('switch.spa_heater')} setPoint={temperatures.spaSetPoint} onRefresh={doRefresh} />
          <HeaterRow label="Solar Heater" switchId="switch.solar_heater" isOn={isOn('switch.solar_heater')} onRefresh={doRefresh} />

          <SectionLabel>Lights</SectionLabel>
          <LightRow label="Pool Light" entityId="light.pool_light" isOn={isOn('light.pool_light')} currentEffect={lightEffect('light.pool_light')} onRefresh={doRefresh} />
          <LightRow label="Spa Light" entityId="light.spa_light" isOn={isOn('light.spa_light')} currentEffect={lightEffect('light.spa_light')} onRefresh={doRefresh} />
          <LightRow label="Laminar LED" entityId="light.laminar_led_lt" isOn={isOn('light.laminar_led_lt')} currentEffect={lightEffect('light.laminar_led_lt')} onRefresh={doRefresh} />

          <SectionLabel>Water Features</SectionLabel>
          <ToggleRow label="Laminar Jets" entityId="switch.laminar_jets" isOn={isOn('switch.laminar_jets')} onRefresh={doRefresh} />
          <ToggleRow label="Bubbler" entityId="switch.bubbler" isOn={isOn('switch.bubbler')} onRefresh={doRefresh} />

          {!freezeProtection && (
            <div className="flex items-center gap-2 pt-3 text-xs text-muted-foreground">
              <Sun className="h-3.5 w-3.5" />
              Freeze Protection: Off
            </div>
          )}
        </div>
      )}
    </SystemCard>
  );
}
