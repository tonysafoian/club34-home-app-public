/**
 * Tests for the Grocery Helper email system.
 *
 * Cases 1–3: Pure unit tests for renderCartHtml (no DB / network).
 * Cases 4–6: Route handler integration tests (mocked DB + email).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (hoisted before any imports) ────────────────────────────

vi.mock('../auditLog.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/notifications', () => ({
  sendMonitorAlert: vi.fn().mockResolvedValue({ sent: true, cooldownActive: false, emailResults: [], whatsappResults: [] }),
}));

vi.mock('../../socket.js', () => ({
  emitToAll: vi.fn(),
}));

vi.mock('../../auth', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../helpers.js', () => ({
  getSaKey: vi.fn(() => ({ client_email: 'svc@project.iam.gserviceaccount.com', private_key: '---', token_uri: 'https://oauth2.googleapis.com/token' })),
  getServiceToken: vi.fn().mockResolvedValue('mock-access-token'),
  base64url: vi.fn((data: Uint8Array) => Buffer.from(data).toString('base64url')),
  logEmail: vi.fn().mockResolvedValue(undefined),
  enqueueFailedJob: vi.fn().mockResolvedValue(undefined),
  JANUS_EMAIL: 'assistant@example.com',
}));

// Storage mock — programmable matchers queue
const storageQueries: Array<{ sql: string; params?: unknown[] }> = [];
type Matcher = (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number } | null;
const storageMatchers: Matcher[] = [];

vi.mock('../../storage', () => ({
  storage: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      storageQueries.push({ sql, params });
      for (const m of storageMatchers) {
        const r = m(sql, params);
        if (r !== null) return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

// DB mock — controls report_email_dedup INSERT (and logEmail/logAudit fallback queries)
let dedupInsertCount = 0;
let dedupThrowOn: number[] = []; // call indices (1-based) that should throw 23505

vi.mock('../db.js', () => ({
  query: vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('report_email_dedup')) {
      dedupInsertCount++;
      if (dedupThrowOn.includes(dedupInsertCount)) {
        const err: Record<string, unknown> = new Error('duplicate key value violates unique constraint') as unknown as Record<string, unknown>;
        (err as Record<string, unknown>).code = '23505';
        throw err;
      }
    }
    return { rows: [], rowCount: 0 };
  }),
}));

// Pool mock — handles withTransaction (used by openCycleIfMissing)
const TEST_RUN: Record<string, unknown> = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  status: 'open',
  cycle_start_at: '2026-05-17T07:00:00.000Z',
  cycle_lock_at: '2026-05-22T23:00:00.000Z',
  delivery_date: '2026-05-25',
  item_count: 2,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_user_id: null,
};

vi.mock('../../db', () => ({
  pool: {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [], rowCount: 0 };
        // openCycleIfMissing: SELECT FOR UPDATE SKIP LOCKED
        if (sql.includes('FROM grocery_order_runs') && sql.includes('FOR UPDATE')) {
          return { rows: [TEST_RUN], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    })),
  },
  db: {},
}));

// sendGroceryEmail mock — preserve the real renderCartHtml/renderCartText/buildSubject
vi.mock('../groceryEmail.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../groceryEmail.js')>();
  return {
    ...orig,
    sendGroceryEmail: vi.fn().mockResolvedValue({ ok: true, results: [] }),
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────

import { renderCartHtml, buildSubject } from '../groceryEmail.js';

// Lazy-import the router so all mocks are set up first
const { default: groceryRouter } = await import('../../routes/grocery.js');

// ─── Request helper ──────────────────────────────────────────────────────

async function callHandler(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body: unknown = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve) => {
    const req: Record<string, unknown> = {
      method, url, originalUrl: url, path: url,
      headers,
      params: {},
      query: {},
      body,
      get(h: string) { return (this.headers as Record<string, string>)[h.toLowerCase()]; },
    };
    let statusCode = 200;
    let payload: unknown = null;
    const res: Record<string, unknown> = {
      status(code: number) { statusCode = code; return this; },
      json(b: unknown) { payload = b; resolve({ status: statusCode, body: payload }); return this; },
      send(b: unknown) { payload = b; resolve({ status: statusCode, body: payload }); return this; },
    };
    (groceryRouter as unknown as { handle: Function }).handle(req, res, () => resolve({ status: 404, body: null }));
  });
}

const CRON_HEADERS = { 'x-cron-secret': 'test-secret' };

beforeEach(() => {
  storageQueries.length = 0;
  storageMatchers.length = 0;
  dedupInsertCount = 0;
  dedupThrowOn = [];
  process.env.CRON_SECRET = 'test-secret';
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 1: renderCartHtml — empty cart
// ═══════════════════════════════════════════════════════════════════════════

describe('renderCartHtml — empty cart', () => {
  it('returns a full HTML document with empty-cart copy for last-call variant', () => {
    const html = renderCartHtml('last-call', []);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Last call.');
    expect(html).toContain('No items in the cart yet.');
    expect(html).toContain('Open the catalog');
    expect(html).toContain('#f6f3ec');
    expect(html).toContain('34');
  });

  it('returns the last-call empty subject line', () => {
    const subject = buildSubject('last-call', []);
    expect(subject).toBe('Grocery Helper — Last call · Nothing picked yet');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 2: renderCartHtml — with items grouped by category
// ═══════════════════════════════════════════════════════════════════════════

describe('renderCartHtml — two items grouped by category', () => {
  const items = [
    { id: '1', name: 'Whole Milk', category: 'dairy', brand: 'Organic Valley', size: '1 gal', unit_price: 699, quantity: 2 },
    { id: '2', name: 'Avocados', category: 'produce', brand: null, size: '4-pack', unit_price: 499, quantity: 1 },
  ];

  it('renders both items in the HTML', () => {
    const html = renderCartHtml('last-call', items);
    expect(html).toContain('Whole Milk');
    expect(html).toContain('Avocados');
  });

  it('produces appears before dairy (priority ordering)', () => {
    const html = renderCartHtml('last-call', items);
    const produceIdx = html.indexOf('Avocados');
    const dairyIdx = html.indexOf('Whole Milk');
    expect(produceIdx).toBeLessThan(dairyIdx);
  });

  it('renders category headers', () => {
    const html = renderCartHtml('last-call', items);
    expect(html).toContain('Dairy');
    expect(html).toContain('Produce');
  });

  it('renders brand in the email', () => {
    const html = renderCartHtml('last-call', items);
    expect(html).toContain('Organic Valley');
  });

  it('renders correct subject for non-empty cart', () => {
    const subject = buildSubject('last-call', items);
    expect(subject).toBe('Grocery Helper — Last call · 2 items so far');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 3: HTML escaping
// ═══════════════════════════════════════════════════════════════════════════

describe('renderCartHtml — HTML escaping', () => {
  it('escapes XSS in item name', () => {
    const items = [
      { name: "<script>alert('x')</script>", category: 'other', quantity: 1 },
    ];
    const html = renderCartHtml('last-call', items);
    expect(html).not.toContain('<script>alert(');
    expect(html).toContain('&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;');
  });

  it('escapes XSS in brand name', () => {
    const items = [
      { name: 'Milk', category: 'dairy', brand: '<b>Injected</b>', quantity: 1 },
    ];
    const html = renderCartHtml('last-call', items);
    expect(html).not.toContain('<b>Injected</b>');
    expect(html).toContain('&lt;b&gt;Injected&lt;/b&gt;');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 4: /cron/last-call — dedup returns skipped on second call
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /cron/last-call — dedup', () => {
  beforeEach(() => {
    // Active recipients
    storageMatchers.push((sql) => {
      if (sql.includes('FROM household_members') && sql.includes('is_active = true')) {
        return { rows: [{ display_name: 'Admin User', email: 'admin@example.com' }] };
      }
      if (sql.includes('FROM grocery_order_items') && sql.includes('run_id')) {
        return { rows: [{ id: 'x', name: 'Apples', category: 'produce', quantity: 2 }] };
      }
      if (sql.includes('FROM grocery_order_item_audit')) {
        return { rows: [] };
      }
      return null;
    });
  });

  it('first call: processes and returns success', async () => {
    const r = await callHandler('POST', '/cron/last-call', CRON_HEADERS);
    expect(r.status).toBe(200);
    expect((r.body as Record<string, unknown>).skipped).toBeUndefined();
    expect((r.body as Record<string, unknown>).success).toBe(true);
  });

  it('second call with same cycle: returns skipped=true (dedup guard)', async () => {
    // First call inserts dedup row (count = 1, succeeds)
    await callHandler('POST', '/cron/last-call', CRON_HEADERS);

    // Make the second INSERT throw 23505 (second call → dedupInsertCount = 2)
    dedupThrowOn = [2];

    const r2 = await callHandler('POST', '/cron/last-call', CRON_HEADERS);
    expect(r2.status).toBe(200);
    expect((r2.body as Record<string, unknown>).skipped).toBe(true);
    expect((r2.body as Record<string, unknown>).reason).toMatch(/already_sent/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 5: /cron/rina-monday — skips when no submitted run today
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /cron/rina-monday — no submitted run today', () => {
  it('returns skipped=true when no submitted run exists for today', async () => {
    // storage returns no run
    storageMatchers.push((sql) => {
      if (sql.includes('FROM grocery_order_runs') && sql.includes("status = 'submitted'")) {
        return { rows: [] };
      }
      return null;
    });

    const r = await callHandler('POST', '/cron/rina-monday', CRON_HEADERS);
    expect(r.status).toBe(200);
    expect((r.body as Record<string, unknown>).skipped).toBe(true);
    expect((r.body as Record<string, unknown>).reason).toBe('no submitted run for today');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Case 6: /cron/rina-monday — fetches household_members by alias (not hard-coded)
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /cron/rina-monday — DB lookup for Rina', () => {
  it('queries household_members.email and whatsapp_number via aliases column', async () => {
    const RINA_EMAIL = 'member@example.test';
    const RINA_PHONE = '13105550001';

    storageMatchers.push((sql) => {
      if (sql.includes('FROM grocery_order_runs') && sql.includes("status = 'submitted'")) {
        return { rows: [{ ...TEST_RUN, status: 'submitted', id: TEST_RUN.id }] };
      }
      if (sql.includes('FROM household_members') && sql.includes("ANY(aliases)")) {
        return { rows: [{ display_name: 'Rina', email: RINA_EMAIL, whatsapp_number: RINA_PHONE }] };
      }
      if (sql.includes('FROM grocery_order_items') && sql.includes('run_id')) {
        return { rows: [{ id: 'i1', name: 'Eggs', category: 'dairy', quantity: 1 }] };
      }
      return null;
    });

    const r = await callHandler('POST', '/cron/rina-monday', CRON_HEADERS);

    expect(r.status).toBe(200);

    // Verify that the handler actually queried household_members with aliases
    const memberQuery = storageQueries.find(q =>
      q.sql.includes('household_members') && q.sql.includes('ANY(aliases)'),
    );
    expect(memberQuery).toBeDefined();
    // Email and whatsapp_number are selected (not hard-coded)
    expect(memberQuery!.sql).toMatch(/email/);
    expect(memberQuery!.sql).toMatch(/whatsapp_number/);

    // sendGroceryEmail was called with Rina's email
    const { sendGroceryEmail } = await import('../groceryEmail.js');
    const calls = (sendGroceryEmail as ReturnType<typeof vi.fn>).mock.calls;
    const rinaCalls = calls.filter((c: unknown[]) => {
      const params = c[0] as { toAddresses?: string[] };
      return params.toAddresses?.includes(RINA_EMAIL);
    });
    expect(rinaCalls.length).toBeGreaterThan(0);
  });
});
