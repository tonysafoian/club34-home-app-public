import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { TeslaBatteryMonitorCard } from '@/components/automations/TeslaBatteryMonitorCard';
import { formatDistanceToNow } from 'date-fns';
import {
  CheckCircle2, XCircle, AlertTriangle, Clock, Play, Loader2,
  RefreshCw, Zap, AlertCircle, ChevronDown, ChevronUp, Radio,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';

// ─── Types ────────────────────────────────────────────────────────────────────

type JobStatus = 'ok' | 'degraded' | 'error' | 'unknown';

interface ScheduledJob {
  name: string;
  label: string;
  schedule: string;
  lastRun: Date | null;
  status: JobStatus;
  detail?: string;
}

interface HealthCheckResult {
  name: string;
  status: 'ok' | 'degraded' | 'error';
  latency_ms: number;
  message?: string;
}

interface HealthLog {
  created_at: string;
  overall_status: string;
  results: unknown;
}

interface FunctionalTestLog {
  created_at: string;
  overall_status: string;
  passed: number;
  failed: number;
  total_ms: number;
}

interface EmailLogRow {
  email_type: string;
  sent_at: string;
  status: string;
}

interface TimestampRow {
  created_at: string;
}

interface FamilyAutomationRow {
  name: string;
  last_run_at: string | null;
  is_active: boolean;
}

interface BroadcastTestResult {
  success: boolean;
  cast_verifications?: Record<string, { verified: boolean }>;
  errors?: string[];
  error?: string;
}

// ─── Self-Healing Alerts ──────────────────────────────────────────────────────

const SELF_HEAL_RULES: Record<string, { title: string; suggestion: string }> = {
  janus_chat: {
    title: 'Janus Chat is slow or unreachable',
    suggestion: 'The janus-chat function may be cold. The prewarm cron should fix this within 5 minutes. If it persists, check the Lovable AI gateway key.',
  },
  janus_whatsapp: {
    title: 'WATI WhatsApp API issue',
    suggestion: 'The WATI access token may be expired. Log into the WATI dashboard, regenerate the token, and update the WATI_ACCESS_TOKEN secret.',
  },
  wati_whatsapp: {
    title: 'WATI WhatsApp API issue',
    suggestion: 'The WATI access token may be expired or the endpoint is wrong. Check WATI_API_ENDPOINT and WATI_ACCESS_TOKEN secrets.',
  },
  gmail_tony: {
    title: 'Gmail (Tony) access failed',
    suggestion: 'The Google Service Account may have lost domain-wide delegation. Check the service account in Google Admin Console and verify delegation for admin@example.com.',
  },
  janus_email: {
    title: 'Gmail (Janus) access failed',
    suggestion: 'Domain-wide delegation for assistant@example.com may have expired. Verify the service account scopes in Google Admin → Security → API Controls.',
  },
  google_calendar: {
    title: 'Google Calendar API failed',
    suggestion: 'The service account may lack Calendar API access for admin@example.com. Check domain-wide delegation scopes include https://www.googleapis.com/auth/calendar.readonly.',
  },
  google_drive: {
    title: 'Google Drive API failed',
    suggestion: 'Drive API delegation may have expired. Verify service account scopes in Google Admin Console.',
  },
  firecrawl: {
    title: 'Firecrawl web search is down',
    suggestion: 'The Firecrawl API key may be invalid or rate-limited. Check the Firecrawl dashboard for quota usage and regenerate the key if needed.',
  },
  notion: {
    title: 'Notion API access failed',
    suggestion: 'The Notion integration token may be expired or revoked. Go to Notion Settings → Integrations and generate a new token, then update NOTION_API_KEY.',
  },
  elevenlabs: {
    title: 'ElevenLabs voice API failed',
    suggestion: 'The ElevenLabs API key may be invalid or the account quota exhausted. Check the ElevenLabs dashboard.',
  },
  ai_gateway: {
    title: 'AI gateway failed',
    suggestion: 'The OPENROUTER_API_KEY may be invalid or rate-limited. This affects all Janus AI responses. Check the key in Admin → Settings.',
  },
  home_assistant: {
    title: 'Home Assistant is unreachable',
    suggestion: 'The Home Assistant instance may be offline or the token expired. Check HA_URL and HA_TOKEN secrets and verify HA is accessible from the internet.',
  },
  google_maps_routes: {
    title: 'Google Maps API failed',
    suggestion: 'The GOOGLE_MAPS_API_KEY may be invalid or the Maps API billing is paused. Check the Google Cloud Console.',
  },
  google_air_quality: {
    title: 'Google Air Quality API failed',
    suggestion: 'The Air Quality API may not be enabled for this project. Enable it in Google Cloud Console → APIs & Services.',
  },
  google_pollen: {
    title: 'Google Pollen API failed',
    suggestion: 'The Pollen API may not be enabled. Enable it in Google Cloud Console → APIs & Services.',
  },
};

// ─── Status Icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status, size = 'sm' }: { status: JobStatus; size?: 'sm' | 'md' }) {
  const cls = size === 'md' ? 'w-5 h-5' : 'w-4 h-4';
  if (status === 'ok') return <CheckCircle2 className={`${cls} text-green-500`} />;
  if (status === 'degraded') return <AlertTriangle className={`${cls} text-yellow-500`} />;
  if (status === 'error') return <XCircle className={`${cls} text-destructive`} />;
  return <Clock className={`${cls} text-muted-foreground`} />;
}

// ─── Job Row ──────────────────────────────────────────────────────────────────

function JobRow({ job }: { job: ScheduledJob }) {
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-0">
      <StatusIcon status={job.status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium font-mono">{job.name}</span>
          {job.label && (
            <span className="text-xs text-muted-foreground hidden sm:inline">{job.label}</span>
          )}
        </div>
        {job.detail && <p className="text-xs text-destructive mt-0.5">{job.detail}</p>}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <Badge variant="outline" className="gap-1 text-xs hidden sm:flex">
          <Clock className="w-3 h-3" />
          {job.schedule}
        </Badge>
        <span className="text-xs text-muted-foreground tabular-nums w-20 text-right">
          {job.lastRun ? formatDistanceToNow(job.lastRun, { addSuffix: true }) : 'Never'}
        </span>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function SystemsTab() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [testingBroadcast, setTestingBroadcast] = useState(false);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [showAllAlerts, setShowAllAlerts] = useState(false);

  // Fetch latest health log
  const { data: latestHealth } = useQuery({
    queryKey: ['systems-health-latest'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<HealthLog>({
        table: 'janus_health_logs',
        select: '*',
        order: { column: 'created_at', ascending: false },
        limit: 1,
      });
      return data;
    },
    refetchInterval: 60_000,
  });

  // Fetch latest functional test log
  const { data: latestFuncTest } = useQuery({
    queryKey: ['systems-functest-latest'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<FunctionalTestLog>({
        table: 'janus_functional_test_logs',
        select: '*',
        order: { column: 'created_at', ascending: false },
        limit: 1,
      });
      return data;
    },
    refetchInterval: 60_000,
  });

  // Fetch last email logs
  const { data: emailLogs } = useQuery({
    queryKey: ['systems-email-logs'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<EmailLogRow[]>({
        table: 'email_logs',
        select: 'email_type, sent_at, status',
        filters: [{ column: 'email_type', op: 'in', value: ['morning_weather', 'executive_status', 'janus_email'] }],
        order: { column: 'sent_at', ascending: false },
        limit: 20,
      });
      return data || [];
    },
    refetchInterval: 120_000,
  });

  // Fetch last Verkada sighting
  const { data: lastVerkada } = useQuery({
    queryKey: ['systems-verkada-latest'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<TimestampRow>({
        table: 'poi_sightings',
        select: 'created_at',
        order: { column: 'created_at', ascending: false },
        limit: 1,
      });
      return data;
    },
  });

  // Fetch last Janus email poll
  const { data: lastEmailPoll } = useQuery({
    queryKey: ['systems-email-poll-latest'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<TimestampRow>({
        table: 'janus_chat_logs',
        select: 'created_at',
        filters: [{ column: 'channel', op: 'eq', value: 'email' }],
        order: { column: 'created_at', ascending: false },
        limit: 1,
      });
      return data;
    },
  });

  // Fetch last Tesla activity
  const { data: lastTesla } = useQuery({
    queryKey: ['systems-tesla-latest'],
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<TimestampRow>({
        table: 'tesla_activity_logs',
        select: 'created_at',
        order: { column: 'created_at', ascending: false },
        limit: 1,
      });
      return data;
    },
  });

  // Fetch family_automations last_run_at for all scheduled automations
  const { data: familyAutomations } = useQuery({
    queryKey: ['systems-family-automations'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<FamilyAutomationRow[]>({
        table: 'family_automations',
        select: 'name, last_run_at, is_active',
      });
      return data || [];
    },
    refetchInterval: 60_000,
  });

  // Build helper to get last email by type
  const getLastEmail = (type: string) => {
    const found = emailLogs?.find((e) => e.email_type === type);
    return found ? new Date(found.sent_at) : null;
  };

  const healthResults: HealthCheckResult[] = latestHealth
    ? (latestHealth.results as unknown as HealthCheckResult[])
    : [];

  const healthStatus = (name: string): JobStatus => {
    const r = healthResults.find((h) => h.name === name);
    return r ? r.status : 'unknown';
  };

  const getAutomationLastRun = (name: string): Date | null => {
    const auto = familyAutomations?.find((a) => a.name === name);
    return auto?.last_run_at ? new Date(auto.last_run_at) : null;
  };

  const getAutomationStatus = (name: string): JobStatus => {
    const auto = familyAutomations?.find((a) => a.name === name);
    if (!auto) return 'unknown';
    if (!auto.last_run_at) return 'unknown';
    return 'ok';
  };

  // Build jobs list
  const jobs: ScheduledJob[] = [
    {
      name: 'morning-weather-email',
      label: 'Morning brief → Emme & Isla',
      schedule: 'Daily 7am PT',
      lastRun: getLastEmail('morning_weather'),
      status: getLastEmail('morning_weather') ? 'ok' : 'unknown',
    },
    {
      name: 'executive-status-email',
      label: 'Daily status report → Tony',
      schedule: 'Daily 8am PT',
      lastRun: getLastEmail('executive_status'),
      status: getLastEmail('executive_status') ? 'ok' : 'unknown',
    },
    {
      name: 'janus-health-check',
      label: 'Checks all 16 Janus APIs',
      schedule: 'Every 4h',
      lastRun: latestHealth ? new Date(latestHealth.created_at) : null,
      status: (latestHealth?.overall_status as JobStatus) || 'unknown',
    },
    {
      name: 'janus-functional-test',
      label: '8 AI test cases across all channels',
      schedule: 'Daily 2am PT',
      lastRun: latestFuncTest ? new Date(latestFuncTest.created_at) : null,
      status: latestFuncTest
        ? latestFuncTest.overall_status === 'ok'
          ? 'ok'
          : latestFuncTest.overall_status === 'partial'
          ? 'degraded'
          : 'error'
        : 'unknown',
    },
    {
      name: 'janus-email-poll',
      label: 'Polls janus@ inbox + triages tony@ inbox',
      schedule: 'Every 1m',
      lastRun: lastEmailPoll ? new Date(lastEmailPoll.created_at) : null,
      status: lastEmailPoll ? 'ok' : 'unknown',
    },
    {
      name: 'janus-reminder-dispatch',
      label: 'Fires due reminders via email/WhatsApp',
      schedule: 'Every 1m',
      lastRun: getAutomationLastRun('janus-reminder-dispatch'),
      status: getAutomationStatus('janus-reminder-dispatch'),
    },
    {
      name: 'verkada-poi-webhook',
      label: 'Real-time Verkada event webhook (POI + alerts)',
      schedule: 'Real-time',
      lastRun: lastVerkada ? new Date(lastVerkada.created_at) : null,
      status: lastVerkada ? 'ok' : 'unknown',
    },
    {
      name: 'travel-email-scanner',
      label: 'Scans inbox for travel confirmations',
      schedule: 'Twice daily',
      lastRun: getAutomationLastRun('travel-email-scanner'),
      status: getAutomationStatus('travel-email-scanner'),
    },
    {
      name: 'tesla-battery-monitor',
      label: 'Checks Tesla battery & sends alerts',
      schedule: 'Every 30m',
      lastRun: lastTesla ? new Date(lastTesla.created_at) : null,
      status: lastTesla ? 'ok' : 'unknown',
    },
    {
      name: 'entertainment-sync',
      label: 'Syncs NBA, concerts, movies',
      schedule: 'Daily 6am PT',
      lastRun: getAutomationLastRun('entertainment-sync'),
      status: getAutomationStatus('entertainment-sync'),
    },
    {
      name: 'media-sync',
      label: 'Syncs streaming media items',
      schedule: 'Daily 6:15am PT',
      lastRun: getAutomationLastRun('media-sync'),
      status: getAutomationStatus('media-sync'),
    },
    {
      name: 'pool-heater-rain-guard',
      label: 'Heaters off if rain, on at 87°F if clear',
      schedule: 'Every 30m',
      lastRun: getAutomationLastRun('pool-heater-rain-guard'),
      status: getAutomationStatus('pool-heater-rain-guard'),
    },
    {
      name: 'printer-health-monitor',
      label: 'Checks printer toner & status, creates Notion tasks',
      schedule: 'Every 30m',
      lastRun: getAutomationLastRun('printer-health-monitor'),
      status: getAutomationStatus('printer-health-monitor'),
    },
    {
      name: 'morning-sauna',
      label: 'Sauna on at 190°F, vacation mode disables',
      schedule: 'MWF 8:30 AM · Tu/Th 8:50 AM PT',
      lastRun: getAutomationLastRun('morning-sauna'),
      status: getAutomationStatus('morning-sauna'),
    },
    {
      name: 'av-closet-temp-monitor',
      label: 'AV Closet temp — email >90°F, WhatsApp Tony >100°F',
      schedule: 'Every 10m',
      lastRun: getAutomationLastRun('AV Closet Temperature Monitor'),
      status: getAutomationStatus('AV Closet Temperature Monitor'),
    },
  ];

  // Compute self-healing alerts from latest health check failures
  const activeAlerts = healthResults
    .filter((r) => r.status === 'error' || r.status === 'degraded')
    .filter((r) => !dismissedAlerts.has(r.name))
    .map((r) => ({ ...r, heal: SELF_HEAL_RULES[r.name] }))
    .filter((r) => r.heal);

  const visibleAlerts = showAllAlerts ? activeAlerts : activeAlerts.slice(0, 3);

  const runTestBroadcast = async () => {
    setTestingBroadcast(true);
    try {
      const data = await apiClient.post<BroadcastTestResult>('/api/broadcast/test-morning', {});
      if (data.success) {
        const verifiedCount = data.cast_verifications
          ? Object.values(data.cast_verifications as Record<string, { verified: boolean }>).filter((v) => v.verified).length
          : null;
        const total = data.cast_verifications ? Object.keys(data.cast_verifications).length : null;
        toast({
          title: 'Test broadcast sent',
          description: verifiedCount !== null
            ? `${verifiedCount}/${total} speakers confirmed playing`
            : 'Sent successfully',
        });
      } else {
        const errSummary = Array.isArray(data.errors) ? data.errors.slice(0, 2).join('; ') : data.error || 'Unknown error';
        toast({
          title: 'Test broadcast failed',
          description: errSummary.slice(0, 120),
          variant: 'destructive',
        });
      }
    } catch (e) {
      toast({ title: 'Error', description: 'Failed to trigger test broadcast', variant: 'destructive' });
    } finally {
      setTestingBroadcast(false);
    }
  };

  // Run all health checks
  const runAllChecks = async () => {
    setRunning(true);
    try {
      const [healthRes, funcRes] = await Promise.allSettled([
        apiClient.invokeFn('janus-health-check'),
        apiClient.invokeFn('janus-functional-test'),
      ]);

      const healthOk = healthRes.status === 'fulfilled';
      const funcOk = funcRes.status === 'fulfilled';

      if (healthOk && funcOk) {
        toast({ title: 'All checks complete', description: 'Results updated' });
      } else if (healthOk || funcOk) {
        toast({ title: 'Partial success', description: 'One check completed, one had issues', variant: 'destructive' });
      } else {
        toast({ title: 'Error', description: 'Both checks failed to run', variant: 'destructive' });
      }

      
      await queryClient.invalidateQueries({ queryKey: ['systems-health-latest'] });
      await queryClient.invalidateQueries({ queryKey: ['systems-functest-latest'] });
    } catch (e) {
      toast({ title: 'Error', description: 'Failed to trigger checks', variant: 'destructive' });
    } finally {
      setRunning(false);
    }
  };

  const overallHealthStatus = (latestHealth?.overall_status as JobStatus) || 'unknown';
  const statusColor = overallHealthStatus === 'ok' ? 'text-green-500' : overallHealthStatus === 'degraded' ? 'text-yellow-500' : overallHealthStatus === 'error' ? 'text-destructive' : 'text-muted-foreground';

  return (
    <div className="space-y-4">
      {/* Self-healing alerts */}
      {activeAlerts.length > 0 && (
        <div className="space-y-2">
          {visibleAlerts.map((alert) => (
            <Alert key={alert.name} variant="destructive" className="border-destructive/40 bg-destructive/5">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle className="text-sm font-semibold flex items-center justify-between">
                <span>{alert.heal.title}</span>
                <button
                  onClick={() => setDismissedAlerts((s) => new Set([...s, alert.name]))}
                  className="text-xs text-muted-foreground hover:text-foreground ml-4"
                >
                  Dismiss
                </button>
              </AlertTitle>
              <AlertDescription className="text-xs mt-1">
                <span className="font-mono text-muted-foreground">{alert.name}</span>
                {alert.message && <span className="ml-2 text-destructive">— {alert.message}</span>}
                <p className="mt-1">{alert.heal.suggestion}</p>
              </AlertDescription>
            </Alert>
          ))}
          {activeAlerts.length > 3 && (
            <button
              onClick={() => setShowAllAlerts(!showAllAlerts)}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              {showAllAlerts ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showAllAlerts ? 'Show fewer' : `Show ${activeAlerts.length - 3} more alerts`}
            </button>
          )}
        </div>
      )}

      {/* Scheduled Jobs */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" />
                Scheduled Jobs
                <Badge
                  variant="outline"
                  className={`text-xs gap-1 ${overallHealthStatus === 'ok' ? 'border-green-500/30 text-green-600' : overallHealthStatus === 'error' ? 'border-destructive/30 text-destructive' : 'border-yellow-500/30 text-yellow-600'}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${overallHealthStatus === 'ok' ? 'bg-green-500' : overallHealthStatus === 'error' ? 'bg-destructive' : 'bg-yellow-500'}`} />
                  {overallHealthStatus === 'ok' ? 'All systems normal' : overallHealthStatus === 'error' ? 'Issues detected' : overallHealthStatus === 'degraded' ? 'Degraded' : 'Status unknown'}
                </Badge>
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                {latestHealth
                  ? `Last health check ${formatDistanceToNow(new Date(latestHealth.created_at), { addSuffix: true })}`
                  : 'No health check data yet'}
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={runAllChecks}
              disabled={running}
              className="gap-1.5 shrink-0"
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              {running ? 'Running…' : 'Run All Checks'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pb-3">
          <div>
            {jobs.map((job) => (
              <JobRow key={job.name} job={job} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Functional test summary */}
      {latestFuncTest && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-primary" />
              Last Functional Test
              <Badge
                variant="outline"
                className={`text-xs ${latestFuncTest.overall_status === 'ok' ? 'border-green-500/30 text-green-600' : latestFuncTest.overall_status === 'fail' ? 'border-destructive/30 text-destructive' : 'border-yellow-500/30 text-yellow-600'}`}
              >
                {latestFuncTest.passed}/{latestFuncTest.passed + latestFuncTest.failed} passed
              </Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              {formatDistanceToNow(new Date(latestFuncTest.created_at), { addSuffix: true })} · {(latestFuncTest.total_ms / 1000).toFixed(0)}s runtime
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* Tesla Battery Monitor */}
      <TeslaBatteryMonitorCard />

      {/* Morning Broadcast Test */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Radio className="w-4 h-4 text-primary" />
                Morning Broadcast
              </CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Trigger a test announcement to Emme's, Isla's, and Tony's office speakers. Bypasses the 6:50am/7:30am schedule and school-year checks.
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={runTestBroadcast}
              disabled={testingBroadcast}
              className="gap-1.5 shrink-0"
              data-testid="button-test-morning-broadcast"
            >
              {testingBroadcast ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
              {testingBroadcast ? 'Broadcasting…' : 'Test Broadcast'}
            </Button>
          </div>
        </CardHeader>
      </Card>
    </div>
  );
}
