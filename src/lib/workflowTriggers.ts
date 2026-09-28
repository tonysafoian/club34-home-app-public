/**
 * Workflow Triggers — event-driven automations defined in Janus
 * and deployed to Home Assistant for server-side execution.
 *
 * Rule definitions (the source of truth) live in `shared/workflowRules.ts`
 * so the server-side reconciler can auto-heal every rule without a separate
 * sync. This file only owns frontend-only concerns: deploying to HA via
 * the in-app proxy, and querying live HA automation status for the UI.
 */

import { haProxy, HAEntity } from '@/lib/api/homeAssistant';
import {
  WORKFLOW_RULES,
  resolveWorkflow,
  buildForwardAutomationConfig,
  buildReverseAutomationConfig,
  type WorkflowRule,
  type ResolvedWorkflow,
} from '@shared/workflowRules';

export {
  WORKFLOW_RULES,
  resolveWorkflow,
  type WorkflowRule,
  type ResolvedWorkflow,
};

// ── Deploy to Home Assistant ─────────────────────────────────────────────

/**
 * Deploy a workflow rule as native HA automation(s).
 * For bidirectional rules, two automations are deployed:
 *   1. `janus_{rule.id}`           — forward (primary trigger → targets)
 *   2. `janus_{rule.id}__reverse`  — reverse (secondary trigger → primary)
 *
 * Returns the resolved entity details on success.
 */
export async function deployWorkflowToHA(
  rule: WorkflowRule,
  allEntities: HAEntity[],
): Promise<ResolvedWorkflow> {
  const resolved = resolveWorkflow(rule, allEntities);
  if (!resolved) {
    throw new Error('Could not resolve trigger/target entities — check that the lights exist in HA');
  }

  const forwardId = `janus_${rule.id}`;
  const forwardConfig = buildForwardAutomationConfig(resolved);
  await haProxy(`/api/config/automation/config/${forwardId}`, 'POST', forwardConfig);

  if (rule.bidirectional) {
    if (
      !resolved.reverseTriggerEntityId ||
      !resolved.reverseTargetEntityIds ||
      resolved.reverseTargetEntityIds.length === 0
    ) {
      console.warn(
        `[WorkflowTriggers] Rule "${rule.id}" is bidirectional but reverse trigger/target ` +
        'could not be resolved — reverse automation was NOT deployed.',
      );
    } else {
      const reverseId = `janus_${rule.id}__reverse`;
      const reverseConfig = buildReverseAutomationConfig(resolved);
      await haProxy(`/api/config/automation/config/${reverseId}`, 'POST', reverseConfig);
    }
  }

  // Reload automations so the freshly-written configs activate immediately.
  try {
    await haProxy('/api/services/automation/reload', 'POST', {});
  } catch (err) {
    console.warn(
      `[WorkflowTriggers] Deployed rule "${rule.id}" but automation reload failed — ` +
      'the new config may not be active until HA reloads automations.',
      err,
    );
  }

  return resolved;
}

/**
 * Check if the HA automation(s) for a rule exist and their state (on/off/missing).
 *
 * For bidirectional rules both automations are checked; the combined status
 * reports `exists: true` only when both are present, and `state: 'on'` only
 * when both are enabled.
 */
export async function getWorkflowHAStatus(
  rule: WorkflowRule,
): Promise<{
  exists: boolean;
  state: string | null;
  forwardExists?: boolean;
  forwardState?: string | null;
  reverseExists?: boolean;
  reverseState?: string | null;
}> {
  const forwardId = `janus_${rule.id}`;
  const reverseId = `janus_${rule.id}__reverse`;

  // HA generates the automation entity_id from the alias (slugified), NOT from
  // the config-id we POST. So we can't look up by predicted entity_id — list
  // all automations and match by attributes.id, which is exactly our config-id.
  const fetchAllAutomationsById = async (): Promise<Map<string, { state: string }>> => {
    try {
      const all = await haProxy(`/api/states`, 'GET');
      const byConfigId = new Map<string, { state: string }>();
      if (Array.isArray(all)) {
        for (const e of all as Array<{ entity_id?: string; state?: string; attributes?: { id?: string } }>) {
          if (!e?.entity_id?.startsWith('automation.')) continue;
          const cfgId = e.attributes?.id;
          if (cfgId && typeof e.state === 'string') {
            byConfigId.set(cfgId, { state: e.state });
          }
        }
      }
      return byConfigId;
    } catch {
      return new Map();
    }
  };

  const automations = await fetchAllAutomationsById();
  const lookup = (id: string): { exists: boolean; state: string | null } => {
    const hit = automations.get(id);
    return hit ? { exists: true, state: hit.state } : { exists: false, state: null };
  };

  const forward = lookup(forwardId);

  if (!rule.bidirectional) {
    return { ...forward, forwardExists: forward.exists, forwardState: forward.state };
  }

  const reverse = lookup(reverseId);

  const bothOn = forward.state === 'on' && reverse.state === 'on';
  const eitherExists = forward.exists || reverse.exists;
  return {
    exists: forward.exists && reverse.exists,
    state: bothOn ? 'on' : (eitherExists ? 'off' : null),
    forwardExists: forward.exists,
    forwardState: forward.state,
    reverseExists: reverse.exists,
    reverseState: reverse.state,
  };
}
