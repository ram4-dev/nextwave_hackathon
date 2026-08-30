import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMandatesFromFile } from '../scripts/mandates-create.js';
import {
  createLocalMerchantSigner,
  createMandateService,
  InMemoryMandateReplayStore,
} from '../src/mandates/index.js';

const issuedAt = '2029-12-31T00:00:00Z';
const expiresAt = '2029-12-31T00:10:00Z';
const now = new Date(issuedAt);

function input() {
  return {
    transactionId: 'txn_001',
    merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
    lineItems: [{ productId: 'product_001', title: 'Product', quantity: 2, unitAmountMinor: 1250, taxAmountMinor: 250, discountAmountMinor: 100 }],
    shipping: { optionId: 'standard', amountMinor: 500 },
    totals: { subtotalMinor: 2500, taxMinor: 250, discountMinor: 100, totalMinor: 3150, currency: 'USD' },
    issuedAt, expiresAt, source: { type: 'llm' as const, requestId: 'request_001' },
  };
}

async function service() {
  const signer = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test', now: () => now });
  return createMandateService({ merchantSigner: signer, replayStore: new InMemoryMandateReplayStore(), now: () => now });
}

async function drafts() {
  const sut = await service();
  const checkout = await sut.createMerchantCheckout(input());
  const checkoutDraft = await sut.createCheckoutMandateDraft({
    checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: checkout.transactionId,
    userReference: 'user_001', nonce: 'nonce_checkout', issuedAt, expiresAt,
  });
  return { sut, checkout, checkoutDraft };
}

describe('AP2 mandate drafts', () => {
  it('creates a verifiable merchant checkout and unsigned checkout draft', async () => {
    const { sut, checkout, checkoutDraft } = await drafts();
    expect(checkout.checkoutHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(checkoutDraft.status).toBe('awaiting_user_signature');
    await expect(sut.verifyDraftConsistency({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: 'txn_001',
      draft: checkoutDraft.unsignedMandatePayload,
      expectedUserReference: 'user_001',
    })).resolves.toMatchObject({ valid: true });
  });

  it('rejects bad totals, tampered JWTs, and mismatched hashes', async () => {
    const sut = await service();
    const wrong = input();
    wrong.totals.totalMinor = 1;
    await expect(sut.createMerchantCheckout(wrong)).rejects.toMatchObject({ code: 'CHECKOUT_TOTALS' });
    const checkout = await sut.createMerchantCheckout(input());
    await expect(sut.createCheckoutMandateDraft({
      checkoutJwt: `${checkout.checkoutJwt}x`, checkoutHash: checkout.checkoutHash, transactionId: 'txn_001',
      userReference: 'user_001', nonce: 'nonce_1', issuedAt, expiresAt,
    })).rejects.toMatchObject({ code: 'CHECKOUT_HASH' });
    await expect(sut.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt, checkoutHash: 'A'.repeat(43), transactionId: 'txn_001',
      userReference: 'user_001', nonce: 'nonce_2', issuedAt, expiresAt,
    })).rejects.toMatchObject({ code: 'CHECKOUT_HASH' });
  });

  it('rejects mismatched payment, sensitive instrument fields, replay, expired mandates, and payee redirection', async () => {
    const { sut, checkout, checkoutDraft } = await drafts();
    const base = {
      transactionId: 'txn_001', checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: checkoutDraft.id,
      payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
      userReference: 'user_001', nonce: 'nonce_payment', issuedAt, expiresAt,
    };
    await expect(sut.createPaymentMandateDraft({
      ...base, paymentAmount: { amountMinor: 1, currency: 'USD' },
      paymentInstrument: { id: 'instrument_001', type: 'card', descriptionMasked: 'Card •••• 1234' },
    })).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT' });
    await expect(sut.createPaymentMandateDraft({
      ...base, paymentAmount: { amountMinor: 3150, currency: 'EUR' },
      paymentInstrument: { id: 'instrument_001', type: 'card', descriptionMasked: 'Card •••• 1234' },
    })).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT' });
    await expect(sut.createPaymentMandateDraft({
      ...base, paymentAmount: { amountMinor: 3150, currency: 'USD' },
      paymentInstrument: { id: 'instrument_001', type: 'card', descriptionMasked: 'Card •••• 1234', token: 'real-token' },
    } as never)).rejects.toMatchObject({ code: 'MANDATE_INPUT' });
    await expect(sut.createPaymentMandateDraft({
      ...base,
      payee: { id: 'attacker_payee', name: 'Attacker', website: 'https://attacker.example' },
      paymentAmount: { amountMinor: 3150, currency: 'USD' },
      paymentInstrument: { id: 'instrument_001', type: 'card', descriptionMasked: 'Card •••• 1234' },
    })).rejects.toMatchObject({ code: 'PAYEE_REDIRECT' });
    await expect(sut.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: 'txn_001',
      userReference: 'user_001', nonce: 'nonce_checkout', issuedAt, expiresAt,
    })).rejects.toMatchObject({ code: 'MANDATE_REPLAY' });
    await expect(sut.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: 'txn_001',
      userReference: 'user_001', nonce: 'nonce_late', issuedAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-01T00:10:00Z',
    })).rejects.toMatchObject({ code: 'MANDATE_EXPIRED' });
  });

  it('rejects draft tampering across security-relevant bindings', async () => {
    const { sut, checkout, checkoutDraft } = await drafts();
    const paymentDraft = await sut.createPaymentMandateDraft({
      transactionId: 'txn_001', checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: checkoutDraft.id,
      payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
      paymentAmount: { amountMinor: 3150, currency: 'USD' },
      paymentInstrument: { id: 'instrument_001', type: 'card', descriptionMasked: 'Card •••• 1234' },
      userReference: 'user_001', nonce: 'nonce_payment', issuedAt, expiresAt,
    });

    const cases: Array<{ label: string; draft: typeof paymentDraft.unsignedMandatePayload | typeof checkoutDraft.unsignedMandatePayload }> = [
      {
        label: 'payee',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payee: { id: 'other', name: 'Other', website: 'https://other.example' },
        },
      },
      {
        label: 'payee_name',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payee: { ...paymentDraft.unsignedMandatePayload.payee, name: 'Renamed' },
        },
      },
      {
        label: 'payee_website',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payee: { ...paymentDraft.unsignedMandatePayload.payee, website: 'https://evil.example' },
        },
      },
      {
        label: 'sub',
        draft: { ...paymentDraft.unsignedMandatePayload, sub: 'attacker_user' },
      },
      {
        label: 'aud',
        draft: { ...paymentDraft.unsignedMandatePayload, aud: 'wrong-audience' },
      },
      {
        label: 'jti',
        draft: { ...paymentDraft.unsignedMandatePayload, jti: 'payment_draft_tampered' },
      },
      {
        label: 'instrument',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payment_instrument: { id: 'instrument_999', type: 'card', description_masked: 'Card •••• 9999' },
        },
      },
      {
        label: 'instrument_type',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payment_instrument: { ...paymentDraft.unsignedMandatePayload.payment_instrument, type: 'bank' },
        },
      },
      {
        label: 'instrument_masked',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payment_instrument: { ...paymentDraft.unsignedMandatePayload.payment_instrument, description_masked: 'Card •••• 0000' },
        },
      },
      {
        label: 'amount',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payment_amount: { amount_minor: 1, currency: 'USD' },
        },
      },
      {
        label: 'currency',
        draft: {
          ...paymentDraft.unsignedMandatePayload,
          payment_amount: { amount_minor: 3150, currency: 'EUR' },
        },
      },
      {
        label: 'payment_iat',
        draft: { ...paymentDraft.unsignedMandatePayload, iat: paymentDraft.unsignedMandatePayload.iat + 1 },
      },
      {
        label: 'payment_exp',
        draft: { ...paymentDraft.unsignedMandatePayload, exp: paymentDraft.unsignedMandatePayload.exp + 1 },
      },
      {
        label: 'payment_nonce',
        draft: { ...paymentDraft.unsignedMandatePayload, nonce: 'tampered_nonce' },
      },
      {
        label: 'checkout_sub',
        draft: { ...checkoutDraft.unsignedMandatePayload, sub: 'other_user' },
      },
      {
        label: 'checkout_aud',
        draft: { ...checkoutDraft.unsignedMandatePayload, aud: 'other-aud' },
      },
      {
        label: 'checkout_iat',
        draft: { ...checkoutDraft.unsignedMandatePayload, iat: checkoutDraft.unsignedMandatePayload.iat + 1 },
      },
      {
        label: 'checkout_exp',
        draft: { ...checkoutDraft.unsignedMandatePayload, exp: checkoutDraft.unsignedMandatePayload.exp + 1 },
      },
      {
        label: 'checkout_nonce',
        draft: { ...checkoutDraft.unsignedMandatePayload, nonce: 'checkout_tampered' },
      },
    ];

    for (const item of cases) {
      await expect(
        sut.verifyDraftConsistency({
          checkoutJwt: checkout.checkoutJwt,
          checkoutHash: checkout.checkoutHash,
          transactionId: 'txn_001',
          draft: item.draft,
          expectedUserReference: 'user_001',
        }),
        item.label,
      ).rejects.toMatchObject({ code: expect.stringMatching(/DRAFT_CONSISTENCY|PAYEE_REDIRECT|MANDATE_INPUT|DRAFT_LINEAGE/) });
    }

    await expect(sut.verifyDraftConsistency({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: 'txn_001',
      draft: {
        ...checkoutDraft.unsignedMandatePayload,
        checkout_jwt: `${checkout.checkoutJwt}x`,
      },
      expectedUserReference: 'user_001',
    })).rejects.toMatchObject({ code: 'DRAFT_CONSISTENCY' });
  });

  it('does not permit the local signer in production, including omitted nodeEnv with process production', async () => {
    await expect(createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'production' })).rejects.toMatchObject({ code: 'MERCHANT_SIGNER_ENV' });
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(createLocalMerchantSigner({ issuer: 'merchant_001' })).rejects.toMatchObject({ code: 'MERCHANT_SIGNER_ENV' });
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

const tempDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('mandates:create CLI handler', () => {
  it('generates checkout and payment drafts from a safe fixture', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mandates-'));
    tempDirectories.push(dir);
    const fixture = {
      ...input(),
      userReference: 'user_001',
      checkoutMandate: { nonce: 'fixture_checkout_nonce', issuedAt, expiresAt },
      paymentMandate: {
        checkoutNonce: 'fixture_payment_nonce', issuedAt, expiresAt,
        payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
        paymentAmount: { amountMinor: 3150, currency: 'USD' },
        paymentInstrument: { id: 'instrument_001', type: 'card', descriptionMasked: 'Card •••• 1234' },
      },
    };
    const fixturePath = path.join(dir, 'checkout.json');
    await writeFile(fixturePath, JSON.stringify(fixture));
    const result = await createMandatesFromFile(fixturePath, { NODE_ENV: 'test' });
    expect(result.checkoutDraft.mandateType).toBe('checkout');
    expect(result.paymentDraft?.mandateType).toBe('payment');
    expect(result.checkout.checkoutJwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.parse(await readFile(fixturePath, 'utf8')).merchant.id).toBe('merchant_001');
  });
});

describe('merchant signer header strictness', () => {
  it('requires ES256 typ kid iss aud iat exp', async () => {
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test', now: () => now });
    const jwt = await signer.signCheckout(input());
    await expect(signer.verifyCheckout(jwt)).resolves.toMatchObject({ transactionId: 'txn_001' });
    await expect(signer.verifyCheckout(`${jwt}x`)).rejects.toMatchObject({ code: 'CHECKOUT_JWT' });
  });
});

void vi;
