import { exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createConfiguredAgentMandateSigner,
  createMandateAnchorEvidence,
  verifyMandateAnchorEvidence,
} from '../src/mandates/index.js';

const verified = {
  closedCheckoutJws: 'checkout-jws', closedPaymentJws: 'payment-jws', checkoutJwt: 'merchant-checkout-jwt',
  transactionId: 'txn_1', agentId: 'agent_1', policyVersion: 'policy-v1',
};

describe('mandate evidence anchoring', () => {
  it('recalculates evidence hashes and requires both closed mandates on-chain', async () => {
    const evidence = createMandateAnchorEvidence(verified);
    expect(evidence.closedCheckoutHash).toMatch(/^0x[a-f0-9]{64}$/);
    await expect(verifyMandateAnchorEvidence({ isAnchored: async (hash) => hash === evidence.closedCheckoutHash }, verified)).resolves.toMatchObject({ anchored: false });
    await expect(verifyMandateAnchorEvidence({ isAnchored: async () => true }, verified)).resolves.toMatchObject({ anchored: true });
  });
});

describe('configured agent mandate signer', () => {
  it('signs and verifies using an explicitly injected ES256 mandate key', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const signer = await createConfiguredAgentMandateSigner({ MANDATE_SIGNING_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: 'mandate-test-key' }) });
    const jws = await signer.sign({ jti: 'closed_1', amount_minor: 500 });
    await expect(signer.verify(jws)).resolves.toMatchObject({ jti: 'closed_1' });
    expect(signer.keyId).toBe('mandate-test-key');
  });

  it('fails closed when mandate key configuration is ambiguous or absent', async () => {
    await expect(createConfiguredAgentMandateSigner({})).rejects.toMatchObject({ code: 'AGENT_SIGNER_CONFIG' });
  });
});
