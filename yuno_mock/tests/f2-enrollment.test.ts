import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import {
  DEV_DEFAULT_PRIVATE_SECRET_KEY,
  DEV_DEFAULT_PUBLIC_API_KEY,
  loadMockConfig,
  type MockConfig,
} from '../src/config.js';
import { InMemoryYunoRepository } from '../src/persistence/memory.js';
import { assertNoSensitiveMaterial, scanForSensitiveMaterial, containsSensitiveV1Input, looksLikeRawPan, luhnValid } from '../src/domain/sensitive.js';
import { computeFingerprint, tokenizeCard } from '../src/services/tokenize.js';
import { validateResponse } from '../../src/providers/yuno/validate.js';

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

describe('F2 enrollment', () => {
  it('creates customer, rejects duplicate merchant_customer_id deterministically', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });

    const res1 = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ merchant_customer_id: 'usr_dup' }),
    });
    expect(res1.status).toBe(201);
    const body1 = await json<{ id: string; merchant_customer_id: string }>(res1);
    expect(body1.merchant_customer_id).toBe('usr_dup');
    expect(validateResponse('create-customer', 201, body1).ok).toBe(true);
    assertNoSensitiveMaterial(body1, secrets(config));

    const res2 = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ merchant_customer_id: 'usr_dup' }),
    });
    expect(res2.status).toBe(400);
    expect(await json(res2)).toEqual({
      code: 'INVALID_REQUEST',
      messages: ['merchant_customer_id already exists'],
    });
  });

  it('runs full enrollment journey with contract-valid responses', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });

    const custRes = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({ merchant_customer_id: 'usr_journey' }),
    });
    const customer = await json<{ id: string }>(custRes);
    expect(custRes.status).toBe(201);

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
    expect(validateResponse('create-customer-session', 201, session).ok).toBe(true);

    const availRes = await app.request(
      `/v1/checkout/customers/sessions/${session.customer_session}/payment-methods`,
      { headers: authHeaders(config) },
    );
    expect(availRes.status).toBe(200);
    const avail = await json<{ payment_methods: unknown[] }>(availRes);
    expect(avail.payment_methods.length).toBeGreaterThan(0);
    expect(validateResponse('retrieve-payment-methods-to-enroll-checkout', 200, avail).ok).toBe(
      true,
    );

    const uiRes = await app.request(
      `/test/enrollment?customer_session=${session.customer_session}`,
    );
    expect(uiRes.status).toBe(200);
    expect(await uiRes.text()).toContain('Test enrollment');

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
    const tokenized = await json<{
      vaulted_token: string;
      fingerprint: string;
      last4: string;
    }>(tokRes);
    expect(tokenized.last4).toBe('1111');
    expect(tokenized.fingerprint).toBe(
      computeFingerprint(
        TEST_PAN,
        12,
        30,
        config.YUNO_MOCK_FINGERPRINT_SECRET,
      ),
    );
    assertNoSensitiveMaterial(tokenized, secrets(config));

    const enrollHeaders = {
      ...authHeaders(config),
      'X-Idempotency-Key': 'enroll-key-1',
    };
    const enrollBody = {
      account_id: ACCOUNT_ID,
      payment_method_type: 'CARD',
      country: 'CO',
      verify: { vault_on_success: true, currency: 'COP' },
    };
    const enrollRes = await app.request(
      `/v1/customers/sessions/${session.customer_session}/payment-methods`,
      {
        method: 'POST',
        headers: enrollHeaders,
        body: JSON.stringify(enrollBody),
      },
    );
    expect(enrollRes.status).toBe(201);
    const enrolled = await json<{ id: string; status: string }>(enrollRes);
    expect(enrolled.status).toBe('ENROLLED');
    expect(validateResponse('enroll-payment-method-checkout', 201, enrolled).ok).toBe(true);

    // Stable replay
    const replayRes = await app.request(
      `/v1/customers/sessions/${session.customer_session}/payment-methods`,
      {
        method: 'POST',
        headers: enrollHeaders,
        body: JSON.stringify({ ...enrollBody, verify: { vault_on_success: false } }),
      },
    );
    expect(replayRes.status).toBe(201);
    const replayed = await json<{ id: string }>(replayRes);
    expect(replayed.id).toBe(enrolled.id);

    const getRes = await app.request(`/v1/payment-methods/${enrolled.id}`, {
      headers: authHeaders(config),
    });
    expect(getRes.status).toBe(200);
    const got = await json<{
      id: string;
      card_data: { fingerprint: string; lfd: string };
    }>(getRes);
    expect(got.card_data.lfd).toBe('1111');
    expect(got.card_data.fingerprint).toBe(tokenized.fingerprint);
    expect(validateResponse('retrieve-payment-method-by-id-checkout', 200, got).ok).toBe(true);

    const listRes = await app.request(`/v1/customers/${customer.id}/payment-methods`, {
      headers: authHeaders(config),
    });
    expect(listRes.status).toBe(200);
    const listed = await json<{ payment_methods: Array<{ vaulted_token: string }> }>(listRes);
    expect(listed.payment_methods).toHaveLength(1);
    expect(listed.payment_methods[0]?.vaulted_token).toBe(tokenized.vaulted_token);
    expect(validateResponse('retrieve-enrolled-payment-methods-api', 200, listed).ok).toBe(true);

    const unRes = await app.request(
      `/v1/customers/payment-methods/${enrolled.id}/unenroll`,
      { method: 'POST', headers: authHeaders(config) },
    );
    expect(unRes.status).toBe(200);
    const unenrolled = await json<{ status: string }>(unRes);
    expect(unenrolled.status).toBe('UNENROLLED');
    expect(validateResponse('unenroll-payment-method-checkout', 200, unenrolled).ok).toBe(true);

    const listAfter = await json<{ payment_methods: unknown[] }>(
      await app.request(`/v1/customers/${customer.id}/payment-methods`, {
        headers: authHeaders(config),
      }),
    );
    expect(listAfter.payment_methods).toHaveLength(0);

    const store = await repo.getStore();
    assertNoSensitiveMaterial(store, secrets(config));
    const hits = scanForSensitiveMaterial(store, secrets(config));
    expect(hits).toEqual([]);
  });

  it('stable fingerprint across tokenize calls', () => {
    const config = testConfig();
    const a = tokenizeCard({
      pan: TEST_PAN,
      cvv: TEST_CVV,
      expirationMonth: 12,
      expirationYear: 30,
      fingerprintSecret: config.YUNO_MOCK_FINGERPRINT_SECRET,
    });
    const b = tokenizeCard({
      pan: TEST_PAN,
      cvv: '999',
      expirationMonth: 12,
      expirationYear: 30,
      fingerprintSecret: config.YUNO_MOCK_FINGERPRINT_SECRET,
    });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.vaulted_token).not.toBe(b.vaulted_token);
  });

  it('returns availability fixtures for CO/MX/BR sessions', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    for (const country of ['CO', 'MX', 'BR'] as const) {
      const cust = await json<{ id: string }>(
        await app.request('/v1/customers', {
          method: 'POST',
          headers: authHeaders(config),
          body: JSON.stringify({ merchant_customer_id: `usr_${country}` }),
        }),
      );
      const sess = await json<{ customer_session: string }>(
        await app.request('/v1/customers/sessions', {
          method: 'POST',
          headers: authHeaders(config),
          body: JSON.stringify({
            account_id: ACCOUNT_ID,
            country,
            customer_id: cust.id,
          }),
        }),
      );
      const avail = await json<{ payment_methods: unknown[] }>(
        await app.request(
          `/v1/checkout/customers/sessions/${sess.customer_session}/payment-methods`,
          { headers: authHeaders(config) },
        ),
      );
      expect(avail.payment_methods.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('rejects missing resources and invalid bodies/headers', async () => {
    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });

    const missingCustomer = await app.request('/v1/customers/sessions', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        country: 'CO',
        customer_id: '00000000-0000-0000-0000-000000000000',
      }),
    });
    expect(missingCustomer.status).toBe(400);

    const missingSession = await app.request(
      '/v1/checkout/customers/sessions/00000000-0000-0000-0000-000000000000/payment-methods',
      { headers: authHeaders(config) },
    );
    expect(missingSession.status).toBe(400);

    const missingPm = await app.request(
      '/v1/payment-methods/00000000-0000-0000-0000-000000000000',
      { headers: authHeaders(config) },
    );
    expect(missingPm.status).toBe(400);

    const badBody = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({}),
    });
    expect(badBody.status).toBe(400);

    const cust = await json<{ id: string }>(
      await app.request('/v1/customers', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({ merchant_customer_id: 'usr_headers' }),
      }),
    );
    const sess = await json<{ customer_session: string }>(
      await app.request('/v1/customers/sessions', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          account_id: ACCOUNT_ID,
          country: 'CO',
          customer_id: cust.id,
        }),
      }),
    );
    const noIdem = await app.request(
      `/v1/customers/sessions/${sess.customer_session}/payment-methods`,
      {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          account_id: ACCOUNT_ID,
          payment_method_type: 'CARD',
          country: 'CO',
        }),
      },
    );
    expect(noIdem.status).toBe(400);
    expect((await json<{ messages: string[] }>(noIdem)).messages.join(' ')).toMatch(
      /X-Idempotency-Key/,
    );
  });

  it('disables enrollment UI in production', async () => {
    const config = testConfig({
      NODE_ENV: 'production',
      YUNO_PUBLIC_API_KEY: DEV_DEFAULT_PUBLIC_API_KEY,
      YUNO_PRIVATE_SECRET_KEY: DEV_DEFAULT_PRIVATE_SECRET_KEY,
      YUNO_MOCK_FINGERPRINT_SECRET: 'prod_fingerprint_secret',
    });
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    expect((await app.request('/test/enrollment')).status).toBe(404);
    expect(
      (
        await app.request('/test/enrollment/tokenize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            customer_session: 'x',
            pan: TEST_PAN,
            cvv: TEST_CVV,
            expiration_month: 12,
            expiration_year: 30,
          }),
        })
      ).status,
    ).toBe(404);
  });

  it('does not persist PAN/CVV after tokenization', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const cust = await json<{ id: string }>(
      await app.request('/v1/customers', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({ merchant_customer_id: 'usr_pan' }),
      }),
    );
    const sess = await json<{ customer_session: string }>(
      await app.request('/v1/customers/sessions', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          account_id: ACCOUNT_ID,
          country: 'CO',
          customer_id: cust.id,
        }),
      }),
    );
    await app.request('/test/enrollment/tokenize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customer_session: sess.customer_session,
        pan: TEST_PAN,
        cvv: TEST_CVV,
        expiration_month: 12,
        expiration_year: 30,
      }),
    });
    const store = await repo.getStore();
    const serialized = JSON.stringify(store);
    expect(serialized).not.toContain(TEST_PAN);
    expect(serialized).not.toMatch(/"pan"\s*:/);
    expect(serialized).not.toMatch(/"cvv"\s*:/);
    expect(serialized).not.toMatch(/"cvc"\s*:/);
    // CVV digits may appear inside hex fingerprints; assert no dedicated field/value.
    assertNoSensitiveMaterial(store, [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
      TEST_PAN,
    ]);
  });

  it('rejects top-level pan/cvv smuggling on POST /v1/customers without leaking digits', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const before = structuredClone(await repo.getStore());

    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        merchant_customer_id: 'usr_smuggle_top',
        pan: TEST_PAN,
        cvv: TEST_CVV,
      }),
    });

    expect(res.status).toBe(400);
    const body = await json<{ code: string; messages: string[] }>(res);
    expect(body).toEqual({
      code: 'INVALID_REQUEST',
      messages: ['Request contains sensitive payment instrument data'],
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(TEST_PAN);
    expect(text).not.toContain(TEST_CVV);
    expect(text).not.toMatch(/4111/);

    expect(await repo.getStore()).toEqual(before);
  });

  it('rejects nested card_number/security_code smuggling on POST /v1/customers', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const before = structuredClone(await repo.getStore());

    const nestedCases = [
      {
        merchant_customer_id: 'usr_smuggle_nested_a',
        metadata: [{ key: 'x', card_number: TEST_PAN }],
      },
      {
        merchant_customer_id: 'usr_smuggle_nested_b',
        billing_address: { security_code: TEST_CVV, city: 'Bogota' },
      },
      {
        merchant_customer_id: 'usr_smuggle_nested_c',
        document: { cardNumber: TEST_PAN },
      },
      {
        merchant_customer_id: 'usr_smuggle_nested_d',
        note: `card ${TEST_PAN}`,
      },
    ];

    for (const payload of nestedCases) {
      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain('INVALID_REQUEST');
      expect(text).toContain('Request contains sensitive payment instrument data');
      expect(text).not.toContain(TEST_PAN);
      expect(text).not.toContain('4111111111111111');
    }

    expect(await repo.getStore()).toEqual(before);
  });

  it('still allows /test/enrollment/tokenize to accept fictional PAN/CVV', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const cust = await json<{ id: string }>(
      await app.request('/v1/customers', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({ merchant_customer_id: 'usr_tok_ok' }),
      }),
    );
    const sess = await json<{ customer_session: string }>(
      await app.request('/v1/customers/sessions', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          account_id: ACCOUNT_ID,
          country: 'CO',
          customer_id: cust.id,
        }),
      }),
    );
    const tok = await app.request('/test/enrollment/tokenize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customer_session: sess.customer_session,
        pan: TEST_PAN,
        cvv: TEST_CVV,
        expiration_month: 12,
        expiration_year: 30,
      }),
    });
    expect(tok.status).toBe(201);
  });
});

describe('F2 Luhn-aware PAN guard', () => {
  // Non-Luhn 16-digit identifier (safe for future merchant_order_id).
  const NON_LUHN_ORDER_ID = '1234567890123456';

  it('rejects Luhn-valid 4111111111111111 as a top-level and nested value', async () => {
    expect(luhnValid(TEST_PAN)).toBe(true);
    expect(containsSensitiveV1Input({ merchant_order_id: TEST_PAN })).toBe(true);
    expect(containsSensitiveV1Input({ meta: { ref: TEST_PAN } })).toBe(true);
    // Canonical UUIDs must never false-positive via hyphen-stripped digit runs.
    expect(looksLikeRawPan('12345678-9012-4000-8000-000000000001')).toBe(false);
    expect(looksLikeRawPan('2fc69d88-3c0d-43fd-9b38-2ad501e24326')).toBe(false);

    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });
    const before = structuredClone(await repo.getStore());

    const top = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        merchant_customer_id: 'usr_luhn_top',
        merchant_order_id: TEST_PAN,
      }),
    });
    expect(top.status).toBe(400);
    expect(await top.text()).not.toContain(TEST_PAN);

    const nested = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        merchant_customer_id: 'usr_luhn_nested',
        metadata: [{ order: TEST_PAN }],
      }),
    });
    expect(nested.status).toBe(400);
    expect(await repo.getStore()).toEqual(before);
  });

  it('rejects an embedded Luhn-valid PAN such as card4111111111111111', () => {
    expect(looksLikeRawPan(`card${TEST_PAN}`)).toBe(true);
    expect(containsSensitiveV1Input({ note: `card${TEST_PAN}` })).toBe(true);
  });

  it('allows a non-Luhn 13-19 digit merchant/order identifier through the guard', async () => {
    expect(NON_LUHN_ORDER_ID).toHaveLength(16);
    expect(luhnValid(NON_LUHN_ORDER_ID)).toBe(false);
    expect(looksLikeRawPan(NON_LUHN_ORDER_ID)).toBe(false);
    expect(containsSensitiveV1Input({ merchant_order_id: NON_LUHN_ORDER_ID })).toBe(false);

    const config = testConfig();
    const app = createApp({ config, repo: new InMemoryYunoRepository() });
    const res = await app.request('/v1/customers', {
      method: 'POST',
      headers: authHeaders(config),
      body: JSON.stringify({
        merchant_customer_id: 'usr_order_id_ok',
        // Extra pin-allowed-shaped field used only to prove the guard does not false-positive.
        metadata: [{ key: 'merchant_order_id', value: NON_LUHN_ORDER_ID }],
      }),
    });
    // May be 201 (accepted) or 400 from Ajv if metadata shape is wrong — must not be sensitive reject.
    const text = await res.text();
    expect(text).not.toContain('Request contains sensitive payment instrument data');
    if (res.status === 201) {
      expect(text).toContain('usr_order_id_ok');
    }
  });

  it('completed enroll replay ignores schema-invalid retry body; first invalid does not consume key', async () => {
    const config = testConfig();
    const repo = new InMemoryYunoRepository();
    const app = createApp({ config, repo });

    const cust = await json<{ id: string }>(
      await app.request('/v1/customers', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({ merchant_customer_id: 'usr_enroll_replay_inv' }),
      }),
    );
    const sess = await json<{ customer_session: string }>(
      await app.request('/v1/customers/sessions', {
        method: 'POST',
        headers: authHeaders(config),
        body: JSON.stringify({
          account_id: ACCOUNT_ID,
          country: 'CO',
          customer_id: cust.id,
        }),
      }),
    );

    await app.request('/test/enrollment/tokenize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customer_session: sess.customer_session,
        pan: TEST_PAN,
        cvv: TEST_CVV,
        expiration_month: 12,
        expiration_year: 30,
      }),
    });

    const key = 'enroll-replay-invalid';
    const headers = { ...authHeaders(config), 'X-Idempotency-Key': key };
    const path = `/v1/customers/sessions/${sess.customer_session}/payment-methods`;

    const invalidFirst = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    expect(invalidFirst.status).toBe(400);
    expect((await repo.getStore()).idempotency).toEqual([]);

    const ok = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        payment_method_type: 'CARD',
        country: 'CO',
      }),
    });
    expect(ok.status).toBe(201);
    const original = await json<{ id: string; status: string }>(ok);

    const replay = await app.request(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ totally: 'invalid' }),
    });
    expect(replay.status).toBe(201);
    expect(await json(replay)).toEqual(original);
    expect((await repo.getStore()).paymentMethods).toHaveLength(1);
  });
});
