/**
 * Mirror of inbound-channel routing decisions (WhatsApp, chat) to the local
 * system_audit_log table so all of Janus's channels can be debugged from
 * Replit without opening Supabase. Companion to janusEmailAudit.ts; uses the
 * same ResolvedIdentity shape so the routing audit story is uniform.
 *
 * Categories: 'janus.whatsapp' | 'janus.chat'
 * Event types: '<channel>.<route>'
 *   Routes: admin-reply, member-reply, outsider-reply, outsider-throttled,
 *           outsider-silent, group-not-mentioned, error
 */
import { storage } from '../storage.js';
import type { ResolvedIdentity } from './identityResolver.js';

export type ChannelKind = 'whatsapp' | 'whatsapp-group' | 'chat';

export type ChannelRoute =
  | 'admin-reply'
  | 'member-reply'
  | 'outsider-reply'
  | 'outsider-throttled'
  | 'outsider-silent'
  | 'group-not-mentioned'
  | 'error';

export interface ChannelDecisionInput {
  channel: ChannelKind;
  route: ChannelRoute;
  identity: ResolvedIdentity;
  fromIdentifier: string;
  groupId?: string;
  messagePreview?: string;
  replyPreview?: string;
  toolNames?: string[];
  durationMs?: number;
  status?: 'success' | 'error';
  errorMessage?: string;
  correlationId?: string;
}

function pickSeverity(input: ChannelDecisionInput): 'info' | 'warn' | 'error' {
  if (input.status === 'error' || input.route === 'error') return 'error';
  if (input.route === 'outsider-throttled') return 'warn';
  return 'info';
}

export async function logJanusChannelDecision(input: ChannelDecisionInput): Promise<void> {
  try {
    const channelTag = input.channel === 'chat' ? 'chat' : 'whatsapp';
    const summary =
      `[${input.channel}/${input.route}] ${input.identity.displayName} <${input.fromIdentifier}> — ` +
      (input.messagePreview || '(no message)').slice(0, 80);

    await storage.createSystemAuditLog({
      category: `janus.${channelTag}`,
      eventType: `${channelTag}.${input.route}`,
      severity: pickSeverity(input),
      actorId: input.identity.userId,
      actorName: input.identity.displayName,
      actorRole: input.identity.role,
      channel: input.channel,
      summary,
      detail: {
        fromIdentifier: input.fromIdentifier,
        groupId: input.groupId,
        identitySource: input.identity.source,
        messagePreview: input.messagePreview ? input.messagePreview.slice(0, 500) : undefined,
        replyPreview: input.replyPreview ? input.replyPreview.slice(0, 500) : undefined,
        toolNames: input.toolNames,
        errorMessage: input.errorMessage,
      },
      durationMs: input.durationMs,
      status: input.status || 'success',
      edgeFunction:
        input.channel === 'chat'
          ? 'janus-chat'
          : input.channel === 'whatsapp-group'
            ? 'janus-whatsapp-group'
            : 'janus-whatsapp',
      correlationId: input.correlationId,
    });
  } catch (e) {
    console.error('[janus-channel-audit] Failed to log decision:', e);
  }
}
