import { calculateJwkThumbprint } from 'jose';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { InMemoryOpenMandateRegistry } from '../src/mandates/autonomy.js';
import {
  Eip712TrustedSurfaceService,
  InMemoryTrustedSurfaceApprovalStore,
  mandateApprovalTypes,
} from '../src/mandates/trusted-surface.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945388d2b4e6f6837b2c5cf6ddf72f146d3a24');
const agentPublicKeyJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' };

async function subject(overrides: { mandateJwk?: JsonWebKey; enrollmentThumbprint?: string } = {}) {
  const jwk = overrides.mandateJwk ?? agentPublicKeyJwk;
  const thumbprint = overrides.enrollmentThumbprint ?? await calculateJwkThumbprint(jwk, 'sha256');
  const repo = new InMemoryRepository();
  await repo.withLock((store) => {
    store.principals.push({ id: 'principal_1', ownerAddress: account.address, kycStatus: 'verified', kycExpiresAt: '2031-01-01T00:00:00.000Z', createdAt: now.toISOString(), updatedAt: now.toISOString() });
    store.enrollments.push({ agentUuid: 'agent_1', deviceCode: 'device_1', principalId: 'principal_1', status: 'bound', publicJwk: jwk, thumbprint, keystoreProvider: 'os_hardware', agentUriPath: '/agents/agent_1', createdAt: now.toISOString(), updatedAt: now.toISOString() });
    store.credentials.push({ id: 'credential_1', agentUuid: 'agent_1', principalId: 'principal_1', thumbprint, agentRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: '1', owner: account.address, status: 'active', statusRef: 'local', issuedAt: now.toISOString(), expiresAt: '2031-01-01T00:00:00.000Z', jti: 'jti_1' });
  });
  const registry = new InMemoryOpenMandateRegistry();
  const mandate = registry.create({
    type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
    agentPublicKeyJwk: jwk,
    constraints: {
      merchantIds: ['merchant_1'], payeeIds: ['merchant_1'], maxQuantityPerProduct: 1, minAmountMinor: 1, maxAmountMinor: 1000,
      currency: 'USD', totalBudgetMinor: 1000, maxOperations: 1, frequencyWindowSeconds: 60, maxOperationsPerWindow: 1,
      paymentInstrumentAlias: 'instrument_1',
    },
    issuedAt: now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z', audience: 'credential-provider', nonce: 'mandate_nonce',
  });
  const service = new Eip712TrustedSurfaceService({
    repo, registry, approvalStore: new InMemoryTrustedSurfaceApprovalStore(), chainId: 84532, now: () => now,
    verifier: { verify: ({ address, domain, message, signature }) => verifyTypedData({ address, domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message, signature }) },
  });
  return { service, mandate, registry };
}

describe('EIP-712 Trusted Surface', () => {
  it('binds an active KYA principal to a one-time EIP-712 mandate approval', async () => {
    const { service, mandate } = await subject();
    const { challenge, typedData } = await service.createApprovalChallenge({ openMandateId: mandate.id, ownerAddress: account.address });
    const signature = await account.signTypedData(typedData);
    const approved = await service.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: account.address, signature });
    expect(approved.mandate.status).toBe('active');
    await expect(service.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: account.address, signature })).rejects.toMatchObject({ code: 'APPROVAL_REPLAY' });
  });

  it('rejects a signature from another wallet', async () => {
    const { service, mandate } = await subject();
    const { challenge, typedData } = await service.createApprovalChallenge({ openMandateId: mandate.id, ownerAddress: account.address });
    const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca3a545d267e77a2c006e5739124230ceaf24c879e06c8');
    await expect(service.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: account.address, signature: await other.signTypedData(typedData) as Hex })).rejects.toMatchObject({ code: 'APPROVAL_SIGNATURE' });
  });

  it('rejects challenge creation when mandate cnf thumbprint differs from enrollment', async () => {
    const mismatchedJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'otherx', y: 'othery' };
    const enrollmentThumbprint = await calculateJwkThumbprint(agentPublicKeyJwk, 'sha256');
    const { service, mandate } = await subject({
      mandateJwk: mismatchedJwk,
      enrollmentThumbprint,
    });
    await expect(service.createApprovalChallenge({
      openMandateId: mandate.id,
      ownerAddress: account.address,
    })).rejects.toMatchObject({ code: 'APPROVAL_KEY_THUMBPRINT' });
  });
});
