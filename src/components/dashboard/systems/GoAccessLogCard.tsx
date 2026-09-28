import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiClient } from '@/lib/apiClient';
import { DoorOpen, RefreshCw, Building2, User, Clock } from 'lucide-react';
import { format, isToday, isYesterday } from 'date-fns';

type DateFilter = 'today' | '7days' | '30days' | 'all';

interface CheckinRecord {
  id: string;
  guest_name: string;
  company_name: string | null;
  checked_in_at: string;
  raw_email_subject: string | null;
}

function formatCheckinDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isToday(d)) return format(d, "'Today at' h:mm a");
  if (isYesterday(d)) return format(d, "'Yesterday at' h:mm a");
  return format(d, "MMM d, yyyy 'at' h:mm a");
}

function groupByDate(checkins: CheckinRecord[]): { label: string; items: CheckinRecord[] }[] {
  const groups = new Map<string, CheckinRecord[]>();
  for (const c of checkins) {
    const d = new Date(c.checked_in_at);
    let label: string;
    if (isToday(d)) label = "Today";
    else if (isYesterday(d)) label = "Yesterday";
    else label = format(d, "EEEE, MMM d");
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(c);
  }
  return Array.from(groups.entries()).map(([label, items]) => ({ label, items }));
}

export function GoAccessLogCard() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<DateFilter>('7days');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['/api/goaccess/checkins', filter],
    queryFn: async () => {
      const result = await apiClient.get(`/api/goaccess/checkins?filter=${filter}`);
      return result as { success: boolean; checkins: CheckinRecord[] };
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await apiClient.post('/api/goaccess/poll', {});
    } catch {
      // ignore: best-effort poll trigger, refresh proceeds regardless
    }
    await queryClient.invalidateQueries({ queryKey: ['/api/goaccess/checkins'] });
    setIsRefreshing(false);
  };

  const checkins = data?.checkins || [];
  const groups = groupByDate(checkins);

  const filters: { value: DateFilter; label: string }[] = [
    { value: 'today', label: 'Today' },
    { value: '7days', label: '7 Days' },
    { value: '30days', label: '30 Days' },
    { value: 'all', label: 'All Time' },
  ];

  return (
    <Card className="border-border bg-card" data-testid="goaccess-log-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <DoorOpen className="h-4 w-4 text-primary" />
            Gate Check-Ins
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh check-ins"
              data-testid="refresh-goaccess"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Guest check-ins at the gate via GoAccess
        </p>
        <div className="flex gap-1.5 mt-2">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === f.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted'
              }`}
              data-testid={`filter-${f.value}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="text-center py-6 space-y-2">
            <DoorOpen className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">Unable to load check-in data</p>
            <Button variant="outline" size="sm" onClick={handleRefresh} data-testid="retry-goaccess">
              Try again
            </Button>
          </div>
        ) : isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
            <Skeleton className="h-12 rounded-lg" />
          </div>
        ) : checkins.length === 0 ? (
          <div className="text-center py-8 space-y-2">
            <DoorOpen className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              {filter === 'today' ? 'No check-ins today' : 'No check-ins found'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Badge variant="outline" className="text-xs">
                {checkins.length} check-in{checkins.length !== 1 ? 's' : ''}
              </Badge>
            </div>
            {groups.map(group => (
              <div key={group.label} className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground px-1 pb-1">{group.label}</p>
                <div className="space-y-0.5">
                  {group.items.map(checkin => (
                    <div
                      key={checkin.id}
                      className="flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-muted/30 transition-colors"
                      data-testid={`checkin-row-${checkin.id}`}
                    >
                      <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <User className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium truncate" data-testid={`guest-name-${checkin.id}`}>
                            {checkin.guest_name}
                          </span>
                        </div>
                        {checkin.company_name && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Building2 className="h-3 w-3 shrink-0" />
                            <span className="truncate" data-testid={`company-name-${checkin.id}`}>
                              {checkin.company_name}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0 tabular-nums">
                        <Clock className="h-3 w-3" />
                        <span>{format(new Date(checkin.checked_in_at), 'h:mm a')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
