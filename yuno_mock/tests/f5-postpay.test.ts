import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
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
  signYunoWebhookBody,
  verifyYunoWebhookSignature,
  YUNO_HMAC_SIGNATURE_HEADER,
} from '../../src/providers/yuno/webhook-verifier.js';
import { decidePaymentEventApplication } from '../../src/providers/yuno/payment-event-guard.js';
import { validateRequest, validateResponse } from '../../src/providers/yuno/validate.js';
import { assertNoSensitiveMaterial } from '../src/domain/sensitive.js';
import { asPaymentData } from '../src/services/payment-view.js';
import type { YunoMockStore } from '../src/persistence/types.js';

const ACCOUNT_ID = '493e9374-510a-4201-9e09-de669d75f256';
const TEST_PAN = '4111111111111111';
const TEST_CVV = '123';
const HMAC_SECRET = 'test-hmac-client-secret-value-f5';

function asPaymentHistory(store: YunoMockStore, paymentId: string) {
  const record = store.payments.find((p) => p.id === paymentId);
  if (!record) return [];
  return asPaymentData(record).transactions;
}

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
    HMAC_SECRET,
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
        verify: { vault_on_success: true, currency: 'COP' },
      }),
    },
  );
  expect(enrollRes.status).toBe(201);
  return { vaultedToken: tokenized.vaulted_token };
}

function paymentBody(vaultedToken: string, overrides: Record<string, unknown> = {}) {
  return {
    account_id: ACCOUNT_ID,
    description: 'F5 test payment',
    country: 'CO',
    merchant_order_id: 'order-f5-001',
    amount: { currency: 'COP', value: 1000 },
    payment_method: {
      type: 'CARD',
      vaulted_token: vaultedToken,
      detail: { card: { capture: false } },
    },
    checkout: {},
    workflow: 'DIRECT',
    ...overrides,
  };
}

async function createAuthorized(
  app: ReturnType<typeof createApp>,
  config: MockConfig,
  vaultedToken: string,
  key: string,
  amountValue = 1000,
) {
  const res = await app.request('/v1/payments', {
    method: 'POST',
    headers: { ...authHeaders(config), 'X-Idempotency-Key': key },
    body: JSON.stringify(
      paymentBody(vaultedToken, {
        merchant_order_id: `order-${key}`,
        amount: { currency: 'COP', value: amountValue },
      }),
    ),
  });
  expect(res.status).toBe(201);
  return json<{
    id: string;
    status: string;
    amount: { value: number; captured: number; refunded: number };
    transactions: { id: string; type: string; status: string };
  }>(res);
}

async function createPurchase(
  app: ReturnType<typeof createApp>,
  config: MockConfig,
  vaultedToken: string,
  key: string,
  amountValue = 1000,
) {
  const res = await app.request('/v1/payments', {
    method: 'POST',
    headers: { ...authHeaders(config), 'X-Idempotency-Key': key },
    body: JSON.stringify(
      paymentBody(vaultedToken, {
        merchant_order_id: `order-${key}`,
        amount: { currency: 'COP', value: amountValue },
        payment_method: {
          type: 'CARD',
          vaulted_token: vaultedToken,
          detail: { card: { capture: true } },
        },
      }),
    ),
  });
  expect(res.status).toBe(201);
  return json<{
    id: string;
    status: string;
    amount: { value: number; captured: number; refunded: number };
    transactions: { id: string; type: string; status: string };
  }>(res);
}

async function registerWebhook(
  app: ReturnType<typeof createApp>,
  config: MockConfig,
  url: string,
) {
  const res = await app.request('/v1/webhooks', {
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({
      account_id: ACCOUNT_ID,
      name: 'f5-payments',
      url,
      hmac_client_secret: HMAC_SECRET,
      payment_triggers: ['AUTHORIZE', 'CAPTURE', 'CANCEL', 'REFUND', 'PURCHASE'],
    }),
  });
  expect(res.status).toBe(201);
}

const receivers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  await Promise.all(
    receivers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

async function startReceiver(
  onBody: (raw: string, headers: Record<string, string | string[] | undefined>) => void,
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      onBody(raw, req.headers as Record<string, string | string[] | undefined>);
      res.statusCode = 200;
      res.end('ok');
    });
  });
  receivers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return `http://127.0.0.1:${addr.port}/hook`;
}

describe('F5 capture', () => {
  it('total and partial capture with cumulative amounts; over/double/wrong-tx rejected', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_cap_1');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-cap-1', 1000);
    expect(auth.status).toBe('AUTHORIZED');
    expect(auth.amount.captured).toBe(0);
    const txId = auth.transactions.id;

    const partial = await app.request(
      `/v1/payments/${auth.id}/transactions/${txId}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cap-partial-1' },
        body: JSON.stringify({
          merchant_reference: 'cap-ref-001',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 400 },
        }),
      },
    );
    expect(partial.status).toBe(200);
    const partialBody = await json<{
      type: string;
      status: string;
      payment: { status: string; sub_status: string; amount: { captured: number } };
    }>(partial);
    expect(partialBody.type).toBe('CAPTURE');
    expect(partialBody.status).toBe('SUCCEEDED');
    expect(partialBody.payment.sub_status).toBe('PARTIALLY_CAPTURED');
    expect(partialBody.payment.amount.captured).toBe(400);
    expect(validateResponse('capture-authorization', 200, partialBody).ok).toBe(true);
    assertNoSensitiveMaterial(partialBody, secrets(config));

    const over = await app.request(
      `/v1/payments/${auth.id}/transactions/${txId}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cap-over-1' },
        body: JSON.stringify({
          merchant_reference: 'cap-ref-002',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 700 },
        }),
      },
    );
    expect(over.status).toBe(400);

    const rest = await app.request(
      `/v1/payments/${auth.id}/transactions/${txId}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cap-rest-1' },
        body: JSON.stringify({
          merchant_reference: 'cap-ref-003',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 600 },
        }),
      },
    );
    expect(rest.status).toBe(200);
    const restBody = await json<{
      payment: { status: string; sub_status: string; amount: { captured: number } };
    }>(rest);
    expect(restBody.payment.sub_status).toBe('CAPTURED');
    expect(restBody.payment.amount.captured).toBe(1000);

    const double = await app.request(
      `/v1/payments/${auth.id}/transactions/${txId}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cap-double-1' },
        body: JSON.stringify({
          merchant_reference: 'cap-ref-004',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 1 },
        }),
      },
    );
    expect(double.status).toBe(400);

    const wrongTx = await app.request(
      `/v1/payments/${auth.id}/transactions/ffffffff-ffff-ffff-ffff-ffffffffffff/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cap-wrong-tx' },
        body: JSON.stringify({
          merchant_reference: 'cap-ref-005',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 1 },
        }),
      },
    );
    expect(wrongTx.status).toBe(400);

    const got = await json<{
      payment: {
        amount: { captured: number; refunded: number };
        transactions: { type: string }[];
      };
    }>(await app.request(`/v1/payments/${auth.id}`, { headers: authHeaders(config) }));
    expect(got.payment.amount.captured).toBe(1000);
    expect(got.payment.transactions.some((t) => t.type === 'CAPTURE')).toBe(true);
    expect(got.payment.transactions.length).toBeGreaterThanOrEqual(3);
  });
});

describe('F5 cancel', () => {
  it('cancels authorization; double cancel with new key rejected; same-key replay', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_can_1');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-can-1');

    const cancelBody = {
      merchant_reference: 'can-ref-001',
      reason: 'REQUESTED_BY_CUSTOMER' as const,
      description: 'customer asked',
    };
    expect(
      validateRequest('cancel-payment', cancelBody, {
        ...authHeaders(config),
        'X-Idempotency-Key': 'can-validate',
      }).ok,
    ).toBe(true);

    const first = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/cancel`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'can-1' },
        body: JSON.stringify(cancelBody),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = await json<{
      type: string;
      payment: { status: string };
    }>(first);
    expect(firstBody.type).toBe('CANCEL');
    expect(firstBody.payment.status).toBe('CANCELED');
    expect(validateResponse('cancel-payment', 200, firstBody).ok).toBe(true);

    const replay = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/cancel`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'can-1' },
        body: JSON.stringify({
          merchant_reference: 'totally-different-body-ignored',
          reason: 'FRAUDULENT',
        }),
      },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);

    const second = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/cancel`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'can-2' },
        body: JSON.stringify(cancelBody),
      },
    );
    expect(second.status).toBe(400);
  });
});

describe('F5 refund', () => {
  it('partial + total refund; over/double rejected; refund_failed no delta', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_ref_1');
    const pay = await createPurchase(app, config, vaultedToken, 'purchase-ref-1', 1000);
    expect(pay.amount.captured).toBe(1000);
    const txId = pay.transactions.id;

    const partial = await app.request(
      `/v1/payments/${pay.id}/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'ref-p-1' },
        body: JSON.stringify({
          merchant_reference: 'ref-001',
          reason: 'REQUESTED_BY_CUSTOMER',
          amount: { currency: 'COP', value: 250 },
        }),
      },
    );
    expect(partial.status).toBe(200);
    const partialBody = await json<{
      status: string;
      sub_status: string;
      amount: { refunded: number; captured: number };
      transactions: { type: string; status: string };
    }>(partial);
    expect(partialBody.status).toBe('SUCCEEDED');
    expect(partialBody.sub_status).toBe('PARTIALLY_REFUNDED');
    expect(partialBody.amount.refunded).toBe(250);
    expect(partialBody.transactions.type).toBe('REFUND');
    expect(validateResponse('refund-payment', 200, partialBody).ok).toBe(true);

    const over = await app.request(
      `/v1/payments/${pay.id}/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'ref-over' },
        body: JSON.stringify({
          merchant_reference: 'ref-002',
          amount: { currency: 'COP', value: 900 },
        }),
      },
    );
    expect(over.status).toBe(400);

    const rest = await app.request(
      `/v1/payments/${pay.id}/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'ref-rest' },
        body: JSON.stringify({
          merchant_reference: 'ref-003',
          amount: { currency: 'COP', value: 750 },
        }),
      },
    );
    expect(rest.status).toBe(200);
    const restBody = await json<{ status: string; amount: { refunded: number } }>(rest);
    expect(restBody.status).toBe('REFUNDED');
    expect(restBody.amount.refunded).toBe(1000);

    const double = await app.request(
      `/v1/payments/${pay.id}/transactions/${txId}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'ref-double' },
        body: JSON.stringify({ merchant_reference: 'ref-004' }),
      },
    );
    expect(double.status).toBe(400);

    // refund_failed
    const { vaultedToken: vt2 } = await enrollVaultedMethod(app, config, 'usr_ref_fail');
    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'refund_failed' }),
    });
    const pay2 = await createPurchase(app, config, vt2, 'purchase-ref-fail', 500);
    const failRes = await app.request(
      `/v1/payments/${pay2.id}/transactions/${pay2.transactions.id}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'ref-fail-1' },
        body: JSON.stringify({
          merchant_reference: 'ref-fail',
          amount: { currency: 'COP', value: 100 },
        }),
      },
    );
    expect(failRes.status).toBe(200);
    const failBody = await json<{
      status: string;
      amount: { refunded: number };
      transactions: { type: string; status: string };
    }>(failRes);
    expect(failBody.amount.refunded).toBe(0);
    expect(failBody.status).toBe('SUCCEEDED');
    expect(failBody.transactions.type).toBe('REFUND');
    expect(failBody.transactions.status).toBe('DECLINED');
  });
});

describe('F5 cancel-or-refund', () => {
  it('payment-level and transaction-level choose cancel vs refund by state', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_cor_1');

    const auth = await createAuthorized(app, config, vaultedToken, 'auth-cor-1');
    const cancelBranch = await app.request(`/v1/payments/${auth.id}/cancel-or-refund`, {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cor-cancel' },
      body: JSON.stringify({ reason: 'REQUESTED_BY_CUSTOMER' }),
    });
    expect(cancelBranch.status).toBe(201);
    const cancelBody = await json<{ type: string; payment: { status: string } }>(
      cancelBranch,
    );
    expect(cancelBody.type).toBe('CANCEL');
    expect(cancelBody.payment.status).toBe('CANCELED');
    expect(validateResponse('cancel-or-refund-a-payment', 201, cancelBody).ok).toBe(true);

    const purchase = await createPurchase(app, config, vaultedToken, 'purchase-cor-1', 800);
    const refundBranch = await app.request(
      `/v1/payments/${purchase.id}/transactions/${purchase.transactions.id}/cancel-or-refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cor-refund' },
        body: JSON.stringify({
          reason: 'REQUESTED_BY_CUSTOMER',
          merchant_reference: 'cor-ref-1',
        }),
      },
    );
    expect(refundBranch.status).toBe(201);
    const refundBody = await json<{ type: string; payment: { status: string } }>(
      refundBranch,
    );
    expect(refundBody.type).toBe('REFUND');
    expect(refundBody.payment.status).toBe('REFUNDED');
    expect(
      validateResponse('cancel-or-refund-payment-with-transaction', 201, refundBody).ok,
    ).toBe(true);

    const declined = await app.request(`/v1/payments/${purchase.id}/cancel-or-refund`, {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cor-exhausted' },
      body: JSON.stringify({ reason: 'REQUESTED_BY_CUSTOMER' }),
    });
    expect(declined.status).toBe(400);
  });
});

describe('F5 idempotency', () => {
  it('replay ignores invalid retry body; first invalid does not consume; concurrent same-key one mutation', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_idem_1');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-idem-1', 1000);
    const txId = auth.transactions.id;
    const path = `/v1/payments/${auth.id}/transactions/${txId}/capture`;

    const invalid = await app.request(path, {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'idem-invalid' },
      body: JSON.stringify({}),
    });
    expect(invalid.status).toBe(400);

    const ok = await app.request(path, {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'idem-invalid' },
      body: JSON.stringify({
        merchant_reference: 'idem-ref-ok',
        reason: 'PRODUCT_CONFIRMED',
        amount: { currency: 'COP', value: 100 },
      }),
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();

    const replayBad = await app.request(path, {
      method: 'POST',
      headers: { ...authHeaders(config), 'X-Idempotency-Key': 'idem-invalid' },
      body: JSON.stringify({ not: 'valid' }),
    });
    expect(replayBad.status).toBe(200);
    expect(await replayBad.json()).toEqual(okBody);

    const auth2 = await createAuthorized(app, config, vaultedToken, 'auth-idem-2', 500);
    const path2 = `/v1/payments/${auth2.id}/transactions/${auth2.transactions.id}/capture`;
    const body = {
      merchant_reference: 'conc-ref',
      reason: 'PRODUCT_CONFIRMED',
      amount: { currency: 'COP', value: 500 },
    };
    const [a, b] = await Promise.all([
      app.request(path2, {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'conc-same' },
        body: JSON.stringify(body),
      }),
      app.request(path2, {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'conc-same' },
        body: JSON.stringify(body),
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0] === 200 || statuses[0] === 400).toBe(true);
    expect(statuses.includes(200)).toBe(true);
    const got = await json<{ payment: { amount: { captured: number } } }>(
      await app.request(`/v1/payments/${auth2.id}`, { headers: authHeaders(config) }),
    );
    expect(got.payment.amount.captured).toBe(500);
  });
});

describe('F5 fractional amounts', () => {
  it('create/capture/refund/retrieve preserve fractional provider decimals', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_frac_1');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-frac', 1250.5);
    expect(auth.amount.value).toBe(1250.5);

    const cap = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'frac-cap' },
        body: JSON.stringify({
          merchant_reference: 'frac-cap-ref',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 250.25 },
        }),
      },
    );
    expect(cap.status).toBe(200);
    const capBody = await json<{ payment: { amount: { captured: number } } }>(cap);
    expect(capBody.payment.amount.captured).toBe(250.25);
    expect(validateResponse('capture-authorization', 200, capBody).ok).toBe(true);

    const rem = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'frac-cap-2' },
        body: JSON.stringify({
          merchant_reference: 'frac-cap-ref-2',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 1000.25 },
        }),
      },
    );
    expect(rem.status).toBe(200);
    const remBody = await json<{ id: string; type: string }>(rem);
    expect(remBody.type).toBe('CAPTURE');

    const ref = await app.request(
      `/v1/payments/${auth.id}/transactions/${remBody.id}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'frac-ref' },
        body: JSON.stringify({
          merchant_reference: 'frac-ref',
          amount: { currency: 'COP', value: 50.5 },
        }),
      },
    );
    expect(ref.status).toBe(200);
    const refBody = await json<{ amount: { refunded: number; value: number } }>(ref);
    expect(refBody.amount.refunded).toBe(50.5);
    expect(refBody.amount.value).toBe(1250.5);

    const got = await json<{
      payment: { amount: { value: number; captured: number; refunded: number } };
    }>(await app.request(`/v1/payments/${auth.id}`, { headers: authHeaders(config) }));
    expect(got.payment.amount.value).toBe(1250.5);
    expect(got.payment.amount.captured).toBe(1250.5);
    expect(got.payment.amount.refunded).toBe(50.5);
  });
});

describe('F5 webhooks + ranking', () => {
  it('CAPTURE/REFUND webhooks are signed and persisted; ranking allows refund path', async () => {
    const delivered: Array<{ raw: string; sig: string }> = [];
    const url = await startReceiver((raw, headers) => {
      delivered.push({
        raw,
        sig: String(headers[YUNO_HMAC_SIGNATURE_HEADER] ?? ''),
      });
    });
    const clock = createManualClock(1_700_000_000_000);
    const runtime = createRuntime({ clock, fetch: globalThis.fetch.bind(globalThis) });
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo, runtime });
    await registerWebhook(app, config, url);
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_wh_1');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-wh-1', 300);

    await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'wh-cap' },
        body: JSON.stringify({
          merchant_reference: 'wh-cap-ref',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 300 },
        }),
      },
    );
    await processDueWork(repo, runtime, config.secretsKey);

    const storeAfterCap = await repo.getStore();
    const captureTx = asPaymentHistory(storeAfterCap, auth.id).find((t) => t.type === 'CAPTURE');
    expect(captureTx?.id).toBeTruthy();

    await app.request(
      `/v1/payments/${auth.id}/transactions/${captureTx!.id}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'wh-ref' },
        body: JSON.stringify({
          merchant_reference: 'wh-ref-ref',
          amount: { currency: 'COP', value: 100 },
        }),
      },
    );
    await processDueWork(repo, runtime, config.secretsKey);

    const types = delivered.map((d) => (JSON.parse(d.raw) as { type_event: string }).type_event);
    expect(types).toContain('CAPTURE');
    expect(types).toContain('REFUND');
    for (const d of delivered) {
      expect(
        verifyYunoWebhookSignature({
          rawBody: d.raw,
          signatureHeader: d.sig,
          secret: HMAC_SECRET,
        }),
      ).toBe(true);
      expect(signYunoWebhookBody(d.raw, HMAC_SECRET)).toBe(d.sig);
      // HMAC covers exact raw bytes — re-serializing must not be required to verify.
      const parsed = JSON.parse(d.raw) as {
        type_event: string;
        data: { payment: { transactions: { id: string; type: string; status: string } } };
      };
      if (parsed.type_event === 'CAPTURE') {
        expect(parsed.data.payment.transactions.type).toBe('CAPTURE');
        expect(parsed.data.payment.transactions.id).toBe(captureTx!.id);
      }
      if (parsed.type_event === 'REFUND') {
        expect(parsed.data.payment.transactions.type).toBe('REFUND');
        expect(parsed.data.payment.transactions.status).toBe('SUCCEEDED');
      }
    }

    const store = await repo.getStore();
    expect(store.events.some((e) => e.typeEvent === 'CAPTURE')).toBe(true);
    expect(store.events.some((e) => e.typeEvent === 'REFUND')).toBe(true);
    expect(store.deliveries.length).toBeGreaterThan(0);

    expect(
      decidePaymentEventApplication({
        current: { status: 'SUCCEEDED', sub_status: 'APPROVED' },
        incoming: { status: 'SUCCEEDED', sub_status: 'PARTIALLY_REFUNDED' },
        eventId: 'rank-1',
        seenEventIds: [],
      }).apply,
    ).toBe(true);
    expect(
      decidePaymentEventApplication({
        current: { status: 'SUCCEEDED', sub_status: 'PARTIALLY_REFUNDED' },
        incoming: { status: 'REFUNDED', sub_status: 'REFUNDED' },
        eventId: 'rank-2',
        seenEventIds: [],
      }).apply,
    ).toBe(true);
    expect(
      decidePaymentEventApplication({
        current: { status: 'REFUNDED', sub_status: 'REFUNDED' },
        incoming: { status: 'SUCCEEDED', sub_status: 'APPROVED' },
        eventId: 'rank-3',
        seenEventIds: [],
      }).reason,
    ).toBe('stale_or_out_of_order');
  });
});

describe('F5 file restart / production controls / no secrets', () => {
  it('migrates missing history on file restart; production scenario 404; no sensitive material', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuno-f5-'));
    try {
      await mkdir(dir, { recursive: true });
      const legacy = {
        customers: [],
        sessions: [],
        paymentMethods: [],
        payments: [
          {
            id: 'pay-legacy-1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
            data: {
              account_id: ACCOUNT_ID,
              description: 'legacy',
              country: 'CO',
              merchant_order_id: 'legacy-order',
              amount: { currency: 'COP', value: 100, captured: 100, refunded: 0 },
              status: 'SUCCEEDED',
              sub_status: 'APPROVED',
              workflow: 'DIRECT',
              checkout: { session: '', sdk_action_required: false },
              customer_payer: { id: 'cus-1' },
              payment_method: { type: 'CARD', vaulted_token: 'tok_legacy' },
              transaction: {
                id: 'tx-legacy',
                type: 'PURCHASE',
                status: 'SUCCEEDED',
                category: 'CARD',
                amount: 100,
                currency: 'COP',
                provider_id: 'YUNO',
                payment_method: { type: 'CARD' },
                response_code: '00',
                response_message: 'Approved',
                created_at: '2024-01-01T00:00:00.000Z',
                updated_at: '2024-01-01T00:00:00.000Z',
              },
              scenario: 'success',
              idempotency_key: 'legacy-key',
            },
          },
        ],
        webhooks: [],
        idempotency: [],
        events: [],
        deliveries: [],
        asyncActions: [],
        scenarios: [],
        appliedEventIds: [],
      };
      const storePath = join(dir, 'store.json');
      await writeFile(storePath, JSON.stringify(legacy));

      const config = testConfig({
        YUNO_STORE_BACKEND: 'file',
        YUNO_DATA_DIR: dir,
        storeFilePath: storePath,
      });
      const repo = new FileYunoRepository(storePath, config.secretsKey);
      await repo.getStore();
      const app = createApp({ config, repo });
      const got = await json<{
        payment: { transactions: unknown[]; amount: { captured: number } };
      }>(
        await app.request('/v1/payments/pay-legacy-1', { headers: authHeaders(config) }),
      );
      expect(got.payment.transactions).toHaveLength(1);
      expect(got.payment.amount.captured).toBe(100);

      const prod = createApp({
        config: testConfig({ NODE_ENV: 'production' }),
        repo: new InMemoryYunoRepository(),
      });
      const scen = await prod.request('/test/scenarios/payments', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenario: 'refund_failed' }),
      });
      expect(scen.status).toBe(404);

      const raw = await readFile(storePath, 'utf8');
      expect(raw).not.toContain(TEST_PAN);
      expect(raw).not.toContain(TEST_CVV);
      expect(raw).not.toContain(HMAC_SECRET);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('F5 transaction-target semantics', () => {
  it('capture/cancel require AUTHORIZE; refund requires PURCHASE or CAPTURE', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_tgt_1');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-tgt-1', 500);

    const cap = await json<{ id: string }>(
      await app.request(
        `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
        {
          method: 'POST',
          headers: { ...authHeaders(config), 'X-Idempotency-Key': 'tgt-cap' },
          body: JSON.stringify({
            merchant_reference: 'tgt-cap',
            reason: 'PRODUCT_CONFIRMED',
            amount: { currency: 'COP', value: 500 },
          }),
        },
      ),
    );

    const refundOnAuth = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'tgt-ref-auth' },
        body: JSON.stringify({ merchant_reference: 'tgt-ref-auth' }),
      },
    );
    expect(refundOnAuth.status).toBe(400);

    const refundOnCap = await app.request(
      `/v1/payments/${auth.id}/transactions/${cap.id}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'tgt-ref-cap' },
        body: JSON.stringify({ merchant_reference: 'tgt-ref-cap' }),
      },
    );
    expect(refundOnCap.status).toBe(200);

    const purchase = await createPurchase(app, config, vaultedToken, 'purchase-tgt', 200);
    const cancelOnPurchase = await app.request(
      `/v1/payments/${purchase.id}/transactions/${purchase.transactions.id}/cancel`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'tgt-can-pur' },
        body: JSON.stringify({ merchant_reference: 'tgt-can' }),
      },
    );
    expect(cancelOnPurchase.status).toBe(400);
  });

  it('tx cancel-or-refund: AUTHORIZE after full capture rejects; CAPTURE refunds', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_tgt_2');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-tgt-2', 400);

    const cap = await json<{ id: string; type: string }>(
      await app.request(
        `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
        {
          method: 'POST',
          headers: { ...authHeaders(config), 'X-Idempotency-Key': 'tgt2-cap' },
          body: JSON.stringify({
            merchant_reference: 'tgt2-cap',
            reason: 'PRODUCT_CONFIRMED',
            amount: { currency: 'COP', value: 400 },
          }),
        },
      ),
    );
    expect(cap.type).toBe('CAPTURE');

    const onAuthorize = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/cancel-or-refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'tgt2-cor-auth' },
        body: JSON.stringify({ reason: 'REQUESTED_BY_CUSTOMER' }),
      },
    );
    // Branches to cancel on AUTHORIZE, but no remaining auth → reject (not silent refund).
    expect(onAuthorize.status).toBe(400);

    const onCapture = await app.request(
      `/v1/payments/${auth.id}/transactions/${cap.id}/cancel-or-refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'tgt2-cor-cap' },
        body: JSON.stringify({ reason: 'REQUESTED_BY_CUSTOMER' }),
      },
    );
    expect(onCapture.status).toBe(201);
    const body = await json<{ type: string; payment: { status: string } }>(onCapture);
    expect(body.type).toBe('REFUND');
    expect(body.payment.status).toBe('REFUNDED');
  });
});

describe('F5 decimal-safe money', () => {
  it('split capture/refund keep exact 1e-4 totals (0.1+0.2=0.3)', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_dec_1');
    const auth = await createAuthorized(app, config, vaultedToken, 'auth-dec', 1);

    const c1 = await json<{ payment: { amount: { captured: number } }; id: string }>(
      await app.request(
        `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
        {
          method: 'POST',
          headers: { ...authHeaders(config), 'X-Idempotency-Key': 'dec-c1' },
          body: JSON.stringify({
            merchant_reference: 'dec-c1',
            reason: 'PRODUCT_CONFIRMED',
            amount: { currency: 'COP', value: 0.1 },
          }),
        },
      ),
    );
    expect(c1.payment.amount.captured).toBe(0.1);

    const c2 = await json<{ payment: { amount: { captured: number } }; id: string }>(
      await app.request(
        `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
        {
          method: 'POST',
          headers: { ...authHeaders(config), 'X-Idempotency-Key': 'dec-c2' },
          body: JSON.stringify({
            merchant_reference: 'dec-c2',
            reason: 'PRODUCT_CONFIRMED',
            amount: { currency: 'COP', value: 0.2 },
          }),
        },
      ),
    );
    expect(c2.payment.amount.captured).toBe(0.3);

    const tooPrecise = await app.request(
      `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'dec-bad' },
        body: JSON.stringify({
          merchant_reference: 'dec-bad',
          reason: 'PRODUCT_CONFIRMED',
          amount: { currency: 'COP', value: 0.00001 },
        }),
      },
    );
    expect(tooPrecise.status).toBe(400);

    const rem = await json<{ id: string }>(
      await app.request(
        `/v1/payments/${auth.id}/transactions/${auth.transactions.id}/capture`,
        {
          method: 'POST',
          headers: { ...authHeaders(config), 'X-Idempotency-Key': 'dec-c3' },
          body: JSON.stringify({
            merchant_reference: 'dec-c3',
            reason: 'PRODUCT_CONFIRMED',
            amount: { currency: 'COP', value: 0.7 },
          }),
        },
      ),
    );

    const r1 = await json<{ amount: { refunded: number } }>(
      await app.request(`/v1/payments/${auth.id}/transactions/${rem.id}/refund`, {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'dec-r1' },
        body: JSON.stringify({
          merchant_reference: 'dec-r1',
          amount: { currency: 'COP', value: 0.1 },
        }),
      }),
    );
    expect(r1.amount.refunded).toBe(0.1);

    const r2 = await json<{ amount: { refunded: number } }>(
      await app.request(`/v1/payments/${auth.id}/transactions/${rem.id}/refund`, {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'dec-r2' },
        body: JSON.stringify({
          merchant_reference: 'dec-r2',
          amount: { currency: 'COP', value: 0.2 },
        }),
      }),
    );
    expect(r2.amount.refunded).toBe(0.3);
  });
});

describe('F5 terminal event guard', () => {
  it('hard terminals reject every different incoming state; duplicates/same-state safe', () => {
    expect(
      decidePaymentEventApplication({
        current: { status: 'CANCELED', sub_status: 'CANCELED' },
        incoming: { status: 'SUCCEEDED', sub_status: 'CAPTURED' },
        eventId: 't1',
        seenEventIds: [],
      }).reason,
    ).toBe('stale_or_out_of_order');

    expect(
      decidePaymentEventApplication({
        current: { status: 'REFUNDED', sub_status: 'REFUNDED' },
        incoming: { status: 'DECLINED', sub_status: 'DECLINED' },
        eventId: 't2',
        seenEventIds: [],
      }).reason,
    ).toBe('stale_or_out_of_order');

    expect(
      decidePaymentEventApplication({
        current: { status: 'REFUNDED', sub_status: 'REFUNDED' },
        incoming: { status: 'REFUNDED', sub_status: 'REFUNDED' },
        eventId: 't3',
        seenEventIds: [],
      }).reason,
    ).toBe('same_state');

    expect(
      decidePaymentEventApplication({
        current: { status: 'CANCELED', sub_status: 'CANCELED' },
        incoming: { status: 'SUCCEEDED', sub_status: 'APPROVED' },
        eventId: 'dup',
        seenEventIds: ['dup'],
      }).reason,
    ).toBe('duplicate_event');
  });
});

describe('F5 refund_failed webhook honesty + cancel-or-refund concurrency', () => {
  it('refund_failed webhook carries DECLINED REFUND tx with unchanged totals', async () => {
    const delivered: Array<{ raw: string; sig: string }> = [];
    const url = await startReceiver((raw, headers) => {
      delivered.push({
        raw,
        sig: String(headers[YUNO_HMAC_SIGNATURE_HEADER] ?? ''),
      });
    });
    const clock = createManualClock(1_700_000_000_000);
    const runtime = createRuntime({ clock, fetch: globalThis.fetch.bind(globalThis) });
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo, runtime });
    await registerWebhook(app, config, url);
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_rf_wh');

    await app.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'refund_failed' }),
    });
    const pay = await createPurchase(app, config, vaultedToken, 'purchase-rf-wh', 100);
    const res = await app.request(
      `/v1/payments/${pay.id}/transactions/${pay.transactions.id}/refund`,
      {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'rf-wh-1' },
        body: JSON.stringify({
          merchant_reference: 'rf-wh',
          amount: { currency: 'COP', value: 40 },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await json<{
      amount: { refunded: number };
      transactions: { id: string; type: string; status: string };
    }>(res);
    expect(body.amount.refunded).toBe(0);
    expect(body.transactions.status).toBe('DECLINED');

    await processDueWork(repo, runtime, config.secretsKey);
    const refundEvents = delivered
      .map((d) => JSON.parse(d.raw) as {
        type_event: string;
        data: {
          payment: {
            amount: { refunded: number };
            transactions: { id: string; type: string; status: string };
          };
        };
      })
      .filter((e) => e.type_event === 'REFUND');
    expect(refundEvents.length).toBeGreaterThanOrEqual(1);
    const evt = refundEvents[refundEvents.length - 1]!;
    expect(evt.data.payment.transactions.type).toBe('REFUND');
    expect(evt.data.payment.transactions.status).toBe('DECLINED');
    expect(evt.data.payment.transactions.id).toBe(body.transactions.id);
    expect(evt.data.payment.amount.refunded).toBe(0);
    expect(
      verifyYunoWebhookSignature({
        rawBody: delivered.find((d) => d.raw.includes(body.transactions.id))!.raw,
        signatureHeader: delivered.find((d) => d.raw.includes(body.transactions.id))!.sig,
        secret: HMAC_SECRET,
      }),
    ).toBe(true);
  });

  it('concurrent cancel-or-refund with distinct keys returns each own action tx', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const { vaultedToken } = await enrollVaultedMethod(app, config, 'usr_cor_race');
    const pay = await createPurchase(app, config, vaultedToken, 'purchase-cor-race', 1000);

    const [a, b] = await Promise.all([
      app.request(`/v1/payments/${pay.id}/cancel-or-refund`, {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cor-race-a' },
        body: JSON.stringify({
          reason: 'REQUESTED_BY_CUSTOMER',
          amount: { currency: 'COP', value: 100 },
        }),
      }),
      app.request(`/v1/payments/${pay.id}/cancel-or-refund`, {
        method: 'POST',
        headers: { ...authHeaders(config), 'X-Idempotency-Key': 'cor-race-b' },
        body: JSON.stringify({
          reason: 'REQUESTED_BY_CUSTOMER',
          amount: { currency: 'COP', value: 200 },
        }),
      }),
    ]);

    const bodies = await Promise.all([
      json<{ id: string; type: string; amount: { value: number } }>(a),
      json<{ id: string; type: string; amount: { value: number } }>(b),
    ]);
    expect([a.status, b.status].every((s) => s === 201)).toBe(true);
    expect(bodies[0]!.type).toBe('REFUND');
    expect(bodies[1]!.type).toBe('REFUND');
    expect(bodies[0]!.id).not.toBe(bodies[1]!.id);
    const amounts = [bodies[0]!.amount.value, bodies[1]!.amount.value].sort((x, y) => x - y);
    expect(amounts).toEqual([100, 200]);

    const got = await json<{ payment: { amount: { refunded: number } } }>(
      await app.request(`/v1/payments/${pay.id}`, { headers: authHeaders(config) }),
    );
    expect(got.payment.amount.refunded).toBe(300);
  });
});
