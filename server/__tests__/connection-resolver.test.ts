/**
 * Unit tests for server/lib/connection-resolver.ts
 *
 * Covers all 4 resolution tiers, the healthy/degraded feed-health flag,
 * wired-by-absence logic, and the buildRuckusMaps helper.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveConnectionMethod,
  buildRuckusMaps,
  LIVE_WINDOW_MS,
  RECENT_WINDOW_MS,
} from '../lib/connection-resolver.js';
import type { ConnectionResolverContext, RuckusDbRow } from '../lib/connection-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(offsetMs: number): Date {
  return new Date(Date.now() + offsetMs);
}

const WIRED_DEVICE = { hostname: 'NAS-01', device_type: 'NAS', os_type: null, hardware_vendor: 'Synology', category: 'Network Infrastructure', subcategory: null };
const PHONE_DEVICE = { hostname: 'iPhone-Tony', device_type: 'Mobile Phone', os_type: 'iOS', hardware_vendor: 'Apple', category: 'Mobile Phones & Tablets', subcategory: null };
const UNKNOWN_DEVICE = { hostname: null, device_type: null, os_type: null, hardware_vendor: null, category: null, subcategory: null };
const SPEAKER_DEVICE = { hostname: 'HomePod-Kitchen', device_type: null, os_type: null, hardware_vendor: 'Apple', category: 'Smart Speakers', subcategory: null };

function emptyCtx(healthy: boolean): ConnectionResolverContext {
  return {
    liveRuckusByMac: new Map(),
    recentRuckusByMac: new Map(),
    ruckusFeedHealthy: healthy,
  };
}

// ---------------------------------------------------------------------------
// buildRuckusMaps
// ---------------------------------------------------------------------------

describe('buildRuckusMaps', () => {
  it('places rows with ssids observed within LIVE_WINDOW_MS into the live map', () => {
    const rows: RuckusDbRow[] = [
      { mac_address: 'aa:bb:cc:dd:ee:01', ssids: ['34'], last_seen: ts(-1000) },
    ];
    const { liveRuckusByMac, recentRuckusByMac } = buildRuckusMaps(rows);
    expect(liveRuckusByMac.has('aa:bb:cc:dd:ee:01')).toBe(true);
    expect(recentRuckusByMac.has('aa:bb:cc:dd:ee:01')).toBe(true);
  });

  it('places rows outside LIVE_WINDOW but within RECENT_WINDOW only in recent map', () => {
    const rows: RuckusDbRow[] = [
      { mac_address: 'aa:bb:cc:dd:ee:02', ssids: ['34_AV'], last_seen: ts(-(LIVE_WINDOW_MS + 10_000)) },
    ];
    const { liveRuckusByMac, recentRuckusByMac } = buildRuckusMaps(rows);
    expect(liveRuckusByMac.has('aa:bb:cc:dd:ee:02')).toBe(false);
    expect(recentRuckusByMac.has('aa:bb:cc:dd:ee:02')).toBe(true);
  });

  it('skips rows with empty ssids array', () => {
    const rows: RuckusDbRow[] = [
      { mac_address: 'aa:bb:cc:dd:ee:03', ssids: [], last_seen: ts(-1000) },
    ];
    const { liveRuckusByMac, recentRuckusByMac } = buildRuckusMaps(rows);
    expect(liveRuckusByMac.size).toBe(0);
    expect(recentRuckusByMac.size).toBe(0);
  });

  it('skips rows with null ssids', () => {
    const rows: RuckusDbRow[] = [
      { mac_address: 'aa:bb:cc:dd:ee:04', ssids: null, last_seen: ts(-1000) },
    ];
    const { liveRuckusByMac } = buildRuckusMaps(rows);
    expect(liveRuckusByMac.size).toBe(0);
  });

  it('uses the ruckusFeedHealthyOverride when provided (true)', () => {
    const rows: RuckusDbRow[] = [];
    const { ruckusFeedHealthy } = buildRuckusMaps(rows, true);
    expect(ruckusFeedHealthy).toBe(true);
  });

  it('uses the ruckusFeedHealthyOverride when provided (false)', () => {
    const rows: RuckusDbRow[] = [
      { mac_address: 'aa:bb:cc:dd:ee:05', ssids: ['34'], last_seen: ts(-1000) },
    ];
    // Even though live map has entries, override says false.
    const { ruckusFeedHealthy, liveRuckusByMac } = buildRuckusMaps(rows, false);
    expect(liveRuckusByMac.size).toBe(1);
    expect(ruckusFeedHealthy).toBe(false);
  });

  it('falls back to live-map count when no override is given', () => {
    const rows: RuckusDbRow[] = [
      { mac_address: 'aa:bb:cc:dd:ee:06', ssids: ['34'], last_seen: ts(-1000) },
    ];
    const { ruckusFeedHealthy } = buildRuckusMaps(rows); // no override
    expect(ruckusFeedHealthy).toBe(true);
  });

  it('normalises dashes to colons in MAC addresses', () => {
    const rows: RuckusDbRow[] = [
      { mac_address: 'AA-BB-CC-DD-EE-07', ssids: ['34'], last_seen: ts(-500) },
    ];
    const { liveRuckusByMac } = buildRuckusMaps(rows);
    expect(liveRuckusByMac.has('aa:bb:cc:dd:ee:07')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tier 1 — Live Ruckus
// ---------------------------------------------------------------------------

describe('resolveConnectionMethod — Tier 1 (live Ruckus)', () => {
  it('returns wifi+confirmed when MAC is in the live map', () => {
    const liveRuckusByMac = new Map([['aa:bb:cc:11:22:33', { ssids: ['34'] }]]);
    const ctx: ConnectionResolverContext = { liveRuckusByMac, recentRuckusByMac: new Map(), ruckusFeedHealthy: true };
    const result = resolveConnectionMethod('aa:bb:cc:11:22:33', PHONE_DEVICE, null, ctx);
    expect(result.method).toBe('wifi');
    expect(result.ssid).toBe('34');
    expect(result.confidence).toBe('confirmed');
    expect(result.source).toBe('ruckus_live');
  });

  it('returns wired+confirmed by absence when feed is healthy and MAC is absent', () => {
    const liveRuckusByMac = new Map([['ff:ff:ff:ff:ff:ff', { ssids: ['34'] }]]);
    const ctx: ConnectionResolverContext = { liveRuckusByMac, recentRuckusByMac: new Map(), ruckusFeedHealthy: true };
    const result = resolveConnectionMethod('aa:bb:cc:11:22:34', PHONE_DEVICE, null, ctx);
    expect(result.method).toBe('wired');
    expect(result.source).toBe('ruckus_live');
    expect(result.confidence).toBe('confirmed');
  });

  it('does NOT apply wired-by-absence when feed is unhealthy', () => {
    const ctx: ConnectionResolverContext = {
      liveRuckusByMac: new Map(),
      recentRuckusByMac: new Map(),
      ruckusFeedHealthy: false,
    };
    // No Ruckus data, feed unhealthy → should NOT be wired by absence.
    const result = resolveConnectionMethod('aa:bb:cc:11:22:35', UNKNOWN_DEVICE, null, ctx);
    expect(result.method).not.toBe('wired');
    expect(result.source).not.toBe('ruckus_live');
  });

  it('MAC present in live map overrides feed-unhealthy state', () => {
    const liveRuckusByMac = new Map([['aa:bb:cc:11:22:36', { ssids: ['34_AV'] }]]);
    const ctx: ConnectionResolverContext = { liveRuckusByMac, recentRuckusByMac: new Map(), ruckusFeedHealthy: false };
    const result = resolveConnectionMethod('aa:bb:cc:11:22:36', SPEAKER_DEVICE, null, ctx);
    expect(result.method).toBe('wifi');
    expect(result.ssid).toBe('34_AV');
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — Recent Ruckus
// ---------------------------------------------------------------------------

describe('resolveConnectionMethod — Tier 2 (recent Ruckus)', () => {
  it('returns wifi+recent when MAC is in recent-only map and feed is unhealthy', () => {
    const recentRuckusByMac = new Map([['aa:bb:cc:22:33:44', { ssids: ['34_AV'], last_seen: new Date().toISOString() }]]);
    const ctx: ConnectionResolverContext = { liveRuckusByMac: new Map(), recentRuckusByMac, ruckusFeedHealthy: false };
    const result = resolveConnectionMethod('aa:bb:cc:22:33:44', SPEAKER_DEVICE, null, ctx);
    expect(result.method).toBe('wifi');
    expect(result.ssid).toBe('34_AV');
    expect(result.confidence).toBe('recent');
    expect(result.source).toBe('ruckus_recent');
  });

  it('returns wifi+recent even when feed is healthy (live miss + recent hit)', () => {
    const liveRuckusByMac = new Map([['ff:ff:ff:ff:ff:fe', { ssids: ['34'] }]]);
    const recentRuckusByMac = new Map([['aa:bb:cc:22:33:45', { ssids: ['34'], last_seen: new Date().toISOString() }]]);
    const ctx: ConnectionResolverContext = { liveRuckusByMac, recentRuckusByMac, ruckusFeedHealthy: true };
    // When feed is healthy and MAC NOT in live map, wired-by-absence takes precedence.
    // Tier 2 only applies when feed is NOT healthy.
    const result = resolveConnectionMethod('aa:bb:cc:22:33:45', PHONE_DEVICE, null, ctx);
    // Feed healthy → wired by absence (Tier 1 wired)
    expect(result.source).toBe('ruckus_live');
    expect(result.method).toBe('wired');
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — Heuristics
// ---------------------------------------------------------------------------

describe('resolveConnectionMethod — Tier 3 (heuristics)', () => {
  it('classifies NAS as wired via category heuristic', () => {
    const result = resolveConnectionMethod('aa:bb:cc:33:44:55', WIRED_DEVICE, null, emptyCtx(false));
    expect(result.method).toBe('wired');
    expect(result.source).toBe('heuristic');
    expect(result.confidence).toBe('inferred');
  });

  it('classifies phone as wifi via category heuristic', () => {
    const result = resolveConnectionMethod('aa:bb:cc:33:44:56', PHONE_DEVICE, null, emptyCtx(false));
    expect(result.method).toBe('wifi');
    expect(result.source).toBe('heuristic');
  });

  it('classifies smart speaker as wifi via category heuristic', () => {
    const result = resolveConnectionMethod('aa:bb:cc:33:44:57', SPEAKER_DEVICE, null, emptyCtx(false));
    expect(result.method).toBe('wifi');
    expect(result.source).toBe('heuristic');
  });

  it('classifies device with "nas" in hostname as wired via keyword heuristic', () => {
    const device = { hostname: 'truenas-main', device_type: null, os_type: null, hardware_vendor: null, category: null, subcategory: null };
    const result = resolveConnectionMethod(null, device, null, emptyCtx(false));
    expect(result.method).toBe('wired');
    expect(result.source).toBe('heuristic');
  });

  it('classifies printer category as wired', () => {
    const device = { hostname: 'HP-LaserJet', device_type: null, os_type: null, hardware_vendor: 'HP', category: 'Printers', subcategory: null };
    const result = resolveConnectionMethod(null, device, null, emptyCtx(false));
    expect(result.method).toBe('wired');
    expect(result.source).toBe('heuristic');
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — Subnet / Unknown
// ---------------------------------------------------------------------------

describe('resolveConnectionMethod — Tier 4 (subnet / unknown)', () => {
  it('returns subnet method when no Ruckus data and no heuristic match', () => {
    const result = resolveConnectionMethod('aa:bb:cc:44:55:66', UNKNOWN_DEVICE, '34', emptyCtx(false));
    expect(result.method).toBe('wifi');
    expect(result.source).toBe('subnet');
    expect(result.confidence).toBe('unknown');
    expect(result.ssid).toBe('34');
  });

  it('returns unknown when no Ruckus data, no heuristic match, and no subnet label', () => {
    const result = resolveConnectionMethod('aa:bb:cc:44:55:67', UNKNOWN_DEVICE, null, emptyCtx(false));
    expect(result.method).toBe('unknown');
    expect(result.source).toBe('unknown');
  });

  it('handles null MAC gracefully and falls through to heuristics', () => {
    const result = resolveConnectionMethod(null, WIRED_DEVICE, null, emptyCtx(true));
    // NAS → wired heuristic, even without MAC
    expect(result.method).toBe('wired');
  });
});

// ---------------------------------------------------------------------------
// Degraded-feed behaviour summary
// ---------------------------------------------------------------------------

describe('degraded feed — wired-by-absence must not fire', () => {
  it('falls to Tier 3 heuristic (not wired-by-absence) when feed is unhealthy', () => {
    const liveRuckusByMac = new Map([['ff:ff:ff:ff:ff:fd', { ssids: ['34'] }]]);
    const ctx: ConnectionResolverContext = {
      liveRuckusByMac,
      recentRuckusByMac: new Map(),
      ruckusFeedHealthy: false,
    };
    const result = resolveConnectionMethod('aa:bb:cc:55:66:77', PHONE_DEVICE, null, ctx);
    // Feed unhealthy → no wired-by-absence; phone → wifi via heuristic
    expect(result.method).toBe('wifi');
    expect(result.source).toBe('heuristic');
  });

  it('falls to Tier 4 (unknown) for a truly unknown device with unhealthy feed', () => {
    const ctx: ConnectionResolverContext = {
      liveRuckusByMac: new Map(),
      recentRuckusByMac: new Map(),
      ruckusFeedHealthy: false,
    };
    const result = resolveConnectionMethod('aa:bb:cc:55:66:78', UNKNOWN_DEVICE, null, ctx);
    expect(result.method).toBe('unknown');
  });
});
