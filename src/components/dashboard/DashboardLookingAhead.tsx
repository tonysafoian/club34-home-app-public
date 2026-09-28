import { useMemo } from 'react';
import { useToday } from '@/hooks/useToday';
import { format, parseISO, isSameDay, addDays, isBefore } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Eye, ExternalLink, Loader2, Repeat, FolderKanban, User } from 'lucide-react';
import { useNotionRecurringTasks, type RecurringTask } from '@/hooks/useNotionActivity';

function getNextWorkDays(count: number, from: Date): Date[] {
  const days: Date[] = [];
  let cursor = addDays(from, 1);
  while (days.length < count) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

function CompactTaskRow({ task }: { task: RecurringTask }) {
  const isRecurring = task.taskType === 'recurring';
  return (
    <div className={`flex items-center gap-2 sm:gap-3 rounded-lg border px-2.5 sm:px-3 py-2 transition-colors hover:bg-muted/30 ${
      isRecurring
        ? 'border-primary/20 bg-primary/[0.03]'
        : 'border-accent/30 bg-accent/[0.03]'
    }`}>
      <div className={`flex items-center justify-center w-5 h-5 rounded shrink-0 ${
        isRecurring ? 'bg-primary/10 text-primary' : 'bg-accent/20 text-accent-foreground'
      }`}>
        {isRecurring ? <Repeat className="h-3 w-3" /> : <FolderKanban className="h-3 w-3" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">{task.name}</span>
          {task.notionUrl && (
            <a href={task.notionUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors shrink-0">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
      {task.assignedTo && (
        <div className="items-center gap-1 text-[10px] text-muted-foreground shrink-0 flex">
          <span className="sm:hidden flex items-center justify-center w-4 h-4 rounded-full bg-muted text-[8px] font-semibold uppercase text-muted-foreground">
            {task.assignedTo.split(' ').map(n => n[0]).join('').slice(0, 2)}
          </span>
          <span className="hidden sm:flex items-center gap-1">
            <User className="h-2.5 w-2.5" />
            <span className="max-w-[80px] truncate">{task.assignedTo}</span>
          </span>
        </div>
      )}
      {task.rawStatus && (
        <span className="text-[10px] text-muted-foreground shrink-0">{task.rawStatus}</span>
      )}
    </div>
  );
}

export function DashboardLookingAhead() {
  const { data: tasks, isLoading } = useNotionRecurringTasks();
  const today = useToday();
  const nextWorkDays = useMemo(() => getNextWorkDays(3, today), [today]);

  const dayGroups = nextWorkDays.map((day) => {
    const dayTasks = tasks?.filter(
      (t) => t.dueDate && isSameDay(parseISO(t.dueDate), day) && t.status !== 'on-track'
    ) ?? [];
    return { day, tasks: dayTasks };
  });

  const totalUpcoming = dayGroups.reduce((sum, g) => sum + g.tasks.length, 0);

  // Next 5 project items due (not done, future due date, project type only)
  const nextProjects = tasks
    ?.filter((t) => t.taskType === 'project' && t.dueDate && t.status !== 'on-track' && !isBefore(parseISO(t.dueDate), today))
    .sort((a, b) => parseISO(a.dueDate!).getTime() - parseISO(b.dueDate!).getTime())
    .slice(0, 5) ?? [];

  return (
    <Card className="glass">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Eye className="h-4 w-4 text-primary" />
          Looking Ahead
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {totalUpcoming === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                Nothing on the horizon for the next 3 work days.
              </div>
            ) : (
              <div className="space-y-4">
                {dayGroups.map(({ day, tasks: dayTasks }) => (
                  <div key={day.toISOString()}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-sm font-medium">{format(day, 'EEEE, MMM d')}</span>
                      {dayTasks.length > 0 && (
                        <Badge variant="secondary" className="text-xs h-5 px-1.5">{dayTasks.length}</Badge>
                      )}
                    </div>
                    {dayTasks.length > 0 ? (
                      <div className="space-y-1.5">
                        {dayTasks.map((task) => (
                          <CompactTaskRow key={task.id} task={task} />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground pl-1">No tasks due</p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Next 5 Projects Due */}
            {nextProjects.length > 0 && (
              <div className="space-y-2 border-t border-border/50 pt-5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FolderKanban className="h-4 w-4 text-accent-foreground" />
                  Next 5 Projects Due
                </div>
                <div className="space-y-1.5">
                  {nextProjects.map((task) => (
                    <div key={task.id} className="flex items-center gap-2 sm:gap-3 rounded-lg border border-accent/30 bg-accent/[0.03] px-2.5 sm:px-3 py-2 sm:py-2.5 transition-colors hover:bg-muted/30">
                      <FolderKanban className="h-3.5 w-3.5 text-accent-foreground shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs sm:text-sm font-medium truncate">{task.name}</span>
                          {task.notionUrl && (
                            <a href={task.notionUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary transition-colors shrink-0">
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          {task.rawStatus && <span>{task.rawStatus}</span>}
                          {task.databaseName && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-normal hidden sm:inline-flex">{task.databaseName}</Badge>
                          )}
                        </div>
                      </div>
                      {task.assignedTo && (
                        <div className="items-center gap-1 text-[10px] text-muted-foreground shrink-0 flex">
                          <span className="sm:hidden flex items-center justify-center w-4 h-4 rounded-full bg-muted text-[8px] font-semibold uppercase text-muted-foreground">
                            {task.assignedTo.split(' ').map(n => n[0]).join('').slice(0, 2)}
                          </span>
                          <span className="hidden sm:flex items-center gap-1">
                            <User className="h-2.5 w-2.5" />
                            <span className="max-w-[80px] truncate">{task.assignedTo}</span>
                          </span>
                        </div>
                      )}
                      <span className="text-xs text-muted-foreground shrink-0">
                        {format(parseISO(task.dueDate!), 'MMM d')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
