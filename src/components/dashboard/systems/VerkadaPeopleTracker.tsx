import { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useVerkadaSightingHealth } from '@/hooks/useVerkada';
import { apiClient } from '@/lib/apiClient';
import { useSocketEvent } from '@/hooks/useRealtimeSocket';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Users, Clock, Camera, ArrowDownToLine, RefreshCw, ChevronDown, Wifi, WifiOff } from 'lucide-react';
import { format, formatDistanceToNow, differenceInMinutes } from 'date-fns';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface PoiProfile {
  id: string;
  verkada_person_id: string;
  label: string | null;
  thumbnail_url: string | null;
  last_seen_at: string | null;
}

export function VerkadaPeopleTracker() {
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [timelineExpanded, setTimelineExpanded] = useState(false);

  const now = useMemo(() => new Date(), []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await queryClient.invalidateQueries({ queryKey: ['poi-profiles'] });
    await queryClient.invalidateQueries({ queryKey: ['verkada-sighting-health'] });
    setLastUpdated(new Date());
    setIsRefreshing(false);
  };

  const { data: profiles, isLoading: profilesLoading } = useQuery({
    queryKey: ['poi-profiles'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<PoiProfile[]>({
        table: 'poi_profiles',
        select: 'id, verkada_person_id, label, thumbnail_url, last_seen_at',
        order: { column: 'last_seen_at', ascending: false },
        limit: 100,
      });
      return data ?? [];
    },
    staleTime: 30 * 1000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
  });

  const { data: sightingHealth, isLoading: sightingsLoading } = useVerkadaSightingHealth();

  // Real-time: subscribe to new sightings and profile updates via WebSocket
  const handleSighting = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['verkada-sighting-health'] });
    setLastUpdated(new Date());
  }, [queryClient]);

  const handleProfileUpdate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['poi-profiles'] });
    setLastUpdated(new Date());
  }, [queryClient]);
  useSocketEvent('verkada:sighting', handleSighting);
  useSocketEvent('verkada:profile-update', handleProfileUpdate);

  const isLoading = profilesLoading || sightingsLoading;

  // Build a lookup of all-time last-seen per person from verkada_events (accurate)
  const allTimeLastSeenMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of (sightingHealth?.all_time_by_person ?? [])) {
      map.set(entry.person_key, entry.all_time_last_seen);
      if (entry.label) map.set(entry.label.toLowerCase().trim(), entry.all_time_last_seen);
    }
    return map;
  }, [sightingHealth]);

  // Build per-person stats from sighting-health by_person data, merged with profile thumbnails
  const personStats = useMemo(() => {
    if (!profiles || !sightingHealth) return [];

    // Normalize a key for case-insensitive, whitespace-tolerant comparison
    const normalize = (s: string | null | undefined): string | null => {
      const t = s?.trim();
      return t ? t.toLowerCase() : null;
    };

    // Deduplicate profiles by normalized label
    const seenLabels = new Map<string, PoiProfile>();
    for (const person of profiles) {
      const key = normalize(person.label) ?? person.verkada_person_id;
      const existing = seenLabels.get(key);
      if (!existing) {
        seenLabels.set(key, person);
      } else if (!existing.thumbnail_url && person.thumbnail_url) {
        seenLabels.set(key, { ...existing, thumbnail_url: person.thumbnail_url });
      }
    }
    const deduplicatedProfiles = Array.from(seenLabels.values());

    return deduplicatedProfiles
      .map((person) => {
        const personKey = normalize(person.label) ?? normalize(person.verkada_person_id);
        const healthEntry = sightingHealth.by_person.find((bp) => {
          const bpKey = normalize(bp.label) ?? normalize(bp.verkada_person_id);
          return bpKey === personKey;
        });

        const cameras = healthEntry
          ? healthEntry.cameras.map((name) => ({ name }))
          : [];

        const lastSightingEntry = sightingHealth.recent_sightings.find((rs) => {
          const rsKey = normalize(rs.label) ?? normalize(rs.verkada_person_id);
          return rsKey === personKey;
        });

        // All-time last seen: prefer data from verkada_events (accurate) over poi_profiles (can lag)
        const allTimeLastSeen =
          (personKey ? allTimeLastSeenMap.get(personKey) : null) ??
          person.last_seen_at;

        return {
          ...person,
          todayCount: healthEntry?.sighting_count ?? 0,
          cameras,
          lastSighting: lastSightingEntry
            ? { camera_name: lastSightingEntry.camera_name, seen_at: lastSightingEntry.seen_at }
            : null,
          allTimeLastSeen,
        };
      })
      .sort((a, b) => {
        if (a.todayCount > 0 && b.todayCount === 0) return -1;
        if (a.todayCount === 0 && b.todayCount > 0) return 1;
        if (a.todayCount !== b.todayCount) return b.todayCount - a.todayCount;
        const aTime = a.allTimeLastSeen ? new Date(a.allTimeLastSeen).getTime() : 0;
        const bTime = b.allTimeLastSeen ? new Date(b.allTimeLastSeen).getTime() : 0;
        return bTime - aTime;
      });
  }, [profiles, sightingHealth, allTimeLastSeenMap]);

  const uniquePeopleToday = sightingHealth?.unique_people_today ?? 0;
  const totalSightingsToday = sightingHealth?.total_sightings_today ?? 0;
  const camerasActiveToday = sightingHealth?.by_camera.length ?? 0;
  const totalCameras = sightingHealth?.total_cameras ?? null;
  const noSightingsToday = totalSightingsToday === 0 && !isLoading;

  // Feed freshness derived from last_webhook_at
  const lastWebhookAt = sightingHealth?.last_webhook_at
    ? new Date(sightingHealth.last_webhook_at)
    : null;
  const minutesSinceWebhook = sightingHealth?.minutes_since_last_webhook ?? null;

  // Last any sighting today (from recent_sightings)
  const lastSightingToday = sightingHealth?.recent_sightings?.[0]?.seen_at
    ? new Date(sightingHealth.recent_sightings[0].seen_at)
    : null;

  // Feed health: stale if no webhook in 4+ hours during daytime (8am–10pm PT)
  const nowHour = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(new Date())
  );
  const isDaytime = nowHour >= 8 && nowHour < 22;
  const feedIsStale = isDaytime && minutesSinceWebhook !== null && minutesSinceWebhook > 240;

  const recentSightings = sightingHealth?.recent_sightings ?? [];
  const timelineLimit = timelineExpanded ? 50 : 15;

  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            People Tracker
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {format(lastUpdated, 'h:mm a')}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={handleRefresh}
              disabled={isRefreshing}
              title="Refresh data"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Badge variant="outline" className="text-xs">
              {format(now, 'MMM d, yyyy')}
            </Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Face-recognized persons of interest across all cameras
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-32 rounded-lg" />
          </div>
        ) : profiles && profiles.length === 0 ? (
          <div className="text-center py-6 space-y-2">
            <Users className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              No Persons of Interest configured yet.
            </p>
            <p className="text-xs text-muted-foreground">
              Tag family members in Verkada Command to start tracking.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Summary stats — always labeled "Today" so zeros read as quiet, not broken */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground">{uniquePeopleToday}</span>
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  People
                </span>
                <span className="text-[9px] text-muted-foreground/70">today</span>
              </div>
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground">{totalSightingsToday}</span>
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  Sightings
                </span>
                <span className="text-[9px] text-muted-foreground/70">today</span>
              </div>
              {/* Cameras card: show active-today / total so "0" never reads as "no cameras" */}
              <div className="rounded-xl bg-primary/5 border border-primary/10 p-3 flex flex-col items-center gap-0.5">
                <span className="text-2xl font-bold text-foreground">
                  {totalCameras !== null
                    ? `${camerasActiveToday}/${totalCameras}`
                    : camerasActiveToday}
                </span>
                <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
                  Cameras
                </span>
                <span className="text-[9px] text-muted-foreground/70">
                  {totalCameras !== null ? 'active today' : 'active today'}
                </span>
              </div>
            </div>

            {/* Feed freshness indicator */}
            <div className={`flex items-center gap-1.5 px-1 text-xs ${feedIsStale ? 'text-amber-500' : 'text-muted-foreground'}`}>
              {feedIsStale
                ? <WifiOff className="h-3 w-3 shrink-0" />
                : <Wifi className="h-3 w-3 shrink-0" />}
              {lastSightingToday ? (
                <span>
                  Last sighting today at {format(lastSightingToday, 'h:mm a')}
                  {lastWebhookAt && (
                    <span className="text-muted-foreground/60">
                      {' '}· feed {formatDistanceToNow(lastWebhookAt, { addSuffix: true })}
                    </span>
                  )}
                </span>
              ) : lastWebhookAt ? (
                <span>
                  Feed last active {formatDistanceToNow(lastWebhookAt, { addSuffix: true })}
                  {feedIsStale && ' — may be stale'}
                </span>
              ) : (
                <span className="text-muted-foreground/60">Feed status unknown</span>
              )}
            </div>

            {/* No-sightings-today empty state — shows when all zeros but profiles exist */}
            {noSightingsToday && (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 py-4 px-3 text-center">
                <p className="text-sm text-muted-foreground font-medium">No sightings yet today</p>
                <p className="text-xs text-muted-foreground/70 mt-0.5">
                  {feedIsStale
                    ? 'The feed may be inactive — check the freshness indicator above.'
                    : 'All tagged people will appear here when detected.'}
                </p>
              </div>
            )}

            {/* POI Profiles with per-person camera breakdown */}
            {personStats.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium px-1">
                  Tagged People
                </p>
                <div className="space-y-1.5">
                  {personStats.map((person) => (
                    <Collapsible key={person.id}>
                      <CollapsibleTrigger className="w-full">
                        <div className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
                          <Avatar className="h-9 w-9">
                            {person.thumbnail_url ? (
                              <AvatarImage src={person.thumbnail_url} alt={person.label || 'Unknown'} />
                            ) : null}
                            <AvatarFallback className="text-xs">
                              {(person.label || '?').slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0 text-left">
                            <p className="text-sm font-medium truncate">
                              {person.label || 'Unknown Person'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {person.lastSighting
                                ? `Last: ${person.lastSighting.camera_name || 'Unknown'} at ${format(new Date(person.lastSighting.seen_at), 'h:mm a')}`
                                : person.allTimeLastSeen
                                ? `Last seen ${formatDistanceToNow(new Date(person.allTimeLastSeen), { addSuffix: true })}`
                                : 'Never seen'}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Badge variant={person.todayCount > 0 ? "default" : "outline"} className="text-xs">
                              {person.todayCount} today
                            </Badge>
                            {person.cameras.length > 0 && (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </div>
                        </div>
                      </CollapsibleTrigger>
                      {person.cameras.length > 0 && (
                        <CollapsibleContent>
                          <div className="ml-12 mt-1 mb-2 space-y-0.5">
                            {person.cameras.map((cam) => (
                              <div key={cam.name} className="flex items-center gap-2 text-xs text-muted-foreground px-2 py-0.5">
                                <Camera className="h-3 w-3 shrink-0" />
                                <span className="truncate">{cam.name}</span>
                              </div>
                            ))}
                          </div>
                        </CollapsibleContent>
                      )}
                    </Collapsible>
                  ))}
                </div>
              </div>
            )}

            {/* Today's Timeline — expanded view */}
            {recentSightings.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium flex items-center gap-1.5 px-1">
                  <Clock className="h-3.5 w-3.5" />
                  Today's Timeline ({totalSightingsToday} sightings)
                </p>
                <div className="space-y-0.5">
                  {recentSightings.slice(0, timelineLimit).map((sighting, idx) => (
                    <div
                      key={`${sighting.verkada_person_id}-${sighting.seen_at}-${idx}`}
                      className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded hover:bg-muted/20"
                    >
                      <ArrowDownToLine className="h-3 w-3 text-primary shrink-0" />
                      <span className="font-medium min-w-[60px]">
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
                  {recentSightings.length > timelineLimit && !timelineExpanded && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full text-xs text-muted-foreground h-7"
                      onClick={() => setTimelineExpanded(true)}
                    >
                      Show {recentSightings.length - timelineLimit} more sightings
                    </Button>
                  )}
                  {timelineExpanded && totalSightingsToday > 50 && (
                    <p className="text-xs text-muted-foreground text-center pt-1">
                      + {totalSightingsToday - 50} more sightings today (showing most recent 50)
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
