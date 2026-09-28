import { format } from 'date-fns';
import { ExternalLink, RefreshCw, Plus, CheckCircle2, Loader2, User } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useNotionDayEvents, type NotionDayEvent } from '@/hooks/useNotionActivity';

interface NotionDayEventsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string | null; // YYYY-MM-DD
  category?: 'updates' | 'new' | 'completions' | null;
}

function notionPageUrl(pageId: string): string {
  return `https://notion.so/${pageId.replace(/-/g, '')}`;
}

const categoryMeta: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
  updates: {
    label: 'Update',
    icon: <RefreshCw className="h-3 w-3" />,
    className: 'bg-[hsl(var(--iaqualink)/0.15)] text-[hsl(var(--iaqualink))]',
  },
  new: {
    label: 'New',
    icon: <Plus className="h-3 w-3" />,
    className: 'bg-[hsl(var(--status-online)/0.15)] text-[hsl(var(--status-online))]',
  },
  completions: {
    label: 'Completed',
    icon: <CheckCircle2 className="h-3 w-3" />,
    className: 'bg-accent/15 text-accent',
  },
};

function EventRow({ event }: { event: NotionDayEvent }) {
  const meta = categoryMeta[event.category] ?? categoryMeta.updates;
  const title = event.title || (event.notion_page_id ? `Page …${event.notion_page_id.slice(-6)}` : 'Untitled page');
  const hasLink = !!event.notion_page_id;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
      <Badge variant="secondary" className={`shrink-0 gap-1 text-[10px] ${meta.className}`}>
        {meta.icon}
        {meta.label}
      </Badge>
      <div className="flex-1 min-w-0">
        {hasLink ? (
          <a href={notionPageUrl(event.notion_page_id!)} target="_blank" rel="noopener noreferrer" className="text-sm font-medium truncate hover:underline hover:text-primary transition-colors">
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
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 h-7 w-7"
          asChild
        >
          <a
            href={notionPageUrl(event.notion_page_id!)}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in Notion"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      )}
    </div>
  );
}

export function NotionDayEventsSheet({
  open,
  onOpenChange,
  date,
  category,
}: NotionDayEventsSheetProps) {
  const { data: events, isLoading } = useNotionDayEvents(date);

  // Deduplicate: keep only the latest event per notion_page_id (events are sorted newest-first)
  const deduplicated = (() => {
    if (!events) return undefined;
    const seen = new Set<string>();
    return events.filter((e) => {
      if (!e.notion_page_id) return true; // keep events without a page ID
      if (seen.has(e.notion_page_id)) return false;
      seen.add(e.notion_page_id);
      return true;
    });
  })();

  const filtered = category
    ? deduplicated?.filter((e) => e.category === category)
    : deduplicated;

  const dateLabel = date ? format(new Date(date + 'T12:00:00'), 'EEEE, MMMM d') : '';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-base">
            {dateLabel}
            {category && (
              <Badge variant="outline" className="ml-2 text-xs font-normal">
                {categoryMeta[category]?.label ?? category}
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !filtered?.length ? (
          <div className="text-center py-16 text-sm text-muted-foreground">
            No events for this day.
          </div>
        ) : (
          <ScrollArea className="h-[calc(100vh-8rem)] pr-3 mt-4">
            {filtered.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
