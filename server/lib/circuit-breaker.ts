/**
 * Circuit breaker for external dependency calls.
 *
 * State machine: closed → open → half-open → closed (or back to open).
 *
 *   - closed: requests flow through; failures are counted.
 *   - open:   requests fail fast with CircuitOpenError. After
 *             resetTimeoutMs we move to half-open on the next allow check.
 *   - half-open: a small number of probe requests are allowed through
 *             (halfOpenMaxAttempts). One failure flips back to open;
 *             one success (or enough probes without failures) closes.
 *
 * Backward-compatible API: the existing low-level helpers
 * (canRequest, recordSuccess, recordFailure, getCircuitState,
 * circuitOpenResponse) are preserved verbatim so server/routes/tesla.ts
 * and server/routes/broadcast.ts continue to work without edits.
 *
 * New API for the four service-call sites we're now wrapping:
 *   - execute(serviceName, fn)              — wraps a network call
 *   - isTransientError(err)                 — predicate for failure counting
 *   - getCircuitSnapshot(name?)             — admin telemetry
 *   - onStateTransition(handler)            — fires when state changes
 *   - CircuitOpenError                      — thrown when open
 *
 * 4xx errors (auth, validation) are explicitly NOT counted as failures.
 * Only network errors, timeouts, and 5xx upstream responses trip the
 * breaker.
 */

export type CircuitState = "closed" | "open" | "half-open";

interface CircuitRecord {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  lastSuccess: number;
  nextRetryAt: number;
}

const circuits: Map<string, CircuitRecord> = new Map();
const configs: Map<string, CircuitBreakerConfig> = new Map();

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 5 * 60_000,
  halfOpenMaxAttempts: 2,
};

/** Register a per-service config. The first execute()/canRequest() lookup uses this. */
export function configureCircuit(serviceName: string, config: CircuitBreakerConfig): void {
  configs.set(serviceName, config);
}

function getConfig(serviceName: string, override?: CircuitBreakerConfig): CircuitBreakerConfig {
  return override ?? configs.get(serviceName) ?? DEFAULT_CONFIG;
}

function getCircuit(serviceName: string): CircuitRecord {
  let circuit = circuits.get(serviceName);
  if (!circuit) {
    circuit = {
      state: "closed",
      failures: 0,
      lastFailure: 0,
      lastSuccess: 0,
      nextRetryAt: 0,
    };
    circuits.set(serviceName, circuit);
  }
  return circuit;
}

// --- State-transition hook -----------------------------------------------

export interface StateTransition {
  name: string;
  from: CircuitState;
  to: CircuitState;
  reason: string;
  at: number;
}

type TransitionHandler = (t: StateTransition) => void;
const transitionHandlers: TransitionHandler[] = [];

/** Register a handler that fires on every breaker state change. */
export function onStateTransition(handler: TransitionHandler): () => void {
  transitionHandlers.push(handler);
  return () => {
    const i = transitionHandlers.indexOf(handler);
    if (i >= 0) transitionHandlers.splice(i, 1);
  };
}

function emit(t: StateTransition): void {
  for (const h of transitionHandlers) {
    try { h(t); } catch (e) { console.error("[circuit-breaker] handler error:", e); }
  }
}

function setState(serviceName: string, circuit: CircuitRecord, next: CircuitState, reason: string): void {
  if (circuit.state === next) return;
  const from = circuit.state;
  circuit.state = next;
  emit({ name: serviceName, from, to: next, reason, at: Date.now() });
}

// --- Legacy low-level API (preserved verbatim) ---------------------------

export function canRequest(
  serviceName: string,
  config: CircuitBreakerConfig = DEFAULT_CONFIG,
): { allowed: boolean; state: CircuitState } {
  const cfg = getConfig(serviceName, config === DEFAULT_CONFIG ? undefined : config);
  const circuit = getCircuit(serviceName);
  const now = Date.now();

  if (circuit.state === "closed") {
    return { allowed: true, state: "closed" };
  }

  if (circuit.state === "open") {
    if (now >= circuit.nextRetryAt) {
      setState(serviceName, circuit, "half-open", "reset_timeout_elapsed");
      circuit.failures = 0;
      return { allowed: true, state: "half-open" };
    }
    return { allowed: false, state: "open" };
  }

  if (circuit.failures < cfg.halfOpenMaxAttempts) {
    return { allowed: true, state: "half-open" };
  }

  setState(serviceName, circuit, "open", "half_open_probe_budget_exhausted");
  circuit.nextRetryAt = now + cfg.resetTimeoutMs;
  return { allowed: false, state: "open" };
}

export function recordSuccess(serviceName: string): void {
  const circuit = getCircuit(serviceName);
  setState(serviceName, circuit, "closed", "success_after_failures");
  circuit.failures = 0;
  circuit.lastSuccess = Date.now();
}

export function recordFailure(
  serviceName: string,
  config: CircuitBreakerConfig = DEFAULT_CONFIG,
): void {
  const cfg = getConfig(serviceName, config === DEFAULT_CONFIG ? undefined : config);
  const circuit = getCircuit(serviceName);
  circuit.failures++;
  circuit.lastFailure = Date.now();

  if (circuit.state === "half-open" || circuit.failures >= cfg.failureThreshold) {
    if (circuit.state !== "open") {
      setState(serviceName, circuit, "open", circuit.state === "half-open" ? "half_open_failed" : `failure_threshold_${cfg.failureThreshold}`);
    }
    circuit.nextRetryAt = Date.now() + cfg.resetTimeoutMs;
  }
}

export function getCircuitState(serviceName: string): CircuitState {
  return getCircuit(serviceName).state;
}

export function circuitOpenResponse(serviceName: string): { status: number; body: object; headers: Record<string, string> } {
  return {
    status: 503,
    body: { error: `Service temporarily unavailable: ${serviceName}. The system will retry automatically.` },
    headers: { "Retry-After": "300" },
  };
}

// --- New high-level API --------------------------------------------------

export class CircuitOpenError extends Error {
  readonly service: string;
  readonly retryAt: number;
  constructor(service: string, retryAt: number) {
    super(`Circuit breaker open for "${service}". Auto-retry at ${new Date(retryAt).toISOString()}.`);
    this.name = "CircuitOpenError";
    this.service = service;
    this.retryAt = retryAt;
  }
}

/**
 * Decide whether an error should count as a failure for the breaker.
 * 4xx HTTP errors (auth, validation, payload size, etc.) don't trip
 * the breaker because retries won't help — only the caller can fix it.
 * Network errors, timeouts, and 5xx upstream errors do.
 *
 * The helper accepts either a thrown Error (with optional .status) or
 * a Response-like { status: number }. fetch() doesn't throw on 5xx, so
 * the execute() wrapper inspects the response's status code itself.
 */
export function isTransientError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { status?: number; statusCode?: number; name?: string; code?: string };
    const status = e.status ?? e.statusCode;
    if (typeof status === "number") {
      if (status >= 400 && status < 500) return false;
      if (status >= 500) return true;
    }
    if (e.name === "AbortError") return true; // timeout
    if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT" || e.code === "ENOTFOUND" || e.code === "ECONNREFUSED") return true;
  }
  // Bare network errors thrown by fetch() (TypeError: fetch failed, etc.) → transient.
  return true;
}

/**
 * Wrap an async function with the breaker. If the circuit is open this
 * throws CircuitOpenError before calling fn. Otherwise it runs fn:
 *
 *   - If fn returns a Response with .ok=false and .status>=500, count
 *     as failure (and return the response — the caller decides what to
 *     do with the body / error message).
 *   - If fn returns a Response with .ok=false and .status 4xx, return
 *     it WITHOUT counting failure.
 *   - If fn throws, classify via isTransientError(); count or re-throw
 *     accordingly.
 */
export async function execute<T>(serviceName: string, fn: () => Promise<T>): Promise<T> {
  const { allowed } = canRequest(serviceName);
  if (!allowed) {
    const circuit = getCircuit(serviceName);
    throw new CircuitOpenError(serviceName, circuit.nextRetryAt);
  }

  try {
    const result = await fn();
    // Best-effort inspection: if the returned value looks like a
    // fetch Response and is a 5xx, count as failure.
    if (
      result &&
      typeof result === "object" &&
      "ok" in result &&
      "status" in result &&
      typeof (result as { status: number }).status === "number"
    ) {
      const status = (result as { status: number }).status;
      const ok = (result as { ok: boolean }).ok;
      if (!ok && status >= 500) {
        recordFailure(serviceName);
        return result;
      }
      // 4xx, or 2xx/3xx (ok)
      recordSuccess(serviceName);
      return result;
    }
    recordSuccess(serviceName);
    return result;
  } catch (e) {
    if (isTransientError(e)) {
      recordFailure(serviceName);
    }
    throw e;
  }
}

/** Snapshot of one breaker (or all). For the admin endpoint. */
export interface CircuitSnapshot {
  name: string;
  state: CircuitState;
  failures: number;
  lastFailure: number | null;
  lastSuccess: number | null;
  nextRetryAt: number | null;
  config: CircuitBreakerConfig;
}

function snapshotOne(name: string): CircuitSnapshot {
  const c = getCircuit(name);
  return {
    name,
    state: c.state,
    failures: c.failures,
    lastFailure: c.lastFailure || null,
    lastSuccess: c.lastSuccess || null,
    nextRetryAt: c.nextRetryAt || null,
    config: getConfig(name),
  };
}

export function getCircuitSnapshot(name: string): CircuitSnapshot;
export function getCircuitSnapshot(): CircuitSnapshot[];
export function getCircuitSnapshot(name?: string): CircuitSnapshot | CircuitSnapshot[] {
  if (name) return snapshotOne(name);
  return Array.from(circuits.keys()).map(snapshotOne);
}

/**
 * Manually force a breaker back to closed. Used by the admin
 * "reset breaker" endpoint when an operator has verified that the
 * upstream service is healthy and wants to short-circuit the
 * normal half-open recovery dance (which can stay stuck if the
 * first probe after a cold start exceeds the upstream's own
 * connection timeout). Idempotent.
 */
export function forceClose(serviceName: string, reason = "manual_reset"): void {
  const circuit = getCircuit(serviceName);
  circuit.failures = 0;
  circuit.nextRetryAt = 0;
  setState(serviceName, circuit, "closed", reason);
}

/** Test-only helper to reset state between cases. */
export function __resetForTests(): void {
  circuits.clear();
  configs.clear();
  transitionHandlers.length = 0;
}
