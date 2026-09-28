/**
 * Server-side Workflow Trigger Reconciler
 *
 * Periodically checks that every Janus workflow rule's HA automation(s)
 * still exist in Home Assistant. If any are missing they are re-deployed
 * automatically so physical-switch sync keeps working after HA restarts.
 *
 * The set of rules is automatically derived from `shared/workflowRules.ts`
 * (the same source the frontend uses) so adding a new rule there
 * immediately makes it self-healing — no separate server-side update needed.
 *
 * Called by the /api/ha-workflow-reconciler cron route (every 30 min).
 */

import { logAudit } from './auditLog.js';
import { query } from './db.js';
import { getEntityCache, isCacheReady } from './haWebSocket.js';
import {
  WORKFLOW_RULES,
  resolveWorkflow,
  buildForwardAutomationConfig,
  buildReverseAutomationConfig,
  type WorkflowRule,
  type HAEntityLike,
} from '../../shared/workflowRules.js';

const HA_URL = () => process.env.HA_URL ?? '';
const HA_TOKEN = () => process.env.HA_TOKEN ?? '';

// ── Low-level HA HTTP helper ──────────────────────────────────────────────────

async function haFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const url = `${HA_URL().replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${HA_TOKEN()}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function getEntities(): HAEntityLike[] {
  return getEntityCache() as HAEntityLike[];
}

// ── HA automation state lookup ────────────────────────────────────────────────

export async function fetchAutomationMap(): Promise<Map<string, string>> {
  const { status, data } = await haFetch('GET', '/api/states');
  if (status !== 200 || !Array.isArray(data)) {
    throw new Error(`HA /api/states returned HTTP ${status}`);
  }
  const map = new Map<string, string>();
  for (const e of data as Array<{ entity_id?: string; state?: string; attributes?: { id?: string } }>) {
    if (!e?.entity_id?.startsWith('automation.')) continue;
    const cfgId = e.attributes?.id;
    if (cfgId && typeof e.state === 'string') map.set(cfgId, e.state);
  }
  return map;
}

// ── Dedup: how many times has this rule been redeployed in the last hour? ────

const REPEATED_REDEPLOY_THRESHOLD = 3;
const REPEATED_REDEPLOY_WINDOW_MINUTES = 60;
const REPEATED_ALERT_DEDUP_MINUTES = 120;

async function countRecentRedeployAudits(ruleId: string): Promise<number> {
  try {
    const { rows } = await query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM system_audit_log
       WHERE event_type = 'workflow_trigger_redeployed'
         AND detail->>'rule_id' = $1
         AND created_at > NOW() - INTERVAL '${REPEATED_REDEPLOY_WINDOW_MINUTES} minutes'`,
      [ruleId],
    );
    return parseInt(rows[0]?.cnt ?? '0', 10);
  } catch {
    return 0;
  }
}

async function hasRecentRepeatAlert(ruleId: string): Promise<boolean> {
  try {
    const { rows } = await query(
      `SELECT id FROM system_audit_log
       WHERE event_type = 'workflow_trigger_repeat_redeploy'
         AND detail->>'rule_id' = $1
         AND created_at > NOW() - INTERVAL '${REPEATED_ALERT_DEDUP_MINUTES} minutes'
       LIMIT 1`,
      [ruleId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

// ── Deploy helper ─────────────────────────────────────────────────────────────

async function deployAutomation(configId: string, config: object): Promise<void> {
  const { status } = await haFetch('POST', `/api/config/automation/config/${configId}`, config);
  if (status < 200 || status >= 300) {
    throw new Error(`HA returned HTTP ${status} when deploying ${configId}`);
  }
}

async function reloadAutomations(): Promise<void> {
  const { status } = await haFetch('POST', '/api/services/automation/reload', {});
  if (status < 200 || status >= 300) {
    throw new Error(`HA returned HTTP ${status} on automation reload`);
  }
}

// ── Main reconcile function ───────────────────────────────────────────────────

export interface ReconcileResult {
  checked: number;
  redeployed: { ruleId: string; automationId: string }[];
  skipped: { ruleId: string; reason: string }[];
  errors: { ruleId: string; error: string }[];
}

async function reconcileRule(
  rule: WorkflowRule,
  automations: Map<string, string>,
  entities: HAEntityLike[],
  result: ReconcileResult,
): Promise<boolean> {
  const forwardId = `janus_${rule.id}`;
  const reverseId = `janus_${rule.id}__reverse`;

  const forwardExists = automations.has(forwardId);
  const reverseExists = !rule.bidirectional || automations.has(reverseId);

  if (forwardExists && reverseExists) {
    console.log(`[WorkflowReconciler] Rule "${rule.id}" — both automations present ✓`);
    return false;
  }

  const missing = [
    ...(!forwardExists ? [forwardId] : []),
    ...(rule.bidirectional && !reverseExists ? [reverseId] : []),
  ];
  console.log(`[WorkflowReconciler] Rule "${rule.id}" — missing: ${missing.join(', ')} — re-deploying`);

  if (entities.length === 0) {
    const reason = 'HA entity cache not ready — cannot resolve entities for deploy';
    console.warn(`[WorkflowReconciler] ${reason}`);
    result.skipped.push({ ruleId: rule.id, reason });
    return false;
  }

  // Use the shared resolver — same logic as the frontend uses to deploy.
  const resolved = resolveWorkflow(rule, entities);
  if (!resolved) {
    const reason = 'Could not resolve trigger/target entities (rule resolveWorkflow returned null)';
    console.warn(`[WorkflowReconciler] Rule "${rule.id}" skipped: ${reason}`);
    result.skipped.push({ ruleId: rule.id, reason });
    return false;
  }

  let deployedAny = false;
  let reloadNeeded = false;

  if (!forwardExists) {
    try {
      const config = buildForwardAutomationConfig(resolved);
      await deployAutomation(forwardId, config);
      reloadNeeded = true;
      deployedAny = true;
      result.redeployed.push({ ruleId: rule.id, automationId: forwardId });
      console.log(`[WorkflowReconciler] ✓ Deployed ${forwardId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[WorkflowReconciler] Failed to deploy ${forwardId}:`, msg);
      result.errors.push({ ruleId: rule.id, error: `${forwardId}: ${msg}` });
    }
  }

  if (rule.bidirectional && !reverseExists) {
    if (
      !resolved.reverseTriggerEntityId ||
      !resolved.reverseTargetEntityIds ||
      resolved.reverseTargetEntityIds.length === 0
    ) {
      const reason = 'Reverse trigger/target entity not found — skipping reverse automation';
      console.warn(`[WorkflowReconciler] Rule "${rule.id}": ${reason}`);
      result.skipped.push({ ruleId: rule.id, reason });
    } else {
      try {
        const config = buildReverseAutomationConfig(resolved);
        await deployAutomation(reverseId, config);
        reloadNeeded = true;
        deployedAny = true;
        result.redeployed.push({ ruleId: rule.id, automationId: reverseId });
        console.log(`[WorkflowReconciler] ✓ Deployed ${reverseId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WorkflowReconciler] Failed to deploy ${reverseId}:`, msg);
        result.errors.push({ ruleId: rule.id, error: `${reverseId}: ${msg}` });
      }
    }
  }

  if (deployedAny) {
    await logAudit('workflow-reconciler', {
      category: 'automations',
      event_type: 'workflow_trigger_redeployed',
      severity: 'warn',
      actor_id: 'system',
      actor_name: 'Workflow Reconciler',
      channel: 'cron',
      summary: `Auto-redeployed missing HA automations for rule "${rule.name}" (${missing.join(', ')})`,
      detail: { rule_id: rule.id, rule_name: rule.name, missing_automations: missing },
      status: 'success',
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));

    const recentCount = await countRecentRedeployAudits(rule.id);
    if (recentCount >= REPEATED_REDEPLOY_THRESHOLD) {
      const alreadyAlerted = await hasRecentRepeatAlert(rule.id);
      if (!alreadyAlerted) {
        console.warn(
          `[WorkflowReconciler] Rule "${rule.id}" has been redeployed ${recentCount} times ` +
          `in the last ${REPEATED_REDEPLOY_WINDOW_MINUTES} min — raising smart alert`,
        );
        await logAudit('workflow-reconciler', {
          category: 'automations',
          event_type: 'workflow_trigger_repeat_redeploy',
          severity: 'critical',
          actor_id: 'system',
          actor_name: 'Workflow Reconciler',
          channel: 'cron',
          summary: `⚠️ Rule "${rule.name}" has needed ${recentCount} auto-redeploys in ${REPEATED_REDEPLOY_WINDOW_MINUTES} min — something deeper may be wrong`,
          detail: {
            rule_id: rule.id,
            rule_name: rule.name,
            redeploy_count: recentCount,
            window_minutes: REPEATED_REDEPLOY_WINDOW_MINUTES,
          },
          status: 'error',
        }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
      }
    }
  }

  return reloadNeeded;
}

export async function reconcileWorkflowTriggers(): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, redeployed: [], skipped: [], errors: [] };

  if (!HA_URL() || !HA_TOKEN()) {
    console.log('[WorkflowReconciler] HA not configured — skipping');
    return result;
  }

  let automations: Map<string, string>;
  try {
    automations = await fetchAutomationMap();
  } catch (err) {
    console.error('[WorkflowReconciler] Failed to fetch HA automations:', err);
    result.errors.push({ ruleId: 'all', error: err instanceof Error ? err.message : String(err) });
    return result;
  }

  const entities = isCacheReady() ? getEntities() : [];
  let reloadNeeded = false;

  // Iterate every rule defined in the shared source of truth. Adding a new
  // rule to WORKFLOW_RULES automatically makes it self-healing.
  for (const rule of WORKFLOW_RULES) {
    if (rule.enabled === false) continue;
    result.checked++;
    const ruleNeedsReload = await reconcileRule(rule, automations, entities, result);
    if (ruleNeedsReload) reloadNeeded = true;
  }

  if (reloadNeeded) {
    try {
      await reloadAutomations();
      console.log('[WorkflowReconciler] HA automations reloaded — new configs are live');
    } catch (err) {
      console.warn('[WorkflowReconciler] Automation reload failed (configs written but may not be active yet):', err);
    }
  }

  return result;
}
