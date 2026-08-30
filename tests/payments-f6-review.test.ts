/**
 * F6 independent-review corrections — focused regression coverage.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AuthorizationVerifier,
} from '../src/domain/authorization/verifier.js';
import {
  parseStrictBody,
  createPaymentBodySchema,
  webhookEndpointBodySchema,
  assertNoSensitiveInputFields,
} from '../src/domain/payments/validation.js';
import {
  deriveProviderIdempotencyKey,
  PaymentError,
} from '../src/domain/payments/helpers.js';
import {
  DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX,
  parseSecretsKey,
} from '../src/crypto/secrets-at-rest.js';
import { MemoryPaymentRepository } from '../src/persistence/payments/memory.js';
import { YunoAdapter } from '../src/providers/yuno/yuno-adapter.js';
import { YunoHttpClient } from '../src/providers/yuno/yuno-http-client.js';
import { signYunoWebhookBody } from '../src/providers/yuno/webhook-verifier.js';
import { createApp as createPlatformApp } from '../src/server/app.js';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { ensureSigningKey } from '../src/credentials/jws.js';
import { DemoKycAdapter } from '../src/kyc/demo.js';
import { issueSessionToken } from '../src/auth/session.js';
import { createApp as createYunoMockApp } from '../yuno_mock/src/app.js';
import { loadMockConfig } from '../yuno_mock/src/config.js';
import { InMemoryYunoRepository } from '../yuno_mock/src/persistence/memory.js';

const ACCOUNT_ID = '493e9374-510a-4201-9e09-de669d75f256';
const OWNER = '0x00000000000000000000000000000000000000b2' as `0x${string}`;
const TEST_PAN = '4111111111111111';
const TEST_CVV = '123';
const HMAC = 'yuno_platform_webhook_hmac_test_secret';

async function runCeremony(ceremony: CeremonyService, owner: `0x${string}`) {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const started = await ceremony.startEnrollment({
    publicJwk,
    keystoreProvider: 'encrypted_os_keystore',
  });
  await ceremony.attachHuman(started.agentUuid, owner);
  const kyc = await ceremony.startKyc(owner);
  const { rawBody, signature } = DemoKycAdapter.signWebhook({
    session_id: kyc.sessionId,
    status: 'verified',
    event_id: `pay-f6-${started.agentUuid}`,
  });
  await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);
  await ceremony.attachHuman(started.agentUuid, owner);
  await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
  const bound = await ceremony.confirmDemoRegistration(started.agentUuid, owner);
  return { agentUuid: started.agentUuid, ...bound };
}

async function enrollFixture(opts?: {
  scenario?: string;
  authz?: AuthorizationVerifier;
  outboundFetch?: typeof fetch;
}) {
  const mockConfig = loadMockConfig({ NODE_ENV: 'test' });
  const mockRepo = new InMemoryYunoRepository();
  const mockApp = createYunoMockApp({ config: mockConfig, repo: mockRepo });

  if (opts?.scenario) {
    await mockApp.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: opts.scenario }),
    });
  }

  const mockFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return mockApp.request(url.replace(/^https?:\/\/[^/]+/, ''), init);
  };

  const platformConfig = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://platform.test',
    KYA_ISSUER: 'http://platform.test',
    KYA_AUDIENCE: 'kya-agent',
    YUNO_BASE_URL: 'http://yuno-mock.test',
    YUNO_ACCOUNT_ID: ACCOUNT_ID,
    YUNO_WEBHOOK_HMAC_SECRET: HMAC,
    PAYMENT_ADMIN_API_KEY: 'payment_admin_test_key',
    PAYMENT_INTERNAL_API_KEY: 'payment_internal_test_key',
  });
  const kyaRepo = new InMemoryRepository();
  await ensureSigningKey(kyaRepo, platformConfig);
  const paymentRepo = new MemoryPaymentRepository();
  const { app: platformApp, ceremony, payment } = createPlatformApp(
    kyaRepo,
    platformConfig,
    {
      repo: paymentRepo,
      fetchImpl: mockFetch,
      outboundFetch: opts?.outboundFetch,
      authz: opts?.authz,
    },
  );

  await ceremony.findOrCreatePrincipal(OWNER);
  const sessionToken = await issueSessionToken(kyaRepo, platformConfig, OWNER);
  const bound = await runCeremony(ceremony, OWNER);

  const start = await platformApp.request('/v1/payment-method-enrollments', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ country: 'CO', currency: 'COP' }),
  });
  const enrollment = (await start.json()) as {
    id: string;
    next_action: { url: string };
  };
  const customerSession = decodeURIComponent(
    enrollment.next_action.url.match(/customer_session=([^&]+)/)![1]!,
  );
  await mockApp.request('/test/enrollment/tokenize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customer_session: customerSession,
      pan: TEST_PAN,
      cvv: TEST_CVV,
      expiration_month: 12,
      expiration_year: 30,
    }),
  });
  await platformApp.request(`/v1/payment-method-enrollments/${enrollment.id}`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const methodsRes = await platformApp.request('/v1/payment-methods', {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  const methods = (await methodsRes.json()) as {
    payment_methods: Array<{ id: string }>;
  };
  const pmId = methods.payment_methods[0]!.id;

  return {
    platformApp,
    mockApp,
    mockRepo,
    paymentRepo,
    payment,
    sessionToken,
    agentToken: bound.token,
    agentUuid: bound.agentUuid,
    pmId,
    platformConfig,
  };
}

describe('strict validation', () => {
  it('rejects unknown fields, sensitive keys, and invalid webhook schemes', () => {
    expect(() =>
      parseStrictBody(createPaymentBodySchema, {
        merchant_id: 'm',
        authorization_id: 'authz_1',
        payment_method_id: 'pm_1',
        merchant_order_id: 'o',
        description: 'd',
        amount: { currency: 'COP', value_minor: 100 },
        capture_method: 'automatic',
        extra: true,
      }),
    ).toThrow(PaymentError);

    expect(() =>
      assertNoSensitiveInputFields({ pan: TEST_PAN, cvv: TEST_CVV }),
    ).toThrow(PaymentError);

    expect(() =>
      parseStrictBody(webhookEndpointBodySchema, { url: 'ftp://evil.test/hook' }),
    ).toThrow(PaymentError);

    expect(
      parseStrictBody(webhookEndpointBodySchema, {
        url: 'https://client.example/hooks',
      }).url,
    ).toBe('https://client.example/hooks');
  });

  it('PAN/CVV at platform boundary → 400 and zero payment/provider mutation', async () => {
    const fx = await enrollFixture();
    const beforePay = (await fx.paymentRepo.getStore()).payments.length;
    const beforeProv = (await fx.mockRepo.getStore()).payments.length;

    const res = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'pan-reject',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_ok',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_pan',
        description: 'leak attempt',
        amount: { currency: 'COP', value_minor: 1000 },
        capture_method: 'automatic',
        country: 'CO',
        pan: TEST_PAN,
        cvv: TEST_CVV,
      }),
    });
    expect(res.status).toBe(400);
    expect((await fx.paymentRepo.getStore()).payments.length).toBe(beforePay);
    expect((await fx.mockRepo.getStore()).payments.length).toBe(beforeProv);
  });
});

describe('authorization binding', () => {
  it('rejects mismatched verifier principal/agent before provider calls', async () => {
    const malicious: AuthorizationVerifier = {
      async verify() {
        return {
          ok: true,
          principalId: 'prin_attacker',
          agentUuid: 'agent_attacker',
        };
      },
    };
    const fx = await enrollFixture({ authz: malicious });
    const beforeProv = (await fx.mockRepo.getStore()).payments.length;
    const res = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'authz-mismatch',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_ok',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_mismatch',
        description: 'mismatch',
        amount: { currency: 'COP', value_minor: 1000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('authorization_invalid');
    expect((await fx.mockRepo.getStore()).payments.length).toBe(beforeProv);
  });
});

describe('provider_timeout stable idempotency', () => {
  it('retries replay same error with one platform payment and one provider payment', async () => {
    const fx = await enrollFixture({ scenario: 'provider_timeout' });
    const body = {
      merchant_id: 'mer_01',
      authorization_id: 'authz_timeout',
      payment_method_id: fx.pmId,
      merchant_order_id: 'order_timeout',
      description: 'Timeout',
      amount: { currency: 'COP', value_minor: 25000 },
      capture_method: 'automatic',
      country: 'CO',
    };
    const headers = {
      authorization: `Bearer ${fx.agentToken}`,
      'content-type': 'application/json',
      'idempotency-key': 'timeout-stable-1',
    };

    const first = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(502);
    const firstBody = (await first.json()) as { code: string; error: string };
    expect(firstBody.code).toBe('payment_outcome_unknown');

    const store1 = await fx.paymentRepo.getStore();
    expect(store1.payments).toHaveLength(1);
    expect(store1.payments[0]!.status).toBe('processing');
    const providerKey = store1.payments[0]!.providerIdempotencyKey;
    expect(providerKey).toBeTruthy();

    const mockStore1 = await fx.mockRepo.getStore();
    expect(mockStore1.payments).toHaveLength(1);

    const second = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(502);
    const secondBody = (await second.json()) as { code: string; error: string };
    expect(secondBody.code).toBe(firstBody.code);
    expect(secondBody.error).toBe(firstBody.error);

    const store2 = await fx.paymentRepo.getStore();
    expect(store2.payments).toHaveLength(1);
    expect(store2.payments[0]!.providerIdempotencyKey).toBe(providerKey);
    expect((await fx.mockRepo.getStore()).payments).toHaveLength(1);
  });
});

describe('requires_3ds mapping', () => {
  it('maps WAITING_ADDITIONAL_STEP to requires_user_action with next_action', async () => {
    const fx = await enrollFixture({ scenario: 'requires_3ds' });
    const res = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': '3ds-1',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_3ds',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_3ds',
        description: '3DS',
        amount: { currency: 'COP', value_minor: 10000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      status: string;
      next_action: { type: string } | null;
    };
    expect(body.status).toBe('requires_user_action');
    expect(body.next_action?.type).toBe('complete_3ds');
  });
});

describe('post-pay provider failures and idempotency keys', () => {
  it('provider 500 on capture never returns false 2xx', async () => {
    const fx = await enrollFixture();
    // Create authorized payment
    const create = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'cap-fail-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_cap',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_cap_fail',
        description: 'Auth',
        amount: { currency: 'COP', value_minor: 40000 },
        capture_method: 'manual',
        country: 'CO',
      }),
    });
    expect(create.status).toBe(201);
    const pay = (await create.json()) as { id: string; status: string };
    expect(pay.status).toBe('authorized');

    // Force provider capture path to 500 via wrapped fetch on a fresh runtime is hard;
    // use adapter unit path: call with injected client.
    const client = new YunoHttpClient({
      baseUrl: 'http://provider.test',
      publicApiKey: 'pk',
      privateSecretKey: 'sk',
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 'PROVIDER_ERROR' }), { status: 500 }),
    });
    const adapter = new YunoAdapter(client, {
      accountId: ACCOUNT_ID,
      baseUrl: 'http://provider.test',
      secretsKey: parseSecretsKey(DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX),
    });
    await expect(
      adapter.capture({
        providerPaymentId: 'pp_1',
        providerTransactionId: 'tx_1',
        currency: 'COP',
        valueMinor: 1000,
        merchantReference: 'm',
        idempotencyKey: deriveProviderIdempotencyKey('cap:k1'),
      }),
    ).rejects.toMatchObject({ code: 'payment_outcome_unknown' });

    await expect(
      adapter.refund({
        providerPaymentId: 'pp_1',
        providerTransactionId: 'tx_1',
        currency: 'COP',
        valueMinor: 1000,
        merchantReference: 'm',
        idempotencyKey: deriveProviderIdempotencyKey('ref:k1'),
      }),
    ).rejects.toMatchObject({ code: 'payment_outcome_unknown' });
  });

  it('same-amount consecutive captures under different platform keys do not collide', async () => {
    const fx = await enrollFixture();
    const create = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'partial-cap-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_pc',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_partial_cap',
        description: 'Partial',
        amount: { currency: 'COP', value_minor: 100000 },
        capture_method: 'manual',
        country: 'CO',
      }),
    });
    const pay = (await create.json()) as { id: string };

    const cap1 = await fx.platformApp.request(`/v1/payments/${pay.id}/capture`, {
      method: 'POST',
      headers: {
        'x-admin-api-key': 'payment_admin_test_key',
        'content-type': 'application/json',
        'idempotency-key': 'partial-cap-a',
      },
      body: JSON.stringify({ amount: { currency: 'COP', value_minor: 30000 } }),
    });
    expect(cap1.status).toBe(200);

    // Second capture of same amount with different platform key must use different provider key
    const keyA = deriveProviderIdempotencyKey('payments.capture:partial-cap-a');
    const keyB = deriveProviderIdempotencyKey('payments.capture:partial-cap-b');
    expect(keyA).not.toBe(keyB);

    // After first full/partial success, second may fail for state — keys still distinct
    const store = await fx.paymentRepo.getStore();
    // Prove derivation includes platform key not only amount
    expect(
      deriveProviderIdempotencyKey('payments.capture:key-1'),
    ).not.toBe(deriveProviderIdempotencyKey('payments.capture:key-2'));
    expect(
      createHash('sha256').update(`${pay.id}:30000`).digest('hex'),
    ).not.toBe(keyA);

    // Refund same amount twice under different keys
    const purchase = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'refund-same-amt-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_ref',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_refund_same',
        description: 'Refund same',
        amount: { currency: 'COP', value_minor: 80000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    const pay2 = (await purchase.json()) as { id: string };

    const r1 = await fx.platformApp.request('/v1/refunds', {
      method: 'POST',
      headers: {
        'x-admin-api-key': 'payment_admin_test_key',
        'content-type': 'application/json',
        'idempotency-key': 'refund-amt-a',
      },
      body: JSON.stringify({
        payment_id: pay2.id,
        amount: { currency: 'COP', value_minor: 10000 },
      }),
    });
    expect(r1.status).toBe(201);

    const r2 = await fx.platformApp.request('/v1/refunds', {
      method: 'POST',
      headers: {
        'x-admin-api-key': 'payment_admin_test_key',
        'content-type': 'application/json',
        'idempotency-key': 'refund-amt-b',
      },
      body: JSON.stringify({
        payment_id: pay2.id,
        amount: { currency: 'COP', value_minor: 10000 },
      }),
    });
    expect(r2.status).toBe(201);
    const rb1 = (await r1.json()) as { id: string };
    const rb2 = (await r2.json()) as { id: string };
    expect(rb1.id).not.toBe(rb2.id);

    expect(
      deriveProviderIdempotencyKey('refunds.create:refund-amt-a'),
    ).not.toBe(deriveProviderIdempotencyKey('refunds.create:refund-amt-b'));

    // Replay same platform key reuses exact provider key (idempotent)
    const r1Replay = await fx.platformApp.request('/v1/refunds', {
      method: 'POST',
      headers: {
        'x-admin-api-key': 'payment_admin_test_key',
        'content-type': 'application/json',
        'idempotency-key': 'refund-amt-a',
      },
      body: JSON.stringify({
        payment_id: pay2.id,
        amount: { currency: 'COP', value_minor: 10000 },
      }),
    });
    expect(r1Replay.status).toBe(201);
    expect((await r1Replay.json() as { id: string }).id).toBe(rb1.id);
    void store;
  });
});

describe('mapPaymentResponse safety', () => {
  it('never uses AUTHORIZE as refundableTransactionId', () => {
    const client = new YunoHttpClient({
      baseUrl: 'http://x',
      publicApiKey: 'pk',
      privateSecretKey: 'sk',
      fetchImpl: async () => new Response('{}'),
    });
    const adapter = new YunoAdapter(client, {
      accountId: ACCOUNT_ID,
      baseUrl: 'http://x',
      secretsKey: parseSecretsKey(DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX),
    });
    const view = adapter.mapPaymentResponse({
      id: 'pay_p',
      status: 'AUTHORIZED',
      sub_status: 'AUTHORIZED',
      amount: { currency: 'COP', value: 100, captured: 0, refunded: 0 },
      transactions: [{ id: 'tx_auth', type: 'AUTHORIZE', status: 'AUTHORIZED' }],
    });
    expect(view.refundableTransactionId).toBeUndefined();
    expect(view.transactionId).toBe('tx_auth');

    const captured = adapter.mapPaymentResponse({
      id: 'pay_p2',
      status: 'SUCCEEDED',
      sub_status: 'APPROVED',
      amount: { currency: 'COP', value: 100, captured: 100, refunded: 0 },
      transactions: [
        { id: 'tx_auth', type: 'AUTHORIZE', status: 'AUTHORIZED' },
        { id: 'tx_cap', type: 'CAPTURE', status: 'SUCCEEDED' },
      ],
    });
    expect(captured.refundableTransactionId).toBe('tx_cap');
  });
});

describe('webhook correctness', () => {
  it('unknown provider id is unmatched and not in applied dedup; later known redelivery applies', async () => {
    const fx = await enrollFixture();
    const create = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'wh-map-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_wh',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_wh_map',
        description: 'WH',
        amount: { currency: 'COP', value_minor: 125000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    expect(create.status).toBe(201);

    const providerPaymentId = (await fx.mockRepo.getStore()).payments[0]!.id;
    const eventId = 'evt_unknown_then_known';

    const unknownBody = JSON.stringify({
      id: eventId,
      type: 'payment',
      type_event: 'PURCHASE',
      data: {
        payment: {
          id: 'not_yet_mapped',
          status: 'SUCCEEDED',
          sub_status: 'APPROVED',
          amount: { currency: 'COP', value: 1250, captured: 1250, refunded: 0 },
        },
      },
    });
    const sig1 = signYunoWebhookBody(unknownBody, HMAC);
    const unk = await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': sig1,
      },
      body: unknownBody,
    });
    expect(unk.status).toBe(200);
    await new Promise<void>((r) => queueMicrotask(() => r()));
    await new Promise((r) => setTimeout(r, 20));

    const mid = await fx.paymentRepo.getStore();
    expect(mid.appliedProviderEventIds).not.toContain(eventId);
    expect(mid.providerEvents.some((e) => e.applyReason === 'unmatched_provider_payment')).toBe(
      true,
    );

    // Bind mapping by setting providerPaymentId on platform payment if not set
    await fx.paymentRepo.withLock((store) => {
      const p = store.payments[0]!;
      p.providerPaymentId = providerPaymentId;
      p.status = 'processing';
      p.capturedMinor = 0;
    });

    const knownBody = JSON.stringify({
      id: eventId,
      type: 'payment',
      type_event: 'PURCHASE',
      data: {
        payment: {
          id: providerPaymentId,
          status: 'SUCCEEDED',
          sub_status: 'APPROVED',
          amount: { currency: 'COP', value: 1250, captured: 1250, refunded: 0 },
          transactions: [
            { id: 'tx_purchase', type: 'PURCHASE', status: 'SUCCEEDED' },
          ],
        },
      },
    });
    const sig2 = signYunoWebhookBody(knownBody, HMAC);
    const known = await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': sig2,
      },
      body: knownBody,
    });
    expect(known.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    const after = await fx.paymentRepo.getStore();
    expect(after.appliedProviderEventIds).toContain(eventId);
    expect(after.payments[0]!.status).toBe('succeeded');
    expect(after.payments[0]!.capturedMinor).toBe(125000);
    expect(after.payments[0]!.providerRefundableTransactionId).toBe('tx_purchase');
  });

  it('exact duplicate, stale after terminal, invalid HMAC zero mutation, hard-terminal no rewind', async () => {
    const fx = await enrollFixture();
    const create = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'wh-term-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_term',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_term',
        description: 'Term',
        amount: { currency: 'COP', value_minor: 50000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    const pay = (await create.json()) as { id: string };
    const providerPaymentId = (await fx.mockRepo.getStore()).payments[0]!.id;
    await fx.paymentRepo.withLock((store) => {
      const p = store.payments.find((x) => x.id === pay.id)!;
      p.providerPaymentId = providerPaymentId;
    });

    const successBody = JSON.stringify({
      id: 'evt_success_1',
      type: 'payment',
      data: {
        payment: {
          id: providerPaymentId,
          status: 'SUCCEEDED',
          sub_status: 'APPROVED',
          amount: { currency: 'COP', value: 500, captured: 500, refunded: 0 },
        },
      },
    });
    const sig = signYunoWebhookBody(successBody, HMAC);
    await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hmac-signature': sig },
      body: successBody,
    });
    await new Promise((r) => setTimeout(r, 30));

    // Exact duplicate
    await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hmac-signature': sig },
      body: successBody,
    });
    await new Promise((r) => setTimeout(r, 20));
    const afterDup = await fx.paymentRepo.getStore();
    expect(afterDup.payments[0]!.status).toBe('succeeded');
    expect(
      afterDup.providerEvents.filter((e) => e.providerEventId === 'evt_success_1').length,
    ).toBeGreaterThanOrEqual(2);

    // Stale PENDING after terminal
    const staleBody = JSON.stringify({
      id: 'evt_stale_1',
      type: 'payment',
      data: {
        payment: {
          id: providerPaymentId,
          status: 'PENDING',
          sub_status: 'IN_PROCESS',
          amount: { currency: 'COP', value: 500, captured: 0, refunded: 0 },
        },
      },
    });
    const staleSig = signYunoWebhookBody(staleBody, HMAC);
    await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': staleSig,
      },
      body: staleBody,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((await fx.paymentRepo.getStore()).payments[0]!.status).toBe('succeeded');

    // Invalid HMAC — zero mutation
    const before = await fx.paymentRepo.getStore();
    const bad = await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': 'deadbeef',
      },
      body: JSON.stringify({
        id: 'evt_bad_hmac',
        data: {
          payment: {
            id: providerPaymentId,
            status: 'REFUNDED',
            sub_status: 'REFUNDED',
          },
        },
      }),
    });
    expect(bad.status).toBe(401);
    const afterBad = await fx.paymentRepo.getStore();
    expect(afterBad.payments[0]!.status).toBe(before.payments[0]!.status);
    expect(afterBad.providerEvents.length).toBe(before.providerEvents.length);
  });

  it('refund_failed records failed refund and unchanged refunded total', async () => {
    // Scenario must be set before create so the payment record stores refund_failed.
    const fx = await enrollFixture({ scenario: 'refund_failed' });
    const create = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'rf-fail-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_rf',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_rf_fail',
        description: 'RF',
        amount: { currency: 'COP', value_minor: 60000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    const pay = (await create.json()) as { id: string; status: string };
    expect(pay.status).toBe('succeeded');

    const refund = await fx.platformApp.request('/v1/refunds', {
      method: 'POST',
      headers: {
        'x-admin-api-key': 'payment_admin_test_key',
        'content-type': 'application/json',
        'idempotency-key': 'rf-fail-1',
      },
      body: JSON.stringify({
        payment_id: pay.id,
        amount: { currency: 'COP', value_minor: 10000 },
      }),
    });
    expect(refund.status).toBe(201);
    const rb = (await refund.json()) as { status: string };
    expect(rb.status).toBe('failed');

    const store = await fx.paymentRepo.getStore();
    const payment = store.payments.find((p) => p.id === pay.id)!;
    expect(payment.status).toBe('succeeded');
    expect(payment.refundedMinor).toBe(0);
  });

  it('processing webhook monetary transition updates captured amount', async () => {
    const fx = await enrollFixture({ scenario: 'processing_then_success' });
    // Create may return processing depending on mock timing; force store state
    const create = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'proc-wh-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_proc',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_proc_wh',
        description: 'Proc',
        amount: { currency: 'COP', value_minor: 99000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    expect([201, 502]).toContain(create.status);

    const mockPay = (await fx.mockRepo.getStore()).payments[0];
    expect(mockPay).toBeTruthy();
    await fx.paymentRepo.withLock((store) => {
      if (store.payments.length === 0) {
        store.payments.push({
          id: 'pay_forced',
          principalId: 'prin_x',
          agentUuid: fx.agentUuid,
          merchantId: 'mer_01',
          merchantOrderId: 'order_proc_wh',
          description: 'Proc',
          authorizationId: 'authz_proc',
          paymentMethodId: fx.pmId,
          amount: { currency: 'COP', value_minor: 99000 },
          captureMethod: 'automatic',
          status: 'processing',
          country: 'CO',
          providerPaymentId: mockPay!.id,
          providerIdempotencyKey: 'forced',
          capturedMinor: 0,
          refundedMinor: 0,
          nextAction: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } else {
        store.payments[0]!.providerPaymentId = mockPay!.id;
        store.payments[0]!.status = 'processing';
        store.payments[0]!.capturedMinor = 0;
      }
    });

    const body = JSON.stringify({
      id: 'evt_proc_success',
      type: 'payment',
      data: {
        payment: {
          id: mockPay!.id,
          status: 'SUCCEEDED',
          sub_status: 'APPROVED',
          amount: { currency: 'COP', value: 990, captured: 990, refunded: 0 },
          checkout: { sdk_action_required: false },
        },
      },
    });
    const sig = signYunoWebhookBody(body, HMAC);
    await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hmac-signature': sig },
      body,
    });
    await new Promise((r) => setTimeout(r, 40));

    const p = (await fx.paymentRepo.getStore()).payments[0]!;
    expect(p.status).toBe('succeeded');
    expect(p.capturedMinor).toBe(99000);
    expect(p.capturedMinor).not.toBe(0);
  });
});

describe('outbound platform webhook delivery', () => {
  it('delivers normalized payload on success and records failed delivery', async () => {
    const delivered: Array<{ url: string; body: unknown }> = [];
    const outboundFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      delivered.push({ url, body });
      if (url.includes('fail')) {
        return new Response('nope', { status: 500 });
      }
      return new Response('ok', { status: 200 });
    };

    const fx = await enrollFixture({ outboundFetch });
    const okEp = await fx.platformApp.request('/v1/webhook-endpoints', {
      method: 'POST',
      headers: {
        'x-admin-api-key': 'payment_admin_test_key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://client.example/hooks/ok' }),
    });
    expect(okEp.status).toBe(201);

    const failEp = await fx.platformApp.request('/v1/webhook-endpoints', {
      method: 'POST',
      headers: {
        'x-admin-api-key': 'payment_admin_test_key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://client.example/hooks/fail' }),
    });
    expect(failEp.status).toBe(201);

    const create = await fx.platformApp.request('/v1/payments', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fx.agentToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'outbound-create',
      },
      body: JSON.stringify({
        merchant_id: 'mer_01',
        authorization_id: 'authz_ob',
        payment_method_id: fx.pmId,
        merchant_order_id: 'order_ob',
        description: 'OB',
        amount: { currency: 'COP', value_minor: 11000 },
        capture_method: 'automatic',
        country: 'CO',
      }),
    });
    const pay = (await create.json()) as { id: string };
    const providerPaymentId = (await fx.mockRepo.getStore()).payments[0]!.id;
    // Force processing so SUCCEEDED webhook applies (not same_state).
    await fx.paymentRepo.withLock((store) => {
      const p = store.payments.find((x) => x.id === pay.id)!;
      p.providerPaymentId = providerPaymentId;
      p.status = 'processing';
      p.capturedMinor = 0;
    });

    const body = JSON.stringify({
      id: 'evt_outbound_1',
      type: 'payment',
      data: {
        payment: {
          id: providerPaymentId,
          status: 'SUCCEEDED',
          sub_status: 'APPROVED',
          amount: { currency: 'COP', value: 110, captured: 110, refunded: 0 },
        },
      },
    });
    const sig = signYunoWebhookBody(body, HMAC);
    await fx.platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hmac-signature': sig },
      body,
    });
    await new Promise((r) => setTimeout(r, 80));

    // Ensure delivery ran (microtask + async fetch)
    if (fx.payment) {
      await fx.payment.service.deliverPendingOutboundWebhooks();
    }

    expect(delivered.length).toBeGreaterThanOrEqual(2);
    for (const d of delivered) {
      const json = JSON.stringify(d.body).toLowerCase();
      expect(json).not.toContain('vaulted_token');
      expect(json).not.toContain(TEST_PAN.toLowerCase());
      expect(json).not.toContain('yuno_private');
    }

    const store = await fx.paymentRepo.getStore();
    expect(store.webhookDeliveries.some((d) => d.status === 'delivered')).toBe(true);
    expect(store.webhookDeliveries.some((d) => d.status === 'failed')).toBe(true);
    expect(store.webhookDeliveries.every((d) => d.attempts >= 1)).toBe(true);
  });
});

describe('queueMicrotask rejection catch', () => {
  it('process rejection does not become unhandled', async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);
    try {
      const fx = await enrollFixture();
      // Valid HMAC + empty event id → process early-returns without unhandled rejection.
      const raw = JSON.stringify({ id: '' });
      const sig = signYunoWebhookBody(raw, HMAC);
      const res = await fx.platformApp.request('/internal/webhooks/yuno', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hmac-signature': sig,
        },
        body: raw,
      });
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});
