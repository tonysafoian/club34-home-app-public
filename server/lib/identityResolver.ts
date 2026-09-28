/**
 * DB-backed identity resolver for inbound channels (email, future webhooks).
 *
 * Replaces hardcoded `KNOWN_USERS` maps that drifted across files. Looks up
 * household_members from local Postgres with multiple fallback strategies:
 *   1. exact email match (case-insensitive)
 *   2. strip "+tag" from local-part and re-match
 *   3. case-insensitive match against the `aliases` text[] column
 *   4. for @household domain only: match local-part against any member's local-part
 *      (ignores ./_/- separators), so user.name@example.com == user-name@example.com
 *
 * Both the member list and the resolved-identity map are cached in-memory for
 * 5 minutes. Call invalidateIdentityCache() after mutating household_members.
 */
import { storage } from '../storage.js';
import type { HouseholdMember } from '../../shared/schema.js';

export type IdentitySource =
  | 'cache' | 'email' | 'plus-tag' | 'alias' | 'local-part' | 'outsider';

export interface ResolvedIdentity {
  userId: string;
  displayName: string;
  role: string;
  source: IdentitySource;
}

const TTL_MS = 5 * 60 * 1000;
const HOUSEHOLD_DOMAIN = process.env.HOUSEHOLD_DOMAIN || 'example.com';

let memberCache: { at: number; members: HouseholdMember[] } | null = null;
const resolveCache = new Map<string, { at: number; identity: ResolvedIdentity }>();

export function invalidateIdentityCache(): void {
  memberCache = null;
  resolveCache.clear();
  phoneCache.clear();
}

async function getMembers(): Promise<HouseholdMember[]> {
  if (memberCache && Date.now() - memberCache.at < TTL_MS) return memberCache.members;
  const all = await storage.getHouseholdMembers();
  const active = all.filter((m) => m.isActive);
  memberCache = { at: Date.now(), members: active };
  return active;
}

function normalizeEmail(email: string): string {
  return (email || '').toLowerCase().trim();
}

function stripPlusTag(email: string): string {
  const at = email.indexOf('@');
  if (at < 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const cleaned = local.split('+')[0];
  return `${cleaned}@${domain}`;
}

function normLocal(s: string): string {
  return s.replace(/[._-]/g, '');
}

function buildIdentity(member: HouseholdMember, source: IdentitySource): ResolvedIdentity {
  return {
    userId: member.supabaseUuid || member.id,
    displayName: member.displayName,
    role: member.role,
    source,
  };
}

function outsiderFor(email: string): ResolvedIdentity {
  const norm = normalizeEmail(email);
  return { userId: norm, displayName: email || norm, role: 'outsider', source: 'outsider' };
}

async function resolveUncached(email: string): Promise<ResolvedIdentity> {
  const members = await getMembers();

  // 1. Direct email match
  const direct = members.find((m) => m.email && m.email.toLowerCase().trim() === email);
  if (direct) return buildIdentity(direct, 'email');

  // 2. Strip "+tag" and retry
  const stripped = stripPlusTag(email);
  if (stripped !== email) {
    const tagless = members.find((m) => m.email && m.email.toLowerCase().trim() === stripped);
    if (tagless) return buildIdentity(tagless, 'plus-tag');
  }

  // 3. Aliases array (case-insensitive)
  const aliasMatch = members.find(
    (m) => Array.isArray(m.aliases) && m.aliases.some((a) => a && a.toLowerCase().trim() === email),
  );
  if (aliasMatch) return buildIdentity(aliasMatch, 'alias');

  // 4. Same household domain — match local-part separator-insensitively
  const at = stripped.indexOf('@');
  if (at > 0) {
    const local = stripped.slice(0, at);
    const domain = stripped.slice(at + 1);
    if (domain === HOUSEHOLD_DOMAIN && local) {
      const wanted = normLocal(local);
      const localMatch = members.find((m) => {
        if (!m.email) return false;
        const memberLocal = m.email.toLowerCase().split('@')[0];
        return normLocal(memberLocal) === wanted;
      });
      if (localMatch) return buildIdentity(localMatch, 'local-part');
    }
  }

  return outsiderFor(email);
}

export async function resolveEmailIdentity(rawEmail: string): Promise<ResolvedIdentity> {
  if (!rawEmail) return outsiderFor('');
  const normalized = normalizeEmail(rawEmail);

  const cached = resolveCache.get(normalized);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { ...cached.identity, source: 'cache' };
  }

  const result = await resolveUncached(normalized);
  resolveCache.set(normalized, { at: Date.now(), identity: result });
  return result;
}

/**
 * Convenience: resolve an email and assert household membership.
 * Returns null if the resolver classified the address as an outsider.
 */
export async function resolveHouseholdEmail(rawEmail: string): Promise<ResolvedIdentity | null> {
  const id = await resolveEmailIdentity(rawEmail);
  return id.role === 'outsider' ? null : id;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phone-based resolution (WhatsApp). Mirrors the email resolver pattern so all
// inbound channels share one authoritative source: household_members.
// ──────────────────────────────────────────────────────────────────────────────

const phoneCache = new Map<string, { at: number; identity: ResolvedIdentity }>();

function normalizePhone(raw: string): string {
  return (raw || '').replace(/[^\d]/g, '');
}

/** Generate the variants we'll attempt to match against household_members.whatsapp_number. */
function phoneVariants(normalized: string): string[] {
  if (!normalized) return [];
  const stripped = normalized.replace(/^1/, '');
  const variants = new Set<string>([
    normalized,
    `+${normalized}`,
    stripped,
    `+1${stripped}`,
    `1${stripped}`,
  ]);
  return [...variants].filter(Boolean);
}

function outsiderForPhone(normalized: string): ResolvedIdentity {
  return { userId: normalized, displayName: normalized || 'unknown', role: 'outsider', source: 'outsider' };
}

async function resolvePhoneUncached(normalized: string): Promise<ResolvedIdentity> {
  const members = await getMembers();
  const candidates = new Set(phoneVariants(normalized));

  // 1. Exact / variant match on whatsapp_number column
  const direct = members.find(
    (m) => m.whatsappNumber && candidates.has(m.whatsappNumber.replace(/[^+\d]/g, '')),
  );
  if (direct) return buildIdentity(direct, 'email'); // reuse 'email' source label loosely; OK for audit

  // 2. Last-10-digits match (US convention) — covers any stored format we missed
  const last10 = normalized.slice(-10);
  if (last10.length === 10) {
    const tail = members.find((m) => {
      if (!m.whatsappNumber) return false;
      return m.whatsappNumber.replace(/[^\d]/g, '').slice(-10) === last10;
    });
    if (tail) return buildIdentity(tail, 'local-part');
  }

  return outsiderForPhone(normalized);
}

export async function resolvePhoneIdentity(rawPhone: string): Promise<ResolvedIdentity> {
  if (!rawPhone) return outsiderForPhone('');
  const normalized = normalizePhone(rawPhone);
  if (!normalized) return outsiderForPhone('');

  const cached = phoneCache.get(normalized);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { ...cached.identity, source: 'cache' };
  }

  const result = await resolvePhoneUncached(normalized);
  phoneCache.set(normalized, { at: Date.now(), identity: result });
  return result;
}

