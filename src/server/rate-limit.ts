export type RateLimitResult = { allowed: boolean; remaining: number };

const DURABLE_RATE_LIMIT_AUTHORITY = Symbol('durable-rate-limit-authority');

/**
 * Rate limiter. `durable: true` is set only by Supabase/RPC implementations —
 * memory always returns durable:false so live cannot be lied into with a flag.
 */
export type RateLimiter = {
  /** Informational only; authority checks use the module-private capability brand. */
  readonly durable: boolean;
  check(key: string): Promise<RateLimitResult> | RateLimitResult;
  ready(): Promise<boolean> | boolean;
};

export function hasDurableRateLimitAuthority(limiter: RateLimiter): boolean {
  return Boolean(
    (limiter as RateLimiter & { [DURABLE_RATE_LIMIT_AUTHORITY]?: true })[
      DURABLE_RATE_LIMIT_AUTHORITY
    ],
  );
}

export type ClientKeyResolver = (input: {
  header: (name: string) => string | undefined;
  path: string;
}) => string;

/**
 * Fail-safe key resolver: never trusts client-supplied forwarded headers.
 * Uses one global public bucket (not spoofable). Inject a trusted-proxy
 * resolver when a verified client identity is available.
 */
export function createFailSafeClientKeyResolver(): ClientKeyResolver {
  return () => `global:public`;
}

/** In-process limiter for tests and single-node demos. Not a multi-instance authority. */
export function createMemoryRateLimiter(opts: {
  limit: number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const nowFn = opts.now ?? Date.now;
  return {
    durable: false,
    ready: () => true,
    check(key: string) {
      const now = nowFn();
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + opts.windowMs };
        buckets.set(key, bucket);
      }
      if (bucket.count >= opts.limit) {
        return { allowed: false, remaining: 0 };
      }
      bucket.count += 1;
      return { allowed: true, remaining: Math.max(0, opts.limit - bucket.count) };
    },
  };
}

/** Durable Supabase rate limiter via kya_check_rate_limit RPC. */
export function createSupabaseRateLimiter(
  rpc: (
    name: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
  opts: { limit: number; windowMs: number },
): RateLimiter {
  const check = async (key: string): Promise<RateLimitResult> => {
    const { data, error } = await rpc('kya_check_rate_limit', {
      p_bucket_key: key,
      p_limit: opts.limit,
      p_window_ms: opts.windowMs,
    });
    if (error) {
      const { DomainError } = await import('../domain/state-machine.js');
      throw new DomainError('Rate limit store unavailable', 'UNAVAILABLE');
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object') {
      const { DomainError } = await import('../domain/state-machine.js');
      throw new DomainError('Rate limit store unavailable', 'UNAVAILABLE');
    }
    const allowed = Boolean((row as { allowed?: boolean }).allowed);
    const remaining = Number((row as { remaining?: number }).remaining ?? 0);
    return { allowed, remaining };
  };

  const limiter: RateLimiter = {
    durable: true,
    check,
    async ready() {
      try {
        await check('__kya_rate_limit_readiness__');
        return true;
      } catch {
        return false;
      }
    },
  };
  Object.defineProperty(limiter, DURABLE_RATE_LIMIT_AUTHORITY, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return limiter;
}
