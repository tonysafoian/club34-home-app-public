import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import { ChevronDown, ChevronUp, Lightbulb, Thermometer, ToggleRight, Play, Volume2, Zap, Activity } from 'lucide-react';
import { useRecentRequests, type AuditEntry } from './useRecentRequests';

export type { AuditEntry };

const CHANNEL_COLORS: Record<string, string> = {
  chat: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  whatsapp: 'bg-green-500/10 text-green-600 border-green-500/20',
  email: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  web: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
  cron: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
  system: 'bg-muted text-muted-foreground border-border',
};

function StatusDot({ status }: { status: string }) {
  const cls = status === 'ok' || status === 'success' ? 'bg-green-500'
    : status === 'degraded' || status === 'partial' ? 'bg-yellow-500'
    : status === 'error' ? 'bg-destructive'
    : status === 'skipped' ? 'bg-muted-foreground'
    : 'bg-muted-foreground';
  const title = status === 'skipped' ? 'Skipped — integration not configured' : status;
  return <span title={title} className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />;
}

function getEventIcon(entry: AuditEntry) {
  const domain = (entry.detail as { domain?: string } | null)?.domain;
  if (entry.event_type === 'ha_call_service') {
    if (domain === 'light') return <Lightbulb className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'climate') return <Thermometer className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'switch') return <ToggleRight className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'scene') return <Play className="w-3.5 h-3.5 text-purple-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'media_player') return <Volume2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />;
    return <Zap className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />;
  }
  if (entry.event_type === 'broadcast_all' || entry.event_type === 'broadcast_girls') return <Volume2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />;
  return <Activity className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />;
}

export function RecentRequestItem({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  const actorDisplay = entry.actor_name ?? (entry.channel === 'web' ? 'Club34 App' : null);

  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 py-2 px-1 text-left hover:bg-muted/30 rounded transition-colors"
      >
        <StatusDot status={entry.status} />
        {getEventIcon(entry)}
        <div className="flex-1 min-w-0">
          <p className="text-xs leading-snug">{entry.summary}</p>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {entry.channel && (
              <Badge variant="outline" className={`text-[9px] px-1 py-0 h-4 ${CHANNEL_COLORS[entry.channel] ?? CHANNEL_COLORS.system}`}>
                {entry.channel}
              </Badge>
            )}
            {actorDisplay && (
              <span className="text-[10px] font-medium text-foreground/70">{actorDisplay}</span>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
          </span>
          {entry.duration_ms != null && (
            <span className="text-[10px] text-muted-foreground tabular-nums">{entry.duration_ms}ms</span>
          )}
          {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
        </div>
      </button>
      {expanded && entry.detail && (
        <pre className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2 mx-1 mb-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
          {JSON.stringify(entry.detail, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function RecentRequestsFeed({ limit = 100 }: { limit?: number }) {
  const { data: recentRequests } = useRecentRequests(limit);

  if (!recentRequests || recentRequests.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-4">No recent events</p>;
  }

  return (
    <div className="divide-y-0">
      {recentRequests.map((entry) => (
        <RecentRequestItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
