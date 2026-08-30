/**
 * F6 real-socket closure E2E — MCP tool adapter → platform Hono → yuno_mock
 * on ephemeral 127.0.0.1 ports. Default fetch on every hop (platform → mock,
 * MCP → platform). Bounded test-only wrap only at the mock listener when
 * injecting deterministic 500s. No app.request.
 */
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp as createPlatformApp } from '../src/server/app.js';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { MemoryPaymentRepository } from '../src/persistence/payments/memory.js';
import type { PaymentRepository } from '../src/persistence/payments/types.js';
import { ensureSigningKey } from '../src/credentials/jws.js';
import { issueSessionToken } from '../src/auth/session.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { DemoKycAdapter } from '../src/kyc/demo.js';
import type { AuthorizationVerifier } from '../src/domain/authorization/verifier.js';
import {
  createPaymentToolAdapter,
  PlatformRestClient,
  type PaymentToolAdapter,
} from '../src/mcp/payment-tools.js';
import { createApp as createYunoMockApp } from '../yuno_mock/src/app.js';
import { loadMockConfig, type MockConfig } from '../yuno_mock/src/config.js';
import { InMemoryYunoRepository } from '../yuno_mock/src/persistence/memory.js';
import type { YunoMockRepository } from '../yuno_mock/src/persistence/index.js';
import { createRuntime } from '../yuno_mock/src/runtime.js';
import { signYunoWebhookBody } from '../src/providers/yuno/webhook-verifier.js';

const ACCOUNT_ID = '493e9374-510a-4201-9e09-de669d75f256';
const OWNER = '0x00000000000000000000000000000000000000c3' as `0x${string}`;
const TEST_PAN = '4111111111111111';
const TEST_CVV = '123';
const HMAC = 'yuno_platform_webhook_hmac_test_secret';
const ADMIN_KEY = 'payment_admin_test_key';

function assertNoProviderLeak(payload: unknown) {
  const json = JSON.stringify(payload).toLowerCase();
  expect(json).not.toContain('vaulted_token');
  expect(json).not.toContain(TEST_PAN);
  expect(json).not.toMatch(/"cvv"\s*:/);
  expect(json).not.toMatch(/"cvc"\s*:/);
  expect(json).not.toContain('yuno_private_test_key');
  expect(json).not.toContain('yuno_public_test_key');
}

async function listen(
  fetchHandler: Parameters<typeof serve>[0]['fetch'],
): Promise<{ server: ServerType; baseUrl: string }> {
  // Use serve()'s listeningListener — never race server.listening vs once('listening').
  return new Promise((resolve, reject) => {
    let settled = false;
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const server = serve(
      {
        fetch: fetchHandler,
        hostname: '127.0.0.1',
        port: 0,
      },
      (info) => {
        server.off('error', onError);
        const port =
          typeof info === 'object' && info !== null && 'port' in info
            ? Number((info as AddressInfo).port)
            : Number((server.address() as AddressInfo | null)?.port);
        if (!Number.isFinite(port) || port <= 0) {
          if (settled) return;
          settled = true;
          void closeServer(server).finally(() => {
            reject(new Error('listen: invalid ephemeral port'));
          });
          return;
        }
        if (settled) return;
        settled = true;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      },
    );
    server.on('error', onError);
  });
}

async function closeServer(server: ServerType): Promise<void> {
  // Drop keep-alive sockets so the next ephemeral bind is not racing undici pools.
  const withAll = server as ServerType & { closeAllConnections?: () => void };
  if (typeof withAll.closeAllConnections === 'function') {
    withAll.closeAllConnections();
  }
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (!err) {
        resolve();
        return;
      }
      // Idempotent close: already shut down is fine.
      if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(err);
    });
  });
}

async function waitForHttpOk(url: string, label: string): Promise<void> {
  await pollUntil(
    `ready ${label} (${url})`,
    async () => {
      try {
        const res = await fetch(url);
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 3_000, intervalMs: 15 },
  );
}

function assertToolOk(
  result: { ok: boolean; status: number; data: unknown; error?: string },
  label: string,
): void {
  if (result.ok) return;
  throw new Error(
    `${label} failed: status=${result.status} error=${JSON.stringify(result.error)} data=${JSON.stringify(result.data)}`,
  );
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
  const kyc = await ceremony.startKyc(owner);
  const { rawBody, signature } = DemoKycAdapter.signWebhook({
    session_id: kyc.sessionId,
    status: 'verified',
    event_id: `pay-real-${started.agentUuid}`,
  });
  await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);
  await ceremony.attachHuman(started.agentUuid, owner);
  await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
  const bound = await ceremony.confirmDemoRegistration(started.agentUuid, owner);
  return { agentUuid: started.agentUuid, ...bound };
}

type MockIntercept = {
  /** When true, capture/refund provider paths return deterministic 500. */
  failPostPay: boolean;
};

type Harness = {
  mockBaseUrl: string;
  platformBaseUrl: string;
  mockConfig: MockConfig;
  mockRepo: YunoMockRepository;
  paymentRepo: PaymentRepository;
  sessionToken: string;
  agentToken: string;
  agentUuid: string;
  principalId: string;
  buyerTools: PaymentToolAdapter;
  adminTools: PaymentToolAdapter;
  intercept: MockIntercept;
  close: () => Promise<void>;
};

const openHarnesses: Array<() => Promise<void>> = [];

afterEach(async () => {
  const closers = openHarnesses.splice(0, openHarnesses.length).reverse();
  // LIFO: last opened closes first. Isolate failures so one leak doesn't skip peers.
  const errors: unknown[] = [];
  for (const close of closers) {
    try {
      await close();
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw errors[0];
  }
});

/** Bounded poll — fails the test if condition never becomes true. */
async function pollUntil(
  label: string,
  predicate: () => Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const intervalMs = opts?.intervalMs ?? 40;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`pollUntil timed out: ${label}`);
}

async function startHarness(opts?: {
  authz?: AuthorizationVerifier;
  outboundFetch?: typeof fetch;
}): Promise<Harness> {
  const intercept: MockIntercept = { failPostPay: false };
  const mockConfig = loadMockConfig({ NODE_ENV: 'test', HOST: '127.0.0.1' });
  const mockRepo = new InMemoryYunoRepository();
  const runtime = createRuntime({ fetch: globalThis.fetch.bind(globalThis) });
  const mockApp = createYunoMockApp({ config: mockConfig, repo: mockRepo, runtime });

  // Bounded wrap at mock listener only — platform still uses default fetch → mockBaseUrl.
  const mockListen = await listen(async (req, env) => {
    const url = new URL(req.url);
    if (
      intercept.failPostPay &&
      req.method === 'POST' &&
      (url.pathname.includes('/capture') || url.pathname.includes('/refund'))
    ) {
      return new Response(
        JSON.stringify({
          code: 'PROVIDER_ERROR',
          messages: ['Deterministic test 500'],
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }
    return mockApp.fetch(req, env);
  });
  // Register mock close immediately so a later platform-listen failure cannot leak the port.
  let platformServer: ServerType | null = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Platform exactly once (if started), then mock exactly once — even if platform close rejects.
    const platform = platformServer;
    platformServer = null;
    let firstError: unknown;
    try {
      if (platform) await closeServer(platform);
    } catch (err) {
      firstError = err;
    } finally {
      try {
        await closeServer(mockListen.server);
      } catch (err) {
        if (firstError === undefined) firstError = err;
      }
    }
    if (firstError !== undefined) throw firstError;
  };
  openHarnesses.push(close);

  const paymentRepo = new MemoryPaymentRepository();
  const platformConfig = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://127.0.0.1:9',
    KYA_ISSUER: 'http://127.0.0.1:9',
    KYA_AUDIENCE: 'kya-agent',
    YUNO_BASE_URL: mockListen.baseUrl,
    YUNO_PUBLIC_API_KEY: mockConfig.YUNO_PUBLIC_API_KEY,
    YUNO_PRIVATE_SECRET_KEY: mockConfig.YUNO_PRIVATE_SECRET_KEY,
    YUNO_ACCOUNT_ID: ACCOUNT_ID,
    YUNO_WEBHOOK_HMAC_SECRET: HMAC,
    PAYMENT_ADMIN_API_KEY: ADMIN_KEY,
    PAYMENT_INTERNAL_API_KEY: 'payment_internal_test_key',
  });
  const kyaRepo = new InMemoryRepository();
  await ensureSigningKey(kyaRepo, platformConfig);

  // Default real fetch against mock — no fetchImpl on platform runtime.
  const { app: platformApp, ceremony, payment } = createPlatformApp(
    kyaRepo,
    platformConfig,
    {
      repo: paymentRepo,
      authz: opts?.authz,
      outboundFetch: opts?.outboundFetch,
    },
  );
  expect(payment).toBeTruthy();

  const platformListen = await listen(platformApp.fetch);
  platformServer = platformListen.server;
  expect(platformListen.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(mockListen.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(platformListen.baseUrl).not.toBe(mockListen.baseUrl);

  // Prove both sockets accept HTTP before any MCP hop (eliminates listen/accept races).
  await waitForHttpOk(`${mockListen.baseUrl}/health`, 'mock');
  await waitForHttpOk(`${platformListen.baseUrl}/health`, 'platform');

  const principal = await ceremony.findOrCreatePrincipal(OWNER);
  const sessionToken = await issueSessionToken(kyaRepo, platformConfig, OWNER);
  const bound = await runCeremony(ceremony, OWNER);

  const buyerClient = new PlatformRestClient({
    baseUrl: platformListen.baseUrl,
    sessionToken,
    agentToken: bound.token,
  });
  const adminClient = new PlatformRestClient({
    baseUrl: platformListen.baseUrl,
    adminApiKey: ADMIN_KEY,
  });

  return {
    mockBaseUrl: mockListen.baseUrl,
    platformBaseUrl: platformListen.baseUrl,
    mockConfig,
    mockRepo,
    paymentRepo,
    sessionToken,
    agentToken: bound.token,
    agentUuid: bound.agentUuid,
    principalId: principal.id,
    buyerTools: createPaymentToolAdapter(buyerClient),
    adminTools: createPaymentToolAdapter(adminClient),
    intercept,
    close,
  };
}

async function enrollAndGetPmId(h: Harness): Promise<string> {
  const enrollStart = await h.buyerTools['payment_methods.begin_enrollment']({
    country: 'CO',
    currency: 'COP',
  });
  assertToolOk(enrollStart, 'payment_methods.begin_enrollment');
  const enrollment = enrollStart.data as {
    id: string;
    next_action: { url: string };
  };
  expect(enrollment.next_action.url).toContain(h.mockBaseUrl);
  const customerSession = decodeURIComponent(
    enrollment.next_action.url.match(/customer_session=([^&]+)/)![1]!,
  );

  const tokenizeRes = await fetch(`${h.mockBaseUrl}/test/enrollment/tokenize`, {
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
  if (tokenizeRes.status !== 201) {
    const text = await tokenizeRes.text();
    throw new Error(
      `tokenize failed: status=${tokenizeRes.status} body=${text}`,
    );
  }

  const enrollGet = await fetch(
    `${h.platformBaseUrl}/v1/payment-method-enrollments/${enrollment.id}`,
    { headers: { authorization: `Bearer ${h.sessionToken}` } },
  );
  const enrollText = await enrollGet.text();
  if (enrollGet.status !== 200) {
    throw new Error(
      `enrollment get failed: status=${enrollGet.status} body=${enrollText}`,
    );
  }
  const enrollBody = JSON.parse(enrollText) as {
    status: string;
    payment_method_id?: string;
  };
  expect(enrollBody.status).toBe('completed');
  assertNoProviderLeak(enrollBody);

  const methods = await h.buyerTools['payment_methods.list']();
  assertToolOk(methods, 'payment_methods.list');
  const pmId = (
    methods.data as { payment_methods: Array<{ id: string }> }
  ).payment_methods[0]!.id;
  return pmId;
}

async function setPaymentScenario(h: Harness, scenario: string): Promise<void> {
  const res = await fetch(`${h.mockBaseUrl}/test/scenarios/payments`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario }),
  });
  expect(res.status).toBe(200);
}

function mockAuthHeaders(config: MockConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    'public-api-key': config.YUNO_PUBLIC_API_KEY,
    'private-secret-key': config.YUNO_PRIVATE_SECRET_KEY,
  };
}

describe('F6 real HTTP socket closure', () => {
  it('enrollment/tokenize/finalize + agent purchase + replay over sockets', async () => {
    const h = await startHarness();
    // Health already proven in startHarness; re-check once for the public path.
    const mockHealth = await fetch(`${h.mockBaseUrl}/health`);
    expect(mockHealth.status).toBe(200);
    const platformHealth = await fetch(`${h.platformBaseUrl}/health`);
    expect(platformHealth.status).toBe(200);

    const pmId = await enrollAndGetPmId(h);
    const body = {
      merchant_id: 'mer_01JREAL',
      authorization_id: 'authz_real_http',
      payment_method_id: pmId,
      merchant_order_id: 'order_real_http_1',
      description: 'Real socket purchase',
      amount: { currency: 'COP', value_minor: 125000 },
      capture_method: 'automatic' as const,
      country: 'CO',
    };
    const purchase = await h.buyerTools['payments.create']({
      idempotency_key: 'real-http-purchase-1',
      body,
    });
    expect(purchase.ok).toBe(true);
    assertNoProviderLeak(purchase.data);
    const pay = purchase.data as { id: string; status: string };
    expect(pay.id).toMatch(/^pay_/);
    expect(pay.status).toBe('succeeded');

    const replay = await h.buyerTools['payments.create']({
      idempotency_key: 'real-http-purchase-1',
      body,
    });
    expect(replay.ok).toBe(true);
    expect((replay.data as { id: string }).id).toBe(pay.id);
  });

  it('provider_timeout: same-key MCP calls replay exact 502; one platform + one mock payment', async () => {
    const h = await startHarness();
    const pmId = await enrollAndGetPmId(h);
    await setPaymentScenario(h, 'provider_timeout');

    const body = {
      merchant_id: 'mer_01',
      authorization_id: 'authz_timeout_sock',
      payment_method_id: pmId,
      merchant_order_id: 'order_timeout_sock',
      description: 'Timeout socket',
      amount: { currency: 'COP', value_minor: 25000 },
      capture_method: 'automatic' as const,
      country: 'CO',
    };

    const first = await h.buyerTools['payments.create']({
      idempotency_key: 'sock-timeout-1',
      body,
    });
    expect(first.ok).toBe(false);
    expect(first.status).toBe(502);
    const firstData = first.data as { code: string; error: string };
    expect(firstData.code).toBe('payment_outcome_unknown');

    const store1 = await h.paymentRepo.getStore();
    expect(store1.payments).toHaveLength(1);
    expect(store1.attempts).toHaveLength(1);
    expect(store1.payments[0]!.status).toBe('processing');
    const providerKey = store1.payments[0]!.providerIdempotencyKey;
    expect(providerKey).toBeTruthy();
    expect(store1.attempts[0]!.providerIdempotencyKey).toBe(providerKey);

    const mock1 = await h.mockRepo.getStore();
    expect(mock1.payments).toHaveLength(1);
    const timeoutIdem = mock1.idempotency.filter((r) => r.key === providerKey);
    expect(timeoutIdem).toHaveLength(1);
    expect(timeoutIdem[0]!.state).toBe('COMPLETED');
    expect(timeoutIdem[0]!.responseStatus).toBe(500);

    // Same-key replay with a fresh same-body object (single `body` property — no duplicate key).
    const second = await h.buyerTools['payments.create']({
      idempotency_key: 'sock-timeout-1',
      body: {
        merchant_id: body.merchant_id,
        authorization_id: body.authorization_id,
        payment_method_id: body.payment_method_id,
        merchant_order_id: body.merchant_order_id,
        description: body.description,
        amount: { currency: body.amount.currency, value_minor: body.amount.value_minor },
        capture_method: body.capture_method,
        country: body.country,
      },
    });
    expect(second.status).toBe(502);
    const secondData = second.data as { code: string; error: string };
    expect(secondData.code).toBe(firstData.code);
    expect(secondData.error).toBe(firstData.error);

    const store2 = await h.paymentRepo.getStore();
    expect(store2.payments).toHaveLength(1);
    expect(store2.attempts).toHaveLength(1);
    expect(store2.payments[0]!.providerIdempotencyKey).toBe(providerKey);
    const mock2 = await h.mockRepo.getStore();
    expect(mock2.payments).toHaveLength(1);
    const timeoutIdemAfter = mock2.idempotency.filter((r) => r.key === providerKey);
    expect(timeoutIdemAfter).toHaveLength(1);
    expect(timeoutIdemAfter[0]!.state).toBe('COMPLETED');
    expect(timeoutIdemAfter[0]!.responseStatus).toBe(500);
  });

  it('post-pay 5xx via MCP admin over sockets: no false 2xx, durable same-key replay', async () => {
    const h = await startHarness();
    const pmId = await enrollAndGetPmId(h);

    const create = await h.buyerTools['payments.create']({
      idempotency_key: 'sock-cap-create',
      body: {
        merchant_id: 'mer_01',
        authorization_id: 'authz_cap_sock',
        payment_method_id: pmId,
        merchant_order_id: 'order_cap_sock',
        description: 'Auth for capture 500',
        amount: { currency: 'COP', value_minor: 40000 },
        capture_method: 'manual',
        country: 'CO',
      },
    });
    expect(create.ok).toBe(true);
    const pay = create.data as { id: string; status: string };
    expect(pay.status).toBe('authorized');

    h.intercept.failPostPay = true;

    const cap1 = await h.adminTools['payments.capture']({
      id: pay.id,
      idempotency_key: 'sock-cap-fail-1',
    });
    expect(cap1.ok).toBe(false);
    expect(cap1.status).toBe(502);
    const capBody1 = cap1.data as { code: string; error: string };
    expect(capBody1.code).toBe('payment_outcome_unknown');

    // Payment stays authorized — no false success
    const getPay = await h.buyerTools['payments.get']({ id: pay.id });
    expect(getPay.ok).toBe(true);
    expect((getPay.data as { status: string }).status).toBe('authorized');

    const store = await h.paymentRepo.getStore();
    const idem = store.idempotency.find((r) =>
      r.key.includes('payments.capture') && r.key.includes('sock-cap-fail-1'),
    );
    expect(idem?.status).toBe('failed');
    expect(idem?.httpStatus).toBe(502);

    const cap2 = await h.adminTools['payments.capture']({
      id: pay.id,
      idempotency_key: 'sock-cap-fail-1',
    });
    expect(cap2.status).toBe(502);
    const capBody2 = cap2.data as { code: string; error: string };
    expect(capBody2.code).toBe(capBody1.code);
    expect(capBody2.error).toBe(capBody1.error);

    // Refund path also covered under same intercept
    h.intercept.failPostPay = false;
    const purchase = await h.buyerTools['payments.create']({
      idempotency_key: 'sock-ref-create',
      body: {
        merchant_id: 'mer_01',
        authorization_id: 'authz_ref_sock',
        payment_method_id: pmId,
        merchant_order_id: 'order_ref_sock',
        description: 'Purchase for refund 500',
        amount: { currency: 'COP', value_minor: 30000 },
        capture_method: 'automatic',
        country: 'CO',
      },
    });
    expect(purchase.ok).toBe(true);
    const pay2 = purchase.data as { id: string };

    h.intercept.failPostPay = true;
    const ref1 = await h.adminTools['refunds.create']({
      payment_id: pay2.id,
      idempotency_key: 'sock-ref-fail-1',
      amount: { currency: 'COP', value_minor: 10000 },
    });
    expect(ref1.ok).toBe(false);
    expect(ref1.status).toBe(502);
    expect((ref1.data as { code: string }).code).toBe('payment_outcome_unknown');

    const ref2 = await h.adminTools['refunds.create']({
      payment_id: pay2.id,
      idempotency_key: 'sock-ref-fail-1',
      amount: { currency: 'COP', value_minor: 10000 },
    });
    expect(ref2.status).toBe(502);
    expect((ref2.data as { code: string }).code).toBe('payment_outcome_unknown');
    expect((ref2.data as { error: string }).error).toBe(
      (ref1.data as { error: string }).error,
    );

    const storeAfter = await h.paymentRepo.getStore();
    expect(storeAfter.refunds).toHaveLength(0);
    expect(
      storeAfter.idempotency.some(
        (r) => r.key.includes('refunds.create') && r.status === 'failed',
      ),
    ).toBe(true);
  });

  it('authorization binding: principal-only and agent-only mismatches reject before mutation', async () => {
    const ids = { principalId: '', agentUuid: '' };
    const keyedAuthz: AuthorizationVerifier = {
      async verify(ctx) {
        if (ctx.authorizationId === 'authz_principal_mismatch') {
          return {
            ok: true,
            principalId: 'prin_attacker',
            agentUuid: ids.agentUuid,
          };
        }
        if (ctx.authorizationId === 'authz_agent_mismatch') {
          return {
            ok: true,
            principalId: ids.principalId,
            agentUuid: 'agent_attacker',
          };
        }
        return {
          ok: true,
          principalId: ctx.actorId,
          agentUuid: ids.agentUuid,
        };
      },
    };
    const h = await startHarness({ authz: keyedAuthz });
    ids.principalId = h.principalId;
    ids.agentUuid = h.agentUuid;
    expect(ids.principalId).toMatch(/^prin_/);
    expect(ids.agentUuid.length).toBeGreaterThan(0);

    const pmId = await enrollAndGetPmId(h);
    const beforeMock = (await h.mockRepo.getStore()).payments.length;
    const beforePlatform = (await h.paymentRepo.getStore()).payments.length;

    const principalMismatch = await h.buyerTools['payments.create']({
      idempotency_key: 'sock-authz-principal',
      body: {
        merchant_id: 'mer_01',
        authorization_id: 'authz_principal_mismatch',
        payment_method_id: pmId,
        merchant_order_id: 'order_principal_mismatch',
        description: 'Principal mismatch only',
        amount: { currency: 'COP', value_minor: 1000 },
        capture_method: 'automatic',
        country: 'CO',
      },
    });
    expect(principalMismatch.ok).toBe(false);
    expect(principalMismatch.status).toBe(403);
    expect((principalMismatch.data as { code: string }).code).toBe(
      'authorization_invalid',
    );
    expect((await h.mockRepo.getStore()).payments.length).toBe(beforeMock);
    expect((await h.paymentRepo.getStore()).payments.length).toBe(beforePlatform);

    const agentMismatch = await h.buyerTools['payments.create']({
      idempotency_key: 'sock-authz-agent',
      body: {
        merchant_id: 'mer_01',
        authorization_id: 'authz_agent_mismatch',
        payment_method_id: pmId,
        merchant_order_id: 'order_agent_mismatch',
        description: 'Agent mismatch only',
        amount: { currency: 'COP', value_minor: 1000 },
        capture_method: 'automatic',
        country: 'CO',
      },
    });
    expect(agentMismatch.ok).toBe(false);
    expect(agentMismatch.status).toBe(403);
    expect((agentMismatch.data as { code: string }).code).toBe(
      'authorization_invalid',
    );
    expect((await h.mockRepo.getStore()).payments.length).toBe(beforeMock);
    expect((await h.paymentRepo.getStore()).payments.length).toBe(beforePlatform);
  });

  it('inbound mock→platform webhooks + outbound platform delivery over real sockets', async () => {
    const received: Array<{ body: unknown }> = [];
    const receiverListen = await listen(async (req) => {
      const text = await req.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      received.push({ body });
      return new Response('ok', { status: 200 });
    });
    openHarnesses.push(async () => closeServer(receiverListen.server));

    const h = await startHarness();
    const pmId = await enrollAndGetPmId(h);

    // Register mock webhook → platform internal endpoint (real HTTP) before create.
    const whCreate = await fetch(`${h.mockBaseUrl}/v1/webhooks`, {
      method: 'POST',
      headers: mockAuthHeaders(h.mockConfig),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        name: 'platform-inbound',
        url: `${h.platformBaseUrl}/internal/webhooks/yuno`,
        hmac_client_secret: HMAC,
        payment_triggers: ['AUTHORIZE', 'CAPTURE', 'CANCEL', 'REFUND', 'PURCHASE'],
      }),
    });
    expect(whCreate.status).toBe(201);

    // Register platform outbound endpoint → ephemeral receiver
    const epRes = await fetch(`${h.platformBaseUrl}/v1/webhook-endpoints`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-api-key': ADMIN_KEY,
      },
      body: JSON.stringify({ url: `${receiverListen.baseUrl}/hooks` }),
    });
    expect(epRes.status).toBe(201);

    await setPaymentScenario(h, 'processing_then_success');
    const create = await h.buyerTools['payments.create']({
      idempotency_key: 'sock-wh-create',
      body: {
        merchant_id: 'mer_01',
        authorization_id: 'authz_wh_sock',
        payment_method_id: pmId,
        merchant_order_id: 'order_wh_sock',
        description: 'Webhook monetary',
        amount: { currency: 'COP', value_minor: 99000 },
        capture_method: 'automatic',
        country: 'CO',
      },
    });
    expect(create.ok).toBe(true);
    expect(create.status).toBe(201);
    const created = create.data as { id: string; status: string };
    expect(created.status).toBe('processing');
    expect(created.id).toMatch(/^pay_/);

    const afterCreate = await h.paymentRepo.getStore();
    expect(afterCreate.payments).toHaveLength(1);
    const platformPay = afterCreate.payments[0]!;
    expect(platformPay.id).toBe(created.id);
    expect(platformPay.status).toBe('processing');
    expect(platformPay.providerPaymentId).toBeTruthy();
    expect(platformPay.capturedMinor).toBe(0);
    const providerPaymentId = platformPay.providerPaymentId!;

    const mockPay = (await h.mockRepo.getStore()).payments.find(
      (p) => p.id === providerPaymentId,
    );
    expect(mockPay).toBeTruthy();

    // Primary monetary transition: mock work → registered webhook → platform (no fallback).
    const work = await fetch(`${h.mockBaseUrl}/test/work/process`, {
      method: 'POST',
    });
    expect(work.status).toBe(200);
    const workBody = (await work.json()) as {
      asyncActionsProcessed?: number;
      deliveriesAttempted?: number;
    };
    expect((workBody.asyncActionsProcessed ?? 0) + (workBody.deliveriesAttempted ?? 0)).toBeGreaterThan(
      0,
    );

    await pollUntil('platform monetary transition + outbound delivered', async () => {
      const store = await h.paymentRepo.getStore();
      const p = store.payments.find((x) => x.id === created.id);
      if (!p || p.status !== 'succeeded' || p.capturedMinor !== 99000) return false;
      const delivered = store.webhookDeliveries.some(
        (d) => d.status === 'delivered' && d.attempts >= 1,
      );
      return delivered && received.length >= 1;
    });

    const finalPay = (await h.paymentRepo.getStore()).payments.find(
      (x) => x.id === created.id,
    )!;
    expect(finalPay.status).toBe('succeeded');
    expect(finalPay.capturedMinor).toBe(99000);

    for (const r of received) {
      assertNoProviderLeak(r.body);
      const payload = r.body as { type?: string; data?: { id?: string } };
      expect(payload.type).toBe('payment.updated');
      expect(payload.data?.id).toBe(created.id);
    }

    // Additional duplicate/stale/invalid-HMAC via direct platform HTTP (allowed).
    const dupBody = JSON.stringify({
      id: 'evt_sock_dup',
      type: 'payment',
      data: {
        payment: {
          id: providerPaymentId,
          status: 'SUCCEEDED',
          sub_status: 'APPROVED',
          amount: { currency: 'COP', value: 990, captured: 990, refunded: 0 },
        },
      },
    });
    const dupSig = signYunoWebhookBody(dupBody, HMAC);
    await fetch(`${h.platformBaseUrl}/internal/webhooks/yuno`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': dupSig,
      },
      body: dupBody,
    });
    await fetch(`${h.platformBaseUrl}/internal/webhooks/yuno`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': dupSig,
      },
      body: dupBody,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(
      (await h.paymentRepo.getStore()).payments.find((x) => x.id === created.id)!
        .status,
    ).toBe('succeeded');

    const staleBody = JSON.stringify({
      id: 'evt_sock_stale',
      type: 'payment',
      data: {
        payment: {
          id: providerPaymentId,
          status: 'PENDING',
          sub_status: 'IN_PROCESS',
          amount: { currency: 'COP', value: 990, captured: 0, refunded: 0 },
        },
      },
    });
    const staleSig = signYunoWebhookBody(staleBody, HMAC);
    await fetch(`${h.platformBaseUrl}/internal/webhooks/yuno`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': staleSig,
      },
      body: staleBody,
    });
    await new Promise((r) => setTimeout(r, 30));
    const afterStale = (await h.paymentRepo.getStore()).payments.find(
      (x) => x.id === created.id,
    )!;
    expect(afterStale.status).toBe('succeeded');
    expect(afterStale.capturedMinor).toBe(99000);

    const beforeBad = await h.paymentRepo.getStore();
    const bad = await fetch(`${h.platformBaseUrl}/internal/webhooks/yuno`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hmac-signature': 'invalid-sig',
      },
      body: JSON.stringify({
        id: 'evt_sock_bad',
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
    const afterBad = await h.paymentRepo.getStore();
    expect(afterBad.payments.find((x) => x.id === created.id)!.status).toBe(
      beforeBad.payments.find((x) => x.id === created.id)!.status,
    );
    expect(afterBad.providerEvents.length).toBe(beforeBad.providerEvents.length);
  });
});
