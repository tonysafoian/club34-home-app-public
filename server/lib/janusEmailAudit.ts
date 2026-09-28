/**
 * Mirror of inbound-email decisions to the local system_audit_log table so
 * Janus email behavior can be debugged from Replit without opening Supabase.
 *
 * Categories: 'janus.email'
 * Event types: 'email.<route>' (admin-reply, member-reply, coordination-reply,
 *              outsider-reply, outsider-throttled, triage, error)
 */
import { storage } from '../storage.js';
import type { ResolvedIdentity } from './identityResolver.js';

export type EmailRoute =
  | 'admin-reply'
  | 'member-reply'
  | 'coordination-reply'
  | 'outsider-reply'
  | 'outsider-throttled'
  | 'forwarded-transactional-suppressed'
  | 'triage'
  | 'error';

export interface EmailDecisionInput {
  fromEmail: string;
  fromName?: string;
  subject: string;
  threadId?: string;
  threadLength: number;
  isJanusInitiatedThread: boolean;
  identity: ResolvedIdentity;
  route: EmailRoute;
  replyPreview?: string;
  durationMs?: number;
  status?: 'success' | 'error';
  errorMessage?: string;
  correlationId?: string;
}

function pickSeverity(input: EmailDecisionInput): 'info' | 'warn' | 'error' {
  if (input.status === 'error' || input.route === 'error') return 'error';
  if (input.route === 'outsider-throttled') return 'warn';
  return 'info';
}

export async function logJanusEmailDecision(input: EmailDecisionInput): Promise<void> {
  try {
    const summary =
      `[${input.route}] ${input.identity.displayName} <${input.fromEmail}> — ` +
      (input.subject || '(no subject)').slice(0, 80);

    await storage.createSystemAuditLog({
      category: 'janus.email',
      eventType: `email.${input.route}`,
      severity: pickSeverity(input),
      actorId: input.identity.userId,
      actorName: input.identity.displayName,
      actorRole: input.identity.role,
      channel: 'email',
      summary,
      detail: {
        fromEmail: input.fromEmail,
        fromName: input.fromName,
        subject: input.subject,
        threadId: input.threadId,
        threadLength: input.threadLength,
        isJanusInitiatedThread: input.isJanusInitiatedThread,
        identitySource: input.identity.source,
        replyPreview: input.replyPreview ? input.replyPreview.slice(0, 500) : undefined,
        errorMessage: input.errorMessage,
      },
      durationMs: input.durationMs,
      status: input.status || 'success',
      edgeFunction: 'janus-email-poll',
      correlationId: input.correlationId,
    });
  } catch (e) {
    console.error('[janus-email-audit] Failed to log decision:', e);
  }
}
