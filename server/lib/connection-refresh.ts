/**
 * Shared connection-method cache refresh.
 *
 * Recomputes and persists the connection-method label (Wired/WiFi/Unknown)
 * for every FortiGate device into network_devices.resolved_connection. Used by
 * two callers that must produce identical results:
 *   - the 5-min Ruckus snapshot cron (server/routes/wireless.ts), which warms
 *     the cache after fresh controller data lands, and
 *   - the admin-triggered "Refresh connection labels" endpoint
 *     (server/routes/fortigate.ts), which lets an admin force a recompute
 *     after re-cabling a device instead of waiting for the next cron tick.
 *
 * Lives in lib (not in a route module) so both callers can share it without
 * a circular import between the wireless and fortigate route files. Uses the
 * exact same helpers (loadRuckusContext + resolveDeviceConnection) as the
 * /api/fortigate/devices slow path, guaranteeing the cached value matches what
 * the endpoint would compute on a miss.
 *
 * Best-effort by contract: callers wrap it so a failure can never break the
 * snapshot response, but it surfaces the FortiGate fetch error to the admin
 * endpoint so a forced refresh can report why it found no devices.
 */

import { fortigateGet, isFortigateConfigured } from './fortigate.js';
import { storage } from '../storage';
import { loadRuckusContext, writeCachedConnections } from './connection-cache.js';
import { resolveDeviceConnection } from './device-connection.js';
import type { ConnectionMethod } from './connection-resolver.js';

export async function refreshConnectionMethodCache(): Promise<number> {
  if (!isFortigateConfigured()) return 0;

  const dData = await fortigateGet('/api/v2/monitor/user/device/query?with_forticlient=false');
  const results = dData['results'];
  const devices: Record<string, unknown>[] = (Array.isArray(results) ? results : [])
    .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object');
  if (devices.length === 0) return 0;

  const overridesList = await storage.getDeviceOverrides().catch(() => []);
  const overridesMap = new Map(overridesList.map(o => [o.mac, o] as const));
  const ctx = await loadRuckusContext();

  const entries: Array<{ mac: string; connection: ConnectionMethod }> = [];
  for (const d of devices) {
    const override = typeof d['mac'] === 'string' ? overridesMap.get(d['mac']) : null;
    const { normalizedMac, connection } = resolveDeviceConnection(d, override, ctx);
    if (normalizedMac) entries.push({ mac: normalizedMac, connection });
  }

  await writeCachedConnections(entries);
  return entries.length;
}
