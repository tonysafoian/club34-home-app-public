import { useMemo } from 'react';
import { useToday } from '@/hooks/useToday';
import { format, parseISO, isSameDay } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CalendarCheck, AlertTriangle, CheckCircle2, ExternalLink, PartyPopper, Loader2, Repeat, FolderKanban, User, ChevronDown, MessageSquare } from 'lucide-react';
import { useNotionRecurringTasks, type RecurringTask, type StatusColor } from '@/hooks/useNotionActivity';

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

function TaskRow({ task }: { task: RecurringTask }) {
  const isRecurring = task.taskType === 'recurring';
  const isProject = task.taskType === 'project';
  const colors = STATUS_COLOR_CLASSES[task.statusColor];

  const rowContent = (
    <div className={`flex items-center gap-2 sm:gap-3 rounded-lg border px-3 sm:px-4 py-2.5 sm:py-3 transition-colors hover:bg-muted/30 ${
      isRecurring
        ? 'border-primary/20 bg-primary/[0.03]'
        : 'border-accent/30 bg-accent/[0.03]'
    } ${isProject ? 'cursor-pointer' : ''}`}>
      <div className={`flex items-center justify-center w-5 h-5 sm:w-6 sm:h-6 rounded-md shrink-0 ${
        isRecurring ? 'bg-primary/10 text-primary' : 'bg-accent/20 text-accent-foreground'
      }`}>
        {isRecurring ? <Repeat className="h-3 w-3 sm:h-3.5 sm:w-3.5" /> : <FolderKanban className="h-3 w-3 sm:h-3.5 sm:w-3.5" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs sm:text-sm font-medium truncate">{task.name}</span>
          {task.notionUrl && (
            <a href={task.notionUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors shrink-0" onClick={(e) => e.stopPropagation()}>
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 sm:gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
          {task.rawStatus && (
            <Badge variant="outline" className={`text-[10px] h-4 px-1.5 border-0 gap-1 ${colors.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
              {task.rawStatus}
            </Badge>
          )}
          {task.dueDate && <span className="hidden sm:inline">Due: {format(parseISO(task.dueDate), 'MMM d, yyyy')}</span>}
          {task.dueDate && <span className="sm:hidden">{format(parseISO(task.dueDate), 'M/d')}</span>}
          {task.databaseName && (
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-normal hidden sm:inline-flex">{task.databaseName}</Badge>
          )}
        </div>
      </div>
      {isProject && task.updateCount !== undefined && (
        <Badge variant="secondary" className="text-[10px] h-5 px-1.5 gap-1 shrink-0">
          <MessageSquare className="h-2.5 w-2.5" />
          {task.updateCount}
        </Badge>
      )}
      {task.assignedTo && (
        <div className="items-center gap-1 text-xs text-muted-foreground shrink-0 flex">
          {/* Mobile: initials badge */}
          <span className="sm:hidden flex items-center justify-center w-5 h-5 rounded-full bg-muted text-[9px] font-semibold uppercase text-muted-foreground">
            {task.assignedTo.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </span>
          {/* Desktop: full name */}
          <span className="hidden sm:flex items-center gap-1">
            <User className="h-3 w-3" />
            <span className="max-w-[100px] truncate">{task.assignedTo}</span>
          </span>
        </div>
      )}
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
              <a href={task.notionUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline mt-1" onClick={(e) => e.stopPropagation()}>
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

export function DashboardToday() {
  const { data: tasks, isLoading } = useNotionRecurringTasks();
  const today = useToday();

  const dueToday = tasks?.filter(
    (t) => t.dueDate && isSameDay(parseISO(t.dueDate), today) && t.status !== 'on-track'
  ) ?? [];

  const overdueAll = tasks?.filter((t) => t.status === 'overdue' && t.dueDate && !isSameDay(parseISO(t.dueDate), today))
    .sort((a, b) => {
      if (!a.dueDate || !b.dueDate) return 0;
      return parseISO(a.dueDate).getTime() - parseISO(b.dueDate).getTime();
    }) ?? [];

  const overdueRecurring = overdueAll.filter((t) => t.taskType === 'recurring');
  const overdueProjects = overdueAll.filter((t) => t.taskType === 'project');

  const allCaughtUp = dueToday.length === 0 && overdueAll.length === 0;

  return (
    <Card className="glass">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm sm:text-base">
            <CalendarCheck className="h-4 w-4 text-primary shrink-0" />
            <span className="sm:hidden">Today — {format(today, 'MMM d')}</span>
            <span className="hidden sm:inline">Today — {format(today, 'EEEE, MMM d')}</span>
          </CardTitle>
          <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><Repeat className="h-3 w-3 text-primary" /> Recurring</span>
            <span className="flex items-center gap-1"><FolderKanban className="h-3 w-3 text-accent-foreground" /> Project</span>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : allCaughtUp ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <PartyPopper className="h-5 w-5 text-primary" />
            All caught up! Nothing due or overdue.
          </div>
        ) : (
          <div className="space-y-5">
            {dueToday.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <CheckCircle2 className="h-4 w-4 text-[hsl(var(--status-warning))]" />
                  Due Today
                  <Badge variant="secondary" className="text-xs h-5 px-1.5">{dueToday.length}</Badge>
                </div>
                <div className="space-y-1.5">
                  {dueToday.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </div>
              </div>
            )}

            {overdueRecurring.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Repeat className="h-4 w-4 text-[hsl(var(--status-offline))]" />
                  <span className="text-[hsl(var(--status-offline))]">Overdue Recurring Tasks</span>
                  <Badge variant="secondary" className="text-xs h-5 px-1.5 bg-[hsl(var(--status-offline)/0.12)] text-[hsl(var(--status-offline))]">
                    {overdueRecurring.length}
                  </Badge>
                </div>
                <div className="space-y-1.5">
                  {overdueRecurring.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </div>
              </div>
            )}

            {overdueProjects.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <AlertTriangle className="h-4 w-4 text-[hsl(var(--status-offline))]" />
                  <span className="text-[hsl(var(--status-offline))]">Overdue Projects</span>
                  <Badge variant="secondary" className="text-xs h-5 px-1.5 bg-[hsl(var(--status-offline)/0.12)] text-[hsl(var(--status-offline))]">
                    {overdueProjects.length}
                  </Badge>
                </div>
                <div className="space-y-1.5">
                  {overdueProjects.map((task) => (
                    <TaskRow key={task.id} task={task} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
