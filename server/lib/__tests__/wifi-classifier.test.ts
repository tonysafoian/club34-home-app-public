import { describe, it, expect } from 'vitest';
import { expectedSsidFor, adviseWrongNetwork } from '../wifi-classifier.js';

describe('expectedSsidFor', () => {
  it('routes AV devices to 34_AV', () => {
    expect(expectedSsidFor({ hostname: 'Living Room TV' }).expected).toBe('34_AV');
    expect(expectedSsidFor({ hostname: 'AppleTV-Bedroom' }).expected).toBe('34_AV');
    expect(expectedSsidFor({ hostname: 'HomePod-Kitchen' }).expected).toBe('34_AV');
    expect(expectedSsidFor({ hostname: 'verkada-cam-01' }).expected).toBe('34_AV');
    expect(expectedSsidFor({ hostname: 'doorbell' }).expected).toBe('34_AV');
    expect(expectedSsidFor({ hostname: 'Sonos-Beam' }).expected).toBe('34_AV');
    expect(expectedSsidFor({ hostname: 'roku-stick' }).expected).toBe('34_AV');
    expect(expectedSsidFor({ hostname: 'Crestron-Bridge' }).expected).toBe('34_AV');
  });

  it('routes trusted personal devices to 34', () => {
    expect(expectedSsidFor({ hostname: 'Brian-iPhone' }).expected).toBe('34');
    expect(expectedSsidFor({ hostname: 'tonys-MacBook-Pro' }).expected).toBe('34');
    expect(expectedSsidFor({ hostname: 'kids-iPad' }).expected).toBe('34');
    expect(expectedSsidFor({ device_type: 'laptop' }).expected).toBe('34');
  });

  it('has no opinion on truly unknown devices', () => {
    expect(expectedSsidFor({ hostname: 'abc1234' }).expected).toBeNull();
    expect(expectedSsidFor({}).expected).toBeNull();
  });

  it('prefers AV over personal when both keywords are present (TV wins over potential MAC match)', () => {
    // Apple TV mentions both "apple" and "tv"; rule order in the
    // classifier puts AV first so this should resolve to 34_AV.
    expect(expectedSsidFor({ hostname: 'Apple-TV-Garage' }).expected).toBe('34_AV');
  });
});

describe('adviseWrongNetwork', () => {
  it('reports "ok" when observed matches expected', () => {
    const r = adviseWrongNetwork({ hostname: 'Brian-iPhone' }, '34');
    expect(r.status).toBe('ok');
    expect(r.expected).toBe('34');
  });

  it('reports "wrong" when an AV device is on 34 instead of 34_AV', () => {
    const r = adviseWrongNetwork({ hostname: 'Living Room TV' }, '34');
    expect(r.status).toBe('wrong');
    expect(r.expected).toBe('34_AV');
  });

  it('flags unknown devices on trusted 34 as needs-label', () => {
    const r = adviseWrongNetwork({ hostname: 'random' }, '34');
    expect(r.status).toBe('needs-label');
  });

  it('returns unclassified when no rule fires and not on 34', () => {
    const r = adviseWrongNetwork({ hostname: 'random' }, '34_Guest');
    expect(r.status).toBe('unclassified');
  });
});
