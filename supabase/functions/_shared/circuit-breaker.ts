export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitRecord {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  lastSuccess: number;
  nextRetryAt: number;
}

const circuits: Map<string, CircuitRecord> = new Map();

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

function getCircuit(serviceName: string): CircuitRecord {
  let circuit = circuits.get(serviceName);
  if (!circuit) {
    circuit = { state: 'closed', failures: 0, lastFailure: 0, lastSuccess: 0, nextRetryAt: 0 };
    circuits.set(serviceName, circuit);
  }
  return circuit;
}

export function canRequest(serviceName: string, config: CircuitBreakerConfig = DEFAULT_CONFIG): { allowed: boolean; state: CircuitState } {
  const circuit = getCircuit(serviceName);
  const now = Date.now();

  if (circuit.state === 'closed') {
    return { allowed: true, state: 'closed' };
  }

  if (circuit.state === 'open') {
    if (now >= circuit.nextRetryAt) {
      circuit.state = 'half-open';
      circuit.failures = 0;
      return { allowed: true, state: 'half-open' };
    }
    return { allowed: false, state: 'open' };
  }

  if (circuit.failures < config.halfOpenMaxAttempts) {
    return { allowed: true, state: 'half-open' };
  }

  circuit.state = 'open';
  circuit.nextRetryAt = now + config.resetTimeoutMs;
  return { allowed: false, state: 'open' };
}

export function recordSuccess(serviceName: string): void {
  const circuit = getCircuit(serviceName);
  circuit.state = 'closed';
  circuit.failures = 0;
  circuit.lastSuccess = Date.now();
}

export function recordFailure(serviceName: string, config: CircuitBreakerConfig = DEFAULT_CONFIG): void {
  const circuit = getCircuit(serviceName);
  circuit.failures++;
  circuit.lastFailure = Date.now();

  if (circuit.state === 'half-open' || circuit.failures >= config.failureThreshold) {
    circuit.state = 'open';
    circuit.nextRetryAt = Date.now() + config.resetTimeoutMs;
  }
}

export function getCircuitState(serviceName: string): CircuitState {
  return getCircuit(serviceName).state;
}

export function circuitOpenResponse(serviceName: string, corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      error: `Service temporarily unavailable: ${serviceName}. The system will retry automatically.`,
    }),
    {
      status: 503,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': '300',
      },
    },
  );
}
