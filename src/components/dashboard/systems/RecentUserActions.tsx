import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';
import {
  ChevronDown, ChevronUp,
  Lightbulb, Thermometer, ToggleRight, Volume2, Zap, Activity,
  Mail, MessageSquare, Shield, Lock, Flame, Play, Search,
  Bell, ShoppingCart, Brain, Calendar, Bookmark, Send,
} from 'lucide-react';

interface ActionEntry {
  id: string;
  created_at: string;
  category: string;
  event_type: string;
  severity: string;
  actor_name: string | null;
  channel: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  duration_ms: number | null;
  status: string;
}

const CHANNEL_COLORS: Record<string, string> = {
  chat: 'bg-blue-500/10 text-blue-600 border-blue-500/20',
  whatsapp: 'bg-green-500/10 text-green-600 border-green-500/20',
  'whatsapp-group': 'bg-green-500/10 text-green-600 border-green-500/20',
  email: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  web: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
};

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'ok' || status === 'success' ? 'bg-green-500' :
    status === 'degraded' || status === 'partial' ? 'bg-yellow-500' :
    status === 'error' ? 'bg-destructive' :
    status === 'skipped' ? 'bg-muted-foreground' :
    'bg-muted-foreground';
  const title = status === 'skipped' ? 'Skipped — integration not configured' : status;
  return <span title={title} className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />;
}

function getActionIcon(entry: ActionEntry) {
  const detail = entry.detail as Record<string, unknown> | null;
  const domain = detail?.domain as string | undefined;
  const tools = detail?.tools as string[] | undefined;

  // HA service calls — by domain
  if (entry.event_type === 'ha_call_service') {
    if (domain === 'light') return <Lightbulb className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'climate') return <Thermometer className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'switch') return <ToggleRight className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'lock') return <Lock className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'alarm_control_panel') return <Shield className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'scene') return <Play className="w-3.5 h-3.5 text-purple-500 flex-shrink-0 mt-0.5" />;
    if (domain === 'media_player') return <Volume2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />;
    return <Zap className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />;
  }

  // Broadcasts
  if (entry.event_type.startsWith('broadcast')) return <Volume2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />;

  // Janus tool-based actions
  if (tools?.some(t => t.includes('email'))) return <Mail className="w-3.5 h-3.5 text-purple-500 flex-shrink-0 mt-0.5" />;
  if (tools?.some(t => t.includes('whatsapp'))) return <MessageSquare className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />;
  if (tools?.some(t => t.includes('reminder'))) return <Bell className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />;
  if (tools?.some(t => t.includes('shopping'))) return <ShoppingCart className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />;
  if (tools?.some(t => t.includes('remember') || t.includes('recall'))) return <Brain className="w-3.5 h-3.5 text-pink-500 flex-shrink-0 mt-0.5" />;
  if (tools?.some(t => t.includes('calendar'))) return <Calendar className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />;
  if (tools?.some(t => t.includes('search') || t.includes('google'))) return <Search className="w-3.5 h-3.5 text-sky-500 flex-shrink-0 mt-0.5" />;
  if (tools?.some(t => t.includes('notion'))) return <Bookmark className="w-3.5 h-3.5 text-stone-600 flex-shrink-0 mt-0.5" />;

  // Channel-based fallback
  if (entry.channel === 'whatsapp' || entry.channel === 'whatsapp-group') return <MessageSquare className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />;
  if (entry.event_type.includes('email')) return <Mail className="w-3.5 h-3.5 text-purple-500 flex-shrink-0 mt-0.5" />;
  if (entry.event_type.includes('whatsapp')) return <Send className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />;
  if (entry.event_type.includes('security') || entry.event_type.includes('verkada')) return <Shield className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />;
  if (entry.category === 'home') return <Flame className="w-3.5 h-3.5 text-orange-500 flex-shrink-0 mt-0.5" />;

  return <Activity className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />;
}

function ActionItem({ entry }: { entry: ActionEntry }) {
  const [expanded, setExpanded] = useState(false);
  const rawActor = entry.actor_name && entry.actor_name !== 'Unknown' ? entry.actor_name : null;
  const actorDisplay = rawActor ?? (entry.channel === 'web' ? 'Janus' : null);

  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2 py-2 px-1 text-left hover:bg-muted/30 rounded transition-colors"
      >
        <StatusDot status={entry.status} />
        {getActionIcon(entry)}
        <div className="flex-1 min-w-0">
          <p className="text-xs leading-snug">{entry.summary}</p>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            {entry.channel && (
              <Badge
                variant="outline"
                className={`text-[9px] px-1 py-0 h-4 ${CHANNEL_COLORS[entry.channel] ?? 'bg-muted text-muted-foreground border-border'}`}
              >
                {entry.channel === 'whatsapp-group' ? 'whatsapp' : entry.channel}
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

export function RecentUserActionsFeed({ limit = 20 }: { limit?: number }) {
  const { data: actions, isLoading } = useQuery({
    queryKey: ['user-actions-log', limit],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<ActionEntry[]>({
        table: 'system_audit_log',
        select: 'id,created_at,category,event_type,severity,actor_name,channel,summary,detail,duration_ms,status',
        filters: [
          { column: 'channel', op: 'neq', value: 'cron' },
          { column: 'category', op: 'neq', value: 'automation' },
        ],
        order: { column: 'created_at', ascending: false },
        limit,
      });
      return data ?? [];
    },
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-2 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 rounded bg-muted/50 animate-pulse" />
        ))}
      </div>
    );
  }

  if (!actions || actions.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-4">No recent user actions</p>;
  }

  return (
    <div className="divide-y-0">
      {actions.map((entry) => (
        <ActionItem key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
