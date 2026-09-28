import { describe, it, expect } from 'vitest';
import {
  buildSnapshotRow,
  detectEvents,
  summarize,
  type SnapshotRowBody,
} from '../wirelessSnapshot.js';

const ap = (mac: string, name: string, status: 'joined' | 'disconnected' | 'unknown') => ({
  mac,
  name,
  status,
} as any);

const client = (mac: string, ssid: string, apMac: string) => ({
  mac,
  ssid,
  ap_mac: apMac,
} as any);

const ssid = (name: string) => ({ name } as any);

describe('buildSnapshotRow', () => {
  it('aggregates AP statuses, client totals, and per-SSID/per-AP counts', () => {
    const aps = [
      ap('aa', 'AP-Garage', 'joined'),
      ap('bb', 'AP-Office', 'joined'),
      ap('cc', 'AP-Theater', 'disconnected'),
      ap('dd', 'AP-Master', 'unknown'),
    ];
    const clients = [
      client('c1', '34', 'aa'),
      client('c2', '34', 'aa'),
      client('c3', '34_AV', 'bb'),
      client('c4', '34_Guest', 'bb'),
    ];
    const snap = buildSnapshotRow({
      aps,
      clients,
      ssids: [ssid('34'), ssid('34_AV'), ssid('34_Guest')],
      stale: false,
      sectionErrors: {},
    });
    expect(snap.ap_total).toBe(4);
    expect(snap.ap_online).toBe(2);
    expect(snap.ap_offline).toBe(1);
    expect(snap.ap_unknown).toBe(1);
    expect(snap.client_total).toBe(4);
    expect(snap.ssid_total).toBe(3);
    expect(snap.clients_by_ssid).toEqual({ '34': 2, '34_AV': 1, '34_Guest': 1 });
    expect(snap.aps_by_mac.aa.client_count).toBe(2);
    expect(snap.aps_by_mac.bb.client_count).toBe(2);
    expect(snap.aps_by_mac.cc.client_count).toBe(0);
  });

  it('propagates stale flag and section errors', () => {
    const snap = buildSnapshotRow({
      aps: [], clients: [], ssids: [],
      stale: true,
      sectionErrors: { aps: 'circuit open' },
    });
    expect(snap.stale).toBe(true);
    expect(snap.section_errors).toEqual({ aps: 'circuit open' });
  });
});

describe('detectEvents', () => {
  const baseline: SnapshotRowBody = {
    ap_total: 2, ap_online: 2, ap_offline: 0, ap_unknown: 0,
    client_total: 6, ssid_total: 2,
    clients_by_ssid: { '34': 4, '34_AV': 2 },
    aps_by_mac: {
      aa: { name: 'AP-Garage', status: 'joined', client_count: 4 },
      bb: { name: 'AP-Office', status: 'joined', client_count: 2 },
    },
    stale: false,
    section_errors: {},
  };

  it('emits no events for an unchanged snapshot', () => {
    expect(detectEvents(baseline, { ...baseline })).toEqual([]);
  });

  it('emits ap_disconnected with controller evidence on joined → disconnected', () => {
    const curr: SnapshotRowBody = {
      ...baseline,
      aps_by_mac: {
        ...baseline.aps_by_mac,
        bb: { name: 'AP-Office', status: 'disconnected', client_count: 0 },
      },
    };
    const events = detectEvents(baseline, curr);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('ap_disconnected');
    expect(events[0].evidence).toBe('controller');
    expect(events[0].severity).toBe('warn');
    expect(events[0].detail.mac).toBe('bb');
  });

  it('emits ap_unknown when controller stops reporting state', () => {
    const curr: SnapshotRowBody = {
      ...baseline,
      aps_by_mac: {
        ...baseline.aps_by_mac,
        bb: { name: 'AP-Office', status: 'unknown', client_count: 0 },
      },
    };
    const events = detectEvents(baseline, curr);
    expect(events[0].event_type).toBe('ap_unknown');
    expect(events[0].evidence).toBe('controller');
  });

  it('emits ap_joined on recovery from disconnected', () => {
    const prev: SnapshotRowBody = {
      ...baseline,
      aps_by_mac: {
        ...baseline.aps_by_mac,
        bb: { name: 'AP-Office', status: 'disconnected', client_count: 0 },
      },
    };
    const events = detectEvents(prev, baseline);
    expect(events[0].event_type).toBe('ap_joined');
    expect(events[0].severity).toBe('info');
  });

  it('emits ssid_clients_drop with client evidence on cliff drop', () => {
    const curr: SnapshotRowBody = {
      ...baseline,
      client_total: 3,
      clients_by_ssid: { '34': 1, '34_AV': 2 },
    };
    const events = detectEvents(baseline, curr);
    const drop = events.find((e) => e.event_type === 'ssid_clients_drop');
    expect(drop).toBeDefined();
    expect(drop!.evidence).toBe('client');
    expect(drop!.detail).toMatchObject({ ssid: '34', prev: 4, curr: 1 });
  });

  it('emits ssid_clients_drop with error severity on N → 0 (even though SSID is absent from curr)', () => {
    // buildSnapshotRow omits zero-client SSIDs from clients_by_ssid. The
    // diff must iterate the union of prev+curr keys to still see this.
    const curr: SnapshotRowBody = {
      ...baseline,
      client_total: 2,
      clients_by_ssid: { '34_AV': 2 }, // '34' disappeared entirely (was 4)
    };
    const events = detectEvents(baseline, curr);
    const drop = events.find((e) => e.event_type === 'ssid_clients_drop' && e.detail.ssid === '34');
    expect(drop).toBeDefined();
    expect(drop!.severity).toBe('error');
    expect(drop!.detail).toMatchObject({ ssid: '34', prev: 4, curr: 0 });
  });

  it('does NOT emit ssid_clients_drop for a 1-client roam under threshold', () => {
    const curr: SnapshotRowBody = {
      ...baseline,
      clients_by_ssid: { '34': 3, '34_AV': 2 }, // 4→3 = 75%, not <=50%
    };
    expect(detectEvents(baseline, curr)).toEqual([]);
  });

  it('emits telemetry_stale_lkg_served on rising edge of stale', () => {
    const curr: SnapshotRowBody = {
      ...baseline,
      stale: true,
      section_errors: { aps: 'timeout' },
    };
    const events = detectEvents(baseline, curr);
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('telemetry_stale_lkg_served');
    expect(events[0].evidence).toBe('telemetry');
  });

  it('does NOT re-emit telemetry_stale when previous was already stale', () => {
    const prev: SnapshotRowBody = { ...baseline, stale: true, section_errors: { aps: 'x' } };
    const curr: SnapshotRowBody = { ...baseline, stale: true, section_errors: { aps: 'x' } };
    expect(detectEvents(prev, curr)).toEqual([]);
  });

  it('emits ap_new for a previously unseen AP and ap_removed when it vanishes', () => {
    const withNew: SnapshotRowBody = {
      ...baseline,
      ap_total: 3,
      aps_by_mac: {
        ...baseline.aps_by_mac,
        cc: { name: 'AP-Theater', status: 'joined', client_count: 0 },
      },
    };
    const newEvents = detectEvents(baseline, withNew);
    expect(newEvents.find((e) => e.event_type === 'ap_new')).toBeDefined();

    const removedEvents = detectEvents(withNew, baseline);
    expect(removedEvents.find((e) => e.event_type === 'ap_removed')).toBeDefined();
  });

  it('on first-ever snapshot emits only telemetry_stale if currently stale', () => {
    const events = detectEvents(null, { ...baseline, stale: true, section_errors: { aps: 'x' } });
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe('telemetry_stale_lkg_served');
  });
});

describe('summarize', () => {
  it('produces a one-liner with counts and alert summary', () => {
    const snap: SnapshotRowBody = {
      ap_total: 5, ap_online: 4, ap_offline: 0, ap_unknown: 1,
      client_total: 23, ssid_total: 3,
      clients_by_ssid: {}, aps_by_mac: {}, stale: false, section_errors: {},
    };
    const s = summarize(snap, []);
    expect(s).toContain('4/5 APs online');
    expect(s).toContain('1 unknown');
    expect(s).toContain('23 clients');
    expect(s).toContain('No recent alerts');
  });

  it('mentions stale state when LKG is being served', () => {
    const snap: SnapshotRowBody = {
      ap_total: 5, ap_online: 5, ap_offline: 0, ap_unknown: 0,
      client_total: 10, ssid_total: 3,
      clients_by_ssid: {}, aps_by_mac: {}, stale: true,
      section_errors: { aps: 'timeout' },
    };
    expect(summarize(snap, [])).toContain('stale');
  });
});
