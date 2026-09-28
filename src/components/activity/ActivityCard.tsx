import { Link } from 'react-router-dom';
import { Activity, ArrowRight, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ActivityEventItem } from './ActivityEventItem';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { ActivityEvent } from '@/types/activity';

export function ActivityCard() {
  const { data: recentEvents = [], isLoading } = useQuery({
    queryKey: ['activity-events-recent'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<ActivityEvent[]>({
        table: 'activity_events',
        select: '*',
        order: { column: 'occurred_at', ascending: false },
        limit: 5,
      });
      return data ?? [];
    },
    refetchInterval: 30_000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-lg font-semibold flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          Recent Activity
        </CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/activity" className="gap-1">
            View All
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : recentEvents.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No recent activity
          </p>
        ) : (
          <div className="space-y-1">
            {recentEvents.map((event) => (
              <ActivityEventItem key={event.id} event={event} compact />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
