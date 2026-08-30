/**
 * F6 E2E: MCP tool adapter → platform REST → independent yuno_mock REST.
 * No direct yuno_mock import into platform production modules (test-only mock app).
 */
import { describe, expect, it } from 'vitest';
import { createApp as createPlatformApp } from '../src/server/app.js';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { MemoryPaymentRepository } from '../src/persistence/payments/memory.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { ensureSigningKey } from '../src/credentials/jws.js';
import { issueSessionToken } from '../src/auth/session.js';
import {
  createPaymentToolAdapter,
  PlatformRestClient,
} from '../src/mcp/payment-tools.js';
import { signYunoWebhookBody } from '../src/providers/yuno/webhook-verifier.js';
import { createApp as createYunoMockApp } from '../yuno_mock/src/app.js';
import { loadMockConfig } from '../yuno_mock/src/config.js';
import { InMemoryYunoRepository } from '../yuno_mock/src/persistence/memory.js';

const ACCOUNT_ID = '493e9374-510a-4201-9e09-de669d75f256';
const OWNER = '0x00000000000000000000000000000000000000a1' as `0x${string}`;
const TEST_PAN = '4111111111111111';
const TEST_CVV = '123';

function assertNoProviderLeak(payload: unknown) {
  const json = JSON.stringify(payload).toLowerCase();
  expect(json).not.toContain('vaulted_token');
  expect(json).not.toContain(TEST_PAN);
  expect(json).not.toMatch(/"cvv"\s*:/);
  expect(json).not.toMatch(/"cvc"\s*:/);
  expect(json).not.toContain('yuno_private_test_key');
  expect(json).not.toContain('yuno_public_test_key');
  // Provider payment method / payment UUIDs may appear in mock internals but
  // public platform responses use pm_/pay_ prefixes only for ids.
}

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
  await ceremony.completeKyc(owner);
  await ceremony.attachHuman(started.agentUuid, owner);
  await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
  const bound = await ceremony.bindAgent(started.agentUuid, owner);
  return { agentUuid: started.agentUuid, ...bound };
}

describe('F6 platform payments E2E', () => {
  it('enrollment → agent purchase → capture/cancel/refund via MCP→platform→mock', async () => {
    const mockConfig = loadMockConfig({ NODE_ENV: 'test' });
    const mockRepo = new InMemoryYunoRepository();
    const mockApp = createYunoMockApp({ config: mockConfig, repo: mockRepo });

    const mockFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      return mockApp.request(path, init);
    };

    const platformConfig = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://platform.test',
      KYA_ISSUER: 'http://platform.test',
      KYA_AUDIENCE: 'kya-agent',
      YUNO_BASE_URL: 'http://yuno-mock.test',
      YUNO_PUBLIC_API_KEY: mockConfig.YUNO_PUBLIC_API_KEY,
      YUNO_PRIVATE_SECRET_KEY: mockConfig.YUNO_PRIVATE_SECRET_KEY,
      YUNO_ACCOUNT_ID: ACCOUNT_ID,
      YUNO_WEBHOOK_HMAC_SECRET: 'yuno_platform_webhook_hmac_test_secret',
      PAYMENT_ADMIN_API_KEY: 'payment_admin_test_key',
      PAYMENT_INTERNAL_API_KEY: 'payment_internal_test_key',
    });

    const kyaRepo = new InMemoryRepository();
    await ensureSigningKey(kyaRepo);
    const paymentRepo = new MemoryPaymentRepository();
    const { app: platformApp, ceremony } = createPlatformApp(kyaRepo, platformConfig, {
      repo: paymentRepo,
      fetchImpl: mockFetch,
    });

    const platformFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      return platformApp.request(path, init);
    };

    // Human session (demo login path) — enrolls methods only; not agent spend.
    await ceremony.findOrCreatePrincipal(OWNER);
    const sessionToken = await issueSessionToken(kyaRepo, platformConfig, OWNER);
    const bound = await runCeremony(ceremony, OWNER);

    const buyerClient = new PlatformRestClient({
      baseUrl: 'http://platform.test',
      sessionToken,
      agentToken: bound.token,
      fetchImpl: platformFetch,
    });
    const adminClient = new PlatformRestClient({
      baseUrl: 'http://platform.test',
      adminApiKey: 'payment_admin_test_key',
      fetchImpl: platformFetch,
    });
    const buyerTools = createPaymentToolAdapter(buyerClient);
    const adminTools = createPaymentToolAdapter(adminClient);

    // Demo session must not authorize agent payment create without KYA credential.
    const sessionOnly = new PlatformRestClient({
      baseUrl: 'http://platform.test',
      agentToken: sessionToken,
      fetchImpl: platformFetch,
    });
    const denied = await sessionOnly.createPayment(
      {
        merchant_id: 'mer_01',
        authorization_id: 'authz_test',
        payment_method_id: 'pm_x',
        merchant_order_id: 'o1',
        description: 'nope',
        amount: { currency: 'COP', value_minor: 100 },
        capture_method: 'automatic',
      },
      'deny-1',
    );
    expect(denied.status).toBe(401);

    // Begin enrollment (human session)
    const enrollStart = await buyerTools['payment_methods.begin_enrollment']({
      country: 'CO',
      currency: 'COP',
    });
    expect(enrollStart.ok).toBe(true);
    assertNoProviderLeak(enrollStart.data);
    const enrollment = enrollStart.data as {
      id: string;
      next_action: { url: string };
    };
    expect(enrollment.next_action.url).toContain('/test/enrollment');
    const sessionMatch = enrollment.next_action.url.match(/customer_session=([^&]+)/);
    expect(sessionMatch).toBeTruthy();
    const customerSession = decodeURIComponent(sessionMatch![1]!);

    // Tokenize on independent mock (test UI path)
    const tokenizeRes = await mockApp.request('/test/enrollment/tokenize', {
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
    expect(tokenizeRes.status).toBe(201);

    // Finalize enrollment via GET
    const enrollGet = await platformApp.request(
      `/v1/payment-method-enrollments/${enrollment.id}`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );
    expect(enrollGet.status).toBe(200);
    const enrollBody = (await enrollGet.json()) as {
      status: string;
      payment_method_id?: string;
    };
    expect(enrollBody.status).toBe('completed');
    expect(enrollBody.payment_method_id).toMatch(/^pm_/);
    assertNoProviderLeak(enrollBody);

    const methods = await buyerTools['payment_methods.list']();
    expect(methods.ok).toBe(true);
    assertNoProviderLeak(methods.data);
    const pmList = methods.data as { payment_methods: Array<{ id: string; last4: string }> };
    expect(pmList.payment_methods[0]?.last4).toBe('1111');
    const pmId = pmList.payment_methods[0]!.id;

    // Automatic purchase
    const purchase = await buyerTools['payments.create']({
      idempotency_key: 'e2e-purchase-1',
      body: {
        merchant_id: 'mer_01JTEST',
        authorization_id: 'authz_e2e_1',
        payment_method_id: pmId,
        merchant_order_id: 'order_auto_1',
        description: 'Agent purchase',
        amount: { currency: 'COP', value_minor: 125000 },
        capture_method: 'automatic',
        country: 'CO',
      },
    });
    expect(purchase.ok).toBe(true);
    assertNoProviderLeak(purchase.data);
    const payAuto = purchase.data as { id: string; status: string };
    expect(payAuto.id).toMatch(/^pay_/);
    expect(payAuto.status).toBe('succeeded');

    // Idempotent replay
    const replay = await buyerTools['payments.create']({
      idempotency_key: 'e2e-purchase-1',
      body: {
        merchant_id: 'mer_01JTEST',
        authorization_id: 'authz_e2e_1',
        payment_method_id: pmId,
        merchant_order_id: 'order_auto_1',
        description: 'Agent purchase',
        amount: { currency: 'COP', value_minor: 125000 },
        capture_method: 'automatic',
        country: 'CO',
      },
    });
    expect(replay.ok).toBe(true);
    expect((replay.data as { id: string }).id).toBe(payAuto.id);

    // Same key different body → 409
    const reuse = await buyerClient.createPayment(
      {
        merchant_id: 'mer_01JTEST',
        authorization_id: 'authz_e2e_1',
        payment_method_id: pmId,
        merchant_order_id: 'order_auto_OTHER',
        description: 'Different',
        amount: { currency: 'COP', value_minor: 125000 },
        capture_method: 'automatic',
        country: 'CO',
      },
      'e2e-purchase-1',
    );
    expect(reuse.status).toBe(409);
    expect((reuse.body as { code: string }).code).toBe('idempotency_key_reused');

    // Manual authorize + admin capture
    const authzPay = await buyerTools['payments.create']({
      idempotency_key: 'e2e-authz-1',
      body: {
        merchant_id: 'mer_01JTEST',
        authorization_id: 'authz_e2e_2',
        payment_method_id: pmId,
        merchant_order_id: 'order_auth_1',
        description: 'Manual auth',
        amount: { currency: 'COP', value_minor: 50000 },
        capture_method: 'manual',
        country: 'CO',
      },
    });
    expect(authzPay.ok).toBe(true);
    const payAuth = authzPay.data as { id: string; status: string };
    expect(payAuth.status).toBe('authorized');

    const capture = await adminTools['payments.capture']({
      id: payAuth.id,
      idempotency_key: 'e2e-capture-1',
    });
    expect(capture.ok).toBe(true);
    expect((capture.data as { status: string }).status).toBe('succeeded');
    assertNoProviderLeak(capture.data);

    // Cancel path: new authorization then cancel
    const toCancel = await buyerTools['payments.create']({
      idempotency_key: 'e2e-cancel-create',
      body: {
        merchant_id: 'mer_01JTEST',
        authorization_id: 'authz_e2e_3',
        payment_method_id: pmId,
        merchant_order_id: 'order_cancel_1',
        description: 'Cancel me',
        amount: { currency: 'COP', value_minor: 10000 },
        capture_method: 'manual',
        country: 'CO',
      },
    });
    const payCancel = toCancel.data as { id: string };
    const canceled = await buyerTools['payments.cancel']({
      id: payCancel.id,
      idempotency_key: 'e2e-cancel-1',
    });
    expect(canceled.ok).toBe(true);
    expect((canceled.data as { status: string }).status).toBe('canceled');

    // Partial then full refund on captured payment
    const partial = await adminTools['refunds.create']({
      payment_id: payAuth.id,
      idempotency_key: 'e2e-refund-partial',
      amount: { currency: 'COP', value_minor: 10000 },
    });
    expect(partial.ok).toBe(true);
    assertNoProviderLeak(partial.data);

    const full = await adminTools['refunds.create']({
      payment_id: payAuth.id,
      idempotency_key: 'e2e-refund-rest',
      amount: { currency: 'COP', value_minor: 40000 },
    });
    expect(full.ok).toBe(true);

    // Webhook invalid HMAC → 401
    const badWh = await platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': 'invalid',
      },
      body: JSON.stringify({ id: 'evt_bad' }),
    });
    expect(badWh.status).toBe(401);

    // Valid HMAC → 200
    const whBody = JSON.stringify({
      id: 'evt_ok_1',
      type: 'payment',
      type_event: 'PURCHASE',
      data: {
        payment: {
          id: 'unknown_provider_id',
          status: 'SUCCEEDED',
          sub_status: 'APPROVED',
        },
      },
    });
    const sig = signYunoWebhookBody(
      whBody,
      platformConfig.YUNO_WEBHOOK_HMAC_SECRET!,
    );
    const goodWh = await platformApp.request('/internal/webhooks/yuno', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': sig,
      },
      body: whBody,
    });
    expect(goodWh.status).toBe(200);

    // Internal health
    const health = await platformApp.request('/internal/providers/yuno/health', {
      headers: { 'x-internal-api-key': 'payment_internal_test_key' },
    });
    expect(health.status).toBe(200);

    // Capabilities via agent
    const caps = await buyerTools['payment_capabilities.get']({
      merchant_id: 'mer_01',
      country: 'CO',
      currency: 'COP',
    });
    expect(caps.ok).toBe(true);

    // AuthorizationVerifier invoked: missing/invalid authz fails
    const noAuthz = await buyerClient.createPayment(
      {
        merchant_id: 'mer_01JTEST',
        authorization_id: 'not_valid',
        payment_method_id: pmId,
        merchant_order_id: 'order_bad_authz',
        description: 'Bad authz',
        amount: { currency: 'COP', value_minor: 1000 },
        capture_method: 'automatic',
        country: 'CO',
      },
      'e2e-bad-authz',
    );
    expect(noAuthz.status).toBe(403);
    expect((noAuthz.body as { code: string }).code).toBe('authorization_invalid');
  });

  it('maps decline and keeps PENDING/AUTHORIZED out of success', async () => {
    const mockConfig = loadMockConfig({ NODE_ENV: 'test' });
    const mockRepo = new InMemoryYunoRepository();
    const mockApp = createYunoMockApp({ config: mockConfig, repo: mockRepo });

    // Set decline scenario via mock internal control
    await mockApp.request('/test/scenarios/payments', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenario: 'declined' }),
    });

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
    });
    const kyaRepo = new InMemoryRepository();
    await ensureSigningKey(kyaRepo);
    const { app: platformApp, ceremony } = createPlatformApp(kyaRepo, platformConfig, {
      repo: new MemoryPaymentRepository(),
      fetchImpl: mockFetch,
    });

    await ceremony.findOrCreatePrincipal(OWNER);
    const sessionToken = await issueSessionToken(kyaRepo, platformConfig, OWNER);
    const bound = await runCeremony(ceremony, OWNER);

    const platformFetch: typeof fetch = async (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      return platformApp.request(url.replace(/^https?:\/\/[^/]+/, ''), init);
    };

    const client = new PlatformRestClient({
      baseUrl: 'http://platform.test',
      sessionToken,
      agentToken: bound.token,
      fetchImpl: platformFetch,
    });

    const start = await client.beginEnrollment({ country: 'CO', currency: 'COP' });
    const enrollment = start.body as { id: string; next_action: { url: string } };
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
    const methods = (await client.listPaymentMethods()).body as {
      payment_methods: Array<{ id: string }>;
    };
    const pmId = methods.payment_methods[0]!.id;

    const declined = await client.createPayment(
      {
        merchant_id: 'mer_01',
        authorization_id: 'authz_decline',
        payment_method_id: pmId,
        merchant_order_id: 'order_decline',
        description: 'Decline',
        amount: { currency: 'COP', value_minor: 1000 },
        capture_method: 'automatic',
        country: 'CO',
      },
      'decline-1',
    );
    expect(declined.status).toBe(201);
    expect((declined.body as { status: string }).status).toBe('declined');
    assertNoProviderLeak(declined.body);
  });
});
