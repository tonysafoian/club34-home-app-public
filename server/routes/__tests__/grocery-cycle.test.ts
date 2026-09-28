/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';

// Auth shim — every test runs as Tony with admin role.
const TEST_USER = { userId: '7a85b652-b5d8-44c4-9409-384562448883', email: 'admin@example.com', displayName: 'Tony', roles: ['admin'] };

vi.mock('../../auth', () => ({
  requireAuth: (req: any, _res: Response, next: NextFunction) => { req.user = TEST_USER; next(); },
  requireRole: () => (req: any, _res: Response, next: NextFunction) => { req.user = TEST_USER; next(); },
}));

vi.mock('../../utils/notifications', () => ({
  sendMonitorAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../lib/auditLog.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// Storage mock with a programmable matcher queue.
type Matcher = (sql: string, params?: any[]) => { rows: any[]; rowCount?: number } | null;
const matchers: Matcher[] = [];
const queries: Array<{ sql: string; params?: any[] }> = [];

vi.mock('../../storage', () => ({
  storage: {
    query: vi.fn(async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      for (const m of matchers) {
        const r = m(sql, params);
        if (r) return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

vi.mock('../../db', () => ({
  pool: {
    connect: vi.fn(async () => {
      return {
        query: vi.fn(async (sql: string, params?: any[]) => {
          queries.push({ sql, params });
          for (const m of matchers) {
            const r = m(sql, params);
            if (r) return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
          }
          return { rows: [], rowCount: 0 };
        }),
        release: () => {},
      };
    }),
  },
  db: {},
}));

const groceryMod = await import('../grocery');
const router = groceryMod.default;
const { getCurrentCycleWindow, submitToAmazonGrocery } = groceryMod as any;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

async function request(app: express.Express, method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req: any = {
      method, url: path, originalUrl: path, path,
      headers: {}, params: extractParams(path), query: {},
      body: body ?? {},
      get(h: string) { return this.headers[h.toLowerCase()]; },
    };
    let statusCode = 200;
    let payload: any = null;
    const res: any = {
      status(code: number) { statusCode = code; return this; },
      json(b: any) { payload = b; resolve({ status: statusCode, body: payload }); return this; },
      send(b: any) { payload = b; resolve({ status: statusCode, body: payload }); return this; },
    };
    try { (router as any).handle(req, res, (err: any) => err ? reject(err) : resolve({ status: 404, body: null })); }
    catch (e) { reject(e); }
  });
}

// Build req.params from a known URL pattern — only used by tests, so be permissive.
function extractParams(_url: string): Record<string, string> { return {}; }

beforeEach(() => {
  matchers.length = 0;
  queries.length = 0;
});

// ============================================================
// Cycle window — DST-safe
// ============================================================

describe('getCurrentCycleWindow (DST-safe)', () => {
  function ptParts(d: Date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {} as Record<string, string>);
    if (parts.hour === '24') parts.hour = '00'; // Intl midnight quirk in some Node builds
    return parts;
  }

  it('returns the correct Saturday-00:00-PT start during PT winter (PST, UTC-8)', () => {
    // Wed Feb 4 2026 12:00 PT — most recent Sat = Jan 31 2026
    const now = new Date('2026-02-04T20:00:00Z'); // = 12:00 PST
    const w = getCurrentCycleWindow(now);
    const s = ptParts(w.cycleStartAt);
    expect(s.weekday).toBe('Sat');
    expect(s.hour + ':' + s.minute).toBe('00:00');
    expect(`${s.year}-${s.month}-${s.day}`).toBe('2026-01-31');
    const l = ptParts(w.cycleLockAt);
    expect(l.weekday).toBe('Fri');
    expect(l.hour).toBe('16');
    expect(`${l.year}-${l.month}-${l.day}`).toBe('2026-02-06');
    expect(w.deliveryDate).toBe('2026-02-09'); // Mon after lock
  });

  it('returns the correct window across the Spring-forward DST boundary (Mar 8 2026, 02:00 → 03:00 PT)', () => {
    // Tue Mar 10 2026 12:00 PT — most recent Sat = Mar 7 (cycle spans DST flip on Mar 8)
    const now = new Date('2026-03-10T19:00:00Z'); // = 12:00 PDT (UTC-7)
    const w = getCurrentCycleWindow(now);
    const s = ptParts(w.cycleStartAt);
    expect(s.weekday).toBe('Sat');
    expect(s.hour + ':' + s.minute).toBe('00:00');
    expect(`${s.year}-${s.month}-${s.day}`).toBe('2026-03-07');
    const l = ptParts(w.cycleLockAt);
    expect(l.weekday).toBe('Fri');
    expect(l.hour).toBe('16');
    expect(`${l.year}-${l.month}-${l.day}`).toBe('2026-03-13');
    expect(w.deliveryDate).toBe('2026-03-16');
  });

  it('returns the correct window across the Fall-back DST boundary (Nov 1 2026, 02:00 → 01:00 PT)', () => {
    // Tue Nov 3 2026 12:00 PT — most recent Sat = Oct 31 (cycle spans DST flip on Nov 1)
    const now = new Date('2026-11-03T20:00:00Z'); // = 12:00 PST (UTC-8)
    const w = getCurrentCycleWindow(now);
    const s = ptParts(w.cycleStartAt);
    expect(s.weekday).toBe('Sat');
    expect(s.hour + ':' + s.minute).toBe('00:00');
    expect(`${s.year}-${s.month}-${s.day}`).toBe('2026-10-31');
    const l = ptParts(w.cycleLockAt);
    expect(l.weekday).toBe('Fri');
    expect(l.hour).toBe('16');
    expect(`${l.year}-${l.month}-${l.day}`).toBe('2026-11-06');
    expect(w.deliveryDate).toBe('2026-11-09');
  });
});

// ============================================================
// openCycleIfMissing — idempotent
// ============================================================

describe('openCycleIfMissing (via GET /api/grocery-order/current)', () => {
  it('is idempotent — second call returns the existing run instead of inserting a new one', async () => {
    const app = buildApp();
    const existingRunId = '11111111-1111-1111-1111-111111111111';
    let selectCalls = 0;

    matchers.push((sql) => {
      if (sql.includes('FROM grocery_order_runs') && sql.includes("status <> 'cancelled'")) {
        selectCalls++;
        // First call: no existing run. Second call: row already there.
        return selectCalls === 1 ? { rows: [] } : { rows: [{ id: existingRunId }] };
      }
      if (sql.startsWith('INSERT INTO grocery_order_runs')) {
        return { rows: [{ id: existingRunId }] };
      }
      if (sql.includes('FROM grocery_order_runs WHERE id =')) {
        return { rows: [{ id: existingRunId, status: 'open' }] };
      }
      if (sql.includes('FROM grocery_order_items WHERE run_id')) return { rows: [] };
      if (sql.includes('FROM grocery_order_item_audit')) return { rows: [] };
      return null;
    });

    const r1 = await request(app, 'GET', '/api/grocery-order/current');
    expect(r1.status).toBe(200);
    expect(r1.body.isNew).toBe(true);
    expect(r1.body.run.id).toBe(existingRunId);

    const r2 = await request(app, 'GET', '/api/grocery-order/current');
    expect(r2.status).toBe(200);
    expect(r2.body.isNew).toBe(false);
    expect(r2.body.run.id).toBe(existingRunId);

    // Only one INSERT across the two calls.
    const inserts = queries.filter(q => q.sql.startsWith('INSERT INTO grocery_order_runs'));
    expect(inserts.length).toBe(1);
  });
});

// ============================================================
// Items mutations + audit
// ============================================================

describe('POST /api/grocery-order/items', () => {
  it('inserts a new item row AND writes a grocery_order_item_audit row', async () => {
    const app = buildApp();
    const runId = '22222222-2222-2222-2222-222222222222';
    const stapleId = '33333333-3333-3333-3333-333333333333';
    const newItemId = '44444444-4444-4444-4444-444444444444';

    matchers.push((sql) => {
      if (sql.includes('FROM grocery_order_runs') && sql.includes("status <> 'cancelled'")) return { rows: [{ id: runId }] };
      if (sql.includes('FROM grocery_order_runs WHERE id =')) return { rows: [{ id: runId, status: 'open' }] };
      if (sql.includes('FROM grocery_staples WHERE id =')) {
        return { rows: [{
          id: stapleId, name: 'Avocado', brand: 'Fresh', size_label: '1 Each',
          category: 'produce', platform: 'amazon-fresh', amazon_asin: 'B000P72UZG',
          amazon_url: 'https://amazon.com/x', image_url: 'https://m.media-amazon.com/x.jpg',
          last_known_price_cents: 165,
        }] };
      }
      if (sql.includes('FROM grocery_order_items WHERE run_id') && sql.includes('AND staple_id = $2')) return { rows: [] };
      if (sql.includes('INSERT INTO grocery_order_items')) {
        return { rows: [{ id: newItemId, run_id: runId, staple_id: stapleId, name: 'Avocado', quantity: 2, inserted: true }] };
      }
      return null;
    });

    const r = await request(app, 'POST', '/api/grocery-order/items', { stapleId, quantity: 2 });
    expect(r.status).toBe(200);
    expect(r.body.item.id).toBe(newItemId);

    const auditInserts = queries.filter(q => q.sql.startsWith('INSERT INTO grocery_order_item_audit'));
    expect(auditInserts.length).toBe(1);
    expect(auditInserts[0].params?.[2]).toBe('added'); // action
    expect(auditInserts[0].params?.[5]).toBe(2);       // qty_after
  });

  it('rejects with 409 when the cycle is locked', async () => {
    const app = buildApp();
    const runId = '55555555-5555-5555-5555-555555555555';
    matchers.push((sql) => {
      if (sql.includes('FROM grocery_order_runs') && sql.includes("status <> 'cancelled'")) return { rows: [{ id: runId }] };
      if (sql.includes('FROM grocery_order_runs WHERE id =')) return { rows: [{ id: runId, status: 'locked' }] };
      return null;
    });
    const r = await request(app, 'POST', '/api/grocery-order/items', { stapleId: 'x', quantity: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('locked');
  });
});

describe('PATCH /api/grocery-order/items/:itemId with quantity=0', () => {
  it('deletes the row and writes a "removed" audit', async () => {
    const app = buildApp();
    const runId = '66666666-6666-6666-6666-666666666666';
    const itemId = '77777777-7777-7777-7777-777777777777';

    matchers.push((sql) => {
      if (sql.includes('FROM grocery_order_items i') && sql.includes('JOIN grocery_order_runs r')) {
        return { rows: [{
          id: itemId, run_id: runId, staple_id: null, amazon_asin: 'B0XYZ',
          name: 'Test item', quantity: 3, run_status: 'open',
        }] };
      }
      if (sql.startsWith('DELETE FROM grocery_order_items')) return { rows: [] };
      return null;
    });

    // Route reads req.params.itemId; build a fake req with the right param.
    const app2 = express();
    app2.use(express.json());
    app2.use(router);
    const r = await new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = {
        method: 'PATCH', url: `/api/grocery-order/items/${itemId}`, originalUrl: `/api/grocery-order/items/${itemId}`,
        path: `/api/grocery-order/items/${itemId}`, headers: {}, params: { itemId }, query: {}, body: { quantity: 0 },
        get(h: string) { return this.headers[h.toLowerCase()]; },
      };
      let statusCode = 200; let payload: any = null;
      const res: any = {
        status(c: number) { statusCode = c; return this; },
        json(b: any) { payload = b; resolve({ status: statusCode, body: payload }); return this; },
      };
      (router as any).handle(req, res, () => resolve({ status: 404, body: null }));
    });
    expect(r.status).toBe(200);
    expect(r.body.removed).toBe(true);

    const deletes = queries.filter(q => q.sql.startsWith('DELETE FROM grocery_order_items'));
    expect(deletes.length).toBe(1);

    const auditInserts = queries.filter(q => q.sql.startsWith('INSERT INTO grocery_order_item_audit'));
    expect(auditInserts.length).toBe(1);
    expect(auditInserts[0].params?.[2]).toBe('removed');
    expect(auditInserts[0].params?.[4]).toBe(3); // qty_before
    expect(auditInserts[0].params?.[5]).toBe(0); // qty_after
  });
});

// ============================================================
// Lock + submit cron
// ============================================================

describe('POST /cron/lock-and-submit', () => {
  const ORIG = process.env.CRON_SECRET;
  beforeEach(() => { process.env.CRON_SECRET = 'test-secret'; });

  it('marks the run as skipped when the cart is empty — no Amazon call', async () => {
    const app = buildApp();
    const runId = '88888888-8888-8888-8888-888888888888';
    matchers.push((sql) => {
      if (sql.includes("status = 'open'") && sql.includes('cycle_start_at')) {
        return { rows: [{ id: runId, status: 'open' }] };
      }
      if (sql.includes('SELECT COUNT(*)') && sql.includes('FROM grocery_order_items')) {
        return { rows: [{ cnt: '0' }] };
      }
      if (sql.startsWith('UPDATE grocery_order_runs') && sql.includes("status = 'skipped'")) {
        return { rows: [] };
      }
      return null;
    });

    const r = await new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = {
        method: 'POST', url: '/cron/lock-and-submit',
        originalUrl: '/cron/lock-and-submit', path: '/cron/lock-and-submit',
        headers: { 'x-cron-secret': 'test-secret' }, params: {}, query: {}, body: {},
        get(h: string) { return this.headers[h.toLowerCase()]; },
      };
      let statusCode = 200; let payload: any = null;
      const res: any = {
        status(c: number) { statusCode = c; return this; },
        json(b: any) { payload = b; resolve({ status: statusCode, body: payload }); return this; },
      };
      (router as any).handle(req, res, () => resolve({ status: 404, body: null }));
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('skipped');

    const skippedUpdates = queries.filter(q => q.sql.includes("status = 'skipped'"));
    expect(skippedUpdates.length).toBe(1);
    const lockedUpdates = queries.filter(q => q.sql.includes("status = 'locked'"));
    expect(lockedUpdates.length).toBe(0);
  });

  it('locks the run and leaves it locked + alerts WhatsApp when Amazon submit fails', async () => {
    const app = buildApp();
    const runId = '99999999-9999-9999-9999-999999999999';
    matchers.push((sql) => {
      if (sql.includes("status = 'open'") && sql.includes('cycle_start_at')) {
        return { rows: [{ id: runId, status: 'open' }] };
      }
      if (sql.includes('SELECT COUNT(*)') && sql.includes('FROM grocery_order_items')) {
        return { rows: [{ cnt: '1' }] };
      }
      if (sql.includes('FROM grocery_order_items WHERE run_id =') && !sql.includes('COUNT(*)')) {
        return { rows: [{ id: 'x', name: 'Milk', brand: null, size_label: null, quantity: 1, amazon_asin: 'B0X', amazon_url: null }] };
      }
      // getGroceryApproverPhones lookup — return both Tony and Lana so the
      // failure alert is verified to reach both household members.
      if (sql.includes('whatsapp_number') && sql.includes('FROM household_members')) {
        return { rows: [{ whatsapp_number: '15550100' }, { whatsapp_number: '15550101' }] };
      }
      if (sql.startsWith('UPDATE grocery_order_runs')) return { rows: [] };
      return null;
    });

    const notifications = await import('../../utils/notifications');

    const r = await new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = {
        method: 'POST', url: '/cron/lock-and-submit',
        originalUrl: '/cron/lock-and-submit', path: '/cron/lock-and-submit',
        headers: { 'x-cron-secret': 'test-secret' }, params: {}, query: {}, body: {},
        get(h: string) { return this.headers[h.toLowerCase()]; },
      };
      let statusCode = 200; let payload: any = null;
      const res: any = {
        status(c: number) { statusCode = c; return this; },
        json(b: any) { payload = b; resolve({ status: statusCode, body: payload }); return this; },
      };
      (router as any).handle(req, res, () => resolve({ status: 404, body: null }));
    });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.status).toBe('locked');

    const lockedUpdates = queries.filter(q => q.sql.includes("status = 'locked'"));
    expect(lockedUpdates.length).toBe(1); // initial lock
    const submittedUpdates = queries.filter(q => q.sql.includes("status = 'submitted'"));
    expect(submittedUpdates.length).toBe(0);
    expect((notifications.sendMonitorAlert as any).mock.calls.length).toBeGreaterThanOrEqual(1);
    // Failure alert must reach both Tony and Lana, not just one number.
    const alertArg = (notifications.sendMonitorAlert as any).mock.calls[0][0];
    const alertedPhones = (alertArg.recipients as Array<{ whatsapp: string }>).map((r) => r.whatsapp);
    expect(alertedPhones).toEqual(expect.arrayContaining(['15550100', '15550101']));
  });

  afterAll(() => { process.env.CRON_SECRET = ORIG; });
});

// Vitest provides afterAll globally when globals: true.
declare const afterAll: (fn: () => void) => void;
