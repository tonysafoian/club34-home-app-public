import { logAudit } from '../lib/auditLog.js';
import { executeSendEmail } from './janus-tools.js';

export interface MonitorAlertConfig {
  recipients: Array<{
    email?: string;
    whatsapp?: string;
  }>;
  subject: string;
  body: string;
  channels: ('email' | 'whatsapp')[];
  cooldownKey: string;
  cooldownMs: number;
  auditEdgeFunction?: string;
}

const _cooldowns: Record<string, number> = {};

function isCooldownActive(key: string, cooldownMs: number): boolean {
  const last = _cooldowns[key];
  if (!last) return false;
  return Date.now() - last < cooldownMs;
}

function setCooldown(key: string): void {
  _cooldowns[key] = Date.now();
}

const BASE_URL = `http://localhost:${process.env.PORT || 5000}`;

async function sendWhatsAppViaRoute(to: string, message: string): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/api/janus/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send', to, message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return `Error: WhatsApp to ${to} returned ${res.status}`;
    }
    return (data as Record<string, string>).result || `WhatsApp to ${to}: sent`;
  } catch (e) {
    console.error(`Notification WhatsApp to ${to} failed:`, e);
    return `Error sending WhatsApp to ${to}: ${e instanceof Error ? e.message : 'unknown'}`;
  }
}

function isSuccess(result: string): boolean {
  const lower = result.toLowerCase();
  return !lower.includes('error') && !lower.includes('failed');
}

export async function sendMonitorAlert(config: MonitorAlertConfig): Promise<{
  sent: boolean;
  cooldownActive: boolean;
  emailResults: string[];
  whatsappResults: string[];
}> {
  const { recipients, subject, body, channels, cooldownKey, cooldownMs, auditEdgeFunction = 'monitor-alert' } = config;

  if (isCooldownActive(cooldownKey, cooldownMs)) {
    return { sent: false, cooldownActive: true, emailResults: [], whatsappResults: [] };
  }

  const emailResults: string[] = [];
  const whatsappResults: string[] = [];
  let anySuccess = false;

  if (channels.includes('email')) {
    for (const r of recipients) {
      if (r.email) {
        const result = await executeSendEmail(r.email, subject, body, 'automation', auditEdgeFunction);
        emailResults.push(result);
        if (isSuccess(result)) anySuccess = true;
      }
    }
  }

  if (channels.includes('whatsapp')) {
    for (const r of recipients) {
      if (r.whatsapp) {
        const message = `${subject}\n\n${body}`;
        const result = await sendWhatsAppViaRoute(r.whatsapp, message);
        whatsappResults.push(result);
        if (isSuccess(result)) anySuccess = true;
      }
    }
  }

  if (anySuccess) {
    setCooldown(cooldownKey);
  }

  logAudit(auditEdgeFunction, {
    category: 'automation',
    event_type: 'monitor_alert_sent',
    severity: anySuccess ? 'info' : 'error',
    actor_id: 'system',
    actor_name: 'Monitor',
    channel: 'automation',
    summary: `Alert ${anySuccess ? 'sent' : 'failed'}: ${subject}`,
    detail: {
      cooldownKey,
      emailCount: emailResults.length,
      whatsappCount: whatsappResults.length,
      anySuccess,
    },
    status: anySuccess ? 'success' : 'error',
  });

  return { sent: anySuccess, cooldownActive: false, emailResults, whatsappResults };
}
