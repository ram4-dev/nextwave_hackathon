import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { calculateJwkThumbprint } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRepository } from '../src/persistence/repository.js';
import {
  FakeMandateAnchorClient,
  InMemoryMandateAnchorOutbox,
  InMemoryMandatePolicyLedger,
  InMemoryMandateReplayStore,
  InMemoryOpenMandateRegistry,
  JsonFileMandateReplayStore,
  KyaAgentTrustVerifier,
  SupabaseMandatePolicyLedger,
  createLocalMerchantSigner,
  createMandateService,
  isStrictEvidenceHash,
  type MandateAnchorEvidence,
  type MandatePolicyReserveInput,
  type MandateReplayStore,
  type OpenMandateConstraints,
  type StoredCheckoutDraft,
  type StoredPaymentDraft,
} from '../src/mandates/index.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const publicJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' };

function constraints(overrides: Partial<OpenMandateConstraints> = {}): OpenMandateConstraints {
  return {
    merchantIds: ['merchant_1'],
    payeeIds: ['merchant_1'],
    maxQuantityPerProduct: 10,
    minAmountMinor: 1,
    maxAmountMinor: 1_000,
    currency: 'USD',
    totalBudgetMinor: 100,
    maxOperations: 10,
    frequencyWindowSeconds: 3_600,
    maxOperationsPerWindow: 10,
    paymentInstrumentAlias: 'instrument_1',
    ...overrides,
  };
}

function createOpen(registry: InMemoryOpenMandateRegistry, nonce: string) {
  return registry.create({
    type: 'payment',
    tenantId: 'tenant_1',
    userReference: 'user_1',
    agentId: 'agent_1',
    agentPublicKeyJwk: publicJwk,
    constraints: constraints(),
    issuedAt: now.toISOString(),
    expiresAt: '2030-01-01T01:00:00.000Z',
    audience: 'credential-provider',
    nonce,
  });
}

function checkoutInput(transactionId: string, issuedAt = now.toISOString(), expiresAt = '2030-01-01T00:05:00.000Z') {
  return {
    transactionId,
    merchant: { id: 'merchant_1', legalName: 'Merchant', website: 'https://merchant.example' },
    lineItems: [{
      productId: 'product_1', title: 'Product', quantity: 1, unitAmountMinor: 100,
      taxAmountMinor: 0, discountAmountMinor: 0,
    }],
    totals: { subtotalMinor: 100, taxMinor: 0, discountMinor: 0, totalMinor: 100, currency: 'USD' },
    issuedAt,
    expiresAt,
    source: { type: 'manual' as const, requestId: `request_${transactionId}` },
  };
}

class MutatingCheckoutReplayStore extends InMemoryMandateReplayStore {
  mutate: (record: StoredCheckoutDraft) => StoredCheckoutDraft = (record) => record;
  mutatePayment: (record: StoredPaymentDraft) => StoredPaymentDraft = (record) => record;
  paymentWrites = 0;

  override async getCheckoutDraft(id: string): Promise<StoredCheckoutDraft | undefined> {
    const record = await super.getCheckoutDraft(id);
    return record ? this.mutate(record) : undefined;
  }

  override async getPaymentDraft(id: string): Promise<StoredPaymentDraft | undefined> {
    const record = await super.getPaymentDraft(id);
    return record ? this.mutatePayment(record) : undefined;
  }

  override async rememberPaymentDraft(id: string, record: StoredPaymentDraft): Promise<void> {
    this.paymentWrites += 1;
    await super.rememberPaymentDraft(id, record);
  }
}

describe('round 3: replay temporal metadata boundaries', () => {
  it('fails closed in both stores and never persists JWT or prompt fields', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'kya-replay-lineage-'));
    const filePath = path.join(directory, 'replay.json');
    try {
      const stores: Array<{ label: string; store: MandateReplayStore }> = [
        { label: 'memory', store: new InMemoryMandateReplayStore() },
        { label: 'json', store: new JsonFileMandateReplayStore(filePath) },
      ];
      const checkoutRecord: StoredCheckoutDraft = {
        transactionId: 'txn_store',
        checkoutHash: 'checkout_hash',
        payloadHash: 'checkout_payload_hash',
        sub: 'user_1',
        aud: 'credential-provider',
        issuedAt: '2030-01-01T00:01:00.900Z',
        expiresAt: '2030-01-01T00:10:00.100Z',
        iat: Math.floor(Date.parse('2030-01-01T00:01:00.900Z') / 1000),
        exp: Math.floor(Date.parse('2030-01-01T00:10:00.100Z') / 1000),
      };
      const paymentRecord: StoredPaymentDraft = {
        transactionId: 'txn_store',
        checkoutHash: 'checkout_hash',
        checkoutMandateDraftId: 'checkout_draft_store',
        payloadHash: 'payment_payload_hash',
        issuedAt: '2030-01-01T00:01:00.900Z',
        expiresAt: '2030-01-01T00:10:00.100Z',
        iat: Math.floor(Date.parse('2030-01-01T00:01:00.900Z') / 1000),
        exp: Math.floor(Date.parse('2030-01-01T00:10:00.100Z') / 1000),
      };

      for (const { label, store } of stores) {
        await expect(store.rememberCheckoutDraft(`checkout_${label}`, checkoutRecord)).resolves.toBeUndefined();
        await expect(store.rememberPaymentDraft(`payment_${label}`, paymentRecord)).resolves.toBeUndefined();
        await expect(store.getCheckoutDraft(`checkout_${label}`)).resolves.toEqual(checkoutRecord);
        await expect(store.getPaymentDraft(`payment_${label}`)).resolves.toEqual(paymentRecord);

        await expect(store.rememberCheckoutDraft(`checkout_bad_time_${label}`, {
          ...checkoutRecord,
          issuedAt: 'not-a-time',
        })).rejects.toMatchObject({ code: 'CHECKOUT_DRAFT_LINEAGE' });
        await expect(store.rememberPaymentDraft(`payment_bad_time_${label}`, {
          ...paymentRecord,
          expiresAt: 'not-a-time',
        })).rejects.toMatchObject({ code: 'PAYMENT_DRAFT_LINEAGE' });
        await expect(store.rememberPaymentDraft(`payment_bad_seconds_${label}`, {
          ...paymentRecord,
          iat: paymentRecord.iat + 1,
        })).rejects.toMatchObject({ code: 'PAYMENT_DRAFT_LINEAGE' });
        await expect(store.rememberCheckoutDraft(`checkout_secret_${label}`, {
          ...checkoutRecord,
          prompt: 'secret_prompt_marker',
        } as StoredCheckoutDraft)).rejects.toMatchObject({ code: 'CHECKOUT_DRAFT_LINEAGE' });
        await expect(store.rememberPaymentDraft(`payment_secret_${label}`, {
          ...paymentRecord,
          checkoutJwt: 'secret_jwt_marker',
        } as StoredPaymentDraft)).rejects.toMatchObject({ code: 'PAYMENT_DRAFT_LINEAGE' });
      }

      const persisted = await readFile(filePath, 'utf8');
      expect(persisted).not.toContain('secret_prompt_marker');
      expect(persisted).not.toContain('secret_jwt_marker');
      expect(persisted).not.toContain('checkoutJwt');
      expect(persisted).not.toContain('prompt');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('round 2: activation and revocation share one serialization boundary', () => {
  it('never leaves an active mandate after revoke resolves, regardless of which operation wins', async () => {
    const activationFirstRegistry = new InMemoryOpenMandateRegistry();
    const activationFirstMandate = createOpen(activationFirstRegistry, 'activation_first');
    let enterVerifier!: () => void;
    let releaseVerifier!: () => void;
    const verifierEntered = new Promise<void>((resolve) => { enterVerifier = resolve; });
    const verifierRelease = new Promise<void>((resolve) => { releaseVerifier = resolve; });
    const activation = activationFirstRegistry.activateWithVerifiedSignature({
      id: activationFirstMandate.id,
      signature: 'signature',
      expectedPayloadHash: activationFirstMandate.canonicalPayloadHash,
      now,
      verifier: {
        verify: async () => {
          enterVerifier();
          await verifierRelease;
          return true;
        },
      },
    });
    await verifierEntered;
    const revocation = activationFirstRegistry.revoke(activationFirstMandate.id);
    releaseVerifier();
    await expect(activation).resolves.toMatchObject({ status: 'active' });
    await expect(revocation).resolves.toMatchObject({ status: 'revoked' });
    expect(activationFirstRegistry.get(activationFirstMandate.id).status).toBe('revoked');

    const revocationFirstRegistry = new InMemoryOpenMandateRegistry();
    const revocationFirstMandate = createOpen(revocationFirstRegistry, 'revocation_first');
    const firstRevocation = revocationFirstRegistry.revoke(revocationFirstMandate.id);
    const laterActivation = revocationFirstRegistry.activateWithVerifiedSignature({
      id: revocationFirstMandate.id,
      signature: 'signature',
      expectedPayloadHash: revocationFirstMandate.canonicalPayloadHash,
      now,
      verifier: { verify: async () => true },
    });
    await expect(firstRevocation).resolves.toMatchObject({ status: 'revoked' });
    await expect(laterActivation).rejects.toMatchObject({ code: 'OPEN_MANDATE_STATE' });
    expect(revocationFirstRegistry.get(revocationFirstMandate.id).status).toBe('revoked');
  });
});

describe('round 2: safe integer and policy reservation boundaries', () => {
  it('rejects every unsafe open-mandate amount, budget, quantity, and limit', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const cases: Array<keyof Pick<OpenMandateConstraints,
      | 'maxQuantityPerProduct'
      | 'minAmountMinor'
      | 'maxAmountMinor'
      | 'totalBudgetMinor'
      | 'maxOperations'
      | 'frequencyWindowSeconds'
      | 'maxOperationsPerWindow'>> = [
        'maxQuantityPerProduct',
        'minAmountMinor',
        'maxAmountMinor',
        'totalBudgetMinor',
        'maxOperations',
        'frequencyWindowSeconds',
        'maxOperationsPerWindow',
      ];
    for (const field of cases) {
      const registry = new InMemoryOpenMandateRegistry();
      expect(() => registry.create({
        type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
        agentPublicKeyJwk: publicJwk,
        constraints: constraints({ [field]: unsafe }),
        issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z',
        audience: 'credential-provider', nonce: `unsafe_${field}`,
      }), field).toThrow(/Invalid open mandate input/);
    }
  });

  it('keeps memory and Supabase adapters fail-closed and prevents artificial balance', async () => {
    const single = vi.fn(async () => ({ data: { remaining_budget_minor: '90' }, error: null }));
    const rpc = vi.fn(() => ({ single }));
    const memory = new InMemoryMandatePolicyLedger();
    const remote = new SupabaseMandatePolicyLedger(
      { rpc } as unknown as import('@supabase/supabase-js').SupabaseClient,
    );
    const base: MandatePolicyReserveInput = {
      checkoutMandateId: 'checkout_1',
      paymentMandateId: 'payment_1',
      transactionId: 'txn_valid',
      amountMinor: 10,
      now,
      checkoutConstraints: constraints(),
      paymentConstraints: constraints(),
    };
    const invalid: MandatePolicyReserveInput[] = [
      { ...base, transactionId: 'txn_negative', amountMinor: -1 },
      { ...base, transactionId: 'txn_unsafe', amountMinor: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, transactionId: 'txn_clock', now: new Date(Number.NaN) },
      {
        ...base,
        transactionId: 'txn_incoherent',
        checkoutConstraints: constraints({ minAmountMinor: 20, maxAmountMinor: 10 }),
      },
      {
        ...base,
        transactionId: 'txn_budget_unsafe',
        paymentConstraints: constraints({ totalBudgetMinor: Number.MAX_SAFE_INTEGER + 1 }),
      },
      {
        ...base,
        transactionId: 'txn_sql_limit',
        checkoutConstraints: constraints({ maxOperations: 2_147_483_648 }),
      },
    ];
    for (const input of invalid) {
      await expect(memory.reserve(input)).rejects.toMatchObject({ code: 'POLICY_INPUT' });
      await expect(remote.reserve(input)).rejects.toMatchObject({ code: 'POLICY_INPUT' });
    }
    expect(rpc).not.toHaveBeenCalled();

    await expect(memory.reserve(base)).resolves.toEqual({ remainingBudgetMinor: 90 });
    await expect(remote.reserve(base)).resolves.toEqual({ remainingBudgetMinor: 90 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(single).toHaveBeenCalledTimes(1);
  });
});

describe('round 2: clocks and credential timestamps fail closed', () => {
  it('rejects an invalid service clock at every public boundary with a stable code', async () => {
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_1', nodeEnv: 'test', now: () => now });
    const validService = createMandateService({ merchantSigner: signer, now: () => now });
    const checkout = await validService.createMerchantCheckout(checkoutInput('txn_clock'));
    const invalidService = createMandateService({ merchantSigner: signer, now: () => new Date(Number.NaN) });
    const calls = [
      () => invalidService.createMerchantCheckout(checkoutInput('txn_clock_create')),
      () => invalidService.createCheckoutMandateDraft({
        checkoutJwt: checkout.checkoutJwt,
        checkoutHash: checkout.checkoutHash,
        transactionId: 'txn_clock',
        userReference: 'user_1',
        nonce: 'clock_checkout',
        issuedAt: now.toISOString(),
        expiresAt: '2030-01-01T00:04:00.000Z',
      }),
      () => invalidService.createPaymentMandateDraft({} as never),
      () => invalidService.verifyDraftConsistency({} as never),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'MANDATE_CLOCK' });
    }
  });

  it('denies malformed credential timestamps and rejects an invalid trust clock', async () => {
    const thumbprint = await calculateJwkThumbprint(publicJwk, 'sha256');
    const repo = new InMemoryRepository();
    await repo.withLock((store) => {
      store.enrollments.push({
        agentUuid: 'agent_1', deviceCode: 'device_1', principalId: 'principal_1', status: 'bound',
        publicJwk, thumbprint, keystoreProvider: 'os_hardware', agentUriPath: '/agents/agent_1',
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      store.credentials.push({
        id: 'credential_bad_time', agentUuid: 'agent_1', principalId: 'principal_1', thumbprint,
        agentRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: '1',
        owner: '0x0000000000000000000000000000000000000001', status: 'active', statusRef: 'local',
        issuedAt: now.toISOString(), expiresAt: 'not-a-date', jti: 'credential_bad_time',
      });
    });
    const input = {
      agentId: 'agent_1', tenantId: 'tenant_1', keyId: 'key_1', publicKeyJwk: publicJwk,
      action: 'autonomous_payment_mandate' as const,
    };
    const verifier = new KyaAgentTrustVerifier(repo, {
      policyVersion: 'v1', isTenantAuthorized: () => true, riskLevel: () => 'low', now: () => now,
    });
    await expect(verifier.verifyAgent(input)).resolves.toMatchObject({
      allowed: false,
      attestationStatus: 'invalid',
      reasons: expect.arrayContaining(['ATTESTATION_INVALID']),
    });
    const invalidClock = new KyaAgentTrustVerifier(repo, {
      policyVersion: 'v1', isTenantAuthorized: () => true, riskLevel: () => 'low',
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClock.verifyAgent(input)).rejects.toMatchObject({ code: 'AGENT_TRUST_CLOCK' });
  });
});

describe('round 2: checkout draft window containment', () => {
  it('accepts exact/narrow windows, rejects both escaped edges, and rechecks consistency', async () => {
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_1', nodeEnv: 'test', now: () => now });
    let serviceNow = now;
    const service = createMandateService({
      merchantSigner: signer,
      replayStore: new InMemoryMandateReplayStore(),
      now: () => serviceNow,
    });
    const checkout = await service.createMerchantCheckout(checkoutInput('txn_window'));
    const draft = (nonce: string, issuedAt: string, expiresAt: string) => service.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: 'txn_window',
      userReference: 'user_1',
      nonce,
      issuedAt,
      expiresAt,
    });

    const exact = await draft('window_exact', now.toISOString(), '2030-01-01T00:05:00.000Z');
    serviceNow = new Date('2030-01-01T00:01:00.000Z');
    const narrow = await draft('window_narrow', '2030-01-01T00:01:00.000Z', '2030-01-01T00:04:00.000Z');
    await expect(draft('window_before', '2029-12-31T23:59:00.000Z', '2030-01-01T00:04:00.000Z'))
      .rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    await expect(draft('window_after', now.toISOString(), '2030-01-01T00:15:00.000Z'))
      .rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    await expect(service.verifyDraftConsistency({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: 'txn_window',
      draft: exact.unsignedMandatePayload,
      expectedUserReference: 'user_1',
    })).resolves.toMatchObject({ valid: true });
    await expect(service.verifyDraftConsistency({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: 'txn_window',
      draft: { ...narrow.unsignedMandatePayload, exp: Date.parse('2030-01-01T00:06:00.000Z') / 1000 },
      expectedUserReference: 'user_1',
    })).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    serviceNow = new Date('2030-01-01T00:02:00.000Z');
    await expect(service.createPaymentMandateDraft({
      transactionId: 'txn_window',
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: narrow.id,
      payee: { id: 'merchant_1', name: 'Merchant', website: 'https://merchant.example' },
      paymentAmount: { amountMinor: 100, currency: 'USD' },
      paymentInstrument: { id: 'instrument_1', type: 'card', descriptionMasked: 'Card •••• 1234' },
      userReference: 'user_1',
      nonce: 'payment_inside',
      issuedAt: '2030-01-01T00:02:00.000Z',
      expiresAt: '2030-01-01T00:03:00.000Z',
    })).resolves.toMatchObject({ mandateType: 'payment' });
  });

  it('enforces both sub-second merchant edges during creation and exact-lineage verification', async () => {
    const merchantIssuedAt = '2030-01-01T00:00:00.900Z';
    const merchantExpiresAt = '2030-01-01T00:10:00.100Z';
    const edgeNow = new Date(merchantIssuedAt);
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_1', nodeEnv: 'test', now: () => edgeNow });
    const replayStore = new MutatingCheckoutReplayStore();
    const service = createMandateService({ merchantSigner: signer, replayStore, now: () => edgeNow });
    const checkout = await service.createMerchantCheckout(checkoutInput(
      'txn_subsecond_window',
      merchantIssuedAt,
      merchantExpiresAt,
    ));
    const draft = (nonce: string, issuedAt: string, expiresAt: string) => service.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: checkout.transactionId,
      userReference: 'user_1',
      nonce,
      issuedAt,
      expiresAt,
    });

    const exact = await draft('subsecond_exact', merchantIssuedAt, merchantExpiresAt);
    const narrow = await draft(
      'subsecond_narrow',
      '2030-01-01T00:00:01.100Z',
      '2030-01-01T00:09:59.900Z',
    );
    await expect(draft(
      'subsecond_before',
      '2030-01-01T00:00:00.100Z',
      merchantExpiresAt,
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    await expect(draft(
      'subsecond_after',
      merchantIssuedAt,
      '2030-01-01T00:10:00.900Z',
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    const verify = (candidate: typeof exact) => service.verifyDraftConsistency({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: checkout.transactionId,
      draft: candidate.unsignedMandatePayload,
      expectedUserReference: 'user_1',
    });
    await expect(verify(exact)).resolves.toMatchObject({ valid: true });
    await expect(verify(narrow)).resolves.toMatchObject({ valid: true });

    replayStore.mutate = (record) => ({ ...record, issuedAt: '2030-01-01T00:00:00.100Z' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutate = (record) => ({ ...record, expiresAt: '2030-01-01T00:10:00.900Z' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutate = (record) => ({ ...record, issuedAt: 'not-a-date' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutate = (record) => ({ ...record, expiresAt: 'not-a-date' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    replayStore.mutate = (record) => record;
    await expect(verify(exact)).resolves.toMatchObject({ valid: true });
    await expect(verify(narrow)).resolves.toMatchObject({ valid: true });
  });
});

describe('round 3: payment draft exact window containment', () => {
  it('accepts exact/narrow windows and rejects both sub-second edges during create and verify', async () => {
    let serviceNow = now;
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_1', nodeEnv: 'test', now: () => serviceNow });
    const replayStore = new MutatingCheckoutReplayStore();
    const service = createMandateService({ merchantSigner: signer, replayStore, now: () => serviceNow });
    const checkout = await service.createMerchantCheckout(checkoutInput(
      'txn_payment_subsecond_window',
      now.toISOString(),
      '2030-01-01T00:15:00.000Z',
    ));
    serviceNow = new Date('2030-01-01T00:01:00.900Z');
    const checkoutDraft = await service.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: checkout.transactionId,
      userReference: 'user_1',
      nonce: 'payment_lineage_checkout',
      issuedAt: '2030-01-01T00:01:00.900Z',
      expiresAt: '2030-01-01T00:10:00.100Z',
    });
    const payment = (nonce: string, issuedAt: string, expiresAt: string) => service.createPaymentMandateDraft({
      transactionId: checkout.transactionId,
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: checkoutDraft.id,
      payee: { id: 'merchant_1', name: 'Merchant', website: 'https://merchant.example' },
      paymentAmount: { amountMinor: 100, currency: 'USD' },
      paymentInstrument: { id: 'instrument_1', type: 'card', descriptionMasked: 'Card •••• 1234' },
      userReference: 'user_1',
      nonce,
      issuedAt,
      expiresAt,
    });

    const exact = await payment(
      'payment_lineage_exact',
      '2030-01-01T00:01:00.900Z',
      '2030-01-01T00:10:00.100Z',
    );
    const narrow = await payment(
      'payment_lineage_narrow',
      '2030-01-01T00:01:01.100Z',
      '2030-01-01T00:09:59.900Z',
    );
    await expect(payment(
      'payment_lineage_before',
      '2030-01-01T00:01:00.100Z',
      '2030-01-01T00:10:00.100Z',
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    await expect(payment(
      'payment_lineage_after',
      '2030-01-01T00:01:00.900Z',
      '2030-01-01T00:10:00.900Z',
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    const writesBeforeCorruptCheckout = replayStore.paymentWrites;
    replayStore.mutate = (record) => ({ ...record, issuedAt: 'not-a-date' });
    await expect(payment(
      'payment_corrupt_checkout_issued',
      '2030-01-01T00:01:00.900Z',
      '2030-01-01T00:10:00.100Z',
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutate = (record) => ({ ...record, expiresAt: 'not-a-date' });
    await expect(payment(
      'payment_corrupt_checkout_expires',
      '2030-01-01T00:01:00.900Z',
      '2030-01-01T00:10:00.100Z',
    )).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    expect(replayStore.paymentWrites).toBe(writesBeforeCorruptCheckout);
    replayStore.mutate = (record) => record;

    const verify = (candidate: typeof exact) => service.verifyDraftConsistency({
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: checkout.transactionId,
      draft: candidate.unsignedMandatePayload,
      expectedUserReference: 'user_1',
    });
    await expect(verify(exact)).resolves.toMatchObject({ valid: true });
    await expect(verify(narrow)).resolves.toMatchObject({ valid: true });

    replayStore.mutate = (record) => ({ ...record, issuedAt: 'not-a-date' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutate = (record) => ({ ...record, expiresAt: 'not-a-date' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutate = (record) => record;

    replayStore.mutatePayment = (record) => ({ ...record, issuedAt: '2030-01-01T00:01:00.100Z' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutatePayment = (record) => ({ ...record, expiresAt: '2030-01-01T00:10:00.900Z' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutatePayment = (record) => ({ ...record, issuedAt: 'not-a-date' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });
    replayStore.mutatePayment = (record) => ({ ...record, expiresAt: 'not-a-date' });
    await expect(verify(exact)).rejects.toMatchObject({ code: 'DRAFT_LINEAGE' });

    replayStore.mutatePayment = (record) => record;
    await expect(verify(exact)).resolves.toMatchObject({ valid: true });
    await expect(verify(narrow)).resolves.toMatchObject({ valid: true });
  });
});

describe('round 2: zero evidence hashes', () => {
  it('rejects all six zero fields in hex/base64url before enqueue and anchor, while accepting valid hashes', async () => {
    const fields: Array<keyof Omit<MandateAnchorEvidence, 'mandateType'>> = [
      'closedCheckoutHash',
      'closedPaymentHash',
      'checkoutHash',
      'transactionIdHash',
      'agentIdHash',
      'policyVersionHash',
    ];
    const sha = (value: string) => createHash('sha256').update(value).digest('base64url');
    const base64Evidence: MandateAnchorEvidence = {
      closedCheckoutHash: sha('closed_checkout'),
      closedPaymentHash: sha('closed_payment'),
      checkoutHash: sha('checkout'),
      transactionIdHash: sha('transaction'),
      agentIdHash: sha('agent'),
      policyVersionHash: sha('policy'),
      mandateType: 1,
    };
    const hexEvidence: MandateAnchorEvidence = {
      closedCheckoutHash: `0x${'11'.repeat(32)}`,
      closedPaymentHash: `0x${'22'.repeat(32)}`,
      checkoutHash: `0x${'33'.repeat(32)}`,
      transactionIdHash: `0x${'44'.repeat(32)}`,
      agentIdHash: `0x${'55'.repeat(32)}`,
      policyVersionHash: `0x${'66'.repeat(32)}`,
      mandateType: 1,
    };
    const representations = [
      { valid: base64Evidence, zero: Buffer.alloc(32).toString('base64url') },
      { valid: hexEvidence, zero: `0x${'00'.repeat(32)}` },
    ];
    for (const representation of representations) {
      const outbox = new InMemoryMandateAnchorOutbox();
      const client = new FakeMandateAnchorClient();
      expect(isStrictEvidenceHash(representation.zero)).toBe(false);
      for (const field of fields) {
        const zeroEvidence = { ...representation.valid, [field]: representation.zero };
        await expect(outbox.enqueue(zeroEvidence), `${field} enqueue`).rejects.toMatchObject({ code: 'ANCHOR_EVIDENCE' });
        await expect(client.anchor(zeroEvidence), `${field} anchor`).rejects.toMatchObject({ code: 'ANCHOR_EVIDENCE' });
      }
      await expect(outbox.enqueue(representation.valid)).resolves.toMatchObject({ status: 'pending' });
      await expect(client.anchor(representation.valid)).resolves.toMatchObject({ txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
      expect(isStrictEvidenceHash(representation.valid.checkoutHash)).toBe(true);
    }
  });
});
