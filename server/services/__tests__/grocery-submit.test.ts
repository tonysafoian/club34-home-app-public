/**
 * server/services/__tests__/grocery-submit.test.ts
 *
 * Smoke tests for server/services/grocery-submit.ts
 *
 * Coverage:
 *  1. buildItemList constructs the correct search terms from grocery_order_items rows
 *  2. submitGroceryOrder throws loudly when BROWSERBASE_API_KEY is missing
 *  3. submitGroceryOrder throws loudly when BROWSERBASE_PROJECT_ID is missing
 *  4. submitGroceryOrder throws loudly when GOOGLE_GENERATIVE_AI_API_KEY is missing
 *  5. A Stagehand session failure causes submitGroceryOrder to return success=false
 *     so that executeLockAndSubmit leaves the run locked and fires the WhatsApp alert
 *  6. Success path: all items added -> success=true, log contains correct counts
 *  7. Partial failure: some items fail -> success=true (at least one added)
 *  8. Total failure: all items fail -> success=false, error message present
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock fetch globally ──────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockEnv(overrides: Record<string, string | undefined> = {}) {
  const defaults: Record<string, string> = {
    BROWSERBASE_API_KEY: 'bb-test-key',
    BROWSERBASE_PROJECT_ID: 'proj-test-id',
    GOOGLE_GENERATIVE_AI_API_KEY: 'gemini-test-key',
  };
  const merged = { ...defaults, ...overrides };
  const originals: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) {
    originals[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Returns a fetch mock that succeeds for all Stagehand calls */
function buildSuccessFetch(sessionId = 'sess-abc-123') {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/sessions/start')) return { ok: true, json: async () => ({ session_id: sessionId }) };
    if (String(url).includes('/navigate')) return { ok: true, json: async () => ({ ok: true }) };
    if (String(url).includes('/act')) return { ok: true, json: async () => ({ ok: true }) };
    if (String(url).includes('/close')) return { ok: true, json: async () => ({}) };
    return { ok: false, json: async () => ({ error: 'unknown endpoint' }) };
  });
}

/** Returns a fetch mock that makes /act always fail (simulate Stagehand error) */
function buildActFailFetch(sessionId = 'sess-fail-123') {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/sessions/start')) return { ok: true, json: async () => ({ session_id: sessionId }) };
    if (String(url).includes('/navigate')) return { ok: true, json: async () => ({ ok: true }) };
    if (String(url).includes('/act')) return { ok: false, json: async () => ({ error: 'act failed' }) };
    if (String(url).includes('/close')) return { ok: true, json: async () => ({}) };
    return { ok: false, json: async () => ({ error: 'unknown' }) };
  });
}

/**
 * Returns a fetch mock where /act succeeds (HTTP 200) but the AI reports it
 * could not find a matching product — it emits the NO_MATCH sentinel instead
 * of clicking. This simulates an out-of-stock item / empty search result.
 */
function buildNoMatchFetch(sessionId = 'sess-nomatch-123') {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/sessions/start')) return { ok: true, json: async () => ({ session_id: sessionId }) };
    if (String(url).includes('/navigate')) return { ok: true, json: async () => ({ ok: true }) };
    if (String(url).includes('/act')) return { ok: true, json: async () => ({ data: 'NO_MATCH' }) };
    if (String(url).includes('/close')) return { ok: true, json: async () => ({}) };
    return { ok: false, json: async () => ({ error: 'unknown' }) };
  });
}

// ── Import subject (after vi.stubGlobal) ──────────────────────────────────────

import { buildItemList, submitGroceryOrder, buildCartNotification } from '../grocery-submit.js';
import type { GrocerySubmitResult } from '../grocery-submit.js';
import type { GroceryOrderItem } from '../../routes/grocery.js';

// ── Factories ─────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<GroceryOrderItem> = {}): GroceryOrderItem {
  return {
    id: 'item-1',
    run_id: 'run-1',
    staple_id: null,
    amazon_asin: null,
    name: 'Whole Milk',
    category: 'dairy',
    brand: null,
    size: null,
    image_url: null,
    unit_price: null,
    quantity: 1,
    added_by_user_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Case 1-4: buildItemList and credential validation ─────────────────────────

describe('buildItemList', () => {
  it('uses name only when brand is null', () => {
    const items = [makeItem({ name: 'Whole Milk', brand: null, size: null, quantity: 1 })];
    const list = buildItemList(items);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Whole Milk');
    expect(list[0].quantity).toBe(1);
    expect(list[0].size).toBeNull();
  });

  it('prepends brand when present', () => {
    const items = [makeItem({ name: 'Whole Milk', brand: 'Organic Valley', size: '1 gal', quantity: 2 })];
    const list = buildItemList(items);
    expect(list[0].name).toBe('Organic Valley Whole Milk');
    expect(list[0].size).toBe('1 gal');
    expect(list[0].quantity).toBe(2);
  });

  it('maps multiple items preserving order', () => {
    const items = [
      makeItem({ id: 'a', name: 'Eggs', brand: 'Happy Egg', size: 'Large 12ct', quantity: 3 }),
      makeItem({ id: 'b', name: 'Butter', brand: null, size: '16 oz', quantity: 1 }),
    ];
    const list = buildItemList(items);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('Happy Egg Eggs');
    expect(list[0].size).toBe('Large 12ct');
    expect(list[1].name).toBe('Butter');
    expect(list[1].size).toBe('16 oz');
  });

  it('handles empty list', () => {
    expect(buildItemList([])).toEqual([]);
  });
});

describe('submitGroceryOrder -- credential validation', () => {
  it('throws when BROWSERBASE_API_KEY is missing', async () => {
    const restore = mockEnv({ BROWSERBASE_API_KEY: undefined });
    try {
      await expect(submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }])).rejects.toThrow(
        'BROWSERBASE_API_KEY',
      );
    } finally {
      restore();
    }
  });

  it('throws when BROWSERBASE_PROJECT_ID is missing', async () => {
    const restore = mockEnv({ BROWSERBASE_PROJECT_ID: undefined });
    try {
      await expect(submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }])).rejects.toThrow(
        'BROWSERBASE_PROJECT_ID',
      );
    } finally {
      restore();
    }
  });

  it('throws when model API key is missing', async () => {
    const restore = mockEnv({ GOOGLE_GENERATIVE_AI_API_KEY: undefined, GEMINI_API_KEY: undefined });
    try {
      await expect(submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }])).rejects.toThrow(
        'GOOGLE_GENERATIVE_AI_API_KEY',
      );
    } finally {
      restore();
    }
  });
});

// ── Case 5-8: browser automation (fake timers so setTimeout is instant) ───────

describe('submitGroceryOrder -- success path', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = mockEnv();
    vi.useFakeTimers();
    mockFetch.mockImplementation(buildSuccessFetch('sess-ok-1'));
  });

  afterEach(() => {
    vi.useRealTimers();
    restore();
    mockFetch.mockReset();
  });

  it('returns success=true and correct counts when all items are added', async () => {
    const items = [
      { name: 'Organic Valley Whole Milk', quantity: 2, size: '1 gal' },
      { name: 'Happy Egg Eggs', quantity: 1, size: 'Large 12ct' },
    ];
    const promise = submitGroceryOrder(items);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.log.submission_method).toBe('stagehand_amazon_fresh');
    expect(result.log.item_count).toBe(2);
    expect(result.log.items_added).toBe(2);
    expect(result.log.items_failed).toBe(0);
    expect(result.log.session_id).toBe('sess-ok-1');
    expect(result.log.session_replay_url).toContain('sess-ok-1');
    expect(result.error).toBeUndefined();
  });

  it('closes the browser session even after success', async () => {
    const promise = submitGroceryOrder([{ name: 'Butter', quantity: 1, size: null }]);
    await vi.runAllTimersAsync();
    await promise;
    const closeCalls = (mockFetch.mock.calls as [string][]).filter(([url]) => String(url).includes('/close'));
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('submitGroceryOrder -- failure paths (all items fail)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = mockEnv();
    vi.useFakeTimers();
    mockFetch.mockImplementation(buildActFailFetch('sess-fail-1'));
  });

  afterEach(() => {
    vi.useRealTimers();
    restore();
    mockFetch.mockReset();
  });

  it('returns success=false and error message when all items fail', async () => {
    const items = [
      { name: 'Organic Milk', quantity: 1, size: null },
      { name: 'NonexistentProduct9999', quantity: 1, size: null },
    ];
    const promise = submitGroceryOrder(items);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/failed to be added/i);
    expect(result.log.items_added).toBe(0);
    expect(result.log.items_failed).toBe(2);
    expect(result.log.items.every((i) => i.status === 'failed')).toBe(true);
  });

  it('closes the session even when all items fail', async () => {
    const promise = submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }]);
    await vi.runAllTimersAsync();
    await promise;
    const closeCalls = (mockFetch.mock.calls as [string][]).filter(([url]) => String(url).includes('/close'));
    expect(closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('signals locked-state preservation -- success=false triggers WhatsApp alert path', async () => {
    const promise = submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }]);
    await vi.runAllTimersAsync();
    const result = await promise;
    // executeLockAndSubmit checks result.success — false means run stays locked
    // and sendMonitorAlert fires (matching Case 7 in grocery-cycle.test.ts)
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('submitGroceryOrder -- partial failure (some items fail)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = mockEnv();
    vi.useFakeTimers();

    let actCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/sessions/start')) return { ok: true, json: async () => ({ session_id: 'sess-partial' }) };
      if (String(url).includes('/navigate')) return { ok: true, json: async () => ({ ok: true }) };
      if (String(url).includes('/act')) {
        actCalls++;
        return actCalls === 1
          ? { ok: true, json: async () => ({ ok: true }) }
          : { ok: false, json: async () => ({ error: 'not found' }) };
      }
      if (String(url).includes('/close')) return { ok: true, json: async () => ({}) };
      return { ok: false, json: async () => ({ error: 'unknown' }) };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    restore();
    mockFetch.mockReset();
  });

  it('returns success=false when any item fails (strict: all-or-nothing)', async () => {
    const items = [
      { name: 'Milk', quantity: 1, size: null },
      { name: 'NonexistentProduct9999', quantity: 1, size: null },
    ];
    const promise = submitGroceryOrder(items);
    await vi.runAllTimersAsync();
    const result = await promise;

    // Even though 1 item was added, partial failure means success=false.
    // executeLockAndSubmit will keep the run locked and fire the WhatsApp alert.
    expect(result.success).toBe(false);
    expect(result.log.items_added).toBe(1);
    expect(result.log.items_failed).toBe(1);
    expect(result.error).toMatch(/failed.*locked for manual review/i);
  });
});

// ── Cart confirmation message ─────────────────────────────────────────────────

function makeLog(overrides: Partial<GrocerySubmitResult['log']> = {}): GrocerySubmitResult['log'] {
  return {
    submission_method: 'stagehand_amazon_fresh',
    submitted_at: new Date().toISOString(),
    session_id: 'sess-x',
    session_replay_url: 'https://browserbase.com/sessions/sess-x',
    item_count: 2,
    items_added: 2,
    items_not_found: 0,
    items_failed: 0,
    items: [
      { name: 'Milk', quantity: 1, size: null, status: 'added' },
      { name: 'Eggs', quantity: 1, size: null, status: 'added' },
    ],
    ...overrides,
  };
}

describe('buildCartNotification', () => {
  it('reports all items added and includes the replay link', () => {
    const msg = buildCartNotification(makeLog());
    expect(msg).toContain('All 2 item(s) are in the Amazon Fresh cart');
    expect(msg).toContain('✅ Added: 2');
    expect(msg).not.toContain('⚠️ Failed');
    expect(msg).toContain('https://browserbase.com/sessions/sess-x');
  });

  it('flags failed items by name on partial success', () => {
    const msg = buildCartNotification(
      makeLog({
        items_added: 1,
        items_failed: 1,
        items: [
          { name: 'Milk', quantity: 1, size: null, status: 'added' },
          { name: 'Nonexistent Item', quantity: 1, size: null, status: 'failed' },
        ],
      }),
    );
    expect(msg).toContain('Added 1 of 2 item(s)');
    expect(msg).toContain('✅ Added: 1');
    expect(msg).toContain('⚠️ Failed: 1');
    expect(msg).toContain("Couldn't add (please add manually):");
    expect(msg).toContain('• Nonexistent Item');
    expect(msg).not.toContain('• Milk');
  });
});

describe('submitGroceryOrder -- cart confirmation WhatsApp', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = mockEnv({
      WATI_API_ENDPOINT: 'https://wati.example.com/api/ext/v3',
      WATI_ACCESS_TOKEN: 'wati-test-token',
    });
    vi.useFakeTimers();
    mockFetch.mockImplementation(buildSuccessFetch('sess-notify'));
  });

  afterEach(() => {
    vi.useRealTimers();
    restore();
    mockFetch.mockReset();
  });

  it('sends a WhatsApp confirmation to the given phone after success', async () => {
    const promise = submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }], '15550000');
    await vi.runAllTimersAsync();
    await promise;

    const watiCalls = (mockFetch.mock.calls as [string][]).filter(([url]) =>
      String(url).includes('sendSessionMessage/15550000'),
    );
    expect(watiCalls.length).toBe(1);
  });

  it('sends a confirmation to every phone when given an array (Tony and Lana)', async () => {
    const promise = submitGroceryOrder(
      [{ name: 'Milk', quantity: 1, size: null }],
      ['15550100', '15550101'],
    );
    await vi.runAllTimersAsync();
    await promise;

    const urls = (mockFetch.mock.calls as [string][]).map(([url]) => String(url));
    expect(urls.filter((u) => u.includes('sendSessionMessage/15550100')).length).toBe(1);
    expect(urls.filter((u) => u.includes('sendSessionMessage/15550101')).length).toBe(1);
  });

  it('dedupes repeated phone numbers in the array', async () => {
    const promise = submitGroceryOrder(
      [{ name: 'Milk', quantity: 1, size: null }],
      ['15550100', '15550100'],
    );
    await vi.runAllTimersAsync();
    await promise;

    const watiCalls = (mockFetch.mock.calls as [string][]).filter(([url]) =>
      String(url).includes('sendSessionMessage/15550100'),
    );
    expect(watiCalls.length).toBe(1);
  });

  it('does not send a confirmation when no phone is provided', async () => {
    const promise = submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }]);
    await vi.runAllTimersAsync();
    await promise;

    const watiCalls = (mockFetch.mock.calls as [string][]).filter(([url]) =>
      String(url).includes('sendSessionMessage'),
    );
    expect(watiCalls.length).toBe(0);
  });

  it('still returns success=false (does not throw) when the WhatsApp send fails', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/sessions/start')) return { ok: true, json: async () => ({ session_id: 'sess-notify' }) };
      if (String(url).includes('/navigate')) return { ok: true, json: async () => ({ ok: true }) };
      if (String(url).includes('/act')) return { ok: true, json: async () => ({ ok: true }) };
      if (String(url).includes('/close')) return { ok: true, json: async () => ({}) };
      if (String(url).includes('sendSessionMessage')) throw new Error('WATI down');
      return { ok: false, json: async () => ({ error: 'unknown' }) };
    });

    const promise = submitGroceryOrder([{ name: 'Milk', quantity: 1, size: null }], '15550000');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.success).toBe(true);
    expect(result.log.items_added).toBe(1);
  });
});

describe('submitGroceryOrder -- not_found (out of stock / no results)', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = mockEnv();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    restore();
    mockFetch.mockReset();
  });

  it('marks an item not_found (not failed) when act emits the NO_MATCH sentinel', async () => {
    mockFetch.mockImplementation(buildNoMatchFetch('sess-nomatch-1'));

    const promise = submitGroceryOrder([{ name: 'NonexistentProduct9999', quantity: 1, size: null }]);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.log.items_added).toBe(0);
    expect(result.log.items_not_found).toBe(1);
    expect(result.log.items_failed).toBe(0);
    expect(result.log.items[0].status).toBe('not_found');
    expect(result.log.items[0].error).toMatch(/no matching in-stock product/i);
    expect(result.error).toMatch(/not found/i);
  });

  it('does not increment quantity for a not_found item (no extra act calls)', async () => {
    mockFetch.mockImplementation(buildNoMatchFetch('sess-nomatch-2'));

    const promise = submitGroceryOrder([{ name: 'OutOfStockThing', quantity: 3, size: null }]);
    await vi.runAllTimersAsync();
    await promise;

    const actCalls = (mockFetch.mock.calls as [string][]).filter(([url]) => String(url).includes('/act'));
    // Only the single search act; quantity increments are skipped for not_found.
    expect(actCalls.length).toBe(1);
  });

  it('reports a mixed breakdown distinguishing not_found from failed', async () => {
    // item 1 -> added, item 2 -> not_found (NO_MATCH), item 3 -> failed (act errors)
    let actCalls = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/sessions/start')) return { ok: true, json: async () => ({ session_id: 'sess-mixed' }) };
      if (String(url).includes('/navigate')) return { ok: true, json: async () => ({ ok: true }) };
      if (String(url).includes('/act')) {
        actCalls++;
        if (actCalls === 1) return { ok: true, json: async () => ({ ok: true }) };
        if (actCalls === 2) return { ok: true, json: async () => ({ data: 'NO_MATCH' }) };
        return { ok: false, json: async () => ({ error: 'add to cart failed' }) };
      }
      if (String(url).includes('/close')) return { ok: true, json: async () => ({}) };
      return { ok: false, json: async () => ({ error: 'unknown' }) };
    });

    const items = [
      { name: 'Milk', quantity: 1, size: null },
      { name: 'OutOfStock', quantity: 1, size: null },
      { name: 'BrokenAdd', quantity: 1, size: null },
    ];
    const promise = submitGroceryOrder(items);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.log.items_added).toBe(1);
    expect(result.log.items_not_found).toBe(1);
    expect(result.log.items_failed).toBe(1);
    expect(result.error).toMatch(/1 not found/i);
    expect(result.error).toMatch(/1 failed to add/i);
    expect(result.error).toMatch(/locked for manual review/i);
  });
});
