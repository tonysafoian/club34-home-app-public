import { useState, useEffect, useCallback } from 'react';
import {
  Shield, Cpu, MemoryStick, Activity, Users, AlertTriangle,
  Lock, Loader2, RefreshCw, Clock, Wifi, CheckCircle
} from 'lucide-react';
import { SystemCard } from '@/components/dashboard/SystemCard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/apiClient';
import { cn } from '@/lib/utils';

interface SystemHealth {
  cpu_usage: number | null;
  memory_usage: number | null;
  active_sessions: number | null;
}

interface SystemStatus {
  uptime: number | null;
  firmware_version: string | null;
  hostname: string | null;
  serial_number: string | null;
}

interface ConnectedDevice {
  hostname: string | null;
  ip: string | null;
  mac: string | null;
  interface: string | null;
  last_seen: number | null;
}

interface DevicesResponse {
  devices: ConnectedDevice[];
  total: number;
}

interface SecurityThreat {
  severity: string;
  src_ip: string | null;
  dst_ip: string | null;
  attack: string;
  action: string | null;
  timestamp: string | null;
  protocol?: string | null;
  service?: string | null;
  src_country?: string | null;
  dst_country?: string | null;
  sent_bytes?: number | null;
  rcvd_bytes?: number | null;
  policy_id?: string | null;
  reference?: string | null;
}

interface ThreatsResponse {
  threats: SecurityThreat[];
  total: number;
}

interface VpnSession {
  type: 'ssl' | 'ipsec';
  user: string;
  src_ip: string | null;
  connected_at: string | null;
  duration_seconds: number | null;
  vpn_ip: string | null;
  status?: string;
}

interface VpnResponse {
  sessions: VpnSession[];
  ssl_count: number;
  ipsec_count: number;
  total: number;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2 mt-1">
      {children}
    </p>
  );
}

function usageColor(pct: number | null): string {
  if (pct === null) return 'text-muted-foreground';
  if (pct >= 85) return 'text-red-400';
  if (pct >= 60) return 'text-yellow-400';
  return 'text-emerald-400';
}

function severityColor(severity: string): string {
  const s = severity.toLowerCase();
  if (s === 'critical' || s === 'high') return 'text-red-400';
  if (s === 'medium' || s === 'warning') return 'text-yellow-400';
  return 'text-blue-400';
}

function severityBadgeVariant(severity: string): 'destructive' | 'secondary' | 'outline' {
  const s = severity.toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium' || s === 'warning') return 'secondary';
  return 'outline';
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  return formatUptime(seconds);
}

function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

export function FortiGateCard() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [threats, setThreats] = useState<SecurityThreat[]>([]);
  const [vpn, setVpn] = useState<VpnResponse | null>(null);

  const [healthError, setHealthError] = useState<string | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [threatsError, setThreatsError] = useState<string | null>(null);
  const [vpnError, setVpnError] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);

    const [healthRes, statusRes, devicesRes, threatsRes, vpnRes] = await Promise.allSettled([
      apiClient.get<SystemHealth>('/api/fortigate/system-health'),
      apiClient.get<SystemStatus>('/api/fortigate/system-status'),
      apiClient.get<DevicesResponse>('/api/fortigate/devices'),
      apiClient.get<ThreatsResponse>('/api/fortigate/threats'),
      apiClient.get<VpnResponse>('/api/fortigate/vpn'),
    ]);

    if (healthRes.status === 'fulfilled') {
      setHealth(healthRes.value);
      setHealthError(null);
    } else {
      setHealthError((healthRes.reason as Error)?.message || 'Failed to load');
    }

    if (statusRes.status === 'fulfilled') {
      setStatus(statusRes.value);
    }

    if (devicesRes.status === 'fulfilled') {
      setDevices(devicesRes.value.devices);
      setDevicesError(null);
    } else {
      setDevicesError((devicesRes.reason as Error)?.message || 'Failed to load');
    }

    if (threatsRes.status === 'fulfilled') {
      setThreats(threatsRes.value.threats);
      setThreatsError(null);
    } else {
      setThreatsError((threatsRes.reason as Error)?.message || 'Failed to load');
    }

    if (vpnRes.status === 'fulfilled') {
      setVpn(vpnRes.value);
      setVpnError(null);
    } else {
      setVpnError((vpnRes.reason as Error)?.message || 'Failed to load');
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
    const interval = setInterval(() => fetchAll(true), 60_000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  const cpuUsage = health?.cpu_usage ?? null;
  const memUsage = health?.memory_usage ?? null;
  const sessionCount = health?.active_sessions ?? null;
  const uptimeSeconds = status?.uptime ?? null;
  const firmwareVersion = status?.firmware_version ?? null;
  const ipsCount = threats.length;

  const hasAnyData = health !== null || status !== null || devices.length > 0 || threats.length > 0 || vpn !== null;
  const isFullError = !hasAnyData && !loading;

  const overallStatus = loading
    ? 'idle' as const
    : hasAnyData
      ? 'online' as const
      : 'offline' as const;

  const statusText = loading
    ? 'Loading...'
    : hasAnyData
      ? (firmwareVersion ? `v${firmwareVersion}` : 'Active')
      : 'Unavailable';

  return (
    <SystemCard
      title="FortiGate Firewall"
      icon={<Shield className="h-6 w-6 text-orange-400" />}
      status={overallStatus}
      statusText={statusText}
      accentColor="bg-orange-500/10"
      metrics={[
        { label: 'CPU', value: cpuUsage !== null ? `${cpuUsage.toFixed(0)}%` : '—' },
        { label: 'Memory', value: memUsage !== null ? `${memUsage.toFixed(0)}%` : '—' },
        { label: 'Sessions', value: sessionCount !== null ? sessionCount.toLocaleString() : '—' },
        { label: 'Uptime', value: formatUptime(uptimeSeconds) },
      ]}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : isFullError ? (
        <div className="flex flex-col items-center gap-3 py-8 px-4 text-center">
          <div className="rounded-full bg-orange-500/10 p-3">
            <Shield className="h-6 w-6 text-orange-400" />
          </div>
          <div>
            <p className="text-sm font-semibold" data-testid="text-fortigate-empty">FortiGate Unavailable</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Could not connect to the FortiGate firewall API.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => fetchAll()} data-testid="button-retry-fortigate">
            <RefreshCw className="h-3 w-3 mr-1" /> Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">

          {/* System Health */}
          <div>
            <SectionLabel>System Health</SectionLabel>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-muted/30 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <Cpu className="h-3.5 w-3.5 text-orange-400" />
                  <span className="text-[10px] text-muted-foreground uppercase">CPU</span>
                </div>
                <p className={cn('text-lg font-bold font-mono tabular-nums', usageColor(cpuUsage))} data-testid="text-fortigate-cpu">
                  {cpuUsage !== null ? `${cpuUsage.toFixed(0)}%` : '—'}
                </p>
              </div>
              <div className="bg-muted/30 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-1">
                  <MemoryStick className="h-3.5 w-3.5 text-purple-400" />
                  <span className="text-[10px] text-muted-foreground uppercase">Memory</span>
                </div>
                <p className={cn('text-lg font-bold font-mono tabular-nums', usageColor(memUsage))} data-testid="text-fortigate-memory">
                  {memUsage !== null ? `${memUsage.toFixed(0)}%` : '—'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mt-3">
              <div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
                  <Activity className="h-3 w-3 text-blue-400" /> Sessions
                </div>
                <p className="font-mono font-semibold text-sm" data-testid="text-fortigate-sessions">
                  {sessionCount !== null ? sessionCount.toLocaleString() : '—'}
                </p>
              </div>
              <div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
                  <Clock className="h-3 w-3 text-teal-400" /> Uptime
                </div>
                <p className="font-mono font-semibold text-sm" data-testid="text-fortigate-uptime">
                  {formatUptime(uptimeSeconds)}
                </p>
              </div>
              <div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-0.5">
                  <AlertTriangle className="h-3 w-3 text-amber-400" /> IPS
                </div>
                <p className={cn('font-mono font-semibold text-sm', ipsCount > 0 ? 'text-amber-400' : '')} data-testid="text-fortigate-ips-count">
                  {ipsCount} <span className="text-[10px] font-normal text-muted-foreground">events</span>
                </p>
              </div>
            </div>

            {firmwareVersion && (
              <div className="mt-2">
                <Badge variant="outline" className="text-[10px] font-mono" data-testid="badge-fortigate-firmware">
                  <Shield className="h-3 w-3 mr-1" /> {firmwareVersion}
                </Badge>
              </div>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Connected Devices */}
          <div>
            <SectionLabel>Connected Devices</SectionLabel>
            {devicesError ? (
              <p className="text-xs text-muted-foreground" data-testid="text-fortigate-devices-error">
                Device data unavailable
              </p>
            ) : devices.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="text-fortigate-devices-empty">
                <Users className="h-4 w-4" />
                <span>No devices found</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className="text-[10px]" data-testid="badge-fortigate-device-count">
                    <Users className="h-3 w-3 mr-1" /> {devices.length} device{devices.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
                <div className="space-y-2 max-h-52 overflow-y-auto">
                  {devices.slice(0, 10).map((device, i) => (
                    <div
                      key={device.mac || i}
                      className="text-[11px] py-1.5 border-b border-border/30 last:border-0"
                      data-testid={`row-fortigate-device-${i}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Wifi className="h-3 w-3 text-emerald-400 shrink-0" />
                          <span className="truncate font-medium" data-testid={`text-device-hostname-${i}`}>
                            {device.hostname || 'Unknown'}
                          </span>
                        </div>
                        {device.interface && (
                          <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                            {device.interface}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 font-mono text-muted-foreground">
                        {device.ip && (
                          <span data-testid={`text-device-ip-${i}`}>{device.ip}</span>
                        )}
                        {device.mac && (
                          <span className="text-[10px]" data-testid={`text-device-mac-${i}`}>{device.mac}</span>
                        )}
                        {device.last_seen !== null && (
                          <span className="text-[10px] ml-auto" data-testid={`text-device-lastseen-${i}`}>
                            {formatTimestamp(new Date(device.last_seen * 1000).toISOString())}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                  {devices.length > 10 && (
                    <p className="text-[10px] text-muted-foreground pt-1">
                      +{devices.length - 10} more devices
                    </p>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="border-t border-border" />

          {/* Security Threats */}
          <div>
            <SectionLabel>Security Threats</SectionLabel>
            {threatsError ? (
              <p className="text-xs text-muted-foreground" data-testid="text-fortigate-threats-error">
                Threat log unavailable
              </p>
            ) : threats.length === 0 ? (
              <div className="flex items-center gap-2 text-xs text-emerald-400 py-2" data-testid="text-fortigate-threats-empty">
                <CheckCircle className="h-4 w-4" />
                <span>No recent threats detected</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="destructive" className="text-[10px]" data-testid="badge-fortigate-threat-count">
                    <AlertTriangle className="h-3 w-3 mr-1" /> {threats.length} threat{threats.length !== 1 ? 's' : ''}
                  </Badge>
                </div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {threats.slice(0, 8).map((threat, i) => (
                    <div
                      key={i}
                      className="text-[11px] py-1 border-b border-border/30 last:border-0"
                      data-testid={`row-fortigate-threat-${i}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn('font-medium truncate', severityColor(threat.severity))} data-testid={`text-threat-attack-${i}`}>
                          {threat.attack}
                        </span>
                        <Badge variant={severityBadgeVariant(threat.severity)} className="text-[9px] px-1 py-0 shrink-0">
                          {threat.severity}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-muted-foreground mt-0.5 font-mono flex-wrap">
                        {threat.src_ip && (
                          <span data-testid={`text-threat-src-${i}`}>
                            {threat.src_ip}{threat.src_country ? ` (${threat.src_country})` : ''}
                          </span>
                        )}
                        {threat.src_ip && threat.dst_ip && <span>→</span>}
                        {threat.dst_ip && (
                          <span data-testid={`text-threat-dst-${i}`}>
                            {threat.dst_ip}{threat.dst_country ? ` (${threat.dst_country})` : ''}
                          </span>
                        )}
                        {(threat.protocol || threat.service) && (
                          <span className="text-muted-foreground/60">
                            {[threat.protocol, threat.service].filter(Boolean).join('/')}
                          </span>
                        )}
                        {threat.timestamp && (
                          <span className="ml-auto">{formatTimestamp(threat.timestamp)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="border-t border-border" />

          {/* VPN Status */}
          <div>
            <SectionLabel>VPN Status</SectionLabel>
            {vpnError ? (
              <p className="text-xs text-muted-foreground" data-testid="text-fortigate-vpn-error">
                VPN data unavailable
              </p>
            ) : !vpn || vpn.total === 0 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2" data-testid="text-fortigate-vpn-empty">
                <Lock className="h-4 w-4" />
                <span>No active VPN sessions</span>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-2">
                  {vpn.ssl_count > 0 && (
                    <Badge variant="outline" className="text-[10px]" data-testid="badge-fortigate-ssl-count">
                      <Lock className="h-3 w-3 mr-1" /> {vpn.ssl_count} SSL
                    </Badge>
                  )}
                  {vpn.ipsec_count > 0 && (
                    <Badge variant="outline" className="text-[10px]" data-testid="badge-fortigate-ipsec-count">
                      <Shield className="h-3 w-3 mr-1" /> {vpn.ipsec_count} IPsec
                    </Badge>
                  )}
                </div>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {vpn.sessions.map((session, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between text-[11px] py-1 border-b border-border/30 last:border-0"
                      data-testid={`row-fortigate-vpn-${i}`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Lock className="h-3 w-3 text-blue-400 shrink-0" />
                        <div className="min-w-0">
                          <span className="font-medium truncate block" data-testid={`text-vpn-user-${i}`}>
                            {session.user}
                          </span>
                          {session.src_ip && (
                            <span className="text-muted-foreground font-mono">{session.src_ip}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <Badge variant="secondary" className="text-[9px] px-1 py-0 uppercase">
                          {session.type}
                        </Badge>
                        {session.duration_seconds !== null ? (
                          <span className="text-muted-foreground font-mono" data-testid={`text-vpn-duration-${i}`}>
                            {formatDuration(session.duration_seconds)}
                          </span>
                        ) : session.type === 'ipsec' && 'status' in session && session.status ? (
                          <span className="text-muted-foreground text-[10px]" data-testid={`text-vpn-status-${i}`}>
                            {String(session.status)}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

        </div>
      )}
    </SystemCard>
  );
}
