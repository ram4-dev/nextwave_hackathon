import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import {
  InMemoryRepository,
  type KyaStore,
} from '../src/persistence/repository.js';
import { createApp } from '../src/server/app.js';
import type { RateLimiter } from '../src/server/rate-limit.js';

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PERSISTENCE_BACKEND: 'memory',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    FRONTEND_ORIGIN: 'http://localhost:5173',
  });
}

class AccessCountingRepository extends InMemoryRepository {
  reads = 0;
  locks = 0;

  override async getStore(): Promise<KyaStore> {
    this.reads += 1;
    return super.getStore();
  }

  override async withLock<T>(
    fn: (store: KyaStore) => Promise<T> | T,
  ): Promise<T> {
    this.locks += 1;
    return super.withLock(fn);
  }
}

const SCOPED_KYA_ROUTES = [
  ['POST', '/v1/device-enrollments/claim'],
  ['POST', '/v1/enrollments/agent_1/approve-fingerprint'],
  ['POST', '/v1/enrollments/agent_1/registration-intent'],
  ['POST', '/v1/enrollments/agent_1/registration-submissions'],
  ['POST', '/v1/enrollments/agent_1/registration-submissions/resolve'],
  ['POST', '/v1/enrollments/agent_1/confirm-demo'],
  ['POST', '/v1/enrollments/agent_1/claim-credential'],
  ['POST', '/v1/enrollments/agent_1/rotate'],
  ['POST', '/v1/enrollments/agent_1/revoke'],
  ['POST', '/v1/enrollments/agent_1/rebind'],
  ['GET', '/v1/enrollments/agent_1'],
  ['POST', '/v1/kyc/sessions'],
  ['GET', '/v1/kyc/sessions/session_1'],
  ['POST', '/v1/kyc/demo/complete'],
  ['GET', '/v1/agent/me'],
  ['GET', '/v1/me'],
] as const;

describe('scoped KYA middleware ordering', () => {
  it('rate-limits every scoped route before malformed authentication or repository work', async () => {
    const repo = new AccessCountingRepository();
    let checks = 0;
    const limiter: RateLimiter = {
      durable: false,
      ready: () => true,
      check: () => {
        checks += 1;
        return { allowed: false, remaining: 0 };
      },
    };
    const { app } = createApp(repo, config(), { publicRateLimiter: limiter });

    for (const [method, path] of SCOPED_KYA_ROUTES) {
      const response = await app.request(path, {
        method,
        headers: {
          authorization: 'Bearer malformed-and-invalid',
          'content-type': 'application/json',
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(429);
      await expect(response.json()).resolves.toMatchObject({ code: 'RATE_LIMIT' });
    }

    expect(checks).toBe(SCOPED_KYA_ROUTES.length);
    expect(repo.reads).toBe(0);
    expect(repo.locks).toBe(0);
  });
});
