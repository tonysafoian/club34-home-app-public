/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Response } from 'express';

let currentRole = 'admin';

vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => {
    req.userRole = currentRole;
    req.userId = 'system';
    next();
  },
}));

const mockQuery = vi.fn();
vi.mock('../../lib/db.js', () => ({
  query: (...args: any[]) => mockQuery(...args),
}));

const mockSendMonitorAlert = vi.fn();
vi.mock('../../utils/notifications.js', () => ({
  sendMonitorAlert: (...args: any[]) => mockSendMonitorAlert(...args),
}));

const mockFetchT = vi.fn();
vi.mock('../../lib/fetchWithTimeout.js', () => ({
  fetchT: (...args: any[]) => mockFetchT(...args),
}));

vi.mock('../../lib/auditLog.js', () => ({
  logAudit: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../utils/janus-tools.js', () => ({
  getAlertPhoneNumber: vi.fn().mockResolvedValue('15550199'),
}));

const routerMod = await import('../pool.js');
const router = routerMod.default;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function call(app: express.Express, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = { method: 'POST', url: path, headers: { 'x-cron-secret': 'secret' }, body: {} };
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
  vi.clearAllMocks();
  process.env.HA_URL = 'http://ha.local';
  process.env.HA_TOKEN = 'token';
});

describe('POST /spa-mode-monitor', () => {
  it('skips if automation is inactive', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'auto-123', is_active: false }]
    });

    const app = makeApp();
    const res = await call(app, '/spa-mode-monitor');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skipped: true, reason: 'Automation is disabled' });
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('does not alert if spa pump is off', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'auto-123', is_active: true }]
    });

    mockFetchT.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'off',
        last_changed: new Date().toISOString(),
      }),
    });

    const app = makeApp();
    const res = await call(app, '/spa-mode-monitor');
    expect(res.status).toBe(200);
    expect(res.body.spaPumpState).toBe('off');
    expect(res.body.alertTriggered).toBe(false);
    expect(mockSendMonitorAlert).not.toHaveBeenCalled();
  });

  it('does not alert if spa pump is on for less than 12 hours', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'auto-123', is_active: true }]
    });

    const fiveHoursAgo = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
    mockFetchT.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'on',
        last_changed: fiveHoursAgo,
      }),
    });

    const app = makeApp();
    const res = await call(app, '/spa-mode-monitor');
    expect(res.status).toBe(200);
    expect(res.body.spaPumpState).toBe('on');
    expect(res.body.alertTriggered).toBe(false);
    expect(mockSendMonitorAlert).not.toHaveBeenCalled();
  });

  it('sends alert and logs execution if spa pump is on for more than 12 hours', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'auto-123', is_active: true }]
    });

    const fourteenHoursAgo = new Date(Date.now() - 14 * 3600 * 1000).toISOString();
    mockFetchT.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'on',
        last_changed: fourteenHoursAgo,
      }),
    });

    mockSendMonitorAlert.mockResolvedValueOnce({
      sent: true,
      cooldownActive: false,
    });

    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // insert log
    mockQuery.mockResolvedValueOnce({ rowCount: 1 }); // update last run

    const app = makeApp();
    const res = await call(app, '/spa-mode-monitor');
    expect(res.status).toBe(200);
    expect(res.body.spaPumpState).toBe('on');
    expect(res.body.alertTriggered).toBe(true);
    expect(res.body.alertSent).toBe(true);
    expect(mockSendMonitorAlert).toHaveBeenCalled();
  });
});
