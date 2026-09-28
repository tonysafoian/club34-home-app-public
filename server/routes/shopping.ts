import { Router } from 'express';
import { storage } from '../storage';
import { requireAuth, getAuthUser } from '../auth';
import { logAudit } from '../lib/auditLog.js';
import { sendWhatsApp, sendGmailRaw, getSaKey, logEmail } from '../lib/helpers';

const router = Router();

function fetchT(input: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input as any, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const STAGEHAND_BASE = 'https://api.stagehand.dev';

function getStagehandHeaders(): Record<string, string> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey) throw new Error('BROWSERBASE_API_KEY not configured');
  if (!projectId) throw new Error('BROWSERBASE_PROJECT_ID not configured');
  return { 'Content-Type': 'application/json', 'x-bb-api-key': apiKey, 'x-bb-project-id': projectId };
}

async function stagehandPost(path: string, body: Record<string, unknown>): Promise<any> {
  const headers = getStagehandHeaders();
  const r = await fetch(`${STAGEHAND_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`Stagehand ${r.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

async function closeSession(sessionId: string): Promise<void> {
  try {
    const headers = getStagehandHeaders();
    await fetch(`${STAGEHAND_BASE}/sessions/${sessionId}/close`, { method: 'POST', headers, body: '{}' });
  } catch {}
}

router.post('/api/amazon-order', requireAuth, async (req: any, res: any) => {
  try {
    const bbKey = process.env.BROWSERBASE_API_KEY;
    if (!bbKey) return res.status(500).json({ success: false, error: 'BROWSERBASE_API_KEY not configured' });
    const { action, orderId, searchQuery, autoOrder } = req.body;
    if (action === 'search') {
      if (!searchQuery || !orderId) return res.status(400).json({ success: false, error: 'searchQuery and orderId are required' });
      const modelApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
      if (!modelApiKey) return res.status(500).json({ success: false, error: 'GOOGLE_GENERATIVE_AI_API_KEY not configured' });
      const session = await stagehandPost('/sessions/start', { model_name: 'google/gemini-2.5-flash', model_api_key: modelApiKey });
      const sessionId = session.data?.session_id || session.session_id || session.id;
      if (!sessionId) throw new Error('Failed to start browser session');
      try {
        const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(searchQuery)}`;
        await stagehandPost(`/sessions/${sessionId}/navigate`, { url: searchUrl });
        await new Promise(resolve => setTimeout(resolve, 3000));
        const extractResult = await stagehandPost(`/sessions/${sessionId}/extract`, {
          instruction: `Extract the first 10 product results from this Amazon search page. For each product, extract: product name, price (with dollar sign), and a product URL if available. Return as a JSON array of objects with keys: name, price, url.`,
        });
        await closeSession(sessionId);
        let products: any[] = [];
        const rawData = extractResult.data || extractResult;
        if (typeof rawData === 'string') { try { const parsed = JSON.parse(rawData); products = Array.isArray(parsed) ? parsed : (parsed.products || []); } catch { products = []; } }
        else if (Array.isArray(rawData)) products = rawData;
        else if (rawData && typeof rawData === 'object') { products = rawData.products || rawData.items || rawData.results || []; if (!Array.isArray(products)) products = []; }
        const authUser = getAuthUser(req);
        console.log('Amazon search completed for order:', orderId, 'by user:', authUser?.userId || 'UNKNOWN');
        logAudit('amazon-order', {
          category: 'home', event_type: 'amazon_order_triggered', severity: 'info',
          actor_id: authUser?.userId || 'UNKNOWN', actor_name: authUser?.displayName || authUser?.email || 'UNKNOWN',
          channel: 'web', summary: `Amazon order search completed for "${searchQuery}"${autoOrder ? ' (auto-order)' : ''}`,
          detail: { order_id: orderId, search_query: searchQuery, auto_order: !!autoOrder, products_found: products.length, session_id: sessionId }, status: 'success',
        });
        return res.json({ success: true, products, query: searchQuery, sessionReplay: `https://browserbase.com/sessions/${sessionId}` });
      } catch (e) { await closeSession(sessionId); throw e; }
    }
    res.status(400).json({ success: false, error: 'Invalid action. Use "search".' });
  } catch (error: any) {
    console.error('Amazon order function error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/api/grocery-order', requireAuth, async (req: any, res: any) => {
  try {
    const bbKey = process.env.BROWSERBASE_API_KEY;
    if (!bbKey) return res.status(500).json({ success: false, error: 'BROWSERBASE_API_KEY not configured' });
    const { action, searchQuery, items } = req.body;

    if (action === 'search') {
      if (!searchQuery) return res.status(400).json({ success: false, error: 'searchQuery is required' });
      const modelApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY;
      if (!modelApiKey) throw new Error('GOOGLE_GENERATIVE_AI_API_KEY not configured');
      const session = await stagehandPost('/sessions/start', { model_name: 'google/gemini-2.5-flash', model_api_key: modelApiKey });
      const sessionId = session.data?.session_id || session.session_id || session.id;
      if (!sessionId) throw new Error('Failed to start browser session');
      try {
        const searchUrl = `https://www.amazon.com/s?k=${encodeURIComponent(searchQuery)}&i=amazonfresh`;
        await stagehandPost(`/sessions/${sessionId}/navigate`, { url: searchUrl });
        await new Promise(resolve => setTimeout(resolve, 3000));
        const extractResult = await stagehandPost(`/sessions/${sessionId}/extract`, {
          instruction: `Extract the first 10 grocery product results from this Amazon Fresh search page. For each product, extract: product name, price (with dollar sign), unit/size/weight info, and whether it appears to be in stock/available. Return as a JSON array of objects with keys: name, price, unit, store (set to "Amazon Fresh"), available (boolean).`,
        });
        await closeSession(sessionId);
        let products: any[] = [];
        const rawData = extractResult.data || extractResult;
        if (typeof rawData === 'string') { try { const parsed = JSON.parse(rawData); products = Array.isArray(parsed) ? parsed : (parsed.products || []); } catch { products = []; } }
        else if (Array.isArray(rawData)) products = rawData;
        else if (rawData && typeof rawData === 'object') { products = rawData.products || rawData.items || rawData.results || []; if (!Array.isArray(products)) products = []; }
        return res.json({ success: true, products, store: 'amazon-fresh', query: searchQuery, sessionReplay: `https://browserbase.com/sessions/${sessionId}` });
      } catch (e) { await closeSession(sessionId); throw e; }
    }

    if (action === 'add_to_cart') {
      if (!items || !Array.isArray(items)) return res.status(400).json({ success: false, error: 'items array is required' });
      const db = storage;
      for (const item of items) {
        await db.query(
          `INSERT INTO shopping_cart_items (user_id, product_name, price, quantity, platform, added_by, status, notes, product_url, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.user!.userId, item.name, item.price, item.quantity || 1, 'amazon-fresh', 'grocery-order', 'pending', item.unit || null, item.url || null, item.image_url || null]
        );
      }
      logAudit('grocery-order', {
        category: 'home', event_type: 'cart_items_added', severity: 'info',
        actor_id: req.user?.userId || 'UNKNOWN', actor_name: req.user?.displayName || req.user?.email || 'UNKNOWN', actor_role: 'user',
        channel: 'web', summary: `${items.length} grocery item${items.length !== 1 ? 's' : ''} added to cart from Amazon Fresh search`,
        detail: { items_count: items.length, platform: 'amazon-fresh', query: searchQuery }, status: 'success',
      });
      return res.json({ success: true, itemsAdded: items.length });
    }

    res.status(400).json({ success: false, error: 'Invalid action. Use "search" or "add_to_cart".' });
  } catch (error: any) {
    console.error('Grocery order function error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/api/shopping-cart', requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user!.userId;
    const db = storage;
    const { rows } = await db.query(
      `SELECT id, product_name, price, quantity, platform, notes, product_url, image_url, added_by, status, created_at
       FROM shopping_cart_items
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [userId]
    );
    res.json({ items: rows });
  } catch (error: any) {
    console.error('GET /api/shopping-cart error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.patch('/api/shopping-cart/:id', requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    const { quantity, status } = req.body;
    const db = storage;

    if (quantity !== undefined) {
      if (typeof quantity !== 'number' || quantity < 1) {
        return res.status(400).json({ error: 'Quantity must be a positive number' });
      }
      const { rowCount } = await db.query(
        `UPDATE shopping_cart_items SET quantity = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3 AND status = 'pending'`,
        [quantity, id, userId]
      );
      if (!rowCount) return res.status(404).json({ error: 'Cart item not found' });
    }

    if (status !== undefined) {
      const validStatuses = ['pending', 'cleared', 'purchased'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
      }
      const { rowCount } = await db.query(
        `UPDATE shopping_cart_items SET status = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
        [status, id, userId]
      );
      if (!rowCount) return res.status(404).json({ error: 'Cart item not found' });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error('PATCH /api/shopping-cart error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/shopping-cart/clear', requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user!.userId;
    const db = storage;
    const { rowCount } = await db.query(
      `UPDATE shopping_cart_items SET status = 'cleared', updated_at = NOW() WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );
    const cleared = rowCount || 0;
    if (cleared > 0) {
      logAudit('shopping-cart', {
        category: 'home', event_type: 'cart_cleared', severity: 'info',
        actor_id: userId || 'UNKNOWN', actor_name: req.user?.displayName || req.user?.email || 'UNKNOWN', actor_role: 'user',
        channel: 'web', summary: `Shopping cart cleared — ${cleared} item${cleared !== 1 ? 's' : ''} removed`,
        detail: { items_cleared: cleared }, status: 'success',
      });
    }
    res.json({ success: true, cleared });
  } catch (error: any) {
    console.error('POST /api/shopping-cart/clear error:', error);
    res.status(500).json({ error: error.message });
  }
});

const TONY_EMAIL = 'admin@example.com';
const STAFF_RECIPIENTS = ['staff2@example.com', 'staff@example.com'];
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const PACKAGE_SEARCH_QUERIES = [
  'is:unread label:inbox subject:"delivered" (from:ups.com OR from:fedex.com OR from:usps.com OR from:amazon.com OR from:narvar.com OR from:aftership.com OR from:shop-notify.com)',
  'is:unread label:inbox subject:"has been delivered"',
  'is:unread label:inbox subject:"package arrived"',
  'is:unread label:inbox subject:"your package" subject:"delivered"',
  'is:unread label:inbox subject:"out for delivery"',
];

async function getGmailAccessToken(impersonateEmail: string): Promise<string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/gmail.modify', aud: sa.token_uri, sub: impersonateEmail, iat: now, exp: now + 3600 };
  const { createSign } = await import('crypto');
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = `${signingInput}.${signature}`;
  const r = await fetchT(sa.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  if (!r.ok) throw new Error(`Gmail auth failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}

async function searchGmail(token: string, query: string): Promise<string[]> {
  const r = await fetchT(`${GMAIL_API}/messages?q=${encodeURIComponent(query)}&maxResults=10`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.messages || []).map((m: any) => m.id as string);
}

async function getMessageDetails(token: string, messageId: string) {
  const r = await fetchT(`${GMAIL_API}/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { subject: '(unknown)', from: '(unknown)', snippet: '' };
  const data = await r.json();
  const headers = data.payload?.headers || [];
  return { subject: headers.find((h: any) => h.name === 'Subject')?.value || '(no subject)', from: headers.find((h: any) => h.name === 'From')?.value || '(unknown)', snippet: data.snippet || '' };
}

async function archiveMessage(token: string, messageId: string): Promise<void> {
  await fetchT(`${GMAIL_API}/messages/${messageId}/modify`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  });
}

router.post('/api/package-arrival-monitor', requireAuth, async (req: any, res: any) => {
  try {
    const token = await getGmailAccessToken(TONY_EMAIL);
    const db = storage;
    const allMessageIds = new Set<string>();
    for (const query of PACKAGE_SEARCH_QUERIES) {
      const ids = await searchGmail(token, query);
      ids.forEach(id => allMessageIds.add(id));
    }
    if (allMessageIds.size === 0) return res.json({ processed: 0, message: 'No package emails found' });

    let processed = 0;
    for (const messageId of allMessageIds) {
      const { rows } = await db.query(
        `SELECT id FROM system_audit_log WHERE edge_function = 'package-arrival-monitor' AND event_type = 'package_arrival_processed' AND detail->>'gmail_message_id' = $1 LIMIT 1`,
        [messageId]
      );
      if (rows?.length > 0) continue;

      const details = await getMessageDetails(token, messageId);
      console.log(`Processing package email: "${details.subject}" from ${details.from}`);

      // 1. WhatsApp Tony
      const waMessage = `📦 *Package notification*\n\n${details.subject}\nFrom: ${details.from}\n\n${details.snippet}`;
      await sendWhatsApp(waMessage).catch(e => console.error('WhatsApp failed:', e));

      // 2. Email Sandra & Jesse
      const staffSubject = `📦 Package Alert: ${details.subject}`;
      const staffBody = `Hi,\n\nA package notification was received:\n\nSubject: ${details.subject}\nFrom: ${details.from}\n\n${details.snippet}\n\n— Janus (automated)`;
      await (async () => {
        const saKey = getSaKey();
        for (const to of STAFF_RECIPIENTS) {
          try {
            const sent = await sendGmailRaw(saKey, to, staffSubject, staffBody, staffBody);
            await logEmail("package_alert", staffSubject, [to], staffBody, sent ? "sent" : "error", sent ? undefined : "sendGmailRaw returned false", staffBody);
          } catch (e) {
            console.error(`Failed to email ${to}:`, e);
            await logEmail("package_alert", staffSubject, [to], staffBody, "error", e instanceof Error ? e.message : "unknown", staffBody);
          }
        }
      })().catch(e => console.error('Staff email phase failed:', e));

      // 3. Archive the email from Tony's inbox
      await archiveMessage(token, messageId).catch(e => console.error('Archive failed:', e));
      await db.query(
        `INSERT INTO system_audit_log (edge_function, category, event_type, severity, actor_id, actor_name, actor_role, channel, summary, detail, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        ['package-arrival-monitor', 'automation', 'package_arrival_processed', 'info', 'system', 'Janus', 'system', 'cron', `Package: ${details.subject}`, JSON.stringify({ gmail_message_id: messageId, subject: details.subject, from: details.from, snippet: details.snippet }), 'success']
      );
      processed++;
    }
    res.json({ processed, total_found: allMessageIds.size });
  } catch (e: any) {
    console.error('package-arrival-monitor error:', e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
