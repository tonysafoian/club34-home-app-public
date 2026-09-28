/**
 * server/services/grocery-submit.ts
 *
 * Headless-browser automation service that adds a locked grocery cart to
 * Amazon Fresh using the Stagehand / Browserbase API (same stack as
 * server/routes/shopping.ts).
 *
 * Contract:
 *   submitGroceryOrder(items) → Promise<{ success, log, error? }>
 *
 * Safety rules:
 *   - BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID must be present or the
 *     function throws — no silent "submitted" state on a credential outage.
 *   - Checkout is NOT triggered; items are placed in the cart for human review.
 *   - Credentials are never written to logs or audit detail.
 */

import type { GroceryOrderItem } from '../routes/grocery.js';
import { sendWhatsAppTo } from '../lib/helpers.js';

const STAGEHAND_BASE = 'https://api.stagehand.dev';
const AMAZON_FRESH_BASE = 'https://www.amazon.com';

// ── Item shape handed to the browser automation ──────────────────────────────

export interface GrocerySubmitItem {
  name: string;
  quantity: number;
  size: string | null;
}

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface CartItemResult {
  name: string;
  quantity: number;
  size: string | null;
  status: 'added' | 'not_found' | 'failed';
  error?: string;
}

export interface GrocerySubmitResult {
  success: boolean;
  log: {
    submission_method: 'stagehand_amazon_fresh';
    submitted_at: string;
    session_id: string;
    session_replay_url: string;
    item_count: number;
    items_added: number;
    items_not_found: number;
    items_failed: number;
    items: CartItemResult[];
  };
  error?: string;
}

// ── Credential helpers ────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured — cannot run Amazon Fresh automation`);
  return v;
}

function getStagehandHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-bb-api-key': requireEnv('BROWSERBASE_API_KEY'),
    'x-bb-project-id': requireEnv('BROWSERBASE_PROJECT_ID'),
  };
}

function getModelApiKey(): string {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY is not configured — cannot run Amazon Fresh automation');
  return key;
}

// ── Low-level Stagehand helpers ───────────────────────────────────────────────

interface StagehandResponse {
  data?: { session_id?: string } & Record<string, unknown>;
  session_id?: string;
  id?: string;
  [key: string]: unknown;
}

async function stagehandPost(path: string, body: Record<string, unknown>): Promise<StagehandResponse> {
  const headers = getStagehandHeaders();
  const r = await fetch(`${STAGEHAND_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`Stagehand ${r.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

async function closeSession(sessionId: string): Promise<void> {
  try {
    const headers = getStagehandHeaders();
    await fetch(`${STAGEHAND_BASE}/sessions/${sessionId}/close`, {
      method: 'POST',
      headers,
      body: '{}',
    });
  } catch {
    // Best-effort cleanup — don't surface close errors
  }
}

/**
 * Sentinel the `act` instruction is told to emit when no product on the search
 * page reasonably matches the requested item (out of stock / no grocery results).
 * Detecting this lets us mark the item 'not_found' instead of clicking a wrong
 * product or reporting a generic 'failed'.
 */
const NO_MATCH_SENTINEL = 'NO_MATCH';

/**
 * Returns true when a Stagehand `act` response signals it could not find a
 * matching product (i.e. it emitted the NO_MATCH sentinel instead of clicking).
 * The Stagehand response shape varies, so we scan the serialized payload.
 */
function actReportsNoMatch(actResult: unknown): boolean {
  if (actResult == null) return false;
  try {
    return JSON.stringify(actResult).toUpperCase().includes(NO_MATCH_SENTINEL);
  } catch {
    return false;
  }
}

// ── Item list builder (exported for unit tests) ───────────────────────────────

/**
 * Converts grocery_order_items rows into the compact { name, quantity, size }
 * search terms used by the browser automation.
 *
 * The search string combines brand + name so Amazon Fresh can find the right
 * product (e.g. "Organic Valley Whole Milk" is more precise than "Whole Milk").
 */
export function buildItemList(items: GroceryOrderItem[]): GrocerySubmitItem[] {
  return items.map((it) => {
    const nameParts = [it.brand, it.name].filter(Boolean);
    return {
      name: nameParts.join(' '),
      quantity: it.quantity,
      size: it.size ?? null,
    };
  });
}

// ── Cart confirmation message ─────────────────────────────────────────────────

/**
 * Builds the WhatsApp confirmation message sent once items have been added to
 * the Amazon Fresh cart. Lists how many items were added, any that failed (so
 * they can be added manually), and the Browserbase session replay link.
 *
 * Exported for unit testing.
 */
export function buildCartNotification(log: GrocerySubmitResult['log']): string {
  const { item_count, items_added, items_failed, session_replay_url, items } = log;

  const lines: string[] = ['🛒 *Grocery Cart Ready*', ''];

  if (items_failed === 0) {
    lines.push(
      `All ${item_count} item(s) are in the Amazon Fresh cart — review and check out when ready.`,
    );
  } else {
    lines.push(
      `Added ${items_added} of ${item_count} item(s) to the Amazon Fresh cart — review and check out when ready.`,
    );
  }

  lines.push('', `✅ Added: ${items_added}`);
  if (items_failed > 0) lines.push(`⚠️ Failed: ${items_failed}`);

  const failedItems = items.filter((it) => it.status !== 'added');
  if (failedItems.length > 0) {
    lines.push('', "Couldn't add (please add manually):");
    for (const it of failedItems) lines.push(`• ${it.name}`);
  }

  lines.push('', `Replay: ${session_replay_url}`);

  return lines.join('\n');
}

// ── Core automation ───────────────────────────────────────────────────────────

/**
 * Adds each item in the list to the Amazon Fresh cart via Stagehand.
 *
 * Process per item:
 *  1. Navigate to an Amazon Fresh search URL for the item.
 *  2. Wait briefly for the page to settle.
 *  3. Use Stagehand `act` to click "Add to Cart" on the best matching result.
 *     The instruction includes a fallback: if no product reasonably matches
 *     (out of stock / no grocery results) it must emit a NO_MATCH sentinel
 *     instead of clicking a wrong item.
 *
 * Per-item outcomes:
 *  - 'added'     — Add to Cart succeeded.
 *  - 'not_found' — the search returned no matching product (NO_MATCH sentinel).
 *  - 'failed'    — a result was attempted but the Stagehand call errored.
 *
 * The browser session is always closed in a `finally` block regardless of
 * per-item failures so we don't leak Browserbase sessions.
 */
export async function submitGroceryOrder(
  items: GrocerySubmitItem[],
  notifyPhones?: string | string[],
): Promise<GrocerySubmitResult> {
  // Validate credentials up front — throws if any are missing.
  getStagehandHeaders();
  const modelApiKey = getModelApiKey();

  const submittedAt = new Date().toISOString();

  // Start a browser session.
  const session = await stagehandPost('/sessions/start', {
    model_name: 'google/gemini-2.5-flash',
    model_api_key: modelApiKey,
  });
  const sessionId = session.data?.session_id || session.session_id || session.id;
  if (!sessionId) throw new Error('Stagehand did not return a session ID');

  const sessionReplayUrl = `https://browserbase.com/sessions/${sessionId}`;
  const results: CartItemResult[] = [];

  try {
    for (const item of items) {
      const searchQuery = [item.name, item.size].filter(Boolean).join(' ');
      const searchUrl = `${AMAZON_FRESH_BASE}/s?k=${encodeURIComponent(searchQuery)}&i=amazonfresh`;

      try {
        await stagehandPost(`/sessions/${sessionId}/navigate`, { url: searchUrl });
        // Allow the page to render product results before acting.
        await new Promise<void>((resolve) => setTimeout(resolve, 3000));

        // Stagehand `act` uses the AI to click the appropriate element. The
        // fallback instruction tells it to emit NO_MATCH (and click nothing)
        // when the item is out of stock or the search returns no grocery
        // results, so we can mark it 'not_found' instead of clicking a wrong
        // product or reporting a generic failure.
        const actResult = await stagehandPost(`/sessions/${sessionId}/act`, {
          action:
            `Find the first available grocery product result on this Amazon Fresh search page ` +
            `that best matches "${searchQuery}". Click its "Add to Cart" button. ` +
            `If no "Add to Cart" button is visible on the search results page, ` +
            `click the first product to open its detail page, then click "Add to Cart". ` +
            `If no product on the page reasonably matches "${searchQuery}" — for example the ` +
            `item is out of stock or the search returned no relevant grocery results — do NOT ` +
            `click any product. Instead respond with exactly this text: ${NO_MATCH_SENTINEL}`,
        });

        // Search returned nothing usable — record as not_found, not failed, so
        // the partial-failure report distinguishes "couldn't find it" from
        // "found it but the add-to-cart step broke".
        if (actReportsNoMatch(actResult)) {
          results.push({
            name: item.name,
            quantity: item.quantity,
            size: item.size,
            status: 'not_found',
            error: `No matching in-stock product found for "${searchQuery}" on Amazon Fresh`,
          });
          continue;
        }

        // Add the requested quantity if it is more than 1 by incrementing the cart.
        if (item.quantity > 1) {
          for (let q = 1; q < item.quantity; q++) {
            await stagehandPost(`/sessions/${sessionId}/act`, {
              action: `Increment the quantity of "${item.name}" in the cart or on the page by 1.`,
            });
          }
        }

        results.push({ name: item.name, quantity: item.quantity, size: item.size, status: 'added' });
      } catch (itemErr: unknown) {
        const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
        results.push({ name: item.name, quantity: item.quantity, size: item.size, status: 'failed', error: msg });
      }
    }
  } finally {
    await closeSession(sessionId);
  }

  const itemsAdded = results.filter((r) => r.status === 'added').length;
  const itemsNotFound = results.filter((r) => r.status === 'not_found').length;
  const itemsFailed = results.filter((r) => r.status === 'failed').length;
  const itemsUnsuccessful = itemsNotFound + itemsFailed;

  // All items must be added for the run to be marked 'submitted'.
  // Any shortfall (partial or total) returns success=false so executeLockAndSubmit
  // leaves the run 'locked' for manual follow-up. This is intentionally strict: a
  // partial order (e.g. 9/10 items) should not silently advance to 'submitted' —
  // human review is required before the run is considered done. On a partial run the
  // cart-confirmation WhatsApp below covers messaging (added/failed/replay), so
  // executeLockAndSubmit only fires its generic failure alert when nothing was added.
  const overallSuccess = itemsUnsuccessful === 0 && itemsAdded > 0;

  // Human-readable breakdown so the WhatsApp alert and admin UI distinguish
  // "couldn't find it" (out of stock / no results) from "found it but the
  // add-to-cart step broke".
  const breakdown = [
    itemsNotFound > 0 ? `${itemsNotFound} not found` : null,
    itemsFailed > 0 ? `${itemsFailed} failed to add` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const errorMsg = overallSuccess
    ? undefined
    : itemsAdded === 0
      ? `All ${items.length} item(s) failed to be added to the Amazon Fresh cart (${breakdown})`
      : `${itemsUnsuccessful} of ${items.length} item(s) failed (${breakdown}) — run kept locked for manual review`;

  const result: GrocerySubmitResult = {
    success: overallSuccess,
    log: {
      submission_method: 'stagehand_amazon_fresh',
      submitted_at: submittedAt,
      session_id: sessionId,
      session_replay_url: sessionReplayUrl,
      item_count: items.length,
      items_added: itemsAdded,
      items_not_found: itemsNotFound,
      items_failed: itemsFailed,
      items: results,
    },
    error: errorMsg,
  };

  // Best-effort WhatsApp confirmation once items are in the cart. This fires
  // whenever at least one item was added (full success or partial) so every
  // order approver (e.g. Tony and Lana) knows the cart is ready and which
  // items, if any, need manual attention. Each recipient is messaged
  // independently so one failed send never blocks the others, and a send
  // failure must never block the caller's state transition.
  const recipients = Array.from(
    new Set((Array.isArray(notifyPhones) ? notifyPhones : [notifyPhones]).filter((p): p is string => !!p)),
  );
  if (recipients.length > 0 && itemsAdded > 0) {
    const message = buildCartNotification(result.log);
    for (const phone of recipients) {
      try {
        await sendWhatsAppTo(phone, message);
      } catch (notifyErr: unknown) {
        const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        console.error(`[grocery-submit] cart confirmation WhatsApp failed for ${phone}:`, msg);
      }
    }
  }

  return result;
}
