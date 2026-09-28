import { formatDistanceToNow, format } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Webhook, Loader2 } from 'lucide-react';
import { useNotionWebhookHealth, type WebhookHealthStatus } from '@/hooks/useNotionActivity';

const STATUS_META: Record<
  WebhookHealthStatus,
  { label: string; dot: string; badgeClass: string }
> = {
  healthy: {
    label: 'Healthy',
    dot: 'hsl(var(--status-online))',
    badgeClass: 'border-transparent',
  },
  warning: {
    label: 'Delayed',
    dot: 'hsl(38 92% 50%)',
    badgeClass: 'border-transparent',
  },
  stale: {
    label: 'Stale',
    dot: 'hsl(var(--destructive))',
    badgeClass: 'border-transparent',
  },
  never: {
    label: 'No events',
    dot: 'hsl(var(--muted-foreground))',
    badgeClass: 'border-transparent',
  },
};

export function NotionWebhookHealth() {
  const { data, isLoading } = useNotionWebhookHealth();

  const meta = data ? STATUS_META[data.status] : STATUS_META.never;

  return (
    <Card className="glass" data-testid="card-notion-webhook-health">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: 'hsl(var(--primary) / 0.12)' }}
            >
              <Webhook className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">Webhook Health</p>
              <p className="text-xs text-muted-foreground">
                Notion delivery status
              </p>
            </div>
          </div>

          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : (
            <Badge
              className={`gap-1.5 ${meta.badgeClass}`}
              style={{
                backgroundColor: `color-mix(in srgb, ${meta.dot} 18%, transparent)`,
                color: meta.dot,
              }}
              data-testid="badge-webhook-status"
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: meta.dot }}
              />
              {meta.label}
            </Badge>
          )}
        </div>

        {!isLoading && data && (
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div>
              <p className="text-lg font-semibold font-display" data-testid="text-webhook-last-delivery">
                {data.lastEventAt
                  ? formatDistanceToNow(new Date(data.lastEventAt), { addSuffix: true })
                  : 'Never'}
              </p>
              <p className="text-xs text-muted-foreground">
                Last delivery
                {data.lastEventAt && (
                  <span className="block">
                    {format(new Date(data.lastEventAt), "MMM d, h:mm a")}
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="text-lg font-semibold font-display" data-testid="text-webhook-count-24h">
                {data.countLast24h}
              </p>
              <p className="text-xs text-muted-foreground">Events (last 24h)</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
