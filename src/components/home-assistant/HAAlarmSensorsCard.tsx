import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Loader2, DoorOpen, DoorClosed, Eye, EyeOff, Snowflake, Droplets, AlertTriangle,
  Radio, ShieldCheck, BatteryLow, Wrench, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useSharedHAEntities } from '@/hooks/useHAEntitiesContext';
import { HAEntity } from '@/lib/api/homeAssistant';

type SensorCategory = 'contact' | 'motion' | 'freeze' | 'water' | 'glass_break' | 'other';

function classifyBinarySensor(entity: HAEntity): SensorCategory {
  const deviceClass = entity.attributes?.device_class as string | undefined;
  const name = ((entity.attributes?.friendly_name as string) || entity.entity_id).toLowerCase();

  if (deviceClass === 'door' || deviceClass === 'window' || deviceClass === 'opening' || deviceClass === 'garage_door') return 'contact';
  if (deviceClass === 'motion' || deviceClass === 'occupancy' || deviceClass === 'presence') return 'motion';
  if (deviceClass === 'cold' || name.includes('freeze')) return 'freeze';
  if (deviceClass === 'moisture' || name.includes('water') || name.includes('leak')) return 'water';
  if (deviceClass === 'vibration' || name.includes('glass') || name.includes('break')) return 'glass_break';
  // Check name patterns for contact sensors
  if (name.includes('door') || name.includes('window') || name.includes('gate')) return 'contact';
  if (name.includes('motion') || name.includes('pir')) return 'motion';
  return 'other';
}

const CATEGORY_CONFIG: Record<SensorCategory, { label: string; openIcon: typeof DoorOpen; closedIcon: typeof DoorClosed }> = {
  contact: { label: 'Doors & Windows', openIcon: DoorOpen, closedIcon: DoorClosed },
  motion: { label: 'Motion', openIcon: Eye, closedIcon: EyeOff },
  freeze: { label: 'Freeze', openIcon: Snowflake, closedIcon: Snowflake },
  water: { label: 'Water / Leak', openIcon: Droplets, closedIcon: Droplets },
  glass_break: { label: 'Glass Break', openIcon: Radio, closedIcon: Radio },
  other: { label: 'Other Sensors', openIcon: ShieldCheck, closedIcon: ShieldCheck },
};

const CATEGORY_ORDER: SensorCategory[] = ['contact', 'motion', 'water', 'freeze', 'glass_break', 'other'];

function SensorRow({ entity }: { entity: HAEntity }) {
  const friendlyName = (entity.attributes?.friendly_name as string) || entity.entity_id;
  const isOpen = entity.state === 'on';
  const category = classifyBinarySensor(entity);
  const config = CATEGORY_CONFIG[category];
  const Icon = isOpen ? config.openIcon : config.closedIcon;
  const lowBattery = entity.attributes?.battery_low === true || entity.attributes?.low_battery === true;
  const malfunction = entity.attributes?.malfunction === true;

  return (
    <div className="flex items-center gap-2 py-1.5">
      <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${isOpen ? 'text-yellow-500' : 'text-green-500'}`} />
      <span className="text-sm flex-1 truncate">{friendlyName}</span>
      {lowBattery && <BatteryLow className="h-3 w-3 text-red-400 flex-shrink-0" />}
      {malfunction && <Wrench className="h-3 w-3 text-orange-400 flex-shrink-0" />}
      <span className={`text-xs font-medium ${isOpen ? 'text-yellow-500' : 'text-green-500'}`}>
        {category === 'motion'
          ? (isOpen ? 'Detected' : 'Clear')
          : (isOpen ? 'Open' : 'Closed')}
      </span>
    </div>
  );
}

export function HAAlarmSensorsCard() {
  const { entities: binarySensors, loading, unavailable } = useSharedHAEntities('binary_sensor');
  const [expanded, setExpanded] = useState(false);

  // Filter to security-related binary sensors (Alarm.com-style)
  const securitySensors = useMemo(() => {
    return binarySensors.filter(e => {
      const dc = e.attributes?.device_class as string | undefined;
      const name = ((e.attributes?.friendly_name as string) || e.entity_id).toLowerCase();
      // Include security-relevant device classes
      if (['door', 'window', 'opening', 'garage_door', 'motion', 'occupancy',
        'presence', 'cold', 'moisture', 'vibration'].includes(dc || '')) return true;
      // Include by name pattern
      if (/door|window|gate|motion|pir|freeze|glass|break|leak|water|sensor/i.test(name)) return true;
      // Exclude obviously non-security sensors
      if (['connectivity', 'battery', 'plug', 'power', 'update', 'running', 'problem'].includes(dc || '')) return false;
      return false;
    });
  }, [binarySensors]);

  const categorized = useMemo(() => {
    const map = new Map<SensorCategory, HAEntity[]>();
    for (const cat of CATEGORY_ORDER) map.set(cat, []);
    for (const entity of securitySensors) {
      const cat = classifyBinarySensor(entity);
      map.get(cat)!.push(entity);
    }
    return CATEGORY_ORDER
      .filter(cat => (map.get(cat)?.length || 0) > 0)
      .map(cat => ({ category: cat, entities: map.get(cat)! }));
  }, [securitySensors]);

  const openCount = securitySensors.filter(e => e.state === 'on').length;
  const alertSensors = securitySensors.filter(e =>
    e.attributes?.battery_low === true || e.attributes?.low_battery === true || e.attributes?.malfunction === true
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <DoorClosed className="h-5 w-5 text-primary" />
            Security Sensors
          </CardTitle>
          <div className="flex items-center gap-2">
            {unavailable ? (
              <Badge variant="outline" className="text-muted-foreground">Not connected</Badge>
            ) : (
              <>
                {alertSensors.length > 0 && (
                  <Badge variant="destructive" className="text-[10px] px-1.5 gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {alertSensors.length}
                  </Badge>
                )}
                <Badge variant={openCount > 0 ? 'default' : 'secondary'}>
                  {openCount > 0 ? `${openCount} open` : 'All secure'}
                </Badge>
              </>
            )}
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
        ) : securitySensors.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">No security sensors found</p>
        ) : (
          <div className="space-y-1">
            <Accordion
              type="multiple"
              className="w-full"
              defaultValue={categorized
                .filter(c => c.entities.some(e => e.state === 'on'))
                .map(c => c.category)}
            >
              {categorized.map(({ category, entities }) => {
                const config = CATEGORY_CONFIG[category];
                const openInCat = entities.filter(e => e.state === 'on').length;
                const visible = expanded ? entities : entities.slice(0, 10);
                return (
                  <AccordionItem key={category} value={category}>
                    <AccordionTrigger className="py-2 text-sm hover:no-underline">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="font-semibold">{config.label}</span>
                        {openInCat > 0 ? (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0">
                            {openInCat} open
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">({entities.length})</span>
                        )}
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="divide-y divide-border">
                        {visible.map(entity => (
                          <SensorRow key={entity.entity_id} entity={entity} />
                        ))}
                      </div>
                      {entities.length > 10 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full h-6 text-xs text-muted-foreground mt-1"
                          onClick={() => setExpanded(!expanded)}
                        >
                          {expanded ? (
                            <><ChevronUp className="h-3 w-3 mr-1" />Show less</>
                          ) : (
                            <><ChevronDown className="h-3 w-3 mr-1" />{entities.length - 10} more</>
                          )}
                        </Button>
                      )}
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
            </Accordion>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
