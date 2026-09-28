import { useMemo } from 'react';
import { Thermometer, Droplets, Loader2, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useSharedHAEntities, useGoveeEntityIds } from '@/hooks/useHAEntitiesContext';
import { HAEntity } from '@/lib/api/homeAssistant';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { useToast } from '@/hooks/use-toast';
import { isAvClosetTempSensor } from '@shared/avCloset';
import { useAvClosetReading } from '@/hooks/useAvClosetReading';

function isGoveeSensor(entity: HAEntity, goveeIds: Set<string>): boolean {
  if (goveeIds.size > 0) return goveeIds.has(entity.entity_id);
  // Fallback name/id heuristic when the govee entity ID list hasn't loaded yet.
  // Include H5103 model marker so devices with generic HA names like
  // "Govee H5103 1A2B" are still captured before the user renames them.
  const id = entity.entity_id.toLowerCase();
  const name = ((entity.attributes?.friendly_name as string) || '').toLowerCase();
  return id.includes('govee') || name.includes('govee') || id.includes('h5103') || name.includes('h5103');
}

function isTemperatureOrHumidity(entity: HAEntity): boolean {
  const dc = entity.attributes?.device_class as string | undefined;
  const unit = entity.attributes?.unit_of_measurement as string | undefined;
  return (
    dc === 'temperature' || dc === 'humidity' ||
    unit === '°F' || unit === '°C' || unit === '%'
  );
}

function SensorTile({ entity, overrideValue }: { entity: HAEntity; overrideValue?: string }) {
  const name = (entity.attributes?.friendly_name as string) || entity.entity_id.replace(/^sensor\./, '').replace(/_/g, ' ');
  const unit = entity.attributes?.unit_of_measurement as string | undefined;
  const dc = entity.attributes?.device_class as string | undefined;
  const isTemp = dc === 'temperature' || unit === '°F' || unit === '°C';
  const isHum = dc === 'humidity';

  // HA's Govee integration double-converts AV Closet temp (reports ~155°F);
  // overrideValue carries the corrected Govee Cloud reading when applicable.
  const displayValue = overrideValue ?? (entity.state + (unit ? ` ${unit}` : ''));

  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {isTemp ? (
          <Thermometer className="h-3 w-3 shrink-0" />
        ) : isHum ? (
          <Droplets className="h-3 w-3 shrink-0" />
        ) : (
          <Thermometer className="h-3 w-3 shrink-0" />
        )}
        <span className="text-xs truncate">{name}</span>
      </div>
      <span className="text-sm font-semibold">
        {displayValue}
      </span>
    </div>
  );
}

export function HAGoveeSensorsCard() {
  const { toast } = useToast();
  const { entities: allSensors, loading, unavailable, refetch } = useSharedHAEntities('sensor');
  const goveeIds = useGoveeEntityIds();
  const { data: avReading } = useAvClosetReading();

  const goveeSensors = useMemo(() =>
    allSensors.filter(e =>
      isGoveeSensor(e, goveeIds) &&
      isTemperatureOrHumidity(e) &&
      e.state !== 'unavailable' &&
      e.state !== 'unknown'
    ),
    [allSensors, goveeIds]
  );

  const reloadMutation = useMutation({
    mutationFn: () => apiClient.post<{ success: boolean; domain?: string; title?: string; error?: string }>('/api/home-assistant/govee/reload'),
    onSuccess: (data) => {
      if (data?.success) {
        toast({
          title: 'Govee integration reloaded',
          description: `HA will re-discover all Govee devices. New sensors should appear within a minute.`,
        });
        setTimeout(() => refetch(true), 3000);
      } else {
        toast({
          title: 'Reload may have failed',
          description: data?.error ?? 'Check audit log for details.',
          variant: 'destructive',
        });
      }
    },
    onError: (err: Error) => {
      const msg = err?.message ?? String(err);
      if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
        toast({
          title: 'Govee integration not found',
          description: 'No Govee config entry was found in Home Assistant. The integration may not be installed.',
          variant: 'destructive',
        });
      } else {
        toast({ title: 'Reload failed', description: msg, variant: 'destructive' });
      }
    },
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Thermometer className="h-5 w-5 text-blue-400" />
            Govee Sensors
          </CardTitle>
          <div className="flex items-center gap-2">
            {!unavailable && !loading && (
              <Badge variant="secondary">{goveeSensors.length} active</Badge>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => reloadMutation.mutate()}
              disabled={reloadMutation.isPending}
              data-testid="button-govee-reload"
            >
              <RefreshCw className={`h-3 w-3 ${reloadMutation.isPending ? 'animate-spin' : ''}`} />
              {reloadMutation.isPending ? 'Reloading…' : 'Reload Govee'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="text-sm text-muted-foreground text-center py-4">Home Assistant is not connected</p>
        ) : loading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : goveeSensors.length === 0 ? (
          <div className="text-center py-4 space-y-2">
            <p className="text-sm text-muted-foreground">
              No Govee temperature or humidity sensors found in Home Assistant.
            </p>
            <p className="text-xs text-muted-foreground">
              If you just added a new device, click <strong>Reload Govee</strong> to trigger re-discovery.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {goveeSensors.map(entity => {
              const isAvTemp = isAvClosetTempSensor(
                entity.entity_id,
                entity.attributes?.friendly_name as string | undefined,
                entity.attributes?.device_class as string | undefined,
                entity.attributes?.unit_of_measurement as string | undefined,
              );
              const override =
                isAvTemp && avReading?.tempF != null && Number.isFinite(avReading.tempF)
                  ? `${Math.round(avReading.tempF)} °F`
                  : undefined;
              return <SensorTile key={entity.entity_id} entity={entity} overrideValue={override} />;
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
