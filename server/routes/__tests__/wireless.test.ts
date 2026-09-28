/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Response } from 'express';

let currentRole: 'admin' | 'member' | 'guest' = 'admin';

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.userRole = currentRole;
    next();
  },
}));

// Pretend the controller is configured so the routes don't 503 early.
const ruckusMock = {
  getSystemInfo: vi.fn(),
  getAccessPoints: vi.fn(),
  getClients: vi.fn(),
  getSSIDs: vi.fn(),
};

vi.mock('../../lib/ruckus.js', async () => {
  // Pull the real CircuitOpenError class so the route's instanceof check
  // keeps working.
  const real = await vi.importActual<typeof import('../../lib/ruckus.js')>('../../lib/ruckus.js');
  return {
    ...real,
    isRuckusConfigured: () => true,
    getRuckusBaseUrl: () => 'https://ruckus.test.local',
    getSystemInfo: (...a: any[]) => ruckusMock.getSystemInfo(...a),
    getAccessPoints: (...a: any[]) => ruckusMock.getAccessPoints(...a),
    getClients: (...a: any[]) => ruckusMock.getClients(...a),
    getSSIDs: (...a: any[]) => ruckusMock.getSSIDs(...a),
  };
});

const routerMod = await import('../wireless.js');
const router = routerMod.default;
const { __resetWirelessCacheForTests } = routerMod;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

interface MockResp { status: number; body: any }

function call(app: express.Express, path: string): Promise<MockResp> {
  return new Promise((resolve) => {
    const req: any = { method: 'GET', url: path, headers: {}, params: {}, query: {} };
    const res: any = {
      _status: 200,
      _body: undefined,
      status(code: number) { this._status = code; return this; },
      json(b: any) { this._body = b; resolve({ status: this._status, body: b }); return this; },
      setHeader() { return this; },
      getHeader() { return undefined; },
    };
    (app as any).handle(req, res);
  });
}

beforeEach(() => {
  currentRole = 'admin';
  __resetWirelessCacheForTests();
  vi.clearAllMocks();
});

describe('GET /api/wireless/status — contract', () => {
  it('returns online/numClients aliases for each AP', async () => {
    ruckusMock.getSystemInfo.mockResolvedValue({ raw: {}, model: 'R750', version: '200.x' });
    ruckusMock.getAccessPoints.mockResolvedValue([
      { mac: 'AA:01', name: 'Front', status: 'joined', raw: {} },
      { mac: 'AA:02', name: 'Kitchen', status: 'disconnected', raw: {} },
      { mac: 'AA:03', name: 'Mystery', status: 'unknown', raw: {} },
    ]);
    ruckusMock.getClients.mockResolvedValue([
      { mac: 'C1', ap_mac: 'AA:01', ssid: '34_AV', signal_health: 'good', raw: {} },
      { mac: 'C2', ap_mac: 'AA:01', ssid: '34', signal_health: 'good', raw: {} },
    ]);
    ruckusMock.getSSIDs.mockResolvedValue([{ name: '34_AV' }, { name: '34' }]);

    const app = makeApp();
    const res = await call(app, '/api/wireless/status');
    expect(res.status).toBe(200);
    expect(res.body.aps).toHaveLength(3);

    const front = res.body.aps.find((a: any) => a.mac === 'AA:01');
    expect(front.status).toBe('joined');
    expect(front.online).toBe(true);
    expect(front.numClients).toBe(2);
    expect(front.client_count).toBe(2);

    const kitchen = res.body.aps.find((a: any) => a.mac === 'AA:02');
    expect(kitchen.online).toBe(false);

    // "unknown" must NOT be reported as hard-online; the UI renders an
    // amber warning state instead.
    const mystery = res.body.aps.find((a: any) => a.mac === 'AA:03');
    expect(mystery.online).toBe(false);
    expect(mystery.status).toBe('unknown');

    expect(res.body.stale).toBe(false);
    expect(res.body.source).toBe('ruckus');
    expect(typeof res.body.generated_at).toBe('string');
    expect(res.body.section_errors).toEqual({});
  });

  it('serves last-known-good APs when getAccessPoints transiently fails', async () => {
    ruckusMock.getSystemInfo.mockResolvedValue({ raw: {} });
    ruckusMock.getAccessPoints.mockResolvedValueOnce([
      { mac: 'AA:01', name: 'Front', status: 'joined', raw: {} },
    ]);
    ruckusMock.getClients.mockResolvedValue([]);
    ruckusMock.getSSIDs.mockResolvedValue([]);

    const app = makeApp();
    const first = await call(app, '/api/wireless/status');
    expect(first.body.aps).toHaveLength(1);
    expect(first.body.stale).toBe(false);

    // Now break getAccessPoints once. We should still see the same AP,
    // marked stale, with the section error surfaced — NOT an empty list.
    ruckusMock.getAccessPoints.mockRejectedValueOnce(new Error('boom: tunnel hiccup'));
    const second = await call(app, '/api/wireless/status');
    expect(second.body.aps).toHaveLength(1);
    expect(second.body.aps[0].mac).toBe('AA:01');
    expect(second.body.stale).toBe(true);
    expect(second.body.section_errors.aps).toMatch(/tunnel hiccup/);
    expect(second.body.last_success_at).toBeTruthy();
  });

  it('returns empty arrays (not crash) when section fails on the very first poll', async () => {
    ruckusMock.getSystemInfo.mockResolvedValue({ raw: {} });
    ruckusMock.getAccessPoints.mockRejectedValue(new Error('cold start failure'));
    ruckusMock.getClients.mockResolvedValue([]);
    ruckusMock.getSSIDs.mockResolvedValue([]);

    const app = makeApp();
    const res = await call(app, '/api/wireless/status');
    expect(res.status).toBe(200);
    expect(res.body.aps).toEqual([]);
    expect(res.body.section_errors.aps).toMatch(/cold start/);
    // stale is false because there's no prior snapshot to serve.
    expect(res.body.stale).toBe(false);
  });
});

describe('GET /api/wireless/grouped — contract', () => {
  it('groups clients under the AP they are associated with (by mac, then name)', async () => {
    ruckusMock.getAccessPoints.mockResolvedValue([
      { mac: 'AA:01', name: 'Front', model: 'R750', status: 'joined', raw: {} },
      { mac: 'AA:02', name: 'Kitchen', status: 'joined', raw: {} },
      { mac: 'AA:03', name: 'Garage', status: 'disconnected', raw: {} },
    ]);
    ruckusMock.getClients.mockResolvedValue([
      { mac: 'C1', ap_mac: 'AA:01', ssid: '34_AV', signal: -55, signal_health: 'good', hostname: 'laptop', ip: '10.0.22.10', raw: { radio: 'na' } },
      { mac: 'C2', ap_mac: 'AA:01', ssid: '34', signal: -70, signal_health: 'fair', raw: { channel: 6 } },
      // matched by ap_name when ap_mac is absent
      { mac: 'C3', ap_name: 'Kitchen', ssid: '34', signal_health: 'unknown', raw: {} },
    ]);

    const app = makeApp();
    const res = await call(app, '/api/wireless/grouped');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(true);
    expect(res.body.client_count).toBe(3);
    expect(res.body.ap_count).toBe(3);

    // Front (AA:01) carries 2 clients, sorted to the top by count.
    const front = res.body.accessPoints.find((a: any) => a.apMac === 'AA:01');
    expect(front.clientCount).toBe(2);
    expect(front.online).toBe(true);
    expect(front.model).toBe('R750');
    expect(front.clients.map((c: any) => c.mac).sort()).toEqual(['C1', 'C2']);
    // band derived from raw radio / channel
    expect(front.clients.find((c: any) => c.mac === 'C1').band).toBe('5GHz');
    expect(front.clients.find((c: any) => c.mac === 'C2').band).toBe('2.4GHz');

    const kitchen = res.body.accessPoints.find((a: any) => a.apMac === 'AA:02');
    expect(kitchen.clientCount).toBe(1);
    expect(kitchen.clients[0].mac).toBe('C3');

    const garage = res.body.accessPoints.find((a: any) => a.apMac === 'AA:03');
    expect(garage.clientCount).toBe(0);
    expect(garage.online).toBe(false);

    expect(res.body.unassigned).toEqual([]);
  });

  it('derives band from widened raw radio/channel aliases and passes signal/ip/signalHealth through', async () => {
    ruckusMock.getAccessPoints.mockResolvedValue([
      { mac: 'AA:01', name: 'Front', status: 'joined', raw: {} },
    ]);
    ruckusMock.getClients.mockResolvedValue([
      // band from rx-radio-mode alias → 5GHz; signal/ip/health pass through
      { mac: 'C1', ap_mac: 'AA:01', ssid: '34', signal: -58, signal_health: 'good', ip: '10.0.22.30', raw: { 'rx-radio-mode': 'ax' } },
      // band from radio-channel alias → 2.4GHz
      { mac: 'C2', ap_mac: 'AA:01', ssid: '34', signal: -72, signal_health: 'fair', raw: { 'radio-channel': 11 } },
      // band from phy-mode alias → 2.4GHz
      { mac: 'C3', ap_mac: 'AA:01', ssid: '34', signal_health: 'unknown', raw: { 'phy-mode': 'ng' } },
      // real prod feed: explicit radio-band "2.4g" wins (even alongside a channel) → 2.4GHz
      { mac: 'C4', ap_mac: 'AA:01', ssid: '34', signal_health: 'good', raw: { 'radio-band': '2.4g', channel: 1, 'radio-type': '11ng' } },
      // real prod feed: radio-band "5G" (case-insensitive) → 5GHz
      { mac: 'C5', ap_mac: 'AA:01', ssid: '34', signal_health: 'good', raw: { 'radio-band': '5G' } },
      // channel-only fallback in the 5GHz range (36-165) → 5GHz
      { mac: 'C6', ap_mac: 'AA:01', ssid: '34', signal_health: 'good', raw: { channel: 149 } },
      // first-class parsed band wins even with NO raw radio attrs (the prod
      // case: getClients() set c.band, raw carries no band hint).
      { mac: 'C7', ap_mac: 'AA:01', ssid: '34', signal_health: 'good', band: '5GHz', raw: {} },
    ]);

    const app = makeApp();
    const res = await call(app, '/api/wireless/grouped');
    const front = res.body.accessPoints.find((a: any) => a.apMac === 'AA:01');
    const c1 = front.clients.find((c: any) => c.mac === 'C1');
    expect(c1.band).toBe('5GHz');
    expect(c1.signal).toBe(-58);
    expect(c1.signalHealth).toBe('good');
    expect(c1.ip).toBe('10.0.22.30');
    expect(front.clients.find((c: any) => c.mac === 'C2').band).toBe('2.4GHz');
    expect(front.clients.find((c: any) => c.mac === 'C3').band).toBe('2.4GHz');
    expect(front.clients.find((c: any) => c.mac === 'C4').band).toBe('2.4GHz');
    expect(front.clients.find((c: any) => c.mac === 'C5').band).toBe('5GHz');
    expect(front.clients.find((c: any) => c.mac === 'C6').band).toBe('5GHz');
    // first-class c.band passes through with an empty raw object.
    expect(front.clients.find((c: any) => c.mac === 'C7').band).toBe('5GHz');
  });

  it('puts clients with no matching AP into the unassigned bucket', async () => {
    ruckusMock.getAccessPoints.mockResolvedValue([
      { mac: 'AA:01', name: 'Front', status: 'joined', raw: {} },
    ]);
    ruckusMock.getClients.mockResolvedValue([
      { mac: 'C1', ap_mac: 'AA:01', ssid: '34', signal_health: 'good', raw: {} },
      { mac: 'C9', ap_mac: 'ZZ:99', ssid: '34', signal_health: 'good', raw: {} },
    ]);

    const app = makeApp();
    const res = await call(app, '/api/wireless/grouped');
    expect(res.body.accessPoints.find((a: any) => a.apMac === 'AA:01').clientCount).toBe(1);
    expect(res.body.unassigned).toHaveLength(1);
    expect(res.body.unassigned[0].mac).toBe('C9');
  });

  it('also groups by SSID with a distinct-AP count per SSID', async () => {
    ruckusMock.getAccessPoints.mockResolvedValue([
      { mac: 'AA:01', name: 'Front', status: 'joined', raw: {} },
      { mac: 'AA:02', name: 'Kitchen', status: 'joined', raw: {} },
    ]);
    ruckusMock.getClients.mockResolvedValue([
      { mac: 'C1', ap_mac: 'AA:01', ssid: '34', signal_health: 'good', raw: {} },
      { mac: 'C2', ap_mac: 'AA:02', ssid: '34', signal_health: 'good', raw: {} },
      { mac: 'C3', ap_mac: 'AA:01', ssid: 'Guest', signal_health: 'good', raw: {} },
    ]);

    const app = makeApp();
    const res = await call(app, '/api/wireless/grouped');
    const club34 = res.body.ssids.find((s: any) => s.ssid === '34');
    expect(club34.clientCount).toBe(2);
    expect(club34.apCount).toBe(2);
    const guest = res.body.ssids.find((s: any) => s.ssid === 'Guest');
    expect(guest.clientCount).toBe(1);
    expect(guest.apCount).toBe(1);
  });

  it('degrades to empty groups + reachable:false (HTTP 200) when a pull fails', async () => {
    ruckusMock.getAccessPoints.mockRejectedValue(new Error('breaker open'));
    ruckusMock.getClients.mockResolvedValue([]);

    const app = makeApp();
    const res = await call(app, '/api/wireless/grouped');
    expect(res.status).toBe(200);
    expect(res.body.reachable).toBe(false);
    expect(res.body.errors.aps).toMatch(/breaker open/);
    expect(res.body.accessPoints).toEqual([]);
    expect(res.body.ssids).toEqual([]);
  });
});
