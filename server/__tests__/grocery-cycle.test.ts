/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * server/__tests__/grocery-cycle.test.ts
 *
 * Tests for the grocery weekly cycle — exercises the exported business logic
 * functions (openCycleIfMissing, executeAddItem, executePatchItem,
 * executeLockAndSubmit, writeItemAudit, ptTimestamp, getCurrentCycleWindow).
 *
 * 7 spec cases:
 *  1. Idempotent open — openCycleIfMissing returns the same run on concurrent calls
 *  2. DST-safe cycle windows (Mar 8 + Nov 1 2026)
 *  3. executeAddItem writes both audit rows (grocery_order_item_audit + logAudit)
 *  4. executePatchItem qty=0 deletes item and writes "removed" audit
 *  5. Mutations rejected when run status != 'open'
 *  6. executeLockAndSubmit with empty cart → status=skipped, no WhatsApp alert
 *  7. executeLockAndSubmit with submit failure → stays locked + WhatsApp alert fired
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── vi.hoisted: variables created before vi.mock factories execute ────────────

// mockPoolConnect must be created before vi.mock('../db') runs (vi.mock is hoisted).
const { mockPoolConnect } = vi.hoisted(() => ({
  mockPoolConnect: vi.fn(),
}));

// ── Mock declarations ──────────────────────────────────────────────────────────

// Fake pool client factory — controls what each client.query call returns.
// BEGIN / COMMIT / ROLLBACK are handled transparently and do NOT consume a
// slot in queryResponses, so callers only need to list their real query results.
const makeFakeClient = (queryResponses: Array<{ rows?: any[]; rowCount?: number }>) => {
  let callIdx = 0;
  const TX_CMDS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);
  return {
    query: vi.fn(async (sql: string) => {
      if (TX_CMDS.has(sql)) return { rows: [], rowCount: 0 };
      const resp = queryResponses[callIdx] ?? { rows: [], rowCount: 0 };
      callIdx++;
      return resp;
    }),
    release: vi.fn(),
  };
};

vi.mock('../db', () => ({
  pool: { connect: mockPoolConnect },
  db: {},
}));

vi.mock('../storage', () => ({
  storage: { query: vi.fn() },
}));

vi.mock('../auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../utils/notifications', () => ({
  sendMonitorAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/auditLog.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { storage } from '../storage';
import { sendMonitorAlert } from '../utils/notifications';
import { logAudit } from '../lib/auditLog.js';
import {
  ptTimestamp,
  getCurrentCycleWindow,
  openCycleIfMissing,
  writeItemAudit,
  executeAddItem,
  executePatchItem,
  executeLockAndSubmit,
  type GroceryRun,
  type GroceryOrderItem,
} from '../routes/grocery';

// ── Stable mock accessors ────────────────────────────────────────────────────

function sq() {
  return vi.mocked(storage.query) as unknown as ReturnType<typeof vi.fn<
    (sql: string, params?: unknown[]) => Promise<{ rows?: unknown[]; rowCount?: number | null }>
  >>;
}
function alertFn() { return vi.mocked(sendMonitorAlert); }
function auditFn() { return vi.mocked(logAudit); }

// ── Test data factories ───────────────────────────────────────────────────────

function makeRun(overrides: Partial<GroceryRun> = {}): GroceryRun {
  return {
    id: 'run-uuid-1',
    status: 'open',
    item_count: 0,
    cycle_start_at: new Date('2026-05-16T07:00:00Z').toISOString(),
    cycle_lock_at: new Date('2026-05-22T23:00:00Z').toISOString(),
    delivery_date: '2026-05-25',
    created_by_user_id: 'user-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeItem(overrides: Partial<GroceryOrderItem> = {}): GroceryOrderItem {
  return {
    id: 'item-uuid-1',
    run_id: 'run-uuid-1',
    staple_id: null,
    amazon_asin: 'B00TESTXXX',
    name: 'Organic Whole Milk',
    category: 'dairy',
    brand: 'Organic Valley',
    size: '1 gal',
    image_url: null,
    unit_price: null,
    quantity: 2,
    added_by_user_id: 'user-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Case 1: Idempotent + concurrency-safe open ─────────────────────────────

describe('Case 1 — openCycleIfMissing: idempotent + concurrency-safe', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the existing run without inserting when SELECT FOR UPDATE finds one', async () => {
    const existingRun = makeRun();
    const client = makeFakeClient([
      { rows: [existingRun] }, // SELECT FOR UPDATE finds existing run
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const result = await openCycleIfMissing('user-1');

    expect(result).toEqual({ run: existingRun, isNew: false });
    // Only one query issued (the SELECT FOR UPDATE) — no INSERT
    const querySqls = client.query.mock.calls.map((c: any[]) => c[0] as string);
    const nonTxCalls = querySqls.filter((s) => s !== 'BEGIN' && s !== 'COMMIT' && s !== 'ROLLBACK');
    expect(nonTxCalls).toHaveLength(1);
    expect(nonTxCalls[0]).toMatch(/FOR UPDATE/);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('inserts a new run when SELECT FOR UPDATE finds nothing', async () => {
    const newRun = makeRun({ id: 'run-new' });
    const client = makeFakeClient([
      { rows: [] },          // SELECT FOR UPDATE → empty
      { rows: [newRun] },    // INSERT ON CONFLICT DO NOTHING → new row
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const result = await openCycleIfMissing('user-1');

    expect(result).toEqual({ run: newRun, isNew: true });
    expect(client.release).toHaveBeenCalledOnce();
    const querySqls = client.query.mock.calls.map((c: any[]) => c[0] as string);
    const nonTxCalls = querySqls.filter((s) => s !== 'BEGIN' && s !== 'COMMIT' && s !== 'ROLLBACK');
    expect(nonTxCalls.some((s) => s.includes('INSERT INTO grocery_order_runs'))).toBe(true);
  });

  it('handles INSERT race (ON CONFLICT DO NOTHING) by falling back to a second SELECT', async () => {
    const racedRun = makeRun({ id: 'run-raced' });
    const client = makeFakeClient([
      { rows: [] },           // SELECT FOR UPDATE → empty
      { rows: [] },           // INSERT → nothing (concurrent winner inserted first)
      { rows: [racedRun] },   // fallback SELECT → winner's row
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const result = await openCycleIfMissing('user-2');
    expect(result).toEqual({ run: racedRun, isNew: false });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('returns null when all three paths yield empty rows (extreme edge)', async () => {
    const client = makeFakeClient([
      { rows: [] }, // SELECT FOR UPDATE
      { rows: [] }, // INSERT
      { rows: [] }, // fallback SELECT
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const result = await openCycleIfMissing();
    expect(result).toEqual({ run: null, isNew: false });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('releases the client even when the transaction throws', async () => {
    const client = {
      query: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      release: vi.fn(),
    };
    mockPoolConnect.mockResolvedValue(client);

    await expect(openCycleIfMissing()).rejects.toThrow('DB connection lost');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

// ── Case 2: DST-safe cycle windows ────────────────────────────────────────

describe('Case 2 — DST-safe cycle windows', () => {
  afterEach(() => vi.useRealTimers());

  it('ptTimestamp: midnight Jan 15 2026 PT (PST, UTC-8) → 08:00 UTC', () => {
    const ts = ptTimestamp('2026-01-15', 0);
    expect(ts.getUTCHours()).toBe(8);
    expect(ts.toISOString().startsWith('2026-01-15')).toBe(true);
  });

  it('ptTimestamp: 4 PM Jun 1 2026 PT (PDT, UTC-7) → 23:00 UTC', () => {
    const ts = ptTimestamp('2026-06-01', 16);
    expect(ts.getUTCHours()).toBe(23);
  });

  it('Nov 1 2026 (fall-back Sunday, PST): cycle = Oct 31 Sat → Nov 6 Fri', () => {
    // Clocks fell back at 2 AM → PST (UTC-8). Using noon Nov 1 PST = 20:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-01T20:00:00Z'));

    const { cycleStartAt, cycleLockAt, deliveryDate } = getCurrentCycleWindow();

    // Sat Oct 31 00:00 PDT = 07:00 UTC
    expect(cycleStartAt.getTime()).toBe(Date.UTC(2026, 9, 31, 7, 0, 0));
    // Fri Nov 6 16:00 PST = 00:00 UTC Nov 7
    expect(cycleLockAt.getTime()).toBe(Date.UTC(2026, 10, 7, 0, 0, 0));
    // Delivery Monday Nov 9
    expect(deliveryDate).toBe('2026-11-09');
  });

  it('Mar 8 2026 (spring-forward Sunday, PDT): cycle = Mar 7 Sat → Mar 13 Fri', () => {
    // Using 10 AM PDT (17:00 UTC) on Mar 8 (a Sunday).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-08T17:00:00Z'));

    const { cycleStartAt, cycleLockAt, deliveryDate } = getCurrentCycleWindow();

    // Sat Mar 7 00:00 PST = 08:00 UTC (Mar 7 was still PST)
    expect(cycleStartAt.getTime()).toBe(Date.UTC(2026, 2, 7, 8, 0, 0));
    // Fri Mar 13 16:00 PDT = 23:00 UTC (PDT = UTC-7)
    expect(cycleLockAt.getTime()).toBe(Date.UTC(2026, 2, 13, 23, 0, 0));
    // Delivery Monday Mar 16
    expect(deliveryDate).toBe('2026-03-16');
  });
});

// ── Case 3: executeAddItem writes both audit rows ─────────────────────────

describe('Case 3 — executeAddItem: writes both audit rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sq().mockReset();
  });

  it('adds a one-off item: writes grocery_order_item_audit + logAudit', async () => {
    const item = makeItem({ id: 'item-new' });

    // storage.query call sequence for executeAddItem (one-off item, no stapleId):
    // 1. SELECT run to validate it's open
    // 2. SELECT id to check if item already exists (pre-check)
    // 3. INSERT/upsert item (RETURNING *)
    // 4. INSERT grocery_order_item_audit (from writeItemAudit)
    // 5. UPDATE item_count on run
    sq()
      .mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'open' }] })          // run validate
      .mockResolvedValueOnce({ rows: [] })                                         // pre-check (not exists)
      .mockResolvedValueOnce({ rows: [item] })                                     // upsert
      .mockResolvedValueOnce({ rows: [] })                                         // audit insert
      .mockResolvedValueOnce({ rowCount: 1 });                                     // item_count update

    const result = await executeAddItem({
      runId: 'run-1',
      amazonAsin: item.amazon_asin!,
      name: item.name,
      category: item.category,
      quantity: 2,
      actorUserId: 'user-1',
    });

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.inserted).toBe(true);
      expect(result.item.name).toBe(item.name);
    }

    // grocery_order_item_audit INSERT
    const auditInsertCall = sq().mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO grocery_order_item_audit'),
    );
    expect(auditInsertCall).toBeDefined();
    expect(auditInsertCall![1]).toContain('added');

    // system_audit_log via logAudit
    expect(auditFn()).toHaveBeenCalledWith(
      'grocery-order',
      expect.objectContaining({ event_type: 'grocery_item_added', status: 'success' }),
    );
  });

  it('returns 409 when run is not open', async () => {
    sq().mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'locked' }] });

    const result = await executeAddItem({
      runId: 'run-1',
      amazonAsin: 'B000TEST',
      name: 'Avocados',
      category: 'produce',
      actorUserId: 'user-1',
    });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/not open/);
    }
    // No audit rows written for rejected mutations
    expect(auditFn()).not.toHaveBeenCalled();
  });

  it('returns 400 when amazonAsin is missing for a one-off item', async () => {
    sq().mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'open' }] });

    const result = await executeAddItem({
      runId: 'run-1',
      name: 'Avocados',
      category: 'produce',
      actorUserId: 'user-1',
      // amazonAsin intentionally omitted
    });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/amazonAsin/);
    }
  });
});

// ── Case 4: executePatchItem qty=0 deletes and audits ─────────────────────

describe('Case 4 — executePatchItem qty=0: deletes item + writes removed audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('qty=0: deletes the item row and writes action=removed audit', async () => {
    const item = makeItem({ quantity: 3, run_status: 'open' } as any);

    // storage.query call sequence:
    // 1. SELECT item JOIN run (run_status='open')
    // 2. DELETE item
    // 3. INSERT grocery_order_item_audit (from writeItemAudit)
    // 4. UPDATE item_count
    sq()
      .mockResolvedValueOnce({ rows: [{ ...item, run_status: 'open' }] }) // item+run
      .mockResolvedValueOnce({ rowCount: 1 })                              // DELETE
      .mockResolvedValueOnce({ rows: [] })                                 // audit insert
      .mockResolvedValueOnce({ rowCount: 1 });                             // item_count

    const result = await executePatchItem(item.id, 0, 'user-1');

    expect(result).toEqual({ deleted: true, removed: true });

    // DELETE was called
    const deleteSql = sq().mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE FROM grocery_order_items'),
    );
    expect(deleteSql).toBeDefined();

    // audit row: action=removed, oldQty=3, newQty=0
    const auditCall = sq().mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO grocery_order_item_audit'),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall![1]).toContain('removed');
    expect(auditCall![1]).toContain(3);   // old_qty
    expect(auditCall![1]).toContain(0);   // new_qty

    expect(auditFn()).toHaveBeenCalledWith(
      'grocery-order',
      expect.objectContaining({ event_type: 'grocery_item_removed' }),
    );
  });

  it('updates quantity (qty > 0) and writes action=qty_changed audit', async () => {
    const item = makeItem({ quantity: 2 });
    sq()
      .mockResolvedValueOnce({ rows: [{ ...item, run_status: 'open' }] })
      .mockResolvedValueOnce({ rows: [{ ...item, quantity: 5 }] })         // UPDATE
      .mockResolvedValueOnce({ rows: [] });                                 // audit insert

    const result = await executePatchItem(item.id, 5, 'user-1');

    expect('item' in result).toBe(true);
    if ('item' in result) expect(result.item.quantity).toBe(5);

    const auditCall = sq().mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO grocery_order_item_audit'),
    );
    expect(auditCall![1]).toContain('qty_changed');
    expect(auditFn()).toHaveBeenCalledWith(
      'grocery-order',
      expect.objectContaining({ event_type: 'grocery_item_qty_changed' }),
    );
  });
});

// ── Case 5: Mutations rejected when run is not open ───────────────────────

describe('Case 5 — Mutation guard: rejected when run is not open', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executePatchItem returns 409 for a locked run', async () => {
    const item = makeItem({ quantity: 1 });
    sq().mockResolvedValueOnce({ rows: [{ ...item, run_status: 'locked' }] });

    const result = await executePatchItem(item.id, 2, 'user-1');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/not open.*locked/);
    }
    // No DELETE, no audit
    const hasDelete = sq().mock.calls.some(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE'),
    );
    expect(hasDelete).toBe(false);
    expect(auditFn()).not.toHaveBeenCalled();
  });

  it('executePatchItem returns 409 for a submitted run', async () => {
    const item = makeItem({ quantity: 3 });
    sq().mockResolvedValueOnce({ rows: [{ ...item, run_status: 'submitted' }] });

    const result = await executePatchItem(item.id, 0, 'user-1');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/not open.*submitted/);
    }
    expect(auditFn()).not.toHaveBeenCalled();
  });

  it('executePatchItem returns 404 for a missing item', async () => {
    sq().mockResolvedValueOnce({ rows: [] }); // item not found

    const result = await executePatchItem('nonexistent-id', 2, 'user-1');

    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.status).toBe(404);
  });

  it('executeAddItem returns 409 for a skipped run', async () => {
    sq().mockResolvedValueOnce({ rows: [{ id: 'run-1', status: 'skipped' }] });

    const result = await executeAddItem({
      runId: 'run-1',
      amazonAsin: 'B000SKIP',
      name: 'Eggs',
      category: 'dairy',
      actorUserId: 'user-1',
    });

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.status).toBe(409);
    }
  });
});

// ── Case 6: executeLockAndSubmit — empty cart → skipped ───────────────────

describe('Case 6 — executeLockAndSubmit: empty cart → status=skipped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Set time to Friday 16:00 PDT (May 22 2026 = 23:00 UTC)
    vi.setSystemTime(new Date('2026-05-22T23:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('sets status=skipped and does NOT call sendMonitorAlert for empty cart', async () => {
    const openRun = makeRun({ status: 'open' });
    const client = makeFakeClient([
      { rows: [openRun] },    // SELECT FOR UPDATE → open run
      { rows: [{ cnt: '0' }] }, // COUNT items → 0
      { rowCount: 1 },          // UPDATE status='skipped'
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const submitFn = vi.fn(); // Must NOT be called for empty cart

    const outcome = await executeLockAndSubmit(submitFn);

    expect(outcome.status).toBe('skipped');
    expect((outcome as any).run_id).toBe(openRun.id);

    // submitFn was never invoked
    expect(submitFn).not.toHaveBeenCalled();
    // WhatsApp alert was NOT fired
    expect(alertFn()).not.toHaveBeenCalled();
    // The UPDATE set status='skipped'
    const updateCalls = client.query.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('skipped'),
    );
    expect(updateCalls.length).toBeGreaterThan(0);
  });

  it('returns no_open_run when no open run exists for the current cycle', async () => {
    const client = makeFakeClient([
      { rows: [] }, // SELECT FOR UPDATE → no open run
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const outcome = await executeLockAndSubmit(vi.fn());

    expect(outcome.status).toBe('no_open_run');
    expect(alertFn()).not.toHaveBeenCalled();
  });
});

// ── Case 7: executeLockAndSubmit — submit failure → locked + WhatsApp ─────

describe('Case 7 — executeLockAndSubmit: submit failure → stays locked + WhatsApp alert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T23:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('leaves run locked and calls sendMonitorAlert with cooldownKey on submit failure', async () => {
    const openRun = makeRun({ status: 'open', item_count: 3 });
    const client = makeFakeClient([
      { rows: [openRun] },       // SELECT FOR UPDATE
      { rows: [{ cnt: '3' }] }, // COUNT items → 3
      { rowCount: 1 },            // UPDATE status='locked'
    ]);
    mockPoolConnect.mockResolvedValue(client);

    // storage.query used for items fetch + submission_log persistence
    const items = [makeItem(), makeItem({ id: 'item-2' }), makeItem({ id: 'item-3' })];
    sq()
      .mockResolvedValueOnce({ rows: items })   // SELECT items
      .mockResolvedValueOnce({ rowCount: 1 });   // UPDATE submission_log

    // Submit function throws → simulates Stagehand/Browserbase failure
    const submitFn = vi.fn().mockRejectedValue(new Error('Browserbase session timeout'));

    const outcome = await executeLockAndSubmit(submitFn);

    expect(outcome.status).toBe('submit_failed');
    expect((outcome as any).error).toMatch(/Browserbase session timeout/);

    // Run stays locked — no UPDATE to 'submitted'
    const submittedUpdates = sq().mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'submitted'"),
    );
    expect(submittedUpdates).toHaveLength(0);

    // submission_log was persisted with the error
    const logUpdate = sq().mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('submission_log'),
    );
    expect(logUpdate).toBeDefined();

    // WhatsApp alert fired with cooldown key
    expect(alertFn()).toHaveBeenCalledTimes(1);
    expect(alertFn()).toHaveBeenCalledWith(
      expect.objectContaining({
        cooldownKey: 'grocery-submit-failure',
        cooldownMs: 4 * 60 * 60 * 1000,
        channels: ['whatsapp'],
      }),
    );
  });

  it('partial run (some items added) stays locked but does NOT fire the failure alert', async () => {
    const openRun = makeRun({ status: 'open', item_count: 3 });
    const client = makeFakeClient([
      { rows: [openRun] },       // SELECT FOR UPDATE
      { rows: [{ cnt: '3' }] },  // COUNT items → 3
      { rowCount: 1 },           // UPDATE status='locked'
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const items = [makeItem(), makeItem({ id: 'item-2' }), makeItem({ id: 'item-3' })];
    sq()
      .mockResolvedValueOnce({ rows: items })   // SELECT items
      .mockResolvedValueOnce({ rowCount: 1 });   // UPDATE submission_log

    // Partial outcome: 2 of 3 added. submitGroceryOrder already sent the cart
    // confirmation WhatsApp, so the generic failure alert must be suppressed.
    const submitFn = vi.fn().mockResolvedValue({
      success: false,
      log: { items_added: 2, item_count: 3, items_failed: 1 },
      error: '1 of 3 item(s) failed — run kept locked for manual review',
    });

    const outcome = await executeLockAndSubmit(submitFn);

    expect(outcome.status).toBe('submit_failed');
    // No duplicate failure alert on a partial run
    expect(alertFn()).not.toHaveBeenCalled();

    // submission_log still persisted with the error
    const logUpdate = sq().mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes('submission_log'),
    );
    expect(logUpdate).toBeDefined();
  });

  it('full failure (zero items added) stays locked and fires the failure alert', async () => {
    const openRun = makeRun({ status: 'open', item_count: 3 });
    const client = makeFakeClient([
      { rows: [openRun] },       // SELECT FOR UPDATE
      { rows: [{ cnt: '3' }] },  // COUNT items → 3
      { rowCount: 1 },           // UPDATE status='locked'
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const items = [makeItem(), makeItem({ id: 'item-2' }), makeItem({ id: 'item-3' })];
    sq()
      .mockResolvedValueOnce({ rows: items })   // SELECT items
      .mockResolvedValueOnce({ rowCount: 1 });   // UPDATE submission_log

    // No items added — no cart confirmation was sent, so the failure alert must fire.
    const submitFn = vi.fn().mockResolvedValue({
      success: false,
      log: { items_added: 0, item_count: 3, items_failed: 3 },
      error: 'All 3 item(s) failed to be added to the Amazon Fresh cart',
    });

    const outcome = await executeLockAndSubmit(submitFn);

    expect(outcome.status).toBe('submit_failed');
    expect(alertFn()).toHaveBeenCalledTimes(1);
    expect(alertFn()).toHaveBeenCalledWith(
      expect.objectContaining({ cooldownKey: 'grocery-submit-failure', channels: ['whatsapp'] }),
    );
  });

  it('transitions to submitted and does NOT call sendMonitorAlert on success', async () => {
    const openRun = makeRun({ status: 'open', item_count: 5 });
    const client = makeFakeClient([
      { rows: [openRun] },
      { rows: [{ cnt: '5' }] },
      { rowCount: 1 },             // UPDATE status='locked'
    ]);
    mockPoolConnect.mockResolvedValue(client);

    const items = Array.from({ length: 5 }, (_, i) => makeItem({ id: `item-${i}` }));
    sq()
      .mockResolvedValueOnce({ rows: items })  // SELECT items
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE status='submitted'

    const submitFn = vi.fn().mockResolvedValue({ success: true, log: { order_id: 'AMZ-123' } });

    const outcome = await executeLockAndSubmit(submitFn);

    expect(outcome.status).toBe('submitted');
    expect((outcome as any).item_count).toBe(5);

    // UPDATE status='submitted' was issued
    const submittedUpdate = sq().mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && (c[0] as string).includes("status = 'submitted'"),
    );
    expect(submittedUpdate).toBeDefined();

    // No WhatsApp alert on success
    expect(alertFn()).not.toHaveBeenCalled();
  });
});

// ── writeItemAudit standalone test ────────────────────────────────────────

describe('writeItemAudit — audit trail correctness', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes grocery_order_item_audit row with correct params', async () => {
    sq().mockResolvedValueOnce({ rows: [] });

    await writeItemAudit({
      itemId: 'item-1',
      runId: 'run-1',
      action: 'added',
      actorUserId: 'user-1',
      oldQty: null,
      newQty: 2,
      detail: { name: 'Baby Spinach', amazon_asin: 'B00CHMN5G8' },
    });

    expect(sq()).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO grocery_order_item_audit/s),
      expect.arrayContaining(['item-1', 'run-1', 'added', 'user-1', null, 2]),
    );
    expect(auditFn()).toHaveBeenCalledWith(
      'grocery-order',
      expect.objectContaining({ event_type: 'grocery_item_added', status: 'success' }),
    );
  });
});
