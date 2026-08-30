/**
 * RED→GREEN remediation probes for independent audit failures.
 * These tests MUST fail before the corresponding fixes land.
 */
import { describe, expect, it } from 'vitest';
import { assertPublicEcP256Jwk } from '../src/crypto/local-agent-key.js';
import {
  checkSupabaseSchemaReady,
  KYA_SCHEMA_VERSION,
} from '../src/persistence/supabase-repository.js';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { createApp } from '../src/server/app.js';
import { createMemoryRateLimiter } from '../src/server/rate-limit.js';
import { generateLocalAgentKey } from '../src/crypto/local-agent-key.js';

function cfg(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    FRONTEND_ORIGIN: 'http://localhost:5173',
    PERSISTENCE_BACKEND: 'memory',
    ...extra,
  });
}

describe('audit probe remediation', () => {
  it('PROBE1: rejects non-canonical P-256 coordinates (x/y not 32 bytes)', () => {
    expect(() =>
      assertPublicEcP256Jwk({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }),
    ).toThrow(/coordinate|32|P-256|Invalid/i);
  });

  it('PROBE2: rejects stale schema version 20260830_01', async () => {
    const fake = {
      from(_table: string) {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return { data: { value: '20260830_01' }, error: null };
          },
        };
      },
    };
    expect(await checkSupabaseSchemaReady(fake as never)).toBe(false);
    expect(KYA_SCHEMA_VERSION).toBe('20260830_02');
  });

  it('PROBE3: legacy /v1/enrollments cannot bypass rate limiter', async () => {
    const repo = new InMemoryRepository();
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    const { app } = createApp(repo, cfg(), { publicRateLimiter: limiter });
    const key = await generateLocalAgentKey();
    const limited = await app.request('/v1/device-enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicJwk: key.publicJwk }),
    });
    expect(limited.status).toBe(201);
    const legacy = await app.request('/v1/enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publicJwk: key.publicJwk,
        keystoreProvider: 'os_hardware',
      }),
    });
    expect(legacy.status).toBe(429);
  });
});
