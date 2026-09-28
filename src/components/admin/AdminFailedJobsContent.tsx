import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Loader2, RefreshCw, RotateCcw, CheckCircle2, XCircle, ChevronDown,
  AlertTriangle, Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDistanceToNow } from 'date-fns';
import { toast } from '@/hooks/use-toast';

interface FailedJob {
  id: string;
  function_name: string;
  payload: Record<string, unknown>;
  error_message: string;
  error_detail: Record<string, unknown> | null;
  attempts: number;
  max_attempts: number;
  status: 'pending' | 'retrying' | 'resolved' | 'dead';
  next_retry_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  retrying: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  resolved: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  dead: 'bg-red-500/15 text-red-400 border-red-500/30',
};

export function AdminFailedJobsContent() {
  const queryClient = useQueryClient();

  const { data: jobs = [], isLoading, isRefetching } = useQuery({
    queryKey: ['admin-failed-jobs'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<FailedJob[]>({ table: 'failed_jobs', select: '*', order: { column: 'created_at', ascending: false }, limit: 100 });
      return (data ?? []) as FailedJob[];
    },
  });

  const retryMutation = useMutation({
    mutationFn: async (jobId: string) => {
      const job = jobs.find(j => j.id === jobId);
      if (!job) throw new Error('Job not found');
      // Invoke the original edge function
      await apiClient.invokeFn(job.function_name, {});
      await apiClient.dbUpdate('failed_jobs', { status: 'resolved', resolved_at: new Date().toISOString() }, [{ column: 'id', op: 'eq', value: jobId }]);
    },
    onSuccess: () => {
      toast({ title: 'Retried successfully' });
      queryClient.invalidateQueries({ queryKey: ['admin-failed-jobs'] });
    },
    onError: (error: Error) => {
      toast({ title: 'Retry failed', description: error.message, variant: 'destructive' });
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await apiClient.dbUpdate('failed_jobs', { status: 'resolved', resolved_at: new Date().toISOString() }, [{ column: 'id', op: 'eq', value: jobId }]);
    },
    onSuccess: () => {
      toast({ title: 'Marked as resolved' });
      queryClient.invalidateQueries({ queryKey: ['admin-failed-jobs'] });
    },
  });

  const activeJobs = jobs.filter(j => j.status === 'pending' || j.status === 'retrying');
  const resolvedJobs = jobs.filter(j => j.status === 'resolved' || j.status === 'dead');

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {activeJobs.length} active / {resolvedJobs.length} resolved
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ['admin-failed-jobs'] })}
          disabled={isRefetching}
        >
          <RefreshCw className={cn("h-4 w-4 mr-1", isRefetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Active failures */}
      {activeJobs.length === 0 && (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-500/50" />
          No active failures — all automations are healthy.
        </Card>
      )}

      {activeJobs.map(job => (
        <JobCard
          key={job.id}
          job={job}
          onRetry={() => retryMutation.mutate(job.id)}
          onResolve={() => resolveMutation.mutate(job.id)}
          retrying={retryMutation.isPending}
        />
      ))}

      {/* Resolved section */}
      {resolvedJobs.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors group w-full pt-4">
            <ChevronDown className="h-4 w-4 transition-transform group-data-[state=closed]:-rotate-90" />
            Resolved ({resolvedJobs.length})
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-2 pt-2">
            {resolvedJobs.map(job => (
              <JobCard key={job.id} job={job} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function JobCard({
  job,
  onRetry,
  onResolve,
  retrying,
}: {
  job: FailedJob;
  onRetry?: () => void;
  onResolve?: () => void;
  retrying?: boolean;
}) {
  const isActive = job.status === 'pending' || job.status === 'retrying';

  return (
    <Card className={cn("p-3 space-y-2", !isActive && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isActive ? (
            <AlertTriangle className="h-4 w-4 text-yellow-400 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500/60 shrink-0" />
          )}
          <span className="text-sm font-mono font-medium truncate">{job.function_name}</span>
          <Badge variant="outline" className={cn("text-[10px] shrink-0", STATUS_STYLE[job.status])}>
            {job.status}
          </Badge>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isActive && onRetry && (
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onRetry} disabled={retrying}>
              {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            </Button>
          )}
          {isActive && onResolve && (
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={onResolve}>
              <XCircle className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <p className="text-xs text-red-400/80 line-clamp-2 pl-6">{job.error_message}</p>

      <div className="flex items-center gap-3 text-[10px] text-muted-foreground pl-6">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {formatDistanceToNow(new Date(job.created_at), { addSuffix: true })}
        </span>
        <span>attempt {job.attempts}/{job.max_attempts}</span>
        {job.error_detail && (
          <Collapsible>
            <CollapsibleTrigger className="underline hover:text-foreground">stack</CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-1 text-[10px] text-muted-foreground/70 whitespace-pre-wrap max-h-32 overflow-auto">
                {typeof job.error_detail === 'object' ? JSON.stringify(job.error_detail, null, 2) : String(job.error_detail)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </Card>
  );
}
