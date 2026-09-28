import { useWebhookEvents } from '@/hooks/useNotion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Webhook, CheckCircle2, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export function NotionWebhookEvents() {
  const { data: events, isLoading } = useWebhookEvents();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Webhook className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Webhook Events</CardTitle>
            <CardDescription className="text-xs">
              Real-time events from Notion (auto-refreshes every 10s)
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : events && events.length > 0 ? (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {events.map((event) => (
              <div
                key={event.id}
                className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/30"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {event.processed ? (
                    <CheckCircle2 className="h-4 w-4 text-status-online shrink-0" />
                  ) : (
                    <Clock className="h-4 w-4 text-status-warning shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {event.event_type}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                      {event.notion_page_id
                        ? `Page: ${event.notion_page_id.substring(0, 8)}…`
                        : event.notion_database_id
                          ? `Database: ${event.notion_database_id.substring(0, 8)}…`
                          : 'Unknown target'}
                    </p>
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap ml-2">
                  {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-6">
            No webhook events yet. Configure a webhook subscription in Notion to start receiving real-time updates.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
