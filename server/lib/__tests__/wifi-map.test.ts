import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUBNET_MAP,
  ipInCidr,
  resolveSubnetLabel,
  resolveWifiSource,
  type RuckusObservation,
} from '../wifi-map.js';

describe('wifi-map subnet defaults', () => {
  it('has the 10.0.22.0/23 family subnet seeded to "34"', () => {
    expect(DEFAULT_SUBNET_MAP.some(s => s.cidr === '10.0.22.0/23' && s.label === '34')).toBe(true);
  });
});

describe('ipInCidr', () => {
  it('matches the observed family laptop IP', () => {
    expect(ipInCidr('10.0.22.170', '10.0.22.0/23')).toBe(true);
    expect(ipInCidr('10.0.23.99', '10.0.22.0/23')).toBe(true);
  });

  it('rejects IPs outside the CIDR', () => {
    expect(ipInCidr('10.0.24.1', '10.0.22.0/23')).toBe(false);
    expect(ipInCidr('192.168.1.1', '10.0.22.0/23')).toBe(false);
  });

  it('returns false for malformed input rather than throwing', () => {
    expect(ipInCidr('not-an-ip', '10.0.22.0/23')).toBe(false);
    expect(ipInCidr('10.0.22.1', 'garbage')).toBe(false);
    expect(ipInCidr('10.0.22.1', '10.0.22.0/99')).toBe(false);
  });

  it('handles /32 and /0 edges', () => {
    expect(ipInCidr('10.0.22.1', '10.0.22.1/32')).toBe(true);
    expect(ipInCidr('10.0.22.2', '10.0.22.1/32')).toBe(false);
    expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });
});

describe('resolveSubnetLabel', () => {
  it('labels devices on the trusted family LAN', () => {
    expect(resolveSubnetLabel('10.0.22.170')).toBe('34');
    expect(resolveSubnetLabel('10.0.23.50')).toBe('34');
  });

  it('returns null for IPs outside the seeded subnets', () => {
    expect(resolveSubnetLabel('192.168.99.1')).toBeNull();
    expect(resolveSubnetLabel(null)).toBeNull();
    expect(resolveSubnetLabel(undefined)).toBeNull();
  });
});

describe('resolveWifiSource — grouping precedence', () => {
  function obs(ssid: string, expected: string | null = null): RuckusObservation {
    return { ssids: [ssid], expected_ssid: expected, last_seen: new Date().toISOString() };
  }

  it('fresh Ruckus observation wins over subnet fallback', () => {
    const map = new Map<string, RuckusObservation>([
      ['aa:bb:cc:dd:ee:01', obs('34_AV')],
    ]);
    // Subnet would say "34", but Ruckus disambiguates to 34_AV.
    const r = resolveWifiSource('aa:bb:cc:dd:ee:01', '10.0.22.170', map);
    expect(r.label).toBe('34_AV');
    expect(r.source).toBe('ruckus');
    expect(r.ruckus?.ssids[0]).toBe('34_AV');
  });

  it('falls back to subnet when there is no Ruckus row for this MAC', () => {
    const map = new Map<string, RuckusObservation>();
    const r = resolveWifiSource('aa:bb:cc:dd:ee:02', '192.168.1.10', map);
    expect(r.label).toBe('34');
    expect(r.source).toBe('subnet');
    expect(r.ruckus).toBeNull();
  });

  it('falls back to subnet when the Ruckus row has an empty ssids array', () => {
    // Caller only inserts rows with non-empty ssids today (the SQL
    // filters jsonb_array_length > 0), but the helper must still cope
    // with the edge case in case a future caller relaxes that filter.
    const map = new Map<string, RuckusObservation>([
      ['aa:bb:cc:dd:ee:03', { ssids: [], expected_ssid: null, last_seen: null }],
    ]);
    const r = resolveWifiSource('aa:bb:cc:dd:ee:03', '192.168.1.10', map);
    expect(r.label).toBe('34');
    expect(r.source).toBe('subnet');
  });

  it('returns Unknown when neither Ruckus nor subnet matches', () => {
    const map = new Map<string, RuckusObservation>();
    const r = resolveWifiSource('aa:bb:cc:dd:ee:04', '192.168.50.10', map);
    expect(r.label).toBeNull();
    expect(r.source).toBeNull();
  });

  it('returns Unknown when MAC is null (wired device with no FortiGate MAC)', () => {
    const map = new Map<string, RuckusObservation>([
      ['aa:bb:cc:dd:ee:05', obs('34')],
    ]);
    const r = resolveWifiSource(null, '8.8.8.8', map);
    expect(r.label).toBeNull();
    expect(r.source).toBeNull();
    expect(r.ruckus).toBeNull();
  });

  it('caller is responsible for MAC normalization (map miss on raw hyphen MAC)', () => {
    // The helper deliberately does NOT re-normalize for performance.
    // This test pins that contract so a future refactor doesn't quietly
    // double-normalize or, worse, stop expecting normalized keys.
    const map = new Map<string, RuckusObservation>([
      ['aa:bb:cc:dd:ee:06', obs('34_Guest')],
    ]);
    const miss = resolveWifiSource('AA-BB-CC-DD-EE-06', '8.8.8.8', map);
    expect(miss.source).toBeNull();
    const hit = resolveWifiSource('aa:bb:cc:dd:ee:06', '8.8.8.8', map);
    expect(hit.label).toBe('34_Guest');
    expect(hit.source).toBe('ruckus');
  });
});
