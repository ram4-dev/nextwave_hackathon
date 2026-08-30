import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  ISO_4217_EXPONENT_SOURCE,
  majorToMinor,
  minorToMajor,
} from '../src/domain/payments/currency.js';
import {
  isPublicPaymentSuccess,
  mapYunoPaymentStatus,
} from '../src/providers/yuno/state-mapper.js';
import {
  DeterministicDevAuthorizationVerifier,
  FailClosedAuthorizationVerifier,
} from '../src/domain/authorization/verifier.js';
import {
  encryptSecret,
  decryptSecret,
  DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX,
  parseSecretsKey,
} from '../src/crypto/secrets-at-rest.js';
import {
  assertPublicSafe,
  canonicalBodyHash,
  deriveProviderIdempotencyKey,
  PaymentError,
  redactSensitive,
} from '../src/domain/payments/helpers.js';
import { signYunoWebhookBody } from '../src/providers/yuno/webhook-verifier.js';
import { MemoryPaymentRepository } from '../src/persistence/payments/memory.js';
import { PaymentService } from '../src/services/payments/payment-service.js';
import { YunoAdapter } from '../src/providers/yuno/yuno-adapter.js';
import { YunoHttpClient } from '../src/providers/yuno/yuno-http-client.js';

describe('currency mapping (ISO-4217 exponents)', () => {
  it('documents SIX ISO-4217 source and uses exponents (not /100)', () => {
    expect(ISO_4217_EXPONENT_SOURCE).toMatch(/SIX/);
    expect(currencyExponent('COP')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });

  it('converts COP/USD/JPY/KWD via exponent', () => {
    expect(minorToMajor(125000, 'COP')).toBe(1250);
    expect(majorToMinor(1250, 'COP')).toBe(125000);
    expect(minorToMajor(199, 'USD')).toBe(1.99);
    expect(majorToMinor(1.99, 'USD')).toBe(199);
    expect(minorToMajor(500, 'JPY')).toBe(500);
    expect(majorToMinor(500, 'JPY')).toBe(500);
    expect(minorToMajor(1234, 'KWD')).toBe(1.234);
    expect(majorToMinor(1.234, 'KWD')).toBe(1234);
  });
});

describe('state mapping', () => {
  it('never treats PENDING or AUTHORIZED as success', () => {
    expect(mapYunoPaymentStatus({ status: 'PENDING', sub_status: 'IN_PROCESS' })).toBe(
      'processing',
    );
    expect(
      mapYunoPaymentStatus({ status: 'PENDING', sub_status: 'WAITING_ADDITIONAL_STEP' }),
    ).toBe('requires_user_action');
    expect(mapYunoPaymentStatus({ status: 'AUTHORIZED', sub_status: 'AUTHORIZED' })).toBe(
      'authorized',
    );
    expect(mapYunoPaymentStatus({ status: 'PENDING', sub_status: 'AUTHORIZED' })).toBe(
      'authorized',
    );
    expect(isPublicPaymentSuccess('processing')).toBe(false);
    expect(isPublicPaymentSuccess('authorized')).toBe(false);
    expect(isPublicPaymentSuccess('succeeded')).toBe(true);
  });
});

describe('AuthorizationVerifier', () => {
  it('fail-closed production verifier rejects', async () => {
    const v = new FailClosedAuthorizationVerifier();
    const r = await v.verify({
      authorizationId: 'authz_anything',
      actorId: 'prin_1',
      amount: { currency: 'COP', value_minor: 100 },
    });
    expect(r.ok).toBe(false);
  });

  it('dev verifier accepts authz_ prefix', async () => {
    const v = new DeterministicDevAuthorizationVerifier();
    const r = await v.verify({
      authorizationId: 'authz_test_1',
      actorId: 'prin_abc',
      amount: { currency: 'COP', value_minor: 100 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.principalId).toBe('prin_abc');
  });
});

describe('secret redaction and encryption', () => {
  it('encrypts and decrypts vaulted tokens with AES-256-GCM', () => {
    const key = parseSecretsKey(DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX);
    const blob = encryptSecret('token_secret_value', key);
    expect(blob.ciphertext).not.toContain('token_secret');
    expect(decryptSecret(blob, key)).toBe('token_secret_value');
  });

  it('redacts sensitive keys and rejects unsafe public payloads', () => {
    const redacted = redactSensitive({
      vaulted_token: 'abc',
      pan: '4111',
      ok: true,
    }) as Record<string, unknown>;
    expect(redacted.vaulted_token).toBe('[REDACTED]');
    expect(redacted.pan).toBe('[REDACTED]');
    expect(() => assertPublicSafe({ vaulted_token: 'x' })).toThrow(PaymentError);
  });
});

describe('idempotency helpers', () => {
  it('hashes canonical bodies stably and derives UUID provider keys', () => {
    expect(canonicalBodyHash({ b: 1, a: 2 })).toBe(canonicalBodyHash({ a: 2, b: 1 }));
    expect(canonicalBodyHash({ a: 1 })).not.toBe(canonicalBodyHash({ a: 2 }));
    const key = deriveProviderIdempotencyKey('pay:test');
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(deriveProviderIdempotencyKey('pay:test')).toBe(key);
  });
});

describe('webhook HMAC + PaymentService verify', () => {
  it('rejects invalid HMAC with zero mutation path', async () => {
    const secret = 'test_hmac_secret';
    const raw = JSON.stringify({ id: 'evt_1', data: { payment: { id: 'p1' } } });
    const repo = new MemoryPaymentRepository();
    const client = new YunoHttpClient({
      baseUrl: 'http://127.0.0.1:9',
      publicApiKey: 'pk',
      privateSecretKey: 'sk',
      fetchImpl: async () => new Response('{}', { status: 500 }),
    });
    const adapter = new YunoAdapter(client, {
      accountId: '00000000-0000-4000-8000-000000000001',
      baseUrl: 'http://127.0.0.1:9',
      secretsKey: parseSecretsKey(DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX),
    });
    const service = new PaymentService({
      repo,
      adapter,
      authz: new FailClosedAuthorizationVerifier(),
      webhookHmacSecret: secret,
      accountId: '00000000-0000-4000-8000-000000000001',
    });

    expect(() => service.verifyInboundWebhook(raw, 'bad-sig')).toThrow(PaymentError);
    const before = await repo.getStore();
    expect(before.providerEvents).toHaveLength(0);

    const good = signYunoWebhookBody(raw, secret);
    service.verifyInboundWebhook(raw, good);
  });
});
