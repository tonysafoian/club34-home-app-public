/**
 * Named circuit-breaker instances for the four most-called external
 * dependencies. Each comes with a defensible default config and an
 * env-var override so on-call can dial them without a redeploy.
 *
 * The breaker module itself (server/lib/circuit-breaker.ts) is the
 * state machine; this file just registers per-service configs and
 * exposes typed helpers so calling code reads:
 *
 *   await breakers.ha.execute(() => fetch(`${HA_URL}/api/states`));
 *
 * instead of having to remember service-name strings.
 */

import {
  configureCircuit,
  execute,
  onStateTransition,
  CircuitOpenError,
  type CircuitBreakerConfig,
} from "./circuit-breaker.js";
import { logAudit } from "./auditLog.js";

export type BreakerName = "ha" | "tesla" | "notion" | "gmail" | "ruckus" | "fortigate";

interface BreakerDefaults {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

// Per-service defaults. Tesla / Gmail are stricter (smaller blast
// radius — fewer call sites, more sensitive to authentication state)
// with longer reset windows. HA / Notion are looser; failures are
// more often transient connectivity blips.
const DEFAULTS: Record<BreakerName, BreakerDefaults> = {
  ha:     { failureThreshold: 5, resetTimeoutMs:  60_000, halfOpenMaxAttempts: 2 },
  tesla:  { failureThreshold: 3, resetTimeoutMs: 120_000, halfOpenMaxAttempts: 2 },
  notion: { failureThreshold: 5, resetTimeoutMs:  60_000, halfOpenMaxAttempts: 2 },
  gmail:  { failureThreshold: 3, resetTimeoutMs: 120_000, halfOpenMaxAttempts: 2 },
  // Ruckus reaches the controller through a Cloudflare Tunnel whose
  // origin TCP connection goes idle between our 5-min cron polls. The
  // first request after idle eats a ~10-12s warm-up; a half-open probe
  // that lands on a cold tunnel can flip the breaker straight back to
  // open. Give it 3 attempts and a longer reset so one bad cold-start
  // doesn't strand the wireless UI until the next deploy.
  ruckus: { failureThreshold: 5, resetTimeoutMs: 120_000, halfOpenMaxAttempts: 3 },
  // FortiGate also tunnels through Cloudflare with a static bearer
  // token — same failure profile as Ruckus, same thresholds.
  fortigate: { failureThreshold: 5, resetTimeoutMs:  60_000, halfOpenMaxAttempts: 2 },
};

function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveConfig(name: BreakerName): CircuitBreakerConfig {
  const d = DEFAULTS[name];
  const upper = name.toUpperCase();
  return {
    failureThreshold: envNumber(`BREAKER_${upper}_FAILURE_THRESHOLD`, d.failureThreshold),
    resetTimeoutMs: envNumber(`BREAKER_${upper}_RESET_TIMEOUT_MS`, d.resetTimeoutMs),
    halfOpenMaxAttempts: envNumber(`BREAKER_${upper}_HALF_OPEN_MAX_ATTEMPTS`, d.halfOpenMaxAttempts),
  };
}

// Underlying circuit names. Tesla maps to "tesla-api" because the
// existing server/routes/tesla.ts already operates on that name; we
// want the new breakers.tesla.execute(...) calls to share state with
// those legacy canRequest/recordSuccess/recordFailure call sites so a
// trip on either path opens the same breaker.
const UNDERLYING_NAME: Record<BreakerName, string> = {
  ha: "ha",
  tesla: "tesla-api",
  notion: "notion",
  gmail: "gmail",
  ruckus: "ruckus",
  fortigate: "fortigate",
};

// Pre-register configs on module load. The breaker module uses these
// the first time canRequest/execute references the name.
for (const n of ["ha", "tesla", "notion", "gmail", "ruckus", "fortigate"] as const) {
  configureCircuit(UNDERLYING_NAME[n], resolveConfig(n));
}

// Audit-log every state transition exactly once (regardless of how many
// blocked calls hit it — that'd flood the log). category=system,
// event_type=circuit_breaker_state, severity=warn for open, info for
// recovery. correlation_id auto-stamps from the ALS middleware so the
// transition row lines up with whatever request was running when it
// fired. Idempotent: if breakers.ts is imported twice (it shouldn't be
// but TS path-resolution surprises happen) the handler dedup is keyed
// by reference identity, so we guard with a module-scope flag.
declare global {
  var __janusBreakerAuditWired: boolean | undefined;
}
if (!globalThis.__janusBreakerAuditWired) {
  globalThis.__janusBreakerAuditWired = true;
  onStateTransition((t) => {
    const severity = t.to === "open" ? "warn" : t.to === "closed" ? "info" : "info";
    // Only the open transition is something a human should look at —
    // closed / half-open transitions are normal recovery noise.
    const actionable = t.to === "open";
    logAudit("circuit-breaker", {
      category: "system",
      event_type: "circuit_breaker_state",
      severity,
      actor_id: "system",
      actor_name: "circuit-breaker",
      channel: "system",
      summary: `Circuit "${t.name}" ${t.from} → ${t.to} (${t.reason})`,
      detail: { name: t.name, from: t.from, to: t.to, reason: t.reason, at: new Date(t.at).toISOString() },
      status: "success",
      actionable,
    }).catch((auditErr) => console.warn(`[audit] write failed: ${auditErr instanceof Error ? auditErr.message : auditErr}`));
  });
}

interface NamedBreaker {
  name: BreakerName;
  underlyingName: string;
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

function makeBreaker(name: BreakerName): NamedBreaker {
  const underlyingName = UNDERLYING_NAME[name];
  return {
    name,
    underlyingName,
    execute: (fn) => execute(underlyingName, fn),
  };
}

export const breakers = {
  ha:        makeBreaker("ha"),
  tesla:     makeBreaker("tesla"),
  notion:    makeBreaker("notion"),
  gmail:     makeBreaker("gmail"),
  ruckus:    makeBreaker("ruckus"),
  fortigate: makeBreaker("fortigate"),
} as const;

export const BREAKER_NAMES: readonly BreakerName[] = ["ha", "tesla", "notion", "gmail", "ruckus", "fortigate"];
export const UNDERLYING_BREAKER_NAMES: readonly string[] = Object.values(UNDERLYING_NAME);

/**
 * Format a TOOL_ERROR string for the chat tool dispatcher when a
 * breaker is open. The model already knows how to handle TOOL_ERROR
 * prefixes — this turns "service unreachable" into a graceful message
 * Janus can relay to the user instead of an opaque stack trace.
 */
export function toolErrorForOpenCircuit(err: CircuitOpenError): string {
  return `TOOL_ERROR: ${err.service} is temporarily unavailable; Janus has paused dependent calls. Auto-retry at ${new Date(err.retryAt).toISOString()}.`;
}

export { CircuitOpenError } from "./circuit-breaker.js";
