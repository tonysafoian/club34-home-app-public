import { useVerkadaSightingHealth } from '@/hooks/useVerkada';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Users, ArrowRight } from 'lucide-react';
import { format } from 'date-fns';

interface VerkadaPeopleTrackerSummaryProps {
  onViewAll?: () => void;
}

export function VerkadaPeopleTrackerSummary({ onViewAll }: VerkadaPeopleTrackerSummaryProps) {
  const { data: sightingHealth, isLoading } = useVerkadaSightingHealth();

  const uniquePeopleToday = sightingHealth?.unique_people_today ?? 0;
  const totalSightingsToday = sightingHealth?.total_sightings_today ?? 0;
  const recentSightings = (sightingHealth?.recent_sightings ?? []).slice(0, 3);

  return (
    <Card className="border-border bg-card" data-testid="people-tracker-summary">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            People Tracker
          </CardTitle>
          {onViewAll && (
            <button
              onClick={onViewAll}
              className="text-xs text-primary hover:underline cursor-pointer flex items-center gap-1"
              data-testid="link-people-tracker-full"
            >
              View details
              <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-16 rounded-lg" />
          </div>
        ) : (
          <div className="space-y-3">
            {/* Today's stats */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground" data-testid="text-people-today">
                  {uniquePeopleToday}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  People
                </span>
                <span className="text-[9px] text-muted-foreground/70">today</span>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground" data-testid="text-sightings-today">
                  {totalSightingsToday}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  Sightings
                </span>
                <span className="text-[9px] text-muted-foreground/70">today</span>
              </div>
            </div>

            {/* Last few sightings */}
            {recentSightings.length > 0 ? (
              <div className="space-y-0.5">
                {recentSightings.map((sighting, idx) => (
                  <div
                    key={`${sighting.verkada_person_id}-${sighting.seen_at}-${idx}`}
                    className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-muted/20"
                    data-testid={`row-recent-sighting-${idx}`}
                  >
                    <span className="font-medium min-w-[60px] truncate">
                      {sighting.label || 'Unknown'}
                    </span>
                    <span className="text-muted-foreground truncate flex-1">
                      {sighting.camera_name || 'detected'}
                    </span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {format(new Date(sighting.seen_at), 'h:mm a')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-2" data-testid="text-no-sightings">
                No sightings yet today
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
