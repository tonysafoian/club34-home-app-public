import { logAudit } from "../../lib/auditLog.js";

const DAILY_CAP = 30;
const MIN_SPACING_MS = 30_000;
const COST_USD_PER_CALL = 0.05;

const laDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function laDayKey(now = new Date()): string {
  return laDateFormatter.format(now);
}

const state: {
  dayKey: string;
  count: number;
  lastAllowedAtMs: number;
} = {
  dayKey: laDayKey(),
  count: 0,
  lastAllowedAtMs: 0,
};

function rolloverIfNeeded(now: Date): void {
  const today = laDayKey(now);
  if (today !== state.dayKey) {
    state.dayKey = today;
    state.count = 0;
    state.lastAllowedAtMs = 0;
  }
}

export type BrowseSource = "chat" | "email-poll" | "whatsapp" | "external_api" | "unknown";

export interface BrowseGuardCtx {
  userId?: string;
  source: BrowseSource;
  url?: string;
  instruction?: string;
}

export interface BrowseGuardResult {
  allowed: boolean;
  message?: string;
}

export async function enforceBrowseWebsiteQuota(
  ctx: BrowseGuardCtx,
): Promise<BrowseGuardResult> {
  const now = new Date();
  rolloverIfNeeded(now);

  const sinceLastMs = now.getTime() - state.lastAllowedAtMs;
  if (state.lastAllowedAtMs > 0 && sinceLastMs < MIN_SPACING_MS) {
    const waitS = Math.max(1, Math.ceil((MIN_SPACING_MS - sinceLastMs) / 1000));
    await safeAudit("blocked_spacing", ctx, {
      day_la: state.dayKey,
      count_today: state.count,
      cap: DAILY_CAP,
      since_last_ms: sinceLastMs,
      wait_s: waitS,
    });
    return {
      allowed: false,
      message: `I just browsed a website. Let me wait ${waitS} seconds before browsing again.`,
    };
  }

  if (state.count >= DAILY_CAP) {
    await safeAudit("blocked_daily_cap", ctx, {
      day_la: state.dayKey,
      count_today: state.count,
      cap: DAILY_CAP,
    });
    return {
      allowed: false,
      message: `I've hit my daily browser-use cap (${DAILY_CAP}/day). Tell Tony if this needs to go higher.`,
    };
  }

  state.count += 1;
  state.lastAllowedAtMs = now.getTime();

  await safeAudit("allowed", ctx, {
    day_la: state.dayKey,
    count_today: state.count,
    cap: DAILY_CAP,
    cost_usd: COST_USD_PER_CALL,
  });

  return { allowed: true };
}

async function safeAudit(
  outcome: "allowed" | "blocked_daily_cap" | "blocked_spacing",
  ctx: BrowseGuardCtx,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await logAudit("browse_website_guard", {
      tool: "browse_website",
      category: "cost-tracked",
      action: outcome,
      source: ctx.source,
      user_id: ctx.userId ?? null,
      detail: {
        url: ctx.url ?? null,
        instruction: ctx.instruction ? String(ctx.instruction).slice(0, 200) : null,
        ...detail,
      },
    });
  } catch {
    // Never let an audit-log failure block tool execution.
  }
}

// Test-only — reset in-memory counters between unit tests.
export function __resetBrowseWebsiteGuardForTests(): void {
  state.dayKey = laDayKey();
  state.count = 0;
  state.lastAllowedAtMs = 0;
}
