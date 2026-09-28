import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit } from '../lib/auditLog.js';
import { fetchT } from '../lib/fetchWithTimeout.js';
import { query } from '../lib/db.js';
import type { AutomationStatusRow, ProfileDisplayNameRow } from '../../shared/dbRows.js';
import { sendWhatsApp } from '../lib/helpers.js';

const router = Router();

async function callHA(body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const haUrl = process.env.HA_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) throw new Error('HA_URL or HA_TOKEN not configured');

  const { domain, service, service_data } = body as { domain: string; service: string; service_data?: any };
  const url = `${haUrl.replace(/\/$/, '')}/api/services/${domain}/${service}`;
  const res = await fetchT(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(service_data || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function callHAWithRetry(
  body: Record<string, unknown>,
  label: string,
  maxAttempts = 3,
): Promise<{ status: number; data: any }> {
  let lastResult: { status: number; data: any } = { status: 500, data: {} };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await callHA(body);
    if (lastResult.status < 400) return lastResult;
    console.warn(`${label} attempt ${attempt}/${maxAttempts} failed: HTTP ${lastResult.status}`);
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 2000));
  }
  return lastResult;
}

// Direct HA helper entity control — bypasses Google Assistant entirely.
// Architecture in this HA instance:
//   input_boolean.sauna_power  → controls power on/off
//   input_number.sauna_target_temp → sets target temperature (°F)
// The old approach called google_assistant_sdk.send_text_command, which caused HA
// to resolve "Sauna" as the room/area (lights), not the SaunaLogic heater.
// The HA automations saunalogic_power_on_via_google / saunalogic_set_temperature_via_google
// also go through Google Assistant — we skip those by writing the helpers directly.
const SAUNA_POWER_ENTITY = process.env.HA_SAUNA_POWER_ENTITY || 'input_boolean.sauna_power';
const SAUNA_TEMP_ENTITY  = process.env.HA_SAUNA_TEMP_ENTITY  || 'input_number.sauna_target_temp';

async function saunaPowerOn(maxAttempts = 3): Promise<{ status: number; data: any }> {
  return callHAWithRetry({
    domain: 'input_boolean',
    service: 'turn_on',
    service_data: { entity_id: SAUNA_POWER_ENTITY },
  }, `saunaPowerOn(${SAUNA_POWER_ENTITY})`, maxAttempts);
}

async function saunaSetTemp(tempF: number, maxAttempts = 3): Promise<{ status: number; data: any }> {
  return callHAWithRetry({
    domain: 'input_number',
    service: 'set_value',
    service_data: { entity_id: SAUNA_TEMP_ENTITY, value: tempF },
  }, `saunaSetTemp(${SAUNA_TEMP_ENTITY}, ${tempF})`, maxAttempts);
}

async function saunaPowerOff(maxAttempts = 3): Promise<{ status: number; data: any }> {
  return callHAWithRetry({
    domain: 'input_boolean',
    service: 'turn_off',
    service_data: { entity_id: SAUNA_POWER_ENTITY },
  }, `saunaPowerOff(${SAUNA_POWER_ENTITY})`, maxAttempts);
}


async function getAutomation(name: string): Promise<AutomationStatusRow | null> {
  const { rows } = await query<AutomationStatusRow>(`SELECT id, is_active FROM family_automations WHERE name = $1 LIMIT 1`, [name]);
  return rows.length > 0 ? rows[0] : null;
}

async function logAutomationRun(automationId: string, status: string, output: any, errorMessage?: string) {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO family_automation_logs (automation_id, status, output, error_message, started_at, completed_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [automationId, status, JSON.stringify(output), errorMessage || null, now, now]
  );
}

async function updateAutomationLastRun(automationId: string) {
  await query(`UPDATE family_automations SET last_run_at = $1 WHERE id = $2`, [new Date().toISOString(), automationId]);
}

router.post('/morning-sauna', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  let automationId: string | null = null;
  const automation = await getAutomation('Morning Sauna');
  if (automation) {
    if (!automation.is_active) {
      const output = { skipped: true, reason: 'Vacation mode is ON (automation disabled)' };
      console.log('morning-sauna: skipped —', output.reason);

      await logAutomationRun(automation.id, 'skipped', output);

      logAudit('morning-sauna', {
        category: 'automation', event_type: 'morning_sauna_skip', severity: 'info',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: 'Morning Sauna skipped: vacation mode', status: 'success',
      });

      res.json(output);
      return;
    }
    automationId = automation.id;
  } else {
    res.status(404).json({ error: 'Morning Sauna automation not found in DB' });
    return;
  }

  try {
    // Force-toggle the power helper regardless of current state.
    // The HA automation 'saunalogic_power_on_via_google' triggers on state CHANGE (off → on).
    // If the helper is stuck 'on' from a previous session (heater finished but helper never reset),
    // a plain turn_on is a no-op and the Google Assistant command never fires.
    // Fix: always turn_off first, wait for HA to register the change, then turn_on.
    const rOff = await saunaPowerOff();
    console.log('sauna force-toggle off:', rOff.status);
    await new Promise((r) => setTimeout(r, 4000)); // 4s: let power-off HA automation + Google finish before turning on

    const r1 = await saunaPowerOn();
    console.log('sauna power on:', r1.status);

    const r2 = await saunaSetTemp(190);
    console.log('sauna set temp 190:', r2.status);

    const commands = [
      { command: 'input_boolean.sauna_power → force-toggle (off→on)', status: r1.status },
      { command: 'input_number.sauna_target_temp → 190', status: r2.status },
    ];
    const failedCommands = commands.filter(c => c.status >= 400);
    const allFailed = failedCommands.length === commands.length;
    const anyFailed = failedCommands.length > 0;

    const output = {
      action: anyFailed ? (allFailed ? 'sauna_failed' : 'sauna_partial') : 'sauna_started',
      commands,
    };

    if (allFailed) {
      const errorMsg = `All HA commands failed (${failedCommands.map(c => `${c.command}: HTTP ${c.status}`).join('; ')})`;
      console.error('morning-sauna FAILED:', errorMsg);

      if (automationId) {
        await logAutomationRun(automationId, 'error', output, errorMsg);
      }

      logAudit('morning-sauna', {
        category: 'automation', event_type: 'morning_sauna_error', severity: 'error',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: `Morning Sauna FAILED: ${failedCommands[0].status === 401 ? 'HA auth rejected (401)' : `HTTP ${failedCommands[0].status}`}`,
        detail: output, status: 'error',
      });

      res.status(502).json(output);
      return;
    }

    if (anyFailed) {
      const errorMsg = `Some commands failed: ${failedCommands.map(c => `${c.command}: HTTP ${c.status}`).join('; ')}`;
      console.warn('morning-sauna partial:', errorMsg);

      if (automationId) {
        await logAutomationRun(automationId, 'partial', output, errorMsg);
      }

      logAudit('morning-sauna', {
        category: 'automation', event_type: 'morning_sauna', severity: 'warning',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: `Morning Sauna partial: ${errorMsg.slice(0, 100)}`,
        detail: output, status: 'partial',
      });
    } else {
      console.log('morning-sauna result:', JSON.stringify(output));

      if (automationId) {
        await logAutomationRun(automationId, 'success', output);
        await updateAutomationLastRun(automationId);
      }

      logAudit('morning-sauna', {
        category: 'automation', event_type: 'morning_sauna', severity: 'info',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: 'Morning Sauna started successfully',
        detail: output, status: 'success',
      });
    }

    res.json(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('morning-sauna error:', msg);

    if (automationId) {
      await logAutomationRun(automationId, 'error', {}, msg);
    }

    logAudit('morning-sauna', {
      category: 'automation', event_type: 'morning_sauna_error', severity: 'error',
      actor_id: 'system', channel: 'cron',
      summary: `Morning Sauna error: ${msg.slice(0, 100)}`, status: 'error',
    });

    res.status(500).json({ error: msg });
  }
});

router.post('/morning-sauna/stop', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  const automation = await getAutomation('Morning Sauna');
  if (!automation) {
    res.status(404).json({ error: 'Morning Sauna automation not found in DB' });
    return;
  }

  try {
    // Do not vacation-gate the scheduled stop. If vacation mode is enabled
    // after a run starts, the corresponding safety shutoff must still happen.
    const result = await saunaPowerOff();
    const command = {
      command: `${SAUNA_POWER_ENTITY} → turn_off`,
      status: result.status,
    };
    const outcome =
      result.status >= 400 ? 'failed'
      : result.status >= 300 ? 'partial'
      : result.status === 204 ? 'skipped'
      : 'success';
    const output = {
      action: 'sauna_scheduled_stop',
      outcome,
      scheduledRuntimeMinutes: 30,
      commands: [command],
    };

    if (outcome === 'failed') {
      const errorMsg = `Automatic sauna shutoff failed: ${command.command} returned HTTP ${command.status}`;
      console.error('morning-sauna scheduled stop FAILED:', errorMsg);
      await logAutomationRun(automation.id, 'error', output, errorMsg);
      logAudit('morning-sauna', {
        category: 'automation', event_type: 'morning_sauna_scheduled_stop', severity: 'error',
        actor_id: 'system', actor_name: 'Cron', channel: 'cron',
        summary: `Morning Sauna automatic shutoff failed (HTTP ${command.status})`,
        detail: output, status: 'error',
      });
      res.status(502).json(output);
      return;
    }

    const logStatus = outcome === 'partial' ? 'partial' : outcome;
    const summary =
      outcome === 'partial'
        ? `Morning Sauna automatic shutoff returned HTTP ${command.status}`
        : outcome === 'skipped'
          ? 'Morning Sauna automatic shutoff completed with no response body'
          : 'Morning Sauna automatically stopped after 30 minutes';
    console.log(`morning-sauna scheduled stop ${outcome}:`, JSON.stringify(output));
    await logAutomationRun(automation.id, logStatus, output);
    logAudit('morning-sauna', {
      category: 'automation',
      event_type: 'morning_sauna_scheduled_stop',
      severity: outcome === 'partial' ? 'warning' : 'info',
      actor_id: 'system',
      actor_name: 'Cron',
      channel: 'cron',
      summary,
      detail: output,
      status: outcome,
    });
    res.json(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const output = {
      action: 'sauna_scheduled_stop',
      outcome: 'failed',
      scheduledRuntimeMinutes: 30,
      commands: [],
    };
    console.error('morning-sauna scheduled stop error:', msg);
    await logAutomationRun(automation.id, 'error', output, msg);
    logAudit('morning-sauna', {
      category: 'automation', event_type: 'morning_sauna_scheduled_stop', severity: 'error',
      actor_id: 'system', actor_name: 'Cron', channel: 'cron',
      summary: `Morning Sauna automatic shutoff error: ${msg.slice(0, 100)}`,
      detail: output, status: 'error',
    });
    res.status(500).json({ ...output, error: msg });
  }
});

router.post('/morning-sauna/control', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action } = req.body as { action: 'start' | 'stop' };
    if (!action || !['start', 'stop'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Must be "start" or "stop".' });
      return;
    }

    const results: { command: string; status: number }[] = [];

    if (action === 'start') {
      // Force-toggle: always turn off first so the state-change event fires in HA.
      // If the helper is stuck 'on', a plain turn_on is a no-op and the heater won't start.
      await saunaPowerOff();
      await new Promise((r) => setTimeout(r, 4000)); // 4s: allow power-off HA automation + Google to finish before turning on
      const r1 = await saunaPowerOn();
      results.push({ command: 'sauna_power force-toggle (off→on)', status: r1.status });
      const r2 = await saunaSetTemp(190);
      results.push({ command: 'sauna_target_temp 190', status: r2.status });
    } else {
      const r1 = await saunaPowerOff();
      results.push({ command: 'sauna_power off', status: r1.status });
    }

    const failedCommands = results.filter(r => r.status >= 400);
    const allFailed = failedCommands.length === results.length;

    let actorName = 'UNKNOWN';
    if (req.userId && req.userId !== 'system') {
      try {
        const { rows } = await query<ProfileDisplayNameRow>(`SELECT display_name FROM profiles WHERE user_id = $1 LIMIT 1`, [req.userId]);
        if (rows[0]?.display_name) actorName = rows[0].display_name;
      } catch {}
    }

    const automation = await getAutomation('Morning Sauna');
    if (automation && action === 'start' && failedCommands.length === 0) {
      await logAutomationRun(automation.id, 'success', { action: 'manual_sauna_start', manual: true });
      await updateAutomationLastRun(automation.id);
    }

    logAudit('morning-sauna', {
      category: 'automation',
      event_type: `morning_sauna_manual_${action}`,
      severity: failedCommands.length > 0 ? 'error' : 'info',
      actor_id: req.userId || 'UNKNOWN',
      actor_name: actorName,
      channel: 'dashboard',
      summary: failedCommands.length > 0
        ? `Sauna ${action} failed: ${failedCommands.map(f => `${f.command} (${f.status})`).join(', ')}`
        : `Sauna manually ${action === 'start' ? 'started' : 'stopped'}`,
      detail: { results },
      status: allFailed ? 'error' : failedCommands.length > 0 ? 'partial' : 'success',
    });

    if (allFailed) {
      res.status(502).json({
        error: `Sauna ${action} failed — Home Assistant returned errors. Check that ${SAUNA_POWER_ENTITY} and ${SAUNA_TEMP_ENTITY} exist in HA.`,
        results,
      });
      return;
    }

    res.json({
      ok: true,
      action,
      results,
      partial: failedCommands.length > 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`sauna control error (${req.body?.action}):`, msg);
    res.status(500).json({ error: msg });
  }
});

router.post('/morning-sauna/log-manual', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { action } = req.body as { action: string };
    if (!action || !['start', 'stop'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Must be "start" or "stop".' });
      return;
    }

    const automation = await getAutomation('Morning Sauna');

    if (automation) {
      const output = { action: `manual_sauna_${action}`, manual: true };
      await logAutomationRun(automation.id, 'success', output);
      if (action === 'start') {
        await updateAutomationLastRun(automation.id);
      }
    }

    const summary = action === 'start'
      ? 'Morning Sauna manually started'
      : 'Morning Sauna manually turned off';

    let actorName = 'UNKNOWN';
    if (req.userId && req.userId !== 'system') {
      try {
        const { rows } = await query<ProfileDisplayNameRow>(`SELECT display_name FROM profiles WHERE user_id = $1 LIMIT 1`, [req.userId]);
        if (rows[0]?.display_name) actorName = rows[0].display_name;
      } catch {}
    } else if (req.userId === 'system') {
      actorName = 'system';
    }

    logAudit('morning-sauna', {
      category: 'automation',
      event_type: `morning_sauna_manual_${action}`,
      severity: 'info',
      actor_id: req.userId || 'UNKNOWN',
      actor_name: actorName,
      channel: 'dashboard',
      summary,
      status: 'success',
    });

    res.json({ logged: true, action });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('manual sauna log error:', msg);
    res.status(500).json({ error: msg });
  }
});

const INTERNAL_SECRET = process.env.INTERNAL_WEBHOOK_SECRET || '';

router.post('/internal/github-push-failure', async (req: Request, res: Response) => {
  if (!INTERNAL_SECRET) {
    res.status(503).json({ error: 'INTERNAL_WEBHOOK_SECRET not configured — endpoint disabled' });
    return;
  }
  const secret = req.headers['x-internal-secret'];
  if (secret !== INTERNAL_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { error_output = '', exit_code = 'unknown', cause = 'unknown' } = req.body as {
    error_output?: string;
    exit_code?: string | number;
    cause?: string;
  };

  const truncatedOutput = String(error_output).slice(0, 500);
  const summary = `🚨 GitHub Push FAILED (exit ${exit_code}): ${cause}`;

  logAudit('github-push', {
    category: 'automation',
    event_type: 'github_push_failure',
    severity: 'critical',
    actor_id: 'system',
    actor_name: 'post-merge',
    channel: 'cron',
    summary,
    detail: { exit_code, cause, error_output: truncatedOutput },
    status: 'error',
  }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

  const whatsappMsg =
    `🚨 *GitHub Push Failed*\n\n` +
    `Repo: ${process.env.GITHUB_REPO || 'household-os'}\n` +
    `Exit code: ${exit_code}\n` +
    `Cause: ${cause}\n\n` +
    (truncatedOutput ? `Output:\n${truncatedOutput.slice(0, 300)}\n\n` : '') +
    `Cloudflare Pages deploy is NOT running. Frontend is stale.\n\n` +
    `Fix: Check repository permissions and GITHUB_TOKEN.`;

  let whatsappOk = true;
  try {
    await sendWhatsApp(whatsappMsg);
  } catch (e: unknown) {
    whatsappOk = false;
    console.error('[github-push-failure] WhatsApp send error:', e);
  }

  console.error(`[github-push-failure] Push failed — exit ${exit_code}, cause: ${cause}`);
  if (!whatsappOk) {
    res.status(207).json({ logged: true, whatsapp: false, warning: 'audit logged but WhatsApp send failed' });
    return;
  }
  res.json({ logged: true, whatsapp: true });
});

export default router;
