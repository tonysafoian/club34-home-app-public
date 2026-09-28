import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Star, Film, ExternalLink, MapPin, Loader2, Ticket, Trophy, Search, Sparkles } from 'lucide-react';
import { format, parseISO, isValid } from 'date-fns';
import React from 'react';

function safeFormatDate(dateStr: string | null | undefined, fmt: string): string | null {
  if (!dateStr) return null;
  try {
    const d = parseISO(dateStr);
    if (!isValid(d)) return null;
    return format(d, fmt);
  } catch {
    return null;
  }
}

function safeToFixed(value: number | null | undefined, decimals: number): string | null {
  if (value == null || !isFinite(value)) return null;
  try {
    return value.toFixed(decimals);
  } catch {
    return null;
  }
}


type MovieTab = 'theater' | 'streaming' | 'discover';
type StreamingFilter = 'streaming_movie' | 'streaming_show' | 'kids';

interface MediaItem {
  id: string;
  category: string;
  title: string;
  description: string | null;
  release_date: string | null;
  streaming_platform: string | null;
  poster_url: string | null;
  rating: string | null;
  score: number | null;
  rank: number | null;
  metadata: Record<string, unknown> | null;
  source: string;
  updated_at: string;
}

interface Showtime {
  theater: string;
  url: string;
  description: string;
  times?: string[];
}

const PLATFORM_COLORS: Record<string, string> = {
  Netflix: 'bg-destructive text-destructive-foreground',
  'Apple TV+': 'bg-foreground text-background',
  Hulu: 'bg-primary/80 text-primary-foreground',
  'Disney+': 'bg-secondary text-secondary-foreground',
  'Max': 'bg-accent text-accent-foreground',
  'Amazon Prime': 'bg-primary text-primary-foreground',
  'Peacock': 'bg-muted text-foreground border border-border',
  'Paramount+': 'bg-blue-500 text-white',
};

// ─── Score helpers ─────────────────────────────────────────────────────────────

function getRtScore(meta: Record<string, unknown> | null): number | null {
  if (!meta) return null;
  const v = meta.rt_score;
  if (v == null) return null;
  return typeof v === 'string' ? parseInt(v) : (v as number);
}

function getImdbRating(meta: Record<string, unknown> | null): number | null {
  if (!meta) return null;
  const v = meta.imdb_rating;
  if (v == null) return null;
  return typeof v === 'string' ? parseFloat(v) : (v as number);
}

// ─── Multi-Source Score Strip ──────────────────────────────────────────────────

function ScoreStrip({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta) return null;

  const rtScore = getRtScore(meta);
  const rtAudience = meta.rt_audience != null
    ? (typeof meta.rt_audience === 'string' ? parseInt(meta.rt_audience as string) : meta.rt_audience as number)
    : null;
  const imdbRating = getImdbRating(meta);
  const metacritic = meta.metacritic != null
    ? (typeof meta.metacritic === 'string' ? parseInt(meta.metacritic as string) : meta.metacritic as number)
    : null;
  const letterboxd = meta.letterboxd != null
    ? (typeof meta.letterboxd === 'string' ? parseFloat(meta.letterboxd as string) : meta.letterboxd as number)
    : null;

  const hasSomeScore = rtScore != null || rtAudience != null || imdbRating != null || metacritic != null || letterboxd != null;
  if (!hasSomeScore) return null;

    const isFresh = (rt: number) => rt >= 60;

  return (
    <div className="flex flex-wrap gap-2 mt-3">
      {rtScore != null && (
        <div className={cn(
          'flex flex-col items-center min-w-[48px] rounded-lg px-2.5 py-1.5',
          isFresh(rtScore) ? 'bg-primary/10' : 'bg-destructive/10'
        )}>
          <span className="text-sm font-bold leading-none">
            {isFresh(rtScore) ? '🍅' : '🤢'} {rtScore}%
          </span>
          <span className="text-[9px] text-muted-foreground mt-0.5">Tomatometer</span>
        </div>
      )}
      {rtAudience != null && (
        <div className="flex flex-col items-center min-w-[48px] bg-muted/60 rounded-lg px-2.5 py-1.5">
          <span className="text-sm font-bold leading-none">👥 {rtAudience}%</span>
          <span className="text-[9px] text-muted-foreground mt-0.5">Audience</span>
        </div>
      )}
      {imdbRating != null && (
        <div className="flex flex-col items-center min-w-[48px] bg-secondary/40 rounded-lg px-2.5 py-1.5">
          <span className="text-sm font-bold leading-none">⭐ {safeToFixed(imdbRating, 1)}</span>
          <span className="text-[9px] text-muted-foreground mt-0.5">IMDb</span>
        </div>
      )}
      {metacritic != null && (
        <div className={cn(
          'flex flex-col items-center min-w-[48px] rounded-lg px-2.5 py-1.5',
          metacritic >= 61 ? 'bg-primary/10' : metacritic >= 40 ? 'bg-secondary/40' : 'bg-destructive/10'
        )}>
          <span className="text-sm font-bold leading-none">🎬 {metacritic}</span>
          <span className="text-[9px] text-muted-foreground mt-0.5">Metacritic</span>
        </div>
      )}
      {letterboxd != null && (
        <div className="flex flex-col items-center min-w-[48px] bg-muted/60 rounded-lg px-2.5 py-1.5">
          <span className="text-sm font-bold leading-none">🔤 {safeToFixed(letterboxd, 1)}</span>
          <span className="text-[9px] text-muted-foreground mt-0.5">Letterboxd</span>
        </div>
      )}
    </div>
  );
}

// ─── Movie Detail Sheet (Showtimes) ───────────────────────────────────────────

function MovieDetailSheet({ item, open, onClose }: { item: MediaItem; open: boolean; onClose: () => void }) {
  const meta = (item.metadata as Record<string, unknown>) || {};

  const { data: showtimesData, isLoading } = useQuery({
    queryKey: ['showtimes', item.title],
    queryFn: async () => {
      return await apiClient.invokeFn<{ showtimes?: Showtime[] }>('showtimes-proxy', { movieTitle: item.title });
    },
    enabled: open && item.category === 'theater',
    staleTime: 1000 * 60 * 30,
    throwOnError: false,
  });

  const showtimes: Showtime[] = showtimesData?.showtimes || [];

  // Parse metadata fields — use typeof guards to avoid crashes on non-string truthy values
  const runtime = typeof meta.runtime === 'string' ? meta.runtime : null;
  const director = typeof meta.director === 'string' ? meta.director : null;
  const actors = typeof meta.actors === 'string' ? meta.actors : null;
  const genres = typeof meta.genres === 'string' ? meta.genres : null;
  const awards = typeof meta.awards === 'string' ? meta.awards : null;
  const imdbId = typeof meta.imdb_id === 'string' ? meta.imdb_id : null;
  const commonSenseAge = typeof meta.common_sense_age === 'number' ? meta.common_sense_age : null;
  const isKids = meta.kids === true;

  const genreList = genres ? genres.split(', ').filter(Boolean) : [];
  const showAwards = awards && awards !== 'N/A' && awards.trim() !== '';

  return (
    <Sheet open={open} onOpenChange={onClose}>
      <SheetContent side="bottom" className="h-[88vh] rounded-t-2xl overflow-y-auto">
        <SheetHeader>
          <div className="flex gap-4">
            {item.poster_url && (
              <img
                src={item.poster_url}
                alt={item.title}
                loading="lazy"
                className="w-20 rounded-xl object-cover shrink-0 aspect-[2/3]"
              />
            )}
            <div className="flex-1 min-w-0">
              <SheetTitle className="font-display text-lg leading-tight">{item.title}</SheetTitle>

              {/* MPAA + Runtime + Year row */}
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {item.rating && (
                  <Badge variant="outline" className="text-[10px] font-semibold">{item.rating}</Badge>
                )}
                {isKids && commonSenseAge != null && (
                  <Badge variant="outline" className="text-[10px]">👶 Ages {commonSenseAge}+</Badge>
                )}
                {runtime && (
                  <span className="text-xs text-muted-foreground">⏱ {runtime}</span>
                )}
                {item.release_date && safeFormatDate(item.release_date, 'yyyy') && (
                  <span className="text-xs text-muted-foreground">
                    {safeFormatDate(item.release_date, 'yyyy')}
                  </span>
                )}
              </div>

              {/* Genre pills */}
              {genreList.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {genreList.slice(0, 4).map(g => (
                    <Badge key={g} variant="outline" className="text-[9px] py-0">{g}</Badge>
                  ))}
                </div>
              )}

              {/* Multi-source score strip */}
              <ScoreStrip meta={item.metadata} />

              {/* Director + Cast */}
              {(director || actors) && (
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                  {director && <span><span className="font-medium">Dir.</span> {director}</span>}
                  {director && actors && <span> · </span>}
                  {actors && <span>{actors}</span>}
                </p>
              )}

              {/* Awards */}
              {showAwards && (
                <div className="mt-2">
                  <Badge className="text-[10px] bg-secondary/60 text-secondary-foreground border-border gap-1">
                    <Trophy className="h-2.5 w-2.5" />
                    {awards}
                  </Badge>
                </div>
              )}

              {/* IMDb link */}
              {imdbId && (
                <a
                  href={`https://www.imdb.com/title/${imdbId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex"
                >
                  <Button size="sm" variant="ghost" className="mt-1.5 h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground">
                    <ExternalLink className="h-3 w-3" />
                    View on IMDb
                  </Button>
                </a>
              )}
            </div>
          </div>
        </SheetHeader>

        {item.description && (
          <p className="text-sm text-muted-foreground mt-4 leading-relaxed line-clamp-4">{item.description}</p>
        )}

        {/* Showtimes — only for theater items */}
        {item.category === 'theater' && (
          <div className="mt-5">
            <div className="flex items-center gap-2 mb-3">
              <Ticket className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Showtimes Near Us</h3>
              <span className="text-xs text-muted-foreground">(Beverly Hills / Brentwood)</span>
            </div>

            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />Searching for showtimes…
              </div>
            ) : showtimes.length === 0 ? (
              <div className="text-sm text-muted-foreground py-4 text-center">
                <Film className="h-8 w-8 mx-auto mb-2 opacity-30" />
                No showtimes found. Check Fandango or AMC directly.
              </div>
            ) : (
              <div className="space-y-3">
                {showtimes.map((st, i) => (
                  <div key={i} className="rounded-xl border border-border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold">{st.theater}</p>
                        {st.times && st.times.length > 0 && (
                          <div className="flex flex-wrap gap-1.5 mt-2">
                            {st.times.map((t, j) => (
                              <span key={j} className="text-xs bg-muted px-2 py-0.5 rounded-full font-medium">{t}</span>
                            ))}
                          </div>
                        )}
                        {!st.times && st.description && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{st.description}</p>
                        )}
                      </div>
                      {st.url && (
                        <a href={st.url} target="_blank" rel="noopener noreferrer">
                          <Button size="sm" variant="outline" className="shrink-0 text-xs h-7 gap-1">
                            <ExternalLink className="h-3 w-3" />Tickets
                          </Button>
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Streaming info */}
        {item.category !== 'theater' && item.streaming_platform && (
          <div className="mt-5 flex items-center gap-2">
            <span className={cn(
              'text-xs font-bold px-2.5 py-1 rounded-lg',
              PLATFORM_COLORS[item.streaming_platform] || 'bg-muted text-muted-foreground'
            )}>
              {item.streaming_platform}
            </span>
            <span className="text-xs text-muted-foreground">Available to stream</span>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ─── Poster Card ──────────────────────────────────────────────────────────────

function PosterCard({ item, onClick }: { item: MediaItem; onClick?: () => void }) {
  const meta = (item.metadata as Record<string, unknown>) || {};
  const rtScore = getRtScore(meta);
  const imdbRating = getImdbRating(meta);
  const isKids = meta.kids as boolean | false;

  // Score badge: prefer RT > IMDb > TMDB score
  const scoreBadge = (() => {
    if (rtScore != null) {
      const fresh = rtScore >= 60;
      return (
        <div className={cn(
          'flex items-center gap-0.5 backdrop-blur rounded-full px-1.5 py-0.5',
          fresh ? 'bg-primary/80' : 'bg-destructive/80'
        )}>
          <span className="text-[10px] font-bold text-primary-foreground">
            {fresh ? '🍅' : '🤢'} {rtScore}%
          </span>
        </div>
      );
    }
    if (imdbRating != null) {
      return (
        <div className="flex items-center gap-0.5 bg-secondary/80 backdrop-blur rounded-full px-1.5 py-0.5">
          <Star className="h-2.5 w-2.5 text-secondary-foreground fill-secondary-foreground" />
          <span className="text-[10px] font-bold text-secondary-foreground">{safeToFixed(imdbRating, 1)}</span>
        </div>
      );
    }
    if (item.score) {
      return (
        <div className="flex items-center gap-0.5 bg-background/80 backdrop-blur rounded-full px-1.5 py-0.5">
          <Star className="h-2.5 w-2.5 text-foreground/60 fill-foreground/60" />
          <span className="text-[10px] font-semibold">{safeToFixed(item.score, 1)}</span>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className={cn("flex-shrink-0 w-36 group", onClick && "cursor-pointer")} onClick={onClick}>
      <div className="relative w-full aspect-[2/3] rounded-xl overflow-hidden bg-muted">
        {item.poster_url ? (
          <img
            src={item.poster_url}
            alt={item.title}
            loading="lazy"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Film className="h-8 w-8 text-muted-foreground/40" />
          </div>
        )}
        {item.rank && (
          <div className="absolute top-2 left-2 w-6 h-6 rounded-full bg-background/80 backdrop-blur flex items-center justify-center text-xs font-bold">
            {item.rank}
          </div>
        )}
        {/* MPAA rating top-right */}
        {item.rating && !isKids && (
          <div className="absolute top-2 right-2 bg-background/75 backdrop-blur rounded px-1 py-0.5 text-[8px] font-bold text-foreground">
            {item.rating}
          </div>
        )}
        {isKids && (
          <div className="absolute top-2 right-2 text-base">👧</div>
        )}
        {/* Score badge bottom-right */}
        {scoreBadge && (
          <div className="absolute bottom-2 right-2">
            {scoreBadge}
          </div>
        )}
      </div>
      <div className="mt-2 space-y-1">
        <p className="text-xs font-semibold leading-tight line-clamp-2">{item.title}</p>
        <div className="flex flex-wrap gap-1">
          {item.streaming_platform && (
            <span className={cn(
              'text-[9px] font-bold px-1.5 py-0.5 rounded',
              PLATFORM_COLORS[item.streaming_platform] || 'bg-muted text-muted-foreground'
            )}>
              {item.streaming_platform}
            </span>
          )}
        </div>
        {item.release_date && safeFormatDate(item.release_date, 'MMM d, yyyy') && (
          <p className="text-[10px] text-muted-foreground">
            {safeFormatDate(item.release_date, 'MMM d, yyyy')}
          </p>
        )}
      </div>
    </div>
  );
}

function ScrollShelf({ items, isLoading, onItemClick }: { items: MediaItem[] | undefined; isLoading: boolean; onItemClick?: (item: MediaItem) => void }) {
  if (isLoading) {
    return (
      <div className="flex gap-3 overflow-x-auto scrollbar-none pb-2">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex-shrink-0 w-36">
            <Skeleton className="w-full aspect-[2/3] rounded-xl" />
            <Skeleton className="h-3 w-3/4 mt-2 rounded" />
            <Skeleton className="h-3 w-1/2 mt-1 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="text-center py-10 text-muted-foreground text-sm">
        <Film className="h-8 w-8 mx-auto mb-2 opacity-40" />
        No items found. Sync to fetch the latest data.
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto scrollbar-none pb-2">
      {items.map(item => (
        <ErrorBoundary key={item.id} fallback={<div className="flex-shrink-0 w-36 aspect-[2/3] rounded-xl bg-muted flex items-center justify-center"><Film className="h-6 w-6 text-muted-foreground/30" /></div>}>
          <PosterCard item={item} onClick={onItemClick ? () => onItemClick(item) : undefined} />
        </ErrorBoundary>
      ))}
    </div>
  );
}

// ─── Discover Panel ──────────────────────────────────────────────────────────

const PRESET_CHIPS = [
  { emoji: '🎭', label: 'Family Night', query: 'family movies everyone will enjoy' },
  { emoji: '🔥', label: 'Action', query: 'high energy action movies' },
  { emoji: '😢', label: 'Emotional', query: 'emotional tearjerker dramas' },
  { emoji: '😂', label: 'Comedy', query: 'laugh out loud comedies' },
  { emoji: '🧠', label: 'Mind-bending', query: 'psychological thrillers and mindbending films' },
  { emoji: '🎃', label: 'Scary', query: 'scary horror movies' },
];

interface DiscoverMovie {
  title: string;
  poster?: string;
  image?: string;
  year?: number | string;
  description?: string;
  rating?: string;
  imdb_rating?: number | string;
  score?: number;
  id?: string;
  imdb_id?: string;
}

function toMediaItem(m: DiscoverMovie, idx: number): MediaItem {
  return {
    id: m.id ?? m.imdb_id ?? `discover-${idx}`,
    category: 'discover',
    title: m.title,
    description: m.description ?? null,
    release_date: m.year ? `${m.year}-01-01` : null,
    streaming_platform: null,
    poster_url: m.poster ?? m.image ?? null,
    rating: m.rating ?? null,
    score: m.score ?? (m.imdb_rating != null ? parseFloat(String(m.imdb_rating)) : null),
    rank: idx + 1,
    metadata: {
      imdb_id: m.imdb_id ?? null,
      imdb_rating: m.imdb_rating != null ? parseFloat(String(m.imdb_rating)) : null,
    },
    source: 'rapidapi-ai',
    updated_at: new Date().toISOString(),
  };
}

function DiscoverPanel({ onItemClick }: { onItemClick: (item: MediaItem) => void }) {
  const [inputValue, setInputValue] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');

  const { data, isLoading, error } = useQuery({
    queryKey: ['ai-movie-discover', submittedQuery],
    queryFn: async () => {
      return await apiClient.invokeFn('ai-movie-recommender', { q: submittedQuery });
    },
    enabled: !!submittedQuery,
    staleTime: 1000 * 60 * 30,
    throwOnError: false,
  });

  const rawResults: DiscoverMovie[] = Array.isArray(data) ? data as DiscoverMovie[] : ((data as { results?: DiscoverMovie[]; movies?: DiscoverMovie[] } | null)?.results ?? (data as { results?: DiscoverMovie[]; movies?: DiscoverMovie[] } | null)?.movies ?? []);
  const discoverItems: MediaItem[] = rawResults.map(toMediaItem);

  function handleSearch() {
    const q = inputValue.trim();
    if (q) setSubmittedQuery(q);
  }

  function handleChip(query: string) {
    setInputValue('');
    setSubmittedQuery(query);
  }

  return (
    <div className="space-y-4">
      {/* Search bar */}
      <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="text-sm font-semibold">What are you in the mood for?</p>
        </div>
        <div className="flex gap-2">
          <Input
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder='e.g. "cozy fall movies", "90s action"'
            className="text-sm"
          />
          <Button onClick={handleSearch} disabled={!inputValue.trim() || isLoading} size="sm" className="shrink-0 gap-1.5">
            <Search className="h-3.5 w-3.5" />
            Search
          </Button>
        </div>

        {/* Preset chips */}
        <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Quick picks</p>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_CHIPS.map(({ emoji, label, query }) => (
              <button
                key={label}
                onClick={() => handleChip(query)}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-all',
                  submittedQuery === query
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                {emoji} {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      {submittedQuery && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">AI Picks</Badge>
            <span className="text-xs text-muted-foreground">"{submittedQuery}"</span>
          </div>

          {isLoading ? (
            <div className="flex gap-3 overflow-x-auto scrollbar-none pb-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-36">
                  <Skeleton className="w-full aspect-[2/3] rounded-xl" />
                  <Skeleton className="h-3 w-3/4 mt-2 rounded" />
                  <Skeleton className="h-3 w-1/2 mt-1 rounded" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <Film className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p>Couldn't fetch recommendations. Try again.</p>
            </div>
          ) : discoverItems.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm">
              <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-40" />
              <p>No results found. Try a different mood or phrase.</p>
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto scrollbar-none pb-2">
              {discoverItems.map(item => (
                <ErrorBoundary key={item.id} fallback={<div className="flex-shrink-0 w-36 aspect-[2/3] rounded-xl bg-muted flex items-center justify-center"><Film className="h-6 w-6 text-muted-foreground/30" /></div>}>
                  <PosterCard item={item} onClick={() => onItemClick(item)} />
                </ErrorBoundary>
              ))}
            </div>
          )}
        </div>
      )}

      {!submittedQuery && (
        <div className="text-center py-6 text-muted-foreground text-sm opacity-60">
          <Sparkles className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p>Type a mood, vibe, or genre above — or tap a quick pick.</p>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function MoviesSection() {
  const [activeTab, setActiveTab] = useState<MovieTab>('theater');
  const [streamingFilter, setStreamingFilter] = useState<StreamingFilter>('streaming_movie');
  const [showKids, setShowKids] = useState(false);
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);

  const getCategories = (): string[] => {
    if (activeTab === 'theater') return ['theater'];
    if (activeTab === 'discover') return [];
    if (streamingFilter === 'kids') return ['kids_movie', 'kids_show'];
    return [streamingFilter];
  };

  const categories = getCategories();

  const { data: items, isLoading, isError, refetch } = useQuery({
    queryKey: ['media_items', categories, showKids],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<MediaItem[]>({
        table: 'media_items',
        select: '*',
        filters: [{ column: 'category', op: 'in', value: categories }],
        order: [
          { column: 'rank', ascending: true, nullsFirst: false },
          { column: 'score', ascending: false, nullsFirst: false },
        ],
        limit: 40,
      });
      let result = (data || []) as MediaItem[];

      if (showKids && activeTab === 'streaming' && streamingFilter !== 'kids') {
        result = result.filter(item => (item.metadata as { kids?: boolean })?.kids === true);
      }

      return result;
    },
    throwOnError: false,
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-xl">🎬</span>
        <h2 className="text-xl font-display font-semibold">Movies & TV</h2>
      </div>

      {/* Main tabs */}
      <div className="flex gap-1.5 flex-wrap">
        {([
          { id: 'theater' as MovieTab, label: '🎟️ In Theaters' },
          { id: 'streaming' as MovieTab, label: '📺 Streaming' },
          { id: 'discover' as MovieTab, label: '✨ Discover' },
        ]).map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-1.5 rounded-full text-sm font-medium transition-all',
              activeTab === id
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'border border-border text-muted-foreground hover:text-foreground hover:bg-muted'
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Streaming sub-filter */}
      {activeTab === 'streaming' && (
        <div className="flex gap-1.5 flex-wrap">
          {([
            { id: 'streaming_movie' as StreamingFilter, label: '🎬 Movies' },
            { id: 'streaming_show' as StreamingFilter, label: '📡 Shows' },
            { id: 'kids' as StreamingFilter, label: '👧 Kids' },
          ]).map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setStreamingFilter(id)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium transition-all',
                streamingFilter === id
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted border border-border'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Error state */}
      {isError && activeTab !== 'discover' && (
        <Card className="glass border-destructive/30">
          <CardContent className="py-8 text-center space-y-3">
            <span className="text-2xl block">⚠️</span>
            <p className="text-sm text-muted-foreground">Couldn't load media data.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <Film className="h-3.5 w-3.5 mr-1.5" />Try again
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Content */}
      {activeTab === 'discover' ? (
        <DiscoverPanel onItemClick={setSelectedItem} />
      ) : activeTab === 'theater' ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">Now Playing</Badge>
            <span className="text-xs text-muted-foreground">Tap a movie to see showtimes + ratings</span>
          </div>
          <ScrollShelf items={items} isLoading={isLoading} onItemClick={setSelectedItem} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {streamingFilter === 'kids' ? 'Kids Content' : 'Top 20'}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {streamingFilter === 'kids' ? 'Family & kids picks' : 'Trending across Netflix, Disney+, Peacock, Paramount+ & more'}
            </span>
          </div>
          <ScrollShelf items={items} isLoading={isLoading} onItemClick={setSelectedItem} />
        </div>
      )}

      {/* Not configured notice — only for theater/streaming */}
      {activeTab !== 'discover' && !isLoading && (!items || items.length === 0) && (
        <Card className="glass border-dashed">
          <CardContent className="py-6 text-center space-y-2">
            <Film className="h-8 w-8 mx-auto opacity-30" />
            <p className="text-sm font-medium">Refreshing soon…</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Movie and TV data updates automatically every morning at 7 AM.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Movie Detail Sheet */}
      {selectedItem && (
        <MovieDetailSheet
          item={selectedItem}
          open={!!selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}
