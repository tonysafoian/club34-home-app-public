/**
 * Unit tests for server/lib/device-connection.ts
 *
 * This helper is the single source of truth shared by the /api/fortigate/devices
 * endpoint (cache-miss slow path) and the Ruckus snapshot cron (cache refresh).
 * The tests lock in (a) the FortiGate field-aliasing, (b) IP extraction across
 * FortiOS shapes, and (c) that endpoint + cron produce IDENTICAL results given
 * the same device + override + context — the property the cache relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  extractIpAddress,
  extractDeviceFields,
  resolveDeviceConnection,
} from '../lib/device-connection.js';
import { buildRuckusMaps } from '../lib/connection-resolver.js';
import type { ConnectionResolverContext, RuckusDbRow } from '../lib/connection-resolver.js';

function ctxFrom(rows: RuckusDbRow[], healthy = true): ConnectionResolverContext {
  const { liveRuckusByMac, recentRuckusByMac, ruckusFeedHealthy } = buildRuckusMaps(rows, healthy);
  return { liveRuckusByMac, recentRuckusByMac, ruckusFeedHealthy };
}

const emptyCtx: ConnectionResolverContext = {
  liveRuckusByMac: new Map(),
  recentRuckusByMac: new Map(),
  ruckusFeedHealthy: false,
};

describe('extractIpAddress', () => {
  it('reads scalar ipv4_address', () => {
    expect(extractIpAddress({ ipv4_address: '192.168.1.1' })).toBe('192.168.1.1');
  });
  it('reads first entry of ipv4_addresses string array', () => {
    expect(extractIpAddress({ ipv4_addresses: ['10.0.22.6', '10.0.22.7'] })).toBe('10.0.22.6');
  });
  it('reads ip field out of ipv4_addresses object array', () => {
    expect(extractIpAddress({ ipv4_addresses: [{ ip: '10.0.22.8' }] })).toBe('10.0.22.8');
  });
  it('falls back to legacy ipaddr / ip', () => {
    expect(extractIpAddress({ ipaddr: '10.0.22.9' })).toBe('10.0.22.9');
    expect(extractIpAddress({ ip: '10.0.22.10' })).toBe('10.0.22.10');
  });
  it('returns null when no address present', () => {
    expect(extractIpAddress({})).toBeNull();
  });
});

describe('extractDeviceFields', () => {
  it('prefers FortiGate primary keys and falls back to aliases', () => {
    const fields = extractDeviceFields({
      vendor: 'Apple', dev_type: 'Mobile Phone', os: 'iOS', hostname: 'iPhone', mac: 'AA:BB:CC:DD:EE:01', ipv4_address: '10.0.22.20',
    });
    expect(fields).toEqual({
      hw_vendor: 'Apple', dev_type: 'Mobile Phone', os_type: 'iOS', hostname: 'iPhone', mac: 'AA:BB:CC:DD:EE:01', ip: '10.0.22.20',
    });
  });
  it('uses hardware_vendor/device_type/os_type/name aliases when primaries absent', () => {
    const fields = extractDeviceFields({
      hardware_vendor: 'Synology', device_type: 'NAS', os_type: 'DSM', name: 'NAS-01', mac: 'AA:BB:CC:DD:EE:02',
    });
    expect(fields.hw_vendor).toBe('Synology');
    expect(fields.dev_type).toBe('NAS');
    expect(fields.os_type).toBe('DSM');
    expect(fields.hostname).toBe('NAS-01');
  });
});

describe('resolveDeviceConnection', () => {
  it('normalizes the MAC for cache keying', () => {
    const { normalizedMac } = resolveDeviceConnection({ mac: 'AA-BB-CC-DD-EE-03' }, null, emptyCtx);
    expect(normalizedMac).toBe('aa:bb:cc:dd:ee:03');
  });

  it('returns a wifi-confirmed label when the MAC is live on Ruckus', () => {
    const ctx = ctxFrom([{ mac_address: 'aa:bb:cc:dd:ee:04', ssids: ['34'], last_seen: new Date() }]);
    const { connection } = resolveDeviceConnection(
      { mac: 'AA:BB:CC:DD:EE:04', vendor: 'Apple', hostname: 'iPhone' },
      null,
      ctx,
    );
    expect(connection.method).toBe('wifi');
    expect(connection.ssid).toBe('34');
  });

  it('applies the override category to the heuristic tier', () => {
    // Featureless device (no MAC observation, no telling hostname/type) so the
    // resolution is driven purely by category. Base = unknown; pinning it to a
    // mobile category via the override must flip it to a wifi heuristic.
    const device = { mac: 'AA:BB:CC:DD:EE:05' };
    const base = resolveDeviceConnection(device, null, emptyCtx);
    const overridden = resolveDeviceConnection(
      device,
      { customCategory: 'Mobile Phones & Tablets', customSubcategory: null },
      emptyCtx,
    );
    expect(base.connection.method).toBe('unknown');
    expect(overridden.connection.method).toBe('wifi');
    expect(overridden.connection).not.toEqual(base.connection);
  });

  it('produces identical results for the same inputs (endpoint == cron invariant)', () => {
    const device = { mac: 'AA:BB:CC:DD:EE:06', vendor: 'Apple', hostname: 'HomePod', device_type: null };
    const ctx = ctxFrom([{ mac_address: 'aa:bb:cc:dd:ee:06', ssids: ['34_AV'], last_seen: new Date() }]);
    const a = resolveDeviceConnection(device, null, ctx);
    const b = resolveDeviceConnection(device, null, ctx);
    expect(a.connection).toEqual(b.connection);
    expect(a.normalizedMac).toBe(b.normalizedMac);
    expect(a.classification.category).toBe(b.classification.category);
  });
});
