/**
 * Test script for the "Garage Light Group" workflow trigger (bidirectional).
 * Verifies: trigger entity exists, target entities resolve, the deployed
 * HA automations are present and enabled, and (optionally) toggles the trigger
 * to confirm targets follow.
 *
 * Run:  npx tsx scripts/test-garage-light-trigger.ts                     # diagnostic only
 *       npx tsx scripts/test-garage-light-trigger.ts --toggle            # flip the Recessed (forward direction)
 *       npx tsx scripts/test-garage-light-trigger.ts --toggle-reverse    # flip TigerDen (reverse direction)
 *       npx tsx scripts/test-garage-light-trigger.ts --deploy            # push both automations to HA
 *
 * Use --deploy after reloading the Crestron + Govee integrations in HA — this
 * pushes both the forward and reverse automation configs to HA so you don't have
 * to open the Automations UI to click Deploy.
 */
import {
  startHAWebSocket, isCacheReady, getEntityCache,
  sendHAWSCommand, callHAService, stopHAWebSocket,
} from '../server/lib/haWebSocket';
import https from 'node:https';
import { URL } from 'node:url';

interface HAEntity {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForCache(maxMs = 15_000): Promise<HAEntity[]> {
  const start = Date.now();
  while (!isCacheReady() && Date.now() - start < maxMs) await sleep(250);
  if (!isCacheReady()) throw new Error('HA WS cache never became ready');
  return getEntityCache() as HAEntity[];
}

function findForwardTrigger(entities: HAEntity[]): HAEntity | null {
  return entities.find((e) => {
    if (!e.entity_id.startsWith('light.')) return false;
    const id = e.entity_id.toLowerCase();
    const name = String(e.attributes?.friendly_name ?? '').toLowerCase().trim();
    const isGarage = id.includes('garage') || name.includes('garage');
    const isRecessed = id.endsWith('_recessed') || name.endsWith('recessed');
    return isGarage && isRecessed;
  }) ?? null;
}

function findReverseTrigger(entities: HAEntity[]): HAEntity | null {
  // Find TigerDen light or switch (prefer light.* when available)
  const candidates = entities.filter((e) => {
    const id = e.entity_id.toLowerCase();
    const name = String(e.attributes?.friendly_name ?? '').toLowerCase().trim();
    const isTigerDen =
      id.includes('tiger_den') || id.includes('tigerden') ||
      name.includes('tigerden') || name.includes('tiger den') ||
      name.includes('tiger_den');
    const notSegment = !id.includes('segment') && !name.includes('segment');
    return isTigerDen && notSegment;
  });
  // Prefer light.* entity; fall back to switch.*
  return (
    candidates.find((e) => e.entity_id.startsWith('light.')) ??
    candidates.find((e) => e.entity_id.startsWith('switch.')) ??
    null
  );
}

function resolveForwardTargets(trigger: HAEntity, entities: HAEntity[]): HAEntity[] {
  const triggerId = trigger.entity_id;
  const match = triggerId.match(/^(.+_)recessed$/i);
  const prefix = match ? match[1].toLowerCase() : '';
  const out: HAEntity[] = [];
  // TigerDen may exist only as switch.* (current Govee Cloud integration).
  // Track separately and prefer light.* when available.
  let tigerDenLight: HAEntity | null = null;
  let tigerDenSwitch: HAEntity | null = null;
  for (const e of entities) {
    if (e.entity_id === triggerId) continue;
    const isLight = e.entity_id.startsWith('light.');
    const isSwitch = e.entity_id.startsWith('switch.');
    if (!isLight && !isSwitch) continue;
    const id = e.entity_id.toLowerCase();
    const name = String(e.attributes?.friendly_name ?? '').toLowerCase();
    if (isLight && prefix && id.startsWith(prefix)) {
      const suffix = id.slice(prefix.length);
      if (suffix === 'north_cabinets' || suffix === 'tool_cabinets') {
        out.push(e); continue;
      }
    }
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
        if (isLight && !tigerDenLight) tigerDenLight = e;
        else if (isSwitch && !tigerDenSwitch) tigerDenSwitch = e;
      }
    }
  }
  if (tigerDenLight) {
    const lightUsable = tigerDenLight.state !== 'unavailable' && tigerDenLight.state !== 'unknown';
    out.push(lightUsable || !tigerDenSwitch ? tigerDenLight : tigerDenSwitch);
  } else if (tigerDenSwitch) {
    out.push(tigerDenSwitch);
  }
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.entity_id) ? false : (seen.add(e.entity_id), true)));
}

async function getState(entityId: string): Promise<HAEntity | null> {
  try {
    const r = await sendHAWSCommand({ type: 'get_states' }, 10_000);
    const list = (r as HAEntity[]) ?? [];
    return list.find((e) => e.entity_id === entityId) ?? null;
  } catch { return null; }
}

function row(label: string, value: string) {
  console.log(`  ${label.padEnd(30)} ${value}`);
}

function buildForwardAutomationConfig(triggerId: string, targetIds: string[]) {
  return {
    alias: 'Janus — Garage Light Group',
    description: '[Managed by Janus] Bidirectional group: Garages Recessed ↔ TigerDen (Govee). Forward: Recessed drives North Cabinets, Tool Cabinets, TigerDen.',
    trigger: [
      { platform: 'state', entity_id: triggerId, to: 'on' },
      { platform: 'state', entity_id: triggerId, to: 'off' },
    ],
    condition: [],
    action: [
      {
        choose: [
          {
            conditions: [{ condition: 'state', entity_id: triggerId, state: 'on' }],
            sequence: [{ service: 'homeassistant.turn_on', target: { entity_id: targetIds } }],
          },
          {
            conditions: [{ condition: 'state', entity_id: triggerId, state: 'off' }],
            sequence: [{ service: 'homeassistant.turn_off', target: { entity_id: targetIds } }],
          },
        ],
      },
    ],
    mode: 'single',
  };
}

function buildReverseAutomationConfig(reverseTrigId: string, primaryId: string) {
  return {
    alias: 'Janus — Garage Light Group (reverse)',
    description: '[Managed by Janus] Reverse direction: TigerDen (Govee) drives Garages Recessed. State-equality condition prevents toggle loops.',
    trigger: [
      { platform: 'state', entity_id: reverseTrigId, to: 'on' },
      { platform: 'state', entity_id: reverseTrigId, to: 'off' },
    ],
    condition: [],
    action: [
      {
        choose: [
          {
            conditions: [
              { condition: 'state', entity_id: reverseTrigId, state: 'on' },
              { condition: 'not', conditions: [{ condition: 'state', entity_id: primaryId, state: 'on' }] },
            ],
            sequence: [{ service: 'homeassistant.turn_on', target: { entity_id: primaryId } }],
          },
          {
            conditions: [
              { condition: 'state', entity_id: reverseTrigId, state: 'off' },
              { condition: 'not', conditions: [{ condition: 'state', entity_id: primaryId, state: 'off' }] },
            ],
            sequence: [{ service: 'homeassistant.turn_off', target: { entity_id: primaryId } }],
          },
        ],
      },
    ],
    mode: 'single',
  };
}

async function haPost(path: string, config: object): Promise<void> {
  const haUrl = process.env.HA_URL || process.env.HOMEASSISTANT_URL;
  const haToken = process.env.HA_TOKEN;
  if (!haUrl || !haToken) throw new Error('HA_URL and HA_TOKEN env vars required for --deploy');

  const u = new URL(path, haUrl);
  const data = Buffer.from(JSON.stringify(config));

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        protocol: u.protocol,
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        headers: {
          Authorization: `Bearer ${haToken}`,
          'Content-Type': 'application/json',
          'Content-Length': data.length,
        },
        rejectUnauthorized: false,
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (resp.statusCode && resp.statusCode >= 200 && resp.statusCode < 300) resolve();
          else reject(new Error(`HA POST ${resp.statusCode}: ${body.slice(0, 200)}`));
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function postToHA(automationId: string, config: object): Promise<void> {
  await haPost(`/api/config/automation/config/${automationId}`, config);
}

async function reloadHAAutomations(): Promise<void> {
  await haPost('/api/services/automation/reload', {});
}

async function main() {
  const doToggleForward = process.argv.includes('--toggle');
  const doToggleReverse = process.argv.includes('--toggle-reverse');
  const doDeploy = process.argv.includes('--deploy');

  console.log('▶ Starting HA WebSocket...');
  startHAWebSocket();
  const entities = await waitForCache();
  console.log(`✓ HA cache ready: ${entities.length} entities\n`);

  // ── 1. Forward trigger (Garages Recessed) ──────────────────────────────
  console.log('── 1. Forward trigger (Garages Recessed) ──────────');
  const forwardTrigger = findForwardTrigger(entities);
  if (!forwardTrigger) {
    console.log('✗ NO forward trigger matched (looking for light.* with "garage" + ending in "recessed")');
    const candidates = entities.filter((e) =>
      e.entity_id.startsWith('light.') &&
      (e.entity_id.toLowerCase().includes('garage') ||
        String(e.attributes?.friendly_name ?? '').toLowerCase().includes('garage'))
    );
    console.log(`  Candidate garage lights (${candidates.length}):`);
    for (const c of candidates.slice(0, 12)) row(c.entity_id, String(c.attributes?.friendly_name ?? ''));
    process.exit(2);
  }
  row('entity_id', forwardTrigger.entity_id);
  row('friendly_name', String(forwardTrigger.attributes?.friendly_name ?? ''));
  row('current state', forwardTrigger.state);
  console.log();

  // ── 2. Reverse trigger (TigerDen) ──────────────────────────────────────
  console.log('── 2. Reverse trigger (TigerDen / Govee) ──────────');
  const reverseTrigger = findReverseTrigger(entities);
  if (!reverseTrigger) {
    console.log('✗ NO reverse trigger matched (looking for light.*/switch.* with "tiger_den"/"tigerden")');
    const candidates = entities.filter((e) => {
      const id = e.entity_id.toLowerCase();
      return id.includes('tiger') || id.includes('govee');
    });
    console.log(`  Candidate tiger/govee entities (${candidates.length}):`);
    for (const c of candidates.slice(0, 12)) row(c.entity_id, `${String(c.attributes?.friendly_name ?? '')} [${c.state}]`);
  } else {
    row('entity_id', reverseTrigger.entity_id);
    row('friendly_name', String(reverseTrigger.attributes?.friendly_name ?? ''));
    row('current state', reverseTrigger.state);
    // Warn if the light.* entity is unavailable but switch.* exists
    if ((reverseTrigger.state === 'unavailable' || reverseTrigger.state === 'unknown') && reverseTrigger.entity_id.startsWith('light.')) {
      const swId = reverseTrigger.entity_id.replace(/^light\./, 'switch.');
      const sw = entities.find(e => e.entity_id === swId);
      if (sw) {
        console.log(`  ⚠ light entity is ${reverseTrigger.state} — switch fallback: ${swId} [${sw.state}]`);
        console.log('  The automation will be deployed using the switch entity.');
      }
    }
  }
  console.log();

  // ── 3. Forward targets ─────────────────────────────────────────────────
  console.log('── 3. Forward targets (Recessed → others) ─────────');
  const forwardTargets = resolveForwardTargets(forwardTrigger, entities);
  if (forwardTargets.length === 0) {
    console.log('✗ NO forward targets resolved — automation would have nothing to control.');
  } else {
    for (const t of forwardTargets) row(t.entity_id, `${String(t.attributes?.friendly_name ?? '')} [${t.state}]`);
  }
  console.log();

  // ── 4. Deployed HA automations ─────────────────────────────────────────
  console.log('── 4. Deployed HA automations ──────────────────────');
  const fwAutoId = 'automation.janus_garage-recessed-group';
  const rvAutoId = 'automation.janus_garage-recessed-group__reverse';

  const fwAuto = await getState(fwAutoId);
  if (!fwAuto) {
    console.log(`✗ ${fwAutoId} NOT FOUND — forward automation not yet deployed.`);
    console.log('  Fix: open Automations → Workflow Triggers and click Deploy, or run --deploy.');
  } else {
    row('forward entity_id', fwAuto.entity_id);
    row('forward state', fwAuto.state);
    row('forward last_triggered', String(fwAuto.attributes?.last_triggered ?? '(never)'));
    if (fwAuto.state !== 'on') console.log('  ⚠ Forward automation is DISABLED.');
  }
  console.log();

  const rvAuto = await getState(rvAutoId);
  if (!rvAuto) {
    console.log(`✗ ${rvAutoId} NOT FOUND — reverse automation not yet deployed.`);
    console.log('  This is why the TigerDen → Recessed direction is broken.');
    console.log('  Fix: run with --deploy.');
  } else {
    row('reverse entity_id', rvAuto.entity_id);
    row('reverse state', rvAuto.state);
    row('reverse last_triggered', String(rvAuto.attributes?.last_triggered ?? '(never)'));
    if (rvAuto.state !== 'on') console.log('  ⚠ Reverse automation is DISABLED.');
  }
  console.log();

  // ── 5. Optional deploy ────────────────────────────────────────────────
  if (doDeploy) {
    console.log('── 5. Deploying automations to HA ──────────────────');
    if (forwardTargets.length === 0) {
      console.log('✗ Cannot deploy — no forward targets resolved.');
    } else {
      const offline = [forwardTrigger, ...forwardTargets].filter(
        (e) => e.state === 'unavailable' || e.state === 'unknown',
      );
      if (offline.length > 0) {
        console.log(`⚠ ${offline.length} entity(ies) currently unavailable (deploying anyway):`);
        for (const o of offline) console.log(`    ${o.entity_id}  [${o.state}]`);
      }

      let forwardOk = false;
      let reverseOk = false;
      let reverseAttempted = false;

      // Deploy forward
      try {
        const fwConfig = buildForwardAutomationConfig(
          forwardTrigger.entity_id,
          forwardTargets.map((t) => t.entity_id),
        );
        await postToHA('janus_garage-recessed-group', fwConfig);
        forwardOk = true;
        console.log('✓ Deployed automation.janus_garage-recessed-group (forward)');
        await sleep(800);
        const after = await getState('automation.janus_garage-recessed-group');
        if (after) row('  post-deploy state', after.state);
      } catch (e) {
        console.log(`✗ Forward deploy failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Deploy reverse
      if (reverseTrigger) {
        reverseAttempted = true;
        // Resolve which entity to use (light or switch fallback)
        let reverseEntityId = reverseTrigger.entity_id;
        if (
          (reverseTrigger.state === 'unavailable' || reverseTrigger.state === 'unknown') &&
          reverseTrigger.entity_id.startsWith('light.')
        ) {
          const swId = reverseTrigger.entity_id.replace(/^light\./, 'switch.');
          const sw = entities.find(e => e.entity_id === swId);
          if (sw && sw.state !== 'unavailable' && sw.state !== 'unknown') {
            reverseEntityId = swId;
            console.log(`  Using switch fallback for reverse trigger: ${reverseEntityId}`);
          }
        }

        try {
          const rvConfig = buildReverseAutomationConfig(reverseEntityId, forwardTrigger.entity_id);
          await postToHA('janus_garage-recessed-group__reverse', rvConfig);
          reverseOk = true;
          console.log('✓ Deployed automation.janus_garage-recessed-group__reverse (reverse)');
          await sleep(800);
          const afterRv = await getState('automation.janus_garage-recessed-group__reverse');
          if (afterRv) row('  post-deploy state', afterRv.state);
        } catch (e) {
          console.log(`✗ Reverse deploy failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        console.log('⚠ Skipping reverse deploy — TigerDen entity not found in HA.');
      }

      // Reload only if at least one config write succeeded; otherwise there's
      // nothing new to activate. If a write failed, be explicit that only the
      // successful one (if any) was activated.
      const anyWritten = forwardOk || reverseOk;
      const allWritten = forwardOk && (!reverseAttempted || reverseOk);
      if (!anyWritten) {
        console.log('⚠ Skipping automation reload — no configs were written successfully.');
      } else {
        try {
          await reloadHAAutomations();
          if (allWritten) {
            console.log('✓ Reloaded HA automations — new configs are now live.');
          } else {
            console.log('✓ Reloaded HA automations — only the successfully-written configs are now live.');
          }
        } catch (e) {
          console.log(`✗ Automation reload failed: ${e instanceof Error ? e.message : String(e)}`);
          console.log('  The configs that were written won\'t activate until HA reloads automations.');
        }
      }
    }
    console.log();
  }

  // ── 6. Live toggle tests ───────────────────────────────────────────────
  if (!doToggleForward && !doToggleReverse) {
    console.log('ℹ Re-run with --toggle         to flip Recessed and verify targets follow (forward direction).');
    console.log('ℹ Re-run with --toggle-reverse to flip TigerDen and verify Recessed follows (reverse direction).');
    console.log('ℹ Re-run with --deploy         to push both automations to HA.');
  }

  if (doToggleForward) {
    console.log('── 6a. Live toggle test (forward: Recessed → targets) ──');
    const before = forwardTrigger.state;
    const next = before === 'on' ? 'off' : 'on';
    console.log(`  Toggling ${forwardTrigger.entity_id} ${before} → ${next} ...`);
    await callHAService('light', `turn_${next}`, { entity_id: forwardTrigger.entity_id });
    await sleep(2500);
    const afterTrigger = await getState(forwardTrigger.entity_id);
    row('  trigger after', afterTrigger?.state ?? '(unknown)');
    for (const t of forwardTargets) {
      const fresh = await getState(t.entity_id);
      const ok = fresh?.state === next;
      console.log(`  ${ok ? '✓' : '✗'} ${t.entity_id.padEnd(42)} → ${fresh?.state ?? '?'}${ok ? '' : ` (expected ${next})`}`);
    }
    console.log(`  Restoring ${forwardTrigger.entity_id} to ${before}...`);
    await callHAService('light', `turn_${before}`, { entity_id: forwardTrigger.entity_id });
    console.log();
  }

  if (doToggleReverse && reverseTrigger) {
    console.log('── 6b. Live toggle test (reverse: TigerDen → Recessed) ──');
    // Mirror the deploy-time fallback: use switch.* if light.* is unavailable/unknown
    let toggleReverseId = reverseTrigger.entity_id;
    if (
      (reverseTrigger.state === 'unavailable' || reverseTrigger.state === 'unknown') &&
      reverseTrigger.entity_id.startsWith('light.')
    ) {
      const swId = reverseTrigger.entity_id.replace(/^light\./, 'switch.');
      const sw = entities.find(e => e.entity_id === swId);
      if (sw && sw.state !== 'unavailable' && sw.state !== 'unknown') {
        toggleReverseId = swId;
        console.log(`  Using switch fallback for toggle: ${toggleReverseId}`);
      }
    }
    const revEntity = entities.find(e => e.entity_id === toggleReverseId) ?? reverseTrigger;
    const revBefore = revEntity.state;
    const revNext = revBefore === 'on' ? 'off' : 'on';
    const domain = toggleReverseId.startsWith('switch.') ? 'switch' : 'light';
    console.log(`  Toggling ${toggleReverseId} ${revBefore} → ${revNext} ...`);
    await callHAService(domain, `turn_${revNext}`, { entity_id: toggleReverseId });
    await sleep(3000); // slightly longer — reverse → forward cascade may take a moment
    const afterReverse = await getState(toggleReverseId);
    row('  TigerDen after', afterReverse?.state ?? '(unknown)');
    const recessedAfter = await getState(forwardTrigger.entity_id);
    const recessedOk = recessedAfter?.state === revNext;
    console.log(`  ${recessedOk ? '✓' : '✗'} ${forwardTrigger.entity_id.padEnd(42)} → ${recessedAfter?.state ?? '?'}${recessedOk ? '' : ` (expected ${revNext})`}`);
    // Also check cabinet cascade (they should follow Recessed via forward automation)
    await sleep(1500);
    for (const t of forwardTargets) {
      if (t.entity_id === toggleReverseId) continue; // TigerDen was the trigger
      const fresh = await getState(t.entity_id);
      const ok = fresh?.state === revNext;
      console.log(`  ${ok ? '✓' : '✗'} ${t.entity_id.padEnd(42)} → ${fresh?.state ?? '?'}${ok ? '' : ` (expected ${revNext})`}`);
    }
    console.log(`  Restoring ${toggleReverseId} to ${revBefore}...`);
    await callHAService(domain, `turn_${revBefore}`, { entity_id: toggleReverseId });
    console.log();
  } else if (doToggleReverse && !reverseTrigger) {
    console.log('⚠ --toggle-reverse: TigerDen entity not found in HA — cannot test.');
  }

  stopHAWebSocket();
  await sleep(500);
  process.exit(0);
}

main().catch((err) => { console.error('FAILED:', err); stopHAWebSocket(); process.exit(1); });
