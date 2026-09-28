/**
 * Grocery Helper — Email renderer & sender
 *
 * Exports:
 *   renderCartHtml  — inline-styled, table-based HTML document for Gmail/Outlook/Apple Mail
 *   renderCartText  — plain-text fallback
 *   sendGroceryEmail — fetches Gmail OAuth token once, loops recipients, never throws
 *
 * Variants: 'last-call' | 'lock-confirmation' | 'rina-monday'
 */

import { getSaKey, getServiceToken, base64url, logEmail, JANUS_EMAIL } from './helpers.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type EmailVariant = 'last-call' | 'lock-confirmation' | 'rina-monday' | 'manual-submit-needed' | 'open-reminder';

export interface GroceryEmailItem {
  id?: string;
  name: string;
  category: string;
  brand?: string | null;
  size?: string | null;
  image_url?: string | null;
  unit_price?: number | null;
  quantity: number;
  added_by_user_id?: string | null;
}

export interface GroceryAuditRow {
  action: string;
  actor_user_id?: string | null;
  old_qty?: number | null;
  new_qty?: number | null;
  detail?: Record<string, unknown> | null;
  created_at?: string;
}

export interface GroceryEmailRun {
  id?: string;
  cycle_lock_at?: string;
  delivery_date?: string;
  cycle_start_at?: string;
}

export interface SendGroceryEmailParams {
  variant: EmailVariant;
  toAddresses: string[];
  items: GroceryEmailItem[];
  run?: GroceryEmailRun;
  auditRows?: GroceryAuditRow[];
  memberNames?: Record<string, string>;
  lockStatus?: 'submitted' | 'skipped' | 'failed';
  estimatedTotal?: number;
}

export interface SendGroceryEmailResult {
  ok: boolean;
  results: Array<{ to: string; success: boolean; error?: string }>;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE = process.env.PUBLIC_BASE_URL || 'https://example.com';
const CART_URL = `${BASE}/common-tasks/grocery`;
const PRIORITY_CATS = ['produce', 'dairy', 'bakery'];

type VariantCopy = {
  ctaLabel: (empty: boolean, lockStatus?: string) => string;
  ctaUrl: string;
};

const VARIANT_COPY: Record<EmailVariant, VariantCopy> = {
  'last-call': {
    ctaLabel: (empty) => empty ? 'Open the catalog' : "Edit this week's cart",
    ctaUrl: CART_URL,
  },
  'lock-confirmation': {
    ctaLabel: (_empty, lockStatus) =>
      lockStatus === 'submitted' ? "View this week's order"
      : lockStatus === 'failed' ? 'View order detail'
      : 'Open the catalog',
    ctaUrl: CART_URL,
  },
  'rina-monday': {
    ctaLabel: () => 'View order',
    ctaUrl: CART_URL,
  },
  'manual-submit-needed': {
    ctaLabel: () => 'Open cart on Amazon Fresh',
    ctaUrl: 'https://www.amazon.com/alm/storefront?almBrandId=QW1hem9uIEZyZXNo',
  },
  'open-reminder': {
    ctaLabel: (empty) => empty ? 'Start adding items' : 'Add or edit items',
    ctaUrl: CART_URL,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtPrice(cents: number | null | undefined): string {
  if (cents == null) return '';
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

function fmtLineTotal(unitCents: number | null | undefined, qty: number): string {
  if (unitCents == null) return '';
  const total = (unitCents / 100) * qty;
  return `$${total.toFixed(2)}`;
}

function fmtLockTime(isoString: string | undefined): string {
  if (!isoString) return 'Friday 4 PM PT';
  try {
    return new Date(isoString).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch {
    return isoString;
  }
}

function fmtDeliveryDate(dateStr: string | undefined): string {
  if (!dateStr) return 'Monday';
  try {
    return new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'long', month: 'long', day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function groupByCategory(items: GroceryEmailItem[]): Array<[string, GroceryEmailItem[]]> {
  const map = new Map<string, GroceryEmailItem[]>();
  for (const item of items) {
    const cat = (item.category || 'other').toLowerCase();
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(item);
  }
  const all = [...map.keys()];
  const priority = PRIORITY_CATS.filter(c => all.includes(c));
  const others = all.filter(c => !PRIORITY_CATS.includes(c)).sort();
  return [...priority, ...others].map(cat => [cat, map.get(cat)!]);
}

const VARIANT_HERO: Record<Exclude<EmailVariant, 'lock-confirmation'>, string> = {
  'last-call': 'Last call.',
  'rina-monday': 'Monday morning.',
  'manual-submit-needed': 'Action needed.',
  'open-reminder': 'Grocery Helper is open.',
};

function heroText(variant: EmailVariant, lockStatus?: string): string {
  if (variant === 'lock-confirmation') {
    if (lockStatus === 'submitted') return 'Order locked.';
    if (lockStatus === 'skipped') return 'No order this week.';
    return 'Submission failed.';
  }
  return VARIANT_HERO[variant];
}

function subHeadline(variant: EmailVariant, itemCount: number, lockStatus?: string, estimatedTotal?: number): string {
  if (variant === 'last-call') {
    return itemCount > 0
      ? `${itemCount} item${itemCount !== 1 ? 's' : ''} in the cart so far. Order locks Friday at 4 PM&nbsp;PT.`
      : 'Nothing in the cart yet. Add something before Friday or the week will be skipped.';
  }
  if (variant === 'lock-confirmation') {
    if (lockStatus === 'submitted') {
      const totalStr = estimatedTotal != null ? ` · ~${fmtLineTotal(estimatedTotal, 1).replace('$', '$')}` : '';
      return `${itemCount} item${itemCount !== 1 ? 's' : ''} sent to Amazon Fresh${totalStr}. You'll get a delivery confirmation when it ships.`;
    }
    if (lockStatus === 'skipped') return 'The cart was empty at lock time, so no order was placed this week.';
    return 'The Amazon Fresh submission encountered an error. The order is locked — please submit manually or contact Tony.';
  }
  if (variant === 'rina-monday') {
    return `${itemCount} item${itemCount !== 1 ? 's' : ''} should be arriving today. See the standing routine below.`;
  }
  if (variant === 'manual-submit-needed') {
    const totalStr = estimatedTotal != null ? ` (~${fmtLineTotal(estimatedTotal, 1)})` : '';
    return `The Monday cart is locked with ${itemCount} item${itemCount !== 1 ? 's' : ''}${totalStr}, but auto-submit isn't wired up yet — please place this order on Amazon Fresh manually before tonight.`;
  }
  if (variant === 'open-reminder') {
    return itemCount > 0
      ? `${itemCount} item${itemCount !== 1 ? 's' : ''} in the cart so far. Add anything else by Friday&nbsp;4&nbsp;PM&nbsp;PT — the cart locks then.`
      : 'Nothing picked yet. Add items by Friday&nbsp;4&nbsp;PM&nbsp;PT and we\'ll order them Monday morning.';
  }
  return '';
}

// ─── HTML renderer ───────────────────────────────────────────────────────────

export function buildSubject(variant: EmailVariant, items: GroceryEmailItem[], lockStatus?: string): string {
  if (variant === 'last-call') {
    return items.length > 0
      ? `Grocery Helper — Last call · ${items.length} item${items.length !== 1 ? 's' : ''} so far`
      : 'Grocery Helper — Last call · Nothing picked yet';
  }
  if (variant === 'lock-confirmation') {
    if (lockStatus === 'submitted') return 'Grocery Helper — Order locked · Delivering Monday';
    if (lockStatus === 'skipped') return 'Grocery Helper — No order this week';
    return '⚠ Grocery Helper — Submit failed';
  }
  if (variant === 'rina-monday') return 'Monday — Grocery delivery & fridge clear-out';
  if (variant === 'manual-submit-needed') {
    return `[ACTION NEEDED] Place Monday Grocery Order — ${items.length} item${items.length !== 1 ? 's' : ''}`;
  }
  if (variant === 'open-reminder') {
    return items.length > 0
      ? `Grocery Helper — ${items.length} item${items.length !== 1 ? 's' : ''} in next week's cart`
      : 'Grocery Helper — Cart is open for next week';
  }
  return 'Grocery Helper';
}

function renderItemsTable(items: GroceryEmailItem[], memberNames: Record<string, string> = {}): string {
  if (items.length === 0) return '';

  const groups = groupByCategory(items);
  let html = '';

  for (const [cat, catItems] of groups) {
    const catLabel = escHtml(cat.charAt(0).toUpperCase() + cat.slice(1));
    html += `
      <tr>
        <td style="padding: 20px 0 8px; font-family: 'Barlow Semi Condensed', Barlow, Arial, sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #92400E;">
          ${catLabel}
        </td>
      </tr>`;

    for (const item of catItems) {
      const imgSrc = item.image_url ? escHtml(item.image_url) : null;
      const thumb = imgSrc
        ? `<img src="${imgSrc}" width="44" height="44" alt="${escHtml(item.name)}" style="border-radius:6px;object-fit:cover;display:block;">`
        : `<div style="width:44px;height:44px;background:#f3ede2;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:20px;">🛒</div>`;

      const editorName = item.added_by_user_id ? memberNames[item.added_by_user_id] : null;
      const editorLine = editorName
        ? `<div style="font-size:11px;color:#9CA3AF;margin-top:2px;">Added by ${escHtml(editorName)}</div>`
        : '';

      const unitPriceStr = fmtPrice(item.unit_price);
      const lineTotalStr = item.unit_price ? fmtLineTotal(item.unit_price, item.quantity) : '';
      const priceCell = unitPriceStr
        ? `<td style="padding:10px 0 10px 8px;vertical-align:middle;white-space:nowrap;font-family:monospace;font-size:13px;color:#374151;text-align:right;">${escHtml(unitPriceStr)}${lineTotalStr ? `<br><span style="color:#6B7280;font-size:11px;">${escHtml(lineTotalStr)}</span>` : ''}</td>`
        : '';

      html += `
        <tr>
          <td style="padding: 6px 0; border-bottom: 1px solid #F3EDE2;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:44px;vertical-align:middle;">${thumb}</td>
                <td style="padding-left:12px;vertical-align:middle;">
                  <div style="font-family:Barlow,Arial,sans-serif;font-size:14px;font-weight:500;color:#1F2937;">${escHtml(item.name)}</div>
                  ${item.brand ? `<div style="font-size:12px;color:#D97706;font-weight:600;">${escHtml(item.brand)}</div>` : ''}
                  ${item.size ? `<div style="font-size:11px;color:#9CA3AF;">${escHtml(item.size)}</div>` : ''}
                  ${editorLine}
                </td>
                <td style="padding-left:8px;vertical-align:middle;white-space:nowrap;text-align:right;">
                  <span style="font-family:Barlow,Arial,sans-serif;font-size:13px;color:#374151;">×&nbsp;${item.quantity}</span>
                </td>
                ${priceCell}
              </tr>
            </table>
          </td>
        </tr>`;
    }
  }

  return html;
}

function renderAuditBlock(auditRows: GroceryAuditRow[], memberNames: Record<string, string> = {}): string {
  if (!auditRows.length) return '';

  const lines = auditRows.map(row => {
    const actor = row.actor_user_id ? (memberNames[row.actor_user_id] || 'Someone') : 'Someone';
    const detail = row.detail as { name?: string } | null;
    const itemName = detail?.name || 'an item';
    const actionMap: Record<string, string> = { added: 'added', removed: 'removed', qty_changed: 'updated qty of' };
    const verb = actionMap[row.action] || row.action;
    const when = row.created_at ? new Date(row.created_at).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
    return `<tr><td style="padding:4px 0;font-family:Barlow,Arial,sans-serif;font-size:12px;color:#6B7280;">${escHtml(actor)} ${escHtml(verb)} <strong style="color:#374151;">${escHtml(itemName)}</strong>${when ? ` <span style="color:#9CA3AF;">at ${escHtml(when)}</span>` : ''}</td></tr>`;
  }).join('');

  return `
    <tr>
      <td style="padding: 20px 0 0;">
        <div style="background:#FEF9F0;border-left:3px solid #D97706;border-radius:4px;padding:14px 16px;">
          <div style="font-family:'Barlow Semi Condensed',Barlow,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#92400E;margin-bottom:8px;">Recent activity</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${lines}</table>
        </div>
      </td>
    </tr>`;
}

function renderStandingRoutine(): string {
  const tasks = [
    'Put away all groceries — refrigerated items first.',
    'Check expiry dates and discard anything past due.',
    'Wipe down refrigerator shelves and crisper drawers.',
    'Note any staples that are running low for next week.',
  ];
  const taskHtml = tasks.map(t => `<tr><td style="padding:3px 0 3px 0;font-family:Barlow,Arial,sans-serif;font-size:13px;color:#374151;">&#10003;&nbsp; ${escHtml(t)}</td></tr>`).join('');
  return `
    <tr>
      <td style="padding: 20px 0 0;">
        <div style="background:#FEF9F0;border-left:3px solid #D97706;border-radius:4px;padding:14px 16px;">
          <div style="font-family:'Barlow Semi Condensed',Barlow,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#92400E;margin-bottom:10px;">Standing routine</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${taskHtml}</table>
        </div>
      </td>
    </tr>`;
}

export function renderCartHtml(
  variant: EmailVariant,
  items: GroceryEmailItem[],
  opts: {
    run?: GroceryEmailRun;
    auditRows?: GroceryAuditRow[];
    memberNames?: Record<string, string>;
    lockStatus?: 'submitted' | 'skipped' | 'failed';
    estimatedTotal?: number;
  } = {},
): string {
  const { run, auditRows = [], memberNames = {}, lockStatus, estimatedTotal } = opts;
  const isEmpty = items.length === 0;
  const ctaConfig = VARIANT_COPY[variant];
  const hero = heroText(variant, lockStatus);
  const sub = subHeadline(variant, items.length, lockStatus, estimatedTotal);
  const ctaLabel = ctaConfig.ctaLabel(isEmpty, lockStatus);
  const ctaUrl = escHtml(ctaConfig.ctaUrl);

  const lockTime = fmtLockTime(run?.cycle_lock_at);
  const deliveryDate = fmtDeliveryDate(run?.delivery_date);

  const itemsHtml = renderItemsTable(items, memberNames);
  const activityHtml = variant === 'last-call' ? renderAuditBlock(auditRows, memberNames) : '';
  const routineHtml = variant === 'rina-monday' ? renderStandingRoutine() : '';

  const emptyCartHtml = isEmpty && variant !== 'rina-monday' ? `
    <tr>
      <td style="padding: 24px 0; text-align:center;">
        <div style="font-family:Barlow,Arial,sans-serif;font-size:15px;color:#9CA3AF;">No items in the cart yet.</div>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grocery Helper — Club 34</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700&family=Barlow:wght@400;500;600&display=swap');
body { margin:0; padding:0; background:#f6f3ec; }
@media (prefers-color-scheme: dark) {
  body, .page-bg { background:#1a1814 !important; }
  .card { background:#2a2620 !important; }
  .item-name { color:#F9FAFB !important; }
  .item-sub { color:#9CA3AF !important; }
  .price-text { color:#D1D5DB !important; }
  .footer-text { color:#6B7280 !important; }
  .separator { border-bottom-color:#3a3530 !important; }
  .cat-label { color:#D97706 !important; }
}
</style>
</head>
<body style="margin:0;padding:0;background:#f6f3ec;">
<table role="presentation" class="page-bg" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f3ec;">
  <tr>
    <td align="center" style="padding:40px 20px 60px;">

      <!-- Card -->
      <table role="presentation" class="card" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.07);">

        <!-- Header band with "34" badge -->
        <tr>
          <td style="background:#92400E;background:linear-gradient(135deg,#B45309 0%,#92400E 100%);padding:24px 32px 20px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <div style="display:inline-block;background:#D97706;background:linear-gradient(135deg,#FBBF24,#D97706);color:#fff;font-family:'Barlow Semi Condensed',Barlow,Arial,sans-serif;font-size:22px;font-weight:700;letter-spacing:0.05em;padding:4px 12px;border-radius:6px;">34</div>
                  <div style="margin-top:6px;font-family:'Barlow Semi Condensed',Barlow,Arial,sans-serif;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#FDE68A;">Grocery Helper</div>
                </td>
                <td style="text-align:right;vertical-align:top;">
                  <div style="font-family:Barlow,Arial,sans-serif;font-size:11px;color:#FDE68A;opacity:0.7;">Delivery: ${escHtml(deliveryDate)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Hero -->
        <tr>
          <td style="padding:28px 32px 8px;">
            <div style="font-family:'Barlow Semi Condensed',Barlow,Arial,sans-serif;font-size:36px;font-weight:700;color:#1F2937;line-height:1.1;">${escHtml(hero)}</div>
            ${sub ? `<div style="margin-top:8px;font-family:Barlow,Arial,sans-serif;font-size:14px;color:#6B7280;line-height:1.5;">${sub}</div>` : ''}
          </td>
        </tr>

        <!-- Items -->
        <tr>
          <td style="padding:16px 32px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              ${emptyCartHtml}
              ${itemsHtml}
              ${activityHtml}
              ${routineHtml}
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td style="padding:28px 32px 0;text-align:center;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="background:#B45309;background:linear-gradient(135deg,#D97706,#92400E);border-radius:8px;">
                  <a href="${ctaUrl}" style="display:inline-block;padding:13px 32px;font-family:'Barlow Semi Condensed',Barlow,Arial,sans-serif;font-size:15px;font-weight:600;letter-spacing:0.03em;color:#ffffff;text-decoration:none;">${escHtml(ctaLabel)}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:28px 32px 32px;">
            <div style="border-top:1px solid #F3EDE2;padding-top:20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-family:Barlow,Arial,sans-serif;font-size:11px;color:#9CA3AF;line-height:1.7;">
                    <strong style="color:#6B7280;">Club 34</strong> · Grocery Helper<br>
                    Cart locks: ${escHtml(lockTime)}<br>
                    Delivery: ${escHtml(deliveryDate)}<br>
                    <a href="${ctaUrl}" style="color:#D97706;text-decoration:none;">Edit cart</a>
                  </td>
                  <td style="text-align:right;vertical-align:bottom;">
                    <div style="font-family:'Barlow Semi Condensed',Barlow,Arial,sans-serif;font-size:20px;font-weight:700;color:#F3EDE2;">34</div>
                  </td>
                </tr>
              </table>
            </div>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ─── Plain-text renderer ─────────────────────────────────────────────────────

export function renderCartText(
  variant: EmailVariant,
  items: GroceryEmailItem[],
  opts: {
    run?: GroceryEmailRun;
    lockStatus?: 'submitted' | 'skipped' | 'failed';
    estimatedTotal?: number;
  } = {},
): string {
  const { run, lockStatus, estimatedTotal } = opts;
  const hero = heroText(variant, lockStatus);
  const sub = subHeadline(variant, items.length, lockStatus, estimatedTotal);
  const lockTime = fmtLockTime(run?.cycle_lock_at);
  const deliveryDate = fmtDeliveryDate(run?.delivery_date);

  const lines: string[] = [];
  lines.push(`GROCERY HELPER — Club 34`);
  lines.push(`========================================`);
  lines.push(``);
  lines.push(hero.toUpperCase());
  if (sub) lines.push(sub.replace(/&nbsp;/g, ' '));
  lines.push(``);

  if (items.length > 0) {
    const groups = groupByCategory(items);
    for (const [cat, catItems] of groups) {
      lines.push(`[ ${cat.toUpperCase()} ]`);
      for (const item of catItems) {
        const brand = item.brand ? ` (${item.brand})` : '';
        const size = item.size ? ` — ${item.size}` : '';
        const price = item.unit_price ? ` @ ${fmtPrice(item.unit_price)}` : '';
        lines.push(`  × ${item.quantity}  ${item.name}${brand}${size}${price}`);
      }
      lines.push(``);
    }
  } else {
    lines.push(`No items in the cart.`);
    lines.push(``);
  }

  if (variant === 'rina-monday') {
    lines.push(`STANDING ROUTINE`);
    lines.push(`  ✓ Put away all groceries — refrigerated items first.`);
    lines.push(`  ✓ Check expiry dates and discard anything past due.`);
    lines.push(`  ✓ Wipe down refrigerator shelves and crisper drawers.`);
    lines.push(`  ✓ Note any staples that are running low for next week.`);
    lines.push(``);
  }

  lines.push(`Cart locks: ${lockTime}`);
  lines.push(`Delivery: ${deliveryDate}`);
  lines.push(`${CART_URL}`);
  lines.push(``);
  lines.push(`Club 34 — Grocery Helper`);

  return lines.join('\n');
}

// ─── Email sender ─────────────────────────────────────────────────────────────

export async function sendGroceryEmail(params: SendGroceryEmailParams): Promise<SendGroceryEmailResult> {
  const { variant, toAddresses, items, run, auditRows, memberNames, lockStatus, estimatedTotal } = params;

  const results: Array<{ to: string; success: boolean; error?: string }> = [];

  let gmailToken: string;
  try {
    const saKey = getSaKey();
    gmailToken = await getServiceToken(saKey, 'https://www.googleapis.com/auth/gmail.send', JANUS_EMAIL);
  } catch (tokenErr: unknown) {
    const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
    console.error('[groceryEmail] Failed to obtain Gmail token:', msg);
    return { ok: false, results: toAddresses.map(to => ({ to, success: false, error: `token_error: ${msg}` })) };
  }

  const htmlBody = renderCartHtml(variant, items, { run, auditRows, memberNames, lockStatus, estimatedTotal });
  const textBody = renderCartText(variant, items, { run, lockStatus, estimatedTotal });
  const subject = buildSubject(variant, items, lockStatus);

  const enc = new TextEncoder();

  for (const to of toAddresses) {
    try {
      const boundary = 'boundary_' + crypto.randomUUID().replace(/-/g, '');
      const subjectB64 = Buffer.from(subject).toString('base64');
      const mime = [
        `From: Janus <${JANUS_EMAIL}>`,
        `To: ${to}`,
        `Subject: =?UTF-8?B?${subjectB64}?=`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        textBody,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        htmlBody,
        '',
        `--${boundary}--`,
      ].join('\r\n');

      const raw = base64url(enc.encode(mime));
      const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gmailToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      });

      if (!sendRes.ok) {
        const errText = await sendRes.text().catch(() => `HTTP ${sendRes.status}`);
        console.error(`[groceryEmail] Send failed → ${to}: ${errText}`);
        results.push({ to, success: false, error: errText });
      } else {
        results.push({ to, success: true });
      }
    } catch (sendErr: unknown) {
      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.error(`[groceryEmail] Send exception → ${to}: ${msg}`);
      results.push({ to, success: false, error: msg });
    }
  }

  const ok = results.length > 0 && results.every(r => r.success);

  await logEmail(
    `grocery_${variant.replace(/-/g, '_')}`,
    subject,
    toAddresses,
    htmlBody,
    ok ? 'sent' : results.some(r => r.success) ? 'partial_failure' : 'error',
    ok ? undefined : results.filter(r => !r.success).map(r => r.error).filter(Boolean).join('; '),
    textBody,
  ).catch(() => {});

  return { ok, results };
}
