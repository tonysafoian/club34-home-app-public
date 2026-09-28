import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  RefreshCw, Wifi, WifiOff, Radio, Users, Globe, AlertTriangle,
  Signal, Activity, Crown, Search, ChevronDown, ChevronUp, Network,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type TabId = 'overview' | 'aps' | 'groups' | 'clients' | 'wlans' | 'diagnostics';

interface WirelessDiagnostics {
  summary: string;
  current_snapshot: {
    captured_at: string;
    ap_total: number; ap_online: number; ap_offline: number; ap_unknown: number;
    client_total: number; ssid_total: number;
    stale: boolean;
    section_errors: Record<string, string> | null;
  } | null;
  lkg: {
    aps_fetched_at: string | null;
    clients_fetched_at: string | null;
    ssids_fetched_at: string | null;
    last_success_at: string | null;
  };
  recent_events: Array<{
    id: string;
    detected_at: string;
    event_type: string;
    severity: 'info' | 'warn' | 'error';
    evidence: 'controller' | 'client' | 'telemetry';
    summary: string;
    detail: Record<string, unknown> | null;
  }>;
  event_count_24h: number;
  retention_days: number;
}

interface RuckusSystemInfo {
  name?: string;
  version?: string;
  unleashedId?: string;
  serial?: string;
  model?: string;
  uptime?: number;
  countryCode?: string;
  raw?: Record<string, unknown>;
}

interface RuckusAccessPoint {
  mac: string;
  name: string;
  model?: string;
  ip?: string;
  // Server returns `status: 'joined' | 'disconnected' | 'unknown'`.
  // Older payloads may also carry `online: boolean` / `numClients: number`
  // (now an alias for `client_count`) — both are normalized below.
  status?: 'joined' | 'disconnected' | 'unknown' | string;
  online?: boolean;
  numClients?: number;
  client_count?: number;
  channel24?: string;
  channel5?: string;
  uptime?: number;
  firmware?: string;
  isMaster?: boolean;
}

type ApPresentation = 'online' | 'offline' | 'unknown';

function presentApStatus(ap: RuckusAccessPoint): ApPresentation {
  // Prefer the canonical `status` enum from the server. Treat `joined`
  // as online and `disconnected` as offline. `unknown` (controller did
  // not report a state we recognize) is rendered as its own warning
  // state instead of a hard offline — a transient blip should not paint
  // the network as down.
  if (ap.status === 'joined') return 'online';
  if (ap.status === 'disconnected') return 'offline';
  if (ap.status === 'unknown') return 'unknown';
  // Legacy fallback: trust `online` if the server hasn't sent `status`.
  if (typeof ap.online === 'boolean') return ap.online ? 'online' : 'offline';
  return 'unknown';
}

function apClientCount(ap: RuckusAccessPoint): number {
  return ap.client_count ?? ap.numClients ?? 0;
}

interface RuckusClient {
  mac: string;
  hostname?: string;
  ip?: string;
  apMac?: string;
  apName?: string;
  ssid?: string;
  rssi?: number;
  signal?: string;
  rxBytes?: number;
  txBytes?: number;
  vlan?: number | string;
  os?: string;
}

interface RuckusWlan {
  id: string | number;
  name: string;
  ssid: string;
  enabled: boolean;
  authentication?: string;
  encryption?: string;
  hidden?: boolean;
  guest?: boolean;
}

interface ApiError {
  error: string;
  hint?: string;
  baseUrl?: string;
}

// Shapes returned by GET /api/wireless/grouped — the per-AP / per-SSID
// client breakdown. Mirrors the server-side GroupedClient/ApGroup/SsidGroup.
interface GroupedClient {
  mac: string;
  hostname?: string;
  ip?: string;
  ssid?: string;
  apName?: string;
  apMac?: string;
  signal?: number;
  signalHealth: 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';
  band?: string;
  vlan?: string | number;
  os?: string;
  firstAssocAt?: number;
}

interface ApGroup {
  apName: string;
  apMac: string;
  model?: string;
  status: 'joined' | 'disconnected' | 'unknown' | string;
  online: boolean;
  clientCount: number;
  clients: GroupedClient[];
}

interface SsidGroup {
  ssid: string;
  clientCount: number;
  apCount: number;
  clients: GroupedClient[];
}

interface GroupedResponse {
  accessPoints: ApGroup[];
  unassigned: GroupedClient[];
  ssids: SsidGroup[];
  ap_count: number;
  client_count: number;
  reachable: boolean;
  errors: Record<string, string>;
  generated_at: string;
  source: string;
}

interface WirelessStatusResponse {
  system: RuckusSystemInfo;
  aps: RuckusAccessPoint[];
  baseUrl: string;
  generated_at?: string;
  elapsed_ms?: number;
  source?: string;
  stale?: boolean;
  section_errors?: Record<string, string>;
  last_success_at?: string | null;
}

function formatUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function ErrorCard({ error, hint, baseUrl }: ApiError) {
  return (
    <Card className="border-destructive/30" data-testid="card-wireless-error">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive text-base">
          <AlertTriangle className="h-4 w-4" /> Cannot reach Ruckus controller
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="font-mono text-xs bg-muted/50 p-2 rounded" data-testid="text-wireless-error-detail">{error}</div>
        {baseUrl && <div className="text-muted-foreground">Target: <span className="font-mono">{baseUrl}</span></div>}
        {hint && <div className="text-muted-foreground">{hint}</div>}
        <div className="text-xs text-muted-foreground border-t pt-3">
          The Ruckus Unleashed controller is on the LAN — Replit reaches it via the Home Assistant
          <code className="px-1 mx-1 bg-muted rounded">rest_command.ruckus_login</code> /
          <code className="px-1 mx-1 bg-muted rounded">ruckus_call</code> proxy services.
          See <code className="px-1 bg-muted rounded">docs/ruckus-ha-proxy.yaml</code> for the snippet to paste into your HA <code className="px-1 bg-muted rounded">configuration.yaml</code>.
        </div>
      </CardContent>
    </Card>
  );
}

interface UseWirelessQueryOpts<T> {
  key: string;
  url: string;
  enabled?: boolean;
  refetchInterval?: number;
  select?: (data: unknown) => T;
}

function useWirelessQuery<T>({ key, url, enabled = true, refetchInterval, select }: UseWirelessQueryOpts<T>) {
  return useQuery<T | ApiError>({
    queryKey: ['/api/wireless', key],
    queryFn: async () => {
      try {
        const data = await apiClient.get(url);
        return (select ? select(data) : data) as T;
      } catch (e) {
        const err = e as { status?: number; body?: ApiError; message?: string };
        if (err.body && typeof err.body === 'object' && 'error' in err.body) return err.body;
        return { error: err.message || 'Request failed' } as ApiError;
      }
    },
    enabled,
    refetchInterval,
    staleTime: 15_000,
  });
}

function isApiError(v: unknown): v is ApiError {
  return Boolean(v && typeof v === 'object' && 'error' in v);
}

export function AdminWirelessContent({ initialTab = 'overview' }: { initialTab?: TabId }) {
  const [tab, setTab] = useState<TabId>(initialTab);

  const status = useWirelessQuery<WirelessStatusResponse>({
    key: 'status',
    url: '/api/wireless/status',
    refetchInterval: 30_000,
  });

  const clients = useWirelessQuery<{ clients: RuckusClient[]; count: number }>({
    key: 'clients',
    url: '/api/wireless/clients',
    enabled: tab === 'clients',
    refetchInterval: 20_000,
  });

  const wlans = useWirelessQuery<{ wlans: RuckusWlan[]; count: number }>({
    key: 'wlans',
    url: '/api/wireless/wlans',
    enabled: tab === 'wlans',
  });

  const grouped = useWirelessQuery<GroupedResponse>({
    key: 'grouped',
    url: '/api/wireless/grouped',
    enabled: tab === 'groups',
    refetchInterval: 20_000,
  });

  return (
    <div className="space-y-6" data-testid="admin-wireless-root">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-display font-semibold flex items-center gap-2">
            <Wifi className="h-6 w-6 text-primary" /> Wireless
          </h2>
          <p className="text-sm text-muted-foreground">
            Ruckus Unleashed controller — APs, connected clients, and SSIDs
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { status.refetch(); clients.refetch(); wlans.refetch(); grouped.refetch(); }}
          data-testid="button-wireless-refresh"
        >
          <RefreshCw className="h-4 w-4 mr-2" /> Refresh
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-wireless-overview">Overview</TabsTrigger>
          <TabsTrigger value="aps" data-testid="tab-wireless-aps">Access Points</TabsTrigger>
          <TabsTrigger value="groups" data-testid="tab-wireless-groups">Client Map</TabsTrigger>
          <TabsTrigger value="clients" data-testid="tab-wireless-clients">Clients</TabsTrigger>
          <TabsTrigger value="wlans" data-testid="tab-wireless-wlans">SSIDs</TabsTrigger>
          <TabsTrigger value="diagnostics" data-testid="tab-wireless-diagnostics">Diagnostics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewPanel query={status} />
        </TabsContent>

        <TabsContent value="aps" className="mt-6">
          <ApsPanel query={status} />
        </TabsContent>

        <TabsContent value="groups" className="mt-6">
          <GroupsPanel query={grouped} />
        </TabsContent>

        <TabsContent value="clients" className="mt-6">
          <ClientsPanel query={clients} />
        </TabsContent>

        <TabsContent value="wlans" className="mt-6">
          <WlansPanel query={wlans} />
        </TabsContent>

        <TabsContent value="diagnostics" className="mt-6">
          <DiagnosticsPanel enabled={tab === 'diagnostics'} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

type WirelessQueryResult<T> = ReturnType<typeof useWirelessQuery<T>>;

function OverviewPanel({ query }: { query: WirelessQueryResult<WirelessStatusResponse> }) {
  if (query.isLoading) return <Skeleton className="h-48 w-full" />;
  if (!query.data || isApiError(query.data)) {
    return <ErrorCard {...(query.data as ApiError ?? { error: 'No data' })} />;
  }

  const { system, aps } = query.data;
  const sysHasErr = system && 'error' in (system as unknown as Record<string, unknown>);
  const apsHasErr = !Array.isArray(aps);
  const apList: RuckusAccessPoint[] = Array.isArray(aps) ? aps : [];
  const onlineCount = apList.filter((a) => presentApStatus(a) === 'online').length;
  const totalClients = apList.reduce((sum, a) => sum + apClientCount(a), 0);

  return (
    <div className="space-y-4">
      {query.data.stale && (
        <Card className="border-amber-500/40" data-testid="card-wireless-stale">
          <CardContent className="pt-4 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-amber-600 dark:text-amber-400">
                Showing last-known-good data
              </div>
              <div className="text-muted-foreground">
                One or more Ruckus sections failed on the most recent poll.
                {query.data.last_success_at &&
                  ` Last full success: ${new Date(query.data.last_success_at).toLocaleTimeString()}.`}
                {query.data.section_errors && Object.keys(query.data.section_errors).length > 0 && (
                  <span> Errors: {Object.entries(query.data.section_errors).map(([k, v]) => `${k}: ${v}`).join('; ')}</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card data-testid="card-wireless-system">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Radio className="h-4 w-4" /> System
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {sysHasErr ? (
            <div className="text-destructive text-xs font-mono" data-testid="text-system-error">
              {(system as unknown as { error: string }).error}
            </div>
          ) : (
            <>
              <Row label="Name" value={system?.name} testId="text-system-name" />
              <Row label="Firmware" value={system?.version} testId="text-system-version" />
              <Row label="Unleashed ID" value={system?.unleashedId} mono testId="text-system-id" />
              {system?.model && <Row label="Model" value={system.model} testId="text-system-model" />}
              {system?.countryCode && <Row label="Country" value={system.countryCode} testId="text-system-country" />}
              {typeof system?.uptime === 'number' && <Row label="Uptime" value={formatUptime(system.uptime)} testId="text-system-uptime" />}
            </>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-wireless-summary">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" /> Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {apsHasErr ? (
            <div className="text-destructive text-xs font-mono" data-testid="text-aps-error">
              {(aps as unknown as { error: string }).error}
            </div>
          ) : (
            <>
              <Row label="Access Points" value={`${onlineCount} / ${apList.length} online`} testId="text-summary-aps" />
              <Row label="Connected clients (sum)" value={String(totalClients)} testId="text-summary-clients" />
              <Row label="Master AP" value={apList.find(a => a.isMaster)?.name ?? '—'} testId="text-summary-master" />
            </>
          )}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}

function ApsPanel({ query }: { query: WirelessQueryResult<WirelessStatusResponse> }) {
  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!query.data || isApiError(query.data)) {
    return <ErrorCard {...(query.data as ApiError ?? { error: 'No data' })} />;
  }
  const apsRaw: unknown = query.data.aps;
  if (apsRaw && typeof apsRaw === 'object' && !Array.isArray(apsRaw) && 'error' in apsRaw) {
    return <ErrorCard error={(apsRaw as { error: string }).error} baseUrl={query.data.baseUrl} />;
  }
  const aps: RuckusAccessPoint[] = Array.isArray(apsRaw) ? apsRaw : [];
  if (aps.length === 0) {
    return <div className="text-muted-foreground text-sm" data-testid="text-aps-empty">No access points found.</div>;
  }

  return (
    <div className="space-y-3">
      {aps.map((ap) => {
        const presentation = presentApStatus(ap);
        return (
        <Card key={ap.mac} data-testid={`card-ap-${ap.mac}`}>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3 flex-wrap">
              {presentation === 'online' ? (
                <Wifi className="h-5 w-5 text-green-500 shrink-0" />
              ) : presentation === 'unknown' ? (
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
              ) : (
                <WifiOff className="h-5 w-5 text-muted-foreground shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium" data-testid={`text-ap-name-${ap.mac}`}>{ap.name}</span>
                  {ap.isMaster && (
                    <Badge variant="default" className="gap-1" data-testid={`badge-ap-master-${ap.mac}`}>
                      <Crown className="h-3 w-3" /> Master
                    </Badge>
                  )}
                  {ap.model && <Badge variant="outline" data-testid={`badge-ap-model-${ap.mac}`}>{ap.model}</Badge>}
                  <Badge variant={presentation === 'online' ? 'secondary' : 'outline'} data-testid={`badge-ap-status-${ap.mac}`}>
                    {ap.status ?? presentation}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-1 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1">
                  <span>MAC: <span className="font-mono">{ap.mac || '—'}</span></span>
                  <span>IP: <span className="font-mono">{ap.ip || '—'}</span></span>
                  <span>Clients: <span className="font-mono" data-testid={`text-ap-clients-${ap.mac}`}>{apClientCount(ap)}</span></span>
                  <span>Uptime: <span className="font-mono">{formatUptime(ap.uptime)}</span></span>
                  {ap.channel24 && <span>2.4GHz ch: <span className="font-mono">{ap.channel24}</span></span>}
                  {ap.channel5 && <span>5GHz ch: <span className="font-mono">{ap.channel5}</span></span>}
                  {ap.firmware && <span>FW: <span className="font-mono">{ap.firmware}</span></span>}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
        );
      })}
    </div>
  );
}

function ClientsPanel({ query }: { query: WirelessQueryResult<{ clients: RuckusClient[]; count: number }> }) {
  const [search, setSearch] = useState('');

  const all = useMemo<RuckusClient[]>(() => {
    if (!query.data || isApiError(query.data)) return [];
    return query.data.clients ?? [];
  }, [query.data]);

  const filtered = useMemo(() => {
    if (!search.trim()) return all;
    const q = search.toLowerCase();
    return all.filter((c) =>
      [c.hostname, c.mac, c.ip, c.ssid, c.apName, c.os].some((v) => v && String(v).toLowerCase().includes(q)),
    );
  }, [all, search]);

  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!query.data || isApiError(query.data)) {
    return <ErrorCard {...(query.data as ApiError ?? { error: 'No data' })} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search clients (hostname, MAC, IP, SSID, AP)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-clients-search"
          className="max-w-md"
        />
        <Badge variant="secondary" data-testid="text-clients-count">{filtered.length} / {all.length}</Badge>
      </div>

      {filtered.length === 0 ? (
        <div className="text-muted-foreground text-sm" data-testid="text-clients-empty">No clients match.</div>
      ) : (
        <div className="border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">Host</th>
                <th className="text-left px-3 py-2">IP</th>
                <th className="text-left px-3 py-2">SSID</th>
                <th className="text-left px-3 py-2">AP</th>
                <th className="text-right px-3 py-2">RSSI</th>
                <th className="text-right px-3 py-2">RX</th>
                <th className="text-right px-3 py-2">TX</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.mac} className="border-t" data-testid={`row-client-${c.mac}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium" data-testid={`text-client-host-${c.mac}`}>{c.hostname || '—'}</div>
                    <div className="text-xs text-muted-foreground font-mono">{c.mac}</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{c.ip || '—'}</td>
                  <td className="px-3 py-2">{c.ssid || '—'}</td>
                  <td className="px-3 py-2">{c.apName || c.apMac || '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {typeof c.rssi === 'number' ? (
                      <span className="inline-flex items-center gap-1">
                        <Signal className="h-3 w-3" /> {c.rssi}
                      </span>
                    ) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{formatBytes(c.rxBytes)}</td>
                  <td className="px-3 py-2 text-right font-mono">{formatBytes(c.txBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WlansPanel({ query }: { query: WirelessQueryResult<{ wlans: RuckusWlan[]; count: number }> }) {
  if (query.isLoading) return <Skeleton className="h-48 w-full" />;
  if (!query.data || isApiError(query.data)) {
    return <ErrorCard {...(query.data as ApiError ?? { error: 'No data' })} />;
  }
  const wlans = query.data.wlans ?? [];
  if (wlans.length === 0) {
    return <div className="text-muted-foreground text-sm" data-testid="text-wlans-empty">No SSIDs configured.</div>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {wlans.map((w) => (
        <Card key={String(w.id)} data-testid={`card-wlan-${w.id}`}>
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <Globe className="h-4 w-4 text-primary" />
              <span className="font-medium" data-testid={`text-wlan-name-${w.id}`}>{w.name || w.ssid}</span>
              {w.guest && <Badge variant="outline">Guest</Badge>}
              {w.hidden && <Badge variant="outline">Hidden</Badge>}
              <Badge variant={w.enabled ? 'secondary' : 'outline'} className="ml-auto">
                {w.enabled ? 'Enabled' : 'Disabled'}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <div>SSID: <span className="font-mono">{w.ssid}</span></div>
              {w.authentication && <div>Auth: <span className="font-mono">{w.authentication}</span></div>}
              {w.encryption && <div>Encryption: <span className="font-mono">{w.encryption}</span></div>}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function signalHealthClass(health: GroupedClient['signalHealth']): string {
  switch (health) {
    case 'excellent': return 'text-emerald-600 dark:text-emerald-400';
    case 'good': return 'text-green-600 dark:text-green-400';
    case 'fair': return 'text-amber-600 dark:text-amber-400';
    case 'poor': return 'text-red-600 dark:text-red-400';
    default: return 'text-muted-foreground';
  }
}

// Renders the list of clients beneath an AP or SSID group. Shared between
// the two grouping modes so the per-client row looks identical in both.
function GroupedClientRows({ clients, mode }: { clients: GroupedClient[]; mode: 'ap' | 'ssid' }) {
  if (clients.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground" data-testid="text-group-empty">
        No connected clients.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="text-left px-4 py-2">Host</th>
            <th className="text-left px-4 py-2">IP</th>
            {/* In AP mode the AP is the group header, so show SSID here;
                in SSID mode the SSID is the header, so show the AP here. */}
            <th className="text-left px-4 py-2">{mode === 'ap' ? 'SSID' : 'Access Point'}</th>
            <th className="text-left px-4 py-2">Band</th>
            <th className="text-right px-4 py-2">Signal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {clients.map((c, i) => (
            <tr key={c.mac || i} className="hover:bg-muted/20 transition-colors" data-testid={`row-grouped-client-${c.mac || i}`}>
              <td className="px-4 py-2">
                <div className="font-medium">{c.hostname || <span className="text-muted-foreground italic">Unknown</span>}</div>
                <div className="text-xs text-muted-foreground font-mono">{c.mac || '—'}</div>
              </td>
              <td className="px-4 py-2 font-mono text-xs">{c.ip || '—'}</td>
              <td className="px-4 py-2">{mode === 'ap' ? (c.ssid || '—') : (c.apName || c.apMac || '—')}</td>
              <td className="px-4 py-2">
                {c.band ? <Badge variant="outline" className="text-xs">{c.band}</Badge> : '—'}
              </td>
              <td className="px-4 py-2 text-right">
                {typeof c.signal === 'number' ? (
                  <span className={cn('inline-flex items-center gap-1 font-mono', signalHealthClass(c.signalHealth))}>
                    <Signal className="h-3 w-3" /> {c.signal} dBm
                  </span>
                ) : (
                  <span className={cn('text-xs capitalize', signalHealthClass(c.signalHealth))}>{c.signalHealth}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupsPanel({ query }: { query: WirelessQueryResult<GroupedResponse> }) {
  const [mode, setMode] = useState<'ap' | 'ssid'>('ap');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (query.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!query.data || isApiError(query.data)) {
    return <ErrorCard {...(query.data as ApiError ?? { error: 'No data' })} />;
  }

  const data = query.data;
  const apGroups = data.accessPoints ?? [];
  const ssidGroups = data.ssids ?? [];
  const unassigned = data.unassigned ?? [];

  return (
    <div className="space-y-4" data-testid="groups-root">
      {!data.reachable && (
        <Card className="border-amber-500/40" data-testid="card-groups-unreachable">
          <CardContent className="pt-4 text-xs flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-amber-600 dark:text-amber-400">Controller unreachable</div>
              <div className="text-muted-foreground">
                Could not load the client breakdown from Ruckus.
                {Object.keys(data.errors ?? {}).length > 0 && (
                  <span> {Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}</span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-muted-foreground">
          {data.client_count} client{data.client_count !== 1 ? 's' : ''} across {data.ap_count} AP{data.ap_count !== 1 ? 's' : ''}
        </div>
        <div className="inline-flex rounded-md border border-border/60 p-0.5" data-testid="toggle-group-mode">
          <Button
            variant={mode === 'ap' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => setMode('ap')}
            data-testid="button-group-by-ap"
          >
            <Radio className="h-3.5 w-3.5" /> By Access Point
          </Button>
          <Button
            variant={mode === 'ssid' ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => setMode('ssid')}
            data-testid="button-group-by-ssid"
          >
            <Globe className="h-3.5 w-3.5" /> By SSID
          </Button>
        </div>
      </div>

      {mode === 'ap' ? (
        apGroups.length === 0 ? (
          <div className="text-muted-foreground text-sm" data-testid="text-groups-empty">No access points found.</div>
        ) : (
          <div className="space-y-3">
            {apGroups.map((ap) => {
              const key = `ap-${ap.apMac || ap.apName}`;
              const isCollapsed = collapsed.has(key);
              return (
                <div key={key} className="rounded-md border border-border/50 overflow-hidden" data-testid={`group-ap-${ap.apMac}`}>
                  <button
                    className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                    onClick={() => toggle(key)}
                    data-testid={`button-toggle-ap-${ap.apMac}`}
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      {ap.online
                        ? <Wifi className="h-4 w-4 text-green-500 shrink-0" />
                        : ap.status === 'unknown'
                          ? <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                          : <WifiOff className="h-4 w-4 text-muted-foreground shrink-0" />}
                      <span className="font-semibold text-sm">{ap.apName}</span>
                      {ap.model && <Badge variant="outline" className="text-xs">{ap.model}</Badge>}
                      <Badge variant="secondary" className="text-xs" data-testid={`badge-ap-clientcount-${ap.apMac}`}>
                        <Users className="h-3 w-3 mr-1" />{ap.clientCount}
                      </Badge>
                      <span className="text-xs text-muted-foreground font-mono">{ap.apMac}</span>
                    </div>
                    {isCollapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
                  </button>
                  {!isCollapsed && <GroupedClientRows clients={ap.clients} mode="ap" />}
                </div>
              );
            })}

            {unassigned.length > 0 && (
              <div className="rounded-md border border-border/50 overflow-hidden" data-testid="group-ap-unassigned">
                <button
                  className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                  onClick={() => toggle('ap-unassigned')}
                  data-testid="button-toggle-ap-unassigned"
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <Network className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-semibold text-sm">Unassigned</span>
                    <Badge variant="outline" className="text-xs">{unassigned.length}</Badge>
                    <span className="text-xs text-muted-foreground">clients with no matching AP</span>
                  </div>
                  {collapsed.has('ap-unassigned') ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
                </button>
                {!collapsed.has('ap-unassigned') && <GroupedClientRows clients={unassigned} mode="ap" />}
              </div>
            )}
          </div>
        )
      ) : (
        ssidGroups.length === 0 ? (
          <div className="text-muted-foreground text-sm" data-testid="text-groups-empty">No connected clients.</div>
        ) : (
          <div className="space-y-3">
            {ssidGroups.map((s) => {
              const key = `ssid-${s.ssid}`;
              const isCollapsed = collapsed.has(key);
              return (
                <div key={key} className="rounded-md border border-border/50 overflow-hidden" data-testid={`group-ssid-${s.ssid}`}>
                  <button
                    className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                    onClick={() => toggle(key)}
                    data-testid={`button-toggle-ssid-${s.ssid}`}
                  >
                    <div className="flex items-center gap-3 flex-wrap">
                      <Globe className="h-4 w-4 text-primary shrink-0" />
                      <span className="font-semibold text-sm">{s.ssid}</span>
                      <Badge variant="secondary" className="text-xs" data-testid={`badge-ssid-clientcount-${s.ssid}`}>
                        <Users className="h-3 w-3 mr-1" />{s.clientCount}
                      </Badge>
                      <span className="text-xs text-muted-foreground">on {s.apCount} AP{s.apCount !== 1 ? 's' : ''}</span>
                    </div>
                    {isCollapsed ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
                  </button>
                  {!isCollapsed && <GroupedClientRows clients={s.clients} mode="ssid" />}
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

function Row({ label, value, mono, testId }: { label: string; value?: string; mono?: boolean; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'font-mono text-xs' : ''} data-testid={testId}>{value ?? '—'}</span>
    </div>
  );
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function evidenceBadge(evidence: 'controller' | 'client' | 'telemetry'): { label: string; className: string } {
  switch (evidence) {
    case 'controller':
      return { label: 'controller', className: 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30' };
    case 'client':
      return { label: 'client signal', className: 'bg-purple-500/15 text-purple-700 dark:text-purple-300 border-purple-500/30' };
    case 'telemetry':
      return { label: 'telemetry only', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30' };
  }
}

function DiagnosticsPanel({ enabled }: { enabled: boolean }) {
  const q = useQuery<WirelessDiagnostics>({
    queryKey: ['/api/wireless/diagnostics'],
    queryFn: () => apiClient.get<WirelessDiagnostics>('/api/wireless/diagnostics'),
    enabled,
    refetchInterval: enabled ? 30_000 : false,
  });

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.error || !q.data) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground" data-testid="text-diagnostics-error">
          Could not load wireless diagnostics. The snapshot cron may not have run yet.
        </CardContent>
      </Card>
    );
  }

  const d = q.data;
  const snap = d.current_snapshot;

  return (
    <div className="space-y-6" data-testid="diagnostics-root">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" /> Network plain-English summary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm" data-testid="text-diagnostics-summary">{d.summary}</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Row label="Last snapshot" value={formatRelative(snap?.captured_at)} testId="text-last-snapshot" />
            <Row label="Last successful poll" value={formatRelative(d.lkg.last_success_at)} testId="text-last-success" />
            <Row label="APs (online/total)" value={snap ? `${snap.ap_online}/${snap.ap_total}` : '—'} testId="text-ap-counts" />
            <Row label="Connected clients" value={snap ? String(snap.client_total) : '—'} testId="text-client-total" />
          </div>
          {snap?.stale ? (
            <div
              className="text-xs px-3 py-2 rounded border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              data-testid="badge-stale"
            >
              Last poll degraded — serving last-known-good for:{' '}
              {Object.keys(snap.section_errors ?? {}).join(', ') || 'unknown'}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="h-4 w-4 text-amber-500" /> Recent events (24h, {d.event_count_24h})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {d.recent_events.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-events">
              No wireless events in the last 24 hours. (Retention: {d.retention_days} days.)
            </p>
          ) : (
            <ul className="space-y-2" data-testid="list-recent-events">
              {d.recent_events.map((e) => {
                const ev = evidenceBadge(e.evidence);
                return (
                  <li
                    key={e.id}
                    className="flex items-start justify-between gap-3 border-b border-border/40 pb-2 last:border-b-0 last:pb-0"
                    data-testid={`event-row-${e.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm" data-testid={`event-summary-${e.id}`}>{e.summary}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>{formatRelative(e.detected_at)}</span>
                        <span>·</span>
                        <span className="font-mono">{e.event_type}</span>
                      </div>
                    </div>
                    <Badge variant="outline" className={`text-xs whitespace-nowrap ${ev.className}`}>
                      {ev.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
