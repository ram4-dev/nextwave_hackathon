import { createHash } from 'node:crypto';
import { CompactSign, exportJWK, generateKeyPair, calculateJwkThumbprint } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createLocalMerchantSigner,
  createMandateService,
  FakeMandateAnchorClient,
  InMemoryMandateAnchorOutbox,
  InMemoryMandateReplayStore,
  InMemoryMandateRequestStore,
  InMemoryOpenMandateRegistry,
  MandateAnchorWorker,
  receiveMandateRequest,
  verifyClosedMandateJws,
  type OpenMandateConstraints,
} from '../src/mandates/index.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const issuedAt = '2030-01-01T00:00:00.000Z';
const expiresAt = '2030-01-01T00:10:00.000Z';

function constraints(): OpenMandateConstraints {
  return {
    merchantIds: ['merchant_001'],
    payeeIds: ['merchant_001'],
    maxQuantityPerProduct: 10,
    minAmountMinor: 1,
    maxAmountMinor: 100,
    currency: 'USD',
    totalBudgetMinor: 100,
    maxOperations: 10,
    frequencyWindowSeconds: 3600,
    maxOperationsPerWindow: 10,
    paymentInstrumentAlias: 'instrument_1',
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

describe('pass3: outbox claim-token CAS', () => {
  it('ignores stale markFailed after a newer worker anchors', async () => {
    const outbox = new InMemoryMandateAnchorOutbox({ maxAttempts: 5, leaseMs: 20 });
    const evidence = {
      closedCheckoutHash: sha('c'),
      closedPaymentHash: sha('p'),
      checkoutHash: sha('checkout'),
      transactionIdHash: sha('txn'),
      agentIdHash: sha('agent'),
      policyVersionHash: sha('policy'),
      mandateType: 1,
    };
    await outbox.enqueue(evidence);

    const claim1 = await outbox.claimNext(now);
    expect(claim1?.status).toBe('processing');
    const token1 = claim1!.claimToken!;

    // Lease expires; W2 reclaims and anchors.
    const later = new Date(now.getTime() + 50);
    const claim2 = await outbox.claimNext(later);
    expect(claim2?.claimToken).not.toBe(token1);
    const anchored = await outbox.markAnchored(claim2!.id, `0x${'ab'.repeat(32)}`, claim2!.claimToken!, later);
    expect(anchored.status).toBe('anchored');

    // Stale W1 failure must not requeue or demote.
    const stale = await outbox.markFailed(claim1!.id, 'late failure', token1, new Date(later.getTime() + 1));
    expect(stale.status).toBe('anchored');
    expect(stale.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect((await outbox.get(claim1!.id)).status).toBe('anchored');
  });

  it('uses outbox maxAttempts as the sole public authority', async () => {
    await expect(() => new InMemoryMandateAnchorOutbox({ maxAttempts: 0 })).toThrow(/maxAttempts/);
    await expect(() => new InMemoryMandateAnchorOutbox({ leaseMs: -1 })).toThrow(/leaseMs/);

    const outbox = new InMemoryMandateAnchorOutbox({ maxAttempts: 2, leaseMs: 1 });
    const worker = new MandateAnchorWorker(outbox, {
      anchor: async () => { throw new Error('down'); },
    });
    await outbox.enqueue({
      closedCheckoutHash: sha('c3'),
      closedPaymentHash: sha('p3'),
      checkoutHash: sha('checkout'),
      transactionIdHash: sha('txn'),
      agentIdHash: sha('agent'),
      policyVersionHash: sha('policy'),
      mandateType: 1,
    });
    expect((await worker.processOnce())?.status).toBe('pending');
    expect((await worker.processOnce())?.status).toBe('failed');
  });
});

describe('pass3: strict closed JWS', () => {
  it('rejects missing/wrong kid, missing/wrong typ, altered payload, and invalid signature', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const publicKeyJwk = await exportJWK(publicKey);
    const payload = { vct: 'mandate.checkout.1', amount: 1 };
    const body = new TextEncoder().encode(JSON.stringify(payload));

    const missingKid = await new CompactSign(body).setProtectedHeader({ alg: 'ES256', typ: 'JWT' }).sign(privateKey);
    await expect(verifyClosedMandateJws({
      jws: missingKid, publicKeyJwk, expectedPayload: payload, expectedKeyId: 'agent-1',
    })).rejects.toMatchObject({ code: 'CLOSED_MANDATE_JWS' });

    const wrongKid = await new CompactSign(body).setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'other' }).sign(privateKey);
    await expect(verifyClosedMandateJws({
      jws: wrongKid, publicKeyJwk, expectedPayload: payload, expectedKeyId: 'agent-1',
    })).rejects.toMatchObject({ code: 'CLOSED_MANDATE_JWS' });

    const missingTyp = await new CompactSign(body).setProtectedHeader({ alg: 'ES256', kid: 'agent-1' }).sign(privateKey);
    await expect(verifyClosedMandateJws({
      jws: missingTyp, publicKeyJwk, expectedPayload: payload, expectedKeyId: 'agent-1',
    })).rejects.toMatchObject({ code: 'CLOSED_MANDATE_JWS' });

    const wrongTyp = await new CompactSign(body).setProtectedHeader({ alg: 'ES256', typ: 'JOSE', kid: 'agent-1' }).sign(privateKey);
    await expect(verifyClosedMandateJws({
      jws: wrongTyp, publicKeyJwk, expectedPayload: payload, expectedKeyId: 'agent-1',
    })).rejects.toMatchObject({ code: 'CLOSED_MANDATE_JWS' });

    const altered = await new CompactSign(new TextEncoder().encode(JSON.stringify({ ...payload, amount: 9 })))
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'agent-1' })
      .sign(privateKey);
    await expect(verifyClosedMandateJws({
      jws: altered, publicKeyJwk, expectedPayload: payload, expectedKeyId: 'agent-1',
    })).rejects.toMatchObject({ code: 'CLOSED_MANDATE_JWS' });

    const other = await generateKeyPair('ES256', { extractable: true });
    const badSig = await new CompactSign(body)
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: 'agent-1' })
      .sign(other.privateKey);
    await expect(verifyClosedMandateJws({
      jws: badSig, publicKeyJwk, expectedPayload: payload, expectedKeyId: 'agent-1',
    })).rejects.toMatchObject({ code: 'CLOSED_MANDATE_JWS' });
  });
});

describe('pass3: promptHash store boundary', () => {
  it('rejects plaintext under promptHash on InMemoryMandateRequestStore', async () => {
    const store = new InMemoryMandateRequestStore();
    await expect(store.create({
      id: 'm1',
      transactionId: 't1',
      agentId: 'a1',
      tenantId: 'ten1',
      promptHash: 'this-is-plaintext-16+',
      receivedAt: now.toISOString(),
      status: 'received',
    })).rejects.toMatchObject({ code: 'MANDATE_REQUEST_PROMPT_HASH' });

    const ok = await receiveMandateRequest(store, {
      transactionId: 't2',
      agentId: 'a1',
      tenantId: 'ten1',
      prompt: 'buy groceries',
      encryptedPromptRef: 'enc_ref_ok',
    });
    expect(ok.promptHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('pass3: draft lineage', () => {
  it('rejects payment drafts with different subject or window outside checkout', async () => {
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test', now: () => now });
    const sut = createMandateService({ merchantSigner: signer, replayStore: new InMemoryMandateReplayStore(), now: () => now });
    const checkout = await sut.createMerchantCheckout({
      transactionId: 'txn_lin',
      merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
      lineItems: [{ productId: 'p1', title: 'P', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
      totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
      issuedAt, expiresAt, source: { type: 'manual', requestId: 'r1' },
    });
    const checkoutDraft = await sut.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: 'txn_lin',
      userReference: 'user_001', nonce: 'n_c', issuedAt, expiresAt,
    });

    await expect(sut.createPaymentMandateDraft({
      transactionId: 'txn_lin', checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: checkoutDraft.id,
      payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
      paymentAmount: { amountMinor: 50, currency: 'USD' },
      paymentInstrument: { id: 'instrument_1', type: 'card', descriptionMasked: 'Card •••• 1234' },
      userReference: 'other_user', nonce: 'n_p1', issuedAt, expiresAt,
    })).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    await expect(sut.createPaymentMandateDraft({
      transactionId: 'txn_lin', checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: checkoutDraft.id,
      payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
      paymentAmount: { amountMinor: 50, currency: 'USD' },
      paymentInstrument: { id: 'instrument_1', type: 'card', descriptionMasked: 'Card •••• 1234' },
      userReference: 'user_001', nonce: 'n_p2',
      issuedAt: new Date(Date.parse(issuedAt) - 1_000).toISOString(),
      expiresAt,
    })).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    await expect(sut.createPaymentMandateDraft({
      transactionId: 'txn_lin', checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: checkoutDraft.id,
      payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
      paymentAmount: { amountMinor: 50, currency: 'USD' },
      paymentInstrument: { id: 'instrument_1', type: 'card', descriptionMasked: 'Card •••• 1234' },
      userReference: 'user_001', nonce: 'n_p3',
      issuedAt,
      expiresAt: new Date(Date.parse(expiresAt) + 1_000).toISOString(),
    })).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
  });
});

describe('pass3: future-issued fail-closed', () => {
  it('rejects future issuedAt beyond skew and future JWT iat on verify', async () => {
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test', now: () => now });
    const sut = createMandateService({ merchantSigner: signer, now: () => now, clockSkewMs: 5_000 });
    await expect(sut.createMerchantCheckout({
      transactionId: 'txn_future',
      merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
      lineItems: [{ productId: 'p1', title: 'P', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
      totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
      issuedAt: '2030-01-01T00:01:00.000Z',
      expiresAt: '2030-01-01T00:11:00.000Z',
      source: { type: 'manual', requestId: 'rf' },
    })).rejects.toMatchObject({ code: 'MANDATE_ISSUED_FUTURE' });

    const wall = new Date('2020-01-01T00:00:00.000Z');
    const pastSigner = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test', now: () => wall });
    const futureJwt = await pastSigner.signCheckout({
      transactionId: 'txn_past',
      merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
      lineItems: [{ productId: 'p1', title: 'P', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
      totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
      issuedAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-01T00:10:00.000Z',
      source: { type: 'manual', requestId: 'rp' },
    });
    await expect(pastSigner.verifyCheckout(futureJwt)).rejects.toMatchObject({ code: 'CHECKOUT_JWT' });
  });
});

describe('pass3: open mandate unused export for registry smoke', () => {
  it('creates open mandate with matching thumbprint helper', async () => {
    const registry = new InMemoryOpenMandateRegistry();
    const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' };
    const mandate = registry.create({
      type: 'payment', tenantId: 't', userReference: 'u', agentId: 'a',
      agentPublicKeyJwk: jwk, constraints: constraints(),
      issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience: 'credential-provider', nonce: 'n',
    });
    expect(await calculateJwkThumbprint(mandate.agentPublicKeyJwk, 'sha256')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(FakeMandateAnchorClient).toBeTypeOf('function');
  });
});
