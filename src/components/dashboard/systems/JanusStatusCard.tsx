import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  RefreshCw, CheckCircle2, AlertTriangle, XCircle,
  MessageSquare, Mail, MapPin, Zap, Server, Clock, ChevronDown, ChevronRight,
} from 'lucide-react';
import { format } from 'date-fns';
import { RecentRequestItem } from './RecentRequests';
import { useRecentRequests } from './useRecentRequests';
import { cn } from '@/lib/utils';

type CheckStatus = 'ok' | 'degraded' | 'error';

interface CheckResult {
  name: string;
  status: CheckStatus;
  latency_ms: number;
  message?: string;
}

function StatusDot({ status }: { status: CheckStatus | string }) {
  const cls = status === 'ok' || status === 'success' ? 'bg-green-500'
    : status === 'degraded' || status === 'partial' ? 'bg-yellow-500'
    : status === 'error' ? 'bg-destructive'
    : 'bg-muted-foreground';
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />;
}

const STATUS_SORT_ORDER: Record<CheckStatus, number> = { error: 0, degraded: 1, ok: 2 };

const CATEGORIES = [
  { label: 'Janus Channels', icon: MessageSquare, checks: ['janus_chat', 'janus_whatsapp', 'janus_email'], color: 'text-blue-500' },
  { label: 'Google Workspace', icon: Mail, checks: ['gmail_tony', 'google_calendar', 'google_drive'], color: 'text-green-500' },
  { label: 'Google Maps', icon: MapPin, checks: ['google_maps_routes', 'google_air_quality', 'google_pollen'], color: 'text-yellow-500' },
  { label: 'Third-Party', icon: Zap, checks: ['firecrawl', 'wati_whatsapp', 'elevenlabs', 'openrouter'], color: 'text-purple-500' },
  { label: 'Infrastructure', icon: Server, checks: ['home_assistant', 'notion', 'memory_db'], color: 'text-orange-500' },
] as const;

const CHECK_LABELS: Record<string, string> = {
  janus_chat: 'Chat', janus_whatsapp: 'WhatsApp', janus_email: 'Email',
  gmail_tony: 'Gmail', google_calendar: 'Calendar', google_drive: 'Drive',
  google_maps_routes: 'Routes', google_air_quality: 'Air Quality', google_pollen: 'Pollen',
  firecrawl: 'Firecrawl', wati_whatsapp: 'WATI', elevenlabs: 'ElevenLabs', openrouter: 'OpenRouter',
  home_assistant: 'Home Assistant', notion: 'Notion', memory_db: 'Memory DB',
};

function categoryWorstStatus(results: CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === 'error')) return 'error';
  if (results.some((r) => r.status === 'degraded')) return 'degraded';
  return 'ok';
}

interface CategorySectionProps {
  label: string;
  icon: React.ElementType;
  color: string;
  results: CheckResult[];
  defaultOpen: boolean;
}

function CategorySection({ label, icon: Icon, color, results, defaultOpen }: CategorySectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  const worst = categoryWorstStatus(results);
  const sorted = [...results].sort((a, b) => STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status]);
  const failCount = results.filter((r) => r.status !== 'ok').length;

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1.5 mb-1 w-full text-left group"
        onClick={() => setOpen((o) => !o)}
        data-testid={`category-toggle-${label.toLowerCase().replace(/\s+/g, '-')}`}
      >
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <span className="text-xs font-semibold flex-1">{label}</span>
        {failCount > 0 && (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] h-4 px-1',
              worst === 'error'
                ? 'border-destructive/40 text-destructive bg-destructive/5'
                : 'border-yellow-500/40 text-yellow-600 bg-yellow-500/5',
            )}
          >
            {failCount} issue{failCount > 1 ? 's' : ''}
          </Badge>
        )}
        {open
          ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
          : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
      </button>

      {open && (
        <div className="space-y-1 pl-5">
          {sorted.map((r) => (
            <div key={r.name} data-testid={`check-row-${r.name}`}>
              <div className="flex items-center gap-2 text-xs">
                <StatusDot status={r.status} />
                <span className="flex-1">{CHECK_LABELS[r.name] ?? r.name}</span>
                <span className="text-muted-foreground tabular-nums">{r.latency_ms}ms</span>
              </div>
              {r.message && r.status !== 'ok' && (
                <p
                  className={cn(
                    'text-[10px] pl-4 mt-0.5 leading-tight',
                    r.status === 'error' ? 'text-destructive/80' : 'text-yellow-600/80',
                  )}
                  data-testid={`check-message-${r.name}`}
                >
                  {r.message}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function JanusStatusCard() {
  const [running, setRunning] = useState(false);
  const queryClient = useQueryClient();

  const { data: latest } = useQuery({
    queryKey: ['janus-health-latest'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<{
        overall_status: CheckStatus;
        total_ms: number | null;
        results: CheckResult[];
        created_at: string;
      }>({
        table: 'janus_health_logs',
        select: '*',
        order: { column: 'created_at', ascending: false },
        limit: 1,
      });
      return data;
    },
    refetchInterval: 5 * 60 * 1000,
  });

  const { data: recentRequests } = useRecentRequests(10);

  async function runCheck() {
    setRunning(true);
    try {
      await apiClient.invokeFn('janus-health-check');
      await queryClient.invalidateQueries({ queryKey: ['janus-health-latest'] });
    } finally {
      setRunning(false);
    }
  }

  const overall = latest?.overall_status ?? 'ok';
  const results = (latest?.results ?? []) as CheckResult[];
  const totalMs = latest?.total_ms ?? null;

  const failedCount = results.filter((r) => r.status === 'error').length;
  const degradedCount = results.filter((r) => r.status === 'degraded').length;
  const problemCount = failedCount + degradedCount;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Janus App Status</CardTitle>
            <div className="flex items-center gap-2">
              {latest && (
                <Badge
                  variant="outline"
                  data-testid="overall-status-badge"
                  className={
                    overall === 'ok' ? 'border-green-500/30 text-green-600 bg-green-500/5'
                      : overall === 'degraded' ? 'border-yellow-500/30 text-yellow-600 bg-yellow-500/5'
                      : 'border-destructive/30 text-destructive bg-destructive/5'
                  }
                >
                  {overall === 'ok' ? <CheckCircle2 className="w-3 h-3 mr-1" /> : overall === 'degraded' ? <AlertTriangle className="w-3 h-3 mr-1" /> : <XCircle className="w-3 h-3 mr-1" />}
                  {overall === 'ok' ? 'All OK' : overall === 'degraded' ? 'Degraded' : 'Outage'}
                </Badge>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={runCheck}
                disabled={running}
                className="h-7 gap-1.5 text-xs"
                data-testid="button-run-check"
              >
                <RefreshCw className={`w-3 h-3 ${running ? 'animate-spin' : ''}`} />
                {running ? 'Running…' : 'Check'}
              </Button>
            </div>
          </div>

          {latest && (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <p className="text-xs text-muted-foreground">
                Last checked {format(new Date(latest.created_at), 'MMM d, h:mm a')}
                {typeof totalMs === 'number' ? ` · ${totalMs}ms` : ''}
              </p>
              {problemCount > 0 && (
                <span
                  className={cn(
                    'text-xs font-medium',
                    failedCount > 0 ? 'text-destructive' : 'text-yellow-600',
                  )}
                  data-testid="problem-count-summary"
                >
                  {problemCount} of {results.length} {problemCount === 1 ? 'check' : 'checks'} {
                    failedCount > 0 && degradedCount > 0
                      ? 'impacted'
                      : failedCount > 0
                        ? 'failed'
                        : 'degraded'
                  }
                </span>
              )}
            </div>
          )}
        </CardHeader>

        <CardContent className="pt-0">
          {!latest ? (
            <p className="text-sm text-muted-foreground">No health checks run yet</p>
          ) : (
            <div className="space-y-2">
              {[...CATEGORIES]
                .map((cat) => {
                  const catResults = cat.checks
                    .map((n) => results.find((r) => r.name === n))
                    .filter(Boolean) as CheckResult[];
                  return { cat, catResults };
                })
                .filter(({ catResults }) => catResults.length > 0)
                .sort((a, b) => {
                  const wa = STATUS_SORT_ORDER[categoryWorstStatus(a.catResults)];
                  const wb = STATUS_SORT_ORDER[categoryWorstStatus(b.catResults)];
                  return wa - wb;
                })
                .map(({ cat, catResults }) => {
                  const hasProblems = catResults.some((r) => r.status !== 'ok');
                  return (
                    <CategorySection
                      key={cat.label}
                      label={cat.label}
                      icon={cat.icon}
                      color={cat.color}
                      results={catResults}
                      defaultOpen={hasProblems}
                    />
                  );
                })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            Recent Requests
          </CardTitle>
          <p className="text-xs text-muted-foreground">Last 10 system events across all channels</p>
        </CardHeader>
        <CardContent className="pt-0">
          {!recentRequests || recentRequests.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No audit events yet</p>
          ) : (
            <div className="divide-y-0">
              {recentRequests.map((entry) => (
                <RecentRequestItem key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
