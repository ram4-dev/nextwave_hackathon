import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMandateAnchorOutbox,
  InMemoryMandatePolicyLedger,
  InMemoryMandateRequestStore,
  InMemoryOpenMandateRegistry,
  MandatePolicyEvaluator,
  PgMandatePolicyLedger,
  receiveMandateRequest,
  type CheckoutSnapshot,
  type OpenMandateConstraints,
  type OpenMandateRecord,
} from '../src/mandates/index.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const audience = 'credential-provider';
const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' };

function sha(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function constraints(overrides: Partial<OpenMandateConstraints> = {}): OpenMandateConstraints {
  return {
    merchantIds: ['merchant_001'],
    payeeIds: ['merchant_001'],
    productIds: ['product_001'],
    supplierIds: ['supplier_001'],
    maxQuantityPerProduct: 3,
    minAmountMinor: 1,
    maxAmountMinor: 1_000,
    currency: 'USD',
    totalBudgetMinor: 100,
    maxOperations: 10,
    frequencyWindowSeconds: 3_600,
    maxOperationsPerWindow: 10,
    paymentInstrumentAlias: 'instrument_1',
    allowedPisp: 'pisp_1',
    ...overrides,
  };
}

function activeMandate(type: 'checkout' | 'payment', id: string, value = constraints()): OpenMandateRecord {
  const payloadHash = sha(id);
  return {
    id,
    type,
    tenantId: 'tenant_1',
    userReference: 'user_1',
    agentId: 'agent_1',
    agentPublicKeyJwk: publicJwk,
    constraints: value,
    canonicalPayloadHash: payloadHash,
    issuedAt: now.toISOString(),
    expiresAt: '2030-01-01T01:00:00.000Z',
    audience,
    nonce: `${id}_nonce`,
    status: 'active',
    userSignature: 'signature',
    activationProof: { signature: 'signature', payloadHash, activatedAt: now.toISOString() },
  };
}

function checkout(lineItems: CheckoutSnapshot['lineItems']): CheckoutSnapshot {
  const subtotalMinor = lineItems.reduce((sum, item) => sum + item.quantity * item.unitAmountMinor, 0);
  return {
    transactionId: 'txn_policy',
    merchant: { id: 'merchant_001', legalName: 'Merchant', website: 'https://merchant.example' },
    lineItems,
    totals: { subtotalMinor, taxMinor: 0, discountMinor: 0, totalMinor: subtotalMinor, currency: 'USD' },
    issuedAt: now.toISOString(),
    expiresAt: '2030-01-01T00:10:00.000Z',
    source: { type: 'manual', requestId: 'request_policy' },
  };
}

function line(quantity: number, supplierId?: string): CheckoutSnapshot['lineItems'][number] {
  return {
    productId: 'product_001',
    supplierId,
    title: 'Product',
    quantity,
    unitAmountMinor: 10,
    taxAmountMinor: 0,
    discountAmountMinor: 0,
  };
}

describe('fourth remediation: complete open-mandate time bounds', () => {
  it('blocks activation/authorization before issuedAt and enforces activation proof/skew bounds', async () => {
    const registry = new InMemoryOpenMandateRegistry();
    const future = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: publicJwk, constraints: constraints(),
      issuedAt: new Date(now.getTime() + 1).toISOString(),
      expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'future',
    });
    await expect(registry.activateWithVerifiedSignature({
      id: future.id,
      signature: 'signature',
      expectedPayloadHash: future.canonicalPayloadHash,
      verifier: { verify: async () => true },
      now,
      clockSkewMs: 5_000,
    })).rejects.toMatchObject({ code: 'OPEN_MANDATE_NOT_YET_VALID' });

    const mandate = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: publicJwk, constraints: constraints(),
      issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'proof_bounds',
    });
    const activation = (activatedAt: string, clockSkewMs = 5_000) => registry.activateWithVerifiedSignature({
      id: mandate.id,
      signature: 'signature',
      expectedPayloadHash: mandate.canonicalPayloadHash,
      verifier: { verify: async () => true },
      proof: { activatedAt },
      now,
      clockSkewMs,
    });
    await expect(activation(new Date(now.getTime() - 1).toISOString())).rejects.toMatchObject({ code: 'OPEN_MANDATE_PROOF' });
    await expect(activation(new Date(now.getTime() + 5_001).toISOString())).rejects.toMatchObject({ code: 'OPEN_MANDATE_PROOF' });
    await expect(activation(now.toISOString(), -1)).rejects.toMatchObject({ code: 'OPEN_MANDATE_CONFIG' });
    await expect(activation(new Date(now.getTime() + 5_000).toISOString())).resolves.toMatchObject({ status: 'active' });

    expect(() => registry.getAuthorizedActive({
      id: mandate.id,
      userReference: 'user_1', agentId: 'agent_1', tenantId: 'tenant_1', audience,
      now: new Date(now.getTime() - 1),
      clockSkewMs: 5_000,
    })).toThrow(/before issuedAt/);
    expect(() => registry.getAuthorizedActive({
      id: mandate.id,
      userReference: 'user_1', agentId: 'agent_1', tenantId: 'tenant_1', audience,
      now,
      clockSkewMs: Number.NaN,
    })).toThrow(/clockSkewMs/);
  });
});

describe('fourth remediation: complete policy rules', () => {
  const evaluator = new MandatePolicyEvaluator();
  const openCheckout = activeMandate('checkout', 'open_checkout');
  const openPayment = activeMandate('payment', 'open_payment');
  const evaluate = (items: CheckoutSnapshot['lineItems'], pispId?: string) => evaluator.evaluate({
    checkout: checkout(items),
    payeeId: 'merchant_001',
    paymentInstrumentAlias: 'instrument_1',
    openCheckout,
    openPayment,
    pispId,
    now,
  });

  it('requires an explicit matching PISP and a supplier when allowlists are present', () => {
    expect(evaluate([line(1, 'supplier_001')]).reasons.map((reason) => reason.code)).toContain('PISP_NOT_ALLOWED');
    expect(evaluate([line(1, 'supplier_001')], 'other_pisp').reasons.map((reason) => reason.code)).toContain('PISP_NOT_ALLOWED');
    expect(evaluate([line(1)], 'pisp_1').reasons.map((reason) => reason.code)).toContain('SUPPLIER_REQUIRED');
    expect(evaluate([line(1, 'supplier_001')], 'pisp_1')).toEqual({ allowed: true, reasons: [] });
  });

  it('aggregates duplicate product lines before max-quantity enforcement', () => {
    const rejected = evaluate([line(2, 'supplier_001'), line(2, 'supplier_001')], 'pisp_1');
    expect(rejected.allowed).toBe(false);
    expect(rejected.reasons.map((reason) => reason.code)).toContain('QUANTITY_EXCEEDED');
    expect(evaluate([line(1, 'supplier_001'), line(2, 'supplier_001')], 'pisp_1')).toEqual({ allowed: true, reasons: [] });
  });
});

describe('fourth remediation: authoritative reservation balance', () => {
  it('returns serialized post-reservation balances without concurrent stale reads', async () => {
    const ledger = new InMemoryMandatePolicyLedger();
    const value = constraints({ supplierIds: undefined, allowedPisp: undefined });
    const reserve = (transactionId: string, amountMinor: number) => ledger.reserve({
      checkoutMandateId: 'checkout_budget',
      paymentMandateId: 'payment_budget',
      transactionId,
      amountMinor,
      now,
      checkoutConstraints: value,
      paymentConstraints: value,
    });
    await expect(reserve('txn_30', 30)).resolves.toEqual({ remainingBudgetMinor: 70 });
    await expect(reserve('txn_20', 20)).resolves.toEqual({ remainingBudgetMinor: 50 });

    const concurrent = new InMemoryMandatePolicyLedger();
    const results = await Promise.all([
      concurrent.reserve({
        checkoutMandateId: 'checkout_concurrent', paymentMandateId: 'payment_concurrent',
        transactionId: 'txn_10', amountMinor: 10, now, checkoutConstraints: value, paymentConstraints: value,
      }),
      concurrent.reserve({
        checkoutMandateId: 'checkout_concurrent', paymentMandateId: 'payment_concurrent',
        transactionId: 'txn_20', amountMinor: 20, now, checkoutConstraints: value, paymentConstraints: value,
      }),
    ]);
    expect(results.map((result) => result.remainingBudgetMinor).sort((a, b) => a - b)).toEqual([70, 90]);
  });

  it('uses the Postgres reservation RPC result directly without a separate stale read', async () => {
    const query = vi.fn(async () => ({ rows: [{ remaining_budget_minor: '50' }] }));
    const ledger = new PgMandatePolicyLedger({ query });
    const value = constraints({ supplierIds: undefined, allowedPisp: undefined });
    await expect(ledger.reserve({
      checkoutMandateId: 'checkout_postgres',
      paymentMandateId: 'payment_postgres',
      transactionId: 'txn_postgres',
      amountMinor: 20,
      now,
      checkoutConstraints: value,
      paymentConstraints: value,
    })).resolves.toEqual({ remainingBudgetMinor: 50 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('reserve_mandate_policy'),
      expect.arrayContaining(['txn_postgres', 20]),
    );
  });
});

describe('fourth remediation: encrypted prompt ref boundary', () => {
  it('accepts exactly 512 ASCII characters and rejects 513 at input and store boundaries', async () => {
    const store = new InMemoryMandateRequestStore();
    const ref512 = 'a'.repeat(512);
    const ref513 = 'a'.repeat(513);
    await expect(receiveMandateRequest(store, {
      requestId: 'request_512', transactionId: 'txn_512', agentId: 'agent_1', tenantId: 'tenant_1',
      prompt: 'opaque prompt', encryptedPromptRef: ref512, receivedAt: now.toISOString(),
    })).resolves.toMatchObject({ encryptedPromptRef: ref512 });
    await expect(receiveMandateRequest(store, {
      requestId: 'request_513', transactionId: 'txn_513', agentId: 'agent_1', tenantId: 'tenant_1',
      prompt: 'opaque prompt', encryptedPromptRef: ref513, receivedAt: now.toISOString(),
    })).rejects.toMatchObject({ code: 'MANDATE_REQUEST_INPUT' });
    await expect(store.create({
      id: 'store_513', transactionId: 'store_txn_513', agentId: 'agent_1', tenantId: 'tenant_1',
      promptHash: sha('opaque prompt'), encryptedPromptRef: ref513, receivedAt: now.toISOString(), status: 'received',
    })).rejects.toMatchObject({ code: 'MANDATE_REQUEST_PROMPT_REF' });
  });
});

describe('fourth remediation: strict outbox idempotency', () => {
  it('returns the existing job only for identical evidence and rejects every conflicting non-key field', async () => {
    const outbox = new InMemoryMandateAnchorOutbox();
    const evidence = {
      closedCheckoutHash: sha('closed_checkout'),
      closedPaymentHash: sha('closed_payment'),
      checkoutHash: sha('checkout'),
      transactionIdHash: sha('transaction'),
      agentIdHash: sha('agent'),
      policyVersionHash: sha('policy'),
      mandateType: 1,
    };
    const first = await outbox.enqueue(evidence);
    await expect(outbox.enqueue(evidence)).resolves.toMatchObject({ id: first.id });

    const conflicts = [
      { ...evidence, checkoutHash: sha('other_checkout') },
      { ...evidence, transactionIdHash: sha('other_transaction') },
      { ...evidence, agentIdHash: sha('other_agent') },
      { ...evidence, policyVersionHash: sha('other_policy') },
      { ...evidence, mandateType: 2 },
    ];
    for (const conflict of conflicts) {
      await expect(outbox.enqueue(conflict)).rejects.toMatchObject({ code: 'ANCHOR_EVIDENCE_CONFLICT' });
    }
    await expect(outbox.get(first.id)).resolves.toMatchObject(evidence);
  });
});
