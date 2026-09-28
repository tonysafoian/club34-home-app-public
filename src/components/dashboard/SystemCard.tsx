import { ReactNode, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

type SystemStatus = 'online' | 'offline' | 'warning' | 'idle';

interface SystemCardProps {
  title: string;
  icon: ReactNode;
  status: SystemStatus;
  statusText?: string;
  metrics?: { label: string; value: string | ReactNode }[];
  quickActions?: { label: string; onClick: () => void; icon?: ReactNode }[];
  accentColor?: string;
  children?: ReactNode;
  expandable?: boolean;
  defaultExpanded?: boolean;
}

const statusConfig: Record<SystemStatus, { label: string; className: string }> = {
  online: { label: 'Online', className: 'bg-status-online text-white' },
  offline: { label: 'Offline', className: 'bg-status-offline text-white' },
  warning: { label: 'Warning', className: 'bg-status-warning text-white' },
  idle: { label: 'Idle', className: 'bg-status-idle text-white' },
};

export function SystemCard({
  title,
  icon,
  status,
  statusText,
  metrics = [],
  quickActions = [],
  accentColor,
  children,
  expandable = true,
  defaultExpanded = false,
}: SystemCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const statusInfo = statusConfig[status];

  return (
    <Card className="overflow-hidden transition-all duration-300 hover:shadow-lg animate-slide-up">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'w-12 h-12 rounded-xl flex items-center justify-center',
                accentColor || 'bg-primary/10'
              )}
            >
              {icon}
            </div>
            <div>
              <CardTitle className="text-lg">{title}</CardTitle>
              <div className="flex items-center gap-2 mt-1">
                <Badge className={cn('text-xs', statusInfo.className)}>
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full mr-1.5',
                      status === 'online' && 'bg-white animate-pulse-soft'
                    )}
                  />
                  {statusText || statusInfo.label}
                </Badge>
              </div>
            </div>
          </div>
          {expandable && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsExpanded(!isExpanded)}
              className="shrink-0"
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Metrics */}
        {metrics.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            {metrics.map((metric, index) => (
              <div key={index} className="bg-muted/50 rounded-lg p-3">
                <p className="text-xs text-muted-foreground">{metric.label}</p>
                <p className="text-lg font-semibold">{metric.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Quick Actions */}
        {quickActions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {quickActions.map((action, index) => (
              <Button
                key={index}
                variant="secondary"
                size="sm"
                onClick={action.onClick}
                className="gap-2"
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>
        )}

        {/* Expanded Content */}
        {isExpanded && children && (
          <div className="pt-3 border-t border-border animate-fade-in">{children}</div>
        )}
      </CardContent>
    </Card>
  );
}
