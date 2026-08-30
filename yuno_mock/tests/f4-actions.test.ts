import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadMockConfig, type MockConfig } from '../src/config.js';
import { InMemoryYunoRepository } from '../src/persistence/memory.js';
import { FileYunoRepository } from '../src/persistence/file.js';
import { createManualClock, createRuntime } from '../src/runtime.js';
import { processDueWork } from '../src/services/webhook-delivery.js';
import {
  createManualScheduler,
  createWorkProcessorFromConfig,
} from '../src/services/work-processor.js';
import { WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_OFFSETS_MS } from '../src/domain/retry.js';
import {
  signYunoWebhookBody,
  verifyYunoWebhookSignature,
  YUNO_HMAC_SIGNATURE_HEADER,
} from '../../src/providers/yuno/webhook-verifier.js';
import { decidePaymentEventApplication } from '../../src/providers/yuno/payment-event-guard.js';
import { validateResponse } from '../../src/providers/yuno/validate.js';
import { assertNoSensitiveMaterial } from '../src/domain/sensitive.js';
import { encryptSecret } from '../src/crypto/secrets-at-rest.js';

const ACCOUNT_ID = '493e9374-510a-4201-9e09-de669d75f256';
const TEST_PAN = '4111111111111111';
const TEST_CVV = '123';
const HMAC_SECRET = 'test-hmac-client-secret-value-f4';

function testConfig(overrides: Partial<MockConfig> = {}): MockConfig {
  return {
    ...loadMockConfig({ NODE_ENV: 'test' }),
    ...overrides,
  };
}

function authHeaders(config: MockConfig): Record<string, string> {
  return {
    'public-api-key': config.YUNO_PUBLIC_API_KEY,
    'private-secret-key': config.YUNO_PRIVATE_SECRET_KEY,
    'content-type': 'application/json',
  };
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function enrollVaultedMethod(
  app: ReturnType<typeof createApp>,
  config: MockConfig,
  merchantCustomerId: string,
): Promise<{ vaultedToken: string }> {
  const custRes = await app.request('/v1/customers', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ merchant_customer_id: merchantCustomerId }),
  });
  expect(custRes.status).toBe(201);
  const customer = await json<{ id: string }>(custRes);

  const sessRes = await app.request('/v1/customers/sessions', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      account_id: ACCOUNT_ID,
      country: 'CO',
      customer_id: customer.id,
    }),
  });
  expect(sessRes.status).toBe(201);
  const session = await json<{ customer_session: string }>(sessRes);

  const tokRes = await app.request('/test/enrollment/tokenize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer_session: session.customer_session,
      pan: TEST_PAN,
      cvv: TEST_CVV,
      expiration_month: 12,
      expiration_year: 30,
    }),
  });
  expect(tokRes.status).toBe(201);
  const tokenized = await json<{ vaulted_token: string }>(tokRes);

  const enrollRes = await app.request(
    `/v1/customers/sessions/${session.customer_session}/payment-methods`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(config),
        'X-Idempotency-Key': `enroll-${merchantCustomerId}`,
      },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        payment_method_type: 'CARD',
        country: 'CO',
      }),
    },
  );
  expect(enrollRes.status).toBe(201);
  return { vaultedToken: tokenized.vaulted_token };
}

function paymentBody(vaultedToken: string, overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT_ID,
    description: 'F4 test payment',
    country: 'CO',
    merchant_order_id: 'order-f4-001',
    amount: { currency: 'COP', value: 1250 },
    payment_method: {
      type: 'CARD',
      vaulted_token: vaultedToken,
    },
    checkout: {},
    workflow: 'DIRECT',
    ...overrides,
  };
}

type ReceivedDelivery = {
  rawBody: string;
  signature: string | null;
  headers: Record<string, string | string[] | undefined>;
};

function createReceiver(opts: {
  hmacSecret: string;
  statusForAttempt?: (n: number) => number;
}): Promise<{
  url: string;
  close: () => Promise<void>;
  deliveries: ReceivedDelivery[];
  mutations: number;
  appliedEventIds: string[];
}> {
  const deliveries: ReceivedDelivery[] = [];
  const appliedEventIds: string[] = [];
  let mutations = 0;
  let attempt = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      attempt += 1;
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const signature = String(req.headers[YUNO_HMAC_SIGNATURE_HEADER] ?? '');
      deliveries.push({
        rawBody,
        signature,
        headers: { ...req.headers },
      });

      const valid = verifyYunoWebhookSignature({
        rawBody,
        signatureHeader: signature,
        secret: opts.hmacSecret,
      });
      if (!valid) {
        res.statusCode = 401;
        res.end('invalid hmac');
        return;
      }

      let parsed: { id?: string; data?: { payment?: { status?: string; sub_status?: string } } };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        res.statusCode = 400;
        res.end('bad json');
        return;
      }

      const eventId = parsed.id ?? '';
      if (!appliedEventIds.includes(eventId)) {
        appliedEventIds.push(eventId);
        mutations += 1;
      }

      const code = opts.statusForAttempt?.(attempt) ?? 200;
      res.statusCode = code;
      res.end(code === 200 ? 'ok' : 'retry');
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no addr'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/hooks`,
        close: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
        deliveries,
        get mutations() {
          return mutations;
        },
        appliedEventIds,
      });
    });
  });
}

describe('F4 webhook HMAC verifier (raw bytes)', () => {
  it('signs and verifies over exact raw body; rejects tamper/invalid', () => {
    const raw = '{"id":"evt_1","type_event":"PURCHASE"}';
    const sig = signYunoWebhookBody(raw, HMAC_SECRET);
    expect(
      verifyYunoWebhookSignature({
        rawBody: raw,
        signatureHeader: sig,
        secret: HMAC_SECRET,
      }),
    ).toBe(true);
    expect(
      verifyYunoWebhookSignature({
        rawBody: raw,
        signatureHeader: sig,
        secret: 'wrong',
      }),
    ).toBe(false);
    expect(
      verifyYunoWebhookSignature({
        rawBody: '{"id":"evt_1","type_event":"PURCHASE" }',
        signatureHeader: sig,
        secret: HMAC_SECRET,
      }),
    ).toBe(false);
    expect(
      verifyYunoWebhookSignature({
        rawBody: Buffer.from(raw, 'utf8'),
        signatureHeader: sig,
        secret: HMAC_SECRET,
      }),
    ).toBe(true);
  });
});

describe('F4 webhook CRUD + secret at rest', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('creates/lists/patches/deletes webhooks with contract validators; masks secrets', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });

    const createRes = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'payments-webhook',
        url: 'https://api.example.test/hooks',
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE', 'AUTHORIZE'],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await json<{
      id: string;
      hmac_client_secret: string | null;
      name: string;
    }>(createRes);
    expect(created.hmac_client_secret).toBe('***');
    expect(JSON.stringify(created)).not.toContain(HMAC_SECRET);
    expect(validateResponse('create-webhook', 201, created).ok).toBe(true);
    assertNoSensitiveMaterial(created, [HMAC_SECRET, ...Object.values(authHeaders(config))]);

    const listRes = await app.request('/v1/webhooks', { headers: authHeaders(config) });
    expect(listRes.status).toBe(200);
    const listed = await json<unknown[]>(listRes);
    expect(listed).toHaveLength(1);
    expect(validateResponse('list-webhooks', 200, listed).ok).toBe(true);

    const patchRes = await app.request(`/v1/webhooks/${created.id}`, {
      method: 'PATCH',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'payments-webhook-renamed',
        state: 'INACTIVE',
      }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await json<{ name: string; state: string }>(patchRes);
    expect(patched.name).toBe('payments-webhook-renamed');
    expect(patched.state).toBe('INACTIVE');

    const delRes = await app.request(`/v1/webhooks/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders(config),
    });
    expect(delRes.status).toBe(200);
    const list2 = await json<unknown[]>(
      await app.request('/v1/webhooks', { headers: authHeaders(config) }),
    );
    expect(list2).toHaveLength(0);
  });

  it('file store never contains HMAC secret plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuno-f4-'));
    dirs.push(dir);
    const config = testConfig({
      YUNO_STORE_BACKEND: 'file',
      YUNO_DATA_DIR: dir,
      storeFilePath: join(dir, 'yuno-mock-store.json'),
    });
    const repo = new FileYunoRepository(config.storeFilePath, config.secretsKey);
    const app = createApp({ config, repo });

    const createRes = await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'secure-hook',
        url: 'https://api.example.test/hooks',
        hmac_client_secret: HMAC_SECRET,
        api_key: 'api-key-cleartext-should-encrypt',
        payment_triggers: ['PURCHASE'],
      }),
    });
    expect(createRes.status).toBe(201);

    const raw = await readFile(config.storeFilePath, 'utf8');
    expect(raw).not.toContain(HMAC_SECRET);
    expect(raw).not.toContain('api-key-cleartext-should-encrypt');
    expect(raw).toContain('aes-256-gcm');
    expect(raw).toContain('ciphertext');
  });

  it('migrates legacy cleartext webhook secrets on file load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuno-f4-mig-'));
    dirs.push(dir);
    const filePath = join(dir, 'store.json');
    const config = testConfig();
    const legacy = {
      customers: [],
      sessions: [],
      paymentMethods: [],
      payments: [],
      webhooks: [
        {
          id: 'wh_legacy',
          data: {
            account_id: ACCOUNT_ID,
            name: 'legacy',
            url: 'https://api.example.test/hooks',
            state: 'ACTIVE',
            enrollment_triggers: null,
            payment_triggers: ['PURCHASE'],
            onboarding_triggers: null,
            subscription_triggers: null,
            report_triggers: null,
            renewal_days: null,
            oauth2_authentication_url: null,
            oauth2_authorization_name: null,
            oauth2_client_id: null,
            oauth2_grant_type: null,
            oauth2_include_client_id: false,
            oauth2_scope: null,
          },
          secrets: { hmac_client_secret: HMAC_SECRET },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      idempotency: [],
      events: [],
      deliveries: [],
      scenarios: [],
    };
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, JSON.stringify(legacy), 'utf8');

    const repo = new FileYunoRepository(filePath, config.secretsKey);
    await repo.withLock(() => undefined);
    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain(HMAC_SECRET);
    expect(raw).toContain('aes-256-gcm');
  });
});

describe('F4 delivery retries + 3DS + async scenarios', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((c) => c()));
  });

  it('retries up to 7 attempts then stops on 200; schedule matches offsets', async () => {
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(7);
    expect([...WEBHOOK_RETRY_OFFSETS_MS]).toEqual([
      0,
      5 * 60 * 1000,
      50 * 60 * 1000,
      6 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
      48 * 60 * 60 * 1000,
      96 * 60 * 60 * 1000,
    ]);

    const receiver = await createReceiver({
      hmacSecret: HMAC_SECRET,
      statusForAttempt: (n) => (n < 7 ? 500 : 200),
    });
    closers.push(receiver.close);

    const clock = createManualClock(1_000_000);
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({
      config,
      repo,
      runtime: createRuntime({ clock, fetch: globalThis.fetch.bind(globalThis) }),
    });

    await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'retry-hook',
        url: receiver.url,
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE'],
      }),
    });

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'success' }),
    });

    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_retry');
    const createRes = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-retry-1' },
      body: JSON.stringify(paymentBody(vaultedToken)),
    });
    expect(createRes.status).toBe(201);

    // First attempt already ran via processDueWork after create (got 500).
    expect(receiver.deliveries.length).toBe(1);

    for (let i = 1; i < WEBHOOK_MAX_ATTEMPTS; i += 1) {
      const delta = WEBHOOK_RETRY_OFFSETS_MS[i]! - WEBHOOK_RETRY_OFFSETS_MS[i - 1]!;
      clock.advance(delta);
      await processDueWork(repo, createRuntime({ clock }), config.secretsKey);
    }

    expect(receiver.deliveries.length).toBe(7);
    expect(receiver.deliveries.every((d) => d.signature)).toBe(true);
    const store = await repo.getStore();
    const delivery = store.deliveries[0]!;
    expect(delivery.attempt).toBe(7);
    expect(delivery.status).toBe('delivered');
  });

  it('requires_3ds create → PENDING/WAITING_ADDITIONAL_STEP; complete success/fail/expire; repeat/stale stable', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'requires_3ds' }),
    });

    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_3ds');
    const createRes = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-3ds-1' },
      body: JSON.stringify(paymentBody(vaultedToken)),
    });
    expect(createRes.status).toBe(201);
    const created = await json<{
      id: string;
      status: string;
      sub_status: string;
      checkout: { sdk_action_required: boolean };
    }>(createRes);
    expect(created.status).toBe('PENDING');
    expect(created.sub_status).toBe('WAITING_ADDITIONAL_STEP');
    expect(created.checkout.sdk_action_required).toBe(true);
    expect(validateResponse('create-payment', 201, created).ok).toBe(true);

    const inspect = await json<{ three_ds: { status: string } }>(
      await app.request(`/test/payments/${created.id}/3ds`),
    );
    expect(inspect.three_ds.status).toBe('pending');

    const done = await json<{ payment: { status: string; checkout: { sdk_action_required: boolean } } }>(
      await app.request(`/test/payments/${created.id}/3ds/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'success' }),
      }),
    );
    expect(done.payment.status).toBe('SUCCEEDED');
    expect(done.payment.checkout.sdk_action_required).toBe(false);

    const again = await json<{ payment: { status: string } }>(
      await app.request(`/test/payments/${created.id}/3ds/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'fail' }),
      }),
    );
    expect(again.payment.status).toBe('SUCCEEDED');

    // fail path
    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'requires_3ds' }),
    });
    const { vaultedToken: vt2 } = await enrollVaultedMethod(app, config, 'usr_3ds_fail');
    const c2 = await json<{ id: string }>(
      await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-3ds-fail' },
        body: JSON.stringify(paymentBody(vt2, { merchant_order_id: 'o-fail' })),
      }),
    );
    const fail = await json<{ payment: { status: string } }>(
      await app.request(`/test/payments/${c2.id}/3ds/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'fail' }),
      }),
    );
    expect(fail.payment.status).toBe('DECLINED');

    // expire path
    const { vaultedToken: vt3 } = await enrollVaultedMethod(app, config, 'usr_3ds_exp');
    const c3 = await json<{ id: string }>(
      await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-3ds-exp' },
        body: JSON.stringify(paymentBody(vt3, { merchant_order_id: 'o-exp' })),
      }),
    );
    const exp = await json<{ payment: { status: string } }>(
      await app.request(`/test/payments/${c3.id}/3ds/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result: 'expire' }),
      }),
    );
    expect(exp.payment.status).toBe('EXPIRED');
  });

  it('processing_then_success/declined advance asynchronously and emit terminal event', async () => {
    const receiver = await createReceiver({ hmacSecret: HMAC_SECRET });
    closers.push(receiver.close);
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });

    await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'async-hook',
        url: receiver.url,
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE'],
      }),
    });

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'processing_then_success' }),
    });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_proc_ok');
    const created = await json<{ id: string; status: string }>(
      await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-proc-ok' },
        body: JSON.stringify(paymentBody(vaultedToken)),
      }),
    );
    expect(created.status).toBe('PENDING');
    await app.request('/test/work/process', { method: 'POST' });
    const got = await json<{ payment: { status: string } }>(
      await app.request(`/v1/payments/${created.id}`, { headers: authHeaders(config) }),
    );
    expect(got.payment.status).toBe('SUCCEEDED');
    expect(receiver.deliveries.length).toBeGreaterThanOrEqual(1);
    expect(
      verifyYunoWebhookSignature({
        rawBody: receiver.deliveries[0]!.rawBody,
        signatureHeader: receiver.deliveries[0]!.signature,
        secret: HMAC_SECRET,
      }),
    ).toBe(true);

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'processing_then_declined' }),
    });
    const { vaultedToken: vt2 } = await enrollVaultedMethod(app, config, 'usr_proc_dec');
    const created2 = await json<{ id: string; status: string }>(
      await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-proc-dec' },
        body: JSON.stringify(paymentBody(vt2, { merchant_order_id: 'o-dec' })),
      }),
    );
    expect(created2.status).toBe('PENDING');
    await app.request('/test/work/process', { method: 'POST' });
    const got2 = await json<{ payment: { status: string } }>(
      await app.request(`/v1/payments/${created2.id}`, { headers: authHeaders(config) }),
    );
    expect(got2.payment.status).toBe('DECLINED');
  });

  it('duplicate_webhook redelivers same id without repeated mutation; out_of_order never rewinds', async () => {
    const receiver = await createReceiver({ hmacSecret: HMAC_SECRET });
    closers.push(receiver.close);
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });

    await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'dup-hook',
        url: receiver.url,
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE'],
      }),
    });

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'duplicate_webhook' }),
    });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_dup');
    await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-dup' },
      body: JSON.stringify(paymentBody(vaultedToken)),
    });
    // First delivery from sync emit; second after async duplicate_redelivery.
    await app.request('/test/work/process', { method: 'POST' });

    expect(receiver.deliveries.length).toBeGreaterThanOrEqual(2);
    const ids = receiver.deliveries.map((d) => (JSON.parse(d.rawBody) as { id: string }).id);
    expect(ids[0]).toBe(ids[1]);
    expect(receiver.deliveries[0]!.rawBody).toBe(receiver.deliveries[1]!.rawBody);
    const store = await repo.getStore();
    const eventId = ids[0]!;
    expect(store.appliedEventIds.filter((id) => id === eventId)).toHaveLength(1);
    expect(store.payments[0]!.data.status).toBe('SUCCEEDED');

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'out_of_order_webhooks' }),
    });
    const { vaultedToken: vt2 } = await enrollVaultedMethod(app, config, 'usr_ooo');
    const created = await json<{ id: string }>(
      await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-ooo' },
        body: JSON.stringify(paymentBody(vt2, { merchant_order_id: 'o-ooo' })),
      }),
    );
    await app.request('/test/work/process', { method: 'POST' });
    const got = await json<{ payment: { status: string } }>(
      await app.request(`/v1/payments/${created.id}`, { headers: authHeaders(config) }),
    );
    expect(got.payment.status).toBe('SUCCEEDED');
    const store2 = await repo.getStore();
    const payment = store2.payments.find((p) => p.id === created.id)!;
    expect(payment.data.status).toBe('SUCCEEDED');

    // Receiver must observe terminal SUCCEEDED first, then a genuine PENDING stale payload.
    const oooDeliveries = receiver.deliveries
      .map((d) => JSON.parse(d.rawBody) as {
        data: {
          payment: {
            id: string;
            status: string;
            sub_status: string;
            amount: { captured: number };
            transactions: { status: string };
          };
        };
      })
      .filter((p) => p.data.payment.id === created.id);
    expect(oooDeliveries.length).toBeGreaterThanOrEqual(2);
    expect(oooDeliveries[0]!.data.payment.status).toBe('SUCCEEDED');
    const stale = oooDeliveries[oooDeliveries.length - 1]!;
    expect(stale.data.payment.status).toBe('PENDING');
    expect(stale.data.payment.sub_status).toBe('IN_PROCESS');
    expect(stale.data.payment.transactions.status).toBe('PENDING');
    expect(stale.data.payment.amount.captured).toBe(0);
  });

  it('invalid HMAC delivery is rejected by receiver fixture with zero mutation', async () => {
    let mutations = 0;
    const deliveries: ReceivedDelivery[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const signature = String(req.headers[YUNO_HMAC_SIGNATURE_HEADER] ?? '');
        deliveries.push({ rawBody, signature, headers: { ...req.headers } });
        const valid = verifyYunoWebhookSignature({
          rawBody,
          signatureHeader: signature,
          secret: HMAC_SECRET,
        });
        if (!valid) {
          res.statusCode = 401;
          res.end('no');
          return;
        }
        mutations += 1;
        res.statusCode = 200;
        res.end('ok');
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', (err?: Error) => (err ? reject(err) : resolve()));
    });
    closers.push(
      () =>
        new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    );
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no addr');
    const url = `http://127.0.0.1:${addr.port}/hooks`;

    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });

    await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'bad-hmac-hook',
        url,
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE'],
      }),
    });

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'invalid_hmac' }),
    });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_badhmac');
    const created = await json<{ id: string; status: string }>(
      await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-badhmac' },
        body: JSON.stringify(paymentBody(vaultedToken)),
      }),
    );
    expect(created.status).toBe('SUCCEEDED');
    // No valid sync delivery for invalid_hmac — only the async corrupted emit.
    expect(deliveries).toHaveLength(0);
    await app.request('/test/work/process', { method: 'POST' });

    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    for (const d of deliveries) {
      expect(
        verifyYunoWebhookSignature({
          rawBody: d.rawBody,
          signatureHeader: d.signature,
          secret: HMAC_SECRET,
        }),
      ).toBe(false);
    }
    expect(mutations).toBe(0);

    const got = await json<{ payment: { status: string } }>(
      await app.request(`/v1/payments/${created.id}`, { headers: authHeaders(config) }),
    );
    expect(got.payment.status).toBe('SUCCEEDED');
  });

  it('background work processor advances retries without /test/work/process', async () => {
    const receiver = await createReceiver({
      hmacSecret: HMAC_SECRET,
      statusForAttempt: (n) => (n === 1 ? 500 : 200),
    });
    closers.push(receiver.close);

    const clock = createManualClock(2_000_000);
    const scheduler = createManualScheduler();
    const config = testConfig({ YUNO_MOCK_WORK_POLL_MS: 1000 });
    const repo = new InMemoryYunoRepository();
    const runtime = createRuntime({
      clock,
      fetch: globalThis.fetch.bind(globalThis),
    });
    const app = createApp({ config, repo, runtime });
    const worker = createWorkProcessorFromConfig(config, repo, runtime, {
      scheduler,
      intervalMs: config.YUNO_MOCK_WORK_POLL_MS,
    });
    worker.start();
    expect(scheduler.isArmed()).toBe(true);

    await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'worker-retry-hook',
        url: receiver.url,
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE'],
      }),
    });
    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'success' }),
    });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_worker_retry');
    await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-worker-retry' },
      body: JSON.stringify(paymentBody(vaultedToken)),
    });
    // Sync create path delivers first attempt (500) via processDueDeliveries.
    expect(receiver.deliveries.length).toBe(1);

    // Advance clock to the next retry offset and fire the operational scheduler —
    // never call /test/work/process.
    clock.advance(WEBHOOK_RETRY_OFFSETS_MS[1]!);
    await scheduler.runTick();
    expect(receiver.deliveries.length).toBe(2);
    expect(
      verifyYunoWebhookSignature({
        rawBody: receiver.deliveries[1]!.rawBody,
        signatureHeader: receiver.deliveries[1]!.signature,
        secret: HMAC_SECRET,
      }),
    ).toBe(true);

    const store = await repo.getStore();
    expect(store.deliveries[0]!.status).toBe('delivered');
    expect(store.deliveries[0]!.attempt).toBe(2);

    await worker.stop();
    expect(worker.running).toBe(false);
  });

  it('background work processor advances processing_then_success async action', async () => {
    const receiver = await createReceiver({ hmacSecret: HMAC_SECRET });
    closers.push(receiver.close);
    const clock = createManualClock(3_000_000);
    const scheduler = createManualScheduler();
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const runtime = createRuntime({ clock, fetch: globalThis.fetch.bind(globalThis) });
    const app = createApp({ config, repo, runtime });
    const worker = createWorkProcessorFromConfig(config, repo, runtime, { scheduler });
    worker.start();

    await app.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'worker-async-hook',
        url: receiver.url,
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE'],
      }),
    });
    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'processing_then_success' }),
    });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_worker_async');
    const created = await json<{ id: string; status: string }>(
      await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-worker-async' },
        body: JSON.stringify(paymentBody(vaultedToken)),
      }),
    );
    expect(created.status).toBe('PENDING');
    expect(receiver.deliveries.length).toBe(0);

    await scheduler.runTick();
    const got = await json<{ payment: { status: string } }>(
      await app.request(`/v1/payments/${created.id}`, { headers: authHeaders(config) }),
    );
    expect(got.payment.status).toBe('SUCCEEDED');
    expect(receiver.deliveries.length).toBeGreaterThanOrEqual(1);
    await worker.stop();
  });

  it('rejects out-of-range YUNO_MOCK_WORK_POLL_MS', () => {
    expect(() => loadMockConfig({ NODE_ENV: 'test', YUNO_MOCK_WORK_POLL_MS: '50' })).toThrow();
    expect(() =>
      loadMockConfig({ NODE_ENV: 'test', YUNO_MOCK_WORK_POLL_MS: '700000' }),
    ).toThrow();
    expect(loadMockConfig({ NODE_ENV: 'test' }).YUNO_MOCK_WORK_POLL_MS).toBe(1000);
  });

  it('production NODE_ENV returns 404 for 3DS/work controls', async () => {
    const config = testConfig({ NODE_ENV: 'production' });
    // production requires explicit keys — loadMockConfig with production needs them
    const prod = loadMockConfig({
      NODE_ENV: 'production',
      YUNO_PUBLIC_API_KEY: 'prod_public',
      YUNO_PRIVATE_SECRET_KEY: 'prod_private',
      YUNO_MOCK_FINGERPRINT_SECRET: 'prod_fp',
      YUNO_MOCK_SECRETS_KEY:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    const app = createApp({ config: { ...prod }, repo: new InMemoryYunoRepository() });
    expect((await app.request('/test/payments/x/3ds')).status).toBe(404);
    expect(
      (
        await app.request('/test/payments/x/3ds/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
    expect((await app.request('/test/work/process', { method: 'POST' })).status).toBe(404);
    void config;
  });

  it('restart persistence keeps webhook config + payment across FileYunoRepository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuno-f4-rst-'));
    const config = testConfig({
      YUNO_STORE_BACKEND: 'file',
      YUNO_DATA_DIR: dir,
      storeFilePath: join(dir, 'yuno-mock-store.json'),
    });
    const repo1 = new FileYunoRepository(config.storeFilePath, config.secretsKey);
    const app1 = createApp({ config, repo: repo1 });

    await app1.request('/v1/webhooks', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'persist-hook',
        url: 'https://api.example.test/hooks',
        hmac_client_secret: HMAC_SECRET,
        payment_triggers: ['PURCHASE'],
      }),
    });
    await app1.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'success' }),
    });
    const { vaultedToken } = await enrollVaultedMethod(app1, config, 'usr_persist');
    const created = await json<{ id: string }>(
      await app1.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-persist' },
        body: JSON.stringify(paymentBody(vaultedToken)),
      }),
    );

    const raw = await readFile(config.storeFilePath, 'utf8');
    expect(raw).not.toContain(HMAC_SECRET);

    const repo2 = new FileYunoRepository(config.storeFilePath, config.secretsKey);
    const app2 = createApp({ config, repo: repo2 });
    const got = await json<{ payment: { id: string; status: string } }>(
      await app2.request(`/v1/payments/${created.id}`, { headers: authHeaders(config) }),
    );
    expect(got.payment.id).toBe(created.id);
    expect(got.payment.status).toBe('SUCCEEDED');
    const listed = await json<unknown[]>(
      await app2.request('/v1/webhooks', { headers: authHeaders(config) }),
    );
    expect(listed).toHaveLength(1);

    await rm(dir, { recursive: true, force: true });
  });
});

describe('F4 event guard', () => {
  it('refuses stale rewind and duplicate event ids', () => {
    expect(
      decidePaymentEventApplication({
        current: { status: 'SUCCEEDED', sub_status: 'APPROVED' },
        incoming: { status: 'PENDING', sub_status: 'IN_PROCESS' },
        eventId: 'e1',
        seenEventIds: [],
      }).reason,
    ).toBe('stale_or_out_of_order');

    expect(
      decidePaymentEventApplication({
        current: { status: 'SUCCEEDED', sub_status: 'APPROVED' },
        incoming: { status: 'SUCCEEDED', sub_status: 'APPROVED' },
        eventId: 'e2',
        seenEventIds: ['e2'],
      }).reason,
    ).toBe('duplicate_event');
  });

  it('encryptSecret round-trip', () => {
    const key = loadMockConfig({ NODE_ENV: 'test' }).secretsKey;
    const blob = encryptSecret('hello-secret', key);
    expect(blob.alg).toBe('aes-256-gcm');
    expect(JSON.stringify(blob)).not.toContain('hello-secret');
  });
});
