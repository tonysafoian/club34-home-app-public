import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Search, RefreshCw, ChevronDown, Clock, AlertTriangle, AlertCircle,
  Info, Zap, Filter, Loader2, ChevronRight, Code, Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, subHours, formatDistanceToNow } from 'date-fns';

const CATEGORIES = [
  'all', 'janus', 'automation', 'email', 'home', 'research',
  'security', 'integration', 'config', 'media',
] as const;

const SEVERITIES = ['all', 'info', 'warn', 'error', 'critical'] as const;

const DATE_RANGES = [
  { label: '1h', hours: 1 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
  { label: '30d', hours: 720 },
] as const;

const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  warn: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  error: 'bg-red-500/15 text-red-400 border-red-500/30',
  critical: 'bg-red-700/20 text-red-300 border-red-700/40',
};

const STATUS_COLORS: Record<string, string> = {
  success: 'text-emerald-400',
  error: 'text-red-400',
  partial: 'text-yellow-400',
  skipped: 'text-muted-foreground',
};

const PAGE_SIZE = 50;

const FRIENDLY_LABELS: Record<string, string> = {
  email: 'Email',
  google_id: 'Google ID',
  apple_sub: 'Apple User ID',
  has_refresh_token: 'Refresh Token Stored',
  target_user_id: 'Target User ID',
  approval_status: 'Approval Status',
  content_length: 'Content Length',
  context_key: 'Context Key',
  run_id: 'Run ID',
  items_count: 'Items Count',
  items_cleared: 'Items Cleared',
  auto_order_delay_hours: 'Auto-Order Delay (hours)',
  item_count: 'Item Count',
  trip_id: 'Trip ID',
  trip_name: 'Trip Name',
  departure_date: 'Departure Date',
  return_date: 'Return Date',
  duration_ms: 'Duration',
  action: 'Action',
  future_counts: 'Future Event Counts',
  gmail_message_id: 'Gmail Message ID',
  snippet: 'Snippet',
  domain: 'Domain',
  reason: 'Reason',
  version: 'Version',
  title: 'Title',
  attempts: 'Retry Attempts',
  stack: 'Stack Trace',
  componentStack: 'Component Stack',
  url: 'URL',
  userAgent: 'User Agent',
  timestamp: 'Timestamp',
  method: 'Method',
  path: 'Path',
  entity_id: 'Entity',
  service_data: 'Service Data',
  status: 'Status',
  entity_count: 'Entity Count',
  requested_count: 'Requested',
  hours: 'Time Range',
  entry_count: 'Entry Count',
  domain_count: 'Domain Count',
  http_status: 'HTTP Status',
  request_bytes: 'Request Size',
  response_bytes: 'Response Size',
  download_mbps: 'Download',
  upload_mbps: 'Upload',
  latency_ms: 'Ping',
  jitter_ms: 'Jitter',
  server_name: 'Server',
  provider: 'Provider',
  record_id: 'Record ID',
  automation_name: 'Automation',
  port: 'Port',
  node_env: 'Environment',
  error: 'Error',
  error_message: 'Error Message',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (key === 'duration_ms' && typeof value === 'number') return formatDuration(value);
  if (key === 'latency_ms' && typeof value === 'number') return `${value.toFixed(0)}ms`;
  if (key === 'jitter_ms' && typeof value === 'number') return `${value.toFixed(0)}ms`;
  if ((key === 'request_bytes' || key === 'response_bytes') && typeof value === 'number') return formatBytes(value);
  if (key === 'download_mbps' && typeof value === 'number') return `${value.toFixed(1)} Mbps ↓`;
  if (key === 'upload_mbps' && typeof value === 'number') return `${value.toFixed(1)} Mbps ↑`;
  if (key === 'hours' && typeof value === 'number') return `${value}h`;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function isVerboseKey(key: string): boolean {
  return ['stack', 'componentStack', 'service_data', 'results', 'detail', 'cast_verifications'].includes(key);
}

interface CastVerification {
  verified: boolean;
  state?: string | null;
  urlMatch?: boolean | null;
}

function parseCastVerifications(
  detail: Record<string, unknown> | null,
): Record<string, CastVerification> | null {
  if (!detail) return null;
  const raw = detail.cast_verifications;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, CastVerification> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      out[k] = {
        verified: Boolean(obj.verified),
        state: typeof obj.state === 'string' ? obj.state : obj.state == null ? null : String(obj.state),
        urlMatch:
          obj.urlMatch === null || obj.urlMatch === undefined
            ? null
            : Boolean(obj.urlMatch),
      };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function castVerificationTone(v: CastVerification): 'ok' | 'warn' | 'error' {
  if (v.verified) return 'ok';
  const state = (v.state || '').toLowerCase();
  if (!state || state === 'unknown') return 'warn';
  if (state === 'playing' || state === 'buffering') return 'warn';
  return 'error';
}

const CAST_TONE_CLASSES: Record<'ok' | 'warn' | 'error', string> = {
  ok: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  warn: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  error: 'bg-red-500/15 text-red-400 border-red-500/30',
};

function CastSummaryBadge({
  verifications,
}: {
  verifications: Record<string, CastVerification>;
}) {
  const total = Object.keys(verifications).length;
  const verified = Object.values(verifications).filter((v) => v.verified).length;
  const tone: 'ok' | 'warn' | 'error' =
    verified === total ? 'ok' : verified === 0 ? 'error' : 'warn';
  return (
    <Badge
      variant="outline"
      className={cn('text-[10px] px-1.5 py-0 gap-1', CAST_TONE_CLASSES[tone])}
      title={`${verified}/${total} speakers confirmed playing`}
      data-testid="badge-cast-verified"
    >
      <Radio className="h-2.5 w-2.5" />
      Cast {verified}/{total}
    </Badge>
  );
}

function hasSilentDropRisk(detail: Record<string, unknown> | null): boolean {
  return detail?.silent_drop_risk === true;
}

const SILENT_DROP_TOOLTIP =
  'Silent-drop risk: speakers loaded the audio but stayed idle at 8s — the broadcast may not have actually been heard.';

function SilentDropBadge() {
  return (
    <Badge
      variant="outline"
      className="text-[10px] px-1.5 py-0 gap-1 bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
      title={SILENT_DROP_TOOLTIP}
      data-testid="badge-silent-drop-risk"
    >
      <AlertTriangle className="h-2.5 w-2.5" />
      Silent-drop risk
    </Badge>
  );
}

function CastVerificationPills({
  verifications,
}: {
  verifications: Record<string, CastVerification>;
}) {
  const entries = Object.entries(verifications);
  return (
    <div className="border-t border-border/40 pt-2">
      <div className="text-foreground/50 font-sans mb-1.5 flex items-center gap-1.5">
        <Radio className="h-3 w-3" />
        Cast playback per speaker
      </div>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([speaker, v]) => {
          const tone = castVerificationTone(v);
          const stateLabel = v.state ? v.state : 'no state';
          return (
            <span
              key={speaker}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px]',
                CAST_TONE_CLASSES[tone],
              )}
              title={`state=${stateLabel}${v.urlMatch === false ? ' · url mismatch' : ''}`}
              data-testid={`pill-cast-${speaker}`}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  tone === 'ok' ? 'bg-emerald-400' : tone === 'warn' ? 'bg-yellow-400' : 'bg-red-400',
                )}
              />
              <span className="font-mono">{speaker}</span>
              <span className="text-foreground/60">{stateLabel}</span>
              {v.urlMatch === false && <span className="text-foreground/60">· url ≠</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function parseDetail(rawDetail: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!rawDetail) return null;
  if (typeof rawDetail === 'object' && !Array.isArray(rawDetail)) return rawDetail;
  if (typeof rawDetail === 'string') {
    try { return JSON.parse(rawDetail); } catch { return null; }
  }
  return null;
}

function ExpandedDetail({ log }: { log: AuditLog }) {
  const [showVerbose, setShowVerbose] = useState(false);
  const [showFullRaw, setShowFullRaw] = useState(false);

  const detail = parseDetail(log.detail);
  const hasDetail = detail !== null && Object.keys(detail).length > 0;
  const castVerifications = parseCastVerifications(detail);

  const prominentKeys = ['status', 'duration_ms', 'error', 'error_message'];
  const verboseKeys = hasDetail ? Object.keys(detail).filter(isVerboseKey) : [];
  const normalKeys = hasDetail ? Object.keys(detail).filter(k => !isVerboseKey(k) && !prominentKeys.includes(k)) : [];

  return (
    <div className="px-3 pb-3 pl-10">
      <div className="rounded-md bg-muted/50 p-3 text-xs overflow-x-auto max-h-96 overflow-y-auto space-y-3">
        {/* Metadata row */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono">
          <div className="text-muted-foreground font-sans">
            <span className="font-medium text-foreground/60">Event type</span>
            <span className="ml-2 text-foreground/80">{log.eventType}</span>
          </div>
          <div className="text-muted-foreground font-sans">
            <span className="font-medium text-foreground/60">Actor</span>
            <span className="ml-2 text-foreground/80">
              {log.actorName || (log.channel === 'cron' || log.channel === 'system' ? 'system' : 'UNKNOWN')}{log.actorRole ? ` (${log.actorRole})` : ''}
            </span>
          </div>
          {log.correlationId && (
            <div className="col-span-2 text-muted-foreground font-sans">
              <span className="font-medium text-foreground/60">Correlation ID</span>
              <span className="ml-2 text-foreground/80 font-mono text-[10px]">{log.correlationId}</span>
            </div>
          )}
        </div>

        {/* Silent-drop risk warning */}
        {hasSilentDropRisk(detail) && (
          <div
            className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-2 text-yellow-400"
            data-testid="note-silent-drop-risk"
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span className="font-sans text-[11px] leading-snug">{SILENT_DROP_TOOLTIP}</span>
          </div>
        )}

        {/* Cast verifications per speaker */}
        {castVerifications && <CastVerificationPills verifications={castVerifications} />}

        {/* Detail fields */}
        {hasDetail && detail !== null && (
          <div className="space-y-1 border-t border-border/40 pt-2">
            {/* Prominent keys first */}
            {prominentKeys.filter(k => detail[k] !== undefined).map(key => (
              <div key={key} className="flex gap-2 items-start">
                <span className="text-foreground/50 w-32 shrink-0 font-sans">{FRIENDLY_LABELS[key] || key}</span>
                <span className={cn('font-mono text-[10px] break-all',
                  key === 'error' || key === 'error_message' ? 'text-red-400' :
                  key === 'duration_ms' ? 'text-blue-400' : 'text-foreground/80'
                )}>
                  {formatDetailValue(key, detail[key])}
                </span>
              </div>
            ))}
            {/* Normal keys */}
            {normalKeys.map(key => (
              <div key={key} className="flex gap-2 items-start">
                <span className="text-foreground/50 w-32 shrink-0 font-sans">{FRIENDLY_LABELS[key] || key.replace(/_/g, ' ')}</span>
                <span className="font-mono text-[10px] break-all text-foreground/80">
                  {formatDetailValue(key, detail[key])}
                </span>
              </div>
            ))}
            {/* Verbose keys behind toggle */}
            {verboseKeys.length > 0 && (
              <div className="pt-1">
                <button
                  onClick={() => setShowVerbose(r => !r)}
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground text-[10px] transition-colors"
                >
                  <Code className="h-3 w-3" />
                  {showVerbose ? 'Hide' : 'Show'} verbose fields ({verboseKeys.join(', ')})
                </button>
                {showVerbose && verboseKeys.map(key => (
                  <div key={key} className="mt-2">
                    <div className="text-foreground/50 font-sans mb-1">{FRIENDLY_LABELS[key] || key.replace(/_/g, ' ')}</div>
                    <pre className="whitespace-pre-wrap break-all text-[10px] text-foreground/80 bg-background/50 rounded p-2">
                      {formatDetailValue(key, detail[key])}
                    </pre>
                  </div>
                ))}
              </div>
            )}
            {/* Full raw JSON toggle */}
            <div className="pt-1 border-t border-border/30">
              <button
                onClick={() => setShowFullRaw(r => !r)}
                className="flex items-center gap-1 text-muted-foreground hover:text-foreground text-[10px] transition-colors"
              >
                <Code className="h-3 w-3" />
                {showFullRaw ? 'Hide' : 'Show'} raw JSON
              </button>
              {showFullRaw && (
                <pre className="mt-2 whitespace-pre-wrap break-all text-[10px] text-foreground/70 bg-background/50 rounded p-2">
                  {JSON.stringify(detail, null, 2)}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* Fallback: non-parseable detail */}
        {!hasDetail && log.detail !== null && (
          <div className="border-t border-border/40 pt-2">
            <pre className="whitespace-pre-wrap break-all text-[10px] text-foreground/80">
              {typeof log.detail === 'string' ? log.detail : JSON.stringify(log.detail, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

interface AuditLog {
  id: string;
  createdAt: string;
  category: string;
  eventType: string;
  severity: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: string | null;
  channel: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
  durationMs: number | null;
  status: string;
  edgeFunction: string | null;
  correlationId: string | null;
}

export function AdminSystemLogsContent() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [activeSeverity, setActiveSeverity] = useState<string>('all');
  const [dateRange, setDateRange] = useState(24); // hours
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [autoRefresh, setAutoRefresh] = useState(false);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['system-audit-logs', searchQuery, activeCategory, activeSeverity, dateRange, page],
    queryFn: async () => {
      const since = subHours(new Date(), dateRange).toISOString();
      const res = await fetch('/api/data/system-audit-logs/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          category: activeCategory,
          severity: activeSeverity,
          since,
          search: searchQuery.trim() || undefined,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        }),
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error('AUTH_REQUIRED');
        if (res.status === 403) throw new Error('INSUFFICIENT_PERMISSIONS');
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error (${res.status})`);
      }
      const result = await res.json();
      return { rows: (result.rows || []) as AuditLog[], count: result.count ?? 0 };
    },
    refetchInterval: autoRefresh ? 10000 : false,
    retry: (failureCount, err) => {
      const msg = (err as Error)?.message;
      if (msg === 'AUTH_REQUIRED' || msg === 'INSUFFICIENT_PERMISSIONS') return false;
      return failureCount < 2;
    },
  });

  const logs = data?.rows ?? [];
  const totalCount = data?.count ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold font-display">System Audit Log</h2>
          <p className="text-xs text-muted-foreground">
            {totalCount.toLocaleString()} events · Immutable, append-only
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className="text-xs"
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1', autoRefresh && 'animate-spin')} />
            {autoRefresh ? 'Live' : 'Auto'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search summary, event type, actor..."
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
          className="pl-9"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {/* Categories */}
        <div className="flex flex-wrap gap-1">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => { setActiveCategory(cat); setPage(0); }}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                activeCategory === cat
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {cat}
            </button>
          ))}
        </div>

        <div className="w-px h-6 bg-border self-center" />

        {/* Severities */}
        <div className="flex gap-1">
          {SEVERITIES.map(sev => (
            <button
              key={sev}
              onClick={() => { setActiveSeverity(sev); setPage(0); }}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                activeSeverity === sev
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {sev}
            </button>
          ))}
        </div>

        <div className="w-px h-6 bg-border self-center" />

        {/* Date range */}
        <div className="flex gap-1">
          {DATE_RANGES.map(r => (
            <button
              key={r.label}
              onClick={() => { setDateRange(r.hours); setPage(0); }}
              className={cn(
                'px-2.5 py-1 rounded-md text-xs font-medium transition-colors',
                dateRange === r.hours
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Logs */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : isError ? (
        <Card className="p-8 text-center" data-testid="audit-logs-error">
          {error?.message === 'AUTH_REQUIRED' ? (
            <>
              <AlertCircle className="h-8 w-8 mx-auto mb-2 text-yellow-500" />
              <p className="text-sm font-medium">Authentication required</p>
              <p className="text-xs text-muted-foreground mt-1">Please log in to view audit logs.</p>
            </>
          ) : error?.message === 'INSUFFICIENT_PERMISSIONS' ? (
            <>
              <AlertCircle className="h-8 w-8 mx-auto mb-2 text-yellow-500" />
              <p className="text-sm font-medium">Admin access required</p>
              <p className="text-xs text-muted-foreground mt-1">You need admin privileges to view system audit logs.</p>
            </>
          ) : (
            <>
              <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-red-500" />
              <p className="text-sm font-medium">Failed to load audit logs</p>
              <p className="text-xs text-muted-foreground mt-1">{error?.message || 'An unexpected error occurred.'}</p>
            </>
          )}
          <Button variant="outline" size="sm" className="mt-4" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1', isFetching && 'animate-spin')} />
            Retry
          </Button>
        </Card>
      ) : logs.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground" data-testid="audit-logs-empty">
          <Filter className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No audit logs found for the current filters.</p>
        </Card>
      ) : (
        <div className="space-y-1">
          {logs.map(log => {
            const isExpanded = expandedIds.has(log.id);
            const SevIcon = log.severity === 'critical' ? AlertCircle
              : log.severity === 'error' ? AlertTriangle
              : log.severity === 'warn' ? AlertTriangle
              : Info;
            const rowCastVerifications = parseCastVerifications(parseDetail(log.detail));

            return (
              <div
                key={log.id}
                className="rounded-lg border border-border/50 bg-card hover:bg-muted/30 transition-colors"
              >
                <button
                  onClick={() => toggleExpanded(log.id)}
                  className="w-full text-left px-3 py-2.5 flex items-start gap-2"
                >
                  <ChevronRight className={cn(
                    'h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform',
                    isExpanded && 'rotate-90'
                  )} />

                  <SevIcon className={cn('h-4 w-4 mt-0.5 shrink-0', 
                    log.severity === 'error' || log.severity === 'critical' ? 'text-red-400' :
                    log.severity === 'warn' ? 'text-yellow-400' : 'text-blue-400'
                  )} />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{log.summary}</span>
                      <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0', SEVERITY_COLORS[log.severity])}>
                        {log.severity}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {log.category}
                      </Badge>
                      {rowCastVerifications && (
                        <CastSummaryBadge verifications={rowCastVerifications} />
                      )}
                      {hasSilentDropRisk(parseDetail(log.detail)) && <SilentDropBadge />}
                      <span className={cn('text-[10px] font-semibold',
                        log.status === 'success' ? 'text-emerald-400' :
                        STATUS_COLORS[log.status] || 'text-muted-foreground'
                      )}>
                        {log.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
                      <span title={format(new Date(log.createdAt), 'MMM d, yyyy h:mm:ss a')}>
                        {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                      </span>
                      <span>by {log.actorName || (log.channel === 'cron' || log.channel === 'system' ? 'system' : 'UNKNOWN')}</span>
                      {log.channel && <span>via {log.channel}</span>}
                      {log.durationMs != null && <span>{formatDuration(log.durationMs)}</span>}
                      {log.edgeFunction && <span className="font-mono text-[10px]">{log.edgeFunction}</span>}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <ExpandedDetail log={log} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
