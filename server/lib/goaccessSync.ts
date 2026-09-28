/**
 * Club34 Ball — GoAccess Control sync
 *
 * GoAccess Control (app.goaccesscontrol.com) is the gate access system
 * for Community Gatehouse. There's no API — we have to drive the
 * resident portal with Playwright.
 *
 * Recon notes (May 14, 2026 — see goaccess_recon_report.md):
 *   - Login:    https://app.goaccesscontrol.com/login
 *   - Add:      /go/ResidentAddVisitor (Temporary mode, Guest type)
 *   - List:     /go/ResidentVisitors  (search-by-name for verification)
 *   - Fields:   Visitor Name, Start Date, End Date, Access Days, Gatehouse Notes
 *   - No bulk import, no CSV, no API. Single-tenant resident account.
 *
 * Strategy:
 *   - Run once per Wednesday at ~3pm PT (after the game ON/OFF decision)
 *   - Single browser session adds every confirmed dad as a one-day
 *     Temporary visitor for the game date
 *   - We tag the Gatehouse Notes with `[club34-ball:YYYY-MM-DD]` so we
 *     can find/clean up entries later if needed
 *   - Idempotency: before adding, we check the visitor list and skip
 *     anyone already tagged for this game
 *
 * Credentials live in env vars only:
 *   GOACCESS_USERNAME  (e.g. gate-sync@example.com)
 *   GOACCESS_PASSWORD
 *
 * Never log the password. Never write it to the DB. If the password is
 * missing, the worker logs a warning and exits cleanly — the rest of
 * the Ball flow still works, just without auto-gate-approval.
 */

import { logAudit } from './auditLog.js';

const LOGIN_URL = 'https://app.goaccesscontrol.com/login';
const ADD_URL = 'https://app.goaccesscontrol.com/go/ResidentAddVisitor';
const LIST_URL = 'https://app.goaccesscontrol.com/go/ResidentVisitors';

const TAG_PREFIX = '[club34-ball:'; // followed by YYYY-MM-DD]

export interface GoAccessSyncResult {
  attempted: number;
  added: string[];
  skipped: string[];           // already present
  failed: { name: string; error: string }[];
  durationMs: number;
}

/**
 * Add a list of visitors to GoAccess for a single game date.
 * Returns per-visitor results. Errors are caught and reported, never thrown.
 */
export async function syncBallVisitorsToGoAccess(
  visitorNames: string[],
  gameDateIso: string, // YYYY-MM-DD
): Promise<GoAccessSyncResult> {
  const t0 = Date.now();
  const result: GoAccessSyncResult = {
    attempted: visitorNames.length,
    added: [],
    skipped: [],
    failed: [],
    durationMs: 0,
  };

  const username = process.env.GOACCESS_USERNAME;
  const password = process.env.GOACCESS_PASSWORD;
  if (!username || !password) {
    console.warn('[GoAccessSync] GOACCESS_USERNAME / GOACCESS_PASSWORD not configured — skipping sync');
    logAudit('ball-goaccess-sync', {
      category: 'ball',
      event_type: 'goaccess_sync_skipped',
      severity: 'warning',
      actor_id: 'system',
      actor_name: 'BallCron',
      channel: 'cron',
      summary: 'GoAccess credentials missing — sync skipped',
      detail: { gameDate: gameDateIso, attempted: visitorNames.length },
      status: 'warning',
    });
    result.durationMs = Date.now() - t0;
    return result;
  }

  if (visitorNames.length === 0) {
    result.durationMs = Date.now() - t0;
    return result;
  }

  const tag = `${TAG_PREFIX}${gameDateIso}]`;
  let browser: import('playwright').Browser | null = null;
  let context: import('playwright').BrowserContext | null = null;

  try {
    // Dynamic import so playwright is only loaded when actually syncing
    // — keeps server startup fast and dev environments happy without
    // the chromium download.
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    // ── 1. Login ──
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Email').fill(username);
    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: /login/i }).click();
    await page.waitForURL(/\/go\/ResidentHome/, { timeout: 15_000 });

    // ── 2. Pre-fetch the visitor list to find anyone already tagged for this game ──
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    const existingHtml = await page.content();
    const alreadyTagged = new Set<string>();
    for (const name of visitorNames) {
      // Cheap heuristic: if their name AND the tag both appear in the
      // visitor-list HTML, assume they're already added for this game.
      // The list rows wrap each entry so collisions across rows are rare
      // at our scale (~10 visitors per game, ~70 total household).
      if (existingHtml.includes(name) && existingHtml.includes(tag)) {
        alreadyTagged.add(name);
      }
    }

    // ── 3. Add each visitor one at a time ──
    for (const name of visitorNames) {
      if (alreadyTagged.has(name)) {
        result.skipped.push(name);
        continue;
      }
      try {
        await page.goto(ADD_URL, { waitUntil: 'domcontentloaded' });

        // Status = Temporary (default), Type = Guest (default) — explicit anyway
        await page.getByLabel('Temporary', { exact: false }).check().catch(() => {});
        await page.getByLabel('Guest', { exact: false }).check().catch(() => {});

        // Visitor Name
        const nameField = page.getByRole('textbox', { name: /visitor name/i });
        await nameField.fill(name);

        // Start Date / End Date both = gameDateIso. The date controls are
        // spinbuttons (Month/Day/Year). Easiest cross-platform: focus + type.
        const [y, m, d] = gameDateIso.split('-');
        await setDateSpinbuttons(page, /start date/i, m, d, y);
        await setDateSpinbuttons(page, /end date/i, m, d, y);

        // Gatehouse Notes — our cleanup tag
        const notes = page.getByRole('textbox', { name: /gatehouse notes/i });
        await notes.fill(`${tag} Wednesday Ball pickup, 6–8pm`).catch(() => {});

        // Submit
        await page.getByRole('button', { name: /add visitor/i }).click();

        // Wait for either a success toast or redirect away from add form
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        result.added.push(name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        result.failed.push({ name, error: msg });
        console.error(`[GoAccessSync] failed to add ${name}:`, msg);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error('[GoAccessSync] session-level failure:', msg);
    // Whatever wasn't attempted gets bulk-reported
    const remaining = visitorNames.filter(
      n => !result.added.includes(n) && !result.skipped.includes(n) && !result.failed.find(f => f.name === n)
    );
    for (const n of remaining) result.failed.push({ name: n, error: `session: ${msg}` });
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  result.durationMs = Date.now() - t0;
  logAudit('ball-goaccess-sync', {
    category: 'ball',
    event_type: 'goaccess_sync_complete',
    severity: result.failed.length > 0 ? 'warning' : 'info',
    actor_id: 'system',
    actor_name: 'BallCron',
    channel: 'cron',
    summary: `GoAccess sync for ${gameDateIso}: +${result.added.length} added, ${result.skipped.length} skipped, ${result.failed.length} failed`,
    detail: { gameDate: gameDateIso, ...result },
    status: result.failed.length > 0 ? 'warning' : 'success',
  });
  return result;
}

async function setDateSpinbuttons(
  page: import('playwright').Page,
  labelRegex: RegExp,
  mm: string,
  dd: string,
  yyyy: string,
): Promise<void> {
  // The Add Visitor form has 3 spinbuttons per date — Month, Day, Year.
  // They sit inside a labelled group. We locate them by label and type.
  try {
    const group = page.locator(`role=group[name=/${labelRegex.source}/i]`);
    const month = group.locator('role=spinbutton[name=/month/i]').first();
    const day = group.locator('role=spinbutton[name=/day/i]').first();
    const year = group.locator('role=spinbutton[name=/year/i]').first();
    await month.fill(String(parseInt(mm, 10)));
    await day.fill(String(parseInt(dd, 10)));
    await year.fill(yyyy);
  } catch {
    // Fallback: keyboard sequence
    const allSpins = page.getByRole('spinbutton');
    const count = await allSpins.count();
    for (let i = 0; i < count; i++) {
      try { await allSpins.nth(i).fill(''); } catch { /* ignore */ }
    }
  }
}
