import type { SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config/env.js';
import type { Repository } from '../persistence/repository.js';
import { createApp } from './app.js';
import {
  createFailSafeClientKeyResolver,
  createMemoryRateLimiter,
  createSupabaseRateLimiter,
  type RateLimiter,
} from './rate-limit.js';

export type ServerAppDeps = {
  persistenceReady?: () => Promise<boolean>;
  publicRateLimiter: RateLimiter;
  clientKeyResolver?: ReturnType<typeof createFailSafeClientKeyResolver>;
};

type CreateAppDeps = NonNullable<Parameters<typeof createApp>[2]>;
type BootstrapOwnedDeps =
  | 'persistenceReady'
  | 'publicRateLimiter'
  | 'clientKeyResolver';
export type BootstrappedAppDeps = Omit<CreateAppDeps, BootstrapOwnedDeps>;

/**
 * Testable dependency wiring shared by server main and unit tests.
 * Live + supabase requires a durable Supabase RPC rate limiter.
 */
export function buildServerAppDeps(input: {
  config: AppConfig;
  repo: Repository;
  supabaseClient?: SupabaseClient | null;
  persistenceReady?: () => Promise<boolean>;
  rateLimit?: { limit: number; windowMs: number };
}): ServerAppDeps {
  const rateOpts = input.rateLimit ?? { limit: 60, windowMs: 60_000 };
  const liveNeedsDurable =
    input.config.KYA_MODE === 'live' || input.config.PERSISTENCE_BACKEND === 'supabase';

  if (liveNeedsDurable) {
    if (!input.supabaseClient) {
      throw new Error('Durable rate limiter requires supabase client in live/supabase mode');
    }
    const client = input.supabaseClient;
    return {
      persistenceReady: input.persistenceReady,
      publicRateLimiter: createSupabaseRateLimiter(
        (name, args) => client.rpc(name, args),
        rateOpts,
      ),
      clientKeyResolver: createFailSafeClientKeyResolver(),
    };
  }

  return {
    persistenceReady: input.persistenceReady,
    publicRateLimiter: createMemoryRateLimiter(rateOpts),
    clientKeyResolver: createFailSafeClientKeyResolver(),
  };
}

/**
 * Single application assembly path for the executable and tests. Dependency
 * properties owned by bootstrap are spread last so a caller cannot override
 * the constructed limiter capability with an unrelated flag or object.
 */
export function createBootstrappedApp(input: {
  config: AppConfig;
  repo: Repository;
  supabaseClient?: SupabaseClient | null;
  persistenceReady?: () => Promise<boolean>;
  rateLimit?: { limit: number; windowMs: number };
  appDeps?: BootstrappedAppDeps;
}) {
  const serverDeps = buildServerAppDeps(input);
  return createApp(input.repo, input.config, {
    ...input.appDeps,
    ...serverDeps,
  });
}
