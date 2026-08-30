import { calculateJwkThumbprint } from 'jose';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, verifyTypedData, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { InMemoryOpenMandateRegistry } from '../src/mandates/autonomy.js';
import {
  Eip712TrustedSurfaceService,
  InMemoryTrustedSurfaceApprovalStore,
  mandateApprovalTypes,
  type Eip712ApprovalChallenge,
  type Eip712ApprovalProof,
  type TrustedSurfaceApprovalStore,
  type TypedDataVerifier,
} from '../src/mandates/trusted-surface.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945388d2b4e6f6837b2c5cf6ddf72f146d3a24');
const agentPublicKeyJwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'x', y: 'y' };

async function subject(overrides: {
  mandateJwk?: JsonWebKey;
  enrollmentThumbprint?: string;
  serviceNow?: Date;
  mandateIssuedAt?: string;
  clockSkewMs?: number;
  approvalStore?: TrustedSurfaceApprovalStore;
  verifier?: TypedDataVerifier;
} = {}) {
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
    issuedAt: overrides.mandateIssuedAt ?? now.toISOString(), expiresAt: '2030-01-01T01:00:00.000Z', audience: 'credential-provider', nonce: 'mandate_nonce',
  });
  const service = new Eip712TrustedSurfaceService({
    repo, registry, approvalStore: overrides.approvalStore ?? new InMemoryTrustedSurfaceApprovalStore(), chainId: 84532,
    now: () => overrides.serviceNow ?? now,
    clockSkewMs: overrides.clockSkewMs,
    verifier: overrides.verifier ?? { verify: ({ address, domain, message, signature }) => verifyTypedData({ address, domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message, signature }) },
  });
  return { service, mandate, registry };
}

class MutatingApprovalStore implements TrustedSurfaceApprovalStore {
  private readonly base = new InMemoryTrustedSurfaceApprovalStore();
  mutate: (challenge: Eip712ApprovalChallenge) => Eip712ApprovalChallenge = (challenge) => challenge;

  create(challenge: Eip712ApprovalChallenge): Promise<Eip712ApprovalChallenge> {
    return this.base.create(challenge);
  }

  async get(id: string): Promise<Eip712ApprovalChallenge> {
    return this.mutate(await this.base.get(id));
  }

  consume(input: Eip712ApprovalProof, at: Date): Promise<Eip712ApprovalProof> {
    return this.base.consume(input, at);
  }
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

  it('canonicalizes stored timestamps to the signed seconds and preserves a real valid signature', async () => {
    const serviceNow = new Date('2030-01-01T00:00:00.500Z');
    const { service, mandate } = await subject({ serviceNow });
    const { challenge, typedData } = await service.createApprovalChallenge({
      openMandateId: mandate.id,
      ownerAddress: account.address,
    });
    expect(BigInt(Date.parse(challenge.issuedAt))).toBe(challenge.message.issuedAt * 1000n);
    expect(BigInt(Date.parse(challenge.expiresAt))).toBe(challenge.message.expiresAt * 1000n);
    expect(challenge.issuedAt).toBe('2030-01-01T00:00:00.000Z');
    expect(challenge.expiresAt).toBe('2030-01-01T00:05:00.000Z');

    const signature = await account.signTypedData(typedData);
    await expect(service.verifyAndRecordApproval({
      challengeId: challenge.id,
      ownerAddress: account.address,
      signature,
    })).resolves.toMatchObject({ mandate: { status: 'active' } });
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

  it('rejects challenge creation before mandate issuedAt even within skew and validates skew config', async () => {
    const { service, mandate } = await subject({
      mandateIssuedAt: new Date(now.getTime() + 1).toISOString(),
      clockSkewMs: 5_000,
    });
    await expect(service.createApprovalChallenge({
      openMandateId: mandate.id,
      ownerAddress: account.address,
    })).rejects.toMatchObject({ code: 'OPEN_MANDATE_NOT_YET_VALID' });
    await expect(subject({ clockSkewMs: -1 })).rejects.toMatchObject({ code: 'APPROVAL_CONFIG' });
  });

  const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca3a545d267e77a2c006e5739124230ceaf24c879e06c8');
  const mutations: Array<{
    label: string;
    expectedCode?: string;
    mutate: (challenge: Eip712ApprovalChallenge) => Eip712ApprovalChallenge;
  }> = [
    { label: 'domain name', mutate: (value) => ({ ...value, domain: { ...value.domain, name: 'Attacker' } }) },
    { label: 'domain extra field', mutate: (value) => ({ ...value, domain: { ...value.domain, salt: `0x${'11'.repeat(32)}` } }) },
    { label: 'mandateHash', mutate: (value) => ({ ...value, message: { ...value.message, mandateHash: `0x${'11'.repeat(32)}` } }) },
    { label: 'userReferenceHash', mutate: (value) => ({ ...value, message: { ...value.message, userReferenceHash: `0x${'22'.repeat(32)}` } }) },
    { label: 'agentIdHash', mutate: (value) => ({ ...value, message: { ...value.message, agentIdHash: `0x${'33'.repeat(32)}` } }) },
    { label: 'nonceHash', mutate: (value) => ({ ...value, message: { ...value.message, nonceHash: `0x${'44'.repeat(32)}` } }) },
    { label: 'message issuedAt', mutate: (value) => ({ ...value, message: { ...value.message, issuedAt: value.message.issuedAt + 1n } }) },
    { label: 'message expiresAt', mutate: (value) => ({ ...value, message: { ...value.message, expiresAt: value.message.expiresAt + 1n } }) },
    { label: 'nonce', mutate: (value) => ({ ...value, nonce: `${value.nonce}_mutated` }) },
    { label: 'challenge issuedAt', mutate: (value) => ({ ...value, issuedAt: new Date(Date.parse(value.issuedAt) + 1_000).toISOString() }) },
    { label: 'challenge expiresAt', mutate: (value) => ({ ...value, expiresAt: new Date(Date.parse(value.expiresAt) + 1_000).toISOString() }) },
    { label: 'challenge issuedAt sub-second', mutate: (value) => ({ ...value, issuedAt: new Date(Date.parse(value.issuedAt) + 500).toISOString() }) },
    { label: 'challenge expiresAt sub-second', mutate: (value) => ({ ...value, expiresAt: new Date(Date.parse(value.expiresAt) + 500).toISOString() }) },
    { label: 'expectedPayloadHash', mutate: (value) => ({ ...value, expectedPayloadHash: 'A'.repeat(43) }) },
    { label: 'openMandateId', mutate: (value) => ({ ...value, openMandateId: 'open_missing' }) },
    {
      label: 'ownerAddress',
      expectedCode: 'APPROVAL_SUBJECT',
      mutate: (value) => ({ ...value, ownerAddress: getAddress(other.address) as `0x${string}` }),
    },
    { label: 'chainId', mutate: (value) => ({ ...value, chainId: 8453 }) },
  ];

  it.each(mutations)('rejects mutated $label before consulting an always-true verifier', async (item) => {
    const store = new MutatingApprovalStore();
    const verify = vi.fn(async () => true);
    const { service, mandate } = await subject({ approvalStore: store, verifier: { verify } });
    const { challenge } = await service.createApprovalChallenge({
      openMandateId: mandate.id,
      ownerAddress: account.address,
    });
    store.mutate = item.mutate;
    await expect(service.verifyAndRecordApproval({
      challengeId: challenge.id,
      ownerAddress: account.address,
      signature: '0x01',
    })).rejects.toMatchObject({ code: item.expectedCode ?? 'APPROVAL_INTEGRITY' });
    expect(verify).not.toHaveBeenCalled();
  });
});
