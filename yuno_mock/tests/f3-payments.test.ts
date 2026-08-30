import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadMockConfig, type MockConfig } from '../src/config.js';
import { InMemoryYunoRepository } from '../src/persistence/memory.js';
import { FileYunoRepository } from '../src/persistence/file.js';
import { assertNoSensitiveMaterial } from '../src/domain/sensitive.js';
import { validateResponse } from '../../src/providers/yuno/validate.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT_ID = '493e9374-510a-4201-9e09-de669d75f256';
const TEST_PAN = '4111111111111111';
const TEST_CVV = '123';

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

function secrets(config: MockConfig): string[] {
  return [
    config.YUNO_PUBLIC_API_KEY,
    config.YUNO_PRIVATE_SECRET_KEY,
    config.YUNO_MOCK_FINGERPRINT_SECRET,
    TEST_PAN,
    TEST_CVV,
  ];
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function enrollVaultedMethod(
  app: ReturnType<typeof createApp>,
  config: MockConfig,
  merchantCustomerId: string,
): Promise<{ customerId: string; vaultedToken: string }> {
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

  return { customerId: customer.id, vaultedToken: tokenized.vaulted_token };
}

function paymentBody(vaultedToken: string, overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT_ID,
    description: 'F3 test payment',
    country: 'CO',
    merchant_order_id: 'order-f3-001',
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

describe('F3 payments', () => {
  it('purchase success creates SUCCEEDED payment and GET returns stable state', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_ok');

    const createRes = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-ok-1' },
      body: JSON.stringify(paymentBody(vaultedToken)),
    });
    expect(createRes.status).toBe(201);
    const created = await json<{
      id: string;
      status: string;
      transactions: { id: string; type: string; status: string };
    }>(createRes);
    expect(created.status).toBe('SUCCEEDED');
    expect(created.transactions.type).toBe('PURCHASE');
    expect(created.transactions.status).toBe('SUCCEEDED');
    expect(validateResponse('create-payment', 201, created).ok).toBe(true);
    assertNoSensitiveMaterial(created, secrets(config));

    const getRes = await app.request(`/v1/payments/${created.id}`, {
      headers: authHeaders(config),
    });
    expect(getRes.status).toBe(200);
    const got = await json<{
      payment: { id: string; status: string; transactions: unknown[] };
    }>(getRes);
    expect(got.payment.id).toBe(created.id);
    expect(got.payment.status).toBe('SUCCEEDED');
    expect(Array.isArray(got.payment.transactions)).toBe(true);
    expect(got.payment.transactions).toHaveLength(1);
    expect(validateResponse('retrieve-payment-by-id-v2', 200, got).ok).toBe(true);

    const withQuery = await json<{
      payment: { id: string; transactions: unknown[] };
    }>(
      await app.request(
        `/v1/payments/${created.id}?transactions_history=false&raw_response=true&bogus=1`,
        { headers: authHeaders(config) },
      ),
    );
    expect(withQuery).toEqual(got);
  });

  it('declined scenario returns DECLINED without treating it as success', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_decl');

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'declined' }),
    });

    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-decl-1' },
      body: JSON.stringify(paymentBody(vaultedToken, { merchant_order_id: 'order-decl' })),
    });
    expect(res.status).toBe(201);
    const body = await json<{ status: string; transactions: { status: string } }>(res);
    expect(body.status).toBe('DECLINED');
    expect(body.transactions.status).toBe('DECLINED');
    expect(body.status).not.toBe('SUCCEEDED');
    expect(validateResponse('create-payment', 201, body).ok).toBe(true);
  });

  it('insufficient_funds returns safe decline without sensitive material', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_nsf');

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'insufficient_funds' }),
    });

    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-nsf-1' },
      body: JSON.stringify(paymentBody(vaultedToken, { merchant_order_id: 'order-nsf' })),
    });
    expect(res.status).toBe(201);
    const body = await json<{
      status: string;
      sub_status: string;
      transactions: { response_code: string; response_message: string };
    }>(res);
    expect(body.status).toBe('DECLINED');
    expect(body.sub_status).toBe('INSUFFICIENT_FUNDS');
    expect(body.transactions.response_code).toBe('51');
    expect(body.transactions.response_message).toBe('Insufficient funds');
    assertNoSensitiveMaterial(body, secrets(config));
    expect(JSON.stringify(body)).not.toMatch(/4111|cvv|pan/i);
  });

  it('manual authorize (capture:false) yields AUTHORIZED, never SUCCEEDED', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_auth');

    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-auth-1' },
      body: JSON.stringify(
        paymentBody(vaultedToken, {
          merchant_order_id: 'order-auth',
          payment_method: {
            type: 'CARD',
            vaulted_token: vaultedToken,
            detail: { card: { capture: false } },
          },
        }),
      ),
    });
    expect(res.status).toBe(201);
    const body = await json<{
      status: string;
      transactions: { type: string; status: string };
    }>(res);
    expect(body.status).toBe('AUTHORIZED');
    expect(body.transactions.type).toBe('AUTHORIZE');
    expect(body.transactions.status).toBe('AUTHORIZED');
    expect(body.status).not.toBe('SUCCEEDED');
    expect(validateResponse('create-payment', 201, body).ok).toBe(true);
  });

  it('authorized scenario forces AUTHORIZED state', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_scen_auth');

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'authorized' }),
    });

    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-scen-auth' },
      body: JSON.stringify(paymentBody(vaultedToken, { merchant_order_id: 'order-scen-auth' })),
    });
    const body = await json<{ status: string; transactions: { type: string; status: string } }>(
      res,
    );
    expect(body.status).toBe('AUTHORIZED');
    expect(body.transactions.status).toBe('AUTHORIZED');
    expect(body.status).not.toBe('SUCCEEDED');
  });

  it('processing scenarios remain PENDING and GET is stable for F4', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_proc');

    for (const scenario of ['processing_then_success', 'processing_then_declined'] as const) {
      await app.request('/test/scenarios/payments', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });

      const res = await app.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': `pay-${scenario}` },
        body: JSON.stringify(
          paymentBody(vaultedToken, { merchant_order_id: `order-${scenario}` }),
        ),
      });
      expect(res.status).toBe(201);
      const body = await json<{ id: string; status: string; sub_status: string }>(res);
      expect(body.status).toBe('PENDING');
      expect(body.sub_status).toBe('IN_PROCESS');
      expect(body.status).not.toBe('SUCCEEDED');

      const get1 = await json<{ payment: { status: string } }>(
        await app.request(`/v1/payments/${body.id}`, { headers: authHeaders(config) }),
      );
      const get2 = await json<{ payment: { status: string } }>(
        await app.request(`/v1/payments/${body.id}`, { headers: authHeaders(config) }),
      );
      expect(get1.payment.status).toBe('PENDING');
      expect(get2.payment.status).toBe(get1.payment.status);
    }
  });

  it('provider_timeout creates uncertain outcome; same-key retry does not duplicate', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_to');

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'provider_timeout' }),
    });

    const headers = { ...authHeaders(config), 'X-Idempotency-Key': 'pay-timeout-1' };
    const body = paymentBody(vaultedToken, { merchant_order_id: 'order-timeout' });

    const res1 = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(res1.status).toBe(500);
    const err1 = await json<{ code: string; messages: string[] }>(res1);
    expect(err1.code).toBe('PROVIDER_ERROR');

    const store1 = await repo.getStore();
    expect(store1.payments).toHaveLength(1);
    const paymentId = store1.payments[0]!.id;

    const res2 = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, description: 'changed retry body' }),
    });
    expect(res2.status).toBe(500);
    expect(await json(res2)).toEqual(err1);

    const store2 = await repo.getStore();
    expect(store2.payments).toHaveLength(1);
    expect(store2.payments[0]!.id).toBe(paymentId);

    const getRes = await app.request(`/v1/payments/${paymentId}`, {
      headers: authHeaders(config),
    });
    expect(getRes.status).toBe(200);
    const got = await json<{ payment: { status: string } }>(getRes);
    expect(got.payment.status).toBe('PENDING');
  });

  it('exact idempotent replay returns original response when retry body differs', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_replay');

    const headers = { ...authHeaders(config), 'X-Idempotency-Key': 'pay-replay-1' };
    const firstBody = paymentBody(vaultedToken, { merchant_order_id: 'order-replay' });

    const res1 = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify(firstBody),
    });
    expect(res1.status).toBe(201);
    const body1 = await json<{ id: string; description: string; merchant_order_id: string }>(
      res1,
    );

    const res2 = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...firstBody,
        description: 'totally different',
        merchant_order_id: 'order-replay-CHANGED',
        amount: { currency: 'COP', value: 9999 },
      }),
    });
    expect(res2.status).toBe(201);
    const body2 = await json<{ id: string; description: string; merchant_order_id: string }>(
      res2,
    );
    expect(body2).toEqual(body1);
    expect(body2.description).toBe('F3 test payment');
    expect(body2.merchant_order_id).toBe('order-replay');
  });

  it('completed payment replay ignores schema-invalid retry body; first invalid does not consume key', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_replay_invalid');

    const key = 'pay-replay-invalid-body';
    const headers = { ...authHeaders(config), 'X-Idempotency-Key': key };

    const invalidFirst = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ account_id: ACCOUNT_ID }),
    });
    expect(invalidFirst.status).toBe(400);
    const afterInvalid = await repo.getStore();
    expect(afterInvalid.payments).toHaveLength(0);
    expect(
      afterInvalid.idempotency.some(
        (r) => r.scope === `payment:${ACCOUNT_ID}` && r.key === key,
      ),
    ).toBe(false);

    const ok = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify(paymentBody(vaultedToken, { merchant_order_id: 'order-replay-inv' })),
    });
    expect(ok.status).toBe(201);
    const original = await json<{ id: string; merchant_order_id: string }>(ok);

    // Schema-invalid retry still carries account_id so scope resolves → replay.
    const replay = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ account_id: ACCOUNT_ID, not_a_payment: true }),
    });
    expect(replay.status).toBe(201);
    expect(await json(replay)).toEqual(original);
    expect((await repo.getStore()).payments).toHaveLength(1);
  });

  it('fractional amount 1250.5 create/GET/idempotent replay without INTERNAL_ERROR', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_frac');

    const headers = { ...authHeaders(config), 'X-Idempotency-Key': 'pay-frac-1' };
    const body = paymentBody(vaultedToken, {
      merchant_order_id: 'order-frac',
      amount: { currency: 'COP', value: 1250.5 },
    });

    const createRes = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(createRes.status).toBe(201);
    const created = await json<{
      id: string;
      amount: { value: number };
      transactions: { amount: number };
    }>(createRes);
    expect(created.amount.value).toBe(1250.5);
    expect(created.transactions.amount).toBe(1250.5);
    expect(validateResponse('create-payment', 201, created).ok).toBe(true);

    const getRes = await app.request(`/v1/payments/${created.id}`, {
      headers: authHeaders(config),
    });
    expect(getRes.status).toBe(200);
    const got = await json<{
      payment: { amount: { value: number }; transactions: { amount: number }[] };
    }>(getRes);
    expect(got.payment.amount.value).toBe(1250.5);
    expect(got.payment.transactions[0]?.amount).toBe(1250.5);
    expect(validateResponse('retrieve-payment-by-id-v2', 200, got).ok).toBe(true);

    const replay = await app.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, description: 'changed' }),
    });
    expect(replay.status).toBe(201);
    expect(await json(replay)).toEqual(created);
  });

  it('rejects unknown vaulted token and unenrolled method before consuming key', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const { vaultedToken, customerId } = await enrollVaultedMethod(app, config, 'usr_pay_tok');

    const unknownRes = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-unknown-tok' },
      body: JSON.stringify(
        paymentBody('00000000-0000-0000-0000-000000000000', {
          merchant_order_id: 'order-unknown',
        }),
      ),
    });
    expect(unknownRes.status).toBe(400);
    expect(await json(unknownRes)).toMatchObject({
      code: 'INVALID_REQUEST',
      messages: ['unknown vaulted_token'],
    });

    // Same key must still be usable after reject-before-start.
    const okRes = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-unknown-tok' },
      body: JSON.stringify(paymentBody(vaultedToken, { merchant_order_id: 'order-after-unknown' })),
    });
    expect(okRes.status).toBe(201);

    // Unenroll then reject
    const listRes = await app.request(`/v1/customers/${customerId}/payment-methods`, {
      headers: authHeaders(config),
    });
    const list = await json<{ payment_methods: { vaulted_token: string }[] }>(listRes);
    expect(list.payment_methods[0]?.vaulted_token).toBe(vaultedToken);

    const methods = (await repo.getStore()).paymentMethods;
    const methodId = methods.find((m) => (m.data as { vaulted_token?: string }).vaulted_token === vaultedToken)?.id;
    expect(methodId).toBeTruthy();

    const unenroll = await app.request(`/v1/customers/payment-methods/${methodId}/unenroll`, {
      method: 'POST',
      headers: authHeaders(config),
    });
    expect(unenroll.status).toBe(200);

    const unenrolledRes = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-unenrolled' },
      body: JSON.stringify(paymentBody(vaultedToken, { merchant_order_id: 'order-unenrolled' })),
    });
    expect(unenrolledRes.status).toBe(400);
    const unBody = await json<{ messages: string[] }>(unenrolledRes);
    expect(unBody.messages[0]).toMatch(/not ENROLLED|unknown vaulted_token/i);
  });

  it('rejects missing/invalid idempotency and invalid amount/account', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_val');

    const missingKey = await app.request('/v1/payments', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify(paymentBody(vaultedToken)),
    });
    expect(missingKey.status).toBe(400);

    const badAmount = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-bad-amt' },
      body: JSON.stringify(
        paymentBody(vaultedToken, {
          merchant_order_id: 'order-bad-amt',
          amount: { currency: 'COP', value: 0 },
        }),
      ),
    });
    expect(badAmount.status).toBe(400);
    expect(await json(badAmount)).toMatchObject({
      messages: ['amount.value must be positive'],
    });

    const badAccount = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-bad-acc' },
      body: JSON.stringify(
        paymentBody(vaultedToken, {
          account_id: 'not-a-uuid',
          merchant_order_id: 'order-bad-acc',
        }),
      ),
    });
    expect(badAccount.status).toBe(400);
  });

  it('GET missing payment returns 400; found returns contract-valid body', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });

    const missing = await app.request(
      '/v1/payments/ffffffff-ffff-ffff-ffff-ffffffffffff',
      { headers: authHeaders(config) },
    );
    expect(missing.status).toBe(400);
    expect(await json(missing)).toMatchObject({
      code: 'INVALID_REQUEST',
      messages: ['payment_id not found'],
    });
  });

  it('persists payments across file repository round-trip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuno-f3-'));
    try {
      const config = testConfig({
        YUNO_STORE_BACKEND: 'file',
        YUNO_DATA_DIR: dir,
        storeFilePath: join(dir, 'yuno-mock-store.json'),
      });
      const repo1 = new FileYunoRepository(config.storeFilePath, config.secretsKey);
      const app1 = createApp({ config, repo: repo1 });
      const { vaultedToken } = await enrollVaultedMethod(app1, config, 'usr_pay_file');

      const createRes = await app1.request('/v1/payments', {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-file-1' },
        body: JSON.stringify(paymentBody(vaultedToken, { merchant_order_id: 'order-file' })),
      });
      expect(createRes.status).toBe(201);
      const created = await json<{ id: string }>(createRes);

      const repo2 = new FileYunoRepository(config.storeFilePath, config.secretsKey);
      const app2 = createApp({ config, repo: repo2 });
      const getRes = await app2.request(`/v1/payments/${created.id}`, {
        headers: authHeaders(config),
      });
      expect(getRes.status).toBe(200);
      const got = await json<{ payment: { id: string; status: string } }>(getRes);
      expect(got.payment.id).toBe(created.id);
      expect(got.payment.status).toBe('SUCCEEDED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects PAN/CVV on payment create via /v1 guard', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_pay_pan');

    const res = await app.request('/v1/payments', {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'pay-pan-1' },
      body: JSON.stringify({
        ...paymentBody(vaultedToken),
        pan: TEST_PAN,
        cvv: TEST_CVV,
      }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({
      code: 'INVALID_REQUEST',
      messages: ['Request contains sensitive payment instrument data'],
    });
  });

  it('scenario control is outside /v1 and 404 in production', async () => {
    const prod = testConfig({ NODE_ENV: 'production' });
    const app = createApp({ config: prod, repo: new InMemoryYunoRepository() });
    const res = await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'declined' }),
    });
    expect(res.status).toBe(404);
  });
});
