import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { HealthScore, FortiViewStatusResponse } from './types';

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatRelativeTime(epochSeconds: number | null): string {
  if (epochSeconds === null) return '—';
  const diffMs = Date.now() - epochSeconds * 1000;
  const diffSecs = Math.floor(diffMs / 1000);
  if (diffSecs < 60) return `${diffSecs}s ago`;
  const diffMins = Math.floor(diffSecs / 60);
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function formatTimestamp(ts: string | null): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  return formatUptime(seconds);
}

export function typeLabel(type: string): string {
  const map: Record<string, string> = {
    physical: 'Physical',
    vlan: 'VLAN',
    aggregate: 'Aggregate',
    loopback: 'Loopback',
    tunnel: 'Tunnel',
    vdom: 'VDOM',
    hard_switch: 'Hard Switch',
  };
  return map[type] || type;
}

export function usageColor(pct: number | null): string {
  if (pct === null) return 'text-muted-foreground';
  if (pct >= 85) return 'text-red-500';
  if (pct >= 60) return 'text-yellow-500';
  return 'text-emerald-500';
}

export function usageBarColor(pct: number | null): string {
  if (pct === null) return '';
  if (pct >= 85) return 'bg-red-500';
  if (pct >= 60) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

export function severityBadgeVariant(severity: string): 'destructive' | 'secondary' | 'outline' {
  const s = severity.toLowerCase();
  if (s === 'critical' || s === 'high') return 'destructive';
  if (s === 'medium' || s === 'warning') return 'secondary';
  return 'outline';
}

export function isRecentlyActive(lastSeenEpoch: number | null): boolean {
  if (lastSeenEpoch === null) return false;
  const diffMs = Date.now() - lastSeenEpoch * 1000;
  return diffMs < 5 * 60 * 1000;
}

export function safeNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && isFinite(val)) return val;
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>;
    if ('current' in obj) return safeNumber(obj['current']);
  }
  return null;
}

export function computeHealthScore({
  wanUp,
  cpuPct,
  memPct,
  highThreats,
  critThreats,
  latencyMs,
  downloadMbps,
}: {
  wanUp: boolean | null;
  cpuPct: number | null;
  memPct: number | null;
  highThreats: number;
  critThreats: number;
  latencyMs: number | null;
  downloadMbps: number | null;
}): HealthScore {
  if (wanUp === false) return 'red';
  if (critThreats > 0) return 'red';
  if ((cpuPct ?? 0) >= 85) return 'red';
  if ((memPct ?? 0) >= 85) return 'red';
  if ((downloadMbps ?? 9999) < 25) return 'red';
  if (highThreats > 0) return 'yellow';
  if ((cpuPct ?? 0) >= 60) return 'yellow';
  if ((memPct ?? 0) >= 60) return 'yellow';
  if ((latencyMs ?? 0) > 50) return 'yellow';
  if ((downloadMbps ?? 9999) < 100) return 'yellow';
  return 'green';
}

export function useFortiViewStatus() {
  return useQuery<FortiViewStatusResponse>({
    queryKey: ['/api/fortigate/fortiview-status'],
    queryFn: () => apiClient.get<FortiViewStatusResponse>('/api/fortigate/fortiview-status'),
    staleTime: 60_000,
    retry: 1,
  });
}
