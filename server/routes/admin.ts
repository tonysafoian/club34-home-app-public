import { Router } from 'express';
import { storage } from '../storage';
import { sanitizeErrorMessage } from '../lib/errorSanitizer';
import { logAudit } from '../lib/auditLog';
import { FAILED_JOBS_MAX_ATTEMPTS, FAILED_JOBS_BACKOFF_MINUTES } from '../lib/failed-jobs-constants.js';
import { getCircuitSnapshot, forceClose } from '../lib/circuit-breaker.js';
import { BREAKER_NAMES, UNDERLYING_BREAKER_NAMES } from '../lib/breakers.js';

const router = Router();

function fetchT(input: string | URL | Request, init?: RequestInit, timeoutMs = 30_000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input as any, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const clientErrorRateLimit = new Map<string, number[]>();
const CLIENT_ERROR_MAX_PER_IP = 10;
const CLIENT_ERROR_WINDOW_MS = 60_000;

function isClientErrorRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (clientErrorRateLimit.get(ip) || []).filter(t => now - t < CLIENT_ERROR_WINDOW_MS);
  if (timestamps.length >= CLIENT_ERROR_MAX_PER_IP) return true;
  timestamps.push(now);
  clientErrorRateLimit.set(ip, timestamps);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of clientErrorRateLimit) {
    const valid = timestamps.filter(t => now - t < CLIENT_ERROR_WINDOW_MS);
    if (valid.length === 0) clientErrorRateLimit.delete(ip);
    else clientErrorRateLimit.set(ip, valid);
  }
}, CLIENT_ERROR_WINDOW_MS);

router.post('/api/client-error', async (req: any, res: any) => {
  try {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (isClientErrorRateLimited(ip)) return res.status(429).json({ error: 'Too many error reports' });

    const body = req.body || {};
    const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : '';
    if (!message) return res.status(400).json({ error: 'message required' });

    const stack = typeof body.stack === 'string' ? body.stack.slice(0, 2000) : undefined;
    const componentStack = typeof body.componentStack === 'string' ? body.componentStack.slice(0, 2000) : undefined;
    let url = typeof body.url === 'string' ? body.url.slice(0, 500) : 'unknown';
    try { const u = new URL(url); u.search = ''; url = u.toString(); } catch {}
    const userAgent = typeof body.userAgent === 'string' ? body.userAgent.slice(0, 300) : '';
    const timestamp = typeof body.timestamp === 'string' ? body.timestamp.slice(0, 30) : '';
    const source = typeof body.source === 'string' ? body.source.slice(0, 100) : 'unknown';

    const sanitizedMessage = sanitizeErrorMessage(message);
    const sanitizedStack = stack ? sanitizeErrorMessage(stack) : undefined;
    const sanitizedComponentStack = componentStack ? sanitizeErrorMessage(componentStack) : undefined;

    console.error(`[FRONTEND ERROR] [${source}] ${sanitizedMessage} | URL: ${url}`);

    await logAudit('client-error-reporter', {
      category: 'config',
      event_type: 'frontend_error',
      severity: 'error',
      actor_id: 'browser',
      actor_name: 'Browser',
      actor_role: 'client',
      channel: 'frontend',
      summary: `Frontend error [${source}]: ${sanitizedMessage.slice(0, 120)}`,
      detail: JSON.stringify({
        stack: sanitizedStack,
        componentStack: sanitizedComponentStack,
        url,
        userAgent,
        timestamp,
      }),
      status: 'logged',
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('client-error endpoint failed:', err);
    res.status(500).json({ error: 'Failed to log error' });
  }
});

const ADMIN_EMAIL = 'admin@example.com';
const JANUS_EMAIL = 'assistant@example.com';

async function deriveKey(masterSecret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(masterSecret), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('club34-credential-vault-v1'), info: enc.encode('aes-gcm-encryption') },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

async function encrypt(plaintext: string, masterSecret: string): Promise<string> {
  const key = await deriveKey(masterSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return Buffer.from(combined).toString('base64');
}

async function decrypt(encryptedB64: string, masterSecret: string): Promise<string> {
  const key = await deriveKey(masterSecret);
  const combined = Buffer.from(encryptedB64, 'base64');
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

router.all('/api/credential-vault', async (req: any, res: any) => {
  try {
    const VAULT_SECRET = process.env.CREDENTIAL_VAULT_SECRET;
    if (!VAULT_SECRET) return res.status(500).json({ error: 'Vault not configured' });

    const db = storage;
    const action = req.query.action || req.body.action;

    if (action === 'save-platform-credential') {
      const { platform, username, password, credential_label } = req.body;
      if (!platform || !username || !password) return res.status(400).json({ error: 'platform, username and password required' });
      const encryptedUsername = await encrypt(username, VAULT_SECRET);
      const encryptedPassword = await encrypt(password, VAULT_SECRET);
      await db.query(
        `INSERT INTO user_platform_credentials (user_id, platform, credential_label, encrypted_username, encrypted_password) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, platform) DO UPDATE SET credential_label = $3, encrypted_username = $4, encrypted_password = $5`,
        [req.user?.id, platform, credential_label || platform, encryptedUsername, encryptedPassword]
      );
      return res.json({ success: true });
    }

    if (action === 'get-platform-credential') {
      const platform = req.query.platform || req.body.platform;
      if (!platform) return res.status(400).json({ error: 'platform required' });
      const { rows } = await db.query(
        `SELECT encrypted_username, encrypted_password FROM user_platform_credentials WHERE user_id = $1 AND platform = $2`,
        [req.user?.id, platform]
      );
      if (!rows?.length) return res.status(404).json({ error: 'Credential not found' });
      const username = await decrypt(rows[0].encrypted_username, VAULT_SECRET);
      const password = await decrypt(rows[0].encrypted_password, VAULT_SECRET);
      return res.json({ username, password });
    }

    if (action === 'save-amazon-settings') {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      const encryptedPassword = await encrypt(password, VAULT_SECRET);
      const { rows: existing } = await db.query(`SELECT id FROM amazon_settings LIMIT 1`);
      if (existing?.length) {
        await db.query(`UPDATE amazon_settings SET amazon_email = $1, encrypted_password = $2, configured_by = $3 WHERE id = $4`, [email, encryptedPassword, req.user?.id, existing[0].id]);
      } else {
        await db.query(`INSERT INTO amazon_settings (amazon_email, encrypted_password, configured_by) VALUES ($1,$2,$3)`, [email, encryptedPassword, req.user?.id]);
      }
      return res.json({ success: true });
    }

    if (action === 'delete-amazon-settings') {
      const { id } = req.body;
      await db.query(`DELETE FROM amazon_settings WHERE id = $1`, [id]);
      return res.json({ success: true });
    }

    if (action === 'get-amazon-password') {
      const { rows } = await db.query(`SELECT encrypted_password FROM amazon_settings LIMIT 1`);
      if (!rows?.length) return res.status(404).json({ error: 'Not found' });
      const password = await decrypt(rows[0].encrypted_password, VAULT_SECRET);
      return res.json({ password });
    }

    res.status(400).json({ error: 'Unknown action' });
  } catch (err: any) {
    console.error('credential-vault error:', err);
    res.status(500).json({ error: err.message });
  }
});

const MAX_ATTEMPTS = FAILED_JOBS_MAX_ATTEMPTS;
const BACKOFF_MINUTES = FAILED_JOBS_BACKOFF_MINUTES;

router.post('/api/failed-job-retry-worker', async (req: any, res: any) => {
  try {
    const db = storage;
    const { rows: jobs } = await db.query(
      `SELECT * FROM failed_jobs WHERE status IN ('pending','retrying') AND attempts < $1 ORDER BY created_at ASC LIMIT 10`,
      [MAX_ATTEMPTS]
    );

    if (!jobs?.length) return res.json({ retried: 0, message: 'No retryable jobs' });

    let retried = 0, dead = 0;
    for (const job of jobs) {
      const attempts = job.attempts || 0;
      const backoffMs = (BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] || 80) * 60_000;
      const lastAttempt = job.last_attempted_at ? new Date(job.last_attempted_at).getTime() : 0;
      if (lastAttempt > 0 && Date.now() - lastAttempt < backoffMs) continue;

      try {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const r = await fetch(`${baseUrl}/api/${job.function_name}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job.payload || {}),
        });

        if (r.ok) {
          await db.query(`UPDATE failed_jobs SET status = 'resolved', attempts = $1, last_attempted_at = $2, resolved_at = $3 WHERE id = $4`, [attempts + 1, new Date().toISOString(), new Date().toISOString(), job.id]);
          retried++;
        } else {
          const newAttempts = attempts + 1;
          if (newAttempts >= MAX_ATTEMPTS) {
            await db.query(`UPDATE failed_jobs SET status = 'dead', attempts = $1, last_attempted_at = $2, error_message = $3 WHERE id = $4`, [newAttempts, new Date().toISOString(), `Exhausted ${MAX_ATTEMPTS} retries. Last HTTP ${r.status}`, job.id]);
            dead++;
            logAudit('failed-job-retry-worker', {
              category: 'system',
              event_type: 'failed_job_exhausted',
              severity: 'error',
              actor_id: 'system',
              actor_name: 'failed-job-retry-worker',
              channel: 'cron',
              summary: `Job ${job.function_name} exhausted ${MAX_ATTEMPTS} retries (HTTP ${r.status})`,
              detail: { job_id: job.id, function_name: job.function_name, attempts: newAttempts, last_status: r.status },
              status: 'error',
              actionable: true,
            }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
          } else {
            await db.query(`UPDATE failed_jobs SET status = 'retrying', attempts = $1, last_attempted_at = $2 WHERE id = $3`, [newAttempts, new Date().toISOString(), job.id]);
          }
        }
      } catch (err: any) {
        const newAttempts = attempts + 1;
        const willBeDead = newAttempts >= MAX_ATTEMPTS;
        await db.query(`UPDATE failed_jobs SET status = $1, attempts = $2, last_attempted_at = $3, error_message = $4 WHERE id = $5`,
          [willBeDead ? 'dead' : 'retrying', newAttempts, new Date().toISOString(), err.message, job.id]);
        if (willBeDead) {
          dead++;
          logAudit('failed-job-retry-worker', {
            category: 'system',
            event_type: 'failed_job_exhausted',
            severity: 'error',
            actor_id: 'system',
            actor_name: 'failed-job-retry-worker',
            channel: 'cron',
            summary: `Job ${job.function_name} exhausted ${MAX_ATTEMPTS} retries (exception: ${err.message?.slice(0, 80)})`,
            detail: { job_id: job.id, function_name: job.function_name, attempts: newAttempts, error: err.message },
            status: 'error',
            actionable: true,
          }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
        }
      }
    }

    res.json({ retried, dead, checked: jobs.length });
  } catch (err: any) {
    console.error('failed-job-retry-worker error:', err);
    res.status(500).json({ error: err.message });
  }
});

const RETENTION_RULES = [
  { table: 'janus_chat_logs', column: 'created_at', days: 90 },
  { table: 'system_audit_log', column: 'created_at', days: 180 },
  { table: 'email_logs', column: 'created_at', days: 90 },
  { table: 'janus_health_logs', column: 'created_at', days: 30 },
  { table: 'failed_jobs', column: 'created_at', days: 60, filter: { column: 'status', values: ['resolved', 'dead'] } },
];

router.post('/api/log-retention-worker', async (req: any, res: any) => {
  try {
    const db = storage;
    const results: any[] = [];
    for (const rule of RETENTION_RULES) {
      try {
        const cutoff = new Date(Date.now() - rule.days * 24 * 60 * 60 * 1000).toISOString();
        let query = `DELETE FROM ${rule.table} WHERE ${rule.column} < $1`;
        const params: any[] = [cutoff];
        if (rule.filter) {
          query += ` AND ${rule.filter.column} = ANY($2)`;
          params.push(rule.filter.values);
        }
        const result = await db.query(query, params);
        results.push({ table: rule.table, deleted: result.rowCount || 0 });
      } catch (e: any) {
        results.push({ table: rule.table, deleted: 0, error: e.message });
      }
    }
    const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
    console.log(`log-retention-worker: purged ${totalDeleted} records`, JSON.stringify(results));
    res.json({ total_deleted: totalDeleted, results });
  } catch (err: any) {
    console.error('log-retention-worker error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/notify-signup', async (req: any, res: any) => {
  try {
    const { userEmail, displayName } = req.body;
    if (!userEmail) return res.status(400).json({ error: 'User email is required' });

    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return res.status(500).json({ error: 'RESEND_API_KEY not configured' });

    const emailResponse = await fetchT('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Club 34 <noreply@example.com>',
        to: [ADMIN_EMAIL],
        subject: 'New Club 34 Signup Request',
        html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #1a1a2e;">New Signup Request</h1>
          <p>A new user has signed up for Club 34 and is awaiting your approval:</p>
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0;"><strong>Name:</strong> ${displayName || 'Not provided'}</p>
            <p style="margin: 10px 0 0;"><strong>Email:</strong> ${userEmail}</p>
          </div>
          <p>Please log in to the Club 34 admin panel to approve or reject this request.</p>
        </div>`,
      }),
    });

    if (!emailResponse.ok) throw new Error(`Resend API returned ${emailResponse.status}`);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error sending signup notification:', error);
    res.status(500).json({ error: error.message });
  }
});

async function getGmailToken(scope: string): Promise<string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not configured');
  const sa = JSON.parse(raw);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: sa.client_email, sub: JANUS_EMAIL, scope, aud: sa.token_uri, iat: now, exp: now + 3600 };
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
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status}`);
  return (await r.json()).access_token;
}

function buildMimeMessage(to: string, subject: string, body: string): string {
  const boundary = 'boundary_' + crypto.randomUUID().replace(/-/g, '');
  const mime = [
    `From: Janus <${JANUS_EMAIL}>`, `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `MIME-Version: 1.0`, `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '', `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', body, '', `--${boundary}--`,
  ].join('\r\n');
  return Buffer.from(mime).toString('base64url');
}

router.post('/api/project-share-notify', async (req: any, res: any) => {
  try {
    const { project_id, shared_with_user_id, shared_by_name, project_name } = req.body;
    if (!project_id || !shared_with_user_id || !shared_by_name || !project_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const db = storage;
    const { rows: members } = await db.query(`SELECT email, display_name FROM household_members WHERE supabase_uuid = $1`, [shared_with_user_id]);
    let recipientEmail = members?.[0]?.email;

    if (!recipientEmail) {
      const { rows: profiles } = await db.query(`SELECT display_name FROM profiles WHERE user_id = $1`, [shared_with_user_id]);
    }

    await db.query(
      `INSERT INTO janus_notifications (user_id, type, message, media_url) VALUES ($1,$2,$3,$4)`,
      [shared_with_user_id, 'project_share', `${shared_by_name} has shared a Janus project with you: "${project_name}".`, `/projects/${project_id}`]
    );

    if (recipientEmail) {
      try {
        const accessToken = await getGmailToken('https://mail.google.com/');
        const subject = `${shared_by_name} shared a Janus project with you`;
        const body = `${shared_by_name} has shared the project "${project_name}" with you.\n\nClick here to access: https://example.com/projects/${project_id}`;
        const raw = buildMimeMessage(recipientEmail, subject, body);
        await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
        });
      } catch (e) { console.error('Email send failed:', e); }
    }

    res.json({ success: true });
  } catch (e: any) {
    console.error('project-share-notify error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/suggest-submit', async (req: any, res: any) => {
  try {
    const { action, content, user_display_name, user_email, suggestion_id } = req.body;
    const db = storage;

    if (action === 'submit') {
      if (!content || !user_email) return res.status(400).json({ error: 'Missing content or user_email' });
      await db.query(
        `INSERT INTO suggestions (user_id, user_display_name, user_email, content) VALUES ($1,$2,$3,$4)`,
        [req.user?.id, user_display_name || user_email, user_email, content]
      );

      try {
        const accessToken = await getGmailToken('https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify');
        const raw1 = buildMimeMessage(ADMIN_EMAIL, `New suggestion from ${user_display_name || user_email}`, `A new suggestion was submitted via Club 34.\n\nFrom: ${user_display_name || user_email} (${user_email})\n\n---\n\n${content}`);
        await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: raw1 }) });
        const raw2 = buildMimeMessage(user_email, 'Your suggestion was received', `Hi ${user_display_name || user_email},\n\nThanks for your suggestion — it's been logged and will be reviewed.\n\n— Club 34`);
        await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: raw2 }) });
      } catch (e) { console.error('Email send failed:', e); }

      return res.json({ success: true });
    }

    if (action === 'notify') {
      if (!suggestion_id) return res.status(400).json({ error: 'Missing suggestion_id' });
      const { rows } = await db.query(`SELECT * FROM suggestions WHERE id = $1`, [suggestion_id]);
      if (!rows?.length) return res.status(404).json({ error: 'Suggestion not found' });
      const suggestion = rows[0];

      try {
        const accessToken = await getGmailToken('https://www.googleapis.com/auth/gmail.send');
        const statusLabel = suggestion.status.charAt(0).toUpperCase() + suggestion.status.slice(1);
        const noteSection = suggestion.admin_note ? `\n\nNote from the team:\n"${suggestion.admin_note}"` : '';
        const raw = buildMimeMessage(suggestion.user_email, 'Update on your Club 34 suggestion',
          `Hi ${suggestion.user_display_name || suggestion.user_email},\n\nYour suggestion has been marked as: ${statusLabel}${noteSection}\n\nYour original suggestion:\n"${suggestion.content}"\n\n— Club 34`);
        await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) });
      } catch (e) { console.error('Email send failed:', e); }

      return res.json({ success: true });
    }

    res.status(400).json({ error: "Unknown action. Use 'submit' or 'notify'." });
  } catch (e: any) {
    console.error('suggest-submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// NOTE: Database is unified under the primary PostgreSQL connection (DATABASE_URL).

// Read-only admin telemetry: snapshot of every registered breaker
// (state, failure count, last failure / success timestamps, next retry
// time, and the resolved config). Used by the admin UI to see at a
// glance whether HA / Tesla / Notion / Gmail are healthy without
// having to chase audit logs.
router.get('/api/admin/circuit-breakers', async (req: any, res: any) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    const providedSecret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    const isAuthorized =
      (cronSecret && providedSecret === cronSecret) ||
      (jwtSecret && providedSecret === jwtSecret) ||
      req.user?.role === 'admin';
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid secret required.' });
    }

    // Force-touch every named breaker so the snapshot includes brand-new
    // ones that haven't had a request yet (state="closed", failures=0).
    const all = getCircuitSnapshot();
    const byName = new Map(all.map((s) => [s.name, s]));
    for (const underlying of UNDERLYING_BREAKER_NAMES) {
      if (!byName.has(underlying)) {
        // Touch via a no-op snapshot lookup of the single name. This
        // initializes the record without consuming the half-open budget.
        const initialized = getCircuitSnapshot(underlying);
        byName.set(initialized.name, initialized);
      }
    }
    res.json({
      breakers: Array.from(byName.values()),
      logical_names: BREAKER_NAMES,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[admin/circuit-breakers] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Force a single breaker back to closed. The normal half-open recovery
// can stay stuck when a Cloudflare Tunnel cold-start hits the upstream's
// own connection timeout on every probe — this lets an operator break
// that loop without a redeploy after they've verified the dependency is
// healthy. Audited.
router.post('/api/admin/circuit-breakers/:name/reset', async (req: any, res: any) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    const providedSecret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    const isAuthorized =
      (cronSecret && providedSecret === cronSecret) ||
      (jwtSecret && providedSecret === jwtSecret) ||
      req.user?.role === 'admin';
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid secret required.' });
    }

    const name = String(req.params.name || '').trim();
    if (!UNDERLYING_BREAKER_NAMES.includes(name)) {
      return res.status(400).json({
        error: `Unknown breaker "${name}". Known: ${UNDERLYING_BREAKER_NAMES.join(', ')}`,
      });
    }

    const before = getCircuitSnapshot(name);
    forceClose(name, 'admin_manual_reset');
    const after = getCircuitSnapshot(name);

    logAudit('admin-breaker-reset', {
      category: 'system',
      event_type: 'circuit_breaker_reset',
      severity: 'info',
      actor_id: req.user?.id || 'system',
      actor_name: req.user?.name || 'admin',
      channel: 'admin',
      summary: `Circuit "${name}" force-closed (was ${before.state})`,
      detail: { name, before_state: before.state, after_state: after.state, failures_cleared: before.failures },
      status: 'success',
      actionable: false,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json({ ok: true, before, after });
  } catch (err: any) {
    console.error('[admin/circuit-breakers/reset] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// LLM usage / cost aggregations. Reads from janus_llm_usage (one row
// per OpenRouter completion). Supports group_by ∈ { user, channel,
// model, tier, day }, plus optional since / until ISO bounds. Default
// window is the trailing 7 days. Returns a flat aggregation by the
// requested key plus the global totals.
router.get('/api/admin/llm-usage', async (req: any, res: any) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    const providedSecret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    const isAuthorized =
      (cronSecret && providedSecret === cronSecret) ||
      (jwtSecret && providedSecret === jwtSecret) ||
      req.user?.role === 'admin';
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid secret required.' });
    }

    const groupBy = String(req.query.group_by || 'day');
    const allowed: Record<string, string> = {
      user: 'user_id',
      channel: 'channel',
      model: 'model',
      tier: 'tier',
      day: "date_trunc('day', created_at)::date::text",
    };
    if (!(groupBy in allowed)) {
      return res.status(400).json({ error: `group_by must be one of: ${Object.keys(allowed).join(', ')}` });
    }
    const groupExpr = allowed[groupBy];

    const now = new Date();
    const defaultSince = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const since = req.query.since ? new Date(String(req.query.since)) : defaultSince;
    const until = req.query.until ? new Date(String(req.query.until)) : now;
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return res.status(400).json({ error: 'since / until must be ISO datetimes' });
    }

    const params = [since.toISOString(), until.toISOString()];

    const totalsQ = `
      SELECT
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COUNT(*)::bigint AS calls
      FROM janus_llm_usage
      WHERE created_at >= $1 AND created_at < $2`;
    const rowsQ = `
      SELECT
        ${groupExpr} AS key,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COUNT(*)::bigint AS calls
      FROM janus_llm_usage
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY ${groupExpr}
      ORDER BY cost_usd DESC NULLS LAST, calls DESC
      LIMIT 200`;
    const byModelQ = `
      SELECT
        model AS key,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COUNT(*)::bigint AS calls
      FROM janus_llm_usage
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY model
      ORDER BY cost_usd DESC NULLS LAST, calls DESC
      LIMIT 20`;
    const byChannelQ = `
      SELECT
        channel AS key,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
        COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
        COUNT(*)::bigint AS calls
      FROM janus_llm_usage
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY channel
      ORDER BY cost_usd DESC NULLS LAST, calls DESC
      LIMIT 20`;

    const [{ rows: totalsRows }, { rows: rows }, { rows: byModelRows }, { rows: byChannelRows }] = await Promise.all([
      storage.query(totalsQ, params),
      storage.query(rowsQ, params),
      storage.query(byModelQ, params),
      storage.query(byChannelQ, params),
    ]);

    const total = totalsRows[0] || { cost_usd: 0, tokens: 0, calls: 0 };
    res.json({
      window: { since: since.toISOString(), until: until.toISOString() },
      group_by: groupBy,
      total: {
        cost_usd: Number(total.cost_usd) || 0,
        tokens: Number(total.tokens) || 0,
        calls: Number(total.calls) || 0,
      },
      rows: rows.map((r: any) => ({
        key: r.key,
        cost_usd: Number(r.cost_usd) || 0,
        tokens: Number(r.tokens) || 0,
        calls: Number(r.calls) || 0,
      })),
      by_model: byModelRows.map((r: any) => ({
        key: r.key,
        cost_usd: Number(r.cost_usd) || 0,
        tokens: Number(r.tokens) || 0,
        calls: Number(r.calls) || 0,
      })),
      by_channel: byChannelRows.map((r: any) => ({
        key: r.key,
        cost_usd: Number(r.cost_usd) || 0,
        tokens: Number(r.tokens) || 0,
        calls: Number(r.calls) || 0,
      })),
    });
  } catch (err: any) {
    console.error('[admin/llm-usage] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Follow-up queue: rows that earlier audit-log writes flagged as
// "actionable=true". Right now four event types flag themselves:
// circuit_breaker_state→open, token_expiry_warning, hallucination_guard,
// failed_job_exhausted. Anything else stays false.
router.get('/api/admin/actionable-audit', async (req: any, res: any) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    const providedSecret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    const isAuthorized =
      (cronSecret && providedSecret === cronSecret) ||
      (jwtSecret && providedSecret === jwtSecret) ||
      req.user?.role === 'admin';
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid secret required.' });
    }

    const now = new Date();
    const defaultSince = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const since = req.query.since ? new Date(String(req.query.since)) : defaultSince;
    const until = req.query.until ? new Date(String(req.query.until)) : now;
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) {
      return res.status(400).json({ error: 'since / until must be ISO datetimes' });
    }
    const eventTypeFilter = req.query.event_type ? String(req.query.event_type) : null;

    const filters: string[] = ['actionable = true', 'created_at >= $1', 'created_at < $2'];
    const params: unknown[] = [since.toISOString(), until.toISOString()];
    if (eventTypeFilter) {
      filters.push(`event_type = $${params.length + 1}`);
      params.push(eventTypeFilter);
    }
    const whereClause = filters.join(' AND ');

    const totalQ = `SELECT COUNT(*)::bigint AS total FROM system_audit_log WHERE ${whereClause}`;
    const byEventQ = `
      SELECT event_type, COUNT(*)::bigint AS count
      FROM system_audit_log
      WHERE ${whereClause}
      GROUP BY event_type
      ORDER BY count DESC
      LIMIT 50`;
    const recentQ = `
      SELECT id, created_at, event_type, category, severity, summary, detail, correlation_id
      FROM system_audit_log
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT 50`;

    const [{ rows: totalRows }, { rows: byEventRows }, { rows: recentRows }] = await Promise.all([
      storage.query(totalQ, params),
      storage.query(byEventQ, params),
      storage.query(recentQ, params),
    ]);

    res.json({
      window: { since: since.toISOString(), until: until.toISOString() },
      total: Number(totalRows[0]?.total) || 0,
      by_event_type: byEventRows.map((r: any) => ({ event_type: r.event_type, count: Number(r.count) || 0 })),
      recent: recentRows,
    });
  } catch (err: any) {
    console.error('[admin/actionable-audit] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Resolve = the admin looked at it and considers it handled. Flips
// actionable=false and writes a follow-up audit row so the resolution
// itself is traceable.
router.post('/api/admin/actionable-audit/:id/resolve', async (req: any, res: any) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const jwtSecret = process.env.JWT_SECRET || process.env.SESSION_SECRET;
    const providedSecret = req.headers['x-cron-secret'] || req.headers['authorization']?.replace('Bearer ', '');
    const isAuthorized =
      (cronSecret && providedSecret === cronSecret) ||
      (jwtSecret && providedSecret === jwtSecret) ||
      req.user?.role === 'admin';
    if (!isAuthorized) {
      return res.status(403).json({ error: 'Unauthorized. Admin access or valid secret required.' });
    }

    const id = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'id must be a uuid' });
    }

    const { rows } = await storage.query(
      `UPDATE system_audit_log
       SET actionable = false
       WHERE id = $1 AND actionable = true
       RETURNING id, event_type, summary`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'row not found or already resolved' });
    }

    // Audit the resolution itself.
    logAudit('admin-actionable-resolve', {
      category: 'system',
      event_type: 'audit_row_resolved',
      severity: 'info',
      actor_id: req.user?.userId || 'system',
      actor_name: req.user?.displayName || 'admin',
      channel: 'admin',
      summary: `Resolved actionable audit row ${id} (${rows[0].event_type})`,
      detail: { resolved_id: id, resolved_event_type: rows[0].event_type, resolved_summary: rows[0].summary },
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    res.json({ resolved: rows[0] });
  } catch (err: any) {
    console.error('[admin/actionable-audit/resolve] error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
