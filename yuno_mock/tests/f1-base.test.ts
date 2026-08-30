import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  DEV_DEFAULT_PRIVATE_SECRET_KEY,
  DEV_DEFAULT_PUBLIC_API_KEY,
  loadMockConfig,
  type MockConfig,
} from '../src/config.js';
import { InMemoryYunoRepository } from '../src/persistence/memory.js';
import { FileYunoRepository } from '../src/persistence/file.js';
import { redactHeaderRecord, redactSecrets } from '../src/redact.js';
import { ProviderIdempotency } from '../src/idempotency/primitive.js';
import { Errors } from '../src/errors.js';
import { listMvpRoutes } from '../src/mvp-routes.js';

function testConfig(overrides: Partial<MockConfig> = {}): MockConfig {
  return {
    ...loadMockConfig({ NODE_ENV: 'test' }),
    ...overrides,
  };
}

function authHeaders(config: MockConfig = testConfig()): Record<string, string> {
  return {
    'public-api-key': config.YUNO_PUBLIC_API_KEY,
    'private-secret-key': config.YUNO_PRIVATE_SECRET_KEY,
  };
}

describe('config', () => {
  it('uses safe defaults in development/test', () => {
    const config = loadMockConfig({ NODE_ENV: 'test' });
    expect(config.YUNO_PUBLIC_API_KEY).toBe(DEV_DEFAULT_PUBLIC_API_KEY);
    expect(config.YUNO_PRIVATE_SECRET_KEY).toBe(DEV_DEFAULT_PRIVATE_SECRET_KEY);
    expect(config.PORT).toBe(8080);
  });

  it('fails closed in production without explicit keys', () => {
    expect(() => loadMockConfig({ NODE_ENV: 'production' })).toThrow(
      /production requires explicit/,
    );
  });

  it('fails closed in production without fingerprint secret', () => {
    expect(() =>
      loadMockConfig({
        NODE_ENV: 'production',
        YUNO_PUBLIC_API_KEY: 'prod_public',
        YUNO_PRIVATE_SECRET_KEY: 'prod_private',
      }),
    ).toThrow(/YUNO_MOCK_FINGERPRINT_SECRET/);
  });

  it('accepts explicit production keys', () => {
    const config = loadMockConfig({
      NODE_ENV: 'production',
      YUNO_PUBLIC_API_KEY: 'prod_public',
      YUNO_PRIVATE_SECRET_KEY: 'prod_private',
      YUNO_MOCK_FINGERPRINT_SECRET: 'prod_fingerprint',
      YUNO_MOCK_SECRETS_KEY:
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      YUNO_DATA_DIR: '/tmp/yuno-prod-data',
    });
    expect(config.YUNO_PUBLIC_API_KEY).toBe('prod_public');
    expect(config.YUNO_MOCK_FINGERPRINT_SECRET).toBe('prod_fingerprint');
  });

  it('requires explicit secrets key in production', () => {
    expect(() =>
      loadMockConfig({
        NODE_ENV: 'production',
        YUNO_PUBLIC_API_KEY: 'prod_public',
        YUNO_PRIVATE_SECRET_KEY: 'prod_private',
        YUNO_MOCK_FINGERPRINT_SECRET: 'prod_fingerprint',
      }),
    ).toThrow(/YUNO_MOCK_SECRETS_KEY/);
  });
});

describe('health', () => {
  it('is unauthenticated and outside /v1', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'ok', service: 'yuno-rest-mock', phase: 'F5' });
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

describe('auth', () => {
  it('rejects missing credentials on /v1', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/v1/customers', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: 'INVALID_CREDENTIALS',
      messages: ['Missing public-api-key or private-secret-key'],
    });
  });

  it('rejects wrong credentials on /v1', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: {
        'public-api-key': 'wrong',
        'private-secret-key': config.YUNO_PRIVATE_SECRET_KEY,
      },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: 'INVALID_CREDENTIALS',
      messages: ['Invalid credentials'],
    });
  });

  it('accepts correct credentials and creates customer (F2)', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: {
        ...authHeaders(config),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ merchant_customer_id: 'usr_test' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; merchant_customer_id: string };
    expect(body.merchant_customer_id).toBe('usr_test');
    expect(body.id).toBeTruthy();
  });

  it('returns 400 INVALID_REQUEST for capture with empty body (F5 implemented)', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request(
      '/v1/payments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/transactions/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/capture',
      {
        method: 'POST',
        headers: {
          ...authHeaders(config),
          'content-type': 'application/json',
          'X-Idempotency-Key': 'stub-key',
        },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; messages: string[] };
    expect(body.code).toBe('INVALID_REQUEST');
  });

  it('reports F5 phase on health', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phase: string };
    expect(body.phase).toBe('F5');
  });

  it('returns NOT_FOUND for non-MVP /v1 paths when authenticated', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/v1/merchants', {
      method: 'GET',
      headers: authHeaders(config),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('json errors', () => {
  it('returns Yuno envelope for malformed JSON', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: {
        ...authHeaders(config),
        'content-type': 'application/json',
      },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'INVALID_REQUEST',
      messages: ['Request body must be valid JSON'],
    });
  });
});

describe('secret redaction', () => {
  it('redacts configured keys from strings and headers', () => {
    const config = testConfig();
    const leaked = `key=${config.YUNO_PRIVATE_SECRET_KEY} pub=${config.YUNO_PUBLIC_API_KEY}`;
    expect(redactSecrets(leaked, [config.YUNO_PUBLIC_API_KEY, config.YUNO_PRIVATE_SECRET_KEY])).toBe(
      'key=[REDACTED] pub=[REDACTED]',
    );
    expect(
      redactHeaderRecord({
        'public-api-key': config.YUNO_PUBLIC_API_KEY,
        'private-secret-key': config.YUNO_PRIVATE_SECRET_KEY,
        'X-Request-Id': 'abc',
      }),
    ).toEqual({
      'public-api-key': '[REDACTED]',
      'private-secret-key': '[REDACTED]',
      'X-Request-Id': 'abc',
    });
  });

  it('does not echo secrets in error JSON bodies', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: {
        'public-api-key': config.YUNO_PUBLIC_API_KEY,
        'private-secret-key': 'wrong-secret',
      },
    });
    const text = await res.text();
    expect(text).not.toContain(config.YUNO_PUBLIC_API_KEY);
    expect(text).not.toContain(config.YUNO_PRIVATE_SECRET_KEY);
    expect(text).not.toContain('wrong-secret');
  });
});

describe('mvp contract facade', () => {
  it('exposes exactly the 18 pinned MVP routes', () => {
    const routes = listMvpRoutes();
    expect(routes).toHaveLength(18);
    expect(routes.some((r) => r.key === 'create-customer' && r.path === '/customers')).toBe(true);
    expect(routes.some((r) => r.path.includes('merchant'))).toBe(false);
  });
});

describe('file persistence', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    // temp dirs are left for OS cleanup; no secrets written
    dirs.length = 0;
  });

  it('round-trips store data atomically', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yuno-mock-'));
    dirs.push(dir);
    const filePath = path.join(dir, 'store.json');
    const repo = new FileYunoRepository(filePath, loadMockConfig({ NODE_ENV: "test" }).secretsKey);

    await repo.withLock((store) => {
      store.customers.push({
        id: 'cus_1',
        data: { merchant_customer_id: 'usr_1' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    const raw = await readFile(filePath, 'utf8');
    expect(JSON.parse(raw).customers[0].id).toBe('cus_1');

    const repo2 = new FileYunoRepository(filePath, loadMockConfig({ NODE_ENV: "test" }).secretsKey);
    const loaded = await repo2.getStore();
    expect(loaded.customers).toHaveLength(1);
    expect(loaded.idempotency).toEqual([]);
    expect(loaded.scenarios).toEqual([]);
  });

  it('uses temp+rename (no leftover .tmp after success)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yuno-mock-'));
    const filePath = path.join(dir, 'store.json');
    const repo = new FileYunoRepository(filePath, loadMockConfig({ NODE_ENV: "test" }).secretsKey);
    await repo.saveStore({
      customers: [],
      sessions: [],
      paymentMethods: [],
      payments: [],
      webhooks: [],
      idempotency: [],
      events: [],
      deliveries: [],
      asyncActions: [],
      scenarios: [],
      appliedEventIds: [],
    });
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(files).toContain('store.json');
  });

  it('serializes concurrent withLock callers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yuno-mock-'));
    const filePath = path.join(dir, 'store.json');
    const repo = new FileYunoRepository(filePath, loadMockConfig({ NODE_ENV: "test" }).secretsKey);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        repo.withLock(async (store) => {
          const current = store.customers.length;
          await new Promise((r) => setTimeout(r, 1));
          store.customers.push({
            id: `cus_${i}`,
            data: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          expect(store.customers.length).toBe(current + 1);
        }),
      ),
    );

    const store = await repo.getStore();
    expect(store.customers).toHaveLength(20);
  });
});

describe('in-memory concurrent lock', () => {
  it('serializes withLock', async () => {
    const repo = new InMemoryYunoRepository();
    await Promise.all(
      Array.from({ length: 25 }, () =>
        repo.withLock(async (store) => {
          const n = store.payments.length;
          await new Promise((r) => setTimeout(r, 0));
          store.payments.push({
            id: `pay_${n}`,
            data: {},
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }),
      ),
    );
    expect((await repo.getStore()).payments).toHaveLength(25);
  });
});

describe('provider idempotency', () => {
  it('replays COMPLETED response and ignores retry body semantics', async () => {
    const repo = new InMemoryYunoRepository();
    const idemp = new ProviderIdempotency(repo);
    const begin1 = await idemp.begin('key-1');
    expect(begin1.kind).toBe('acquired');
    await idemp.complete('key-1', 201, { id: 'pay_1' });

    const begin2 = await idemp.begin('key-1');
    expect(begin2).toEqual({ kind: 'replay', status: 201, body: { id: 'pay_1' } });
  });

  it('returns REQUEST_IN_PROCESS while IN_PROGRESS', async () => {
    const repo = new InMemoryYunoRepository();
    const idemp = new ProviderIdempotency(repo);
    await idemp.begin('key-2');
    await expect(idemp.beginOrThrow('key-2')).rejects.toMatchObject({
      code: 'REQUEST_IN_PROCESS',
      status: 400,
    });
    expect(Errors.requestInProcess().toBody()).toEqual({
      code: 'REQUEST_IN_PROCESS',
      messages: ['A request with this idempotency key is still in process'],
    });
  });

  it('returns IDEMPOTENCY_DUPLICATED after CONSUMED_WITHOUT_RESULT', async () => {
    const repo = new InMemoryYunoRepository();
    const idemp = new ProviderIdempotency(repo);
    await idemp.begin('key-3');
    await idemp.consumeWithoutResult('key-3');
    await expect(idemp.beginOrThrow('key-3')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_DUPLICATED',
      status: 400,
    });
  });

  it('does not consume key when abandoned before start / rejected-before-start', async () => {
    const repo = new InMemoryYunoRepository();
    const idemp = new ProviderIdempotency(repo);
    await idemp.begin('key-4');
    await idemp.abandonWithoutConsume('key-4');
    const again = await idemp.begin('key-4');
    expect(again.kind).toBe('acquired');
  });

  it('rejected-before-start path: never calling begin leaves key free', async () => {
    const repo = new InMemoryYunoRepository();
    const idemp = new ProviderIdempotency(repo);
    // Simulate validation failure before begin — key unused
    const store = await repo.getStore();
    expect(store.idempotency).toEqual([]);
    const first = await idemp.begin('key-5');
    expect(first.kind).toBe('acquired');
  });

  it('persists idempotency state on file backend', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yuno-idemp-'));
    const filePath = path.join(dir, 'store.json');
    const repo = new FileYunoRepository(filePath, loadMockConfig({ NODE_ENV: "test" }).secretsKey);
    const idemp = new ProviderIdempotency(repo);
    await idemp.begin('file-key');
    await idemp.complete('file-key', 200, { ok: true });

    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    expect(raw.idempotency[0].state).toBe('COMPLETED');

    const idemp2 = new ProviderIdempotency(new FileYunoRepository(filePath, loadMockConfig({ NODE_ENV: "test" }).secretsKey));
    expect(await idemp2.begin('file-key')).toEqual({
      kind: 'replay',
      status: 200,
      body: { ok: true },
    });
  });

  it('lookupExisting is non-mutating and concurrent begin yields one acquired + one in_progress', async () => {
    const repo = new InMemoryYunoRepository();
    const idemp = new ProviderIdempotency(repo);

    expect(await idemp.lookupExisting('peek-1', 'scope-a')).toEqual({ kind: 'absent' });
    await idemp.begin('peek-1', 'scope-a');
    expect(await idemp.lookupExisting('peek-1', 'scope-a')).toEqual({ kind: 'in_progress' });
    expect((await repo.getStore()).idempotency).toHaveLength(1);

    await idemp.complete('peek-1', 201, { id: 'x' }, 'scope-a');
    expect(await idemp.lookupExisting('peek-1', 'scope-a')).toEqual({
      kind: 'replay',
      status: 201,
      body: { id: 'x' },
    });
    expect(await idemp.lookupExistingOrThrow('peek-1', 'scope-a')).toEqual({
      kind: 'replay',
      status: 201,
      body: { id: 'x' },
    });

    const concurrent = await Promise.all([
      idemp.begin('concurrent-1', 'scope-b'),
      idemp.begin('concurrent-1', 'scope-b'),
    ]);
    const kinds = concurrent.map((r) => r.kind).sort();
    expect(kinds).toEqual(['acquired', 'in_progress']);
  });
});

describe('corrupt store file', () => {
  it('surfaces JSON parse errors from getStore', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yuno-bad-'));
    const filePath = path.join(dir, 'store.json');
    await writeFile(filePath, '{bad', 'utf8');
    const repo = new FileYunoRepository(filePath, loadMockConfig({ NODE_ENV: "test" }).secretsKey);
    await expect(repo.getStore()).rejects.toThrow();
  });
});
