import { createHash } from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { describe, expect, it } from 'vitest';
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
  InMemoryOpenMandateRegistry,
  MandateAnchorWorker,
  type OpenMandateConstraints,
} from '../src/mandates/index.js';
import {
  Eip712TrustedSurfaceService,
  InMemoryTrustedSurfaceApprovalStore,
  mandateApprovalTypes,
} from '../src/mandates/trusted-surface.js';
import { createMandatesFromFile } from '../scripts/mandates-create.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const now = new Date('2030-01-01T00:00:00.000Z');
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945388d2b4e6f6837b2c5cf6ddf72f146d3a24');
const audience = 'credential-provider';

function constraints(overrides: Partial<OpenMandateConstraints> = {}): OpenMandateConstraints {
  return {
    merchantIds: ['merchant_001'],
    payeeIds: ['merchant_001'],
    maxQuantityPerProduct: 10,
    minAmountMinor: 1,
    maxAmountMinor: 5000,
    currency: 'USD',
    totalBudgetMinor: 10_000,
    maxOperations: 10,
    frequencyWindowSeconds: 3600,
    maxOperationsPerWindow: 10,
    paymentInstrumentAlias: 'instrument_1',
    ...overrides,
  };
}

describe('AP2 safe-path integration', () => {
  it('authorized immutable open mandates → policy reservation → agent-signed closed hashes → fake anchor, plus CLI draft path', async () => {
    const agentSigner = await createTestAgentMandateSigner('test');
    const thumbprint = await calculateJwkThumbprint(agentSigner.publicKeyJwk, 'sha256');
    const repo = new InMemoryRepository();
    await repo.withLock((store) => {
      store.principals.push({
        id: 'principal_1', ownerAddress: account.address, kycStatus: 'verified',
        kycExpiresAt: '2031-01-01T00:00:00.000Z', createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      store.enrollments.push({
        agentUuid: 'agent_1', deviceCode: 'device_1', principalId: 'principal_1', status: 'bound',
        publicJwk: agentSigner.publicKeyJwk, thumbprint,
        keystoreProvider: 'os_hardware', agentUriPath: '/agents/agent_1',
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      store.credentials.push({
        id: 'credential_1', agentUuid: 'agent_1', principalId: 'principal_1', thumbprint,
        agentRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: '1', owner: account.address,
        status: 'active', statusRef: 'local', issuedAt: now.toISOString(), expiresAt: '2031-01-01T00:00:00.000Z', jti: 'jti_1',
      });
    });

    const merchant = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test' });
    const mandateService = createMandateService({
      merchantSigner: merchant,
      replayStore: new InMemoryMandateReplayStore(),
      now: () => now,
    });
    const checkout = await mandateService.createMerchantCheckout({
      transactionId: 'txn_safe_1',
      merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
      lineItems: [{ productId: 'product_001', title: 'Product', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
      totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
      issuedAt: now.toISOString(),
      expiresAt: '2030-01-01T00:10:00.000Z',
      source: { type: 'manual', requestId: 'req_safe' },
    });

    const registry = new InMemoryOpenMandateRegistry();
    const openCheckout = registry.create({
      type: 'checkout', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints(),
      issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'open_checkout',
    });
    const openPayment = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints(),
      issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'open_payment',
    });

    const approvalStore = new InMemoryTrustedSurfaceApprovalStore();
    const trustedSurface = new Eip712TrustedSurfaceService({
      repo, registry, approvalStore, chainId: 84532, now: () => now,
      verifier: {
        verify: ({ address, domain, message, signature }) => verifyTypedData({
          address, domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message, signature,
        }),
      },
    });

    for (const mandate of [openCheckout, openPayment]) {
      const { challenge, typedData } = await trustedSurface.createApprovalChallenge({
        openMandateId: mandate.id, ownerAddress: account.address,
      });
      const signature = await account.signTypedData(typedData);
      const approved = await trustedSurface.verifyAndRecordApproval({
        challengeId: challenge.id, ownerAddress: account.address, signature,
      });
      expect(approved.mandate.status).toBe('active');
      expect(approved.mandate.canonicalPayloadHash).toBe(mandate.canonicalPayloadHash);
    }

    const closed = await createAutonomousClosedMandates({
      openCheckoutMandateId: openCheckout.id,
      openPaymentMandateId: openPayment.id,
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
      agentTrustVerifier: {
        verifyAgent: async () => ({
          allowed: true, agentStatus: 'bound', attestationStatus: 'valid', keyBindingStatus: 'bound',
          riskLevel: 'low', revocationStatus: 'active', policyVersion: 'v1', reasons: [],
        }),
      },
      agentSigner,
      policyLedger: new InMemoryMandatePolicyLedger(),
      now: () => now,
    });
    expect(closed.status).toBe('verified');
    expect(closed.closedCheckoutHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(closed.closedPaymentHash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const outbox = new InMemoryMandateAnchorOutbox();
    const client = new FakeMandateAnchorClient();
    const worker = new MandateAnchorWorker(outbox, client);
    await outbox.enqueue({
      closedCheckoutHash: closed.closedCheckoutHash,
      closedPaymentHash: closed.closedPaymentHash,
      checkoutHash: checkout.checkoutHash,
      transactionIdHash: createHash('sha256').update(checkout.transactionId).digest('base64url'),
      agentIdHash: createHash('sha256').update('agent_1').digest('base64url'),
      policyVersionHash: createHash('sha256').update('v1').digest('base64url'),
      mandateType: 1,
    });
    const anchored = await worker.processOnce();
    expect(anchored?.status).toBe('anchored');
    expect(client.anchored).toHaveLength(1);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'mandates-e2e-'));
    try {
      const fixturePath = path.join(dir, 'checkout.json');
      await writeFile(fixturePath, JSON.stringify({
        transactionId: 'txn_cli_1',
        merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
        lineItems: [{ productId: 'product_001', title: 'Product', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
        totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
        issuedAt: now.toISOString(),
        expiresAt: '2030-01-01T00:10:00.000Z',
        source: { type: 'manual', requestId: 'req_cli' },
        userReference: 'user_1',
        checkoutMandate: { nonce: 'cli_checkout', issuedAt: now.toISOString(), expiresAt: '2030-01-01T00:10:00.000Z' },
        paymentMandate: {
          checkoutNonce: 'cli_payment',
          issuedAt: now.toISOString(),
          expiresAt: '2030-01-01T00:10:00.000Z',
          payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
          paymentAmount: { amountMinor: 50, currency: 'USD' },
          paymentInstrument: { id: 'instrument_1', type: 'card', descriptionMasked: 'Card •••• 1234' },
        },
      }));
      const cli = await createMandatesFromFile(fixturePath, { NODE_ENV: 'test' });
      expect(cli.checkoutDraft.mandateType).toBe('checkout');
      expect(cli.paymentDraft?.mandateType).toBe('payment');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
