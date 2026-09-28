import { format } from 'date-fns';
import { 
  Activity, 
  DoorOpen, 
  Shield, 
  Camera, 
  Settings2,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ActivityEvent, ActivityEventType, ActivitySeverity } from '@/types/activity';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

const eventTypeConfig: Record<ActivityEventType, { icon: typeof Activity; label: string }> = {
  motion: { icon: Activity, label: 'Motion' },
  access: { icon: DoorOpen, label: 'Access' },
  alarm: { icon: Shield, label: 'Alarm' },
  camera: { icon: Camera, label: 'Camera' },
  system: { icon: Settings2, label: 'System' },
};

const severityColors: Record<ActivitySeverity, string> = {
  info: 'bg-status-online/10 text-status-online',
  warning: 'bg-status-warning/10 text-status-warning',
  alert: 'bg-status-offline/10 text-status-offline',
};

const severityBorder: Record<ActivitySeverity, string> = {
  info: 'border-l-status-online',
  warning: 'border-l-status-warning',
  alert: 'border-l-status-offline',
};

interface ActivityEventItemProps {
  event: ActivityEvent;
  compact?: boolean;
}

export function ActivityEventItem({ event, compact = false }: ActivityEventItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const config = eventTypeConfig[event.event_type];
  const Icon = config.icon;
  const hasMetadata = Object.keys(event.metadata).length > 0;

  const timeDisplay = format(new Date(event.occurred_at), compact ? 'h:mm a' : 'h:mm:ss a');
  const dateDisplay = format(new Date(event.occurred_at), 'MMM d');

  if (compact) {
    return (
      <div className={cn(
        "flex items-center gap-3 py-2 border-l-2 pl-3",
        severityBorder[event.severity]
      )}>
        <div className={cn("p-1.5 rounded-md", severityColors[event.severity])}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm truncate">{event.description}</p>
          <p className="text-xs text-muted-foreground">
            {event.zone && `${event.zone} · `}{timeDisplay}
          </p>
        </div>
      </div>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn(
        "border rounded-lg bg-card border-l-4 transition-colors",
        severityBorder[event.severity],
        isOpen && "bg-muted/30"
      )}>
        <CollapsibleTrigger asChild>
          <button className="w-full p-4 flex items-center gap-4 text-left hover:bg-muted/50 transition-colors">
            <div className={cn("p-2 rounded-lg", severityColors[event.severity])}>
              <Icon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium">{event.description}</p>
              <p className="text-sm text-muted-foreground">
                {event.zone && `${event.zone} · `}
                <span className="capitalize">{config.label}</span>
              </p>
            </div>
            <div className="text-right text-sm text-muted-foreground">
              <p>{timeDisplay}</p>
              <p>{dateDisplay}</p>
            </div>
            {hasMetadata && (
              <div className="text-muted-foreground">
                {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </div>
            )}
          </button>
        </CollapsibleTrigger>
        {hasMetadata && (
          <CollapsibleContent>
            <div className="px-4 pb-4 pt-0">
              <div className="bg-muted/50 rounded-md p-3 text-sm">
                <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wider">Details</p>
                <dl className="space-y-1">
                  {Object.entries(event.metadata).map(([key, value]) => (
                    <div key={key} className="flex justify-between">
                      <dt className="text-muted-foreground capitalize">{key.replace(/_/g, ' ')}</dt>
                      <dd className="font-medium">{String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </CollapsibleContent>
        )}
      </div>
    </Collapsible>
  );
}
