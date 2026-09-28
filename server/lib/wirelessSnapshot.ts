// Wireless observability — snapshot + event detection
//
// Pure functions for transforming a fan-out of (system, aps, clients,
// ssids) into:
//   - a `wireless_snapshots` row body
//   - a list of derived `wireless_events` (by diffing against the
//     previous snapshot)
//
// Kept pure (no db calls) so the unit tests can exercise diff logic
// without any database fixture. The /api/wireless-snapshot route is
// the one that actually inserts.

import type {
  RuckusAccessPoint,
  RuckusClient,
  RuckusSSID,
} from './ruckus.js';

export interface SnapshotRowBody {
  ap_total: number;
  ap_online: number;
  ap_offline: number;
  ap_unknown: number;
  client_total: number;
  ssid_total: number;
  clients_by_ssid: Record<string, number>;
  aps_by_mac: Record<string, ApSnapshot>;
  stale: boolean;
  section_errors: Record<string, string>;
}

export interface ApSnapshot {
  name: string;
  status: string;
  client_count: number;
}

export interface DerivedEvent {
  event_type:
    | 'ap_joined'
    | 'ap_disconnected'
    | 'ap_unknown'
    | 'ap_new'
    | 'ap_removed'
    | 'ssid_clients_drop'
    | 'telemetry_stale_lkg_served';
  severity: 'info' | 'warn' | 'error';
  evidence: 'controller' | 'client' | 'telemetry';
  summary: string;
  detail: Record<string, unknown>;
}

export interface BuildSnapshotInput {
  aps: RuckusAccessPoint[];
  clients: RuckusClient[];
  ssids: RuckusSSID[];
  stale: boolean;
  sectionErrors: Record<string, string>;
}

export function buildSnapshotRow(input: BuildSnapshotInput): SnapshotRowBody {
  const apOnline = input.aps.filter((a) => a.status === 'joined').length;
  const apOffline = input.aps.filter((a) => a.status === 'disconnected').length;
  const apUnknown = input.aps.filter((a) => a.status === 'unknown').length;

  const clientsBySsid: Record<string, number> = {};
  for (const c of input.clients) {
    if (!c.ssid) continue;
    clientsBySsid[c.ssid] = (clientsBySsid[c.ssid] ?? 0) + 1;
  }

  const clientsByAp = new Map<string, number>();
  for (const c of input.clients) {
    const key = c.ap_mac || c.ap_name || '';
    if (!key) continue;
    clientsByAp.set(key, (clientsByAp.get(key) ?? 0) + 1);
  }

  const apsByMac: Record<string, ApSnapshot> = {};
  for (const ap of input.aps) {
    apsByMac[ap.mac] = {
      name: ap.name,
      status: ap.status ?? 'unknown',
      client_count: clientsByAp.get(ap.mac) ?? clientsByAp.get(ap.name) ?? 0,
    };
  }

  return {
    ap_total: input.aps.length,
    ap_online: apOnline,
    ap_offline: apOffline,
    ap_unknown: apUnknown,
    client_total: input.clients.length,
    ssid_total: input.ssids.length,
    clients_by_ssid: clientsBySsid,
    aps_by_mac: apsByMac,
    stale: input.stale,
    section_errors: input.sectionErrors,
  };
}

// Diff thresholds — kept conservative so we don't drown the audit log
// in benign blips. A drop of <50% with <3 absolute clients is not worth
// alerting on; transient client roams are normal.
const SSID_DROP_RATIO = 0.5;
const SSID_DROP_MIN_ABSOLUTE = 3;

export function detectEvents(
  prev: SnapshotRowBody | null,
  curr: SnapshotRowBody,
): DerivedEvent[] {
  const events: DerivedEvent[] = [];
  if (!prev) {
    // First snapshot ever — no diff to make, but if we're already
    // serving stale telemetry, record that fact.
    if (curr.stale) {
      events.push(staleEvent(curr));
    }
    return events;
  }

  const prevAps = prev.aps_by_mac ?? {};
  const currAps = curr.aps_by_mac ?? {};

  // AP state transitions
  for (const [mac, c] of Object.entries(currAps)) {
    const p = prevAps[mac];
    if (!p) {
      events.push({
        event_type: 'ap_new',
        severity: 'info',
        evidence: 'controller',
        summary: `New AP discovered: ${c.name} (${mac}) — status ${c.status}`,
        detail: { mac, name: c.name, status: c.status },
      });
      continue;
    }
    if (p.status === c.status) continue;
    if (p.status === 'joined' && c.status === 'disconnected') {
      events.push({
        event_type: 'ap_disconnected',
        severity: 'warn',
        evidence: 'controller',
        summary: `AP ${c.name} went joined → disconnected`,
        detail: { mac, name: c.name, prev_status: p.status, curr_status: c.status },
      });
    } else if (p.status === 'joined' && c.status === 'unknown') {
      events.push({
        event_type: 'ap_unknown',
        severity: 'warn',
        evidence: 'controller',
        summary: `AP ${c.name} went joined → unknown (controller stopped reporting state)`,
        detail: { mac, name: c.name, prev_status: p.status, curr_status: c.status },
      });
    } else if (p.status !== 'joined' && c.status === 'joined') {
      events.push({
        event_type: 'ap_joined',
        severity: 'info',
        evidence: 'controller',
        summary: `AP ${c.name} (${mac}) joined`,
        detail: { mac, name: c.name, prev_status: p.status, curr_status: c.status },
      });
    }
  }

  // APs that disappeared from the controller entirely
  for (const [mac, p] of Object.entries(prevAps)) {
    if (!currAps[mac]) {
      events.push({
        event_type: 'ap_removed',
        severity: 'warn',
        evidence: 'controller',
        summary: `AP ${p.name} (${mac}) no longer reported by controller`,
        detail: { mac, name: p.name, last_status: p.status },
      });
    }
  }

  // SSID client-count cliff (client-evidence, not controller). We must
  // iterate the UNION of prev/curr SSID keys: buildSnapshotRow omits
  // SSIDs at zero clients, so a true N→0 outage would never appear in
  // `curr.clients_by_ssid` and we'd miss the biggest signal we have.
  const prevSsids = prev.clients_by_ssid ?? {};
  const currSsids = curr.clients_by_ssid ?? {};
  const allSsids = new Set([...Object.keys(prevSsids), ...Object.keys(currSsids)]);
  for (const ssid of allSsids) {
    const prevCount = prevSsids[ssid] ?? 0;
    const currCount = currSsids[ssid] ?? 0;
    if (
      prevCount >= SSID_DROP_MIN_ABSOLUTE &&
      currCount <= Math.floor(prevCount * SSID_DROP_RATIO)
    ) {
      events.push({
        event_type: 'ssid_clients_drop',
        severity: currCount === 0 ? 'error' : 'warn',
        evidence: 'client',
        summary: `SSID "${ssid}" client count fell ${prevCount} → ${currCount}`,
        detail: { ssid, prev: prevCount, curr: currCount },
      });
    }
  }

  // Telemetry quality — only emit on the rising edge (prev clean, curr stale)
  if (curr.stale && !prev.stale) {
    events.push(staleEvent(curr));
  }

  return events;
}

function staleEvent(curr: SnapshotRowBody): DerivedEvent {
  const sections = Object.keys(curr.section_errors ?? {}).join(', ') || 'unknown';
  return {
    event_type: 'telemetry_stale_lkg_served',
    severity: 'info',
    evidence: 'telemetry',
    summary: `Wireless poll degraded — serving last-known-good for sections: ${sections}`,
    detail: { section_errors: curr.section_errors },
  };
}

// Plain-English one-liner for /api/wireless/diagnostics.
export function summarize(curr: SnapshotRowBody, recentEvents: DerivedEvent[]): string {
  const parts: string[] = [];
  parts.push(
    `${curr.ap_online}/${curr.ap_total} APs online` +
      (curr.ap_unknown > 0 ? ` (${curr.ap_unknown} unknown)` : '') +
      `, ${curr.client_total} clients across ${curr.ssid_total} SSIDs.`,
  );
  if (curr.stale) {
    const sections = Object.keys(curr.section_errors ?? {}).join(', ');
    parts.push(`Telemetry stale (${sections}) — last-known-good served.`);
  }
  const warns = recentEvents.filter((e) => e.severity !== 'info');
  if (warns.length > 0) {
    parts.push(`${warns.length} recent alert${warns.length === 1 ? '' : 's'}.`);
  } else {
    parts.push('No recent alerts.');
  }
  return parts.join(' ');
}
