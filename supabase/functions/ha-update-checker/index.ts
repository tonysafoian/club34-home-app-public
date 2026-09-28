import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const EDGE_FN = 'ha-update-checker';
const AUTOMATION_NAME = 'HA Update Checker';
const ALERT_EMAIL = 'admin@example.com';
const HA_URL = process.env.HA_URL || 'http://homeassistant.local:8123';
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function logAudit(entry: Record<string, unknown>) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/system_audit_log`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ edge_function: EDGE_FN, ...entry }),
    });
  } catch (e) {
    console.error('Audit log failed:', e);
  }
}

async function callHAProxy(body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/home-assistant-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      'x-cron-secret': Deno.env.get('CRON_SECRET') || '',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendAlertEmail(subject: string, body: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/janus-email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: 'send', to: ALERT_EMAIL, subject, body }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`janus-email returned ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (data.error) {
    throw new Error(`janus-email error: ${data.error}`);
  }
}

async function logRun(
  supabase: ReturnType<typeof createClient>,
  automationId: string,
  status: string,
  output: Record<string, unknown>,
  errorMessage?: string,
) {
  const now = new Date().toISOString();
  await supabase.from('family_automation_logs').insert({
    automation_id: automationId,
    status,
    output,
    error_message: errorMessage || null,
    started_at: now,
    completed_at: now,
  });
  await supabase.from('family_automations').update({ last_run_at: now }).eq('id', automationId);
}

interface UpdateEntity {
  entity_id: string;
  friendly_name: string;
  installed_version: string;
  latest_version: string;
}

async function computeHash(updates: UpdateEntity[]): Promise<string> {
  const sorted = [...updates]
    .sort((a, b) => a.entity_id.localeCompare(b.entity_id))
    .map(u => `${u.entity_id}:${u.latest_version}`)
    .join('|');
  const encoder = new TextEncoder();
  const data = encoder.encode(sorted);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function buildUpdateEmailBody(updates: UpdateEntity[]): string {
  const rows = updates
    .map(
      u => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${u.friendly_name || u.entity_id}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;color:#6b7280;">${u.installed_version || 'unknown'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;color:#059669;font-weight:bold;">${u.latest_version}</td>
      </tr>`,
    )
    .join('\n');

  return [
    `<h2 style="color:#1f2937;">Home Assistant Updates Available</h2>`,
    `<p style="color:#6b7280;">The following ${updates.length} update${updates.length !== 1 ? 's are' : ' is'} ready to install:</p>`,
    `<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;">`,
    `<thead>`,
    `<tr style="background:#f3f4f6;">`,
    `<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;">Component</th>`,
    `<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;">Installed</th>`,
    `<th style="padding:8px 12px;text-align:left;border-bottom:2px solid #d1d5db;">Available</th>`,
    `</tr>`,
    `</thead>`,
    `<tbody>`,
    rows,
    `</tbody>`,
    `</table>`,
    `<p style="margin-top:24px;">`,
    `<a href="${HA_URL}" style="display:inline-block;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Open Home Assistant →</a>`,
    `</p>`,
    `<p style="color:#9ca3af;font-size:12px;margin-top:16px;">This notification will not repeat for the same updates within 24 hours.</p>`,
  ].join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Look up automation row
  const { data: automation } = await supabase
    .from('family_automations')
    .select('id, is_active')
    .eq('name', AUTOMATION_NAME)
    .single();

  if (!automation) {
    return new Response(JSON.stringify({ error: 'Automation not found in DB' }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!automation.is_active) {
    return new Response(JSON.stringify({ skipped: true, reason: 'Automation is disabled' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    // 1. Fetch all HA states
    const allStates = await callHAProxy({ action: 'get-states' });
    if (!Array.isArray(allStates)) {
      throw new Error(`HA proxy returned unexpected response: ${JSON.stringify(allStates).slice(0, 200)}`);
    }

    // 2. Filter for update entities where state is "on" (update available),
    //    excluding HACS/community store updates (only official HA updates).
    //    HACS entities are identified by entity_id containing "hacs" or
    //    attributes that indicate a community/HACS platform.
    const availableUpdates: UpdateEntity[] = [];
    for (const s of allStates) {
      if (!s.entity_id?.startsWith('update.')) continue;
      if (s.state !== 'on') continue;

      const attrs = s.attributes || {};

      // Exclude HACS entities — community store integrations/themes/automations
      const entityIdLower = (s.entity_id as string).toLowerCase();
      if (entityIdLower.includes('hacs')) continue;
      // entity_platform = 'hacs' is set by HACS on its managed entities
      if (attrs.entity_platform === 'hacs') continue;
      // integration_type can also identify HACS-managed updates
      if (attrs.integration_type === 'hacs') continue;
      // release_url pointing to a community github repo (not home-assistant org)
      if (
        typeof attrs.release_url === 'string' &&
        attrs.release_url.includes('github.com') &&
        !attrs.release_url.includes('github.com/home-assistant') &&
        !attrs.release_url.includes('github.com/NabuCasa')
      ) continue;

      availableUpdates.push({
        entity_id: s.entity_id,
        friendly_name: attrs.friendly_name || s.entity_id,
        installed_version: attrs.installed_version || attrs.current_version || '',
        latest_version: attrs.latest_version || attrs.newest_version || '',
      });
    }

    console.log(`${EDGE_FN}: Found ${availableUpdates.length} available update(s)`);

    if (availableUpdates.length === 0) {
      // Silent success — no updates
      const output = { updates_found: 0, updates: [], email_sent: false };
      await logRun(supabase, automation.id, 'success', output);
      logAudit({
        category: 'automation',
        event_type: 'ha_update_check',
        severity: 'info',
        actor_id: 'system',
        actor_name: 'Cron',
        actor_role: 'system',
        channel: 'cron',
        summary: 'No HA updates available',
        detail: output,
        status: 'success',
      });
      return new Response(JSON.stringify(output), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // 3. Compute deduplication hash for this set of updates
    const updateHash = await computeHash(availableUpdates);

    // 4. Check cooldown — did we already notify for the exact same set within 24h?
    const since = new Date(Date.now() - COOLDOWN_MS).toISOString();
    const { data: recentLogs } = await supabase
      .from('family_automation_logs')
      .select('output')
      .eq('automation_id', automation.id)
      .eq('status', 'success')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50);

    const alreadyNotified = recentLogs?.some((log: { output?: unknown }) => {
      const out = log.output as Record<string, unknown> | null;
      return out?.update_hash === updateHash && out?.email_sent === true;
    }) ?? false;

    let emailSent = false;

    if (!alreadyNotified) {
      const count = availableUpdates.length;
      const subject = `🔄 Home Assistant: ${count} update${count !== 1 ? 's' : ''} available`;
      const body = buildUpdateEmailBody(availableUpdates);

      try {
        await sendAlertEmail(subject, body);
        emailSent = true;
        console.log(`${EDGE_FN}: Email sent for ${count} update(s)`);
      } catch (e) {
        console.error(`${EDGE_FN}: Failed to send email:`, e);
      }
    } else {
      console.log(`${EDGE_FN}: Notification suppressed — same updates already notified within 24h`);
    }

    // 5. Log the run
    const output = {
      updates_found: availableUpdates.length,
      updates: availableUpdates,
      update_hash: updateHash,
      email_sent: emailSent,
      cooldown_active: alreadyNotified,
    };

    await logRun(supabase, automation.id, 'success', output);
    logAudit({
      category: 'automation',
      event_type: 'ha_update_check',
      severity: emailSent ? 'warn' : 'info',
      actor_id: 'system',
      actor_name: 'Cron',
      actor_role: 'system',
      channel: 'cron',
      summary: `${availableUpdates.length} HA update(s) available${emailSent ? ' — email sent' : alreadyNotified ? ' — cooldown active' : ''}`,
      detail: output,
      status: 'success',
    });

    return new Response(JSON.stringify(output), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${EDGE_FN} error:`, msg);
    await logRun(supabase, automation.id, 'error', {}, msg);
    logAudit({
      category: 'automation',
      event_type: 'ha_update_check_error',
      severity: 'error',
      actor_id: 'system',
      channel: 'cron',
      summary: `HA update check error: ${msg.slice(0, 100)}`,
      status: 'error',
    });

    try {
      const _u = Deno.env.get('SUPABASE_URL')!;
      const _k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      await fetch(`${_u}/rest/v1/failed_jobs`, {
        method: 'POST',
        headers: { apikey: _k, Authorization: `Bearer ${_k}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ function_name: EDGE_FN, error_message: msg.slice(0, 2000), error_detail: { stack: err instanceof Error ? err.stack : null } }),
      });
    } catch { /* DLQ write is best-effort — never mask the original error */ }

    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
