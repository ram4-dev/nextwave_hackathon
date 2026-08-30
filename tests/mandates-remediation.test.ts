import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRepository } from '../src/persistence/repository.js';
import {
  createAutonomousClosedMandates,
  createLocalMerchantSigner,
  createMandateService,
  createTestAgentMandateSigner,
  FakeMandateAnchorClient,
  InMemoryMandateAnchorOutbox,
  InMemoryMandatePolicyLedger,
  InMemoryMandateReplayStore,
  InMemoryMandateRequestStore,
  InMemoryOpenMandateRegistry,
  MandateAnchorWorker,
  openMandatePayloadHash,
  receiveMandateRequest,
  type OpenMandateConstraints,
} from '../src/mandates/index.js';
import {
  Eip712TrustedSurfaceService,
  InMemoryTrustedSurfaceApprovalStore,
  mandateApprovalTypes,
} from '../src/mandates/trusted-surface.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945388d2b4e6f6837b2c5cf6ddf72f146d3a24');
const audience = 'credential-provider';

function constraints(overrides: Partial<OpenMandateConstraints> = {}): OpenMandateConstraints {
  return {
    merchantIds: ['merchant_001'],
    payeeIds: ['merchant_001'],
    maxQuantityPerProduct: 10,
    minAmountMinor: 1,
    maxAmountMinor: 100,
    currency: 'USD',
    totalBudgetMinor: 100,
    maxOperations: 2,
    frequencyWindowSeconds: 3600,
    maxOperationsPerWindow: 2,
    paymentInstrumentAlias: 'instrument_1',
    ...overrides,
  };
}

async function seededRepo() {
  const repo = new InMemoryRepository();
  await repo.withLock((store) => {
    store.principals.push({
      id: 'principal_1', ownerAddress: account.address, kycStatus: 'verified',
      kycExpiresAt: '2031-01-01T00:00:00.000Z', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    store.enrollments.push({
      agentUuid: 'agent_1', deviceCode: 'device_1', principalId: 'principal_1', status: 'bound',
      publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, thumbprint: 'thumbprint',
      keystoreProvider: 'os_hardware', agentUriPath: '/agents/agent_1',
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    });
    store.credentials.push({
      id: 'credential_1', agentUuid: 'agent_1', principalId: 'principal_1', thumbprint: 'thumbprint',
      agentRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: '1', owner: account.address,
      status: 'active', statusRef: 'local', issuedAt: now.toISOString(), expiresAt: '2031-01-01T00:00:00.000Z', jti: 'jti_1',
    });
  });
  return repo;
}

describe('EIP-712 Trusted Surface', () => {
  it('binds an active KYA principal to a one-time EIP-712 mandate approval', async () => {
    const repo = await seededRepo();
    const registry = new InMemoryOpenMandateRegistry();
    const mandate = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      constraints: constraints(), issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z',
      audience, nonce: 'mandate_nonce',
    });
    const service = new Eip712TrustedSurfaceService({
      repo, registry, approvalStore: new InMemoryTrustedSurfaceApprovalStore(), chainId: 84532, now: () => now,
      verifier: {
        verify: ({ address, domain, message, signature }) => verifyTypedData({
          address, domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message, signature,
        }),
      },
    });
    const { challenge, typedData } = await service.createApprovalChallenge({ openMandateId: mandate.id, ownerAddress: account.address });
    const signature = await account.signTypedData(typedData);
    const approved = await service.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: account.address, signature });
    expect(approved.mandate.status).toBe('active');
    expect(approved.mandate.activationProof?.payloadHash).toBe(mandate.canonicalPayloadHash);
    await expect(service.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: account.address, signature }))
      .rejects.toMatchObject({ code: 'APPROVAL_REPLAY' });
  });

  it('rejects a signature from another wallet', async () => {
    const repo = await seededRepo();
    const registry = new InMemoryOpenMandateRegistry();
    const mandate = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      constraints: constraints(), issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z',
      audience, nonce: 'mandate_nonce',
    });
    const service = new Eip712TrustedSurfaceService({
      repo, registry, approvalStore: new InMemoryTrustedSurfaceApprovalStore(), chainId: 84532, now: () => now,
      verifier: {
        verify: ({ address, domain, message, signature }) => verifyTypedData({
          address, domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message, signature,
        }),
      },
    });
    const { challenge, typedData } = await service.createApprovalChallenge({ openMandateId: mandate.id, ownerAddress: account.address });
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca3a545d267e77a2c006e5739124230ceaf24c879e06c8');
    await expect(service.verifyAndRecordApproval({
      challengeId: challenge.id, ownerAddress: account.address, signature: await other.signTypedData(typedData) as Hex,
    })).rejects.toMatchObject({ code: 'APPROVAL_SIGNATURE' });
  });

  it('rejects activation when a limit signed as 100 is mutated to 999999', async () => {
    const registry = new InMemoryOpenMandateRegistry();
    const mutableConstraints = constraints({ maxAmountMinor: 100, totalBudgetMinor: 100 });
    const mandate = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      constraints: mutableConstraints, issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z',
      audience, nonce: 'mandate_nonce',
    });
    const signedHash = mandate.canonicalPayloadHash;
    mutableConstraints.maxAmountMinor = 999999;
    mutableConstraints.totalBudgetMinor = 999999;
    await expect(registry.activateWithVerifiedSignature({
      id: mandate.id,
      signature: '0xsigned',
      expectedPayloadHash: openMandatePayloadHash({
        ...mandate,
        constraints: { ...mandate.constraints, maxAmountMinor: 999999, totalBudgetMinor: 999999 },
      }),
      verifier: { verify: async () => true },
      now,
    })).rejects.toMatchObject({ code: 'OPEN_MANDATE_HASH' });
    await expect(registry.activateWithVerifiedSignature({
      id: mandate.id,
      signature: '0xsigned',
      expectedPayloadHash: signedHash,
      verifier: { verify: async () => true },
      now,
    })).resolves.toMatchObject({ status: 'active', canonicalPayloadHash: signedHash, constraints: { maxAmountMinor: 100 } });
  });
});

describe('policy ledger global budgets', () => {
  it('rejects 60+60 against a 100 budget even when the counterpart mandate changes', async () => {
    const ledger = new InMemoryMandatePolicyLedger();
    const checkoutConstraints = constraints({ totalBudgetMinor: 100, maxOperations: 10, maxOperationsPerWindow: 10 });
    const paymentA = constraints({ totalBudgetMinor: 100, maxOperations: 10, maxOperationsPerWindow: 10 });
    const paymentB = constraints({ totalBudgetMinor: 100, maxOperations: 10, maxOperationsPerWindow: 10 });
    await ledger.reserve({
      checkoutMandateId: 'checkout_1', paymentMandateId: 'payment_a', transactionId: 'txn_a',
      amountMinor: 60, now, checkoutConstraints, paymentConstraints: paymentA,
    });
    await expect(ledger.reserve({
      checkoutMandateId: 'checkout_1', paymentMandateId: 'payment_b', transactionId: 'txn_b',
      amountMinor: 60, now, checkoutConstraints, paymentConstraints: paymentB,
    })).rejects.toMatchObject({ code: 'POLICY_BUDGET' });
  });

  it('enforces operation and frequency limits independently per mandate', async () => {
    const ledger = new InMemoryMandatePolicyLedger();
    const checkoutConstraints = constraints({
      totalBudgetMinor: 10_000, maxOperations: 1, maxOperationsPerWindow: 1, frequencyWindowSeconds: 3600,
    });
    const paymentConstraints = constraints({
      totalBudgetMinor: 10_000, maxOperations: 10, maxOperationsPerWindow: 10, frequencyWindowSeconds: 3600,
    });
    await ledger.reserve({
      checkoutMandateId: 'checkout_ops', paymentMandateId: 'payment_1', transactionId: 'txn_1',
      amountMinor: 10, now, checkoutConstraints, paymentConstraints,
    });
    await expect(ledger.reserve({
      checkoutMandateId: 'checkout_ops', paymentMandateId: 'payment_2', transactionId: 'txn_2',
      amountMinor: 10, now, checkoutConstraints, paymentConstraints,
    })).rejects.toMatchObject({ code: 'POLICY_OPERATIONS' });
  });
});

describe('autonomy provenance', () => {
  it('rejects fabricated active open mandate records and mismatched subjects', async () => {
    const registry = new InMemoryOpenMandateRegistry();
    const merchant = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test' });
    const agentSigner = await createTestAgentMandateSigner('test');
    const service = createMandateService({
      merchantSigner: merchant,
      replayStore: new InMemoryMandateReplayStore(),
      now: () => now,
    });
    const checkoutInput = {
      transactionId: 'txn_auto_1',
      merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
      lineItems: [{ productId: 'product_001', title: 'Product', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
      totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
      issuedAt: now.toISOString(), expiresAt: '2030-01-01T00:10:00.000Z',
      source: { type: 'manual' as const, requestId: 'req_1' },
    };
    const checkout = await service.createMerchantCheckout(checkoutInput);

    await expect(createAutonomousClosedMandates({
      openCheckoutMandateId: 'fabricated',
      openPaymentMandateId: 'fabricated_payment',
      registry,
      userReference: 'user_1',
      audience,
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: checkout.transactionId,
      agentIdentity: { agentId: 'agent_1', tenantId: 'tenant_1' },
      agentKeyReference: agentSigner.keyId,
      paymentInstrumentAlias: 'instrument_1',
      payeeId: 'merchant_001',
      merchantSigner: merchant,
      agentTrustVerifier: { verifyAgent: async () => ({
        allowed: true, agentStatus: 'bound', attestationStatus: 'valid', keyBindingStatus: 'bound',
        riskLevel: 'low', revocationStatus: 'active', policyVersion: 'v1', reasons: [],
      }) },
      agentSigner,
      policyLedger: new InMemoryMandatePolicyLedger(),
      now: () => now,
    })).rejects.toMatchObject({ code: 'OPEN_MANDATE_NOT_FOUND' });

    const checkoutMandate = registry.create({
      type: 'checkout', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints({ maxAmountMinor: 100, totalBudgetMinor: 100 }),
      issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'c1',
    });
    await registry.activateWithVerifiedSignature({
      id: checkoutMandate.id, signature: '0x1', expectedPayloadHash: checkoutMandate.canonicalPayloadHash,
      verifier: { verify: async () => true }, now,
    });
    const paymentMandate = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints({ maxAmountMinor: 100, totalBudgetMinor: 100 }),
      issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'p1',
    });
    await registry.activateWithVerifiedSignature({
      id: paymentMandate.id, signature: '0x2', expectedPayloadHash: paymentMandate.canonicalPayloadHash,
      verifier: { verify: async () => true }, now,
    });

    await expect(createAutonomousClosedMandates({
      openCheckoutMandateId: checkoutMandate.id,
      openPaymentMandateId: paymentMandate.id,
      registry,
      userReference: 'other_user',
      audience,
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: checkout.transactionId,
      agentIdentity: { agentId: 'agent_1', tenantId: 'tenant_1' },
      agentKeyReference: agentSigner.keyId,
      paymentInstrumentAlias: 'instrument_1',
      payeeId: 'merchant_001',
      merchantSigner: merchant,
      agentTrustVerifier: { verifyAgent: async () => ({
        allowed: true, agentStatus: 'bound', attestationStatus: 'valid', keyBindingStatus: 'bound',
        riskLevel: 'low', revocationStatus: 'active', policyVersion: 'v1', reasons: [],
      }) },
      agentSigner,
      policyLedger: new InMemoryMandatePolicyLedger(),
      now: () => now,
    })).rejects.toMatchObject({ code: 'OPEN_MANDATE_USER' });

    registry.revoke(paymentMandate.id);
    await expect(createAutonomousClosedMandates({
      openCheckoutMandateId: checkoutMandate.id,
      openPaymentMandateId: paymentMandate.id,
      registry,
      userReference: 'user_1',
      audience,
      checkoutJwt: checkout.checkoutJwt,
      checkoutHash: checkout.checkoutHash,
      transactionId: checkout.transactionId,
      agentIdentity: { agentId: 'agent_1', tenantId: 'tenant_1' },
      agentKeyReference: agentSigner.keyId,
      paymentInstrumentAlias: 'instrument_1',
      payeeId: 'merchant_001',
      merchantSigner: merchant,
      agentTrustVerifier: { verifyAgent: async () => ({
        allowed: true, agentStatus: 'bound', attestationStatus: 'valid', keyBindingStatus: 'bound',
        riskLevel: 'low', revocationStatus: 'active', policyVersion: 'v1', reasons: [],
      }) },
      agentSigner,
      policyLedger: new InMemoryMandatePolicyLedger(),
      now: () => now,
    })).rejects.toMatchObject({ code: 'OPEN_MANDATE_INACTIVE' });
  });
});

describe('prompt hash-only persistence', () => {
  it('never passes plaintext prompt into the store boundary', async () => {
    const store = new InMemoryMandateRequestStore();
    const createSpy = vi.spyOn(store, 'create');
    const record = await receiveMandateRequest(store, {
      transactionId: 'txn_prompt',
      agentId: 'agent_1',
      tenantId: 'tenant_1',
      prompt: 'buy me something secret',
      encryptedPromptRef: 'enc_ref_1',
    });
    expect(record.promptHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record).not.toHaveProperty('prompt');
    expect(createSpy.mock.calls[0]?.[0]).not.toHaveProperty('prompt');
    expect(store.debugDump()[0]).not.toHaveProperty('prompt');
    expect(JSON.stringify(store.debugDump())).not.toContain('buy me something secret');
  });

  it('migration SQL does not define a plaintext prompt column or RPC arg', async () => {
    const sql = await readFile(path.join(process.cwd(), 'supabase/migrations/20260830_create_mandate_requests.sql'), 'utf8');
    expect(sql).toContain('prompt_hash');
    expect(sql).toContain('encrypted_prompt_ref');
    expect(sql).not.toMatch(/\bp_prompt\b/);
    expect(sql).not.toMatch(/^\s*prompt\s+text/m);
  });
});

describe('hash-only anchor outbox worker', () => {
  it('enqueues idempotently and anchors via an injectable fake client', async () => {
    const outbox = new InMemoryMandateAnchorOutbox();
    const client = new FakeMandateAnchorClient();
    const worker = new MandateAnchorWorker(outbox, client);
    const evidence = {
      closedCheckoutHash: createHash('sha256').update('c').digest('base64url'),
      closedPaymentHash: createHash('sha256').update('p').digest('base64url'),
      checkoutHash: createHash('sha256').update('checkout').digest('base64url'),
      transactionIdHash: createHash('sha256').update('txn').digest('base64url'),
      agentIdHash: createHash('sha256').update('agent').digest('base64url'),
      policyVersionHash: createHash('sha256').update('policy').digest('base64url'),
      mandateType: 1,
    };
    const first = await outbox.enqueue(evidence);
    const second = await outbox.enqueue(evidence);
    expect(second.id).toBe(first.id);
    const processed = await worker.processOnce();
    expect(processed?.status).toBe('anchored');
    expect(client.anchored).toHaveLength(1);
    await expect(outbox.enqueue({ ...evidence, closedCheckoutHash: 'notahashwithnospacesbutinvalidlen' }))
      .rejects.toMatchObject({ code: 'ANCHOR_EVIDENCE' });
  });
});
