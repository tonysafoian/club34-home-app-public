import { useState } from 'react';
import { format, parseISO, isSameDay, startOfWeek, addDays, isWithinInterval } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Loader2, CheckCircle2, Clock, AlertTriangle, ExternalLink, ListChecks, CalendarDays, CalendarRange, ChevronDown, MessageSquare, User } from 'lucide-react';
import { useNotionRecurringTasks, type TaskStatus, type StatusColor, type RecurringTask } from '@/hooks/useNotionActivity';
import { WeekStrip } from './WeekStrip';

const STATUS_COLOR_CLASSES: Record<StatusColor, { badge: string; dot: string }> = {
  red: {
    badge: 'text-[hsl(var(--status-offline))] bg-[hsl(var(--status-offline)/0.12)]',
    dot: 'bg-[hsl(var(--status-offline))]',
  },
  yellow: {
    badge: 'text-[hsl(var(--status-warning))] bg-[hsl(var(--status-warning)/0.12)]',
    dot: 'bg-[hsl(var(--status-warning))]',
  },
  green: {
    badge: 'text-[hsl(var(--status-online))] bg-[hsl(var(--status-online)/0.12)]',
    dot: 'bg-[hsl(var(--status-online))]',
  },
};

const STATUS_CONFIG: Record<TaskStatus, { label: string; icon: React.ReactNode; className: string }> = {
  'on-track': {
    label: 'On Track',
    icon: <CheckCircle2 className="h-4 w-4" />,
    className: 'text-[hsl(var(--status-online))] bg-[hsl(var(--status-online)/0.12)]',
  },
  overdue: {
    label: 'Overdue',
    icon: <AlertTriangle className="h-4 w-4" />,
    className: 'text-[hsl(var(--status-offline))] bg-[hsl(var(--status-offline)/0.12)]',
  },
  upcoming: {
    label: 'Upcoming',
    icon: <Clock className="h-4 w-4" />,
    className: 'text-[hsl(var(--status-warning))] bg-[hsl(var(--status-warning)/0.12)]',
  },
};

type ViewMode = 'status' | 'daily' | 'weekly';
type FilterValue = 'all' | TaskStatus;

const FILTERS: { label: string; value: FilterValue }[] = [
  { label: 'All', value: 'all' },
  { label: 'On Track', value: 'on-track' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Upcoming', value: 'upcoming' },
];

function StatusBadge({ statusColor, rawStatus }: { statusColor: StatusColor; rawStatus: string }) {
  const colors = STATUS_COLOR_CLASSES[statusColor];
  return (
    <Badge variant="outline" className={`text-xs ${colors.badge} border-0 gap-1`}>
      <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
      {rawStatus || 'No Status'}
    </Badge>
  );
}

function TaskRow({ task, compact = false }: { task: RecurringTask; compact?: boolean }) {
  const isProject = task.taskType === 'project';

  const rowContent = (
    <div className={`flex items-center gap-3 rounded-lg border border-border/50 bg-background/50 transition-colors hover:bg-muted/30 ${compact ? 'px-3 py-2' : 'px-4 py-3'} ${isProject ? 'cursor-pointer' : ''}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`${compact ? 'text-xs' : 'text-sm'} font-medium truncate`}>{task.name}</span>
          {task.notionUrl && (
            <a href={task.notionUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors" onClick={(e) => e.stopPropagation()}>
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {!compact && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
            {task.rawStatus && <span>Status: {task.rawStatus}</span>}
            {task.dueDate && <span>Due: {format(parseISO(task.dueDate), 'MMM d, yyyy')}</span>}
          </div>
        )}
      </div>
      {isProject && task.updateCount !== undefined && (
        <Badge variant="secondary" className="text-[10px] h-5 px-1.5 gap-1 shrink-0">
          <MessageSquare className="h-2.5 w-2.5" />
          {task.updateCount}
        </Badge>
      )}
      <StatusBadge statusColor={task.statusColor} rawStatus={task.rawStatus} />
      {isProject && <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180 shrink-0" />}
    </div>
  );

  if (!isProject) return rowContent;

  return (
    <Collapsible className="group">
      <CollapsibleTrigger asChild>{rowContent}</CollapsibleTrigger>
      <CollapsibleContent>
        {task.lastUpdate ? (
          <div className="ml-4 mt-1 rounded-lg border border-border/30 bg-muted/20 px-4 py-3 text-xs space-y-1">
            <div className="flex items-center gap-2 text-muted-foreground">
              <span className="font-medium text-foreground capitalize">{task.lastUpdate.description}</span>
            </div>
            <div className="flex items-center gap-3 text-muted-foreground">
              {task.lastUpdate.author && (
                <span className="flex items-center gap-1"><User className="h-3 w-3" />{task.lastUpdate.author}</span>
              )}
              <span>{format(parseISO(task.lastUpdate.date), 'MMM d, yyyy · h:mm a')}</span>
            </div>
            {task.notionUrl && (
              <a href={task.notionUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline mt-1">
                <ExternalLink className="h-3 w-3" /> Open in Notion
              </a>
            )}
          </div>
        ) : (
          <div className="ml-4 mt-1 rounded-lg border border-border/30 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
            No update history available.
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function WeeklyCalendarView({ tasks, weekStart }: { tasks: RecurringTask[]; weekStart: Date }) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = new Date();

  return (
    <div className="space-y-1">
      {days.map((day) => {
        const dayTasks = tasks.filter((t) => t.dueDate && isSameDay(parseISO(t.dueDate), day));
        const isToday = isSameDay(day, today);

        return (
          <div key={day.toISOString()} className={`rounded-lg border transition-colors ${isToday ? 'border-primary/40 bg-primary/5' : 'border-border/30 bg-background/30'}`}>
            <div className={`px-3 py-2 flex items-center gap-2 ${isToday ? 'text-primary' : 'text-muted-foreground'}`}>
              <span className="text-xs font-semibold w-10">{format(day, 'EEE')}</span>
              <span className={`text-xs ${isToday ? 'font-bold' : 'font-medium'}`}>{format(day, 'MMM d')}</span>
              {dayTasks.length > 0 && (
                <Badge variant="secondary" className="text-[10px] h-4 px-1.5 ml-auto">
                  {dayTasks.length}
                </Badge>
              )}
            </div>
            {dayTasks.length > 0 && (
              <div className="px-3 pb-2 space-y-1">
                {dayTasks.map((task) => (
                  <TaskRow key={task.id} task={task} compact />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function NotionRecurringTasks() {
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [statusFilter, setStatusFilter] = useState<FilterValue>('all');
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date(), { weekStartsOn: 1 }));
  const { data: allTasks, isLoading } = useNotionRecurringTasks();

  // Only show recurring tasks in this component (not project items)
  const tasks = allTasks?.filter((t) => t.taskType === 'recurring');

  // Status view filtering
  const statusFiltered = statusFilter === 'all' ? tasks : tasks?.filter((t) => t.status === statusFilter);

  // Daily view filtering
  const dailyTasks = tasks?.filter((t) => {
    if (!t.dueDate) return false;
    return isSameDay(parseISO(t.dueDate), selectedDate);
  });

  // Weekly view — tasks in the selected week
  const weekEnd = addDays(weekStart, 6);
  const weeklyTasks = tasks?.filter((t) => {
    if (!t.dueDate) return false;
    const d = parseISO(t.dueDate);
    return isWithinInterval(d, { start: weekStart, end: weekEnd });
  });

  const counts = {
    all: tasks?.length ?? 0,
    'on-track': tasks?.filter((t) => t.status === 'on-track').length ?? 0,
    overdue: tasks?.filter((t) => t.status === 'overdue').length ?? 0,
    upcoming: tasks?.filter((t) => t.status === 'upcoming').length ?? 0,
  };

  const displayedTasks = viewMode === 'daily' ? dailyTasks : viewMode === 'weekly' ? weeklyTasks : statusFiltered;

  return (
    <Card className="glass">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4 text-primary" />
            Recurring Task Tracker
          </CardTitle>
          <div className="flex gap-1 rounded-lg border border-border/50 p-0.5">
            <Button variant={viewMode === 'daily' ? 'default' : 'ghost'} size="sm" className="h-7 text-xs px-2.5 gap-1" onClick={() => setViewMode('daily')}>
              <CalendarDays className="h-3.5 w-3.5" /> Daily
            </Button>
            <Button variant={viewMode === 'weekly' ? 'default' : 'ghost'} size="sm" className="h-7 text-xs px-2.5 gap-1" onClick={() => setViewMode('weekly')}>
              <CalendarRange className="h-3.5 w-3.5" /> Weekly
            </Button>
            <Button variant={viewMode === 'status' ? 'default' : 'ghost'} size="sm" className="h-7 text-xs px-2.5 gap-1" onClick={() => setViewMode('status')}>
              <ListChecks className="h-3.5 w-3.5" /> Status
            </Button>
          </div>
        </div>

        {viewMode === 'daily' ? (
          <div className="pt-2"><WeekStrip selected={selectedDate} onSelect={setSelectedDate} /></div>
        ) : viewMode === 'weekly' ? (
          <div className="pt-2"><WeekStrip selected={weekStart} onSelect={(d) => setWeekStart(startOfWeek(d, { weekStartsOn: 1 }))} /></div>
        ) : (
          <div className="flex gap-1.5 pt-2 flex-wrap">
            {FILTERS.map((f) => (
              <Button key={f.value} variant={statusFilter === f.value ? 'default' : 'outline'} size="sm" className="h-7 text-xs px-2.5 gap-1" onClick={() => setStatusFilter(f.value)}>
                {f.label} <span className="opacity-60">({counts[f.value]})</span>
              </Button>
            ))}
          </div>
        )}
      </CardHeader>

      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : viewMode === 'weekly' ? (
          weeklyTasks?.length ? (
            <WeeklyCalendarView tasks={weeklyTasks} weekStart={weekStart} />
          ) : (
            <div className="text-center py-12 text-sm text-muted-foreground">No tasks due the week of {format(weekStart, 'MMM d')} – {format(weekEnd, 'MMM d')}.</div>
          )
        ) : !displayedTasks?.length ? (
          <div className="text-center py-12 text-sm text-muted-foreground">
            {viewMode === 'daily'
              ? `No tasks due on ${format(selectedDate, 'EEEE, MMM d')}.`
              : !tasks?.length
                ? 'No tasks with date or status properties found in synced databases.'
                : 'No tasks match the current filter.'}
          </div>
        ) : (
          <div className="space-y-2">
            {viewMode === 'daily' && (
              <p className="text-xs text-muted-foreground mb-3">
                {displayedTasks.length} task{displayedTasks.length !== 1 ? 's' : ''} due on{' '}
                <span className="font-medium text-foreground">{format(selectedDate, 'EEEE, MMM d')}</span>
              </p>
            )}
            {displayedTasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
