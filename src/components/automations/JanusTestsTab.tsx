import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow, format } from 'date-fns';
import {
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronUp,
  FlaskConical, Loader2, Play, RefreshCw,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  prompt: string;
  status: 'pass' | 'fail';
  latency_ms: number;
  response_snippet: string;
  reason: string;
}

interface FunctionalTestLog {
  id: string;
  created_at: string;
  overall_status: string;
  total_ms: number;
  passed: number;
  failed: number;
  results: TestResult[];
}

// ─── Test Result Row ──────────────────────────────────────────────────────────

function TestRow({ result }: { result: TestResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-muted/30 transition-colors px-1 rounded"
        onClick={() => setExpanded(!expanded)}
      >
        {result.status === 'pass' ? (
          <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
        ) : (
          <XCircle className="w-4 h-4 text-destructive shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{result.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground tabular-nums">{result.latency_ms}ms</span>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="px-7 pb-3 space-y-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1 font-medium">Prompt sent</p>
            <p className="text-xs bg-muted rounded px-2 py-1 font-mono">{result.prompt}</p>
          </div>
          {result.status === 'fail' && (
            <div>
              <p className="text-xs text-muted-foreground mb-1 font-medium">Failure reason</p>
              <p className="text-xs text-destructive">{result.reason}</p>
            </div>
          )}
          {result.response_snippet && (
            <div>
              <p className="text-xs text-muted-foreground mb-1 font-medium">Response snippet</p>
              <p className="text-xs bg-muted rounded px-2 py-1 leading-relaxed line-clamp-6">
                {result.response_snippet}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── History Row ──────────────────────────────────────────────────────────────

function HistoryRow({ log, isSelected, onClick }: { log: FunctionalTestLog; isSelected: boolean; onClick: () => void }) {
  const total = log.passed + log.failed;
  const pct = total > 0 ? Math.round((log.passed / total) * 100) : 0;
  const dotClass = log.overall_status === 'ok' ? 'bg-green-500' : log.overall_status === 'partial' ? 'bg-yellow-500' : 'bg-destructive';
  const badgeClass = pct === 100 ? 'border-green-500/30 text-green-600' : pct >= 75 ? 'border-yellow-500/30 text-yellow-600' : 'border-destructive/30 text-destructive';

  return (
    <button
      className={`w-full flex items-center gap-3 py-2 text-left border-b border-border/40 last:border-0 hover:bg-muted/30 transition-colors px-1 rounded ${isSelected ? 'bg-muted/50' : ''}`}
      onClick={onClick}
    >
      <div className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />
      <span className="text-xs text-muted-foreground flex-1 text-left">
        {format(new Date(log.created_at), 'MMM d, h:mma')}
      </span>
      <Badge variant="outline" className={`text-xs ${badgeClass}`}>
        {log.passed}/{total}
      </Badge>
      <span className="text-xs text-muted-foreground tabular-nums">{(log.total_ms / 1000).toFixed(0)}s</span>
    </button>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function JanusTestsTab() {
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const { data: logs = [], refetch } = useQuery<FunctionalTestLog[]>({
    queryKey: ['janus-functional-test-logs'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<(Omit<FunctionalTestLog, 'results'> & { results: unknown })[]>({
        table: 'janus_functional_test_logs',
        select: '*',
        order: { column: 'created_at', ascending: false },
        limit: 30,
      });
      return (data || []).map((d) => ({
        ...d,
        results: Array.isArray(d.results) ? (d.results as TestResult[]) : [],
      }));
    },
    refetchInterval: 60_000,
  });

  const latestLog = logs[0] || null;
  const selectedLog = selectedLogId ? logs.find((l) => l.id === selectedLogId) : latestLog;

  const runNow = async () => {
    setRunning(true);
    try {
      await apiClient.invokeFn('janus-functional-test', undefined, { timeoutMs: 120000 });
      toast({ title: 'Functional test complete', description: 'Refreshing results…' });
      await refetch();
    } catch (e) {
      toast({ title: 'Test run failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  };

  const overallBadgeClass = (status: string) => {
    if (status === 'ok') return 'border-green-500/30 text-green-600 bg-green-500/10';
    if (status === 'partial') return 'border-yellow-500/30 text-yellow-600 bg-yellow-500/10';
    return 'border-destructive/30 text-destructive bg-destructive/10';
  };

  return (
    <div className="space-y-4">
      {/* Header card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-primary" />
                Janus Functional Tests
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                9 real AI conversations run daily at 2am PT to validate Janus actually works end-to-end
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={runNow} disabled={running} className="gap-1.5 shrink-0">
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {running ? 'Running…' : 'Run Now'}
            </Button>
          </div>
        </CardHeader>
      </Card>

      {logs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FlaskConical className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No test runs yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Click "Run Now" above or wait for the 2am daily cron to fire.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* History sidebar */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <RefreshCw className="w-3.5 h-3.5" />
                Run History
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="max-h-96 overflow-y-auto">
                {logs.map((log) => (
                  <HistoryRow
                    key={log.id}
                    log={log}
                    isSelected={selectedLog?.id === log.id}
                    onClick={() => setSelectedLogId(log.id === latestLog?.id ? null : log.id)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Selected run detail */}
          <Card className="lg:col-span-2">
            {selectedLog ? (
              <>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <CardTitle className="text-sm flex items-center gap-2">
                        Test Results
                        <Badge variant="outline" className={`text-xs ${overallBadgeClass(selectedLog.overall_status)}`}>
                          {selectedLog.overall_status === 'ok' ? 'All Passed' : selectedLog.overall_status === 'partial' ? 'Partial' : 'Failed'}
                        </Badge>
                      </CardTitle>
                      <CardDescription className="text-xs mt-0.5">
                        {formatDistanceToNow(new Date(selectedLog.created_at), { addSuffix: true })} ·{' '}
                        {selectedLog.passed}/{selectedLog.passed + selectedLog.failed} tests passed ·{' '}
                        {(selectedLog.total_ms / 1000).toFixed(0)}s total
                      </CardDescription>
                    </div>
                    <div className="flex gap-1.5">
                      {selectedLog.results.map((r, i) => (
                        <div
                          key={i}
                          className={`w-2.5 h-2.5 rounded-full ${r.status === 'pass' ? 'bg-green-500' : 'bg-destructive'}`}
                          title={r.name}
                        />
                      ))}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {selectedLog.results.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center">No individual results stored for this run.</p>
                  ) : (
                    <div>
                      {selectedLog.results.map((result, i) => (
                        <TestRow key={i} result={result} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </>
            ) : (
              <CardContent className="py-12 text-center text-muted-foreground">
                <Clock className="w-6 h-6 mx-auto mb-2" />
                <p className="text-sm">Select a run from the history to view details</p>
              </CardContent>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
