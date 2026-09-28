import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, type DbFilter } from '@/lib/apiClient';
import { useUserRole } from '@/hooks/useUserRole';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import {
  Trophy, Flag, Music2, Theater, RefreshCw, ExternalLink,
  MapPin, Calendar, Clock, Tv, Activity, Loader2, TrendingUp
} from 'lucide-react';
import { format, parseISO, isToday, subHours, isFuture, addDays } from 'date-fns';
import { toast } from '@/hooks/use-toast';

type EntCategory = 'lakers' | 'f1' | 'concert' | 'shows';

const CATEGORIES: { id: EntCategory; label: string; icon: React.ElementType; emoji: string }[] = [
  { id: 'lakers', label: 'Lakers', icon: Trophy, emoji: '🏀' },
  { id: 'f1', label: 'Formula 1', icon: Flag, emoji: '🏎️' },
  { id: 'concert', label: 'Concerts', icon: Music2, emoji: '🎤' },
  { id: 'shows', label: 'Live Shows', icon: Theater, emoji: '🎭' },
];

interface EntertainmentEvent {
  id: string;
  category: string;
  title: string;
  venue: string | null;
  event_date: string;
  event_end: string | null;
  location: string | null;
  ticket_url: string | null;
  image_url: string | null;
  metadata: Record<string, unknown> | null;
  season_year: number | null;
  source: string;
  updated_at: string;
}

interface F1Session { name: string; date: string; time: string; }

function fmtDate(d: string) {
  try { return format(parseISO(d), 'EEE, MMM d · h:mm a'); } catch { return d; }
}

function fmtSessionDate(date: string, time: string) {
  try {
    const dt = parseISO(`${date}T${time}`);
    return format(dt, 'EEE, MMM d · h:mm a') + ' (local)';
  } catch { return `${date} ${time}`; }
}

// ─── F1 Detail Sheet ─────────────────────────────────────────────────────────

function F1DetailSheet({ event, open, onClose }: { event: EntertainmentEvent; open: boolean; onClose: () => void }) {
  const meta = event.metadata as { flag?: string; circuit?: string; country?: string; sessions?: F1Session[] } | null;
  const sessions: F1Session[] = meta?.sessions || [];

  const sessionColors: Record<string, string> = {
    'Practice 1': 'bg-muted text-muted-foreground',
    'Practice 2': 'bg-muted text-muted-foreground',
    'Practice 3': 'bg-muted text-muted-foreground',
    'Sprint Qualifying': 'bg-amber-500/10 text-amber-600 border-amber-500/30',
    'Sprint Race': 'bg-orange-500/10 text-orange-600 border-orange-500/30',
    'Qualifying': 'bg-primary/10 text-primary border-primary/30',
    'Race': 'bg-destructive/10 text-destructive border-destructive/30',
  };

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[80vh] rounded-t-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-3">
            <span className="text-4xl">{meta?.flag || '🏁'}</span>
            <div>
              <SheetTitle className="font-display">{event.title}</SheetTitle>
              {meta?.circuit && <p className="text-sm text-muted-foreground">{meta.circuit}</p>}
              {event.location && (
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <MapPin className="h-3 w-3" />{event.location}
                </p>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Race Weekend Schedule</h3>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Schedule not available. Re-sync to get full weekend data.</p>
          ) : (
            <div className="space-y-2">
              {sessions.map((session, i) => {
                const colorClass = sessionColors[session.name] || 'bg-muted text-muted-foreground';
                let sessionDt: Date | null = null;
                try { sessionDt = parseISO(`${session.date}T${session.time}`); } catch { /* ok */ }
                const isPast = sessionDt ? sessionDt < new Date() : false;

                return (
                  <div key={i} className={cn(
                    'flex items-center justify-between rounded-xl px-4 py-3 border',
                    colorClass,
                    isPast && 'opacity-50'
                  )}>
                    <div>
                      <p className="font-semibold text-sm">{session.name}</p>
                      <p className="text-xs mt-0.5 opacity-80">{fmtSessionDate(session.date, session.time)}</p>
                    </div>
                    {session.name === 'Race' && <span className="text-lg">🏆</span>}
                    {session.name.includes('Sprint') && <span className="text-lg">⚡</span>}
                    {session.name.includes('Qualifying') && !session.name.includes('Sprint') && <span className="text-lg">⏱️</span>}
                    {session.name.includes('Practice') && <span className="text-lg">🔧</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Lakers Detail Sheet ──────────────────────────────────────────────────────

function LakersDetailSheet({ event, open, onClose }: { event: EntertainmentEvent; open: boolean; onClose: () => void }) {
  const meta = event.metadata as { homeAway?: string; opponent?: string; opponentTricode?: string; gameId?: string; broadcastChannels?: string[] } | null;
  const gameId = meta?.gameId;
  const isHome = meta?.homeAway === 'home';
  const channels: string[] = meta?.broadcastChannels || ['Spectrum SportsNet'];
  const opponent = meta?.opponent || 'Opponent';

  const gameDate = parseISO(event.event_date);
  const isLive = isToday(gameDate) && new Date() > subHours(gameDate, 1);
  const isUpcoming = isFuture(gameDate) && !isLive;
  const isWithin7Days = isUpcoming && gameDate <= addDays(new Date(), 7);

  const { data: liveData, isLoading: liveLoading } = useQuery({
    queryKey: ['nba-live', gameId, isLive],
    queryFn: async () => {
      if (!isLive) return null;
      return await apiClient.invokeFn<{ data?: { scoreboard?: { games?: Array<{ gameId: string; homeTeam?: { tricode: string; score: number }; awayTeam?: { tricode: string; score: number }; period: number; gameClock?: string }> } } }>('nba-game-proxy', { action: 'live-scoreboard' });
    },
    enabled: !!isLive,
    refetchInterval: isLive ? 30000 : false,
  });

  const { data: gameDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['nba-game-detail', gameId],
    queryFn: async () => {
      if (!gameId) return null;
      return await apiClient.invokeFn<{ boxscore?: { homeTeam?: { teamTricode: string; teamName: string; players?: unknown[] }; awayTeam?: { teamTricode: string; teamName: string; players?: unknown[] } } }>('nba-game-proxy', { action: 'game-detail', gameId });
    },
    enabled: !!gameId && isLive,
  });

  // Win probability — fetch via Firecrawl search for upcoming games within 7 days
  const { data: winProbData, isLoading: winProbLoading } = useQuery({
    queryKey: ['lakers-win-prob', event.id, opponent, format(gameDate, 'yyyy-MM-dd')],
    queryFn: async () => {
      const data = await apiClient.invokeFn<{ data?: Array<{ title?: string; description?: string; url?: string }> }>('firecrawl-search', {
        query: `Lakers vs ${opponent} prediction win probability ${format(gameDate, 'MMMM d yyyy')} NBA`,
        options: { limit: 5 },
      });
      // Parse win probability from search results
      const results = data?.data || [];
      const allText = results.map((r: { title?: string; description?: string }) =>
        `${r.title || ''} ${r.description || ''}`
      ).join(' ');
      // Extract percentage for Lakers
      const lakersMatch = allText.match(/lakers[^.%]*?(\d{1,3})%/i) ||
        allText.match(/(\d{1,3})%[^.]*?lakers/i) ||
        allText.match(/los angeles lakers[^.%]*?(\d{1,3})%/i);
      const pct = lakersMatch ? parseInt(lakersMatch[1]) : null;
      return { probability: pct, source: results[0]?.url || null };
    },
    enabled: open && isWithin7Days,
    staleTime: 1000 * 60 * 60 * 4, // Cache 4 hours
  });

  // Find this game in live scoreboard
  const liveGame = liveData?.data?.scoreboard?.games?.find(
    (g: { gameId: string }) => g.gameId === gameId
  );

  const boxscore = gameDetail?.boxscore;
  const lakersTeam = boxscore?.homeTeam?.teamTricode === 'LAL' ? boxscore?.homeTeam : boxscore?.awayTeam;
  const opponentTeam = boxscore?.homeTeam?.teamTricode === 'LAL' ? boxscore?.awayTeam : boxscore?.homeTeam;

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-display">{event.title}</SheetTitle>
          <div className="flex items-center gap-2 flex-wrap mt-1">
            <Badge variant={isHome ? 'default' : 'outline'} className="text-xs">
              {isHome ? '🏠 Home' : '✈️ Away'}
            </Badge>
            {isLive && (
              <Badge className="text-xs bg-destructive text-destructive-foreground animate-pulse">
                🔴 LIVE
              </Badge>
            )}
          </div>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {/* Game info */}
          <div className="space-y-2">
            {event.venue && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MapPin className="h-4 w-4 shrink-0" />{event.venue}
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4 shrink-0" />{fmtDate(event.event_date)}
            </div>
          </div>

          {/* Win probability — upcoming games within 7 days */}
          {isWithin7Days && (
            <div className="rounded-xl bg-muted/40 p-4">
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp className="h-4 w-4 text-primary" />
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Win Probability</p>
              </div>
              {winProbLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />Fetching prediction…
                </div>
              ) : winProbData?.probability != null ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-primary">Lakers</span>
                    <span className="text-sm font-bold">{winProbData.probability}%</span>
                  </div>
                  <Progress value={winProbData.probability} className="h-2" />
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Lakers win</span>
                    <span>{100 - winProbData.probability}% {opponent.split(' ').pop()} win</span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Prediction not available yet — check back closer to game time.</p>
              )}
            </div>
          )}

          {/* Live score */}
          {isLive && (
            <div className="rounded-xl bg-muted/40 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">Live Score</p>
              {liveLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />Fetching live score…
                </div>
              ) : liveGame ? (
                <div className="flex items-center justify-between">
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground">LAL</p>
                    <p className="text-4xl font-bold">{liveGame.homeTeam?.tricode === 'LAL' ? liveGame.homeTeam?.score : liveGame.awayTeam?.score}</p>
                  </div>
                  <div className="text-center px-4">
                    <p className="text-xs text-muted-foreground">
                      {liveGame.period > 0 ? `Q${liveGame.period}` : 'Pre-Game'}
                      {liveGame.gameClock && ` · ${liveGame.gameClock}`}
                    </p>
                    <Activity className="h-5 w-5 mx-auto mt-1 text-primary animate-pulse" />
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground">{meta?.opponentTricode || 'OPP'}</p>
                    <p className="text-4xl font-bold">{liveGame.homeTeam?.tricode === 'LAL' ? liveGame.awayTeam?.score : liveGame.homeTeam?.score}</p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Score not available yet</p>
              )}
            </div>
          )}

          {/* Starting lineups */}
          {isLive && gameId && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Starting Lineups</p>
              {detailLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />Loading lineups…
                </div>
              ) : lakersTeam?.players ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs font-semibold mb-1.5">Lakers Starters</p>
                    <div className="space-y-1">
                      {(lakersTeam.players as Array<{ name: string; position: string; oncourt: boolean; starter: string }>)
                        .filter(p => p.starter === '1')
                        .map((p, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="text-muted-foreground w-4">{p.position}</span>
                            <span>{p.name}</span>
                            {p.oncourt && <span className="text-[10px] text-primary">●</span>}
                          </div>
                        ))}
                    </div>
                  </div>
                  {opponentTeam?.players && (
                    <div>
                      <p className="text-xs font-semibold mb-1.5">{opponentTeam.teamName} Starters</p>
                      <div className="space-y-1">
                        {(opponentTeam.players as Array<{ name: string; position: string; oncourt: boolean; starter: string }>)
                          .filter(p => p.starter === '1')
                          .map((p, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs">
                              <span className="text-muted-foreground w-4">{p.position}</span>
                              <span>{p.name}</span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Lineup data available closer to game time</p>
              )}
            </div>
          )}

          {/* Broadcast */}
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
              <Tv className="h-3.5 w-3.5 inline mr-1" />Watch In LA
            </p>
            <div className="flex flex-wrap gap-2">
              {channels.map(ch => (
                <Badge key={ch} variant="outline" className="text-xs">{ch}</Badge>
              ))}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Show Detail Sheet (Broadway / Comedy / Kids) ─────────────────────────────

function ShowDetailSheet({ event, open, onClose }: { event: EntertainmentEvent; open: boolean; onClose: () => void }) {
  const meta = event.metadata as { price_range?: string; age_recommendation?: string; kids?: boolean } | null;

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[75vh] rounded-t-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex items-start gap-3">
            <span className="text-3xl">🎭</span>
            <div>
              <SheetTitle className="font-display">{event.title}</SheetTitle>
              {meta?.kids && (
                <Badge className="text-[10px] mt-1 bg-primary/20 text-primary border-primary/30">👧 Kids Show</Badge>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="mt-5 space-y-4">
          {/* Venue & Dates */}
          <div className="space-y-2">
            {event.venue && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MapPin className="h-4 w-4 shrink-0" />{event.venue}
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4 shrink-0" />
              {event.event_date ? (
                <>
                  {format(parseISO(event.event_date), 'MMM d, yyyy')}
                  {event.event_end && ` – ${format(parseISO(event.event_end), 'MMM d, yyyy')}`}
                </>
              ) : 'Dates TBD'}
            </div>
          </div>

          {/* Price range */}
          {meta?.price_range && (
            <div className="rounded-xl bg-muted/40 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Price Range</p>
              <p className="text-sm font-semibold">{meta.price_range}</p>
            </div>
          )}

          {/* Age recommendation */}
          {meta?.age_recommendation && (
            <div className="rounded-xl bg-muted/40 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">Age Recommendation</p>
              <p className="text-sm">{meta.age_recommendation}</p>
            </div>
          )}

          {/* Ticket links */}
          {event.ticket_url && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Get Tickets</p>
              <a href={event.ticket_url} target="_blank" rel="noopener noreferrer" className="block">
                <Button className="w-full gap-2">
                  <ExternalLink className="h-4 w-4" />
                  Buy Tickets
                </Button>
              </a>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Card Components ──────────────────────────────────────────────────────────

function LakersCard({ event, onClick }: { event: EntertainmentEvent; onClick: () => void }) {
  const meta = event.metadata as Record<string, string> | null;
  const isHome = meta?.homeAway === 'home';
  const gameDate = parseISO(event.event_date);
  const isLive = isToday(gameDate);

  return (
    <Card className="glass hover:shadow-md transition-shadow cursor-pointer" onClick={onClick}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-semibold text-sm leading-tight">{event.title}</p>
              {isLive && (
                <span className="text-[10px] font-bold text-destructive animate-pulse">LIVE</span>
              )}
            </div>
            {event.venue && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />{event.venue}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Calendar className="h-3 w-3 shrink-0" />{fmtDate(event.event_date)}
            </p>
          </div>
          <Badge variant={isHome ? 'default' : 'outline'} className="shrink-0 text-[10px]">
            {isHome ? 'Home' : 'Away'}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function F1Card({ event, onClick }: { event: EntertainmentEvent; onClick: () => void }) {
  const meta = event.metadata as Record<string, string> | null;
  const sessions: F1Session[] = (event.metadata as { sessions?: F1Session[] })?.sessions || [];

  return (
    <Card className="glass hover:shadow-md transition-shadow cursor-pointer" onClick={onClick}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <span className="text-2xl shrink-0">{meta?.flag || '🏁'}</span>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight">{event.title}</p>
            {meta?.circuit && <p className="text-xs text-muted-foreground">{meta.circuit}</p>}
            {event.location && (
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <MapPin className="h-3 w-3 shrink-0" />{event.location}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Calendar className="h-3 w-3 shrink-0" />
              {sessions.length > 0
                ? `${format(parseISO(sessions[0].date), 'MMM d')} – ${format(parseISO(event.event_end || event.event_date), 'MMM d')}`
                : fmtDate(event.event_date)}
            </p>
            {sessions.length > 0 && (
              <p className="text-[10px] text-muted-foreground/60 mt-0.5">{sessions.length} sessions · tap for schedule</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConcertCard({ event }: { event: EntertainmentEvent }) {
  return (
    <Card className="glass hover:shadow-md transition-shadow overflow-hidden">
      {event.image_url && (
        <div className="w-full h-32 overflow-hidden">
          <img
            src={event.image_url}
            alt={event.title}
            className="w-full h-full object-cover"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        </div>
      )}
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-tight">{event.title}</p>
            {event.venue && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />{event.venue}
              </p>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Calendar className="h-3 w-3 shrink-0" />{fmtDate(event.event_date)}
            </p>
          </div>
          {event.ticket_url && (
            <a href={event.ticket_url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
              <Button size="sm" variant="outline" className="shrink-0 text-xs h-7 gap-1">
                <ExternalLink className="h-3 w-3" />Tickets
              </Button>
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ShowCard({ event, onClick }: { event: EntertainmentEvent; onClick: () => void }) {
  const meta = event.metadata as { price_range?: string; kids?: boolean } | null;

  return (
    <Card className="glass hover:shadow-md transition-shadow cursor-pointer" onClick={onClick}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-sm leading-tight">{event.title}</p>
              {meta?.kids && <span className="text-[10px] text-primary font-medium">👧 Kids</span>}
            </div>
            {event.venue && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />{event.venue}
              </p>
            )}
            {event.event_date && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <Clock className="h-3 w-3 shrink-0" />
                {format(parseISO(event.event_date), 'MMM d')}
                {event.event_end && ` – ${format(parseISO(event.event_end), 'MMM d, yyyy')}`}
              </p>
            )}
            {meta?.price_range && (
              <p className="text-xs text-primary mt-0.5">{meta.price_range}</p>
            )}
          </div>
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Section ─────────────────────────────────────────────────────────────

export function EntertainmentSection() {
  const [activeCategory, setActiveCategory] = useState<EntCategory>('lakers');
  const [syncing, setSyncing] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<EntertainmentEvent | null>(null);
  const { isAdmin } = useUserRole();
  const queryClientHook = useQueryClient();

  // Query using 'shows' for the new category, but also include 'broadway' for backward compat
  const queryCategory = activeCategory === 'shows' ? 'shows' : activeCategory;

  const { data: events, isLoading, isError, dataUpdatedAt, refetch } = useQuery({
    queryKey: ['entertainment_events', queryCategory],
    queryFn: async () => {
      const filters: DbFilter[] = [
        { column: 'event_date', op: 'gte', value: new Date().toISOString() },
      ];
      if (activeCategory === 'shows') {
        filters.push({ column: 'category', op: 'in', value: ['shows', 'broadway'] });
      } else {
        filters.push({ column: 'category', op: 'eq', value: queryCategory });
      }
      const { data } = await apiClient.dbQuery<EntertainmentEvent[]>({
        table: 'entertainment_events',
        select: '*',
        filters,
        order: { column: 'event_date', ascending: true },
        limit: 50,
      });
      return data ?? [];
    },
    staleTime: 5 * 60_000, // 5 min — events don't change often
    throwOnError: false,
  });

  async function handleSync() {
    setSyncing(true);
    try {
      const actionMap: Record<EntCategory, string> = {
        lakers: 'lakers', f1: 'f1', concert: 'concerts', shows: 'broadway',
      };
      const syncResult = await apiClient.invokeFn<{ success: boolean; results: Record<string, { synced?: number; error?: string; note?: string }> }>('entertainment-sync', { action: actionMap[activeCategory] });
      await queryClientHook.invalidateQueries({ queryKey: ['entertainment_events'] });

      // Check for per-category errors in the response
      const catErrors = Object.entries(syncResult?.results || {})
        .filter(([, r]) => r?.error)
        .map(([cat, r]) => `${cat}: ${r.error}`)
        .join('; ');

      if (catErrors) {
        toast({ title: 'Sync completed with errors', description: catErrors, variant: 'destructive' });
      } else {
        toast({ title: 'Sync complete!' });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Sync failed';
      toast({ title: 'Error', description: msg, variant: 'destructive' });
    } finally {
      setSyncing(false);
    }
  }

  const catConfig = CATEGORIES.find(c => c.id === activeCategory)!;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xl">{catConfig.emoji}</span>
          <h2 className="text-xl font-display font-semibold">Live Entertainment</h2>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            {dataUpdatedAt > 0 && (
              <span className="text-xs text-muted-foreground">
                Synced {format(new Date(dataUpdatedAt), 'h:mm a')}
              </span>
            )}
            <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing} className="gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
              {syncing ? 'Syncing…' : 'Sync'}
            </Button>
          </div>
        )}
      </div>

      {/* Category pills */}
      <div className="flex gap-1.5 overflow-x-auto scrollbar-none">
        {CATEGORIES.map(({ id, label, emoji }) => (
          <button
            key={id}
            onClick={() => setActiveCategory(id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-all shrink-0',
              activeCategory === id
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'border border-border text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
          >
            <span>{emoji}</span>{label}
          </button>
        ))}
      </div>

      {/* Events list */}
      {isLoading ? (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
        </div>
      ) : isError ? (
        <Card className="glass border-destructive/30">
          <CardContent className="py-8 text-center space-y-3">
            <span className="text-2xl block">⚠️</span>
            <p className="text-sm text-muted-foreground">Couldn't load {catConfig.label} events.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />Try again
            </Button>
          </CardContent>
        </Card>
      ) : events && events.length > 0 ? (
        <div className="space-y-2">
          {events.map(event => {
            if (activeCategory === 'lakers') return (
              <LakersCard key={event.id} event={event} onClick={() => setSelectedEvent(event)} />
            );
            if (activeCategory === 'f1') return (
              <F1Card key={event.id} event={event} onClick={() => setSelectedEvent(event)} />
            );
            if (activeCategory === 'concert') return <ConcertCard key={event.id} event={event} />;
            return <ShowCard key={event.id} event={event} onClick={() => setSelectedEvent(event)} />;
          })}
        </div>
      ) : (
        <Card className="glass">
          <CardContent className="py-12 text-center">
            <span className="text-4xl mb-3 block">{catConfig.emoji}</span>
            <p className="text-muted-foreground text-sm">No upcoming events found.</p>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing} className="mt-4 gap-1.5">
                <RefreshCw className={cn('h-3.5 w-3.5', syncing && 'animate-spin')} />
                Sync Now
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Detail Sheets */}
      {selectedEvent && activeCategory === 'f1' && (
        <F1DetailSheet event={selectedEvent} open={!!selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
      {selectedEvent && activeCategory === 'lakers' && (
        <LakersDetailSheet event={selectedEvent} open={!!selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
      {selectedEvent && activeCategory === 'shows' && (
        <ShowDetailSheet event={selectedEvent} open={!!selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </div>
  );
}
