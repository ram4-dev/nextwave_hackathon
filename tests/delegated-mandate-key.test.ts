import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { KyaAgentTrustVerifier } from '../src/mandates/agent-trust.js';
import { InMemoryRepository } from '../src/persistence/repository.js';

describe('delegated mandate signing key', () => {
  it('accepts a separate key explicitly bound to the KYA agent and rejects the identity key', async () => {
    const identity = await generateKeyPair('ES256', { extractable: true });
    const mandate = await generateKeyPair('ES256', { extractable: true });
    const identityPublicJwk = await exportJWK(identity.publicKey);
    const mandatePublicJwk = await exportJWK(mandate.publicKey);
    const repo = new InMemoryRepository();
    const now = new Date('2030-01-01T00:00:00.000Z');
    await repo.withLock(async (store) => {
      store.principals.push({ id: 'principal_1', ownerAddress: '0x1111111111111111111111111111111111111111', kycStatus: 'verified', kycExpiresAt: '2031-01-01T00:00:00.000Z', createdAt: now.toISOString(), updatedAt: now.toISOString() });
      store.enrollments.push({ agentUuid: 'agent_uuid_1', agentId: 'agent_1', deviceCode: 'device_1', principalId: 'principal_1', status: 'bound', publicJwk: identityPublicJwk, thumbprint: await calculateJwkThumbprint(identityPublicJwk, 'sha256'), mandateSigningPublicJwk: mandatePublicJwk, mandateSigningThumbprint: await calculateJwkThumbprint(mandatePublicJwk, 'sha256'), mandateSigningKeyId: 'mandate-key-1', mandateSigningBoundAt: now.toISOString(), keystoreProvider: 'os_hardware', agentUriPath: '/agent_1', createdAt: now.toISOString(), updatedAt: now.toISOString() });
      store.credentials.push({ id: 'credential_1', jti: 'credential_1', agentUuid: 'agent_uuid_1', principalId: 'principal_1', thumbprint: await calculateJwkThumbprint(identityPublicJwk, 'sha256'), agentRegistry: 'base:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: 'agent_1', owner: '0x1111111111111111111111111111111111111111', status: 'active', statusRef: 'local', issuedAt: now.toISOString(), expiresAt: '2031-01-01T00:00:00.000Z' });
    });
    const verifier = new KyaAgentTrustVerifier(repo, { policyVersion: 'v1', now: () => now, isTenantAuthorized: () => true, riskLevel: () => 'low', requireMandateSigningKey: true });
    await expect(verifier.verifyAgent({ agentId: 'agent_1', tenantId: 'tenant_1', keyId: 'mandate-key-1', publicKeyJwk: mandatePublicJwk, action: 'autonomous_payment_mandate' })).resolves.toMatchObject({ allowed: true, keyBindingStatus: 'bound' });
    await expect(verifier.verifyAgent({ agentId: 'agent_1', tenantId: 'tenant_1', keyId: 'mandate-key-1', publicKeyJwk: identityPublicJwk, action: 'autonomous_payment_mandate' })).resolves.toMatchObject({ allowed: false, reasons: expect.arrayContaining(['MANDATE_SIGNING_KEY_MISMATCH']) });
  });
});
