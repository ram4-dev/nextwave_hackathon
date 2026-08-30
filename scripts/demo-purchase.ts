/**
 * Offline, end-to-end demo: KYA-bound agent → merchant checkout → explicit
 * EIP-712 approval → policy/trust evaluation → agent-signed closed mandates.
 * No merchant, Yuno, Supabase, or blockchain write is performed.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { DemoKycAdapter } from '../src/kyc/demo.js';
import {
  createAutonomousClosedMandates,
  createDemoAgentMandateSigner,
  createLocalMerchantSigner,
  createMandateService,
  Eip712TrustedSurfaceService,
  InMemoryMandateReplayStore,
  InMemoryOpenMandateRegistry,
  InMemoryTrustedSurfaceApprovalStore,
  KyaAgentTrustVerifier,
  mandateApprovalTypes,
} from '../src/mandates/index.js';

async function main() {
  const config = loadConfig({ ...process.env, NODE_ENV: 'development', KYA_MODE: 'demo' });
  const repo = new InMemoryRepository();
  const ceremony = new CeremonyService(repo, config);
  const owner = privateKeyToAccount(generatePrivateKey());

  // The same demo signer JWK is enrolled in KYA and later signs closed mandates.
  const agentSigner = await createDemoAgentMandateSigner(config.KYA_MODE);
  const started = await ceremony.startEnrollment({ publicJwk: agentSigner.publicKeyJwk, keystoreProvider: 'encrypted_os_keystore' });
  await ceremony.attachHuman(started.agentUuid, owner.address);
  const kyc = await ceremony.startKyc(owner.address);
  const signedWebhook = DemoKycAdapter.signWebhook({ session_id: kyc.sessionId, status: 'verified', event_id: `purchase-demo-${started.agentUuid}` });
  await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signedWebhook.signature }, signedWebhook.rawBody);
  await ceremony.attachHuman(started.agentUuid, owner.address);
  await ceremony.approveFingerprint(started.agentUuid, owner.address, started.thumbprint);
  const bound = await ceremony.confirmDemoRegistration(started.agentUuid, owner.address);
  console.log('1. KYA agent bound:', bound.agentId);

  const merchantSigner = await createLocalMerchantSigner({ issuer: 'demo-merchant-1', nodeEnv: 'development' });
  const mandateService = createMandateService({ merchantSigner, replayStore: new InMemoryMandateReplayStore() });
  const now = new Date();
  const transactionId = `txn_${now.getTime()}`;
  const checkout = await mandateService.createMerchantCheckout({
    transactionId,
    merchant: { id: 'demo-merchant-1', legalName: 'Demo Store Inc.', website: 'https://demo-store.example' },
    lineItems: [{ productId: 'sku_headphones_1', title: 'Wireless Headphones', quantity: 1, unitAmountMinor: 9999, taxAmountMinor: 0, discountAmountMinor: 0 }],
    totals: { subtotalMinor: 9999, taxMinor: 0, discountMinor: 0, totalMinor: 9999, currency: 'USD' },
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    source: { type: 'llm', requestId: 'demo-purchase-request' },
  });
  console.log('2. Merchant checkout hash:', checkout.checkoutHash);

  const constraints = {
    merchantIds: ['demo-merchant-1'], payeeIds: ['demo-merchant-1'], maxQuantityPerProduct: 2,
    minAmountMinor: 1, maxAmountMinor: 20_000, currency: 'USD', totalBudgetMinor: 20_000,
    maxOperations: 5, frequencyWindowSeconds: 3600, maxOperationsPerWindow: 5,
    paymentInstrumentAlias: 'demo-card-••••4242',
  };
  const registry = new InMemoryOpenMandateRegistry();
  const common = {
    tenantId: 'tenant_1', userReference: owner.address, agentId: bound.agentId,
    agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints, issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), audience: 'kya-ap2',
  };
  const openCheckout = registry.create({ ...common, type: 'checkout', nonce: 'demo-open-checkout' });
  const openPayment = registry.create({ ...common, type: 'payment', nonce: 'demo-open-payment' });

  const trustedSurface = new Eip712TrustedSurfaceService({
    repo, registry, approvalStore: new InMemoryTrustedSurfaceApprovalStore(), chainId: 84532,
    verifier: { verify: ({ address, domain, message, signature }) => verifyTypedData({ address, domain, message, signature, types: mandateApprovalTypes, primaryType: 'MandateApproval' }) },
  });
  for (const mandate of [openCheckout, openPayment]) {
    const { challenge, typedData } = await trustedSurface.createApprovalChallenge({ openMandateId: mandate.id, ownerAddress: owner.address });
    const signature = await owner.signTypedData(typedData);
    await trustedSurface.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: owner.address, signature });
  }
  console.log('3. User EIP-712 approval: both open mandates active');

  const closed = await createAutonomousClosedMandates({
    openCheckoutMandate: registry.get(openCheckout.id), openPaymentMandate: registry.get(openPayment.id),
    checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId,
    agentIdentity: { agentId: bound.agentId, tenantId: 'tenant_1' }, agentKeyReference: agentSigner.keyId,
    paymentInstrumentAlias: constraints.paymentInstrumentAlias, payeeId: 'demo-merchant-1', merchantSigner, agentSigner,
    agentTrustVerifier: new KyaAgentTrustVerifier(repo, {
      policyVersion: 'demo-v1', isTenantAuthorized: () => true, riskLevel: () => 'low',
    }),
  });
  console.log(JSON.stringify({
    ok: true, transactionId, trustDecision: closed.trust, policyDecision: closed.policy,
    closedCheckoutHash: closed.closedCheckoutHash, closedPaymentHash: closed.closedPaymentHash,
    note: 'Evidence is not anchored and no payment was executed in this demo.',
  }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
