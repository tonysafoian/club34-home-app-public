import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiClient } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/hooks/use-toast';
import {
  RefreshCw, Network, Users, Layers,
  ChevronDown, ChevronUp, ArrowUpDown, ArrowUp, ArrowDown,
  ArrowLeft, Download, Upload, Activity, Globe, ExternalLink,
  Pencil, RotateCcw, X, Check, Wifi, Cable, HelpCircle, AlertTriangle, Tag, Shuffle,
  Camera, Tv, Speaker, Thermometer, Lightbulb, Radio, Printer, Gamepad2,
  Server, Car, Laptop, Smartphone, Zap, Cpu, DoorOpen, Droplets, Wrench,
  UserPlus, Clock,
  type LucideIcon,
} from 'lucide-react';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useUserRole } from '@/hooks/useUserRole';
import type { ConnectedDevice, ConnectionMethod, DevicesResponse, DeviceTrafficResponse, RefreshConnectionsResponse, SortKey } from './types';
import {
  LastUpdated, SectionSkeleton, ErrorCard,
} from './shared';
import { formatBytes, formatRelativeTime, isRecentlyActive } from './shared-utils';
import { resolveInitialCategory, resolveCategoryToSave, DEVICE_CATEGORIES } from './device-category';

// Re-export SortKey so it's co-located here per spec
export type { SortKey };

function connectionFilterKey(conn: ConnectionMethod | undefined): string {
  if (!conn || conn.method === 'unknown') return '__unknown__';
  if (conn.method === 'wired') return 'wired';
  return conn.ssid ? `wifi:${conn.ssid}` : 'wifi:unknown';
}

function connectionFilterLabel(key: string): string {
  if (key === '__unknown__') return 'Unknown';
  if (key === 'wired') return 'Wired';
  if (key.startsWith('wifi:')) {
    const ssid = key.slice(5);
    return ssid === 'unknown' ? 'Wi-Fi (unknown SSID)' : `Wi-Fi · ${ssid}`;
  }
  return key;
}

export function ConnectionBadge({ conn, size = 'default' }: { conn: ConnectionMethod | undefined; size?: 'default' | 'compact' }) {
  if (!conn) return null;

  const compact = size === 'compact';

  const sourceLabels: Record<string, string> = {
    ruckus_live: 'Live from Ruckus — confirmed',
    ruckus_recent: 'Last known SSID from Ruckus (feed may be stale)',
    heuristic: 'Inferred from device type / category',
    subnet: 'Inferred from subnet (10.0.22.0/23)',
    unknown: 'Source unknown',
  };

  const isInferred = conn.confidence === 'inferred' || conn.confidence === 'unknown';

  if (conn.method === 'wired') {
    return (
      <span
        title={`Wired · ${sourceLabels[conn.source] ?? conn.source}`}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border font-medium',
          compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs',
          isInferred
            ? 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20 border-dashed'
            : 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        )}
        data-testid="badge-connection-wired"
      >
        <Cable className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        {compact ? 'Wired' : (
          <>Wired{isInferred && <span className="opacity-60 text-[9px]">~</span>}</>
        )}
      </span>
    );
  }

  if (conn.method === 'wifi') {
    const ssidLabel = conn.ssid ? conn.ssid : '?';
    return (
      <span
        title={`Wi-Fi · ${conn.ssid ?? 'unknown SSID'} · ${sourceLabels[conn.source] ?? conn.source}`}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border font-medium',
          compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs',
          conn.ssid === '34_AV'
            ? (isInferred
              ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20 border-dashed'
              : 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20')
            : conn.ssid === '34_Guest'
              ? (isInferred
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20 border-dashed'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20')
              : (isInferred
                ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20 border-dashed'
                : 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20'),
        )}
        data-testid={`badge-connection-wifi-${conn.ssid ?? 'unknown'}`}
      >
        <Wifi className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
        {compact
          ? `Wi-Fi · ${ssidLabel}`
          : (
            <>
              Wi-Fi · {ssidLabel}
              {!conn.ssid_certain && <span className="opacity-60 text-[9px]">~</span>}
            </>
          )
        }
      </span>
    );
  }

  return (
    <span
      title="Connection method unknown"
      className={cn(
        'inline-flex items-center gap-1 rounded-full border font-medium border-dashed',
        compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs',
        'bg-muted/30 text-muted-foreground border-border/50',
      )}
      data-testid="badge-connection-unknown"
    >
      <HelpCircle className={compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      Unknown
    </span>
  );
}
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  'Network Infrastructure': Network,
  'Security Cameras': Camera,
  'Smart TVs & Streaming': Tv,
  'Smart Speakers': Speaker,
  'Thermostats': Thermometer,
  'Lighting & Switches': Lightbulb,
  'AV Systems': Radio,
  'Printers': Printer,
  'Gaming Consoles': Gamepad2,
  'Virtual Machines': Server,
  'Cars': Car,
  'Computers & Laptops': Laptop,
  'Mobile Phones & Tablets': Smartphone,
  'People / Personal Devices': Users,
  'Electricity Monitoring': Zap,
  'IoT Devices': Cpu,
  'Smart Gate Devices': DoorOpen,
  'Smart Sprinklers': Droplets,
  'Primary Systems': Wrench,
  'Unknown / Uncategorized': HelpCircle,
};

function categoryIconFor(category: string): LucideIcon {
  return CATEGORY_ICONS[category] ?? Layers;
}

const AUTO_CATEGORY = '__auto__';

const NETWORK_COLORS = [
  'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
  'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
  'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
];

function DeviceDetailView({ device, onBack }: { device: ConnectedDevice; onBack: () => void }) {
  const mac = device.mac ?? 'unknown';
  const ip = device.ip;
  const active = isRecentlyActive(device.last_seen);

  const { data, isLoading, isError } = useQuery<DeviceTrafficResponse>({
    queryKey: ['/api/fortigate/devices', mac, 'traffic', ip],
    queryFn: () => apiClient.get<DeviceTrafficResponse>(`/api/fortigate/devices/${encodeURIComponent(mac)}/traffic?srcip=${encodeURIComponent(ip ?? '')}`),
    enabled: !!ip,
    staleTime: 60_000,
    retry: 1,
  });

  const destinations = data?.destinations ?? [];

  return (
    <div className="space-y-5" data-testid="device-detail-view">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack} data-testid="button-back-to-devices" className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          Back to devices
        </Button>
      </div>

      {/* Identity card */}
      <Card data-testid="card-device-identity">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', active ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
                <span data-testid="text-detail-hostname">{device.hostname || 'Unknown Device'}</span>
              </CardTitle>
              {device.hardware_vendor && (
                <p className="text-sm text-muted-foreground mt-0.5" data-testid="text-detail-vendor">{device.hardware_vendor}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {device.category && (
                <Badge variant="secondary" className="text-xs" data-testid="badge-detail-category">{device.category}</Badge>
              )}
              <Badge variant={active ? 'default' : 'outline'} className={cn('text-xs', active ? 'bg-emerald-500 hover:bg-emerald-600' : '')} data-testid="badge-detail-status">
                {active ? 'Active Now' : 'Offline'}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">IP Address</div>
              <div className="font-mono font-medium" data-testid="text-detail-ip">{device.ip ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">MAC Address</div>
              <div className="font-mono text-xs" data-testid="text-detail-mac">{device.mac ?? '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">Connection</div>
              <div data-testid="text-detail-connection">
                <ConnectionBadge conn={device.connection} />
              </div>
            </div>
            {device.connection && device.connection.method !== 'unknown' && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Source</div>
                <div className="text-xs text-muted-foreground" data-testid="text-detail-connection-source">
                  {device.connection.source === 'ruckus_live' && 'Confirmed live (Ruckus)'}
                  {device.connection.source === 'ruckus_recent' && 'Last known (Ruckus, stale)'}
                  {device.connection.source === 'heuristic' && 'Inferred from device type'}
                  {device.connection.source === 'subnet' && 'Inferred from subnet'}
                  {device.connection.source === 'unknown' && '—'}
                </div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">Last Seen</div>
              <div className={cn('text-xs', active ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground')} data-testid="text-detail-lastseen">
                {active ? 'Active now' : formatRelativeTime(device.last_seen)}
              </div>
            </div>
            {device.os_type && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">OS</div>
                <div className="text-xs" data-testid="text-detail-os">{device.os_type}</div>
              </div>
            )}
            {device.device_type && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Device Type</div>
                <div className="text-xs" data-testid="text-detail-type">{device.device_type}</div>
              </div>
            )}
            {device.subcategory && (
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">Subcategory</div>
                <div className="text-xs" data-testid="text-detail-subcategory">{device.subcategory}</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Traffic summary */}
      {!ip ? (
        <div className="rounded-md border border-border/50 py-8 text-center text-sm text-muted-foreground">
          No IP address available — traffic data unavailable
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : isError ? (
        <div className="rounded-md border border-border/50 py-8 text-center text-sm text-muted-foreground">
          Traffic data unavailable (FortiGate may not have records for this device)
        </div>
      ) : (
        <>
          {/* Traffic summary cards */}
          <div className="grid grid-cols-3 gap-3">
            <Card data-testid="card-traffic-rx">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Download className="h-4 w-4 text-emerald-500" />
                  <span className="text-xs text-muted-foreground">Download (RX)</span>
                </div>
                <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400" data-testid="text-detail-total-rx">
                  {formatBytes(data?.total_rx_bytes ?? 0)}
                </div>
              </CardContent>
            </Card>
            <Card data-testid="card-traffic-tx">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Upload className="h-4 w-4 text-blue-400" />
                  <span className="text-xs text-muted-foreground">Upload (TX)</span>
                </div>
                <div className="text-xl font-bold text-blue-500 dark:text-blue-400" data-testid="text-detail-total-tx">
                  {formatBytes(data?.total_tx_bytes ?? 0)}
                </div>
              </CardContent>
            </Card>
            <Card data-testid="card-traffic-total">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-1">
                  <Activity className="h-4 w-4 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Total Traffic</span>
                </div>
                <div className="text-xl font-bold" data-testid="text-detail-total-bytes">
                  {formatBytes(data?.total_bytes ?? 0)}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sites visited table */}
          <div data-testid="section-sites-visited">
            <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
              <Globe className="h-4 w-4 text-muted-foreground" />
              Sites Visited
              {destinations.length > 0 && (
                <Badge variant="secondary" className="text-xs">{destinations.length}</Badge>
              )}
            </h3>
            {destinations.length === 0 ? (
              <div className="rounded-md border border-border/50 py-8 text-center text-sm text-muted-foreground">
                No site visit data available for this device
              </div>
            ) : (
              <div className="rounded-md border border-border/50 overflow-hidden">
                <table className="w-full text-sm" data-testid="table-sites-visited">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Domain / IP</th>
                      <th className="px-4 py-2.5 text-left">Category</th>
                      <th className="px-4 py-2.5 text-right">Hits</th>
                      <th className="px-4 py-2.5 text-right">Download</th>
                      <th className="px-4 py-2.5 text-right">Upload</th>
                      <th className="px-4 py-2.5 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/30">
                    {destinations.map((dest, i) => (
                      <tr key={i} className="hover:bg-muted/20 transition-colors" data-testid={`row-site-${i}`}>
                        <td className="px-4 py-2.5 font-mono text-xs max-w-xs">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate" data-testid={`text-site-domain-${i}`}>{dest.domain}</span>
                            {dest.domain.includes('.') && !dest.domain.match(/^\d+\.\d+\.\d+\.\d+$/) && (
                              <a
                                href={`https://${dest.domain}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                              >
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5" data-testid={`text-site-category-${i}`}>
                          {dest.category ? (
                            <Badge variant="outline" className="text-xs">{dest.category}</Badge>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs" data-testid={`text-site-hits-${i}`}>{dest.hits}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-emerald-600 dark:text-emerald-400" data-testid={`text-site-rx-${i}`}>
                          {formatBytes(dest.rx_bytes)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-blue-500 dark:text-blue-400" data-testid={`text-site-tx-${i}`}>
                          {formatBytes(dest.tx_bytes)}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs" data-testid={`text-site-bytes-${i}`}>
                          {formatBytes(dest.bytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function DeviceEditPopover({
  device,
  onClose,
  onSaved,
}: {
  device: ConnectedDevice;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [nameValue, setNameValue] = useState(device.hostname || '');
  const [categoryValue, setCategoryValue] = useState(() => resolveInitialCategory(device));
  const [subcategoryValue, setSubcategoryValue] = useState(device.subcategory || '');
  const [ownerValue, setOwnerValue] = useState(device.owner || '');
  const queryClient = useQueryClient();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const mutation = useMutation({
    mutationFn: (data: { custom_name: string | null; custom_category: string | null; custom_subcategory: string | null; owner: string | null }) =>
      apiClient.request(`/api/fortigate/device-overrides/${encodeURIComponent(device.mac || '')}`, {
        method: 'PUT',
        body: {
          ...data,
          original_hostname: device.original_hostname ?? device.hostname,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/devices'] });
      toast({ title: 'Device updated', description: 'Override saved successfully' });
      onSaved();
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to save override', variant: 'destructive' });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () =>
      apiClient.del(`/api/fortigate/device-overrides/${encodeURIComponent(device.mac || '')}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/devices'] });
      toast({ title: 'Reset', description: 'Device reset to auto-detected values' });
      onSaved();
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to reset override', variant: 'destructive' });
    },
  });

  function handleSave() {
    if (!device.mac) return;
    const categoryToSave = resolveCategoryToSave(categoryValue, device);
    mutation.mutate({
      custom_name: nameValue.trim() || null,
      custom_category: categoryToSave,
      custom_subcategory: subcategoryValue || null,
      owner: ownerValue.trim() || null,
    });
  }

  function handleReset() {
    if (!device.mac) return;
    resetMutation.mutate();
  }

  return (
    <div
      className="absolute z-50 left-0 top-full mt-1 w-80 rounded-lg border border-border bg-popover shadow-lg p-4 space-y-3"
      onClick={e => e.stopPropagation()}
      data-testid="device-edit-popover"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold flex items-center gap-1.5">
          <Pencil className="h-3.5 w-3.5 text-blue-400" />
          Edit Device
        </span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" data-testid="button-close-edit-popover">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground font-medium">Custom Name</label>
        <Input
          ref={nameRef}
          value={nameValue}
          onChange={e => setNameValue(e.target.value)}
          placeholder={device.original_hostname ?? device.hostname ?? 'Enter hostname…'}
          className="h-8 text-sm"
          data-testid="input-device-custom-name"
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground font-medium">Owner</label>
        <Input
          value={ownerValue}
          onChange={e => setOwnerValue(e.target.value)}
          placeholder="e.g. Work Phone, Guest — Jane…"
          className="h-8 text-sm"
          data-testid="input-device-owner"
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs text-muted-foreground font-medium">Category</label>
        <Select
          value={categoryValue || AUTO_CATEGORY}
          onValueChange={v => { setCategoryValue(v === AUTO_CATEGORY ? '' : v); setSubcategoryValue(''); }}
        >
          <SelectTrigger className="h-8 text-sm" data-testid="select-device-category">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_CATEGORY}>— auto detected —</SelectItem>
            {DEVICE_CATEGORIES.map(c => {
              const Icon = categoryIconFor(c);
              return (
                <SelectItem key={c} value={c} data-testid={`option-category-${c}`}>
                  <span className="flex items-center gap-2">
                    <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    {c}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={mutation.isPending}
          className="flex-1 h-7 text-xs"
          data-testid="button-save-device-override"
        >
          <Check className="h-3.5 w-3.5 mr-1" />
          Save
        </Button>
        {device.is_overridden && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleReset}
            disabled={resetMutation.isPending}
            className="h-7 text-xs text-muted-foreground"
            data-testid="button-reset-device-override"
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            Reset
          </Button>
        )}
      </div>
      {device.is_overridden && device.original_hostname && device.original_hostname !== device.hostname && (
        <div className="text-xs text-muted-foreground border-t border-border pt-2">
          Original: <span className="font-mono">{device.original_hostname}</span>
        </div>
      )}
    </div>
  );
}

function DeviceTableRows({
  devices,
  sortKey,
  sortAsc,
  handleSort,
  groupIndex,
  groupName,
  onDeviceClick,
}: {
  devices: ConnectedDevice[];
  sortKey: SortKey;
  sortAsc: boolean;
  handleSort: (key: SortKey) => void;
  groupIndex: number;
  groupName: string;
  onDeviceClick?: (device: ConnectedDevice) => void;
}) {
  const [editingMac, setEditingMac] = useState<string | null>(null);

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortAsc ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  }

  const sorted = [...devices].sort((a, b) => {
    let av: string | number | null = a[sortKey] as string | number | null;
    let bv: string | number | null = b[sortKey] as string | number | null;
    if (av === null) av = '';
    if (bv === null) bv = '';
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortAsc ? av - bv : bv - av;
    }
    return sortAsc
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  });

  return (
    <table className="w-full text-sm" data-testid={`table-devices-${groupName}`}>
      <thead className="bg-muted/40 text-xs text-muted-foreground">
        <tr>
          {([
            { key: 'hostname', label: 'Hostname / Vendor' },
            { key: 'ip', label: 'IP Address' },
            { key: 'mac', label: 'MAC' },
            { key: 'device_type', label: 'Type / OS' },
            { key: 'last_seen', label: 'Last Seen' },
            { key: 'rx_bytes', label: 'RX' },
            { key: 'tx_bytes', label: 'TX' },
          ] as { key: SortKey; label: string }[]).map(col => (
            <th
              key={col.key}
              className="px-4 py-2.5 text-left cursor-pointer hover:text-foreground transition-colors whitespace-nowrap"
              onClick={() => handleSort(col.key)}
            >
              <div className="flex items-center gap-1">
                {col.label}
                <SortIcon col={col.key} />
              </div>
            </th>
          ))}
          <th className="px-4 py-2.5 text-left text-xs text-muted-foreground whitespace-nowrap">Connection</th>
          <th className="px-4 py-2.5 text-left text-xs text-muted-foreground w-8" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border/30">
        {sorted.map((device, i) => {
          const idx = `${groupIndex}-${i}`;
          const active = isRecentlyActive(device.last_seen);
          const isEditing = editingMac === device.mac;
          return (
            <tr
              key={device.mac || idx}
              className={cn(
                'transition-colors relative',
                active ? 'bg-emerald-500/5' : '',
                device.is_overridden ? 'border-l-2 border-l-blue-400' : '',
                onDeviceClick && !isEditing ? 'cursor-pointer hover:bg-muted/40' : 'hover:bg-muted/20',
              )}
              onClick={() => !isEditing && onDeviceClick?.(device)}
              data-testid={`row-device-${idx}`}
            >
              <td className="px-4 py-2.5 font-medium relative">
                <div className="flex items-center gap-2">
                  <span
                    className={cn('h-2 w-2 rounded-full shrink-0', active ? 'bg-emerald-500' : 'bg-muted-foreground/40')}
                    title={active ? 'Active now' : 'Previously seen'}
                  />
                  {device.is_overridden && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-blue-400 shrink-0"
                      title={`Renamed from: ${device.original_hostname || 'Unknown'}`}
                      data-testid={`indicator-overridden-${idx}`}
                    />
                  )}
                  <span
                    data-testid={`text-device-hostname-${idx}`}
                    title={device.is_overridden && device.original_hostname ? `Original: ${device.original_hostname}` : undefined}
                  >
                    {device.hostname || <span className="text-muted-foreground italic">Unknown</span>}
                  </span>
                  {device.is_random && (
                    <span
                      className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20"
                      title="Randomized MAC address — OUI lookup not reliable"
                      data-testid={`indicator-random-mac-${idx}`}
                    >
                      <Shuffle className="h-2 w-2 mr-0.5" />
                      random
                    </span>
                  )}
                  {device.owner_missing ? (
                    <span
                      className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                      title="Needs owner — this personal device has a category but no one is assigned to it yet"
                      data-testid={`indicator-needs-owner-${idx}`}
                    >
                      <UserPlus className="h-2 w-2 mr-0.5" />
                      owner
                    </span>
                  ) : device.needs_label && !device.is_overridden && (
                    <span
                      className="inline-flex items-center px-1 py-0 rounded text-[9px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"
                      title="Needs labeling — assign an owner or category"
                      data-testid={`indicator-needs-label-${idx}`}
                    >
                      <Tag className="h-2 w-2 mr-0.5" />
                      label
                    </span>
                  )}
                </div>
                {device.hardware_vendor && (
                  <div className="text-xs text-muted-foreground font-normal pl-4 mt-0.5" data-testid={`text-device-vendor-${idx}`}>
                    {device.hardware_vendor}
                  </div>
                )}
                {isEditing && (
                  <DeviceEditPopover
                    device={device}
                    onClose={() => setEditingMac(null)}
                    onSaved={() => setEditingMac(null)}
                  />
                )}
              </td>
              <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-device-ip-${idx}`}>{device.ip ?? '—'}</td>
              <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground" data-testid={`text-device-mac-${idx}`}>{device.mac ?? '—'}</td>
              <td className="px-4 py-2.5" data-testid={`text-device-type-${idx}`}>
                {device.device_type && <div className="text-xs font-medium">{device.device_type}</div>}
                {device.os_type && <div className="text-xs text-muted-foreground">{device.os_type}</div>}
                {!device.device_type && !device.os_type && <span className="text-xs text-muted-foreground">—</span>}
              </td>
              <td className="px-4 py-2.5 whitespace-nowrap" data-testid={`text-device-lastseen-${idx}`}>
                <span className={cn('text-xs', active ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-muted-foreground')}>
                  {active ? 'Active now' : formatRelativeTime(device.last_seen)}
                </span>
              </td>
              <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-device-rx-${idx}`}>
                <span className="text-emerald-600 dark:text-emerald-400">↓</span> {formatBytes(device.rx_bytes)}
              </td>
              <td className="px-4 py-2.5 font-mono text-xs" data-testid={`text-device-tx-${idx}`}>
                <span className="text-blue-400">↑</span> {formatBytes(device.tx_bytes)}
              </td>
              <td className="px-4 py-2.5" data-testid={`text-device-connection-${idx}`}>
                <ConnectionBadge conn={device.connection} size="compact" />
              </td>
              <td className="px-2 py-2.5 text-right">
                {device.mac && (
                  <button
                    className={cn(
                      'p-1 rounded hover:bg-muted/60 transition-colors',
                      isEditing ? 'text-blue-400' : 'text-muted-foreground/50 hover:text-muted-foreground',
                    )}
                    onClick={e => {
                      e.stopPropagation();
                      setEditingMac(isEditing ? null : device.mac);
                    }}
                    title="Edit device name/category"
                    data-testid={`button-edit-device-${idx}`}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DevicesTab() {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('hostname');
  const [sortAsc, setSortAsc] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [groupByMode, setGroupByMode] = useState<'network' | 'category' | 'connection'>('category');
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [needsLabelOnly, setNeedsLabelOnly] = useState(false);

  function toggleFilter(name: string) {
    setSelectedFilters(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleTypeFilter(type: string) {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }
  const queryClient = useQueryClient();
  const { isAdmin } = useUserRole();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedDeviceMac = searchParams.get('device');
  const connectionParam = searchParams.get('connection');

  // Deep-link from the Overview connection breakdown: ?connection=<key>
  // switches to "By Connection" grouping pre-filtered to that key, then
  // clears the param so manual filter toggles aren't overridden afterwards.
  useEffect(() => {
    if (!connectionParam) return;
    setGroupByMode('connection');
    setSelectedFilters(new Set([connectionParam]));
    setSelectedTypes(new Set());
    setNeedsLabelOnly(false);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('connection');
      return next;
    }, { replace: true });
  }, [connectionParam, setSearchParams]);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<DevicesResponse>({
    queryKey: ['/api/fortigate/devices', 'category'],
    queryFn: () => apiClient.get<DevicesResponse>('/api/fortigate/devices?groupBy=category'),
    staleTime: 30_000,
    retry: 1,
  });

  const refreshConnectionsMutation = useMutation({
    mutationFn: () => apiClient.post<RefreshConnectionsResponse>('/api/fortigate/devices/refresh-connections'),
    onSuccess: (res) => {
      toast({
        title: 'Connection labels refreshed',
        description: `Recomputed ${res.updated} device${res.updated !== 1 ? 's' : ''}`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/fortigate/devices'] });
    },
    onError: () => {
      toast({ title: 'Error', description: 'Failed to refresh connection labels', variant: 'destructive' });
    },
  });

  useEffect(() => {
    if (!isLoading && !isFetching) setLastUpdated(new Date());
  }, [isLoading, isFetching, data]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/fortigate/devices'] });
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(handleRefresh, 30_000);
    return () => clearInterval(interval);
  }, [handleRefresh]);

  const devices = data?.devices ?? [];

  const selectedDevice = selectedDeviceMac
    ? (devices.find(d => d.mac === selectedDeviceMac) ?? null)
    : null;

  function handleDeviceClick(device: ConnectedDevice) {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (device.mac) next.set('device', device.mac);
      return next;
    });
  }

  function handleBack() {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.delete('device');
      return next;
    });
  }

  if (selectedDeviceMac && selectedDevice) {
    return <DeviceDetailView device={selectedDevice} onBack={handleBack} />;
  }

  if (selectedDeviceMac && !selectedDevice && !isLoading) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={handleBack} className="gap-1.5" data-testid="button-back-to-devices">
          <ArrowLeft className="h-4 w-4" />
          Back to devices
        </Button>
        <div className="rounded-md border border-border/50 py-10 text-center text-muted-foreground text-sm">
          Device not found — it may no longer be visible on the network
        </div>
      </div>
    );
  }

  const ruckusFeedHealthy = data?.ruckus_feed_healthy ?? true;

  const connectionCacheNewest = data?.connection_cache?.newest ?? null;
  // The warming cron runs every 5 min; treat labels older than ~15 min as stale
  // (a couple of missed ticks) so a single late run doesn't raise a false alarm.
  const connectionCacheStale = connectionCacheNewest !== null
    && (Date.now() - connectionCacheNewest) > 15 * 60 * 1000;

  const needsLabelCount = devices.filter(d => d.needs_label).length;

  const filtered = devices.filter(d => {
    if (needsLabelOnly && !d.needs_label) return false;
    const q = search.toLowerCase();
    const matchesSearch = q === '' || (
      (d.hostname?.toLowerCase().includes(q) ?? false) ||
      (d.ip?.toLowerCase().includes(q) ?? false) ||
      (d.mac?.toLowerCase().includes(q) ?? false) ||
      (d.interface?.toLowerCase().includes(q) ?? false) ||
      (d.device_type?.toLowerCase().includes(q) ?? false) ||
      (d.hardware_vendor?.toLowerCase().includes(q) ?? false)
    );
    if (!matchesSearch) return false;
    if (selectedTypes.size > 0 && !selectedTypes.has(d.device_type || 'Unknown')) return false;
    if (selectedFilters.size === 0) return true;
    if (groupByMode === 'network') {
      const key = d.interface ?? '__unknown__';
      return selectedFilters.has(key);
    } else if (groupByMode === 'connection') {
      return selectedFilters.has(connectionFilterKey(d.connection));
    } else {
      const cat = d.category ?? 'Unknown / Uncategorized';
      return selectedFilters.has(cat);
    }
  });

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  }

  function toggleGroup(name: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const activeCount = devices.filter(d => isRecentlyActive(d.last_seen)).length;

  const typeBreakdown = new Map<string, { count: number; categories: Record<string, number> }>();
  for (const d of devices) {
    const t = d.device_type || 'Unknown';
    const entry = typeBreakdown.get(t) ?? { count: 0, categories: {} };
    entry.count += 1;
    const cat = d.category ?? '';
    if (cat) entry.categories[cat] = (entry.categories[cat] || 0) + 1;
    typeBreakdown.set(t, entry);
  }
  const topTypes = Array.from(typeBreakdown.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 4)
    .map(([type, meta]) => ({
      type,
      count: meta.count,
      category: Object.entries(meta.categories).sort((a, b) => b[1] - a[1])[0]?.[0],
    }));

  const groupMap = new Map<string, ConnectedDevice[]>();
  for (const device of filtered) {
    const key = device.interface ?? '__unknown__';
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key)!.push(device);
  }

  const allGroupMap = new Map<string, number>();
  for (const device of devices) {
    const key = device.interface ?? '__unknown__';
    allGroupMap.set(key, (allGroupMap.get(key) ?? 0) + 1);
  }

  const connectionGroupMap = new Map<string, ConnectedDevice[]>();
  for (const device of filtered) {
    const key = connectionFilterKey(device.connection);
    if (!connectionGroupMap.has(key)) connectionGroupMap.set(key, []);
    connectionGroupMap.get(key)!.push(device);
  }

  const allConnectionGroupMap = new Map<string, number>();
  for (const device of devices) {
    const key = connectionFilterKey(device.connection);
    allConnectionGroupMap.set(key, (allConnectionGroupMap.get(key) ?? 0) + 1);
  }

  const CONNECTION_GROUP_ORDER = ['wired', 'wifi:34', 'wifi:34_AV', 'wifi:34_Guest', 'wifi:unknown', '__unknown__'];
  const sortedConnectionGroupNames = Array.from(connectionGroupMap.keys()).sort((a, b) => {
    const ai = CONNECTION_GROUP_ORDER.indexOf(a);
    const bi = CONNECTION_GROUP_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const allSortedConnectionGroupNames = Array.from(allConnectionGroupMap.keys()).sort((a, b) => {
    const ai = CONNECTION_GROUP_ORDER.indexOf(a);
    const bi = CONNECTION_GROUP_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const CONNECTION_COLORS: Record<string, string> = {
    wired: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
    'wifi:34': 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
    'wifi:34_AV': 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    'wifi:34_Guest': 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    'wifi:unknown': 'bg-blue-500/10 text-blue-500/70 dark:text-blue-400/70 border-blue-500/20',
    '__unknown__': 'bg-muted/30 text-muted-foreground border-border/50',
  };

  const sortedGroupNames = Array.from(groupMap.keys()).sort((a, b) => {
    if (a === '__unknown__') return 1;
    if (b === '__unknown__') return -1;
    return a.localeCompare(b);
  });

  const allSortedGroupNames = Array.from(allGroupMap.keys()).sort((a, b) => {
    if (a === '__unknown__') return 1;
    if (b === '__unknown__') return -1;
    return a.localeCompare(b);
  });

  const colorMap = new Map<string, string>();
  allSortedGroupNames.forEach((name, i) => {
    colorMap.set(name, NETWORK_COLORS[i % NETWORK_COLORS.length]);
  });

  const filteredForCategory = filtered.map(d => ({
    ...d,
    category: d.category ?? 'Unknown / Uncategorized',
    subcategory: d.subcategory ?? 'Unknown',
    vendor: d.vendor ?? (d.hardware_vendor || 'Unknown'),
  }));

  type VendorMap = Map<string, ConnectedDevice[]>;
  type SubcategoryMap = Map<string, VendorMap>;
  const categoryGroupMap = new Map<string, SubcategoryMap>();
  for (const device of filteredForCategory) {
    const cat = device.category;
    const sub = device.subcategory;
    const ven = device.vendor ?? 'Unknown';
    if (!categoryGroupMap.has(cat)) categoryGroupMap.set(cat, new Map());
    const subMap = categoryGroupMap.get(cat)!;
    if (!subMap.has(sub)) subMap.set(sub, new Map());
    const vendorMap = subMap.get(sub)!;
    if (!vendorMap.has(ven)) vendorMap.set(ven, []);
    vendorMap.get(ven)!.push(device);
  }

  const CATEGORY_SORT_LAST = ['People / Personal Devices', 'Unknown / Uncategorized'];
  const sortedCategoryNames = Array.from(categoryGroupMap.keys()).sort((a, b) => {
    const ai = CATEGORY_SORT_LAST.indexOf(a);
    const bi = CATEGORY_SORT_LAST.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return 1;
    if (bi !== -1) return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">Connected Devices</h2>
          <p className="text-sm text-muted-foreground">
            {groupByMode === 'category'
              ? 'All devices seen by the FortiGate, grouped by category'
              : groupByMode === 'connection'
                ? 'All devices seen by the FortiGate, grouped by connection method'
                : 'All devices seen by the FortiGate, grouped by network'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md border border-border/50 overflow-hidden" data-testid="toggle-groupby">
            <button
              className={cn('px-3 py-1.5 text-xs font-medium transition-colors', groupByMode === 'category' ? 'bg-primary text-primary-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40')}
              onClick={() => { setGroupByMode('category'); setSelectedFilters(new Set()); }}
              data-testid="button-groupby-category"
            >
              By Category
            </button>
            <button
              className={cn('px-3 py-1.5 text-xs font-medium transition-colors', groupByMode === 'network' ? 'bg-primary text-primary-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40')}
              onClick={() => { setGroupByMode('network'); setSelectedFilters(new Set()); }}
              data-testid="button-groupby-network"
            >
              By Network
            </button>
            <button
              className={cn('px-3 py-1.5 text-xs font-medium transition-colors', groupByMode === 'connection' ? 'bg-primary text-primary-foreground' : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40')}
              onClick={() => { setGroupByMode('connection'); setSelectedFilters(new Set()); }}
              data-testid="button-groupby-connection"
            >
              By Connection
            </button>
          </div>
          {connectionCacheNewest !== null && (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-xs',
                connectionCacheStale ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
              )}
              title={
                connectionCacheStale
                  ? 'The connection-label warming job may have stalled — labels are older than expected'
                  : 'When the Wired/Wi-Fi connection labels were last recomputed'
              }
              data-testid="text-connection-cache-freshness"
            >
              <Clock className="h-3 w-3" />
              Labels refreshed {formatRelativeTime(Math.floor(connectionCacheNewest / 1000))}
            </span>
          )}
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshConnectionsMutation.mutate()}
              disabled={refreshConnectionsMutation.isPending}
              data-testid="button-refresh-connection-labels"
            >
              <Wifi className={cn('h-4 w-4 mr-1.5', refreshConnectionsMutation.isPending && 'animate-pulse')} />
              {refreshConnectionsMutation.isPending ? 'Refreshing…' : 'Refresh labels'}
            </Button>
          )}
          <LastUpdated timestamp={lastUpdated} />
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} data-testid="button-refresh-devices">
            <RefreshCw className={cn('h-4 w-4 mr-1.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {isError && !isLoading && (
        <ErrorCard message={(error as Error)?.message || 'Unknown error'} onRetry={refetch} />
      )}

      {needsLabelOnly && !isLoading && (
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm" data-testid="banner-needs-labeling">
          <Tag className="h-4 w-4 text-amber-500 shrink-0" />
          <div className="flex-1 text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">Needs labeling filter active</span> — showing {filtered.length} device{filtered.length !== 1 ? 's' : ''} that need a name, category, or owner. Personal devices tagged <span className="font-medium">owner</span> already have a category but still need to be attributed to a person. Use the pencil icon to assign one.
          </div>
          <button
            className="text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 text-xs underline"
            onClick={() => setNeedsLabelOnly(false)}
            data-testid="button-clear-needs-labeling"
          >
            Clear filter
          </button>
        </div>
      )}

      {!isLoading && !isError && !ruckusFeedHealthy && devices.length > 0 && (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm" data-testid="banner-ruckus-degraded">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-xs text-amber-700 dark:text-amber-400">
            <span className="font-medium">Ruckus feed offline</span> — Wi-Fi SSIDs and wired/wireless detection are inferred from device type rather than confirmed by the controller. Results will sharpen automatically when Ruckus reconnects.
          </div>
        </div>
      )}

      {!isLoading && devices.length > 0 && (
        <div className="space-y-2">
          {groupByMode === 'network' && (
            <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg border border-border/50 bg-muted/20" data-testid="network-summary-bar">
              <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground font-medium mr-1">Networks:</span>
              {allSortedGroupNames.map(name => {
                const count = allGroupMap.get(name) ?? 0;
                const label = name === '__unknown__' ? 'Other / Unknown' : name;
                const color = colorMap.get(name) ?? NETWORK_COLORS[0];
                const isActive = selectedFilters.has(name);
                return (
                  <span
                    key={name}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleFilter(name)}
                    onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleFilter(name)}
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer select-none transition-all',
                      color,
                      isActive ? 'ring-2 ring-offset-1 ring-current scale-105 shadow-sm' : 'opacity-80 hover:opacity-100'
                    )}
                    data-testid={`badge-network-${name}`}
                  >
                    {label}
                    <span className="font-bold">{count}</span>
                  </span>
                );
              })}
            </div>
          )}
          {groupByMode === 'connection' && allSortedConnectionGroupNames.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg border border-border/50 bg-muted/20" data-testid="connection-summary-bar">
              <Wifi className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground font-medium mr-1">Connection:</span>
              {allSortedConnectionGroupNames.map(key => {
                const count = allConnectionGroupMap.get(key) ?? 0;
                const label = connectionFilterLabel(key);
                const color = CONNECTION_COLORS[key] ?? NETWORK_COLORS[0];
                const isActive = selectedFilters.has(key);
                return (
                  <span
                    key={key}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleFilter(key)}
                    onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleFilter(key)}
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer select-none transition-all',
                      color,
                      isActive ? 'ring-2 ring-offset-1 ring-current scale-105 shadow-sm' : 'opacity-80 hover:opacity-100'
                    )}
                    data-testid={`badge-conn-${key}`}
                  >
                    {key === 'wired' && <Cable className="h-3 w-3" />}
                    {key.startsWith('wifi:') && <Wifi className="h-3 w-3" />}
                    {label}
                    <span className="font-bold">{count}</span>
                  </span>
                );
              })}
            </div>
          )}
          {groupByMode === 'category' && sortedCategoryNames.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-lg border border-border/50 bg-muted/20" data-testid="category-summary-bar">
              <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground font-medium mr-1">Categories:</span>
              {sortedCategoryNames.map((catName, i) => {
                const subMap = categoryGroupMap.get(catName)!;
                const count = Array.from(subMap.values()).flatMap(vm => Array.from(vm.values()).flat()).length;
                const isActive = selectedFilters.has(catName);
                const ChipIcon = categoryIconFor(catName);
                return (
                  <span
                    key={catName}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleFilter(catName)}
                    onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && toggleFilter(catName)}
                    className={cn(
                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer select-none transition-all',
                      NETWORK_COLORS[i % NETWORK_COLORS.length],
                      isActive ? 'ring-2 ring-offset-1 ring-current scale-105 shadow-sm' : 'opacity-80 hover:opacity-100'
                    )}
                    data-testid={`badge-category-${catName}`}
                  >
                    <ChipIcon className="h-3 w-3 shrink-0" />
                    {catName}
                    <span className="font-bold">{count}</span>
                  </span>
                );
              })}
            </div>
          )}
          {/* Device count summary bar */}
          <div className="flex flex-wrap items-center gap-3 px-3 py-2 rounded-lg border border-border/50 bg-muted/20" data-testid="bar-device-summary">
            <div className="flex items-center gap-1.5">
              <Users className="h-4 w-4 text-blue-400 shrink-0" />
              <span className="text-sm font-semibold" data-testid="text-device-total">{devices.length}</span>
              <span className="text-xs text-muted-foreground">total</span>
            </div>
            <div className="h-4 w-px bg-border/50" />
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400" data-testid="text-device-active">{activeCount}</span>
              <span className="text-xs text-muted-foreground">active now</span>
            </div>
            {needsLabelCount > 0 && (
              <>
                <div className="h-4 w-px bg-border/50" />
                <button
                  role="button"
                  onClick={() => { setNeedsLabelOnly(v => !v); setSelectedFilters(new Set()); }}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border cursor-pointer select-none transition-all',
                    needsLabelOnly
                      ? 'bg-amber-500/20 text-amber-700 dark:text-amber-400 border-amber-500/40 ring-2 ring-amber-500/30 shadow-sm'
                      : 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20 hover:bg-amber-500/20',
                  )}
                  data-testid="chip-needs-labeling"
                  title="Show only devices that need a human to assign a name, category, or owner"
                >
                  <Tag className="h-3 w-3" />
                  Needs labeling
                  <span className="font-bold">{needsLabelCount}</span>
                </button>
              </>
            )}
            {topTypes.length > 0 && (
              <>
                <div className="h-4 w-px bg-border/50" />
                <div className="flex flex-wrap gap-1.5">
                  {topTypes.map(({ type, count, category }) => {
                    const TypeIcon = category ? categoryIconFor(category) : Layers;
                    const isActive = selectedTypes.has(type);
                    return (
                      <Badge
                        key={type}
                        variant="secondary"
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleTypeFilter(type)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggleTypeFilter(type);
                          }
                        }}
                        className={cn(
                          'text-xs gap-1 cursor-pointer select-none transition-all',
                          isActive
                            ? 'ring-2 ring-offset-1 ring-primary scale-105 shadow-sm'
                            : 'opacity-80 hover:opacity-100',
                        )}
                        aria-pressed={isActive}
                        title={isActive ? `Clear ${type} filter` : `Filter to ${type} devices`}
                        data-testid={`badge-device-type-${type}`}
                      >
                        <TypeIcon className="h-3 w-3 shrink-0" />
                        {type}
                        <span className="text-muted-foreground font-mono">{count}</span>
                      </Badge>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by hostname, IP, MAC, vendor, interface…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-sm"
          data-testid="input-device-search"
        />
        {data && (
          <span className="text-sm text-muted-foreground">
            {filtered.length} of {devices.length} device{devices.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <SectionSkeleton rows={6} />
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-border/50 py-10 text-center text-muted-foreground text-sm">
          {search ? 'No devices match your search' : 'No devices found'}
        </div>
      ) : groupByMode === 'category' ? (
        <div className="space-y-3">
          {sortedCategoryNames.map((catName, ci) => {
            const subMap = categoryGroupMap.get(catName)!;
            const catDevices = Array.from(subMap.values()).flatMap(vm => Array.from(vm.values()).flat());
            const catActive = catDevices.filter(d => isRecentlyActive(d.last_seen)).length;
            const isCatCollapsed = collapsedGroups.has(`cat:${catName}`);
            const catColor = NETWORK_COLORS[ci % NETWORK_COLORS.length];
            const CatIcon = categoryIconFor(catName);
            return (
              <div key={catName} className="rounded-md border border-border/50 overflow-hidden" data-testid={`group-category-${catName}`}>
                <button
                  className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                  onClick={() => toggleGroup(`cat:${catName}`)}
                  data-testid={`button-toggle-category-${catName}`}
                >
                  <div className="flex items-center gap-3">
                    <CatIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-semibold text-sm">{catName}</span>
                    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border', catColor)} data-testid={`badge-category-count-${catName}`}>
                      {catDevices.length} device{catDevices.length !== 1 ? 's' : ''}
                    </span>
                    {catActive > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {catActive} active
                      </span>
                    )}
                  </div>
                  {isCatCollapsed
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    : <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  }
                </button>
                {!isCatCollapsed && (
                  <div className="divide-y divide-border/30">
                    {Array.from(subMap.entries())
                      .sort(([, aVm], [, bVm]) => {
                        const aCount = Array.from(aVm.values()).flat().length;
                        const bCount = Array.from(bVm.values()).flat().length;
                        return bCount - aCount;
                      })
                      .map(([subName, vendorMap], si) => {
                        const subDevices = Array.from(vendorMap.values()).flat();
                        const subTotal = subDevices.length;
                        const subActive = subDevices.filter(d => isRecentlyActive(d.last_seen)).length;
                        const isSubCollapsed = collapsedGroups.has(`sub:${catName}:${subName}`);
                        return (
                          <div key={subName} data-testid={`group-subcategory-${catName}-${subName}`}>
                            <button
                              className="w-full flex items-center justify-between px-6 py-2.5 bg-muted/10 hover:bg-muted/30 transition-colors text-left"
                              onClick={() => toggleGroup(`sub:${catName}:${subName}`)}
                              data-testid={`button-toggle-subcategory-${catName}-${subName}`}
                            >
                              <div className="flex items-center gap-2.5">
                                <Network className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                <span className="font-medium text-sm">{subName}</span>
                                <Badge variant="secondary" className="text-xs" data-testid={`badge-sub-count-${catName}-${subName}`}>
                                  {subTotal}
                                </Badge>
                                {subActive > 0 && (
                                  <span className="text-xs text-emerald-600 dark:text-emerald-400">
                                    {subActive} active
                                  </span>
                                )}
                              </div>
                              {isSubCollapsed
                                ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                : <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                              }
                            </button>
                            {!isSubCollapsed && (
                              <div className="divide-y divide-border/20">
                                {Array.from(vendorMap.entries())
                                  .sort(([, a], [, b]) => b.length - a.length)
                                  .map(([venName, venDevices], vi) => {
                                    const venActive = venDevices.filter(d => isRecentlyActive(d.last_seen)).length;
                                    const isVenCollapsed = collapsedGroups.has(`ven:${catName}:${subName}:${venName}`);
                                    return (
                                      <div key={venName} data-testid={`group-vendor-${catName}-${subName}-${venName}`}>
                                        <button
                                          className="w-full flex items-center justify-between px-8 py-2 bg-muted/5 hover:bg-muted/20 transition-colors text-left"
                                          onClick={() => toggleGroup(`ven:${catName}:${subName}:${venName}`)}
                                          data-testid={`button-toggle-vendor-${catName}-${subName}-${venName}`}
                                        >
                                          <div className="flex items-center gap-2">
                                            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                                            <span className="text-sm text-foreground/80">{venName}</span>
                                            <Badge variant="outline" className="text-xs" data-testid={`badge-vendor-count-${catName}-${subName}-${venName}`}>
                                              {venDevices.length}
                                            </Badge>
                                            {venActive > 0 && (
                                              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                                {venActive} active
                                              </span>
                                            )}
                                          </div>
                                          {isVenCollapsed
                                            ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                            : <ChevronUp className="h-3 w-3 text-muted-foreground" />
                                          }
                                        </button>
                                        {!isVenCollapsed && (
                                          <div className="overflow-x-auto">
                                            <DeviceTableRows
                                              devices={venDevices}
                                              sortKey={sortKey}
                                              sortAsc={sortAsc}
                                              handleSort={handleSort}
                                              groupIndex={ci * 10000 + si * 100 + vi}
                                              groupName={`${catName}-${subName}-${venName}`}
                                              onDeviceClick={handleDeviceClick}
                                            />
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : groupByMode === 'connection' ? (
        <div className="space-y-3">
          {sortedConnectionGroupNames.map((connKey, ci) => {
            const groupDevices = connectionGroupMap.get(connKey) ?? [];
            const label = connectionFilterLabel(connKey);
            const isCollapsed = collapsedGroups.has(`conn:${connKey}`);
            const color = CONNECTION_COLORS[connKey] ?? NETWORK_COLORS[0];
            const activeCount2 = groupDevices.filter(d => isRecentlyActive(d.last_seen)).length;
            const IconComp = connKey === 'wired' ? Cable : connKey.startsWith('wifi:') ? Wifi : HelpCircle;

            return (
              <div key={connKey} className="rounded-md border border-border/50 overflow-hidden" data-testid={`group-connection-${connKey}`}>
                <button
                  className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                  onClick={() => toggleGroup(`conn:${connKey}`)}
                  data-testid={`button-toggle-conn-${connKey}`}
                >
                  <div className="flex items-center gap-3">
                    <IconComp className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-semibold text-sm">{label}</span>
                    <span
                      className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border', color)}
                      data-testid={`badge-conn-count-${connKey}`}
                    >
                      {groupDevices.length} device{groupDevices.length !== 1 ? 's' : ''}
                    </span>
                    {activeCount2 > 0 && (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        {activeCount2} active
                      </span>
                    )}
                  </div>
                  {isCollapsed
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    : <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  }
                </button>

                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <DeviceTableRows
                      devices={groupDevices}
                      sortKey={sortKey}
                      sortAsc={sortAsc}
                      handleSort={handleSort}
                      groupIndex={ci}
                      groupName={connKey}
                      onDeviceClick={handleDeviceClick}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {sortedGroupNames.map((groupName, gi) => {
            const groupDevices = groupMap.get(groupName) ?? [];
            const label = groupName === '__unknown__' ? 'Other / Unknown' : groupName;
            const isCollapsed = collapsedGroups.has(groupName);
            const color = colorMap.get(groupName) ?? NETWORK_COLORS[0];

            return (
              <div key={groupName} className="rounded-md border border-border/50 overflow-hidden" data-testid={`group-network-${groupName}`}>
                <button
                  className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                  onClick={() => toggleGroup(groupName)}
                  data-testid={`button-toggle-group-${groupName}`}
                >
                  <div className="flex items-center gap-3">
                    <Network className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-semibold text-sm">{label}</span>
                    <span
                      className={cn('inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold border', color)}
                      data-testid={`badge-group-count-${groupName}`}
                    >
                      {groupDevices.length} device{groupDevices.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {isCollapsed
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    : <ChevronUp className="h-4 w-4 text-muted-foreground" />
                  }
                </button>

                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <DeviceTableRows
                      devices={groupDevices}
                      sortKey={sortKey}
                      sortAsc={sortAsc}
                      handleSort={handleSort}
                      groupIndex={gi}
                      groupName={groupName}
                      onDeviceClick={handleDeviceClick}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
