/**
 * Workflow Rules — single source of truth for Janus-managed HA automations.
 *
 * Shared between:
 *   - Frontend (src/lib/workflowTriggers.ts) — for UI display + manual deploy
 *   - Backend  (server/lib/workflowReconciler.ts) — for periodic self-healing
 *
 * IMPORTANT: This module must stay pure (no browser-only or server-only
 * imports) so it can be consumed from both environments. To add a new
 * Janus-managed HA automation, just append it to WORKFLOW_RULES below —
 * the reconciler will automatically pick it up and self-heal it.
 */

// ── Minimal HA entity shape we actually consume (kept local to avoid
// pulling in frontend-only modules from server code). ────────────────────
export interface HAEntityLike {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

// ── Rule definition ──────────────────────────────────────────────────────

export interface WorkflowRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Human-readable trigger label */
  triggerLabel: string;
  /** Human-readable list of target labels */
  targetLabels: string[];
  /** Returns true if the given entity is a trigger for this rule */
  isTrigger: (entity: HAEntityLike) => boolean;
  /** Resolve concrete target entity IDs at runtime */
  resolveTargets: (triggerEntity: HAEntityLike, allEntities: HAEntityLike[]) => string[];

  /**
   * When set, the forward automation only fires when the trigger transitions
   * TO this state. Useful for one-directional rules (e.g. "spa on → filter on"
   * without the reverse "spa off → filter off" side-effect).
   * When omitted the automation handles both 'on' and 'off' transitions (default).
   */
  triggerOnlyTo?: 'on' | 'off';

  /**
   * When true, the rule is bidirectional: changing any member of the group
   * drives the others. A second HA automation (id = `{rule.id}__reverse`) is
   * deployed alongside the primary one.
   *
   * The reverse automation uses state-equality conditions so it only fires
   * when the primary entity's state actually differs — preventing toggle storms.
   */
  bidirectional?: boolean;
  /** Human-readable label for the reverse trigger (shown in the UI). */
  reverseTriggerLabel?: string;
  /** Returns true if the entity should act as the reverse trigger. */
  reverseIsTrigger?: (entity: HAEntityLike) => boolean;
  /**
   * Resolve the entity(ies) that the reverse trigger should drive.
   * Usually this is just the primary trigger entity of the forward direction.
   * Receives the live entity list so it can apply the same switch-fallback logic.
   */
  resolveReverseTarget?: (reverseEntity: HAEntityLike, allEntities: HAEntityLike[]) => string[];
}

// ── Rules (source of truth — all workflow logic lives in Janus) ─────────

export const WORKFLOW_RULES: WorkflowRule[] = [
  {
    id: 'garage-recessed-group',
    name: 'Garage Light Group',
    description:
      'Bidirectional group: Garages Recessed ↔ TigerDen (Govee). ' +
      'Toggling either side also controls North Cabinets and Tool Cabinets.',
    enabled: true,
    triggerLabel: 'Garages — Recessed',
    targetLabels: ['North Cabinets', 'Tool Cabinets', 'TigerDen (Govee)'],

    isTrigger: (entity) => {
      if (!entity.entity_id.startsWith('light.')) return false;
      const id = entity.entity_id.toLowerCase();
      const name = (entity.attributes?.friendly_name as string || '').toLowerCase().trim();
      const isGarage = id.includes('garage') || name.includes('garage');
      const isRecessed = id.endsWith('_recessed') || name.endsWith('recessed');
      return isGarage && isRecessed;
    },

    resolveTargets: (triggerEntity, allEntities) => {
      const targets: string[] = [];
      const triggerId = triggerEntity.entity_id;

      const match = triggerId.match(/^(.+_)recessed$/i);
      const prefix = match ? match[1].toLowerCase() : '';

      // TigerDen may be exposed as light.*, switch.*, or both depending on the
      // Govee integration in use. Track candidates separately so we can prefer
      // light.* when available (loop-protection in the reverse automation
      // assumes a single canonical entity per device).
      let tigerDenLight: string | null = null;
      let tigerDenSwitch: string | null = null;

      for (const e of allEntities) {
        if (e.entity_id === triggerId) continue;
        const isLight = e.entity_id.startsWith('light.');
        const isSwitch = e.entity_id.startsWith('switch.');
        if (!isLight && !isSwitch) continue;

        const id = e.entity_id.toLowerCase();
        const name = (e.attributes?.friendly_name as string || '').toLowerCase();

        // ── Same-room Crestron cabinets (Garages) — always light.* ──
        if (isLight && prefix && id.startsWith(prefix)) {
          const suffix = id.slice(prefix.length);
          if (suffix === 'north_cabinets' || suffix === 'tool_cabinets') {
            targets.push(e.entity_id);
            continue;
          }
        }

        // ── Govee TigerDen — accept light.* OR switch.*. The Govee Cloud
        //    integration currently exposes the TigerDen LED strip ONLY as
        //    switch.tiger_den_led_lights (no light entity), so filtering to
        //    light.* drops it from the forward direction entirely.
        if (!prefix || !id.startsWith(prefix)) {
          const isGovee = id.includes('govee') || name.includes('govee');
          const isTigerDen =
            id.includes('tiger_den') || id.includes('tigerden') ||
            name.includes('tigerden') || name.includes('tiger den') ||
            name.includes('tiger_den');
          if (
            (isTigerDen || (isGovee && (name.includes('garage') || name.includes('tiger')))) &&
            !id.includes('segment') && !name.includes('segment')
          ) {
            if (isLight && !tigerDenLight) tigerDenLight = e.entity_id;
            else if (isSwitch && !tigerDenSwitch) tigerDenSwitch = e.entity_id;
          }
        }
      }

      // Prefer the light entity when it exists and is reachable; fall back to
      // switch.* only when light is missing or unavailable.
      if (tigerDenLight) {
        const lightEntity = allEntities.find(x => x.entity_id === tigerDenLight);
        const lightUsable =
          lightEntity && lightEntity.state !== 'unavailable' && lightEntity.state !== 'unknown';
        targets.push(lightUsable || !tigerDenSwitch ? tigerDenLight : tigerDenSwitch);
      } else if (tigerDenSwitch) {
        targets.push(tigerDenSwitch);
      }

      const resolved = [...new Set(targets)];

      // ── Resilience: switch.* fallback ──────────────────────────────────
      return resolved.map((entityId) => {
        if (!entityId.startsWith('light.')) return entityId;
        const entity = allEntities.find(x => x.entity_id === entityId);
        if (!entity || (entity.state !== 'unavailable' && entity.state !== 'unknown')) {
          return entityId;
        }
        const switchId = entityId.replace(/^light\./, 'switch.');
        const switchEntity = allEntities.find(x => x.entity_id === switchId);
        if (switchEntity && switchEntity.state !== 'unavailable' && switchEntity.state !== 'unknown') {
          return switchId;
        }
        return entityId;
      });
    },

    // ── Reverse direction: TigerDen → Garages Recessed ──────────────────

    bidirectional: true,
    reverseTriggerLabel: 'TigerDen (Govee)',

    reverseIsTrigger: (entity) => {
      const id = entity.entity_id.toLowerCase();
      const name = (entity.attributes?.friendly_name as string || '').toLowerCase().trim();
      const isTigerDen =
        id.includes('tiger_den') || id.includes('tigerden') ||
        name.includes('tigerden') || name.includes('tiger den') ||
        name.includes('tiger_den');
      const isGoveeOrLight = id.startsWith('light.') || id.startsWith('switch.');
      const notSegment = !id.includes('segment') && !name.includes('segment');
      return isTigerDen && isGoveeOrLight && notSegment;
    },

    resolveReverseTarget: (_reverseEntity, allEntities) => {
      // Drive the Garages Recessed light (the primary trigger of the forward rule)
      const recessed = allEntities.find(e => {
        if (!e.entity_id.startsWith('light.')) return false;
        const id = e.entity_id.toLowerCase();
        const name = (e.attributes?.friendly_name as string || '').toLowerCase().trim();
        const isGarage = id.includes('garage') || name.includes('garage');
        const isRecessed = id.endsWith('_recessed') || name.endsWith('recessed');
        return isGarage && isRecessed;
      });
      if (!recessed) return [];
      return [recessed.entity_id];
    },
  },

  // ── Pool SPA → Filter Mode ────────────────────────────────────────────────
  // One-directional: when the pool enters SPA mode (the iAqualink "Spa" switch
  // turns on) the Filter pump is automatically turned on. Turning spa off does
  // NOT turn the filter off — the filter stays running until manually stopped.
  {
    id: 'pool-spa-filter-mode',
    name: 'Pool SPA → Filter Mode',
    description:
      'When the pool switches to SPA mode the Filter pump turns on automatically. ' +
      'One-directional — turning spa off does not turn the filter off.',
    enabled: true,
    triggerLabel: 'Spa mode (iAqualink)',
    targetLabels: ['Filter Pump'],

    // Only fire when spa transitions TO 'on' — ignore the off transition so
    // the filter keeps running after the spa is switched off.
    triggerOnlyTo: 'on',

    isTrigger: (entity) => {
      // Primary: the canonical iAqualink spa pump entity used throughout this codebase.
      if (entity.entity_id === 'switch.spa_pump') return true;
      // Friendly-name fallback: any switch whose name is exactly "Spa Pump"
      // (handles renamed or multi-device setups).
      if (!entity.entity_id.startsWith('switch.')) return false;
      const name = (entity.attributes?.friendly_name as string || '').toLowerCase().trim();
      return name === 'spa pump';
    },

    resolveTargets: (_triggerEntity, allEntities) => {
      // Primary: the canonical iAqualink pool (filter) pump entity used throughout
      // this codebase — confirmed in useIaqualinkHA.tsx and IaqualinkCard.tsx.
      const primary = allEntities.find(e => e.entity_id === 'switch.pool_pump');
      if (primary) return [primary.entity_id];

      // Friendly-name fallback: any switch labelled "Pool Pump".
      const byName = allEntities.find(e => {
        if (!e.entity_id.startsWith('switch.')) return false;
        const name = (e.attributes?.friendly_name as string || '').toLowerCase().trim();
        return name === 'pool pump';
      });
      if (byName) return [byName.entity_id];

      // Broad fallback: any switch whose id/name contains 'filter'.
      const filterEntity = allEntities.find(e => {
        if (!e.entity_id.startsWith('switch.')) return false;
        const id = e.entity_id.toLowerCase();
        const name = (e.attributes?.friendly_name as string || '').toLowerCase().trim();
        return id.includes('filter') || name.includes('filter');
      });
      return filterEntity ? [filterEntity.entity_id] : [];
    },
  },
];

// ── Resolve helpers ──────────────────────────────────────────────────────

export interface ResolvedWorkflow {
  rule: WorkflowRule;
  triggerEntityId: string;
  triggerName: string;
  targetEntityIds: string[];
  targetNames: string[];
  /** Entity IDs that were swapped to a switch.* fallback because the light.* was unavailable */
  fallbackEntityIds: string[];
  /** Reverse trigger entity (bidirectional rules only) */
  reverseTriggerEntityId?: string;
  reverseTriggerName?: string;
  /** Reverse target entity IDs (what the reverse trigger drives) */
  reverseTargetEntityIds?: string[];
}

/** Resolve a workflow rule against live HA entities */
export function resolveWorkflow(
  rule: WorkflowRule,
  allEntities: HAEntityLike[],
): ResolvedWorkflow | null {
  const triggerEntity = allEntities.find(e => rule.isTrigger(e));
  if (!triggerEntity) return null;

  const targetIds = rule.resolveTargets(triggerEntity, allEntities);
  if (targetIds.length === 0) return null;

  const getName = (id: string) => {
    const e = allEntities.find(x => x.entity_id === id);
    return e ? (e.attributes?.friendly_name as string) || id : id;
  };

  const fallbackEntityIds = targetIds.filter(id => {
    if (!id.startsWith('switch.')) return false;
    // A genuine *working* fallback requires the switch itself to be reachable.
    // If the chosen switch is unavailable/unknown it is NOT a working fallback —
    // the light went offline with no reachable twin to route around it, so the
    // degradation must surface as an offline/degraded entity (see offlineEntities
    // in WorkflowTriggersSection) rather than masquerading as a healthy fallback.
    const switchEntity = allEntities.find(x => x.entity_id === id);
    if (!switchEntity ||
        switchEntity.state === 'unavailable' || switchEntity.state === 'unknown') {
      return false;
    }
    // Only a genuine fallback if there is a corresponding light.* entity that
    // is unavailable/unknown — i.e. the switch was chosen because the light
    // went offline.  Switch-native targets (no light.* twin, or light.* is
    // healthy) must NOT be counted.
    const lightId = id.replace(/^switch\./, 'light.');
    const lightEntity = allEntities.find(x => x.entity_id === lightId);
    return lightEntity != null &&
      (lightEntity.state === 'unavailable' || lightEntity.state === 'unknown');
  });

  // ── Bidirectional resolution ──
  let reverseTriggerEntityId: string | undefined;
  let reverseTriggerName: string | undefined;
  let reverseTargetEntityIds: string[] | undefined;

  if (rule.bidirectional && rule.reverseIsTrigger && rule.resolveReverseTarget) {
    // Prefer light.* entity; only fall back to switch.* when light is unavailable/unknown.
    const lightCandidate = allEntities.find(
      e => e.entity_id.startsWith('light.') && rule.reverseIsTrigger!(e),
    );
    const switchCandidate = allEntities.find(
      e => e.entity_id.startsWith('switch.') && rule.reverseIsTrigger!(e),
    );

    let reverseEntity: HAEntityLike | undefined;
    let resolvedReverseId: string | undefined;

    if (lightCandidate) {
      if (lightCandidate.state === 'unavailable' || lightCandidate.state === 'unknown') {
        if (switchCandidate && switchCandidate.state !== 'unavailable' && switchCandidate.state !== 'unknown') {
          resolvedReverseId = switchCandidate.entity_id;
          reverseEntity = switchCandidate;
        } else {
          resolvedReverseId = lightCandidate.entity_id;
          reverseEntity = lightCandidate;
        }
      } else {
        resolvedReverseId = lightCandidate.entity_id;
        reverseEntity = lightCandidate;
      }
    } else if (switchCandidate) {
      resolvedReverseId = switchCandidate.entity_id;
      reverseEntity = switchCandidate;
    }

    if (reverseEntity && resolvedReverseId) {
      reverseTriggerEntityId = resolvedReverseId;
      reverseTriggerName = getName(resolvedReverseId);
      reverseTargetEntityIds = rule.resolveReverseTarget(reverseEntity, allEntities);
    }
  }

  return {
    rule,
    triggerEntityId: triggerEntity.entity_id,
    triggerName: getName(triggerEntity.entity_id),
    targetEntityIds: targetIds,
    targetNames: targetIds.map(getName),
    fallbackEntityIds,
    reverseTriggerEntityId,
    reverseTriggerName,
    reverseTargetEntityIds,
  };
}

// ── HA automation config builders ────────────────────────────────────────

/** Build the forward HA automation config (trigger → targets) */
export function buildForwardAutomationConfig(resolved: ResolvedWorkflow) {
  const onlyTo = resolved.rule.triggerOnlyTo;

  // Build trigger list — restricted to a single state when triggerOnlyTo is set.
  const triggers = onlyTo
    ? [{ platform: 'state', entity_id: resolved.triggerEntityId, to: onlyTo }]
    : [
        { platform: 'state', entity_id: resolved.triggerEntityId, to: 'on' },
        { platform: 'state', entity_id: resolved.triggerEntityId, to: 'off' },
      ];

  // Build action branches — only the matching branch(es).
  const onBranch = {
    conditions: [{ condition: 'state', entity_id: resolved.triggerEntityId, state: 'on' }],
    sequence: [{ service: 'homeassistant.turn_on', target: { entity_id: resolved.targetEntityIds } }],
  };
  const offBranch = {
    conditions: [{ condition: 'state', entity_id: resolved.triggerEntityId, state: 'off' }],
    sequence: [{ service: 'homeassistant.turn_off', target: { entity_id: resolved.targetEntityIds } }],
  };

  const chooseBranches = onlyTo === 'on'
    ? [onBranch]
    : onlyTo === 'off'
    ? [offBranch]
    : [onBranch, offBranch];

  return {
    alias: `Janus — ${resolved.rule.name}`,
    description: `[Managed by Janus] ${resolved.rule.description}`,
    trigger: triggers,
    condition: [],
    action: [{ choose: chooseBranches }],
    mode: 'single',
  };
}

/**
 * Build the reverse HA automation config (reverseTrigger → reverseTargets).
 *
 * Loop-protection: each branch checks that the primary entity is NOT already in
 * the desired state before acting. Prevents oscillation when both automations
 * fire on the same state change.
 */
export function buildReverseAutomationConfig(resolved: ResolvedWorkflow) {
  const reverseId = resolved.reverseTriggerEntityId!;
  const primaryId = resolved.reverseTargetEntityIds![0];

  return {
    alias: `Janus — ${resolved.rule.name} (reverse)`,
    description: `[Managed by Janus] Reverse direction: ${resolved.rule.reverseTriggerLabel ?? 'secondary'} → primary. ${resolved.rule.description}`,
    trigger: [
      { platform: 'state', entity_id: reverseId, to: 'on' },
      { platform: 'state', entity_id: reverseId, to: 'off' },
    ],
    condition: [],
    action: [
      {
        choose: [
          {
            conditions: [
              { condition: 'state', entity_id: reverseId, state: 'on' },
              {
                condition: 'not',
                conditions: [{ condition: 'state', entity_id: primaryId, state: 'on' }],
              },
            ],
            sequence: [
              { service: 'homeassistant.turn_on', target: { entity_id: primaryId } },
            ],
          },
          {
            conditions: [
              { condition: 'state', entity_id: reverseId, state: 'off' },
              {
                condition: 'not',
                conditions: [{ condition: 'state', entity_id: primaryId, state: 'off' }],
              },
            ],
            sequence: [
              { service: 'homeassistant.turn_off', target: { entity_id: primaryId } },
            ],
          },
        ],
      },
    ],
    mode: 'single',
  };
}
