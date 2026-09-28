import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Activity, Thermometer, Droplets, Eye, EyeOff } from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { HAEntity } from '@/lib/api/homeAssistant';

function getSensorIcon(entity: HAEntity) {
  const unit = entity.attributes?.unit_of_measurement as string | undefined;
  const deviceClass = entity.attributes?.device_class as string | undefined;
  if (deviceClass === 'temperature' || unit === '°F' || unit === '°C') return <Thermometer className="h-3 w-3" />;
  if (deviceClass === 'humidity' || unit === '%') return <Droplets className="h-3 w-3" />;
  if (deviceClass === 'motion') return entity.state === 'on' ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />;
  return <Activity className="h-3 w-3" />;
}

function getStateColor(entity: HAEntity) {
  const deviceClass = entity.attributes?.device_class as string | undefined;
  if (deviceClass === 'motion' && entity.state === 'on') return 'text-yellow-400';
  if (deviceClass === 'door' || deviceClass === 'window') {
    return entity.state === 'on' ? 'text-red-400' : 'text-green-400';
  }
  if (entity.state === 'unavailable') return 'text-muted-foreground';
  return 'text-foreground';
}

export function HASensorsCard() {
  const { entities, loading, unavailable } = useSharedHAEntities('sensor');
  const binaries = useSharedHAEntities('binary_sensor');
  const allSensors = [...entities, ...binaries.entities].filter(
    e => e.state !== 'unavailable' && e.state !== 'unknown'
  );

  const isLoading = loading || binaries.loading;
  const isUnavailable = unavailable || binaries.unavailable;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5 text-accent" />
            Sensors
          </CardTitle>
          {isUnavailable ? (
            <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
          ) : (
            <Badge variant="secondary">{allSensors.length} active</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isUnavailable ? (
          <p className="text-sm text-muted-foreground text-center py-4">Home Assistant is not connected</p>
        ) : isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : allSensors.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No sensor data available</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
            {allSensors.map(entity => {
              const name = (entity.attributes?.friendly_name as string) || entity.entity_id;
              const unit = entity.attributes?.unit_of_measurement as string | undefined;
              const displayValue = entity.state + (unit ? ` ${unit}` : '');
              return (
                <div
                  key={entity.entity_id}
                  className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/20 px-3 py-2"
                >
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    {getSensorIcon(entity)}
                    <span className="text-xs truncate">{name}</span>
                  </div>
                  <span className={`text-sm font-semibold ${getStateColor(entity)}`}>
                    {displayValue}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
