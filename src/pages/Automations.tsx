import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useIsMobile } from '@/hooks/use-mobile';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { DashboardNav } from '@/components/dashboard/DashboardNav';
import { MobileBottomNav } from '@/components/dashboard/MobileBottomNav';
import { MobileChipNav, DesktopSidebar } from '@/components/shared/SectionNav';
import type { SectionGroup } from '@/components/shared/SectionNav';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useUserRole } from '@/hooks/useUserRole';
import {
  BatteryLow, Mail, Clock, Droplets, Package,
  Printer, GraduationCap, Flame, Sunrise, Car, Home, Server, Cpu, Zap as ZapIcon, Shield,
  ChevronRight, ArrowLeft, CheckCircle2, XCircle, AlertTriangle, MinusCircle, Activity, CalendarClock, Wifi,
  ShoppingCart, UtensilsCrossed, Apple, Thermometer, Palmtree,
  Leaf, DoorClosed, Bath, Ban, X, Plus, Lock,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { WorkflowTriggersSection } from '@/components/automations/WorkflowTriggersSection';
import { ThermostatsSection } from '@/components/automations/ThermostatsSection';
import { format, formatDistanceToNow } from 'date-fns';

// ── Routine definitions with metadata for the detail view ──

interface RoutineDefinition {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  frequency: string;
  edgeFunction: string;
  trigger: string;
  actions: string[];
  category: string;
  // When set, this routine is backed by a row in family_automations and shows
  // a Vacation mode toggle that pauses/resumes it (matches the Morning Sauna pattern).
  automationName?: string;
  // When true, the detail panel shows an admin-editable "Excluded rooms & lights"
  // list stored in the automation row's config.excluded_terms (substring match).
  supportsExclusions?: boolean;
}

const ROUTINES: RoutineDefinition[] = [
  {
    id: 'school-broadcast',
    title: 'Morning School & Family Wake-Up',
    description: 'School calendar sync + 6:50am & 7:30am wake-up broadcasts',
    icon: GraduationCap,
    frequency: 'Weekdays 6:50 AM & 7:30 AM',
    edgeFunction: 'school-morning-broadcast',
    trigger: 'Cron: weekdays at 6:50 AM & 7:30 AM PT',
    actions: ['Check school calendar', 'Add a rotating encouragement and practical weather guidance', 'Broadcast to bedroom speakers via HA'],
    category: 'morning',
    automationName: 'Morning School & Family Wake-Up',
  },
  {
    id: 'morning-email',
    title: 'Morning Brief Email',
    description: 'Weather, news, markets & calendar digest',
    icon: Mail,
    frequency: 'Daily 7:00 AM',
    edgeFunction: 'morning-weather-email',
    trigger: 'Cron: daily at 7:00 AM PT',
    actions: ['Fetch weather forecast', 'Fetch Google Calendar events', 'Compile & send email digest'],
    category: 'morning',
    automationName: 'Morning Brief Email',
  },
  {
    id: 'morning-sauna',
    title: 'Morning Sauna',
    description: 'Runs the sauna at 190\u00b0F for 30 minutes every weekday morning',
    icon: Flame,
    frequency: 'MWF 8:30–9:00 AM · Tu/Th 8:50–9:20 AM',
    edgeFunction: 'morning-sauna',
    trigger: 'Cron: Mon/Wed/Fri 8:30–9:00 AM PT · Tue/Thu 8:50–9:20 AM PT',
    actions: [
      'Check vacation mode before scheduled start',
      'Force-toggle HA input_boolean.sauna_power off→on',
      'Set HA input_number.sauna_target_temp to 190°F',
      'Turn off HA input_boolean.sauna_power after 30 minutes',
    ],
    category: 'morning',
  },
  {
    id: 'tesla-battery',
    title: 'Tesla Battery Monitor',
    description: 'Alerts staff when range \u2264 100 mi & vehicle is at home',
    icon: BatteryLow,
    frequency: 'Every 30 min',
    edgeFunction: 'tesla-battery-monitor',
    trigger: 'Cron: every 30 minutes',
    actions: ['Fetch vehicle data from Tesla API', 'Check battery range threshold', 'Create alert record', 'Send WhatsApp notification'],
    category: 'vehicles',
  },
  {
    id: 'tesla-trip-tracker',
    title: 'Tesla Trip Tracker',
    description: 'WhatsApp alert when either car starts or stops driving, with location',
    icon: Car,
    frequency: 'Every 30 min',
    edgeFunction: 'tesla-battery-monitor',
    trigger: 'Cron: every 30 minutes (shared with battery monitor)',
    actions: ['Fetch drive_state from Tesla API', 'Detect driving start/stop transition', 'Reverse geocode location', 'WhatsApp admin with location'],
    category: 'vehicles',
  },
  {
    id: 'pool-rain-guard',
    title: 'Pool Heater Rain Guard',
    description: 'Turns off heaters when rain is expected, restores to 87\u00b0F when clear',
    icon: Droplets,
    frequency: 'Every 30 min',
    edgeFunction: 'pool-heater-rain-guard',
    trigger: 'Cron: every 30 minutes',
    actions: ['Fetch weather forecast from Open-Meteo', 'Evaluate rain probability', 'Call HA to toggle pool/spa heaters', 'Set climate target temperature'],
    category: 'home',
  },
  {
    id: 'spa-mode-alert',
    title: 'Spa Mode 12 Hour Alert',
    description: 'Email estate team and admin when the pool has been left on SPA mode for more than 12 hours',
    icon: Flame,
    frequency: 'Every 30 min',
    edgeFunction: 'spa-mode-monitor',
    trigger: 'Cron: every 30 minutes',
    actions: ['Poll spa pump state from HA', 'Evaluate if pump has been on for >12 hours', 'Email estate managers & admin if threshold exceeded'],
    category: 'home',
  },
  {
    id: 'package-arrival',
    title: 'Package Arrival Monitor',
    description: 'WhatsApp admin, email estate managers, archive notification from inbox',
    icon: Package,
    frequency: 'Every 5 min',
    edgeFunction: 'package-arrival-monitor',
    trigger: 'Cron: every 5 minutes',
    actions: ['Search Gmail for unread package delivery emails', 'WhatsApp admin with details', 'Email estate managers', 'Archive email from inbox'],
    category: 'home',
  },
  {
    id: 'printer-health',
    title: 'Printer Health Monitor',
    description: 'Monitors HP printers (toner, status) and Bambu Lab 3D printers (errors, temps) — creates Notion tasks when attention needed',
    icon: Printer,
    frequency: 'Every 30 min',
    edgeFunction: 'printer-health-monitor',
    trigger: 'Cron: every 30 minutes',
    actions: ['Read HP & Bambu Lab entities from HA', 'Check toner levels & 3D printer status', 'Detect temp anomalies & print errors', 'Deduplicate against recent alerts', 'Create Notion task if attention needed'],
    category: 'office',
  },
  {
    id: 'internet-health',
    title: 'Internet Health Monitor',
    description: 'Monitors Spectrum internet via HA Speedtest — alerts on outages, degraded speed, or high latency',
    icon: Wifi,
    frequency: 'Every 15 min',
    edgeFunction: 'internet-health-monitor',
    trigger: 'Cron: every 15 minutes',
    actions: ['Read speedtest_download/upload/ping from HA', 'Check FortiGate WAN link status (down/offline only, not unavailable)', 'Evaluate speed & latency thresholds (DL<100, UL<30, Ping>50)', 'Deduplicate within 60-min window', 'Create Notion task if degraded or down'],
    category: 'network',
  },
  {
    id: 'ha-server-health',
    title: 'HA Server Health Monitor',
    description: 'Emails administrator when CPU or RAM stay critically high for 15+ minutes',
    icon: Cpu,
    frequency: 'Every 5 min',
    edgeFunction: 'ha-server-health-monitor',
    trigger: 'Cron: every 5 minutes',
    actions: ['Read system_monitor entities from HA', 'Evaluate CPU/RAM/swap thresholds', 'Send email alert if sustained-high'],
    category: 'server',
  },
  {
    id: 'verkada-poi-sync',
    title: 'Verkada POI Sync',
    description: 'Syncs Person of Interest detections from Verkada API to fill webhook gaps',
    icon: Shield,
    frequency: 'Every 5 min',
    edgeFunction: 'verkada-poi-sync',
    trigger: 'Cron: every 5 minutes',
    actions: ['Authenticate with Verkada API', 'Fetch POI profiles list', 'Fetch recent POI alerts (10-min window)', 'Upsert to poi_profiles & poi_sightings'],
    category: 'security',
  },
  {
    id: 'ha-locks-monitor',
    title: 'Door Locks & Battery Monitor',
    description: 'Monitors door locks for low battery (<20%), offline status, or jammed locks — alerts via WhatsApp',
    icon: Lock,
    frequency: 'Every 4 hours',
    edgeFunction: 'ha-locks-monitor',
    trigger: 'Cron: every 4 hours',
    actions: [
      'Query all lock entities and battery telemetry from Home Assistant',
      'Verify connection status and online availability',
      'Evaluate battery percentage (<20% warning, <10% critical) if reported',
      'Detect jammed or offline lock states',
      'Deduplicate alerts within 24-hour window',
      'Send WhatsApp alert to admin if attention needed',
    ],
    category: 'security',
  },
  {
    id: 'calendar-nav-tesla',
    title: 'Calendar Nav to Tesla',
    description: 'Sends meeting locations to vehicle navigation 15 min before events',
    icon: CalendarClock,
    frequency: 'Every 5 min',
    edgeFunction: 'calendar-nav-tesla',
    trigger: 'Cron: every 5 minutes',
    actions: ['Fetch Google Calendar events starting in 10-20 min', 'Filter events with location/address', 'Deduplicate via audit log', 'Wake vehicle Tesla', 'Send navigation_request with address', 'WhatsApp confirmation to driver'],
    category: 'calendar',
  },
  {
    id: 'gym-thermostat',
    title: 'Gym Timer & Temperature',
    description: 'AC on 6 AM–3 PM daily at 68°F cool / 64°F heat. Alerts if temp out of range.',
    icon: Thermometer,
    frequency: 'Every 15 min',
    edgeFunction: 'thermostat-monitor',
    trigger: 'Cron: every 15 minutes (PT timezone)',
    actions: [
      'Poll all climate entities from HA (excluding pool/spa)',
      'Log readings to thermostat_logs table',
      'Enforce 6 AM–3 PM PT schedule for Gym AC (cool 68°F / heat 64°F)',
      'Send email alert via sendMonitorAlert if temp outside 64–68°F band',
    ],
    category: 'thermostats',
  },
  {
    id: 'theater-thermostat',
    title: 'Theater Timer & Temperature',
    description: 'Heat 66°F / Cool 72°F (dual auto) from 10 AM–11 PM daily. Off otherwise.',
    icon: Thermometer,
    frequency: 'Every 15 min',
    edgeFunction: 'thermostat-monitor',
    trigger: 'Cron: every 15 minutes (PT timezone)',
    actions: [
      'Enforce heat_cool mode on Theater 10 AM–11 PM PT (heat 66°F / cool 72°F)',
      'Turn Theater HVAC off outside the 10 AM–11 PM window',
      'After a 30-minute startup grace period, email if temp remains outside 66–72°F',
    ],
    category: 'thermostats',
  },
  {
    id: 'av-closet-temp-monitor',
    title: 'AV Closet Temperature Monitor',
    description: 'Emails admin & staff over 90°F; WhatsApps admin over 100°F.',
    icon: Thermometer,
    frequency: 'Every 10 min',
    edgeFunction: 'av-closet-temp-monitor',
    trigger: 'Cron: every 10 minutes (PT timezone)',
    actions: [
      'Read the AV Closet temperature sensor from HA',
      'Email admin & staff if temp is above 90°F (2h dedup)',
      'WhatsApp admin from Janus if temp is above 100°F (2h dedup)',
    ],
    category: 'thermostats',
  },
  {
    id: 'time-worker-digest',
    title: 'Worker Daily Digest',
    description: 'Emails workers whose time entries were approved or rejected that day',
    icon: Mail,
    frequency: 'Mon–Sat 6:00 PM',
    edgeFunction: 'time-worker-digest',
    trigger: 'Cron: Mon–Sat at 6:00 PM PT',
    actions: ['Find workers with entry status changes today', 'Build per-worker approved/rejected summary', 'Email each worker their status update'],
    category: 'time-tracking',
    automationName: 'Time Worker Daily Digest',
  },
  {
    id: 'time-admin-pending-digest',
    title: 'Admin Pending Digest',
    description: 'Emails admins a summary of workers with pending time entries awaiting approval',
    icon: Clock,
    frequency: 'Mon–Sat 7:00 AM',
    edgeFunction: 'time-admin-pending-digest',
    trigger: 'Cron: Mon–Sat at 7:00 AM PT',
    actions: ['Query pending time entries grouped by worker', 'Skip if nothing is pending', 'Email admins the pending-approvals summary'],
    category: 'time-tracking',
    automationName: 'Time Admin Pending Digest',
  },
  {
    id: 'time-weekly-closeout',
    title: 'Weekly Close-Out',
    description: "Emails admins last week's hours, ready-to-pay and still-pending totals",
    icon: CalendarClock,
    frequency: 'Mon 7:00 AM',
    edgeFunction: 'time-weekly-closeout',
    trigger: 'Cron: Monday at 7:00 AM PT',
    actions: ["Summarize last week's hours per worker", 'Compute ready-to-pay vs still-pending amounts', 'Email admins the weekly close-out'],
    category: 'time-tracking',
    automationName: 'Time Weekly Close-Out',
  },
  {
    id: 'energy-fountains-off',
    title: 'Fountains Off at 9 PM',
    description: 'Turns off all three fountain lights at 9:00 PM every night',
    icon: Droplets,
    frequency: 'Daily 9:00 PM',
    edgeFunction: 'energy-fountains-off',
    trigger: 'Cron: daily at 9:00 PM PT',
    actions: ['Find every light labeled "Fountain" in Home Assistant', 'Turn off any that are still on', 'Log which fountains were turned off'],
    category: 'energy-savings',
    automationName: 'Fountains Off at 9 PM',
  },
  {
    id: 'energy-closet-timer',
    title: 'Closet Light Timer',
    description: 'Turns off any closet light left on for more than 30 minutes',
    icon: DoorClosed,
    frequency: 'Checks every 5 min',
    edgeFunction: 'energy-closet-timer',
    trigger: 'Cron: every 5 minutes',
    actions: ['Find every light labeled "Closet" (water closets count as bathrooms)', 'Skip any light on the exclusion list', 'Check how long each has been on', 'Turn off any on longer than 30 minutes'],
    category: 'energy-savings',
    automationName: 'Closet Light Timer',
    supportsExclusions: true,
  },
  {
    id: 'energy-bathroom-timer',
    title: 'Bathroom Light Timer',
    description: 'Bathroom lights off after 15 min — Primary Bath gets 1 hour',
    icon: Bath,
    frequency: 'Checks every 5 min',
    edgeFunction: 'energy-bathroom-timer',
    trigger: 'Cron: every 5 minutes',
    actions: ['Find every bathroom, powder room & water closet light', 'Skip any light on the exclusion list', 'Check how long each has been on', 'Turn off after 15 minutes (Primary Bath: 1 hour)'],
    category: 'energy-savings',
    automationName: 'Bathroom Light Timer',
    supportsExclusions: true,
  },
];

// ── Shared Log Entry Row ──

interface LogEntry {
  id: string;
  created_at: string;
  event_type: string;
  severity: string;
  summary: string;
  status: string;
  duration_ms: number | null;
  detail: unknown;
  edge_function?: string | null;
}

function LogEntryRow({ entry, showFunction }: { entry: LogEntry; showFunction?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-2 py-2 rounded hover:bg-muted/30 text-xs">
      {entry.status === 'success' ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500 mt-0.5 shrink-0" />
      ) : entry.status === 'error' ? (
        <XCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
      ) : entry.status === 'skipped' ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <MinusCircle className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>Skipped — integration not configured</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 mt-0.5 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{entry.summary}</p>
        <p className="text-muted-foreground">
          {format(new Date(entry.created_at), 'MMM d, h:mm a')}
          {entry.duration_ms != null && ` \u00b7 ${entry.duration_ms}ms`}
          {showFunction && entry.edge_function && ` \u00b7 ${entry.edge_function}`}
        </p>
      </div>
      <Badge
        variant="outline"
        className={`text-[10px] shrink-0 ${
          entry.severity === 'error' ? 'border-destructive/30 text-destructive' :
          entry.severity === 'warning' ? 'border-yellow-500/30 text-yellow-500' :
          'border-primary/30 text-primary'
        }`}
      >
        {entry.severity}
      </Badge>
    </div>
  );
}

// ── Section Recent Log ──

function SectionRecentLog({ edgeFunctions }: { edgeFunctions: string[] }) {
  const { data: logs, isLoading } = useQuery({
    queryKey: ['section-logs', edgeFunctions],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<LogEntry[]>({
        table: 'system_audit_log',
        select: '*',
        filters: [{ column: 'edge_function', op: 'in', value: edgeFunctions }],
        order: { column: 'created_at', ascending: false },
        limit: 25,
      });
      return data ?? [];
    },
    staleTime: 60_000,
    enabled: edgeFunctions.length > 0,
  });

  if (edgeFunctions.length === 0) return null;

  return (
    <Card className="mt-4">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Recent Log
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded" />
            ))}
          </div>
        ) : !logs || logs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No log entries yet for this section.
          </p>
        ) : (
          <div className="space-y-1">
            {logs.map((entry) => (
              <LogEntryRow key={entry.id} entry={entry} showFunction={edgeFunctions.length > 1} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Time Tracking Audit Trail (category-filtered) ──

function TimeTrackingAuditLog() {
  const { data: logs, isLoading } = useQuery({
    queryKey: ['time-tracking-audit-log'],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<LogEntry[]>({
        table: 'system_audit_log',
        select: '*',
        filters: [{ column: 'category', op: 'eq', value: 'time_tracking' }],
        order: { column: 'created_at', ascending: false },
        limit: 25,
      });
      return data ?? [];
    },
    staleTime: 60_000,
  });

  return (
    <Card className="mt-4" data-testid="card-time-tracking-audit">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Time Tracking Activity
        </CardTitle>
        <CardDescription className="text-xs">
          Entries created, approved & rejected, payments marked, workers added — the full time tracking audit trail.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 rounded" />
            ))}
          </div>
        ) : !logs || logs.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-no-time-tracking-events">
            No time tracking activity yet.
          </p>
        ) : (
          <div className="space-y-1">
            {logs.map((entry) => (
              <LogEntryRow key={entry.id} entry={entry} showFunction />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Excluded rooms & lights (light-timer routines) ──

/** Normalize config.excluded_terms into a clean lowercase string list. */
function readExcludedTerms(config: Record<string, unknown> | null | undefined): string[] {
  const raw = config && typeof config === 'object' ? config.excluded_terms : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is string => typeof t === 'string')
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0);
}

function ExclusionsCard({
  routine,
  automation,
}: {
  routine: RoutineDefinition;
  automation: { id: string; is_active: boolean; config: Record<string, unknown> | null } | null;
}) {
  const { isAdmin } = useUserRole();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newTerm, setNewTerm] = useState('');
  const [saving, setSaving] = useState(false);

  const terms = readExcludedTerms(automation?.config);

  const saveTerms = async (next: string[], successTitle: string) => {
    if (!automation) return;
    setSaving(true);
    try {
      // Scoped admin-only endpoint — server-side role check + audit log
      // (the generic db proxy rejects non-admin config writes).
      await apiClient.request('/api/energy/exclusions', {
        method: 'PUT',
        body: { automationName: routine.automationName, excludedTerms: next },
      });
      queryClient.invalidateQueries({ queryKey: ['routine-automation', routine.automationName] });
      toast({ title: successTitle });
    } catch (err) {
      toast({ title: 'Failed to update exclusions', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const addTerm = () => {
    const term = newTerm.trim().toLowerCase();
    if (!term) return;
    if (terms.includes(term)) {
      toast({ title: `"${term}" is already excluded` });
      setNewTerm('');
      return;
    }
    setNewTerm('');
    saveTerms([...terms, term], `Excluded "${term}" from this timer`);
  };

  const removeTerm = (term: string) => {
    saveTerms(terms.filter(t => t !== term), `"${term}" is covered by this timer again`);
  };

  return (
    <Card data-testid="card-timer-exclusions">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Ban className="h-4 w-4 text-muted-foreground" />
          Excluded rooms & lights
        </CardTitle>
        <CardDescription className="text-xs">
          Lights whose name contains any of these words are skipped by this timer
          (e.g. &quot;powder&quot; keeps powder room on as long as needed).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {terms.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="text-no-exclusions">
            No exclusions — this timer covers every matching light.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {terms.map(term => (
              <Badge key={term} variant="secondary" className="gap-1 text-xs font-normal" data-testid={`badge-exclusion-${term}`}>
                {term}
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => removeTerm(term)}
                    disabled={saving}
                    className="ml-0.5 rounded-full hover:text-destructive disabled:opacity-50"
                    aria-label={`Remove "${term}" from exclusions`}
                    data-testid={`button-remove-exclusion-${term}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Badge>
            ))}
          </div>
        )}
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Input
              value={newTerm}
              onChange={(e) => setNewTerm(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTerm(); } }}
              placeholder='Room or light name (e.g. "powder" or "guest bath")'
              className="h-8 text-xs"
              disabled={saving || !automation}
              data-testid="input-new-exclusion"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1 shrink-0"
              onClick={addTerm}
              disabled={saving || !automation || newTerm.trim().length === 0}
              data-testid="button-add-exclusion"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          </div>
        )}
        {!isAdmin && (
          <p className="text-[10px] text-muted-foreground">Only admins can edit this list.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Routine Detail Panel ──

function RoutineDetailPanel({ routine, onBack }: { routine: RoutineDefinition; onBack: () => void }) {
  const Icon = routine.icon;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [togglingVacation, setTogglingVacation] = useState(false);

  // Vacation mode (for routines backed by a family_automations row)
  const { data: automation } = useQuery({
    queryKey: ['routine-automation', routine.automationName],
    enabled: !!routine.automationName,
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await apiClient.dbMaybeSingle<{ id: string; is_active: boolean; config: Record<string, unknown> | null }>({
        table: 'family_automations',
        select: 'id, is_active, config',
        filters: [{ column: 'name', op: 'eq', value: routine.automationName! }],
      });
      return data;
    },
  });

  const vacationMode = automation ? !automation.is_active : false;

  const toggleVacation = async () => {
    if (!automation) return;
    setTogglingVacation(true);
    try {
      const newActive = !automation.is_active;
      await apiClient.dbUpdate('family_automations', { is_active: newActive }, [
        { column: 'id', op: 'eq', value: automation.id },
      ]);
      queryClient.invalidateQueries({ queryKey: ['routine-automation', routine.automationName] });
      toast({ title: newActive ? 'Vacation mode off — automation resumed' : 'Vacation mode on — automation paused' });
    } catch (err) {
      toast({ title: 'Failed to update vacation mode', description: err instanceof Error ? err.message : undefined, variant: 'destructive' });
    } finally {
      setTogglingVacation(false);
    }
  };

  // Fetch recent audit log entries for this routine's edge function
  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey: ['routine-logs', routine.edgeFunction],
    queryFn: async () => {
      const { data } = await apiClient.dbQuery<Array<{
        id: string;
        created_at: string;
        event_type: string;
        severity: string;
        summary: string;
        status: string;
        duration_ms: number | null;
        detail: unknown;
      }>>({
        table: 'system_audit_log',
        select: '*',
        filters: [{ column: 'edge_function', op: 'eq', value: routine.edgeFunction }],
        order: { column: 'created_at', ascending: false },
        limit: 25,
      });
      return data ?? [];
    },
    staleTime: 60_000,
  });

  const successCount = logs?.filter(l => l.status === 'success').length ?? 0;
  const errorCount = logs?.filter(l => l.status === 'error').length ?? 0;
  const lastRun = logs?.[0];

  return (
    <div className="space-y-4">
      {/* Header with back button */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold">{routine.title}</h3>
          <p className="text-xs text-muted-foreground">{routine.description}</p>
        </div>
      </div>

      {/* Health summary */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{successCount}</p>
            <p className="text-[10px] text-muted-foreground font-medium">Successes</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{errorCount}</p>
            <p className="text-[10px] text-muted-foreground font-medium">Errors</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-foreground">
              {lastRun ? formatDistanceToNow(new Date(lastRun.created_at), { addSuffix: true }).replace('about ', '') : '—'}
            </p>
            <p className="text-[10px] text-muted-foreground font-medium">Last Run</p>
          </CardContent>
        </Card>
      </div>

      {/* Vacation mode toggle (routines backed by a family_automations row) */}
      {routine.automationName && (
        <Card className={vacationMode ? 'border-amber-500/40 bg-amber-500/5' : undefined}>
          <CardContent className="p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Palmtree className={`h-5 w-5 shrink-0 ${vacationMode ? 'text-amber-500' : 'text-muted-foreground'}`} />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Vacation mode</p>
                  <p className="text-xs text-muted-foreground">
                    {vacationMode ? "Paused — this routine won't run" : 'Active — running on schedule'}
                  </p>
                </div>
              </div>
              <Switch
                checked={vacationMode}
                onCheckedChange={() => toggleVacation()}
                disabled={togglingVacation || !automation}
                data-testid="switch-vacation-mode"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Excluded rooms & lights (admin-editable, stored in config.excluded_terms) */}
      {routine.supportsExclusions && (
        <ExclusionsCard routine={routine} automation={automation ?? null} />
      )}

      {/* Trigger & Actions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-1">Trigger</p>
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-primary" />
              <span>{routine.trigger}</span>
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-1">Edge Function</p>
            <Badge variant="outline" className="font-mono text-xs">{routine.edgeFunction}</Badge>
          </div>
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-1">Actions</p>
            <ol className="list-decimal list-inside space-y-0.5 text-xs text-muted-foreground">
              {routine.actions.map((action, i) => (
                <li key={i}>{action}</li>
              ))}
            </ol>
          </div>
        </CardContent>
      </Card>

      {/* Recent Logs */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Recent Log
          </CardTitle>
        </CardHeader>
        <CardContent>
          {logsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 rounded" />
              ))}
            </div>
          ) : !logs || logs.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No log entries yet for this routine.
            </p>
          ) : (
            <div className="space-y-1">
              {logs.map((entry) => (
                <LogEntryRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Clickable Routine Card ──

function RoutineCard({ routine, onClick }: { routine: RoutineDefinition; onClick: () => void }) {
  const Icon = routine.icon;
  return (
    <Card
      className="cursor-pointer hover:bg-muted/40 transition-colors group"
      onClick={onClick}
    >
      <CardHeader className="py-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center shrink-0">
              <Icon className="w-5 h-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{routine.title}</CardTitle>
              <CardDescription className="text-xs">{routine.description}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="gap-1 text-xs"><Clock className="h-3 w-3" />{routine.frequency}</Badge>
            <Badge variant="outline" className="border-primary/30 text-primary text-xs">Active</Badge>
            <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

// ── Page ──

const AUTOMATION_GROUPS: SectionGroup[] = [
  {
    group: 'Scheduled',
    items: [
      { id: 'morning', label: 'Morning Routines', icon: Sunrise },
      { id: 'time-tracking', label: 'Time Tracking', icon: Clock },
      { id: 'energy-savings', label: 'Energy Savings', icon: Leaf },
    ],
  },
  {
    group: 'Monitors',
    items: [
      { id: 'vehicles', label: 'Vehicles', icon: Car },
      { id: 'home', label: 'Home & Pool', icon: Home },
      { id: 'office', label: 'Office', icon: Printer },
      { id: 'network', label: 'Network', icon: Wifi },
      { id: 'server', label: 'Server', icon: Server },
      { id: 'security', label: 'Security', icon: Shield },
      { id: 'calendar', label: 'Calendar', icon: CalendarClock },
      { id: 'thermostats', label: 'Thermostats', icon: Thermometer },
    ],
  },
  {
    group: 'Workflow Triggers',
    items: [
      { id: 'workflows', label: 'Workflow Triggers', icon: ZapIcon },
    ],
  },
  {
    group: 'Common Tasks',
    items: [
      { id: 'amazon-order', label: 'Find Something on Amazon & Order', icon: ShoppingCart },
    ],
  },
];

const COMMON_TASK_ROUTES: Record<string, string> = {
  'amazon-order': '/common-tasks/amazon',
};

export default function Automations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const activeSection = searchParams.get('section') || 'morning';
  const [selectedRoutine, setSelectedRoutine] = useState<string | null>(null);

  const allItems = AUTOMATION_GROUPS.flatMap(g => g.items);
  const activeLabel = allItems.find(i => i.id === activeSection)?.label ?? 'Automations';

  function setSection(id: string) {
    const route = COMMON_TASK_ROUTES[id];
    if (route) {
      navigate(route);
      return;
    }
    setSelectedRoutine(null);
    setSearchParams({ section: id });
  }

  const routinesForSection = ROUTINES.filter(r => r.category === activeSection);
  const activeRoutine = selectedRoutine ? ROUTINES.find(r => r.id === selectedRoutine) : null;

  const content = activeSection === 'workflows' ? (
    <WorkflowTriggersSection />
  ) : activeSection === 'thermostats' && !activeRoutine ? (
    <div>
      <div className="mb-4">
        <h3
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2"
          data-testid="heading-thermostat-schedules"
        >
          Thermostat Schedules
        </h3>
        <div className="space-y-2">
          {routinesForSection.map(routine => (
            <RoutineCard key={routine.id} routine={routine} onClick={() => setSelectedRoutine(routine.id)} />
          ))}
        </div>
      </div>
      <ThermostatsSection />
      <SectionRecentLog edgeFunctions={['thermostat-monitor', 'av-closet-temp-monitor']} />
    </div>
  ) : activeSection === 'time-tracking' && !activeRoutine ? (
    <div>
      <div className="space-y-3">
        {routinesForSection.map(routine => (
          <RoutineCard key={routine.id} routine={routine} onClick={() => setSelectedRoutine(routine.id)} />
        ))}
      </div>
      <TimeTrackingAuditLog />
    </div>
  ) : activeRoutine ? (
    <RoutineDetailPanel routine={activeRoutine} onBack={() => setSelectedRoutine(null)} />
  ) : (
    <div>
      <div className="space-y-3">
        {routinesForSection.length > 0 ? (
          routinesForSection.map(routine => (
            <RoutineCard key={routine.id} routine={routine} onClick={() => setSelectedRoutine(routine.id)} />
          ))
        ) : (
          <p className="text-muted-foreground text-sm">No routines configured for this section yet.</p>
        )}
      </div>
      <SectionRecentLog edgeFunctions={routinesForSection.map(r => r.edgeFunction)} />
    </div>
  );

  return (
    <div className="min-h-screen bg-background pb-16 md:pb-0">
      <DashboardHeader />
      <DashboardNav />

      {isMobile && (
        <MobileChipNav groups={AUTOMATION_GROUPS} activeSection={activeSection} onSectionChange={setSection} />
      )}

      <div className="flex">
        {!isMobile && (
          <DesktopSidebar groups={AUTOMATION_GROUPS} activeSection={activeSection} onSectionChange={setSection} />
        )}

        <ErrorBoundary name="automations">
        <main className="flex-1 min-w-0 container py-6 px-3 md:px-4">
          {!activeRoutine && <h2 className="text-lg font-semibold mb-4">{activeLabel}</h2>}
          {content}
        </main>
        </ErrorBoundary>
      </div>
      <MobileBottomNav />
    </div>
  );
}
