import { describe, expect, it } from 'vitest';
import {
  InMemoryMandateReplayStore,
  createLocalMerchantSigner,
  createMandateService,
  type MandateReplayStore,
  type StoredCheckoutDraft,
  type StoredPaymentDraft,
} from '../src/mandates/index.js';

const now = new Date('2030-01-01T00:01:00.900Z');
const merchantIssuedAt = '2030-01-01T00:00:00.000Z';
const merchantExpiresAt = '2030-01-01T00:10:00.999Z';
const checkoutIssuedAt = '2030-01-01T00:01:00.900Z';
const checkoutExpiresAt = '2030-01-01T00:10:00.100Z';

class MutatingReplayStore implements MandateReplayStore {
  private readonly inner = new InMemoryMandateReplayStore();
  mutateCheckout: (record: StoredCheckoutDraft) => StoredCheckoutDraft = (record) => record;
  mutatePayment: (record: StoredPaymentDraft) => StoredPaymentDraft = (record) => record;
  readonly consumedNonces: string[] = [];
  paymentWrites = 0;

  async consumeNonce(transactionId: string, nonce: string): Promise<void> {
    this.consumedNonces.push(`${transactionId}:${nonce}`);
    await this.inner.consumeNonce(transactionId, nonce);
  }

  async rememberCheckoutDraft(id: string, record: StoredCheckoutDraft): Promise<void> {
    await this.inner.rememberCheckoutDraft(id, record);
  }

  async getCheckoutDraft(id: string): Promise<StoredCheckoutDraft | undefined> {
    const record = await this.inner.getCheckoutDraft(id);
    return record ? this.mutateCheckout(record) : undefined;
  }

  async rememberPaymentDraft(id: string, record: StoredPaymentDraft): Promise<void> {
    this.paymentWrites += 1;
    await this.inner.rememberPaymentDraft(id, record);
  }

  async getPaymentDraft(id: string): Promise<StoredPaymentDraft | undefined> {
    const record = await this.inner.getPaymentDraft(id);
    return record ? this.mutatePayment(record) : undefined;
  }
}

async function setup(transactionId: string) {
  const store = new MutatingReplayStore();
  const signer = await createLocalMerchantSigner({
    issuer: 'merchant_1',
    nodeEnv: 'test',
    now: () => now,
  });
  const service = createMandateService({ merchantSigner: signer, replayStore: store, now: () => now });
  const checkout = await service.createMerchantCheckout({
    transactionId,
    merchant: { id: 'merchant_1', legalName: 'Merchant', website: 'https://merchant.example' },
    lineItems: [{
      productId: 'product_1',
      title: 'Product',
      quantity: 1,
      unitAmountMinor: 100,
      taxAmountMinor: 0,
      discountAmountMinor: 0,
    }],
    totals: {
      subtotalMinor: 100,
      taxMinor: 0,
      discountMinor: 0,
      totalMinor: 100,
      currency: 'USD',
    },
    issuedAt: merchantIssuedAt,
    expiresAt: merchantExpiresAt,
    source: { type: 'manual', requestId: `request_${transactionId}` },
  });
  const createCheckoutDraft = (
    nonce: string,
    issuedAt: string,
    expiresAt: string,
  ) => service.createCheckoutMandateDraft({
    checkoutJwt: checkout.checkoutJwt,
    checkoutHash: checkout.checkoutHash,
    transactionId,
    userReference: 'user_1',
    nonce,
    issuedAt,
    expiresAt,
  });
  const exactCheckoutDraft = await createCheckoutDraft(
    `${transactionId}_checkout_exact`,
    merchantIssuedAt,
    merchantExpiresAt,
  );
  const narrowCheckoutDraft = await createCheckoutDraft(
    `${transactionId}_checkout_narrow`,
    checkoutIssuedAt,
    checkoutExpiresAt,
  );
  const createPaymentDraft = (
    nonce: string,
    issuedAt: string,
    expiresAt: string,
  ) => service.createPaymentMandateDraft({
    transactionId,
    checkoutJwt: checkout.checkoutJwt,
    checkoutHash: checkout.checkoutHash,
    checkoutMandateDraftId: narrowCheckoutDraft.id,
    payee: { id: 'merchant_1', name: 'Merchant', website: 'https://merchant.example' },
    paymentAmount: { amountMinor: 100, currency: 'USD' },
    paymentInstrument: {
      id: 'instrument_1',
      type: 'card',
      descriptionMasked: 'Card •••• 1234',
    },
    userReference: 'user_1',
    nonce,
    issuedAt,
    expiresAt,
  });
  const verify = (draft: Parameters<typeof service.verifyDraftConsistency>[0]['draft']) =>
    service.verifyDraftConsistency({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId,
      draft,
      expectedUserReference: 'user_1',
    });

  return {
    checkout,
    createPaymentDraft,
    exactCheckoutDraft,
    narrowCheckoutDraft,
    service,
    store,
    verify,
  };
}

describe('exact draft-window id binding', () => {
  it('rejects same-second checkout metadata tamper during verification while exact/narrow remain valid', async () => {
    const { exactCheckoutDraft, narrowCheckoutDraft, store, verify } = await setup('txn_checkout_binding');

    await expect(verify(exactCheckoutDraft.unsignedMandatePayload)).resolves.toMatchObject({ valid: true });
    await expect(verify(narrowCheckoutDraft.unsignedMandatePayload)).resolves.toMatchObject({ valid: true });

    store.mutateCheckout = (record) => ({ ...record, issuedAt: '2030-01-01T00:01:00.950Z' });
    await expect(verify(narrowCheckoutDraft.unsignedMandatePayload))
      .rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    store.mutateCheckout = (record) => ({ ...record, expiresAt: '2030-01-01T00:10:00.050Z' });
    await expect(verify(narrowCheckoutDraft.unsignedMandatePayload))
      .rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    store.mutateCheckout = (record) => record;
    await expect(verify(narrowCheckoutDraft.unsignedMandatePayload)).resolves.toMatchObject({ valid: true });
  });

  it('does not let checkout tamper widen payment creation or consume nonce/write payment', async () => {
    const { createPaymentDraft, store } = await setup('txn_payment_parent_binding');
    const nonceCount = store.consumedNonces.length;
    const paymentWrites = store.paymentWrites;

    store.mutateCheckout = (record) => ({ ...record, issuedAt: '2030-01-01T00:01:00.100Z' });
    await expect(createPaymentDraft(
      'tampered_parent_issued',
      '2030-01-01T00:01:00.100Z',
      checkoutExpiresAt,
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    expect(store.consumedNonces).toHaveLength(nonceCount);
    expect(store.paymentWrites).toBe(paymentWrites);

    store.mutateCheckout = (record) => ({ ...record, expiresAt: '2030-01-01T00:10:00.900Z' });
    await expect(createPaymentDraft(
      'tampered_parent_expires',
      checkoutIssuedAt,
      '2030-01-01T00:10:00.900Z',
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    expect(store.consumedNonces).toHaveLength(nonceCount);
    expect(store.paymentWrites).toBe(paymentWrites);

    store.mutateCheckout = (record) => record;
    await expect(createPaymentDraft(
      'tampered_parent_issued',
      checkoutIssuedAt,
      checkoutExpiresAt,
    )).resolves.toMatchObject({ mandateType: 'payment' });
    expect(store.consumedNonces).toHaveLength(nonceCount + 1);
    expect(store.paymentWrites).toBe(paymentWrites + 1);
  });

  it('rejects same-second payment metadata tamper while exact/narrow payments remain valid', async () => {
    const { createPaymentDraft, store, verify } = await setup('txn_payment_binding');
    const exact = await createPaymentDraft('payment_exact', checkoutIssuedAt, checkoutExpiresAt);
    const narrow = await createPaymentDraft(
      'payment_narrow',
      '2030-01-01T00:01:00.950Z',
      '2030-01-01T00:10:00.050Z',
    );

    await expect(verify(exact.unsignedMandatePayload)).resolves.toMatchObject({ valid: true });
    await expect(verify(narrow.unsignedMandatePayload)).resolves.toMatchObject({ valid: true });

    store.mutatePayment = (record) => ({ ...record, issuedAt: '2030-01-01T00:01:00.950Z' });
    await expect(verify(exact.unsignedMandatePayload))
      .rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    store.mutatePayment = (record) => ({ ...record, expiresAt: '2030-01-01T00:10:00.050Z' });
    await expect(verify(exact.unsignedMandatePayload))
      .rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    store.mutatePayment = (record) => record;
    await expect(verify(exact.unsignedMandatePayload)).resolves.toMatchObject({ valid: true });
    await expect(verify(narrow.unsignedMandatePayload)).resolves.toMatchObject({ valid: true });
  });
});
