import { Warehouse, DoorClosed, Car } from 'lucide-react';
import { AwaitingIntegration } from './AwaitingIntegration';

/**
 * MyQ garage doors. Not yet wired to a real data source — renders the
 * shared AwaitingIntegration placeholder instead of mock doors with
 * non-functional controls.
 */
export function MyQCard() {
  return (
    <AwaitingIntegration
      title="MyQ Garage"
      icon={<Warehouse className="h-6 w-6 text-muted-foreground" />}
      accentColor="bg-muted"
      description="Garage door status and controls will appear here once MyQ is connected, most likely through the Home Assistant integration."
      plannedFeatures={[
        {
          icon: <DoorClosed className="h-4 w-4 text-emerald-400" />,
          title: 'Door Status',
          description: 'Live open/closed state per garage door',
        },
        {
          icon: <Car className="h-4 w-4 text-sky-400" />,
          title: 'Vehicle Presence',
          description: 'Whether a vehicle is parked in each bay',
        },
      ]}
    />
  );
}
