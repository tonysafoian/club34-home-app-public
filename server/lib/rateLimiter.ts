const buckets: Map<string, { tokens: number; lastRefill: number }> = new Map();

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = { maxRequests: 60, windowMs: 60_000 };

export function checkRateLimit(
  userId: string,
  functionName: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
): { allowed: boolean; retryAfterMs: number } {
  const key = `${functionName}:${userId}`;
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket || now - bucket.lastRefill >= config.windowMs) {
    bucket = { tokens: config.maxRequests - 1, lastRefill: now };
    buckets.set(key, bucket);
    return { allowed: true, retryAfterMs: 0 };
  }

  if (bucket.tokens > 0) {
    bucket.tokens--;
    return { allowed: true, retryAfterMs: 0 };
  }

  const retryAfterMs = config.windowMs - (now - bucket.lastRefill);
  return { allowed: false, retryAfterMs };
}
