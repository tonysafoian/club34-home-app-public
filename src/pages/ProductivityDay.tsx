import { useState, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { ArrowLeft, RefreshCw, Plus, CheckCircle2, Loader2, ExternalLink, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { useNotionDayEvents, type NotionDayEvent } from '@/hooks/useNotionActivity';

type Category = 'updates' | 'new' | 'completions';

function notionPageUrl(pageId: string): string {
  return `https://notion.so/${pageId.replace(/-/g, '')}`;
}

const categoryMeta: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  updates: {
    label: 'Updates',
    icon: <RefreshCw className="h-3.5 w-3.5" />,
    color: 'hsl(var(--iaqualink))',
  },
  new: {
    label: 'New',
    icon: <Plus className="h-3.5 w-3.5" />,
    color: 'hsl(var(--status-online))',
  },
  completions: {
    label: 'Completed',
    icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    color: 'hsl(var(--accent))',
  },
};

function EventRow({ event }: { event: NotionDayEvent }) {
  const meta = categoryMeta[event.category] ?? categoryMeta.updates;
  const title = event.title || (event.notion_page_id ? `Page …${event.notion_page_id.slice(-6)}` : 'Untitled page');
  const hasLink = !!event.notion_page_id;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
      <Badge variant="secondary" className="shrink-0 gap-1 text-[10px]" style={{ backgroundColor: `${meta.color}15`, color: meta.color }}>
        {meta.icon}
        {meta.label}
      </Badge>
      <div className="flex-1 min-w-0">
        {hasLink ? (
          <a href={notionPageUrl(event.notion_page_id!)} target="_blank" rel="noopener noreferrer" className="text-sm font-medium truncate block hover:underline hover:text-primary transition-colors">
            {title}
          </a>
        ) : (
          <p className="text-sm font-medium truncate">{title}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {format(new Date(event.created_at), 'h:mm a')}
          {event.event_type && (
            <span className="ml-1.5 opacity-60">· {event.event_type.replace(/_/g, ' ')}</span>
          )}
        </p>
        {event.author && (
          <p className="text-[10px] text-muted-foreground/70 flex items-center gap-1 mt-0.5">
            <User className="h-2.5 w-2.5" />
            {event.author}
          </p>
        )}
      </div>
      {hasLink && (
        <Button variant="ghost" size="icon" className="shrink-0 h-7 w-7" asChild>
          <a href={notionPageUrl(event.notion_page_id!)} target="_blank" rel="noopener noreferrer" title="Open in Notion">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      )}
    </div>
  );
}

export default function ProductivityDay() {
  const { date } = useParams<{ date: string }>();
  const navigate = useNavigate();
  const { data: events, isLoading } = useNotionDayEvents(date ?? null);
  const [visible, setVisible] = useState<Record<Category, boolean>>({
    updates: true,
    new: true,
    completions: true,
  });

  // Back-swipe gesture
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swiping = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const x = e.touches[0].clientX;
    // Only activate from left edge (first 30px)
    if (x < 30) {
      touchStartX.current = x;
      touchStartY.current = e.touches[0].clientY;
      swiping.current = true;
    }
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!swiping.current || touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = Math.abs(e.changedTouches[0].clientY - touchStartY.current);
    // Require horizontal swipe > 80px and mostly horizontal
    if (dx > 80 && dy < dx) {
      navigate('/productivity');
    }
    touchStartX.current = null;
    touchStartY.current = null;
    swiping.current = false;
  }, [navigate]);

  const dateLabel = date ? format(new Date(date + 'T12:00:00'), 'EEEE, MMMM d') : '';

  // Deduplicate by notion_page_id
  const deduplicated = (() => {
    if (!events) return [];
    const seen = new Set<string>();
    return events.filter((e) => {
      if (!e.notion_page_id) return true;
      if (seen.has(e.notion_page_id)) return false;
      seen.add(e.notion_page_id);
      return true;
    });
  })();

  const counts = deduplicated.reduce(
    (acc, e) => ({ ...acc, [e.category]: (acc[e.category as Category] || 0) + 1 }),
    { updates: 0, new: 0, completions: 0 } as Record<Category, number>
  );

  const filtered = deduplicated.filter((e) => visible[e.category as Category]);

  const toggleCategory = (key: Category) => {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="min-h-screen bg-background pb-16 md:pb-0" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <DashboardHeader />
      <main className="container py-4 md:py-6 px-3 md:px-4 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9" onClick={() => navigate('/productivity')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold">{dateLabel}</h1>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-3">
          {(['updates', 'new', 'completions'] as Category[]).map((key) => {
            const meta = categoryMeta[key];
            return (
              <Card key={key} className="glass">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${meta.color}26` }}>
                    <span style={{ color: meta.color }}>{meta.icon}</span>
                  </div>
                  <div>
                    <p className="text-2xl font-semibold font-display">{counts[key]}</p>
                    <p className="text-xs text-muted-foreground">{meta.label}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Category filters */}
        <div className="flex gap-2">
          {(['updates', 'new', 'completions'] as Category[]).map((key) => {
            const meta = categoryMeta[key];
            return (
              <Badge
                key={key}
                variant={visible[key] ? 'default' : 'outline'}
                className="cursor-pointer gap-1 text-xs select-none transition-all"
                onClick={() => toggleCategory(key)}
                style={visible[key] ? { backgroundColor: meta.color, color: 'hsl(var(--primary-foreground))' } : undefined}
              >
                {meta.icon}
                {meta.label}
              </Badge>
            );
          })}
        </div>

        {/* Event list */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : !filtered.length ? (
          <div className="text-center py-16 text-sm text-muted-foreground">
            No events for this day.
          </div>
        ) : (
          <Card className="glass">
            <CardContent className="p-3">
              {filtered.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </CardContent>
          </Card>
        )}
      </main>
      <MobileBottomNav />
    </div>
  );
}
