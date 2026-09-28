/**
 * camelCase-filename alias for ./circuit-breaker.
 *
 * Both filenames exist in the tree from earlier work and were nearly
 * identical implementations. This file is now a thin re-export so
 * there is exactly one source of truth in ./circuit-breaker.ts.
 * Existing imports from server/routes/tesla.ts and any other site
 * that uses this path keep working unchanged.
 */

export {
  canRequest,
  recordSuccess,
  recordFailure,
  getCircuitState,
  circuitOpenResponse,
  configureCircuit,
  execute,
  isTransientError,
  getCircuitSnapshot,
  onStateTransition,
  CircuitOpenError,
} from "./circuit-breaker.js";

export type {
  CircuitState,
  CircuitBreakerConfig,
  CircuitSnapshot,
  StateTransition,
} from "./circuit-breaker.js";
