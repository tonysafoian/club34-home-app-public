/**
 * Janus Time Tracking — T&M Contractor Time Tracking
 * server/routes/time.ts
 *
 * Worker routes: authenticated by JWT role='worker' (or admin acting on behalf)
 * Admin routes: authenticated by the standard Janus 'admin' role (JWT roles claim,
 * backed by user_roles) — there is no separate Time admin list.
 *
 * Canonical timezone: America/Los_Angeles (PT) for all date logic.
 * Money in integer cents. Hours as numeric(5,2) string from postgres → coerce before math.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { getAuthUser } from "../auth.js";
import { logAudit } from "../lib/auditLog.js";
import { query } from "../lib/db.js";
import type { AutomationStatusRow } from "../../shared/dbRows.js";
import { pool } from "../db.js";
import ExcelJS from "exceljs";

const router = Router();

// ── Timezone helpers ───────────────────────────────────────────────────────

const PT = "America/Los_Angeles";

function getTodayPT(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: PT }).format(new Date());
}

function getWeekStartPT(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  const diff = dow === 0 ? 6 : dow - 1;
  const monday = new Date(date);
  monday.setUTCDate(monday.getUTCDate() - diff);
  return monday.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

function isWithinWindow(dateStr: string): boolean {
  const today = getTodayPT();
  // "7-day window" = today + 6 prior days (7 days total)
  const windowStart = addDays(today, -6);
  return dateStr >= windowStart && dateStr <= today;
}

// ── Admin auth helper ──────────────────────────────────────────────────────

// Time admin = standard Janus admin role (same 'admin' role used everywhere else).
function isTimeAdmin(user: { roles: string[] }): boolean {
  return user.roles.includes("admin");
}

// ── Worker identity helper ─────────────────────────────────────────────────

interface WorkerRow {
  id: string;
  user_id: string | null;
  full_name: string;
  email: string;
  mobile: string | null;
  zelle_handle: string | null;
  can_add_expenses: boolean;
  default_category_id: string | null;
  active: boolean;
  deactivated_at: string | null;
  created_at: string;
}

async function getWorkerByEmail(email: string): Promise<WorkerRow | null> {
  const res = await query<WorkerRow>(
    `SELECT * FROM tt_workers WHERE email = $1`,
    [email.toLowerCase()]
  );
  return res.rows[0] ?? null;
}

async function getWorkerByUserId(profileId: string): Promise<WorkerRow | null> {
  const res = await query<WorkerRow>(
    `SELECT * FROM tt_workers WHERE user_id = $1`,
    [profileId]
  );
  return res.rows[0] ?? null;
}

async function getProfileId(userId: string): Promise<string | null> {
  const res = await query<{ id: string }>(
    `SELECT id FROM profiles WHERE user_id = $1`,
    [userId]
  );
  return res.rows[0]?.id ?? null;
}

// Snapshot rate: rate effective on or before the given date
async function snapshotRate(workerId: string, dateStr: string): Promise<number | null> {
  const res = await query<{ hourly_rate_cents: string }>(
    `SELECT hourly_rate_cents FROM tt_rate_history
     WHERE worker_id = $1 AND effective_from <= $2
     ORDER BY effective_from DESC LIMIT 1`,
    [workerId, dateStr]
  );
  if (!res.rows[0]) return null;
  return parseInt(res.rows[0].hourly_rate_cents, 10);
}

// ── Middleware helpers ─────────────────────────────────────────────────────

function requireWorkerOrAdmin(req: Request, res: Response): { user: NonNullable<ReturnType<typeof getAuthUser>> } | null {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  const isWorker = user.roles.includes("worker");
  const isAdmin = isTimeAdmin(user);
  if (!isWorker && !isAdmin) {
    res.status(403).json({ error: "Worker or time-admin role required" });
    return null;
  }
  return { user };
}

function requireTimeAdmin(req: Request, res: Response): { user: NonNullable<ReturnType<typeof getAuthUser>> } | null {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  if (!isTimeAdmin(user)) {
    res.status(403).json({ error: "Time admin authorization required" });
    return null;
  }
  return { user };
}

// ─────────────────────────────────────────────────────────────────────────────
// WORKER ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/time/is-admin — lets the frontend check if the current user is a time admin
// Time admin = standard Janus 'admin' role (same gate as all /api/time/admin/* routes).
router.get("/api/time/is-admin", async (req, res) => {
  try {
    const user = getAuthUser(req);
    if (!user) {
      res.json({ isAdmin: false });
      return;
    }
    res.json({ isAdmin: isTimeAdmin(user), email: user.email });
  } catch (e) {
    console.error("[time] GET /api/time/is-admin error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/me — worker profile, categories, current rate, window bounds
router.get("/api/time/me", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    const isAdmin = isTimeAdmin(user);
    // Admin-only vendor preview: /api/time/me?preview=vendor returns (and on first
    // use creates) a "Test Vendor" worker row linked to the admin's own profile, so
    // the admin can experience the exact vendor UI end-to-end at /time?preview=vendor.
    const vendorPreview = isAdmin && String(req.query.preview || "") === "vendor";

    // Admins are routed to the admin dashboard unless they explicitly ask for the
    // vendor preview (keeps /time → /time/admin redirect stable even after the
    // Test Vendor row exists).
    if (isAdmin && !vendorPreview) {
      res.json({ isAdmin: true, email: user.email, displayName: user.displayName });
      return;
    }

    let worker = await getWorkerByUserId(profileId);

    if (!worker && vendorPreview) {
      // Reuse an existing row for this email (link it), else create the Test Vendor.
      worker = await getWorkerByEmail(user.email);
      if (worker && !worker.user_id) {
        await query(`UPDATE tt_workers SET user_id = $1 WHERE id = $2`, [profileId, worker.id]);
        worker.user_id = profileId;
      }
      if (!worker) {
        const created = await query<WorkerRow>(
          `INSERT INTO tt_workers (full_name, email, mobile, zelle_handle, can_add_expenses, default_category_id, created_by, user_id)
           VALUES ($1, $2, NULL, NULL, true, NULL, $3, $3) RETURNING *`,
          ["Test Vendor", user.email.toLowerCase(), profileId]
        );
        worker = created.rows[0];
        await query(
          `INSERT INTO tt_rate_history (worker_id, hourly_rate_cents, effective_from, created_by)
           VALUES ($1, $2, $3, $4)`,
          [worker.id, 10000, getTodayPT(), profileId]
        );
        await query(
          `INSERT INTO tt_worker_categories (worker_id, category_id)
           SELECT $1, id FROM tt_categories WHERE active = true
           ON CONFLICT DO NOTHING`,
          [worker.id]
        );
        logAudit("time-vendor-preview", {
          event: "test_vendor_created",
          summary: `Test Vendor row auto-created for admin ${user.email} (vendor preview)`,
          status: "success",
          category: "time_tracking",
          detail: { worker_id: worker.id, email: user.email },
        });
      }
    }

    if (!worker) {
      res.status(404).json({ error: "Worker record not found" });
      return;
    }

    const today = getTodayPT();
    // "7-day window" = today + 6 prior days (7 days total)
    const windowStart = addDays(today, -6);

    const [catRows, rateRow] = await Promise.all([
      query<{ id: string; name: string; sort_order: number }>(
        `SELECT c.id, c.name, c.sort_order
         FROM tt_categories c
         JOIN tt_worker_categories wc ON wc.category_id = c.id
         WHERE wc.worker_id = $1 AND c.active = true
         ORDER BY c.sort_order, c.name`,
        [worker.id]
      ),
      query<{ hourly_rate_cents: string; effective_from: string }>(
        `SELECT hourly_rate_cents, effective_from FROM tt_rate_history
         WHERE worker_id = $1 ORDER BY effective_from DESC LIMIT 1`,
        [worker.id]
      ),
    ]);

    const currentRate = rateRow.rows[0]
      ? parseInt(rateRow.rows[0].hourly_rate_cents, 10)
      : null;

    res.json({
      worker: {
        ...worker,
        currentRateCents: currentRate,
        categories: catRows.rows,
        windowStart,
        today,
      },
    });
  } catch (e) {
    console.error("[time] GET /api/time/me error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/entries?week=YYYY-MM-DD — entries + expenses for that week
router.get("/api/time/entries", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) {
      res.status(404).json({ error: "Worker record not found" });
      return;
    }

    const weekParam = String(req.query.week || "");
    const weekStart = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)
      ? getWeekStartPT(weekParam)
      : getWeekStartPT(getTodayPT());
    const weekEnd = addDays(weekStart, 6);

    const [entries, expenses] = await Promise.all([
      query(
        `SELECT te.*, c.name AS category_name
         FROM tt_time_entries te
         JOIN tt_categories c ON c.id = te.category_id
         WHERE te.worker_id = $1 AND te.work_date >= $2 AND te.work_date <= $3
         ORDER BY te.work_date, te.created_at`,
        [worker.id, weekStart, weekEnd]
      ),
      query(
        `SELECT e.*, c.name AS category_name
         FROM tt_expenses e
         LEFT JOIN tt_categories c ON c.id = e.category_id
         WHERE e.worker_id = $1 AND e.expense_date >= $2 AND e.expense_date <= $3
         ORDER BY e.expense_date, e.created_at`,
        [worker.id, weekStart, weekEnd]
      ),
    ]);

    res.json({ weekStart, weekEnd, entries: entries.rows, expenses: expenses.rows });
  } catch (e) {
    console.error("[time] GET /api/time/entries error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/entries — create time entry
router.post("/api/time/entries", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) { res.status(404).json({ error: "Profile not found" }); return; }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) { res.status(404).json({ error: "Worker record not found" }); return; }
    if (!worker.active) { res.status(403).json({ error: "Worker account is deactivated" }); return; }

    const { work_date, category_id, hours, note } = req.body as {
      work_date: string;
      category_id: string;
      hours: number;
      note?: string;
    };

    if (!work_date || !category_id || hours === undefined) {
      res.status(400).json({ error: "work_date, category_id, and hours are required" });
      return;
    }

    if (!isWithinWindow(work_date)) {
      res.status(400).json({ error: "work_date is outside the 7-day submission window" });
      return;
    }

    const hoursNum = Number(hours);
    if (isNaN(hoursNum) || hoursNum < 0.25 || hoursNum > 24) {
      res.status(400).json({ error: "hours must be between 0.25 and 24" });
      return;
    }
    if ((hoursNum * 4) % 1 !== 0) {
      res.status(400).json({ error: "hours must be in 0.25 increments" });
      return;
    }

    // 24-hour daily cap
    const dayTotal = await query<{ total: string }>(
      `SELECT COALESCE(SUM(hours::numeric), 0) AS total FROM tt_time_entries
       WHERE worker_id = $1 AND work_date = $2 AND status != 'rejected'`,
      [worker.id, work_date]
    );
    const existingHours = parseFloat(dayTotal.rows[0]?.total ?? "0");
    if (existingHours + hoursNum > 24) {
      res.status(400).json({ error: "Daily hours cap of 24 would be exceeded" });
      return;
    }

    // Verify category is assigned to this worker
    const catCheck = await query(
      `SELECT 1 FROM tt_worker_categories WHERE worker_id = $1 AND category_id = $2`,
      [worker.id, category_id]
    );
    if (catCheck.rows.length === 0) {
      res.status(400).json({ error: "Category not assigned to this worker" });
      return;
    }

    const rateCents = await snapshotRate(worker.id, work_date);
    if (rateCents === null) {
      res.status(400).json({ error: "No hourly rate defined for this worker" });
      return;
    }

    const result = await query(
      `INSERT INTO tt_time_entries (worker_id, work_date, category_id, hours, note, rate_cents, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [worker.id, work_date, category_id, hoursNum, note || null, rateCents, profileId]
    );
    const entry = result.rows[0];

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "entry_created",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Worker ${worker.full_name} created time entry: ${hoursNum}h on ${work_date}`,
      detail: { entry_id: entry.id, worker_id: worker.id, hours: hoursNum, work_date, category_id },
    });

    res.status(201).json({ entry });
  } catch (e) {
    console.error("[time] POST /api/time/entries error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/time/entries/:id — update time entry (pending/rejected + in-window)
router.patch("/api/time/entries/:id", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) { res.status(404).json({ error: "Profile not found" }); return; }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) { res.status(404).json({ error: "Worker record not found" }); return; }
    if (!worker.active) { res.status(403).json({ error: "Worker account is deactivated" }); return; }

    const { id } = req.params;
    const existing = await query(
      `SELECT * FROM tt_time_entries WHERE id = $1 AND worker_id = $2`,
      [id, worker.id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    const entry = existing.rows[0] as Record<string, unknown>;

    if (entry.status !== "pending" && entry.status !== "rejected") {
      res.status(403).json({ error: "Only pending or rejected entries can be edited" });
      return;
    }
    if (!isWithinWindow(String(entry.work_date))) {
      res.status(403).json({ error: "Entry date is outside the 7-day window" });
      return;
    }

    const { hours, note, category_id } = req.body as { hours?: number; note?: string; category_id?: string };

    let hoursNum = parseFloat(String(entry.hours));
    if (hours !== undefined) {
      hoursNum = Number(hours);
      if (isNaN(hoursNum) || hoursNum < 0.25 || hoursNum > 24) {
        res.status(400).json({ error: "hours must be between 0.25 and 24" });
        return;
      }
      if ((hoursNum * 4) % 1 !== 0) {
        res.status(400).json({ error: "hours must be in 0.25 increments" });
        return;
      }
    }

    // Re-check category assignment if category is changing
    if (category_id && category_id !== String(entry.category_id)) {
      const catCheck = await query(
        `SELECT 1 FROM tt_worker_categories WHERE worker_id = $1 AND category_id = $2`,
        [worker.id, category_id]
      );
      if (catCheck.rows.length === 0) {
        res.status(403).json({ error: "Category not assigned to this worker" });
        return;
      }
    }

    // Re-enforce 24h per-day cap (exclude current entry from the total)
    const dailyOtherHours = await query(
      `SELECT COALESCE(SUM(hours::numeric), 0) AS total
       FROM tt_time_entries
       WHERE worker_id = $1 AND work_date = $2 AND id != $3 AND status != 'rejected'`,
      [worker.id, entry.work_date, id]
    );
    const otherHours = parseFloat(String((dailyOtherHours.rows[0] as Record<string, unknown>).total ?? 0));
    if (otherHours + hoursNum > 24) {
      res.status(400).json({ error: `Total hours for this day would exceed 24h (${otherHours}h already logged)` });
      return;
    }

    // If resubmitting a rejected entry, clear rejected_reason and reset to pending
    const newStatus = entry.status === "rejected" ? "pending" : entry.status;

    const updated = await query(
      `UPDATE tt_time_entries
       SET hours = $1, note = $2, category_id = COALESCE($3, category_id),
           status = $4, rejected_reason = CASE WHEN $4 = 'pending' THEN NULL ELSE rejected_reason END,
           updated_at = now()
       WHERE id = $5 AND worker_id = $6 AND status = $7
       RETURNING *`,
      [hoursNum, note ?? entry.note, category_id ?? null, newStatus, id, worker.id, entry.status]
    );

    if (updated.rows.length === 0) {
      res.status(409).json({ error: "Conflict: entry status changed; please refresh" });
      return;
    }

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "entry_updated",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Worker ${worker.full_name} updated entry ${id}`,
      detail: { entry_id: id, worker_id: worker.id, before: entry, after: updated.rows[0] },
    });

    res.json({ entry: updated.rows[0] });
  } catch (e) {
    console.error("[time] PATCH /api/time/entries/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/time/entries/:id — delete time entry (pending/rejected + in-window)
router.delete("/api/time/entries/:id", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) { res.status(404).json({ error: "Profile not found" }); return; }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) { res.status(404).json({ error: "Worker record not found" }); return; }
    if (!worker.active) { res.status(403).json({ error: "Worker account is deactivated" }); return; }

    const { id } = req.params;
    const existing = await query(
      `SELECT * FROM tt_time_entries WHERE id = $1 AND worker_id = $2`,
      [id, worker.id]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ error: "Entry not found" });
      return;
    }
    const entry = existing.rows[0] as Record<string, unknown>;

    if (entry.status !== "pending" && entry.status !== "rejected") {
      res.status(403).json({ error: "Only pending or rejected entries can be deleted" });
      return;
    }
    if (!isWithinWindow(String(entry.work_date))) {
      res.status(403).json({ error: "Entry date is outside the 7-day window" });
      return;
    }

    const deleted = await query(
      `DELETE FROM tt_time_entries WHERE id = $1 AND worker_id = $2 AND status = $3 RETURNING id`,
      [id, worker.id, entry.status]
    );
    if (deleted.rows.length === 0) {
      res.status(409).json({ error: "Conflict: entry status changed; please refresh" });
      return;
    }

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "entry_deleted",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Worker ${worker.full_name} deleted entry ${id}`,
      detail: { entry_id: id, worker_id: worker.id, entry },
    });

    res.json({ success: true });
  } catch (e) {
    console.error("[time] DELETE /api/time/entries/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/expenses — create expense
router.post("/api/time/expenses", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) { res.status(404).json({ error: "Profile not found" }); return; }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) { res.status(404).json({ error: "Worker record not found" }); return; }
    if (!worker.active) { res.status(403).json({ error: "Worker account is deactivated" }); return; }
    if (!worker.can_add_expenses) { res.status(403).json({ error: "Expense submission not enabled for this worker" }); return; }

    const { expense_date, amount_cents, note, category_id } = req.body as {
      expense_date: string;
      amount_cents: number;
      note: string;
      category_id?: string;
    };

    if (!expense_date || !amount_cents || !note) {
      res.status(400).json({ error: "expense_date, amount_cents, and note are required" });
      return;
    }
    if (!isWithinWindow(expense_date)) {
      res.status(400).json({ error: "expense_date is outside the 7-day window" });
      return;
    }
    if (amount_cents <= 0) {
      res.status(400).json({ error: "amount_cents must be positive" });
      return;
    }

    const result = await query(
      `INSERT INTO tt_expenses (worker_id, expense_date, amount_cents, note, category_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [worker.id, expense_date, amount_cents, note, category_id || null]
    );

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "expense_created",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Worker ${worker.full_name} created expense: $${(amount_cents / 100).toFixed(2)} on ${expense_date}`,
      detail: { expense_id: result.rows[0].id, worker_id: worker.id, amount_cents, expense_date },
    });

    res.status(201).json({ expense: result.rows[0] });
  } catch (e) {
    console.error("[time] POST /api/time/expenses error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/time/expenses/:id
router.patch("/api/time/expenses/:id", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) { res.status(404).json({ error: "Profile not found" }); return; }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) { res.status(404).json({ error: "Worker record not found" }); return; }
    if (!worker.active) { res.status(403).json({ error: "Worker account is deactivated" }); return; }
    if (!worker.can_add_expenses) { res.status(403).json({ error: "Expense submission not enabled" }); return; }

    const { id } = req.params;
    const existing = await query(
      `SELECT * FROM tt_expenses WHERE id = $1 AND worker_id = $2`,
      [id, worker.id]
    );
    if (existing.rows.length === 0) { res.status(404).json({ error: "Expense not found" }); return; }
    const expense = existing.rows[0] as Record<string, unknown>;

    if (expense.status !== "pending" && expense.status !== "rejected") {
      res.status(403).json({ error: "Only pending or rejected expenses can be edited" });
      return;
    }
    if (!isWithinWindow(String(expense.expense_date))) {
      res.status(403).json({ error: "Expense date is outside the 7-day window" });
      return;
    }

    const { amount_cents, note, category_id } = req.body as { amount_cents?: number; note?: string; category_id?: string };
    const newStatus = expense.status === "rejected" ? "pending" : expense.status;

    const updated = await query(
      `UPDATE tt_expenses
       SET amount_cents = COALESCE($1, amount_cents),
           note = COALESCE($2, note),
           category_id = COALESCE($3, category_id),
           status = $4,
           rejected_reason = CASE WHEN $4 = 'pending' THEN NULL ELSE rejected_reason END,
           updated_at = now()
       WHERE id = $5 AND worker_id = $6 AND status = $7 RETURNING *`,
      [amount_cents ?? null, note ?? null, category_id ?? null, newStatus, id, worker.id, expense.status]
    );

    if (updated.rows.length === 0) {
      res.status(409).json({ error: "Conflict: expense status changed; please refresh" });
      return;
    }

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "expense_updated",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Worker ${worker.full_name} updated expense ${id}`,
      detail: { expense_id: id, worker_id: worker.id, before: expense, after: updated.rows[0] },
    });

    res.json({ expense: updated.rows[0] });
  } catch (e) {
    console.error("[time] PATCH /api/time/expenses/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/time/expenses/:id
router.delete("/api/time/expenses/:id", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) { res.status(404).json({ error: "Profile not found" }); return; }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) { res.status(404).json({ error: "Worker record not found" }); return; }
    if (!worker.active) { res.status(403).json({ error: "Worker account is deactivated" }); return; }

    const { id } = req.params;
    const existing = await query(`SELECT * FROM tt_expenses WHERE id = $1 AND worker_id = $2`, [id, worker.id]);
    if (existing.rows.length === 0) { res.status(404).json({ error: "Expense not found" }); return; }
    const expense = existing.rows[0] as Record<string, unknown>;

    if (expense.status !== "pending" && expense.status !== "rejected") {
      res.status(403).json({ error: "Only pending or rejected expenses can be deleted" });
      return;
    }
    if (!isWithinWindow(String(expense.expense_date))) {
      res.status(403).json({ error: "Expense date is outside the 7-day window" });
      return;
    }

    const deleted = await query(
      `DELETE FROM tt_expenses WHERE id = $1 AND worker_id = $2 AND status = $3 RETURNING id`,
      [id, worker.id, expense.status]
    );
    if (deleted.rows.length === 0) {
      res.status(409).json({ error: "Conflict: expense status changed; please refresh" });
      return;
    }

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "expense_deleted",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Worker ${worker.full_name} deleted expense ${id}`,
      detail: { expense_id: id, worker_id: worker.id, expense },
    });

    res.json({ success: true });
  } catch (e) {
    console.error("[time] DELETE /api/time/expenses/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/weeks?limit=26 — week summaries with rollups + payment info
router.get("/api/time/weeks", async (req, res) => {
  try {
    const auth = requireWorkerOrAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    if (!profileId) { res.status(404).json({ error: "Profile not found" }); return; }
    const worker = await getWorkerByUserId(profileId);
    if (!worker) { res.status(404).json({ error: "Worker record not found" }); return; }

    const limit = Math.min(Number(req.query.limit ?? 26), 52);

    // date_trunc('week', ...) is ISO 8601: Monday-start. No shifting needed.
    const weeksRes = await query(
      `SELECT
         date_trunc('week', work_date::timestamp)::date AS week_start_raw,
         date_trunc('week', work_date::timestamp)::date AS week_mon
       FROM tt_time_entries WHERE worker_id = $1
       UNION
       SELECT
         date_trunc('week', expense_date::timestamp)::date,
         date_trunc('week', expense_date::timestamp)::date
       FROM tt_expenses WHERE worker_id = $1
       ORDER BY 1 DESC LIMIT $2`,
      [worker.id, limit]
    );

    // Get current week's Monday too
    const currentWeekStart = getWeekStartPT(getTodayPT());

    const weekStarts: string[] = weeksRes.rows.map((r) => {
      const raw = String(r.week_mon ?? r.week_start_raw);
      return raw.slice(0, 10);
    });
    if (!weekStarts.includes(currentWeekStart)) {
      weekStarts.unshift(currentWeekStart);
    }
    // Sort desc
    weekStarts.sort((a, b) => (a < b ? 1 : -1));

    // For each week, get rollups
    const weekDetails = await Promise.all(
      weekStarts.slice(0, limit).map(async (ws) => {
        const we = addDays(ws, 6);
        const [entries, expenses, payment] = await Promise.all([
          query(
            `SELECT status, SUM(hours::numeric) AS hours, SUM(hours::numeric * rate_cents) AS labor_cents
             FROM tt_time_entries WHERE worker_id = $1 AND work_date >= $2 AND work_date <= $3
             GROUP BY status`,
            [worker.id, ws, we]
          ),
          query(
            `SELECT status, SUM(amount_cents) AS amount_cents
             FROM tt_expenses WHERE worker_id = $1 AND expense_date >= $2 AND expense_date <= $3
             GROUP BY status`,
            [worker.id, ws, we]
          ),
          query(
            `SELECT * FROM tt_payments WHERE worker_id = $1 AND week_start = $2`,
            [worker.id, ws]
          ),
        ]);

        const entryByStatus: Record<string, { hours: number; laborCents: number }> = {};
        for (const row of entries.rows as Array<Record<string, unknown>>) {
          entryByStatus[String(row.status)] = {
            hours: parseFloat(String(row.hours ?? 0)),
            laborCents: Math.round(parseFloat(String(row.labor_cents ?? 0))),
          };
        }
        const expByStatus: Record<string, number> = {};
        for (const row of expenses.rows as Array<Record<string, unknown>>) {
          expByStatus[String(row.status)] = parseInt(String(row.amount_cents ?? 0), 10);
        }

        const totalHours = Object.values(entryByStatus).reduce((a, v) => a + v.hours, 0);
        const totalLaborCents = Object.values(entryByStatus).reduce((a, v) => a + v.laborCents, 0);
        const totalExpCents = Object.values(expByStatus).reduce((a, v) => a + v, 0);

        return {
          weekStart: ws,
          weekEnd: we,
          totalHours,
          totalLaborCents,
          totalExpensesCents: totalExpCents,
          totalCents: totalLaborCents + totalExpCents,
          byStatus: entryByStatus,
          expensesByStatus: expByStatus,
          payment: payment.rows[0] ?? null,
        };
      })
    );

    res.json({ weeks: weekDetails });
  } catch (e) {
    console.error("[time] GET /api/time/weeks error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/time/admin/overview?week=YYYY-MM-DD — per-worker week rollups
router.get("/api/time/admin/overview", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;

    const weekParam = String(req.query.week || "");
    const weekStart = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)
      ? getWeekStartPT(weekParam)
      : getWeekStartPT(getTodayPT());
    const weekEnd = addDays(weekStart, 6);

    const workers = await query<WorkerRow>(`SELECT * FROM tt_workers ORDER BY full_name`);

    const overviews = await Promise.all(
      workers.rows.map(async (w) => {
        const [entries, expenses, payment, pendingCount] = await Promise.all([
          query(
            `SELECT status, COUNT(*) AS cnt, SUM(hours::numeric) AS hours, SUM(hours::numeric * rate_cents) AS labor_cents
             FROM tt_time_entries WHERE worker_id = $1 AND work_date >= $2 AND work_date <= $3
             GROUP BY status`,
            [w.id, weekStart, weekEnd]
          ),
          query(
            `SELECT status, COUNT(*) AS cnt, SUM(amount_cents) AS amount_cents
             FROM tt_expenses WHERE worker_id = $1 AND expense_date >= $2 AND expense_date <= $3
             GROUP BY status`,
            [w.id, weekStart, weekEnd]
          ),
          query(`SELECT * FROM tt_payments WHERE worker_id = $1 AND week_start = $2`, [w.id, weekStart]),
          query(
            `SELECT COUNT(*) AS cnt FROM tt_time_entries WHERE worker_id = $1 AND status = 'pending'`,
            [w.id]
          ),
        ]);

        return {
          worker: w,
          weekStart,
          weekEnd,
          entries: entries.rows,
          expenses: expenses.rows,
          payment: payment.rows[0] ?? null,
          totalPendingCount: parseInt(String((pendingCount.rows[0] as Record<string, unknown>)?.cnt ?? 0), 10),
        };
      })
    );

    res.json({ weekStart, weekEnd, workers: overviews });
  } catch (e) {
    console.error("[time] GET /api/time/admin/overview error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/admin/entries?week=YYYY-MM-DD&worker_id=UUID — entries for a worker-week
router.get("/api/time/admin/entries", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;

    const weekParam = String(req.query.week || "");
    const workerId = String(req.query.worker_id || "");
    const weekStart = weekParam && /^\d{4}-\d{2}-\d{2}$/.test(weekParam)
      ? getWeekStartPT(weekParam)
      : getWeekStartPT(getTodayPT());
    const weekEnd = addDays(weekStart, 6);

    if (!workerId) {
      res.status(400).json({ error: "worker_id is required" });
      return;
    }

    const [entries, expenses] = await Promise.all([
      query(
        `SELECT te.*, c.name AS category_name
         FROM tt_time_entries te JOIN tt_categories c ON c.id = te.category_id
         WHERE te.worker_id = $1 AND te.work_date >= $2 AND te.work_date <= $3
         ORDER BY te.work_date, te.created_at`,
        [workerId, weekStart, weekEnd]
      ),
      query(
        `SELECT e.*, c.name AS category_name
         FROM tt_expenses e LEFT JOIN tt_categories c ON c.id = e.category_id
         WHERE e.worker_id = $1 AND e.expense_date >= $2 AND e.expense_date <= $3
         ORDER BY e.expense_date, e.created_at`,
        [workerId, weekStart, weekEnd]
      ),
    ]);

    res.json({ weekStart, weekEnd, entries: entries.rows, expenses: expenses.rows });
  } catch (e) {
    console.error("[time] GET /api/time/admin/entries error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/admin/entries/status — batch approve/reject/unapprove
router.post("/api/time/admin/entries/status", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    const { entry_ids, expense_ids, action, reason } = req.body as {
      entry_ids?: string[];
      expense_ids?: string[];
      action: "approve" | "reject" | "unapprove";
      reason?: string;
    };

    if (!action || !["approve", "reject", "unapprove"].includes(action)) {
      res.status(400).json({ error: "action must be approve, reject, or unapprove" });
      return;
    }
    if (action === "reject" && !reason) {
      res.status(400).json({ error: "reason is required for rejection" });
      return;
    }

    const allEntryIds = entry_ids ?? [];
    const allExpenseIds = expense_ids ?? [];
    if (allEntryIds.length === 0 && allExpenseIds.length === 0) {
      res.status(400).json({ error: "At least one entry_id or expense_id required" });
      return;
    }

    const now = new Date().toISOString();
    let entriesUpdated = 0;
    let expensesUpdated = 0;

    // All mutations in a single transaction so entries + expenses are all-or-none on conflict
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (allEntryIds.length > 0) {
        let newStatus: string;
        let fromStatus: string;
        if (action === "approve") { newStatus = "approved"; fromStatus = "pending"; }
        else if (action === "reject") { newStatus = "rejected"; fromStatus = "pending"; }
        else { newStatus = "pending"; fromStatus = "approved"; }

        const upd = await client.query(
          `UPDATE tt_time_entries
           SET status = $1,
               rejected_reason = CASE WHEN $1 = 'rejected' THEN $2 ELSE NULL END,
               approved_at = CASE WHEN $1 = 'approved' THEN $3 ELSE NULL END,
               approved_by = CASE WHEN $1 = 'approved' THEN $4 ELSE NULL END,
               updated_at = $3
           WHERE id = ANY($5::uuid[]) AND status = $6
           RETURNING id`,
          [newStatus, reason ?? null, now, profileId, allEntryIds, fromStatus]
        );
        entriesUpdated = upd.rows.length;
        if (entriesUpdated < allEntryIds.length) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "Some entries had an unexpected status; refresh and try again", updated: entriesUpdated });
          return;
        }
      }

      if (allExpenseIds.length > 0) {
        let newStatus: string;
        let fromStatus: string;
        if (action === "approve") { newStatus = "approved"; fromStatus = "pending"; }
        else if (action === "reject") { newStatus = "rejected"; fromStatus = "pending"; }
        else { newStatus = "pending"; fromStatus = "approved"; }

        const upd = await client.query(
          `UPDATE tt_expenses
           SET status = $1,
               rejected_reason = CASE WHEN $1 = 'rejected' THEN $2 ELSE NULL END,
               approved_at = CASE WHEN $1 = 'approved' THEN $3 ELSE NULL END,
               approved_by = CASE WHEN $1 = 'approved' THEN $4 ELSE NULL END,
               updated_at = $3
           WHERE id = ANY($5::uuid[]) AND status = $6
           RETURNING id`,
          [newStatus, reason ?? null, now, profileId, allExpenseIds, fromStatus]
        );
        expensesUpdated = upd.rows.length;
        if (expensesUpdated < allExpenseIds.length) {
          await client.query("ROLLBACK");
          res.status(409).json({ error: "Some expenses had an unexpected status; refresh and try again", updated: expensesUpdated });
          return;
        }
      }

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: `entries_${action}`,
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin ${action}d ${entriesUpdated} entries and ${expensesUpdated} expenses`,
      detail: { action, entry_ids: allEntryIds, expense_ids: allExpenseIds, reason },
    });

    res.json({ success: true, entriesUpdated, expensesUpdated });
  } catch (e) {
    console.error("[time] POST /api/time/admin/entries/status error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/admin/entries — admin creates/corrects entry on behalf of worker (window-exempt)
router.post("/api/time/admin/entries", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    const { worker_id, work_date, category_id, hours, note, is_adjustment } = req.body as {
      worker_id: string;
      work_date: string;
      category_id: string;
      hours: number;
      note?: string;
      is_adjustment?: boolean;
    };

    if (!worker_id || !work_date || !category_id || hours === undefined) {
      res.status(400).json({ error: "worker_id, work_date, category_id, hours required" });
      return;
    }

    const hoursNum = Number(hours);
    if (isNaN(hoursNum) || hoursNum <= 0) {
      res.status(400).json({ error: "hours must be a positive number" });
      return;
    }
    if (hoursNum > 24) {
      res.status(400).json({ error: "hours cannot exceed 24 per entry" });
      return;
    }
    if (Math.round(hoursNum * 4) !== hoursNum * 4) {
      res.status(400).json({ error: "hours must be in 0.25 increments" });
      return;
    }

    // Enforce 24h daily cap across all entries for that worker+date (admin included)
    const dailyTotalRes = await query<{ total: string }>(
      `SELECT COALESCE(SUM(hours::numeric), 0) AS total
       FROM tt_time_entries WHERE worker_id = $1 AND work_date = $2`,
      [worker_id, work_date]
    );
    const dailyTotal = parseFloat(dailyTotalRes.rows[0]?.total ?? "0");
    if (dailyTotal + hoursNum > 24) {
      res.status(400).json({ error: `Adding ${hoursNum}h would exceed the 24h daily cap (${dailyTotal}h already logged)` });
      return;
    }

    // Verify category exists and is active
    const catCheck = await query<{ id: string }>(
      `SELECT id FROM tt_categories WHERE id = $1 AND active = true`,
      [category_id]
    );
    if (catCheck.rows.length === 0) {
      res.status(400).json({ error: "Category not found or inactive" });
      return;
    }

    const rateCents = await snapshotRate(worker_id, work_date);
    if (rateCents === null) {
      res.status(400).json({ error: "No rate defined for worker on that date" });
      return;
    }

    const result = await query(
      `INSERT INTO tt_time_entries (worker_id, work_date, category_id, hours, note, rate_cents, is_adjustment, created_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
      [worker_id, work_date, category_id, hoursNum, note ?? null, rateCents, is_adjustment ?? false, profileId]
    );

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "admin_entry_created",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin created entry on behalf of worker ${worker_id}: ${hoursNum}h on ${work_date}${is_adjustment ? " (adjustment)" : ""}`,
      detail: { entry_id: result.rows[0].id, worker_id, hours: hoursNum, work_date, is_adjustment },
    });

    res.status(201).json({ entry: result.rows[0] });
  } catch (e) {
    console.error("[time] POST /api/time/admin/entries error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/admin/payments/preview?worker_id=UUID&week=YYYY-MM-DD
router.get("/api/time/admin/payments/preview", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;

    const workerId = String(req.query.worker_id || "");
    const weekParam = String(req.query.week || "");
    if (!workerId || !weekParam) {
      res.status(400).json({ error: "worker_id and week required" });
      return;
    }
    const weekStart = getWeekStartPT(weekParam);
    const weekEnd = addDays(weekStart, 6);

    const worker = await query<WorkerRow>(`SELECT * FROM tt_workers WHERE id = $1`, [workerId]);
    if (worker.rows.length === 0) { res.status(404).json({ error: "Worker not found" }); return; }

    // Check this week has no pending items
    const pendingCheck = await query(
      `SELECT COUNT(*) AS cnt FROM tt_time_entries
       WHERE worker_id = $1 AND work_date >= $2 AND work_date <= $3 AND status = 'pending'`,
      [workerId, weekStart, weekEnd]
    );
    const pendingExpCheck = await query(
      `SELECT COUNT(*) AS cnt FROM tt_expenses
       WHERE worker_id = $1 AND expense_date >= $2 AND expense_date <= $3 AND status = 'pending'`,
      [workerId, weekStart, weekEnd]
    );
    const pendingCount = parseInt(String((pendingCheck.rows[0] as Record<string, unknown>).cnt), 10) +
      parseInt(String((pendingExpCheck.rows[0] as Record<string, unknown>).cnt), 10);

    // Approved entries in this week
    const entries = await query(
      `SELECT * FROM tt_time_entries WHERE worker_id = $1 AND work_date >= $2 AND work_date <= $3 AND status = 'approved'`,
      [workerId, weekStart, weekEnd]
    );
    // Prior unpaid approved entries (from earlier weeks)
    const priorEntries = await query(
      `SELECT * FROM tt_time_entries WHERE worker_id = $1 AND work_date < $2 AND status = 'approved' AND payment_id IS NULL`,
      [workerId, weekStart]
    );
    const expensesThis = await query(
      `SELECT * FROM tt_expenses WHERE worker_id = $1 AND expense_date >= $2 AND expense_date <= $3 AND status = 'approved'`,
      [workerId, weekStart, weekEnd]
    );
    const priorExpenses = await query(
      `SELECT * FROM tt_expenses WHERE worker_id = $1 AND expense_date < $2 AND status = 'approved' AND payment_id IS NULL`,
      [workerId, weekStart]
    );

    const allEntries = [...entries.rows, ...priorEntries.rows] as Array<Record<string, unknown>>;
    const allExpenses = [...expensesThis.rows, ...priorExpenses.rows] as Array<Record<string, unknown>>;

    const hoursTotal = allEntries.reduce((sum, e) => sum + parseFloat(String(e.hours ?? 0)), 0);
    const laborCents = Math.round(allEntries.reduce((sum, e) => sum + parseFloat(String(e.hours ?? 0)) * parseInt(String(e.rate_cents ?? 0), 10), 0));
    const expensesCents = allExpenses.reduce((sum, e) => sum + parseInt(String(e.amount_cents ?? 0), 10), 0);

    const existingPayment = await query(
      `SELECT * FROM tt_payments WHERE worker_id = $1 AND week_start = $2`,
      [workerId, weekStart]
    );

    res.json({
      worker: worker.rows[0],
      weekStart,
      weekEnd,
      pendingCount,
      canPay: pendingCount === 0 && allEntries.length > 0,
      hoursTotal,
      laborCents,
      expensesCents,
      totalCents: laborCents + expensesCents,
      entries: allEntries,
      priorEntries: priorEntries.rows,
      expenses: allExpenses,
      priorExpenses: priorExpenses.rows,
      existingPayment: existingPayment.rows[0] ?? null,
      suggestedMemo: `Janus T&M — week of ${weekStart} — ${worker.rows[0].full_name}`,
    });
  } catch (e) {
    console.error("[time] GET /api/time/admin/payments/preview error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/admin/payments — create payment (atomic: insert + stamp entries)
router.post("/api/time/admin/payments", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    const { worker_id, week_start, confirmation_ref, note } = req.body as {
      worker_id: string;
      week_start: string;
      confirmation_ref?: string;
      note?: string;
    };

    if (!worker_id || !week_start) {
      res.status(400).json({ error: "worker_id and week_start required" });
      return;
    }

    const weekStart = getWeekStartPT(week_start);
    const weekEnd = addDays(weekStart, 6);

    // Begin atomic transaction on a pinned client connection
    const client = await pool.connect();
    let payment: Record<string, unknown> | null = null;
    let totalCents = 0;
    let payId: unknown = null;
    try {
      await client.query("BEGIN");

      // Check for pending items (must be zero)
      const pendingCheck = await client.query(
        `SELECT COUNT(*) AS cnt FROM tt_time_entries
         WHERE worker_id = $1 AND work_date >= $2 AND work_date <= $3 AND status = 'pending'`,
        [worker_id, weekStart, weekEnd]
      );
      const pendingExpCheck = await client.query(
        `SELECT COUNT(*) AS cnt FROM tt_expenses
         WHERE worker_id = $1 AND expense_date >= $2 AND expense_date <= $3 AND status = 'pending'`,
        [worker_id, weekStart, weekEnd]
      );
      const pendingCount = parseInt(String((pendingCheck.rows[0] as Record<string, unknown>).cnt), 10) +
        parseInt(String((pendingExpCheck.rows[0] as Record<string, unknown>).cnt), 10);

      if (pendingCount > 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Cannot pay: pending items exist for this worker-week" });
        return;
      }

      // Collect all approved entries (this week + prior unpaid) — FOR UPDATE locks rows
      const entries = await client.query(
        `SELECT id, hours, rate_cents FROM tt_time_entries
         WHERE worker_id = $1 AND work_date >= $2 AND work_date <= $3 AND status = 'approved'
         FOR UPDATE`,
        [worker_id, weekStart, weekEnd]
      );
      const priorEntries = await client.query(
        `SELECT id, hours, rate_cents FROM tt_time_entries
         WHERE worker_id = $1 AND work_date < $2 AND status = 'approved' AND payment_id IS NULL
         FOR UPDATE`,
        [worker_id, weekStart]
      );
      const expenses = await client.query(
        `SELECT id, amount_cents FROM tt_expenses
         WHERE worker_id = $1 AND expense_date >= $2 AND expense_date <= $3 AND status = 'approved'
         FOR UPDATE`,
        [worker_id, weekStart, weekEnd]
      );
      const priorExpenses = await client.query(
        `SELECT id, amount_cents FROM tt_expenses
         WHERE worker_id = $1 AND expense_date < $2 AND status = 'approved' AND payment_id IS NULL
         FOR UPDATE`,
        [worker_id, weekStart]
      );

      const allEntries = [...entries.rows, ...priorEntries.rows] as Array<Record<string, unknown>>;
      const allExpenses = [...expenses.rows, ...priorExpenses.rows] as Array<Record<string, unknown>>;

      if (allEntries.length === 0) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "No approved entries to pay" });
        return;
      }

      const hoursTotal = allEntries.reduce((s, e) => s + parseFloat(String(e.hours ?? 0)), 0);
      const laborCents = Math.round(allEntries.reduce((s, e) => s + parseFloat(String(e.hours ?? 0)) * parseInt(String(e.rate_cents ?? 0), 10), 0));
      const expensesCents = allExpenses.reduce((s, e) => s + parseInt(String(e.amount_cents ?? 0), 10), 0);
      totalCents = laborCents + expensesCents;

      // Insert payment record
      const payRes = await client.query(
        `INSERT INTO tt_payments (worker_id, week_start, hours_total, labor_cents, expenses_cents, total_cents, confirmation_ref, note, paid_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (worker_id, week_start) DO NOTHING
         RETURNING *`,
        [worker_id, weekStart, hoursTotal, laborCents, expensesCents, totalCents, confirmation_ref ?? null, note ?? null, profileId]
      );

      if (payRes.rows.length === 0) {
        await client.query("ROLLBACK");
        res.status(409).json({ error: "Payment already exists for this worker-week" });
        return;
      }

      payment = payRes.rows[0] as Record<string, unknown>;
      payId = payment.id;

      // Stamp entries and expenses to paid in the same transaction
      if (allEntries.length > 0) {
        const entryIds = allEntries.map((e) => String(e.id));
        await client.query(
          `UPDATE tt_time_entries SET status = 'paid', payment_id = $1, updated_at = now()
           WHERE id = ANY($2::uuid[]) AND status = 'approved'`,
          [payId, entryIds]
        );
      }
      if (allExpenses.length > 0) {
        const expIds = allExpenses.map((e) => String(e.id));
        await client.query(
          `UPDATE tt_expenses SET status = 'paid', payment_id = $1, updated_at = now()
           WHERE id = ANY($2::uuid[]) AND status = 'approved'`,
          [payId, expIds]
        );
      }

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "payment_created",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin marked week ${weekStart} paid for worker ${worker_id}: $${(totalCents / 100).toFixed(2)}`,
      detail: { payment_id: payId, worker_id, week_start: weekStart, total_cents: totalCents, confirmation_ref },
    });

    // Send immediate payment email (async, don't block response)
    if (payment) sendPaymentEmail(worker_id, payment).catch((e) => console.error("[time] Payment email error:", e));

    res.status(201).json({ payment });
  } catch (e) {
    console.error("[time] POST /api/time/admin/payments error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/admin/reports
router.get("/api/time/admin/reports", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;

    const { period = "week", start, end, worker_id, category_id } = req.query as {
      period?: string;
      start?: string;
      end?: string;
      worker_id?: string;
      category_id?: string;
    };

    // Compute period bounds in PT
    let periodStart: string;
    let periodEnd: string;

    if (start && end) {
      periodStart = start;
      periodEnd = end;
    } else {
      const today = getTodayPT();
      if (period === "week") {
        periodStart = getWeekStartPT(today);
        periodEnd = addDays(periodStart, 6);
      } else if (period === "month") {
        const [y, m] = today.split("-").map(Number);
        periodStart = `${y}-${String(m).padStart(2, "0")}-01`;
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        periodEnd = `${y}-${String(m).padStart(2, "0")}-${lastDay}`;
      } else if (period === "quarter") {
        const [y, m] = today.split("-").map(Number);
        const qStart = Math.floor((m - 1) / 3) * 3 + 1;
        periodStart = `${y}-${String(qStart).padStart(2, "0")}-01`;
        const qEndMonth = qStart + 2;
        const lastDay = new Date(Date.UTC(y, qEndMonth, 0)).getUTCDate();
        periodEnd = `${y}-${String(qEndMonth).padStart(2, "0")}-${lastDay}`;
      } else {
        const [y] = today.split("-").map(Number);
        periodStart = `${y}-01-01`;
        periodEnd = `${y}-12-31`;
      }
    }

    // Build parameterized filter clauses — never interpolate user-supplied IDs
    const baseParams: unknown[] = [periodStart, periodEnd];
    let workerParamIdx = 0;
    let catParamIdx = 0;
    if (worker_id) { baseParams.push(worker_id); workerParamIdx = baseParams.length; }
    if (category_id) { baseParams.push(category_id); catParamIdx = baseParams.length; }
    const workerFilter = workerParamIdx ? `AND te.worker_id = $${workerParamIdx}` : "";
    const catFilter = catParamIdx ? `AND te.category_id = $${catParamIdx}` : "";

    const [headlines, byWorker, byCategory, weeklyChart] = await Promise.all([
      // Headline cards
      query(
        `SELECT status,
          COUNT(*) AS entry_count,
          SUM(hours::numeric) AS hours,
          SUM(hours::numeric * rate_cents) AS labor_cents
         FROM tt_time_entries te
         WHERE te.work_date >= $1 AND te.work_date <= $2 ${workerFilter} ${catFilter}
         GROUP BY status`,
        baseParams
      ),
      // By worker pivot (no workerFilter — this groups by worker)
      query(
        `SELECT w.id, w.full_name, te.status,
          SUM(te.hours::numeric) AS hours,
          SUM(te.hours::numeric * te.rate_cents) AS labor_cents,
          COUNT(te.id) AS entry_count
         FROM tt_time_entries te
         JOIN tt_workers w ON w.id = te.worker_id
         WHERE te.work_date >= $1 AND te.work_date <= $2 ${catFilter}
         GROUP BY w.id, w.full_name, te.status
         ORDER BY w.full_name`,
        baseParams
      ),
      // By category pivot (no catFilter — this groups by category)
      query(
        `SELECT c.id, c.name, te.status,
          SUM(te.hours::numeric) AS hours,
          SUM(te.hours::numeric * te.rate_cents) AS labor_cents,
          COUNT(te.id) AS entry_count
         FROM tt_time_entries te
         JOIN tt_categories c ON c.id = te.category_id
         WHERE te.work_date >= $1 AND te.work_date <= $2 ${workerFilter}
         GROUP BY c.id, c.name, te.status
         ORDER BY c.name`,
        baseParams
      ),
      // Weekly chart: $ per week by status
      query(
        `SELECT date_trunc('week', work_date::timestamp)::date AS week_start,
          status,
          SUM(hours::numeric * rate_cents) AS labor_cents
         FROM tt_time_entries te
         WHERE te.work_date >= $1 AND te.work_date <= $2 ${workerFilter} ${catFilter}
         GROUP BY week_start, status
         ORDER BY week_start`,
        baseParams
      ),
    ]);

    // Expense headlines — parameterized worker filter
    const expParams: unknown[] = [periodStart, periodEnd];
    const expWorkerClause = worker_id ? `AND worker_id = $${expParams.push(worker_id)}` : "";
    const expHeadlines = await query(
      `SELECT status, SUM(amount_cents) AS amount_cents
       FROM tt_expenses WHERE expense_date >= $1 AND expense_date <= $2
       ${expWorkerClause}
       GROUP BY status`,
      expParams
    );

    res.json({
      periodStart,
      periodEnd,
      period,
      headlines: headlines.rows,
      expenseHeadlines: expHeadlines.rows,
      byWorker: byWorker.rows,
      byCategory: byCategory.rows,
      weeklyChart: weeklyChart.rows,
    });
  } catch (e) {
    console.error("[time] GET /api/time/admin/reports error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/admin/reports/export.xlsx
router.get("/api/time/admin/reports/export.xlsx", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;

    const { start, end, worker_id } = req.query as { start?: string; end?: string; worker_id?: string };
    const today = getTodayPT();
    const periodStart = start ?? getWeekStartPT(today);
    const periodEnd = end ?? addDays(getWeekStartPT(today), 6);

    const entryParams: unknown[] = [periodStart, periodEnd];
    const entryWorkerClause = worker_id ? `AND te.worker_id = $${entryParams.push(worker_id)}` : "";

    const entries = await query(
      `SELECT te.*, w.full_name AS worker_name, w.email AS worker_email,
         c.name AS category_name
       FROM tt_time_entries te
       JOIN tt_workers w ON w.id = te.worker_id
       JOIN tt_categories c ON c.id = te.category_id
       WHERE te.work_date >= $1 AND te.work_date <= $2 ${entryWorkerClause}
       ORDER BY te.work_date, w.full_name`,
      entryParams
    );

    const expExportParams: unknown[] = [periodStart, periodEnd];
    const expExportWorkerClause = worker_id ? `AND e.worker_id = $${expExportParams.push(worker_id)}` : "";

    const expenses = await query(
      `SELECT e.*, w.full_name AS worker_name, w.email AS worker_email,
         c.name AS category_name
       FROM tt_expenses e
       JOIN tt_workers w ON w.id = e.worker_id
       LEFT JOIN tt_categories c ON c.id = e.category_id
       WHERE e.expense_date >= $1 AND e.expense_date <= $2 ${expExportWorkerClause}
       ORDER BY e.expense_date, w.full_name`,
      expExportParams
    );

    const workbook = new ExcelJS.Workbook();

    const sheet1 = workbook.addWorksheet("Time Entries");
    sheet1.addRow(["Date", "Worker", "Email", "Category", "Hours", "Rate ($/hr)", "Amount ($)", "Status", "Note", "Adjustment"]);
    for (const row of entries.rows as Array<Record<string, unknown>>) {
      const hours = parseFloat(String(row.hours ?? 0));
      const rate = parseInt(String(row.rate_cents ?? 0), 10) / 100;
      sheet1.addRow([
        row.work_date, row.worker_name, row.worker_email,
        row.category_name, hours, rate, (hours * rate).toFixed(2),
        row.status, row.note ?? "", row.is_adjustment ? "Yes" : "No",
      ]);
    }

    const sheet2 = workbook.addWorksheet("Expenses");
    sheet2.addRow(["Date", "Worker", "Email", "Category", "Amount ($)", "Status", "Note"]);
    for (const row of expenses.rows as Array<Record<string, unknown>>) {
      sheet2.addRow([
        row.expense_date, row.worker_name, row.worker_email,
        row.category_name ?? "", (parseInt(String(row.amount_cents ?? 0), 10) / 100).toFixed(2),
        row.status, row.note,
      ]);
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="janus-time-${periodStart}-to-${periodEnd}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error("[time] GET /api/time/admin/reports/export.xlsx error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Admin: Workers CRUD ────────────────────────────────────────────────────

// GET /api/time/admin/workers
router.get("/api/time/admin/workers", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;

    const workers = await query(
      `SELECT w.*,
         (SELECT hourly_rate_cents FROM tt_rate_history WHERE worker_id = w.id ORDER BY effective_from DESC LIMIT 1) AS current_rate_cents,
         (SELECT SUM(te.hours::numeric * te.rate_cents) FROM tt_time_entries te WHERE te.worker_id = w.id AND te.status = 'approved' AND te.payment_id IS NULL) AS unpaid_labor_cents,
         (SELECT SUM(e.amount_cents) FROM tt_expenses e WHERE e.worker_id = w.id AND e.status = 'approved' AND e.payment_id IS NULL) AS unpaid_expense_cents
       FROM tt_workers w ORDER BY w.full_name`
    );

    const workersWithCats = await Promise.all(
      (workers.rows as Array<Record<string, unknown>>).map(async (w) => {
        const cats = await query(
          `SELECT c.id, c.name FROM tt_categories c
           JOIN tt_worker_categories wc ON wc.category_id = c.id
           WHERE wc.worker_id = $1 AND c.active = true ORDER BY c.name`,
          [w.id]
        );
        return { ...w, categories: cats.rows };
      })
    );

    res.json({ workers: workersWithCats });
  } catch (e) {
    console.error("[time] GET /api/time/admin/workers error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/admin/workers — add worker
router.post("/api/time/admin/workers", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    const {
      full_name, email, mobile, zelle_handle, can_add_expenses,
      category_ids, default_category_id, hourly_rate_cents, effective_from,
    } = req.body as {
      full_name: string;
      email: string;
      mobile?: string;
      zelle_handle?: string;
      can_add_expenses?: boolean;
      category_ids?: string[];
      default_category_id?: string;
      hourly_rate_cents: number;
      effective_from?: string;
    };

    if (!full_name || !email || !hourly_rate_cents) {
      res.status(400).json({ error: "full_name, email, hourly_rate_cents required" });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Guard: reject household emails from becoming workers.
    // Two-pass check:
    // 1. invited_emails — catches users not yet signed up + seed-reinserted household rows
    // 2. google_tokens — catches users who signed up (handleNewUser deletes their invite row)
    const existingInvite = await query(
      `SELECT role FROM invited_emails WHERE email = $1`,
      [normalizedEmail]
    );
    if (existingInvite.rows.length > 0) {
      const inviteRow = existingInvite.rows[0] as Record<string, unknown>;
      if (inviteRow.role !== "worker") {
        res.status(400).json({ error: "This email is already a household member. Cannot add as worker." });
        return;
      }
    }
    // Also check google_tokens for users who have already signed in (their invite row may have been removed)
    const existingGoogleToken = await query(
      `SELECT 1 FROM google_tokens WHERE lower(google_email) = $1 LIMIT 1`,
      [normalizedEmail]
    );
    if (existingGoogleToken.rows.length > 0) {
      res.status(400).json({ error: "This email belongs to an existing household member. Cannot add as worker." });
      return;
    }

    // Check existing worker
    const existingWorker = await query(`SELECT id FROM tt_workers WHERE email = $1`, [normalizedEmail]);
    if (existingWorker.rows.length > 0) {
      res.status(409).json({ error: "Worker with this email already exists" });
      return;
    }

    const today = getTodayPT();
    const rateFrom = effective_from || today;

    // Insert worker
    const workerRes = await query(
      `INSERT INTO tt_workers (full_name, email, mobile, zelle_handle, can_add_expenses, default_category_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [full_name, normalizedEmail, mobile ?? null, zelle_handle ?? null, can_add_expenses ?? false, default_category_id ?? null, profileId]
    );
    const worker = workerRes.rows[0] as Record<string, unknown>;

    // Insert rate history
    await query(
      `INSERT INTO tt_rate_history (worker_id, hourly_rate_cents, effective_from, created_by)
       VALUES ($1, $2, $3, $4)`,
      [worker.id, hourly_rate_cents, rateFrom, profileId]
    );

    // Assign categories
    if (category_ids && category_ids.length > 0) {
      for (const catId of category_ids) {
        await query(
          `INSERT INTO tt_worker_categories (worker_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [worker.id, catId]
        );
      }
    }

    // Add to invited_emails with role='worker'
    await query(
      `INSERT INTO invited_emails (email, invited_by, role)
       VALUES ($1, $2, 'worker')
       ON CONFLICT DO NOTHING`,
      [normalizedEmail, user.email]
    );

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "worker_created",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin created worker ${full_name} (${normalizedEmail})`,
      detail: { worker_id: worker.id, email: normalizedEmail, hourly_rate_cents, category_ids },
    });

    // Send welcome email (async)
    sendWelcomeEmail(worker, hourly_rate_cents, category_ids ?? []).catch((e) => console.error("[time] Welcome email error:", e));

    res.status(201).json({ worker });
  } catch (e) {
    console.error("[time] POST /api/time/admin/workers error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/time/admin/workers/:id
router.patch("/api/time/admin/workers/:id", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const profileId = await getProfileId(user.userId);
    const { id } = req.params;
    const { full_name, mobile, zelle_handle, can_add_expenses, default_category_id, category_ids } = req.body as {
      full_name?: string;
      mobile?: string;
      zelle_handle?: string;
      can_add_expenses?: boolean;
      default_category_id?: string;
      category_ids?: string[];
    };

    const updated = await query(
      `UPDATE tt_workers SET
         full_name = COALESCE($1, full_name),
         mobile = COALESCE($2, mobile),
         zelle_handle = COALESCE($3, zelle_handle),
         can_add_expenses = COALESCE($4, can_add_expenses),
         default_category_id = COALESCE($5, default_category_id),
         updated_at = now()
       WHERE id = $6 RETURNING *`,
      [full_name ?? null, mobile ?? null, zelle_handle ?? null, can_add_expenses ?? null, default_category_id ?? null, id]
    );

    if (updated.rows.length === 0) { res.status(404).json({ error: "Worker not found" }); return; }

    if (category_ids !== undefined) {
      await query(`DELETE FROM tt_worker_categories WHERE worker_id = $1`, [id]);
      for (const catId of category_ids) {
        await query(`INSERT INTO tt_worker_categories (worker_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, catId]);
      }
    }

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "worker_updated",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin updated worker ${id}`,
      detail: { worker_id: id, updated_by: profileId },
    });

    res.json({ worker: updated.rows[0] });
  } catch (e) {
    console.error("[time] PATCH /api/time/admin/workers/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/admin/workers/:id/activate — activate/deactivate
router.post("/api/time/admin/workers/:id/activate", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;

    const { id } = req.params;
    const { active } = req.body as { active: boolean };

    const updated = await query(
      `UPDATE tt_workers SET active = $1, deactivated_at = CASE WHEN $1 = false THEN now() ELSE NULL END, updated_at = now()
       WHERE id = $2 RETURNING *`,
      [active, id]
    );
    if (updated.rows.length === 0) { res.status(404).json({ error: "Worker not found" }); return; }

    const worker = updated.rows[0] as Record<string, unknown>;

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: active ? "worker_activated" : "worker_deactivated",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin ${active ? "activated" : "deactivated"} worker ${worker.full_name}`,
      detail: { worker_id: id, active },
    });

    // Send notification email (async)
    sendActivationEmail(worker, active).catch((e) => console.error("[time] Activation email error:", e));

    res.json({ worker });
  } catch (e) {
    console.error("[time] POST /api/time/admin/workers/:id/activate error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/time/admin/workers/:id/rate-history
router.get("/api/time/admin/workers/:id/rate-history", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const rates = await query(
      `SELECT * FROM tt_rate_history WHERE worker_id = $1 ORDER BY effective_from DESC`,
      [req.params.id]
    );
    res.json({ rates: rates.rows });
  } catch (e) {
    console.error("[time] GET rate-history error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/admin/workers/:id/rate — add new rate
router.post("/api/time/admin/workers/:id/rate", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;
    const profileId = await getProfileId(user.userId);

    const { id } = req.params;
    const { hourly_rate_cents, effective_from } = req.body as { hourly_rate_cents: number; effective_from: string };

    if (!hourly_rate_cents || !effective_from) {
      res.status(400).json({ error: "hourly_rate_cents and effective_from required" });
      return;
    }

    const result = await query(
      `INSERT INTO tt_rate_history (worker_id, hourly_rate_cents, effective_from, created_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (worker_id, effective_from) DO UPDATE SET hourly_rate_cents = EXCLUDED.hourly_rate_cents
       RETURNING *`,
      [id, hourly_rate_cents, effective_from, profileId]
    );

    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "rate_updated",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin set rate for worker ${id}: $${(hourly_rate_cents / 100).toFixed(2)}/hr effective ${effective_from}`,
      detail: { worker_id: id, hourly_rate_cents, effective_from },
    });

    res.status(201).json({ rate: result.rows[0] });
  } catch (e) {
    console.error("[time] POST /api/time/admin/workers/:id/rate error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Admin: Categories CRUD ─────────────────────────────────────────────────

// GET /api/time/admin/categories
router.get("/api/time/admin/categories", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const cats = await query(`SELECT * FROM tt_categories ORDER BY sort_order, name`);
    res.json({ categories: cats.rows });
  } catch (e) {
    console.error("[time] GET /api/time/admin/categories error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Also expose categories to workers (for the time entry form)
router.get("/api/time/categories", async (_req, res) => {
  try {
    const cats = await query(`SELECT * FROM tt_categories WHERE active = true ORDER BY sort_order, name`);
    res.json({ categories: cats.rows });
  } catch (e) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/time/admin/categories
router.post("/api/time/admin/categories", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;
    const { name, sort_order } = req.body as { name: string; sort_order?: number };
    if (!name) { res.status(400).json({ error: "name required" }); return; }
    const result = await query(
      `INSERT INTO tt_categories (name, sort_order) VALUES ($1, $2) RETURNING *`,
      [name, sort_order ?? 0]
    );
    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "category_created",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin created time category "${name}"`,
      detail: { category: result.rows[0] },
    });
    res.status(201).json({ category: result.rows[0] });
  } catch (e) {
    console.error("[time] POST /api/time/admin/categories error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/time/admin/categories/:id
router.patch("/api/time/admin/categories/:id", async (req, res) => {
  try {
    const auth = requireTimeAdmin(req, res);
    if (!auth) return;
    const { user } = auth;
    const { id } = req.params;
    const { name, active, sort_order } = req.body as { name?: string; active?: boolean; sort_order?: number };
    const updated = await query(
      `UPDATE tt_categories SET name = COALESCE($1, name), active = COALESCE($2, active), sort_order = COALESCE($3, sort_order)
       WHERE id = $4 RETURNING *`,
      [name ?? null, active ?? null, sort_order ?? null, id]
    );
    if (updated.rows.length === 0) { res.status(404).json({ error: "Category not found" }); return; }
    await logAudit("time-tracking", {
      category: "time_tracking", event_type: "category_updated",
      actor_id: user.userId, actor_name: user.displayName ?? user.email,
      summary: `Admin updated time category ${id}`,
      detail: { category: updated.rows[0] },
    });
    res.json({ category: updated.rows[0] });
  } catch (e) {
    console.error("[time] PATCH /api/time/admin/categories/:id error:", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CRON / NOTIFICATION ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Vacation-mode guard: each time-tracking cron is backed by a family_automations
// row (seeded in migrations/0051) so the Automations UI can pause/resume it.
// Returns the automation row (or null if the row is missing — run anyway).
async function getTimeAutomation(name: string): Promise<AutomationStatusRow | null> {
  try {
    const { rows } = await query<AutomationStatusRow>(
      `SELECT id, is_active FROM family_automations WHERE name = $1 LIMIT 1`, [name]
    );
    return rows[0] ?? null;
  } catch { return null; }
}

async function markTimeAutomationRan(id: string): Promise<void> {
  try { await query(`UPDATE family_automations SET last_run_at = NOW() WHERE id = $1`, [id]); } catch { /* non-fatal */ }
}

function auditTimeCron(edgeFunction: string, eventType: string, summary: string, status: string, t0: number, detail?: Record<string, unknown>): void {
  void logAudit(edgeFunction, {
    category: "time_tracking", event_type: eventType, severity: status === "error" ? "error" : "info",
    actor_id: "system", actor_name: "Cron", channel: "cron",
    summary, status, duration_ms: Date.now() - t0,
    ...(detail ? { detail } : {}),
  }).catch(() => { /* audit best-effort */ });
}

// POST /api/time/cron/worker-digest — worker 6 PM PT digest
router.post("/api/time/cron/worker-digest", async (req, res) => {
  const t0 = Date.now();
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isAdmin = cronSecret && req.headers["x-cron-secret"] === cronSecret;
    if (!isAdmin) {
      const auth = requireTimeAdmin(req, res);
      if (!auth) return;
    }
    const automation = await getTimeAutomation("Time Worker Daily Digest");
    if (automation && !automation.is_active) {
      auditTimeCron("time-worker-digest", "worker_digest_skipped", "Worker daily digest skipped: paused in Automations", "skipped", t0);
      res.json({ skipped: true, reason: "automation_paused" });
      return;
    }
    if (automation) await markTimeAutomationRan(automation.id);
    const { getSaKey } = await import("../lib/helpers.js");
    let saKey: import("../lib/helpers.js").ServiceAccountKey | null = null;
    try { saKey = getSaKey(); } catch { saKey = null; }
    if (!saKey) {
      auditTimeCron("time-worker-digest", "worker_digest_skipped", "Worker daily digest skipped: no service account key", "skipped", t0);
      res.json({ skipped: true, reason: "no_service_account_key" });
      return;
    }

    const today = getTodayPT();
    const yesterday = addDays(today, -1);

    // Find all workers with status changes today
    const changes = await query(
      `SELECT DISTINCT te.worker_id FROM tt_time_entries te
       WHERE (te.approved_at::date = $1 OR te.updated_at::date = $1)
         AND te.status IN ('approved', 'rejected')`,
      [today]
    );

    let sent = 0;
    for (const row of changes.rows as Array<Record<string, unknown>>) {
      const worker = await query<WorkerRow>(`SELECT * FROM tt_workers WHERE id = $1`, [row.worker_id as string]);
      if (!worker.rows[0]) continue;
      const w = worker.rows[0];

      const entries = await query(
        `SELECT te.*, c.name AS category_name FROM tt_time_entries te
         JOIN tt_categories c ON c.id = te.category_id
         WHERE te.worker_id = $1 AND (te.approved_at::date = $2 OR (te.status = 'rejected' AND te.updated_at::date = $2))
           AND te.status IN ('approved', 'rejected')
         ORDER BY te.work_date`,
        [w.id, today]
      );

      if (entries.rows.length === 0) continue;

      const rows = (entries.rows as Array<Record<string, unknown>>)
        .map((e) => `<tr><td>${e.work_date}</td><td>${e.category_name}</td><td>${e.hours}h</td><td>${e.status}</td><td>${e.rejected_reason ?? ""}</td></tr>`)
        .join("");

      const html = `<h2>Janus Time — Daily Status Update</h2>
<p>Here's a summary of your time entry status changes for ${today}:</p>
<table border="1" cellpadding="6"><tr><th>Date</th><th>Category</th><th>Hours</th><th>Status</th><th>Note</th></tr>${rows}</table>
<p>View your full history at <a href="https://example.com/time">example.com/time</a></p>`;

      const { sendGmailRaw, logEmail, JANUS_EMAIL } = await import("../lib/helpers.js");
      const ok = await sendGmailRaw(saKey, w.email, `Janus Time — Status Update ${today}`, html, `Status update for ${today}`, JANUS_EMAIL);
      await logEmail("time_worker_digest", `Janus Time — Status Update ${today}`, [w.email], html, ok ? "sent" : "failed");
      if (ok) sent++;
    }

    void yesterday; // referenced for clarity
    auditTimeCron("time-worker-digest", "worker_digest_sent", `Worker daily digest: ${sent} email(s) sent`, "success", t0, { sent });
    res.json({ skipped: false, sent });
  } catch (e) {
    console.error("[time] worker-digest error:", e);
    auditTimeCron("time-worker-digest", "worker_digest_failed", `Worker daily digest failed: ${String(e)}`, "error", t0, { error: String(e) });
    res.json({ skipped: true, reason: String(e) });
  }
});

// POST /api/time/cron/admin-pending-digest — admin 7 AM PT pending digest
router.post("/api/time/cron/admin-pending-digest", async (req, res) => {
  const t0 = Date.now();
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isAdmin = cronSecret && req.headers["x-cron-secret"] === cronSecret;
    if (!isAdmin) {
      const auth = requireTimeAdmin(req, res);
      if (!auth) return;
    }
    const automation = await getTimeAutomation("Time Admin Pending Digest");
    if (automation && !automation.is_active) {
      auditTimeCron("time-admin-pending-digest", "admin_pending_digest_skipped", "Admin pending digest skipped: paused in Automations", "skipped", t0);
      res.json({ skipped: true, reason: "automation_paused" });
      return;
    }
    if (automation) await markTimeAutomationRan(automation.id);
    const { getSaKey } = await import("../lib/helpers.js");
    let saKey: import("../lib/helpers.js").ServiceAccountKey | null = null;
    try { saKey = getSaKey(); } catch { saKey = null; }
    if (!saKey) {
      auditTimeCron("time-admin-pending-digest", "admin_pending_digest_skipped", "Admin pending digest skipped: no service account key", "skipped", t0);
      res.json({ skipped: true, reason: "no_service_account_key" });
      return;
    }

    const { TONY_EMAIL } = await import("../lib/helpers.js");
    const adminEmails = [TONY_EMAIL];

    const pending = await query(
      `SELECT w.full_name, COUNT(te.id) AS cnt, SUM(te.hours::numeric * te.rate_cents) AS labor_cents
       FROM tt_time_entries te JOIN tt_workers w ON w.id = te.worker_id
       WHERE te.status = 'pending'
       GROUP BY w.id, w.full_name ORDER BY w.full_name`
    );

    if (pending.rows.length === 0) {
      auditTimeCron("time-admin-pending-digest", "admin_pending_digest_skipped", "Admin pending digest skipped: no pending entries", "skipped", t0);
      res.json({ skipped: true, reason: "no_pending_items" });
      return;
    }

    const rows = (pending.rows as Array<Record<string, unknown>>)
      .map((r) => `<tr><td>${r.full_name}</td><td>${r.cnt}</td><td>$${(parseFloat(String(r.labor_cents ?? 0)) / 100).toFixed(2)}</td></tr>`)
      .join("");

    const html = `<h2>Janus Time — Pending Approvals</h2>
<p>The following workers have pending time entries requiring your approval:</p>
<table border="1" cellpadding="6"><tr><th>Worker</th><th>Entries</th><th>Est. Amount</th></tr>${rows}</table>
<p><a href="https://example.com/time/admin">Review in Janus Time Admin</a></p>`;

    const { sendGmailRaw, logEmail, JANUS_EMAIL } = await import("../lib/helpers.js");
    let sent = 0;
    for (const adminEmail of adminEmails) {
      const ok = await sendGmailRaw(saKey, adminEmail, "Janus Time — Pending Approvals", html, "Pending approvals for Janus Time", JANUS_EMAIL);
      await logEmail("time_admin_pending_digest", "Janus Time — Pending Approvals", [adminEmail], html, ok ? "sent" : "failed");
      if (ok) sent++;
    }

    auditTimeCron("time-admin-pending-digest", "admin_pending_digest_sent", `Admin pending digest: ${sent} email(s) sent (${pending.rows.length} worker(s) pending)`, "success", t0, { sent, workers_pending: pending.rows.length });
    res.json({ skipped: false, sent });
  } catch (e) {
    console.error("[time] admin-pending-digest error:", e);
    auditTimeCron("time-admin-pending-digest", "admin_pending_digest_failed", `Admin pending digest failed: ${String(e)}`, "error", t0, { error: String(e) });
    res.json({ skipped: true, reason: String(e) });
  }
});

// POST /api/time/cron/weekly-closeout — Monday 7 AM PT close-out
router.post("/api/time/cron/weekly-closeout", async (req, res) => {
  const t0 = Date.now();
  try {
    const cronSecret = process.env.CRON_SECRET;
    const isAdmin = cronSecret && req.headers["x-cron-secret"] === cronSecret;
    if (!isAdmin) {
      const auth = requireTimeAdmin(req, res);
      if (!auth) return;
    }
    const automation = await getTimeAutomation("Time Weekly Close-Out");
    if (automation && !automation.is_active) {
      auditTimeCron("time-weekly-closeout", "weekly_closeout_skipped", "Weekly close-out skipped: paused in Automations", "skipped", t0);
      res.json({ skipped: true, reason: "automation_paused" });
      return;
    }
    if (automation) await markTimeAutomationRan(automation.id);
    const { getSaKey } = await import("../lib/helpers.js");
    let saKey: import("../lib/helpers.js").ServiceAccountKey | null = null;
    try { saKey = getSaKey(); } catch { saKey = null; }
    if (!saKey) {
      auditTimeCron("time-weekly-closeout", "weekly_closeout_skipped", "Weekly close-out skipped: no service account key", "skipped", t0);
      res.json({ skipped: true, reason: "no_service_account_key" });
      return;
    }

    const { TONY_EMAIL } = await import("../lib/helpers.js");
    const adminEmails = [TONY_EMAIL];

    const today = getTodayPT();
    const lastWeekEnd = addDays(today, -1);
    const lastWeekStart = getWeekStartPT(lastWeekEnd);

    const summary = await query(
      `SELECT w.full_name,
         SUM(CASE WHEN te.status = 'approved' AND te.payment_id IS NULL THEN te.hours::numeric * te.rate_cents ELSE 0 END) AS unpaid_approved_cents,
         SUM(CASE WHEN te.status = 'pending' THEN te.hours::numeric * te.rate_cents ELSE 0 END) AS pending_cents,
         SUM(te.hours::numeric) AS total_hours
       FROM tt_time_entries te JOIN tt_workers w ON w.id = te.worker_id
       WHERE te.work_date >= $1 AND te.work_date <= $2
       GROUP BY w.id, w.full_name ORDER BY w.full_name`,
      [lastWeekStart, lastWeekEnd]
    );

    const rows = (summary.rows as Array<Record<string, unknown>>)
      .map((r) => `<tr><td>${r.full_name}</td><td>${r.total_hours}h</td><td>$${(parseFloat(String(r.unpaid_approved_cents ?? 0)) / 100).toFixed(2)}</td><td>$${(parseFloat(String(r.pending_cents ?? 0)) / 100).toFixed(2)}</td></tr>`)
      .join("");

    const html = `<h2>Janus Time — Weekly Close-Out (${lastWeekStart} to ${lastWeekEnd})</h2>
<table border="1" cellpadding="6"><tr><th>Worker</th><th>Hours</th><th>Ready to Pay</th><th>Still Pending</th></tr>${rows}</table>
<p><a href="https://example.com/time/admin">Manage in Janus Time Admin</a></p>`;

    const { sendGmailRaw, logEmail, JANUS_EMAIL } = await import("../lib/helpers.js");
    let sent = 0;
    for (const adminEmail of adminEmails) {
      const ok = await sendGmailRaw(saKey, adminEmail, `Janus Time — Weekly Close-Out ${lastWeekStart}`, html, "Weekly close-out", JANUS_EMAIL);
      await logEmail("time_weekly_closeout", `Janus Time — Weekly Close-Out ${lastWeekStart}`, [adminEmail], html, ok ? "sent" : "failed");
      if (ok) sent++;
    }

    auditTimeCron("time-weekly-closeout", "weekly_closeout_sent", `Weekly close-out: ${sent} email(s) sent (${lastWeekStart} to ${lastWeekEnd})`, "success", t0, { sent, week_start: lastWeekStart, week_end: lastWeekEnd });
    res.json({ skipped: false, sent });
  } catch (e) {
    console.error("[time] weekly-closeout error:", e);
    auditTimeCron("time-weekly-closeout", "weekly_closeout_failed", `Weekly close-out failed: ${String(e)}`, "error", t0, { error: String(e) });
    res.json({ skipped: true, reason: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTIFICATION HELPERS (used by payment/worker creation flows)
// ─────────────────────────────────────────────────────────────────────────────

async function sendWelcomeEmail(worker: Record<string, unknown>, rateCents: number, categoryIds: string[]): Promise<void> {
  try {
    const { getSaKey, sendGmailRaw, logEmail, JANUS_EMAIL } = await import("../lib/helpers.js");
    let saKey: import("../lib/helpers.js").ServiceAccountKey | null = null;
    try { saKey = getSaKey(); } catch { saKey = null; }
    if (!saKey) return;

    let catNames = "";
    if (categoryIds.length > 0) {
      const cats = await query(
        `SELECT name FROM tt_categories WHERE id = ANY($1::uuid[])`,
        [categoryIds]
      );
      catNames = (cats.rows as Array<Record<string, unknown>>).map((c) => c.name).join(", ");
    }

    const html = `<h2>Welcome to Janus Time!</h2>
<p>Hi ${worker.full_name},</p>
<p>Your Janus Time account has been set up. You can log your hours at:</p>
<p><strong><a href="https://example.com/time">https://example.com/time</a></strong></p>
<p><strong>Your hourly rate:</strong> $${(rateCents / 100).toFixed(2)}/hr</p>
${catNames ? `<p><strong>Your work categories:</strong> ${catNames}</p>` : ""}
${worker.can_add_expenses ? "<p>You are also authorized to submit expenses.</p>" : ""}
<p>Log in with your Google or Apple account to get started.</p>`;

    const ok = await sendGmailRaw(saKey, String(worker.email), "Welcome to Janus Time", html, `Welcome to Janus Time. Login at https://example.com/time`, JANUS_EMAIL);
    await logEmail("time_welcome", "Welcome to Janus Time", [String(worker.email)], html, ok ? "sent" : "failed");
  } catch (e) {
    console.error("[time] sendWelcomeEmail error:", e);
  }
}

async function sendActivationEmail(worker: Record<string, unknown>, active: boolean): Promise<void> {
  try {
    const { getSaKey, sendGmailRaw, logEmail, JANUS_EMAIL } = await import("../lib/helpers.js");
    let saKey: import("../lib/helpers.js").ServiceAccountKey | null = null;
    try { saKey = getSaKey(); } catch { saKey = null; }
    if (!saKey) return;

    const subject = active ? "Your Janus Time account has been reactivated" : "Your Janus Time account has been deactivated";
    const html = active
      ? `<p>Hi ${worker.full_name}, your Janus Time account has been reactivated. You can log hours at <a href="https://example.com/time">example.com/time</a>.</p>`
      : `<p>Hi ${worker.full_name}, your Janus Time account has been deactivated. Contact Tony if you have questions.</p>`;

    const ok = await sendGmailRaw(saKey, String(worker.email), subject, html, subject, JANUS_EMAIL);
    await logEmail(active ? "time_reactivation" : "time_deactivation", subject, [String(worker.email)], html, ok ? "sent" : "failed");
  } catch (e) {
    console.error("[time] sendActivationEmail error:", e);
  }
}

async function sendPaymentEmail(workerId: string, payment: Record<string, unknown>): Promise<void> {
  try {
    const { getSaKey, sendGmailRaw, logEmail, JANUS_EMAIL } = await import("../lib/helpers.js");
    let saKey: import("../lib/helpers.js").ServiceAccountKey | null = null;
    try { saKey = getSaKey(); } catch { saKey = null; }
    if (!saKey) return;

    const workerRes = await query<WorkerRow>(`SELECT * FROM tt_workers WHERE id = $1`, [workerId]);
    const worker = workerRes.rows[0];
    if (!worker) return;

    const totalCents = parseInt(String(payment.total_cents ?? 0), 10);
    const laborCents = parseInt(String(payment.labor_cents ?? 0), 10);
    const expCents = parseInt(String(payment.expenses_cents ?? 0), 10);
    const hours = parseFloat(String(payment.hours_total ?? 0));

    const html = `<h2>Janus Time — Payment Confirmation</h2>
<p>Hi ${worker.full_name},</p>
<p>Payment for the week of <strong>${payment.week_start}</strong> has been sent:</p>
<table border="1" cellpadding="6">
  <tr><td>Hours</td><td>${hours.toFixed(2)}</td></tr>
  <tr><td>Labor</td><td>$${(laborCents / 100).toFixed(2)}</td></tr>
  ${expCents > 0 ? `<tr><td>Expenses</td><td>$${(expCents / 100).toFixed(2)}</td></tr>` : ""}
  <tr><td><strong>Total</strong></td><td><strong>$${(totalCents / 100).toFixed(2)}</strong></td></tr>
</table>
${payment.confirmation_ref ? `<p>Zelle Confirmation: ${payment.confirmation_ref}</p>` : ""}
<p>View your history at <a href="https://example.com/time">example.com/time</a></p>`;

    const ok = await sendGmailRaw(saKey, worker.email, `Janus Time — Payment ${payment.week_start}`, html, `Payment of $${(totalCents / 100).toFixed(2)} for week ${payment.week_start}`, JANUS_EMAIL);
    await logEmail("time_payment", `Janus Time — Payment ${payment.week_start}`, [worker.email], html, ok ? "sent" : "failed");
  } catch (e) {
    console.error("[time] sendPaymentEmail error:", e);
  }
}

export default router;
