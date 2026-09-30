import { useState, useEffect } from 'react';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, Clock, MessageSquare, Mail, MapPin, Zap, Server } from 'lucide-react';
import { format } from 'date-fns';

// ─── Types ────────────────────────────────────────────────────────────────────

type CheckStatus = 'ok' | 'degraded' | 'error';

interface CheckResult {
  name: string;
  status: CheckStatus;
  latency_ms: number;
  message?: string;
}

interface HealthLog {
  id: string;
  overall_status: CheckStatus;
  total_ms: number;
  results: CheckResult[];
  created_at: string;
}

// ─── Category Definitions ─────────────────────────────────────────────────────

const CATEGORIES = [
  {
    key: 'channels',
    label: 'Janus Channels',
    icon: MessageSquare,
    checks: ['janus_chat', 'janus_whatsapp', 'janus_email'],
    color: 'text-blue-500',
  },
  {
    key: 'workspace',
    label: 'Google Workspace',
    icon: Mail,
    checks: ['gmail_tony', 'google_calendar', 'google_drive'],
    color: 'text-green-500',
  },
  {
    key: 'maps',
    label: 'Google Maps Platform',
    icon: MapPin,
    checks: ['google_maps_routes', 'google_air_quality', 'google_pollen'],
    color: 'text-yellow-500',
  },
  {
    key: 'thirdparty',
    label: 'Third-Party Services',
    icon: Zap,
    checks: ['firecrawl', 'wati_whatsapp', 'elevenlabs', 'ai_gateway'],
    color: 'text-purple-500',
  },
  {
    key: 'infra',
    label: 'Infrastructure',
    icon: Server,
    checks: ['home_assistant', 'notion', 'memory_db'],
    color: 'text-orange-500',
  },
] as const;

const CHECK_LABELS: Record<string, string> = {
  janus_chat: 'Janus Chat',
  janus_whatsapp: 'Janus WhatsApp',
  janus_email: 'Janus Email',
  gmail_tony: 'Gmail (Primary)',
  google_calendar: 'Google Calendar',
  google_drive: 'Google Drive',
  google_maps_routes: 'Maps Routes API',
  google_air_quality: 'Air Quality API',
  google_pollen: 'Pollen API',
  firecrawl: 'Firecrawl',
  wati_whatsapp: 'WATI WhatsApp',
  elevenlabs: 'ElevenLabs Voice',
  ai_gateway: 'OpenRouter AI Gateway',
  home_assistant: 'Home Assistant',
  notion: 'Notion',
  memory_db: 'Memory DB',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusIcon({ status, className = 'w-4 h-4' }: { status: CheckStatus; className?: string }) {
  if (status === 'ok') return <CheckCircle2 className={`${className} text-green-500`} />;
  if (status === 'degraded') return <AlertTriangle className={`${className} text-yellow-500`} />;
  return <XCircle className={`${className} text-destructive`} />;
}

function StatusBadge({ status }: { status: CheckStatus }) {
  const map = {
    ok: 'bg-primary/10 text-primary border-primary/20',
    degraded: 'bg-muted text-muted-foreground border-border',
    error: 'bg-destructive/10 text-destructive border-destructive/20',
  } as const;
  return (
    <Badge variant="outline" className={`text-xs font-medium ${map[status]}`}>
      {status === 'ok' ? 'OK' : status === 'degraded' ? 'Slow' : 'Error'}
    </Badge>
  );
}

function CheckRow({ result }: { result: CheckResult }) {
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors">
      <StatusIcon status={result.status} />
      <span className="flex-1 text-sm font-medium">{CHECK_LABELS[result.name] ?? result.name}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{result.latency_ms}ms</span>
      <StatusBadge status={result.status} />
      {result.message && (
        <span className="text-xs text-muted-foreground max-w-[200px] truncate" title={result.message}>
          {result.message}
        </span>
      )}
    </div>
  );
}

function CategorySection({
  category,
  results,
}: {
  category: typeof CATEGORIES[number];
  results: CheckResult[];
}) {
  const Icon = category.icon;
  const catResults = category.checks.map((name) => results.find((r) => r.name === name)).filter(Boolean) as CheckResult[];
  const catStatus: CheckStatus = catResults.some((r) => r.status === 'error')
    ? 'error'
    : catResults.some((r) => r.status === 'degraded')
      ? 'degraded'
      : 'ok';

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-4 h-4 ${category.color}`} />
        <span className="text-sm font-semibold">{category.label}</span>
        <StatusBadge status={catStatus} />
      </div>
      <div className="rounded-lg border bg-card divide-y divide-border/50">
        {catResults.length === 0 ? (
          <div className="py-3 px-3 text-xs text-muted-foreground">No results yet</div>
        ) : (
          catResults.map((r) => <CheckRow key={r.name} result={r} />)
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function JanusHealthTab() {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<HealthLog[]>([]);
  const [latest, setLatest] = useState<HealthLog | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(true);

  async function fetchLogs() {
    setLoadingLogs(true);
    const { data } = await apiClient.dbQuery<HealthLog[]>({
      table: 'janus_health_logs',
      select: '*',
      order: { column: 'created_at', ascending: false },
      limit: 20,
    });
    if (data && data.length > 0) {
      const typed = data;
      setLogs(typed);
      setLatest(typed[0]);
    }
    setLoadingLogs(false);
  }

  useEffect(() => {
    fetchLogs();
  }, []);

  async function triggerCheck() {
    setRunning(true);
    try {
      await apiClient.invokeFn('janus-health-check');
      await fetchLogs();
    } finally {
      setRunning(false);
    }
  }

  const overallStatus: CheckStatus = latest?.overall_status ?? 'ok';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-base font-semibold">Janus API Health</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {latest
              ? `Last checked ${format(new Date(latest.created_at), 'MMM d, h:mm a')} · ${latest.total_ms}ms total`
              : 'No checks run yet — run one manually or wait for the next scheduled run.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {latest && (
            <Badge
              variant="outline"
              className={
                overallStatus === 'ok'
                  ? 'border-green-500/30 text-green-600 bg-green-500/5'
                  : overallStatus === 'degraded'
                    ? 'border-yellow-500/30 text-yellow-600 bg-yellow-500/5'
                    : 'border-destructive/30 text-destructive bg-destructive/5'
              }
            >
              <StatusIcon status={overallStatus} className="w-3 h-3 mr-1" />
              {overallStatus === 'ok' ? 'All Systems OK' : overallStatus === 'degraded' ? 'Degraded' : 'Outage'}
            </Badge>
          )}
          <Button size="sm" variant="outline" onClick={triggerCheck} disabled={running} className="gap-2">
            <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`} />
            {running ? 'Running…' : 'Run Now'}
          </Button>
        </div>
      </div>

      {/* Latest Results — grouped by category */}
      {latest && (
        <div className="grid gap-4">
          {CATEGORIES.map((cat) => (
            <CategorySection key={cat.key} category={cat} results={latest.results as CheckResult[]} />
          ))}
        </div>
      )}

      {/* Log History Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            Check History
          </CardTitle>
          <CardDescription className="text-xs">Last 20 scheduled runs</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loadingLogs ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : logs.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No health check logs yet</div>
          ) : (
            <div className="divide-y divide-border/50">
              {logs.map((log) => {
                const results = log.results as CheckResult[];
                const okCount = results.filter((r) => r.status === 'ok').length;
                const errCount = results.filter((r) => r.status === 'error').length;
                const degCount = results.filter((r) => r.status === 'degraded').length;
                return (
                  <div key={log.id} className="flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors">
                    <StatusIcon status={log.overall_status} />
                    <span className="text-xs text-muted-foreground w-36 shrink-0">
                      {format(new Date(log.created_at), 'MMM d, h:mm a')}
                    </span>
                    <div className="flex items-center gap-2 flex-1 flex-wrap">
                      {okCount > 0 && (
                        <Badge variant="outline" className="text-xs bg-primary/5 text-primary border-primary/20">
                          {okCount} ok
                        </Badge>
                      )}
                      {degCount > 0 && (
                        <Badge variant="outline" className="text-xs bg-muted text-muted-foreground border-border">
                          {degCount} slow
                        </Badge>
                      )}
                      {errCount > 0 && (
                        <Badge variant="outline" className="text-xs bg-destructive/5 text-destructive border-destructive/20">
                          {errCount} errors
                        </Badge>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">{log.total_ms}ms</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
