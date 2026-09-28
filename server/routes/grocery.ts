import { Router } from 'express';
import { pool } from '../db';
import { storage } from '../storage';
import { requireAuth } from '../auth';
import { sendMonitorAlert } from '../utils/notifications';
import { logAudit } from '../lib/auditLog.js';
import { emitToAll } from '../socket.js';
import { logEmail, enqueueFailedJob, TONY_EMAIL, MOM_EMAIL } from '../lib/helpers.js';
import { sendGroceryEmail, buildSubject } from '../lib/groceryEmail.js';
import type pg from 'pg';

const router = Router();

const TONY_PHONE = process.env.ADMIN_PHONE || '15550100';
const TONY_USER_ID = '7a85b652-b5d8-44c4-9409-384562448883';

// ─── Grocery image proxy ───────────────────────────────────────────────────
const ALLOWED_IMAGE_HOSTS = new Set([
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
  'ecx.images-amazon.com',
  'g-ec2.images-amazon.com',
]);

const imageCache = new Map<string, { data: Buffer; contentType: string; cachedAt: number }>();
const IMAGE_CACHE_TTL = 24 * 60 * 60 * 1000;
const IMAGE_CACHE_MAX = 300;

router.get('/api/grocery/image', async (req: any, res: any) => {
  try {
    const { url } = req.query;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
    let parsed: URL;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) return res.status(403).json({ error: 'Host not allowed' });

    const cached = imageCache.get(url);
    if (cached && Date.now() - cached.cachedAt < IMAGE_CACHE_TTL) {
      res.setHeader('Content-Type', cached.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      return res.end(cached.data);
    }

    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 10_000);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': 'https://www.amazon.com/',
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        },
      });
    } finally {
      clearTimeout(fetchTimeout);
    }
    if (!upstream.ok) return res.status(502).end();
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return res.status(415).end();
    const contentLength = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (contentLength > 5 * 1024 * 1024) return res.status(413).end();
    const data = Buffer.from(await upstream.arrayBuffer());
    if (data.length > 5 * 1024 * 1024) return res.status(413).end();

    if (imageCache.size >= IMAGE_CACHE_MAX) {
      const oldest = [...imageCache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) imageCache.delete(oldest[0]);
    }
    imageCache.set(url, { data, contentType, cachedAt: Date.now() });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.end(data);
  } catch (error: any) {
    console.error('GET /api/grocery/image error:', error);
    res.status(502).end();
  }
});

// ─── Cycle window helpers ──────────────────────────────────────────────────

/**
 * Converts a PT date string (YYYY-MM-DD) and PT hour to a UTC Date,
 * correctly handling both PST (UTC-8) and PDT (UTC-7) via round-trip
 * verification with Intl.DateTimeFormat. DST-safe.
 */
export function ptTimestamp(ptDateStr: string, ptHour: number, ptMinute = 0): Date {
  const isoBase = `${ptDateStr}T${String(ptHour).padStart(2, '0')}:${String(ptMinute).padStart(2, '0')}:00`;
  for (const offsetHours of [8, 7]) {
    const utcMs = Date.parse(isoBase + 'Z') + offsetHours * 3_600_000;
    const candidate = new Date(utcMs);
    const rawPtHour = parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        hour12: false,
      }).format(candidate),
      10,
    );
    const actualPtHour = rawPtHour % 24; // normalize: some ICU builds return 24 for midnight
    const targetHour = ptHour % 24;
    if (actualPtHour === targetHour) return candidate;
  }
  // Fallback (should never reach): assume PST
  return new Date(Date.parse(isoBase + 'Z') + 8 * 3_600_000);
}

/**
 * Returns the current Sat→Fri cycle window in PT.
 * cycleStartAt = most-recent Saturday 00:00 PT
 * cycleLockAt  = that Friday 16:00 PT
 * deliveryDate = Monday YYYY-MM-DD (delivery target — Mon of the following week)
 */
export function getCurrentCycleWindow(now: Date = new Date()): { cycleStartAt: Date; cycleLockAt: Date; deliveryDate: string } {

  const ptWeekdayName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'short',
  }).format(now);
  const ptWeekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(ptWeekdayName);

  // Days to roll back to reach the most-recent Saturday
  const daysSinceSat = ptWeekday === 6 ? 0 : ptWeekday + 1;
  const nowUtcMs = now.getTime();
  const satDayMs = nowUtcMs - daysSinceSat * 86_400_000;

  const satDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(satDayMs));

  const friDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(satDayMs + 6 * 86_400_000));

  const monDate = new Date(satDayMs + 9 * 86_400_000);
  const monDateStr = monDate.toISOString().slice(0, 10);

  return {
    cycleStartAt: ptTimestamp(satDateStr, 0),
    cycleLockAt: ptTimestamp(friDateStr, 16),
    deliveryDate: monDateStr,
  };
}

// ─── Transaction helper ────────────────────────────────────────────────────

type PgClient = pg.PoolClient;

/**
 * Runs `fn` inside a DB transaction. Automatically BEGIN/COMMIT/ROLLBACK.
 * Exported so tests can swap `pool` via vi.mock.
 */
export async function withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ─── Core business logic (dependency-injected, fully testable) ─────────────

export interface GroceryRun {
  id: string;
  status: string;
  item_count: number;
  cycle_start_at: string;
  cycle_lock_at: string;
  delivery_date: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  locked_at?: string | null;
  submitted_at?: string | null;
  submission_log?: unknown;
  auto_ordered?: boolean;
}

export interface GroceryOrderItem {
  id: string;
  run_id: string;
  staple_id: string | null;
  amazon_asin: string | null;
  name: string;
  category: string;
  brand: string | null;
  size: string | null;
  image_url: string | null;
  unit_price: number | null;
  quantity: number;
  added_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

// NOTE: unit_price and other NUMERIC columns arrive as JS numbers — the
// global pg type parser in server/db.ts coerces NUMERIC/DECIMAL at the driver
// level, so no per-route normalization is needed here.

/**
 * Idempotent + concurrency-safe cycle opener.
 *
 * Uses a DB transaction with SELECT FOR UPDATE to ensure that under concurrent
 * cron invocations (e.g. two instances firing at the same second) exactly one
 * run is created for each cycle. The FOR UPDATE row lock prevents two
 * concurrent callers from both reading "no run" and both inserting.
 *
 * Flow:
 *   BEGIN
 *   SELECT ... FOR UPDATE  → if found, COMMIT and return it
 *   INSERT ... ON CONFLICT DO NOTHING  → if inserted, COMMIT and return new row
 *   SELECT again (lost the race)       → COMMIT and return winner's row
 */
export async function openCycleIfMissing(createdByUserId?: string): Promise<{ run: GroceryRun | null; isNew: boolean }> {
  const { cycleStartAt, cycleLockAt, deliveryDate } = getCurrentCycleWindow();

  return withTransaction(async (client) => {
    // Lock any existing non-cancelled run for this cycle window.
    // SKIP LOCKED avoids deadlock if another concurrent caller already holds the lock —
    // in that case the INSERT below will hit ON CONFLICT and we fall through to the
    // final SELECT.
    const existing = await client.query<GroceryRun>(
      `SELECT * FROM grocery_order_runs
       WHERE cycle_start_at = $1 AND status <> 'cancelled'
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [cycleStartAt.toISOString()],
    );
    if (existing.rows.length > 0) return { run: existing.rows[0], isNew: false };

    // No run exists — insert one.
    const { rows } = await client.query<GroceryRun>(
      `INSERT INTO grocery_order_runs
         (status, cycle_start_at, cycle_lock_at, delivery_date, created_by_user_id, item_count)
       VALUES ('open', $1, $2, $3, $4, 0)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [cycleStartAt.toISOString(), cycleLockAt.toISOString(), deliveryDate, createdByUserId ?? null],
    );

    if (rows.length > 0) {
      logAudit('grocery-cycle', {
        category: 'home', event_type: 'grocery_cycle_opened', severity: 'info',
        actor_id: createdByUserId ?? 'system', actor_role: 'system', channel: 'cron',
        summary: `Grocery cycle opened for ${deliveryDate} delivery`,
        detail: { cycle_start_at: cycleStartAt.toISOString(), run_id: rows[0].id },
        status: 'success',
      }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
      return { run: rows[0], isNew: true };
    }

    // Concurrent winner already inserted — fetch their row.
    const race = await client.query<GroceryRun>(
      `SELECT * FROM grocery_order_runs
       WHERE cycle_start_at = $1 AND status <> 'cancelled'
       LIMIT 1`,
      [cycleStartAt.toISOString()],
    );
    return { run: race.rows[0] ?? null, isNew: false };
  });
}

/**
 * Writes a grocery_order_item_audit row AND a system_audit_log row.
 */
export async function writeItemAudit(opts: {
  itemId: string | null;
  runId: string;
  action: 'added' | 'qty_changed' | 'removed';
  actorUserId: string | null;
  oldQty?: number | null;
  newQty?: number | null;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const { itemId, runId, action, actorUserId, oldQty, newQty, detail } = opts;

  await storage.query(
    `INSERT INTO grocery_order_item_audit
       (item_id, run_id, action, actor_user_id, old_qty, new_qty, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [itemId, runId, action, actorUserId, oldQty ?? null, newQty ?? null, JSON.stringify(detail ?? {})],
  );

  logAudit('grocery-order', {
    category: 'home',
    event_type: `grocery_item_${action}`,
    severity: 'info',
    actor_id: actorUserId ?? 'system',
    actor_role: 'user',
    channel: 'web',
    summary: `Grocery item ${action} in run ${runId}`,
    detail: { item_id: itemId, run_id: runId, old_qty: oldQty, new_qty: newQty, ...detail },
    status: 'success',
  }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
}

/**
 * Core lock-and-submit logic — extracted for testability.
 *
 * The run transition open→locked is atomic via SELECT FOR UPDATE inside a
 * transaction, so two concurrent invocations cannot both lock and submit the
 * same run.
 *
 * Returns a result descriptor that the route handler can serialize.
 */
export async function executeLockAndSubmit(
  submitFn: (run: GroceryRun, items: GroceryOrderItem[]) => Promise<{ success: boolean; log: unknown; error?: string }>,
  getFailureRecipients: () => Promise<string[]> = getGroceryApproverPhones,
): Promise<
  | { status: 'no_open_run' }
  | { status: 'already_locked_or_submitted'; current_status: string }
  | { status: 'skipped'; run_id: string }
  | { status: 'submitted'; run_id: string; item_count: number }
  | { status: 'submit_failed'; run_id: string; error: string }
> {
  const { cycleStartAt } = getCurrentCycleWindow();

  // Atomically transition open→locked under a row lock.
  // This prevents two concurrent calls from both seeing status='open' and both locking.
  const { run, itemCount } = await withTransaction(async (client) => {
    // Lock the open run for this cycle — FOR UPDATE blocks concurrent callers.
    const runResult = await client.query<GroceryRun>(
      `SELECT * FROM grocery_order_runs
       WHERE cycle_start_at = $1 AND status = 'open'
       FOR UPDATE
       LIMIT 1`,
      [cycleStartAt.toISOString()],
    );

    if (!runResult.rows.length) return { run: null, itemCount: 0 };

    const r = runResult.rows[0];

    // Count items inside the transaction so the count is consistent with the lock.
    const countResult = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM grocery_order_items WHERE run_id = $1`,
      [r.id],
    );
    const cnt = parseInt(countResult.rows[0].cnt, 10);

    if (cnt === 0) {
      // Empty cart: mark skipped and release.
      await client.query(
        `UPDATE grocery_order_runs
         SET status = 'skipped', locked_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [r.id],
      );
      logAudit('grocery-cycle', {
        category: 'home', event_type: 'grocery_cycle_skipped', severity: 'info',
        actor_id: 'system', actor_role: 'system', channel: 'cron',
        summary: `Grocery cycle skipped — cart was empty`,
        detail: { run_id: r.id },
        status: 'success',
      }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
      return { run: { ...r, status: 'skipped' }, itemCount: 0 };
    }

    // Lock the run — callers seeing this transaction commit will find status='locked'.
    await client.query(
      `UPDATE grocery_order_runs
       SET status = 'locked', locked_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [r.id],
    );
    return { run: { ...r, status: 'locked' }, itemCount: cnt };
  });

  if (!run) return { status: 'no_open_run' };
  if (run.status === 'skipped') return { status: 'skipped', run_id: run.id };

  // Fetch items for submission (outside the transaction — run is now locked).
  const { rows: items } = await storage.query<GroceryOrderItem>(
    `SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY category, name`,
    [run.id],
  );

  // Attempt Amazon submission.
  let submissionResult: { success: boolean; log: unknown; error?: string };
  try {
    submissionResult = await submitFn(run, items);
  } catch (submitErr: any) {
    submissionResult = { success: false, log: null, error: submitErr.message };
  }

  if (submissionResult.success) {
    await storage.query(
      `UPDATE grocery_order_runs
       SET status = 'submitted', submitted_at = NOW(),
           submission_log = $2, updated_at = NOW()
       WHERE id = $1`,
      [run.id, JSON.stringify(submissionResult.log)],
    );
    logAudit('grocery-cycle', {
      category: 'home', event_type: 'grocery_cycle_submitted', severity: 'info',
      actor_id: 'system', actor_role: 'system', channel: 'cron',
      summary: `Grocery order submitted to Amazon (${itemCount} items)`,
      detail: { run_id: run.id, item_count: itemCount },
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
    return { status: 'submitted', run_id: run.id, item_count: itemCount };
  }

  // Failure — leave status='locked' for manual retry.
  await storage.query(
    `UPDATE grocery_order_runs
     SET submission_log = $2, updated_at = NOW()
     WHERE id = $1`,
    [run.id, JSON.stringify({ error: submissionResult.error, attempted_at: new Date().toISOString() })],
  );

  // A partial run (some items added, some failed) returns success=false but
  // submitGroceryOrder has already sent the cart-confirmation WhatsApp listing
  // what was added, what failed, and the replay link. Firing this generic
  // failure alert too would double-message Tony/Lana, so only send it on a true
  // full failure where nothing made it into the cart (and thus no confirmation
  // was sent).
  const submissionLog = submissionResult.log as { items_added?: number } | null;
  const itemsAdded = typeof submissionLog?.items_added === 'number' ? submissionLog.items_added : 0;

  if (itemsAdded === 0) {
    // Notify every order approver (Tony and Lana), not just one number, so both
    // household members learn the cart failed. getGroceryApproverPhones() already
    // dedupes and falls back to Tony if the lookup yields nothing.
    const failurePhones = await getFailureRecipients();
    sendMonitorAlert({
      recipients: failurePhones.map((whatsapp) => ({ whatsapp })),
      subject: 'Grocery Order Submission Failed',
      body: `⚠️ *Grocery Order Failed*\n\nThe weekly grocery order (${itemCount} items) could not be submitted to Amazon.\n\nError: ${submissionResult.error ?? 'Unknown error'}\n\nPlease submit manually or retry via the admin panel.`,
      channels: ['whatsapp'],
      cooldownKey: 'grocery-submit-failure',
      cooldownMs: 4 * 60 * 60 * 1000,
    }).catch((err: Error) => console.error('[grocery-cron] WhatsApp alert failed:', err));
  }

  logAudit('grocery-cycle', {
    category: 'home', event_type: 'grocery_cycle_submit_failed', severity: 'error',
    actor_id: 'system', actor_role: 'system', channel: 'cron',
    summary: `Grocery order submission failed — run left locked for manual retry`,
    detail: { run_id: run.id, error: submissionResult.error },
    status: 'error',
  }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

  return { status: 'submit_failed', run_id: run.id, error: submissionResult.error ?? 'Unknown error' };
}

/**
 * Core add-item logic — extracted for testability.
 *
 * Validates the run is open, upserts the item, and writes the audit trail.
 * Returns the upserted item and whether it was newly inserted.
 */
export async function executeAddItem(opts: {
  runId: string;
  stapleId?: string | null;
  amazonAsin?: string | null;
  name?: string | null;
  category?: string | null;
  quantity?: number;
  brand?: string | null;
  size?: string | null;
  imageUrl?: string | null;
  unitPrice?: number | null;
  actorUserId: string;
}): Promise<
  | { error: string; status: number }
  | { item: GroceryOrderItem; inserted: boolean }
> {
  const { runId, stapleId, actorUserId } = opts;

  // Validate run is open.
  const runResult = await storage.query<{ id: string; status: string }>(
    `SELECT id, status FROM grocery_order_runs WHERE id = $1`,
    [runId],
  );
  if (!runResult.rows.length) return { error: 'Run not found', status: 404 };
  if (runResult.rows[0].status !== 'open') {
    return { error: `Run is not open (status=${runResult.rows[0].status})`, status: 409 };
  }

  let itemData: Record<string, unknown>;

  if (stapleId) {
    const stapleResult = await storage.query(
      `SELECT * FROM grocery_staples WHERE id = $1`,
      [stapleId],
    );
    if (!stapleResult.rows.length) return { error: 'Staple not found', status: 404 };
    const staple = stapleResult.rows[0];
    itemData = {
      run_id: runId, staple_id: stapleId,
      amazon_asin: staple.amazon_asin, name: staple.name, category: staple.category,
      brand: staple.brand, size: staple.size, image_url: staple.image_url,
      unit_price: staple.unit_price, quantity: opts.quantity ?? staple.default_quantity ?? 1,
      added_by_user_id: actorUserId,
    };
  } else {
    if (!opts.amazonAsin) return { error: 'amazonAsin is required for one-off items', status: 400 };
    if (!opts.name) return { error: 'name is required for one-off items', status: 400 };
    if (!opts.category) return { error: 'category is required for one-off items', status: 400 };
    itemData = {
      run_id: runId, staple_id: null,
      amazon_asin: opts.amazonAsin, name: opts.name, category: opts.category,
      brand: opts.brand ?? null, size: opts.size ?? null, image_url: opts.imageUrl ?? null,
      unit_price: opts.unitPrice ?? null, quantity: opts.quantity ?? 1,
      added_by_user_id: actorUserId,
    };
  }

  // Check if item already exists in this run to determine if this is an insert or update.
  let exists = false;
  if (stapleId) {
    const checkResult = await storage.query<{ id: string }>(
      `SELECT id FROM grocery_order_items WHERE run_id = $1 AND staple_id = $2 LIMIT 1`,
      [runId, stapleId],
    );
    exists = checkResult.rows.length > 0;
  } else {
    const checkResult = await storage.query<{ id: string }>(
      `SELECT id FROM grocery_order_items WHERE run_id = $1 AND amazon_asin = $2 AND staple_id IS NULL LIMIT 1`,
      [runId, opts.amazonAsin],
    );
    exists = checkResult.rows.length > 0;
  }

  let upsertSql: string;
  let upsertParams: unknown[];

  if (stapleId) {
    upsertSql = `
      INSERT INTO grocery_order_items
        (run_id, staple_id, amazon_asin, name, category, brand, size, image_url, unit_price, quantity, added_by_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (run_id, staple_id) WHERE staple_id IS NOT NULL
      DO UPDATE SET
        quantity = EXCLUDED.quantity, name = EXCLUDED.name, category = EXCLUDED.category,
        brand = EXCLUDED.brand, size = EXCLUDED.size, image_url = EXCLUDED.image_url,
        unit_price = EXCLUDED.unit_price, updated_at = NOW()
      RETURNING *
    `;
    upsertParams = [
      itemData.run_id, itemData.staple_id, itemData.amazon_asin,
      itemData.name, itemData.category, itemData.brand, itemData.size,
      itemData.image_url, itemData.unit_price, itemData.quantity, itemData.added_by_user_id,
    ];
  } else {
    upsertSql = `
      INSERT INTO grocery_order_items
        (run_id, staple_id, amazon_asin, name, category, brand, size, image_url, unit_price, quantity, added_by_user_id)
      VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (run_id, amazon_asin) WHERE staple_id IS NULL AND amazon_asin IS NOT NULL
      DO UPDATE SET
        quantity = EXCLUDED.quantity, name = EXCLUDED.name, category = EXCLUDED.category,
        brand = EXCLUDED.brand, size = EXCLUDED.size, image_url = EXCLUDED.image_url,
        unit_price = EXCLUDED.unit_price, updated_at = NOW()
      RETURNING *
    `;
    upsertParams = [
      itemData.run_id, itemData.amazon_asin, itemData.name, itemData.category,
      itemData.brand, itemData.size, itemData.image_url, itemData.unit_price,
      itemData.quantity, itemData.added_by_user_id,
    ];
  }

  const { rows: itemRows } = await storage.query<GroceryOrderItem>(
    upsertSql, upsertParams,
  );
  const item = itemRows[0];
  const wasInserted = !exists;

  await writeItemAudit({
    itemId: item.id,
    runId,
    action: wasInserted ? 'added' : 'qty_changed',
    actorUserId,
    oldQty: wasInserted ? null : undefined,
    newQty: itemData.quantity as number,
    detail: { name: item.name, amazon_asin: item.amazon_asin },
  });

  await storage.query(
    `UPDATE grocery_order_runs
     SET item_count = (SELECT COUNT(*) FROM grocery_order_items WHERE run_id = $1),
         updated_at = NOW()
     WHERE id = $1`,
    [runId],
  );

  return { item: item as GroceryOrderItem, inserted: wasInserted };
}

/**
 * Core patch-quantity logic — extracted for testability.
 * qty <= 0 deletes the item (treated as PATCH qty=0).
 */
export async function executePatchItem(
  itemId: string,
  quantity: number,
  actorUserId: string,
): Promise<
  | { error: string; status: number }
  | { deleted: true; removed?: true }
  | { item: GroceryOrderItem }
> {
  const itemResult = await storage.query(
    `SELECT i.*, r.status AS run_status
     FROM grocery_order_items i
     JOIN grocery_order_runs r ON r.id = i.run_id
     WHERE i.id = $1`,
    [itemId],
  );
  if (!itemResult.rows.length) return { error: 'Item not found', status: 404 };
  const item = itemResult.rows[0];
  if (item.run_status !== 'open') {
    return { error: `Run is not open (status=${item.run_status})`, status: 409 };
  }

  const oldQty: number = item.quantity;

  if (quantity <= 0) {
    await storage.query(`DELETE FROM grocery_order_items WHERE id = $1`, [itemId]);
    await writeItemAudit({
      itemId, runId: item.run_id, action: 'removed',
      actorUserId, oldQty, newQty: 0,
      detail: { name: item.name, amazon_asin: item.amazon_asin },
    });
    await storage.query(
      `UPDATE grocery_order_runs SET item_count=(SELECT COUNT(*) FROM grocery_order_items WHERE run_id=$1), updated_at=NOW() WHERE id=$1`,
      [item.run_id],
    );
    return { deleted: true, removed: true };
  }

  const { rows: updatedRows } = await storage.query<GroceryOrderItem>(
    `UPDATE grocery_order_items SET quantity=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
    [quantity, itemId],
  );
  await writeItemAudit({
    itemId, runId: item.run_id, action: 'qty_changed',
    actorUserId, oldQty, newQty: quantity,
    detail: { name: item.name, amazon_asin: item.amazon_asin },
  });

  return { item: updatedRows[0] };
}

// ─── Auth helper ───────────────────────────────────────────────────────────

function validateCronSecret(req: any): boolean {
  const secret = req.headers['x-cron-secret'];
  return secret === process.env.CRON_SECRET || secret === process.env.JWT_SECRET;
}

// ─── Stagehand submission pipeline ────────────────────────────────────────

/**
 * Returns the WhatsApp numbers of the household members who approve/review
 * grocery orders (the parents — Tony and Lana), looked up from
 * household_members so we don't maintain another literal phone constant.
 * Falls back to TONY_PHONE if the lookup returns nothing, so the cart
 * confirmation is never silently dropped.
 */
export async function getGroceryApproverPhones(): Promise<string[]> {
  try {
    const { rows } = await storage.query<{ whatsapp_number: string | null }>(
      `SELECT whatsapp_number
       FROM household_members
       WHERE is_active = true
         AND lower(email) = ANY($1)
         AND whatsapp_number IS NOT NULL
         AND whatsapp_number <> ''`,
      [[TONY_EMAIL.toLowerCase(), MOM_EMAIL.toLowerCase()]],
    );
    const phones = rows
      .map((r) => (r.whatsapp_number || '').replace(/[^\d]/g, ''))
      .filter(Boolean);
    if (phones.length > 0) return Array.from(new Set(phones));
  } catch (err) {
    console.error('[grocery] getGroceryApproverPhones lookup failed:', err);
  }
  // Lookup failed or returned nothing — fall back to Tony so the confirmation
  // is never silently dropped.
  return [TONY_PHONE];
}

async function submitToAmazonGrocery(
  _run: GroceryRun,
  items: GroceryOrderItem[],
): Promise<{ success: boolean; log: unknown; error?: string }> {
  const { buildItemList, submitGroceryOrder } = await import('../services/grocery-submit.js');
  const itemList = buildItemList(items);
  const notifyPhones = await getGroceryApproverPhones();
  return submitGroceryOrder(itemList, notifyPhones);
}

// ─── Staples CRUD ──────────────────────────────────────────────────────────

router.get('/api/grocery-staples', requireAuth, async (req: any, res: any) => {
  try {
    const { rows } = await storage.query(
      `SELECT id, name, default_quantity, category, platform, is_active,
              added_by_user_id, brand, size, amazon_asin, amazon_url, image_url, unit_price,
              created_at, updated_at
       FROM grocery_staples ORDER BY category ASC, name ASC`,
    );
    res.json({ staples: rows });
  } catch (error: any) {
    console.error('GET /api/grocery-staples error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/grocery-staples', requireAuth, async (req: any, res: any) => {
  try {
    const { name, defaultQuantity, category, platform, brand, size, amazonAsin, amazonUrl, imageUrl, unitPrice } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    const { rows } = await storage.query(
      `INSERT INTO grocery_staples
         (name, default_quantity, category, platform, added_by_user_id, brand, size, amazon_asin, amazon_url, image_url, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [name.trim(), defaultQuantity || 1, category || 'general', platform || 'amazon-fresh',
       req.user!.userId, brand ?? null, size ?? null, amazonAsin ?? null, amazonUrl ?? null, imageUrl ?? null, unitPrice ?? null],
    );
    res.json({ staple: rows[0] });
  } catch (error: any) {
    console.error('POST /api/grocery-staples error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/api/grocery-staples/:id', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { name, defaultQuantity, category, platform, isActive, brand, size, amazonAsin, amazonUrl, imageUrl, unitPrice } = req.body;
    const sets: string[] = [];
    const vals: unknown[] = [];
    let idx = 1;

    if (name !== undefined) { sets.push(`name = $${idx++}`); vals.push(name.trim()); }
    if (defaultQuantity !== undefined) { sets.push(`default_quantity = $${idx++}`); vals.push(defaultQuantity); }
    if (category !== undefined) { sets.push(`category = $${idx++}`); vals.push(category); }
    if (platform !== undefined) { sets.push(`platform = $${idx++}`); vals.push(platform); }
    if (isActive !== undefined) { sets.push(`is_active = $${idx++}`); vals.push(isActive); }
    if (brand !== undefined) { sets.push(`brand = $${idx++}`); vals.push(brand); }
    if (size !== undefined) { sets.push(`size = $${idx++}`); vals.push(size); }
    if (amazonAsin !== undefined) { sets.push(`amazon_asin = $${idx++}`); vals.push(amazonAsin); }
    if (amazonUrl !== undefined) { sets.push(`amazon_url = $${idx++}`); vals.push(amazonUrl); }
    if (imageUrl !== undefined) { sets.push(`image_url = $${idx++}`); vals.push(imageUrl); }
    if (unitPrice !== undefined) { sets.push(`unit_price = $${idx++}`); vals.push(unitPrice); }

    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    sets.push(`updated_at = NOW()`);
    vals.push(id);

    const { rowCount, rows } = await storage.query(
      `UPDATE grocery_staples SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      vals,
    );
    if (!rowCount) return res.status(404).json({ error: 'Staple not found' });
    res.json({ staple: rows[0] });
  } catch (error: any) {
    console.error('PATCH /api/grocery-staples error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/api/grocery-staples/:id', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const { rowCount } = await storage.query(`DELETE FROM grocery_staples WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Staple not found' });
    res.json({ success: true });
  } catch (error: any) {
    console.error('DELETE /api/grocery-staples error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Current cycle ─────────────────────────────────────────────────────────

router.get('/api/grocery-order/current', requireAuth, async (req: any, res: any) => {
  try {
    const { run, isNew } = await openCycleIfMissing(req.user!.userId);
    if (!run) return res.status(500).json({ error: 'Failed to open or retrieve current cycle' });

    const [itemsResult, auditResult] = await Promise.all([
      storage.query(`SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY created_at ASC`, [run.id]),
      storage.query(`SELECT * FROM grocery_order_item_audit WHERE run_id = $1 ORDER BY created_at DESC LIMIT 10`, [run.id]),
    ]);

    res.json({ run, items: itemsResult.rows, audit: auditResult.rows, isNew });
  } catch (error: any) {
    console.error('GET /api/grocery-order/current error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Items: add (upsert) ───────────────────────────────────────────────────

router.post('/api/grocery-order/items', requireAuth, async (req: any, res: any) => {
  try {
    let runId = req.body.runId;
    if (!runId) {
      const { run } = await openCycleIfMissing(req.user!.userId);
      if (!run) return res.status(500).json({ error: 'Failed to open or retrieve current cycle' });
      runId = run.id;
    }

    const result = await executeAddItem({
      runId: runId,
      stapleId: req.body.stapleId,
      amazonAsin: req.body.amazonAsin,
      name: req.body.name,
      category: req.body.category,
      quantity: req.body.quantity,
      brand: req.body.brand,
      size: req.body.size,
      imageUrl: req.body.imageUrl,
      unitPrice: req.body.unitPrice,
      actorUserId: req.user!.userId,
    });

    if ('error' in result) return res.status(result.status).json({ error: result.error });
    emitToAll('grocery:item-changed', { runId: runId, action: 'upsert' });
    res.json(result);
  } catch (error: any) {
    console.error('POST /api/grocery-order/items error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Items: update quantity ────────────────────────────────────────────────

router.patch('/api/grocery-order/items/:itemId', requireAuth, async (req: any, res: any) => {
  try {
    const { itemId } = req.params;
    const { quantity } = req.body;

    if (quantity === undefined || typeof quantity !== 'number') {
      return res.status(400).json({ error: 'quantity (number) is required' });
    }

    const result = await executePatchItem(itemId, quantity, req.user!.userId);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    emitToAll('grocery:item-changed', { itemId, action: 'patch' });
    res.json(result);
  } catch (error: any) {
    console.error('PATCH /api/grocery-order/items/:itemId error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Items: delete ─────────────────────────────────────────────────────────

router.delete('/api/grocery-order/items/:itemId', requireAuth, async (req: any, res: any) => {
  try {
    const { itemId } = req.params;
    // Reuse patch logic with qty=0
    const result = await executePatchItem(itemId, 0, req.user!.userId);
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    emitToAll('grocery:item-changed', { itemId, action: 'delete' });
    res.json(result);
  } catch (error: any) {
    console.error('DELETE /api/grocery-order/items/:itemId error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Runs: list + detail ───────────────────────────────────────────────────

router.get('/api/grocery-order/runs', requireAuth, async (req: any, res: any) => {
  try {
    const { rows } = await storage.query(
      `SELECT id, status, item_count, auto_ordered, approved_by,
              cycle_start_at, cycle_lock_at, delivery_date,
              locked_at, submitted_at, created_by_user_id,
              created_at, approved_at, ordered_at
       FROM grocery_order_runs ORDER BY created_at DESC LIMIT 20`,
    );
    res.json({ runs: rows });
  } catch (error: any) {
    console.error('GET /api/grocery-order/runs error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/grocery-order/runs/:id', requireAuth, async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const runResult = await storage.query(`SELECT * FROM grocery_order_runs WHERE id = $1`, [id]);
    if (!runResult.rows.length) return res.status(404).json({ error: 'Run not found' });

    const [itemsResult, auditResult] = await Promise.all([
      storage.query(`SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY created_at ASC`, [id]),
      storage.query(`SELECT * FROM grocery_order_item_audit WHERE run_id = $1 ORDER BY created_at DESC`, [id]),
    ]);

    res.json({ run: runResult.rows[0], items: itemsResult.rows, audit: auditResult.rows });
  } catch (error: any) {
    console.error('GET /api/grocery-order/runs/:id error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Cron endpoints ────────────────────────────────────────────────────────

// Sat 00:00 PT — open the weekly cycle
router.post('/cron/open-cycle', async (req: any, res: any) => {
  if (!validateCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { run } = await openCycleIfMissing(TONY_USER_ID);
    res.json({ success: true, run_id: run?.id ?? null });
  } catch (error: any) {
    console.error('[grocery-cron] open-cycle error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Tue 16:00 PT — open-reminder notification (cart is open for next week)
router.post('/cron/open-reminder', async (req: any, res: any) => {
  if (!validateCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { run } = await openCycleIfMissing(TONY_USER_ID);
    if (!run || run.status !== 'open') {
      return res.json({ success: true, skipped: true, reason: 'no open run' });
    }

    // Dedup — only one open-reminder email per cycle
    const cycleStartDate = new Date(run.cycle_start_at).toISOString().slice(0, 10);
    const { query: dbQuery } = await import('../lib/db.js');
    try {
      await dbQuery(
        `INSERT INTO report_email_dedup (report_type, period_key) VALUES ($1, $2)`,
        ['grocery-open-reminder', cycleStartDate],
      );
    } catch (dedupErr: unknown) {
      if (typeof dedupErr === 'object' && dedupErr !== null && (dedupErr as { code?: string }).code === '23505') {
        console.log(`[grocery-cron] open-reminder: already sent for cycle ${cycleStartDate} — skipping`);
        return res.json({ success: true, skipped: true, reason: 'already_sent_this_cycle' });
      }
      throw dedupErr;
    }

    // Load items + active recipients
    const [itemsResult, recipientsResult] = await Promise.all([
      storage.query(
        `SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY category, name`,
        [run.id],
      ),
      storage.query(
        `SELECT id, display_name, email FROM household_members WHERE is_active = true AND email IS NOT NULL`,
      ),
    ]);

    const items = itemsResult.rows;
    const recipients = recipientsResult.rows as Array<{ id: string; display_name: string; email: string }>;
    const toAddresses = recipients.map(r => r.email).filter(Boolean);
    const memberNames: Record<string, string> = {};
    for (const r of recipients) memberNames[r.id] = r.display_name;

    if (toAddresses.length === 0) {
      console.warn('[grocery-cron] open-reminder: no active recipients with email — nothing sent');
      logAudit('grocery-cycle', {
        category: 'home', event_type: 'grocery_open_reminder', severity: 'warn',
        actor_id: 'system', actor_role: 'system', channel: 'cron',
        summary: `Grocery open-reminder skipped — no email recipients`,
        detail: { run_id: run.id },
        status: 'skipped',
      }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
      return res.json({ success: true, run_id: run.id, item_count: items.length, sent: 0 });
    }

    const emailResult = await sendGroceryEmail({
      variant: 'open-reminder',
      toAddresses,
      items,
      run,
      memberNames,
    });

    logAudit('grocery-cycle', {
      category: 'home', event_type: 'grocery_open_reminder', severity: 'info',
      actor_id: 'system', actor_role: 'system', channel: 'cron',
      summary: `Grocery open-reminder email sent (${items.length} items) to ${toAddresses.length} recipients`,
      detail: { run_id: run.id, item_count: items.length, ok: emailResult.ok, results: emailResult.results },
      status: emailResult.ok ? 'success' : 'partial',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    if (!emailResult.ok) {
      await enqueueFailedJob('grocery-open-reminder-email', new Error(
        emailResult.results.filter(r => !r.success).map(r => r.error).join('; ') || 'Send failed',
      ));
    }

    res.json({ success: true, run_id: run.id, item_count: items.length, sent: toAddresses.length, ok: emailResult.ok });
  } catch (error: any) {
    console.error('[grocery-cron] open-reminder error:', error);
    await enqueueFailedJob('grocery-open-reminder-email', error);
    res.status(500).json({ error: error.message });
  }
});

// Thu 16:00 PT — last-call notification (cart closes tomorrow)
router.post('/cron/last-call', async (req: any, res: any) => {
  if (!validateCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { run } = await openCycleIfMissing(TONY_USER_ID);
    if (!run || run.status !== 'open') {
      return res.json({ success: true, skipped: true, reason: 'no open run' });
    }

    // Dedup — only one last-call email per cycle
    const cycleStartDate = new Date(run.cycle_start_at).toISOString().slice(0, 10);
    const { query: dbQuery } = await import('../lib/db.js');
    try {
      await dbQuery(
        `INSERT INTO report_email_dedup (report_type, period_key) VALUES ($1, $2)`,
        ['grocery-last-call', cycleStartDate],
      );
    } catch (dedupErr: unknown) {
      if (typeof dedupErr === 'object' && dedupErr !== null && (dedupErr as { code?: string }).code === '23505') {
        console.log(`[grocery-cron] last-call: already sent for cycle ${cycleStartDate} — skipping`);
        return res.json({ success: true, skipped: true, reason: 'already_sent_this_cycle' });
      }
      throw dedupErr;
    }

    // Load items + last 10 audit rows + active recipients
    // memberNames is keyed by household_members.id so that added_by_user_id
    // and actor_user_id lookups in the email renderer resolve to display names.
    const [itemsResult, auditResult, recipientsResult] = await Promise.all([
      storage.query(
        `SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY category, name`,
        [run.id],
      ),
      storage.query(
        `SELECT * FROM grocery_order_item_audit WHERE run_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [run.id],
      ),
      storage.query(
        `SELECT id, display_name, email FROM household_members WHERE is_active = true AND email IS NOT NULL`,
      ),
    ]);

    const items = itemsResult.rows;
    const auditRows = auditResult.rows;
    const recipients = recipientsResult.rows as Array<{ id: string; display_name: string; email: string }>;
    const toAddresses = recipients.map(r => r.email).filter(Boolean);
    // Key by household member UUID so renderer can resolve added_by_user_id / actor_user_id
    const memberNames: Record<string, string> = {};
    for (const r of recipients) memberNames[r.id] = r.display_name;

    if (toAddresses.length === 0) {
      console.warn('[grocery-cron] last-call: no active recipients with email — nothing sent');
      logAudit('grocery-cycle', {
        category: 'home', event_type: 'grocery_last_call', severity: 'warn',
        actor_id: 'system', actor_role: 'system', channel: 'cron',
        summary: `Grocery last-call skipped — no email recipients`,
        detail: { run_id: run.id },
        status: 'skipped',
      }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
      return res.json({ success: true, run_id: run.id, item_count: items.length, sent: 0 });
    }

    const emailResult = await sendGroceryEmail({
      variant: 'last-call',
      toAddresses,
      items,
      run,
      auditRows,
      memberNames,
    });

    logAudit('grocery-cycle', {
      category: 'home', event_type: 'grocery_last_call', severity: 'info',
      actor_id: 'system', actor_role: 'system', channel: 'cron',
      summary: `Grocery last-call email sent (${items.length} items) to ${toAddresses.length} recipients`,
      detail: { run_id: run.id, item_count: items.length, ok: emailResult.ok, results: emailResult.results },
      status: emailResult.ok ? 'success' : 'partial',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    if (!emailResult.ok) {
      await enqueueFailedJob('grocery-last-call-email', new Error(
        emailResult.results.filter(r => !r.success).map(r => r.error).join('; ') || 'Send failed',
      ));
    }

    res.json({ success: true, run_id: run.id, item_count: items.length, sent: toAddresses.length, ok: emailResult.ok });
  } catch (error: any) {
    console.error('[grocery-cron] last-call error:', error);
    await enqueueFailedJob('grocery-last-call-email', error);
    res.status(500).json({ error: error.message });
  }
});

// Fri 16:00 PT — lock and submit to Amazon
router.post('/cron/lock-and-submit', async (req: any, res: any) => {
  if (!validateCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const outcome = await executeLockAndSubmit(submitToAmazonGrocery);

    if (outcome.status === 'no_open_run') {
      return res.json({ success: true, skipped: true, reason: 'no open run for current cycle' });
    }
    if (outcome.status === 'already_locked_or_submitted') {
      return res.json({ success: true, skipped: true, reason: `run already ${outcome.current_status}` });
    }

    // Send lock-confirmation email (deduped per cycle)
    try {
      const { query: dbQuery } = await import('../lib/db.js');
      const { cycleStartAt, cycleLockAt, deliveryDate: cycleDeliveryDate } = getCurrentCycleWindow();
      const cycleStartDate = cycleStartAt.toISOString().slice(0, 10);

      let emailSent = false;
      try {
        await dbQuery(
          `INSERT INTO report_email_dedup (report_type, period_key) VALUES ($1, $2)`,
          ['grocery-lock-confirmation', cycleStartDate],
        );
        emailSent = true;
      } catch (dedupErr: unknown) {
        if (typeof dedupErr === 'object' && dedupErr !== null && (dedupErr as { code?: string }).code === '23505') {
          console.log(`[grocery-cron] lock-confirmation: already sent for cycle ${cycleStartDate} — skipping email`);
        } else {
          throw dedupErr;
        }
      }

      if (emailSent) {
        let toAddresses: string[] = [];
        let items: GroceryOrderItem[] = [];
        let lockStatus: 'submitted' | 'skipped' | 'failed';

        if (outcome.status === 'submitted') {
          lockStatus = 'submitted';
          const [itemsResult, recipientsResult] = await Promise.all([
            storage.query<GroceryOrderItem>(
              `SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY category, name`,
              [outcome.run_id],
            ),
            storage.query(
              `SELECT email FROM household_members WHERE is_active = true AND email IS NOT NULL`,
            ),
          ]);
          items = itemsResult.rows;
          toAddresses = recipientsResult.rows.map((r: { email: string }) => r.email).filter(Boolean);
        } else if (outcome.status === 'skipped') {
          lockStatus = 'skipped';
          const recipientsResult = await storage.query(
            `SELECT email FROM household_members WHERE is_active = true AND email IS NOT NULL`,
          );
          toAddresses = recipientsResult.rows.map((r: { email: string }) => r.email).filter(Boolean);
        } else {
          lockStatus = 'failed';
          toAddresses = ['admin@example.com'];
        }

        const runData = {
          cycle_lock_at: cycleLockAt.toISOString(),
          delivery_date: cycleDeliveryDate,
          cycle_start_at: cycleStartAt.toISOString(),
        };

        const emailResult = await sendGroceryEmail({
          variant: 'lock-confirmation',
          toAddresses,
          items,
          run: runData,
          lockStatus,
        });

        logAudit('grocery-cycle', {
          category: 'home', event_type: 'grocery_lock_confirmation_email', severity: 'info',
          actor_id: 'system', actor_role: 'system', channel: 'cron',
          summary: `Grocery lock-confirmation email sent (${lockStatus}) to ${toAddresses.length} recipients`,
          detail: { run_id: outcome.run_id, lock_status: lockStatus, ok: emailResult.ok },
          status: emailResult.ok ? 'success' : 'partial',
        }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
      }
    } catch (emailErr: unknown) {
      console.error('[grocery-cron] lock-confirmation email error:', emailErr);
      await enqueueFailedJob('grocery-lock-confirmation-email', emailErr);
    }

    switch (outcome.status) {
      case 'skipped':
        return res.json({ ok: true, success: true, status: 'skipped', run_id: outcome.run_id });
      case 'submitted':
        return res.json({ ok: true, success: true, status: 'submitted', run_id: outcome.run_id, item_count: outcome.item_count });
      case 'submit_failed':
        return res.json({ ok: false, success: false, status: 'locked', run_id: outcome.run_id, error: outcome.error });
    }
  } catch (error: any) {
    console.error('[grocery-cron] lock-and-submit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mon 06:00 PT — delivery-day follow-up to Rina
router.post('/cron/rina-monday', async (req: any, res: any) => {
  if (!validateCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const todayPT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const { rows: runRows } = await storage.query(
      `SELECT * FROM grocery_order_runs
       WHERE delivery_date = $1 AND status = 'submitted'
       LIMIT 1`,
      [todayPT],
    );

    if (!runRows.length) {
      return res.json({ success: true, skipped: true, reason: 'no submitted run for today' });
    }

    const run = runRows[0] as GroceryRun;

    // Dedup — only one Rina Monday email per delivery date
    const { query: dbQuery } = await import('../lib/db.js');
    try {
      await dbQuery(
        `INSERT INTO report_email_dedup (report_type, period_key) VALUES ($1, $2)`,
        ['grocery-rina-monday', todayPT],
      );
    } catch (dedupErr: unknown) {
      if (typeof dedupErr === 'object' && dedupErr !== null && (dedupErr as { code?: string }).code === '23505') {
        console.log(`[grocery-cron] rina-monday: already sent for ${todayPT} — skipping`);
        return res.json({ success: true, skipped: true, reason: 'already_sent_today' });
      }
      throw dedupErr;
    }

    // Look up Rina from household_members by alias — never hard-coded
    const { rows: rinaRows } = await storage.query(
      `SELECT display_name, email, whatsapp_number
       FROM household_members
       WHERE is_active = true AND 'Rina' = ANY(aliases)
       LIMIT 1`,
    );

    if (!rinaRows.length) {
      console.warn('[grocery-cron] rina-monday: no household member with alias "Rina" found — skipping');
      logAudit('grocery-cycle', {
        category: 'home', event_type: 'grocery_delivery_day', severity: 'warn',
        actor_id: 'system', actor_role: 'system', channel: 'cron',
        summary: `Grocery rina-monday skipped — no member with alias "Rina"`,
        detail: { run_id: run.id, delivery_date: todayPT },
        status: 'skipped',
      }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
      return res.json({ success: true, skipped: true, reason: 'rina_not_found' });
    }

    const rina = rinaRows[0] as { display_name: string; email: string; whatsapp_number: string | null };

    // Load items
    const { rows: items } = await storage.query<GroceryOrderItem>(
      `SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY category, name`,
      [run.id],
    );

    // Send email to Rina
    let emailOk = false;
    if (rina.email) {
      const emailResult = await sendGroceryEmail({
        variant: 'rina-monday',
        toAddresses: [rina.email],
        items,
        run,
      });
      emailOk = emailResult.ok;

      logEmail(
        'grocery_rina_monday',
        buildSubject('rina-monday', items),
        [rina.email],
        '',
        emailOk ? 'sent' : 'error',
        emailOk ? undefined : emailResult.results[0]?.error,
      ).catch(() => {});
    }

    // Send short WhatsApp note to Rina (12h cooldown)
    let whatsappSent = false;
    if (rina.whatsapp_number) {
      const whatsappResult = await sendMonitorAlert({
        recipients: [{ whatsapp: rina.whatsapp_number }],
        subject: 'Grocery delivery today',
        body: `Hi Rina! 🛒 The grocery order (${items.length} item${items.length !== 1 ? 's' : ''}) should be arriving today. Please put away refrigerated items first. Full checklist sent to your email.`,
        channels: ['whatsapp'],
        cooldownKey: 'grocery-rina-monday',
        cooldownMs: 12 * 60 * 60 * 1000,
      });
      whatsappSent = whatsappResult.sent;
    }

    logAudit('grocery-cycle', {
      category: 'home', event_type: 'grocery_delivery_day', severity: 'info',
      actor_id: 'system', actor_role: 'system', channel: 'cron',
      summary: `Grocery delivery day: Rina Monday email sent for ${todayPT}`,
      detail: { run_id: run.id, item_count: items.length, email_ok: emailOk, whatsapp_sent: whatsappSent },
      status: emailOk ? 'success' : 'partial',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json({ success: true, run_id: run.id, item_count: items.length, delivery_date: todayPT, email_ok: emailOk, whatsapp_sent: whatsappSent });
  } catch (error: any) {
    console.error('[grocery-cron] rina-monday error:', error);
    await enqueueFailedJob('grocery-rina-monday-email', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Admin: skip this week ─────────────────────────────────────────────────

router.post('/api/grocery-order/runs/:id/skip', requireAuth, async (req: any, res: any) => {
  try {
    const isAdmin = (await storage.query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [req.user!.userId],
    )).rows.length > 0;
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const { id } = req.params;
    const runResult = await storage.query(`SELECT * FROM grocery_order_runs WHERE id = $1`, [id]);
    if (!runResult.rows.length) return res.status(404).json({ error: 'Run not found' });
    const run = runResult.rows[0] as GroceryRun;
    if (run.status !== 'open') {
      return res.status(409).json({ error: `Run is not open (status=${run.status})` });
    }

    const { rows: updated } = await storage.query(
      `UPDATE grocery_order_runs
       SET status='skipped', submitted_at=NOW(), updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id],
    );

    logAudit('grocery-cycle', {
      category: 'home', event_type: 'grocery_cycle_skipped_manually', severity: 'info',
      actor_id: req.user!.userId, actor_role: 'admin', channel: 'web',
      summary: `Grocery cycle skipped manually by admin ${req.user!.userId}`,
      detail: { run_id: id },
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    emitToAll('grocery:run-skipped', { runId: id });

    res.json({ success: true, run: updated[0] });
  } catch (error: any) {
    console.error('POST /api/grocery-order/runs/:id/skip error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Ad-hoc one-time item ──────────────────────────────────────────────────

router.post('/api/grocery-order/items/adhoc', requireAuth, async (req: any, res: any) => {
  try {
    const isAdmin = (await storage.query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [req.user!.userId],
    )).rows.length > 0;
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const { runId, name, brand, quantity, category } = req.body;
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const runResult = await storage.query<{ id: string; status: string }>(
      `SELECT id, status FROM grocery_order_runs WHERE id = $1`,
      [runId],
    );
    if (!runResult.rows.length) return res.status(404).json({ error: 'Run not found' });
    if (runResult.rows[0].status !== 'open') {
      return res.status(409).json({ error: `Run is not open (status=${runResult.rows[0].status})` });
    }

    const { rows } = await storage.query<GroceryOrderItem>(
      `INSERT INTO grocery_order_items
         (run_id, staple_id, name, brand, category, quantity, added_by_user_id)
       VALUES ($1, NULL, $2, $3, $4, $5, $6)
       RETURNING *`,
      [runId, name.trim(), brand ?? null, category || 'general', quantity ?? 1, req.user!.userId],
    );

    const item = rows[0];

    await writeItemAudit({
      itemId: item.id,
      runId,
      action: 'added',
      actorUserId: req.user!.userId,
      oldQty: null,
      newQty: item.quantity,
      detail: { name: item.name, adhoc: true },
    });

    await storage.query(
      `UPDATE grocery_order_runs
       SET item_count = (SELECT COUNT(*) FROM grocery_order_items WHERE run_id = $1),
           updated_at = NOW()
       WHERE id = $1`,
      [runId],
    );

    emitToAll('grocery:item-changed', { runId, action: 'adhoc-add' });

    res.json({ item });
  } catch (error: any) {
    console.error('POST /api/grocery-order/items/adhoc error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Reorder: copy items from a past run to the current open cycle ─────────

router.post('/api/grocery-order/runs/:id/copy-to-current', requireAuth, async (req: any, res: any) => {
  try {
    const isAdmin = (await storage.query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [req.user!.userId],
    )).rows.length > 0;
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const { id: sourceRunId } = req.params;

    // Verify source run exists
    const sourceResult = await storage.query(`SELECT id FROM grocery_order_runs WHERE id = $1`, [sourceRunId]);
    if (!sourceResult.rows.length) return res.status(404).json({ error: 'Source run not found' });

    // Find the current cycle (any non-cancelled status)
    const { cycleStartAt } = getCurrentCycleWindow();
    const targetResult = await storage.query<GroceryRun>(
      `SELECT * FROM grocery_order_runs
       WHERE cycle_start_at = $1 AND status <> 'cancelled'
       LIMIT 1`,
      [cycleStartAt.toISOString()],
    );

    if (!targetResult.rows.length) {
      return res.status(409).json({ error: 'No active cycle found to copy into' });
    }
    const target = targetResult.rows[0];

    if (target.status !== 'open') {
      return res.status(400).json({ error: 'Current cycle is locked' });
    }

    // Fetch source items
    const { rows: sourceItems } = await storage.query<GroceryOrderItem>(
      `SELECT * FROM grocery_order_items WHERE run_id = $1`,
      [sourceRunId],
    );

    if (sourceItems.length === 0) {
      return res.json({ copied: 0, skipped: 0 });
    }

    // Fetch staple_ids already in the target run to skip duplicates
    const { rows: targetItems } = await storage.query<{ staple_id: string | null }>(
      `SELECT staple_id FROM grocery_order_items WHERE run_id = $1`,
      [target.id],
    );
    const existingStapleIds = new Set(targetItems.map(r => r.staple_id).filter(Boolean));

    let copied = 0;
    let skipped = 0;

    for (const item of sourceItems) {
      // Skip if the same staple is already in the target run
      if (item.staple_id && existingStapleIds.has(item.staple_id)) {
        skipped++;
        continue;
      }

      await storage.query(
        `INSERT INTO grocery_order_items
           (run_id, staple_id, amazon_asin, name, category, brand, size, image_url, unit_price, quantity, added_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          target.id, item.staple_id, item.amazon_asin, item.name, item.category,
          item.brand, item.size, item.image_url, item.unit_price, item.quantity,
          req.user!.userId,
        ],
      );

      if (item.staple_id) existingStapleIds.add(item.staple_id);
      copied++;
    }

    // Update item_count on target
    await storage.query(
      `UPDATE grocery_order_runs
       SET item_count = (SELECT COUNT(*) FROM grocery_order_items WHERE run_id = $1),
           updated_at = NOW()
       WHERE id = $1`,
      [target.id],
    );

    logAudit('grocery-cycle', {
      category: 'home', event_type: 'grocery_items_copied', severity: 'info',
      actor_id: req.user!.userId, actor_role: 'admin', channel: 'web',
      summary: `Copied ${copied} items from run ${sourceRunId} to current cycle (${skipped} skipped)`,
      detail: { source_run_id: sourceRunId, target_run_id: target.id, copied, skipped },
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    emitToAll('grocery:items-copied', { runId: target.id, copied, skipped });
    emitToAll('grocery:item-changed', { runId: target.id, action: 'copy' });

    res.json({ copied, skipped, targetRunId: target.id });
  } catch (error: any) {
    console.error('POST /api/grocery-order/runs/:id/copy-to-current error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Owner/admin: early lock & submit ─────────────────────────────────────

router.post('/api/grocery-order/runs/:id/lock-early', requireAuth, async (req: any, res: any) => {
  try {
    const isAdmin = (await storage.query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [req.user!.userId],
    )).rows.length > 0;

    if (!isAdmin) return res.status(403).json({ error: 'Only admins can lock the cart early' });

    const { id } = req.params;
    const runResult = await storage.query(`SELECT * FROM grocery_order_runs WHERE id = $1`, [id]);
    if (!runResult.rows.length) return res.status(404).json({ error: 'Run not found' });
    const run = runResult.rows[0] as GroceryRun;
    if (run.status !== 'open') {
      return res.status(409).json({ error: `Run is not open (status=${run.status})` });
    }

    // Lock it (submission runs via the Stagehand/Browserbase pipeline in server/services/grocery-submit.ts)
    await storage.query(
      `UPDATE grocery_order_runs SET status='locked', locked_at=NOW(), updated_at=NOW() WHERE id=$1`,
      [id],
    );

    logAudit('grocery-cycle', {
      category: 'home', event_type: 'grocery_cycle_locked_early', severity: 'info',
      actor_id: req.user!.userId, actor_role: 'user', channel: 'web',
      summary: `Grocery cycle locked early by ${req.user!.userId}`,
      detail: { run_id: id },
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    emitToAll('grocery:item-changed', { runId: id, action: 'lock-early' });

    res.json({ success: true, status: 'locked', run_id: id });
  } catch (error: any) {
    console.error('POST /api/grocery-order/runs/:id/lock-early error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Admin: manual resubmit ────────────────────────────────────────────────

router.post('/api/grocery-order/runs/:id/resubmit', requireAuth, async (req: any, res: any) => {
  try {
    const roleResult = await storage.query(
      `SELECT role FROM user_roles WHERE user_id = $1 AND role = 'admin' LIMIT 1`,
      [req.user!.userId],
    );
    if (!roleResult.rows.length) return res.status(403).json({ error: 'Admin only' });

    const { id } = req.params;
    const runResult = await storage.query(`SELECT * FROM grocery_order_runs WHERE id = $1`, [id]);
    if (!runResult.rows.length) return res.status(404).json({ error: 'Run not found' });
    const run = runResult.rows[0] as GroceryRun;

    if (run.status !== 'locked') {
      return res.status(409).json({ error: `Can only resubmit locked runs (status=${run.status})` });
    }

    const { rows: items } = await storage.query<GroceryOrderItem>(
      `SELECT * FROM grocery_order_items WHERE run_id = $1 ORDER BY category, name`,
      [id],
    );

    let submissionResult: { success: boolean; log: unknown; error?: string };
    try {
      submissionResult = await submitToAmazonGrocery(run, items);
    } catch (submitErr: any) {
      submissionResult = { success: false, log: null, error: submitErr.message };
    }

    if (submissionResult.success) {
      await storage.query(
        `UPDATE grocery_order_runs SET status='submitted', submitted_at=NOW(), submission_log=$2, updated_at=NOW() WHERE id=$1`,
        [id, JSON.stringify(submissionResult.log)],
      );
      return res.json({ success: true, status: 'submitted' });
    }

    await storage.query(
      `UPDATE grocery_order_runs SET submission_log=$2, updated_at=NOW() WHERE id=$1`,
      [id, JSON.stringify({ error: submissionResult.error, attempted_at: new Date().toISOString() })],
    );
    return res.status(500).json({ success: false, status: 'locked', error: submissionResult.error });
  } catch (error: any) {
    console.error('POST /api/grocery-order/runs/:id/resubmit error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Legacy endpoints (deprecated) ────────────────────────────────────────

function deprecationLog(endpoint: string): void {
  console.warn(`[grocery] DEPRECATED endpoint called: ${endpoint} — migrate to /api/grocery-order/*`);
}

router.post('/api/grocery-order/prepare-weekly', requireAuth, (_req: any, res: any) => {
  deprecationLog('POST /api/grocery-order/prepare-weekly');
  res.json({ success: true, message: 'Deprecated — use POST /cron/open-cycle or GET /api/grocery-order/current instead' });
});

router.post('/api/grocery-order/prepare-weekly-cron', async (req: any, res: any) => {
  deprecationLog('POST /api/grocery-order/prepare-weekly-cron');
  if (!validateCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, message: 'Deprecated — replaced by POST /cron/open-cycle' });
});

router.post('/api/grocery-order/approve/:runId', requireAuth, (_req: any, res: any) => {
  deprecationLog(`POST /api/grocery-order/approve/:runId`);
  res.json({ success: true, message: 'Deprecated — cart is now always-open until Friday lock' });
});

router.post('/api/grocery-order/cancel/:runId', requireAuth, async (req: any, res: any) => {
  deprecationLog(`POST /api/grocery-order/cancel/${req.params.runId}`);
  try {
    const { runId } = req.params;
    const { rowCount } = await storage.query(
      `UPDATE grocery_order_runs SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND status IN ('open','locked')`,
      [runId],
    );
    if (!rowCount) return res.status(404).json({ error: 'Run not found or already in terminal state' });
    res.json({ success: true, message: 'Run cancelled' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/grocery-order/auto-order-check', async (req: any, res: any) => {
  deprecationLog('POST /api/grocery-order/auto-order-check');
  if (!validateCronSecret(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, message: 'Deprecated — replaced by POST /cron/lock-and-submit on Friday 4 PM PT' });
});

export default router;
