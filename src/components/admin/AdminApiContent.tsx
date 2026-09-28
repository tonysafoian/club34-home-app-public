import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Plug, KeyRound, ShieldCheck, Globe, Copy, Check, ExternalLink, Activity, RefreshCw, Timer, X } from 'lucide-react';
import { formatDistanceToNow, subHours } from 'date-fns';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

type ParamShape = Record<string, { type: string; required?: boolean; description?: string }>;
type BodyShape = { type: string; required?: string[]; properties: Record<string, { type: string; description?: string }> };
type EndpointDef = { method: string; path: string; description: string; query?: ParamShape; body?: BodyShape };
type ToolDef = { name: string; description: string; parameters: unknown };
type Capabilities = {
  name: string;
  version: string;
  base_path: string;
  auth: { type: string; header: string };
  rate_limit: { max_requests: number; window_ms: number; scope: string };
  endpoints: EndpointDef[];
  tools: ToolDef[];
};

const DEFAULT_BASE = (() => {
  if (typeof window === 'undefined') return 'https://example.com/api/v1/external';
  return `${window.location.origin}/api/v1/external`;
})();

function methodColor(method: string): string {
  switch (method) {
    case 'GET': return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30';
    case 'POST': return 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30';
    case 'PATCH': return 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30';
    case 'DELETE': return 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30';
    default: return 'bg-muted text-muted-foreground border-border';
  }
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast({ title: 'Copied', description: label || 'Snippet copied to clipboard' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  }
  return (
    <div className="relative group">
      <pre
        data-testid={`code-${(label || 'snippet').toLowerCase().replace(/\s+/g, '-')}`}
        className="text-xs font-mono bg-muted/50 border border-border rounded-md p-3 overflow-x-auto whitespace-pre"
      >
{code}
      </pre>
      <Button
        size="icon"
        variant="ghost"
        onClick={copy}
        className="absolute top-1.5 right-1.5 h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
        data-testid={`button-copy-${(label || 'snippet').toLowerCase().replace(/\s+/g, '-')}`}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

type ExternalApiCallRow = {
  id: string;
  createdAt: string;
  eventType: string;
  severity: string;
  summary: string;
  status: string;
  detail: Record<string, unknown> | null;
};

function endpointKeyOf(row: ExternalApiCallRow): string {
  const id = row.eventType.replace(/^external_api\./, '');
  if (id === 'tools.invoke') {
    const tool = row.detail && typeof row.detail['tool'] === 'string' ? (row.detail['tool'] as string) : null;
    return tool ? `tools/${tool}/invoke` : id;
  }
  return id;
}

function durationOf(row: ExternalApiCallRow): number | null {
  const raw = row.detail?.['duration_ms'];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function formatMs(ms: number): string {
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

type EndpointStat = {
  key: string;
  count: number;
  errors: number;
  errorRate: number;
  avgMs: number;
  p95Ms: number;
};

const CALL_STATUS_STYLES: Record<string, string> = {
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  error: 'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30',
  denied: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',
};

const RECENT_CALLS_SHOWN = 25;

function LiveActivityPanel() {
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);

  // Recent calls feed: the newest page of audit rows is enough for a
  // "recent calls" list; aggregate stats come from the server instead.
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['external-api-live-activity'],
    queryFn: async () => {
      const since = subHours(new Date(), 24).toISOString();
      const res = await fetch('/api/data/system-audit-logs/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ category: 'external_api', since, limit: 500 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Server error (${res.status})`);
      }
      const result = await res.json();
      return {
        rows: ((result.rows || []) as ExternalApiCallRow[]),
        count: (result.count ?? 0) as number,
      };
    },
    refetchInterval: 30000,
  });

  // Leaderboard: aggregated in SQL over the FULL 24h window (avg, p95, call
  // count, error count per endpoint), so heavy traffic can't skew the stats.
  const statsQuery = useQuery({
    queryKey: ['external-api-endpoint-stats'],
    queryFn: async () => {
      const res = await fetch('/api/data/external-api/endpoint-stats?hours=24&top=5', {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Server error (${res.status})`);
      }
      const result = await res.json();
      return (result.stats || []) as { endpoint: string; calls: number; errors: number; avgMs: number; p95Ms: number }[];
    },
    refetchInterval: 30000,
  });

  const rows = useMemo(() => data?.rows ?? [], [data]);

  const slowestEndpoints = useMemo<EndpointStat[]>(
    () =>
      (statsQuery.data ?? []).map((s) => ({
        key: s.endpoint,
        count: s.calls,
        errors: s.errors,
        errorRate: s.calls > 0 ? s.errors / s.calls : 0,
        avgMs: s.avgMs,
        p95Ms: s.p95Ms,
      })),
    [statsQuery.data],
  );

  const recentCalls = useMemo(() => {
    const filtered = selectedEndpoint
      ? rows.filter((row) => endpointKeyOf(row) === selectedEndpoint)
      : rows;
    return filtered.slice(0, RECENT_CALLS_SHOWN);
  }, [rows, selectedEndpoint]);

  return (
    <Card data-testid="panel-live-activity">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <CardTitle>Live activity</CardTitle>
            </div>
            <CardDescription className="mt-1">
              External API calls from the audit log over the last 24 hours ({data?.count ?? 0} total).
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { refetch(); statsQuery.refetch(); }}
            disabled={isFetching || statsQuery.isFetching}
            data-testid="button-refresh-live-activity"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (isFetching || statsQuery.isFetching) && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {(isLoading || statsQuery.isLoading) && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading activity…
          </div>
        )}
        {(isError || statsQuery.isError) && (
          <div className="text-sm text-destructive py-4 text-center" data-testid="text-live-activity-error">
            Failed to load activity.{' '}
            <button className="underline" onClick={() => { refetch(); statsQuery.refetch(); }}>Retry</button>
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center" data-testid="text-live-activity-empty">
            No External API calls in the last 24 hours.
          </div>
        )}

        {!isLoading && !isError && slowestEndpoints.length > 0 && (
          <div data-testid="section-slowest-endpoints">
            <div className="flex items-center gap-2 mb-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <h4 className="font-medium text-sm">Slowest endpoints (p95, last 24h)</h4>
            </div>
            <div className="rounded-md border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left font-medium px-3 py-2">Endpoint</th>
                    <th className="text-right font-medium px-3 py-2">p95</th>
                    <th className="text-right font-medium px-3 py-2">Avg</th>
                    <th className="text-right font-medium px-3 py-2">Calls</th>
                    <th className="text-right font-medium px-3 py-2">Errors</th>
                  </tr>
                </thead>
                <tbody>
                  {slowestEndpoints.map((s) => {
                    const active = selectedEndpoint === s.key;
                    return (
                      <tr
                        key={s.key}
                        onClick={() => setSelectedEndpoint(active ? null : s.key)}
                        className={cn(
                          'cursor-pointer border-b border-border last:border-b-0 transition-colors',
                          active ? 'bg-primary/10' : 'hover:bg-muted/50',
                        )}
                        data-testid={`row-slow-endpoint-${s.key.replace(/[^a-zA-Z0-9]+/g, '-')}`}
                      >
                        <td className="px-3 py-2 font-mono text-xs">{s.key}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs font-medium">{formatMs(s.p95Ms)}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">{formatMs(s.avgMs)}</td>
                        <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">{s.count}</td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right font-mono text-xs',
                            s.errors > 0 ? 'text-red-500' : 'text-muted-foreground',
                          )}
                        >
                          {(s.errorRate * 100).toFixed(s.errorRate > 0 && s.errorRate < 0.01 ? 1 : 0)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Click an endpoint to filter the recent calls below. Auth/rate-limit denials are excluded from latency stats.
            </p>
          </div>
        )}

        {!isLoading && !isError && rows.length > 0 && (
          <div data-testid="section-recent-calls">
            <div className="flex items-center gap-2 mb-2">
              <h4 className="font-medium text-sm">Recent calls</h4>
              {selectedEndpoint && (
                <Badge
                  variant="secondary"
                  className="gap-1 font-mono text-[10px] cursor-pointer"
                  onClick={() => setSelectedEndpoint(null)}
                  data-testid="badge-endpoint-filter"
                >
                  {selectedEndpoint}
                  <X className="h-3 w-3" />
                </Badge>
              )}
            </div>
            {recentCalls.length === 0 ? (
              <div className="text-xs text-muted-foreground py-3 text-center border border-dashed border-border rounded-md">
                No calls match this endpoint in the loaded window.
              </div>
            ) : (
              <ul className="rounded-md border border-border divide-y divide-border" data-testid="list-recent-calls">
                {recentCalls.map((row) => {
                  const d = durationOf(row);
                  return (
                    <li
                      key={row.id}
                      className="flex items-center gap-2 px-3 py-1.5 text-xs"
                      data-testid={`row-recent-call-${row.id}`}
                    >
                      <Badge
                        variant="outline"
                        className={cn(
                          'shrink-0 text-[10px] px-1.5',
                          CALL_STATUS_STYLES[row.status] || 'bg-muted text-muted-foreground border-border',
                        )}
                      >
                        {row.status}
                      </Badge>
                      <span className="font-mono truncate flex-1 min-w-0">{endpointKeyOf(row)}</span>
                      <span className="font-mono text-muted-foreground shrink-0">
                        {d !== null ? formatMs(d) : '—'}
                      </span>
                      <span className="text-muted-foreground shrink-0 w-24 text-right">
                        {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function AdminApiContent() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(false);
  const [healthy, setHealthy] = useState<boolean | null>(null);

  async function probe() {
    setLoading(true);
    setHealthy(null);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/health`, {
        method: 'GET',
        headers: { 'x-api-key': '___probe___' },
      });
      setHealthy(res.status === 401 || res.ok);
    } catch {
      setHealthy(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadCapabilities(apiKey: string) {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/capabilities`, {
        headers: { 'x-api-key': apiKey },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCaps(data.data || data);
    } catch (e) {
      setCaps(null);
      console.error('Failed to load capabilities:', e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [apiKeyInput, setApiKeyInput] = useState('');

  const curlExamples = [
    {
      label: 'List capabilities',
      code: `curl -H "x-api-key: $EXTERNAL_API_KEY" \\
  ${baseUrl}/capabilities`,
    },
    {
      label: 'Get HA states',
      code: `curl -H "x-api-key: $EXTERNAL_API_KEY" \\
  "${baseUrl}/home/states?domain=light"`,
    },
    {
      label: 'Call HA service',
      code: `curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"domain":"light","service":"turn_on","service_data":{"entity_id":"light.kitchen"}}' \\
  ${baseUrl}/home/call-service`,
    },
    {
      label: 'Broadcast to speakers',
      code: `curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Dinner is ready"}' \\
  ${baseUrl}/broadcast`,
    },
    {
      label: 'Send email',
      code: `curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"someone@example.com","subject":"Hi","text":"From Janus"}' \\
  ${baseUrl}/email/send`,
    },
    {
      label: 'Update a calendar event',
      code: `curl -X PATCH -H "x-api-key: $EXTERNAL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Dentist (rescheduled)","start":"2026-05-12T14:00:00-07:00","end":"2026-05-12T15:00:00-07:00"}' \\
  ${baseUrl}/calendar/event/EVENT_ID`,
    },
    {
      label: 'Recent activity feed',
      code: `curl -H "x-api-key: $EXTERNAL_API_KEY" \\
  "${baseUrl}/activity?limit=20"`,
    },
    {
      label: 'Invoke a generic tool',
      code: `curl -X POST -H "x-api-key: $EXTERNAL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"query":"weather in Beverly Hills"}' \\
  ${baseUrl}/tools/perplexity_search/invoke`,
    },
  ];

  const readEndpoints = caps?.endpoints?.filter((e) => e.method === 'GET') ?? [];
  const writeEndpoints = caps?.endpoints?.filter((e) => e.method !== 'GET') ?? [];

  return (
    <div className="space-y-6" data-testid="admin-api-content">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Plug className="h-5 w-5 text-primary" />
            <CardTitle>External API</CardTitle>
            {healthy === true && (
              <Badge variant="secondary" className="ml-2 gap-1" data-testid="badge-api-online">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> Online
              </Badge>
            )}
            {healthy === false && (
              <Badge variant="destructive" className="ml-2" data-testid="badge-api-offline">Offline</Badge>
            )}
          </div>
          <CardDescription>
            A read/write HTTP API for sibling apps and integrations (e.g. Janus, automations).
            Single shared API key authentication via the <code className="text-xs">x-api-key</code> header.
            Every request is recorded in the system audit log under{' '}
            <code className="text-xs">source: external_api</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="api-base-url" className="text-xs uppercase tracking-wide text-muted-foreground">Base URL</Label>
            <div className="flex gap-2 mt-1">
              <Input
                id="api-base-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                className="font-mono text-sm"
                data-testid="input-api-base-url"
              />
              <Button onClick={probe} variant="outline" disabled={loading} data-testid="button-probe-api">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Probe'}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              The API is mounted at this path on the same Club 34 server. Use the production URL
              when calling from outside (e.g. <code>https://example.com/api/v1/external</code>).
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <KeyRound className="h-3.5 w-3.5" /> AUTH
              </div>
              <div className="font-mono">x-api-key: $EXTERNAL_API_KEY</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <ShieldCheck className="h-3.5 w-3.5" /> AUDITED
              </div>
              <div>Every call → <code>system_audit_log</code></div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Globe className="h-3.5 w-3.5" /> RATE LIMIT
              </div>
              <div>60 requests / minute (global)</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <LiveActivityPanel />

      <Card>
        <CardHeader>
          <CardTitle>Quick start</CardTitle>
          <CardDescription>
            All requests require the <code>x-api-key</code> header. Responses are JSON shaped as{' '}
            <code>{'{ success, data | error }'}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {curlExamples.map((ex) => (
            <div key={ex.label}>
              <div className="text-xs font-medium text-muted-foreground mb-1">{ex.label}</div>
              <CodeBlock code={ex.code} label={ex.label} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Live capability discovery</CardTitle>
              <CardDescription>
                Paste your API key to fetch the current endpoint and tool catalog directly from the API.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="EXTERNAL_API_KEY"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              className="font-mono text-sm"
              data-testid="input-api-key"
            />
            <Button
              onClick={() => loadCapabilities(apiKeyInput)}
              disabled={!apiKeyInput || loading}
              data-testid="button-load-capabilities"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Load'}
            </Button>
          </div>

          {caps && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-sm mb-2">Read endpoints ({readEndpoints.length})</h4>
                  <ul className="space-y-1.5 text-sm" data-testid="list-read-endpoints">
                    {readEndpoints.map((e) => (
                      <li key={`${e.method}-${e.path}`} className="flex items-start gap-2">
                        <Badge variant="outline" className={`shrink-0 font-mono text-[10px] ${methodColor(e.method)}`}>
                          {e.method}
                        </Badge>
                        <div className="min-w-0">
                          <div className="font-mono text-xs">{e.path}</div>
                          <div className="text-xs text-muted-foreground">{e.description}</div>
                          {e.query && (
                            <div className="text-[10px] font-mono text-muted-foreground/80 mt-0.5">
                              query: {Object.entries(e.query).map(([k, v]) => `${k}:${v.type}${v.required ? '*' : ''}`).join(', ')}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h4 className="font-medium text-sm mb-2">Action endpoints ({writeEndpoints.length})</h4>
                  <ul className="space-y-1.5 text-sm" data-testid="list-action-endpoints">
                    {writeEndpoints.map((e) => (
                      <li key={`${e.method}-${e.path}`} className="flex items-start gap-2">
                        <Badge variant="outline" className={`shrink-0 font-mono text-[10px] ${methodColor(e.method)}`}>
                          {e.method}
                        </Badge>
                        <div className="min-w-0">
                          <div className="font-mono text-xs">{e.path}</div>
                          <div className="text-xs text-muted-foreground">{e.description}</div>
                          {e.body && (
                            <div className="text-[10px] font-mono text-muted-foreground/80 mt-0.5">
                              body: {Object.entries(e.body.properties).map(([k, v]) => `${k}:${v.type}${e.body!.required?.includes(k) ? '*' : ''}`).join(', ')}
                            </div>
                          )}
                          {e.query && (
                            <div className="text-[10px] font-mono text-muted-foreground/80 mt-0.5">
                              query: {Object.entries(e.query).map(([k, v]) => `${k}:${v.type}${v.required ? '*' : ''}`).join(', ')}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div>
                <h4 className="font-medium text-sm mb-2">Generic tools ({caps.tools.length})</h4>
                <p className="text-xs text-muted-foreground mb-2">
                  Each tool can be invoked at <code className="font-mono">POST /tools/{'{name}'}/invoke</code>. The body is validated against the tool's JSON Schema before execution — invalid args return <code>400</code> with the validation errors in <code>detail</code>.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2" data-testid="grid-tools">
                  {caps.tools.map((t) => (
                    <div key={t.name} className="rounded-md border border-border p-2 text-sm">
                      <div className="font-mono text-xs font-medium">{t.name}</div>
                      <div className="text-xs text-muted-foreground line-clamp-2">{t.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit log shape</CardTitle>
          <CardDescription>
            Every successful or failed call is recorded under <code>category: external_api</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <ul className="text-xs space-y-1 text-muted-foreground list-disc pl-5">
            <li><code>event_type</code>: <code>external_api.&lt;endpoint_id&gt;</code></li>
            <li><code>detail.duration_ms</code> — wall-clock time the handler took</li>
            <li><code>detail.request</code> — sanitized + truncated request body (POST/PATCH/DELETE)</li>
            <li><code>detail.query</code> — sanitized query string (when present)</li>
            <li><code>detail.response_preview</code> — sanitized + truncated successful response (helpful for debugging callers)</li>
            <li>Known secret fields (<code>access_token</code>, <code>api_key</code>, <code>password</code>, <code>private_key</code>, <code>credentials</code>, …) are redacted everywhere</li>
            <li>Payloads larger than ~4 KB are truncated with a <code>_truncated: true</code> marker</li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reference</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            See the full reference, error semantics, and example payloads in{' '}
            <a
              href="https://github.com/tonysafoian/club34-home-app-public-home-app-public/blob/main/EXTERNAL_API.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary inline-flex items-center gap-1 hover:underline"
              data-testid="link-external-api-docs"
            >
              EXTERNAL_API.md <ExternalLink className="h-3 w-3" />
            </a>
            .
          </p>
          <p className="text-muted-foreground text-xs">
            Rotate the <code>EXTERNAL_API_KEY</code> environment variable to revoke access. There is
            currently a single shared key — there are no per-app keys.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
