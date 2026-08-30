/**
 * Demonstrates the production-shaped key split without exposing the configured
 * private JWK: a KYA identity key and a different delegated mandate signer.
 * Run with: node --env-file=.env --import tsx scripts/demo-purchase-configured.ts
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { DemoKycAdapter } from '../src/kyc/demo.js';
import {
  createAutonomousClosedMandates,
  createConfiguredAgentMandateSigner,
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
  const mandateSigner = await createConfiguredAgentMandateSigner();
  const repo = new InMemoryRepository();
  const ceremony = new CeremonyService(repo, config);
  const owner = privateKeyToAccount(generatePrivateKey());

  // Identity key: KYA agent authentication/challenges. It never signs mandates.
  const identitySigner = await createDemoAgentMandateSigner(config.KYA_MODE);
  const started = await ceremony.startEnrollment({ publicJwk: identitySigner.publicKeyJwk, keystoreProvider: 'encrypted_os_keystore' });
  await ceremony.attachHuman(started.agentUuid, owner.address);
  const kyc = await ceremony.startKyc(owner.address);
  const webhook = DemoKycAdapter.signWebhook({ session_id: kyc.sessionId, status: 'verified', event_id: `configured-key-demo-${started.agentUuid}` });
  await ceremony.handleKycWebhook('demo', { 'x-demo-signature': webhook.signature }, webhook.rawBody);
  await ceremony.attachHuman(started.agentUuid, owner.address);
  await ceremony.approveFingerprint(started.agentUuid, owner.address, started.thumbprint);
  const bound = await ceremony.confirmDemoRegistration(started.agentUuid, owner.address);

  // Delegated key: comes from MANDATE_SIGNING_PRIVATE_JWK and is bound as a
  // distinct public key. Only this key signs the autonomous closed mandates.
  await ceremony.bindMandateSigningKey(started.agentUuid, owner.address, {
    publicJwk: mandateSigner.publicKeyJwk,
    keyId: mandateSigner.keyId,
  });
  console.log('1. Separate KYA identity key and delegated mandate key bound:', { agentId: bound.agentId, mandateKeyId: mandateSigner.keyId });

  const merchantSigner = await createLocalMerchantSigner({ issuer: 'demo-merchant-1', nodeEnv: 'development' });
  const mandateService = createMandateService({ merchantSigner, replayStore: new InMemoryMandateReplayStore() });
  const now = new Date();
  const transactionId = `configured_txn_${now.getTime()}`;
  const checkout = await mandateService.createMerchantCheckout({
    transactionId, merchant: { id: 'demo-merchant-1', legalName: 'Demo Store Inc.', website: 'https://demo-store.example' },
    lineItems: [{ productId: 'sku_headphones_1', title: 'Wireless Headphones', quantity: 1, unitAmountMinor: 9999, taxAmountMinor: 0, discountAmountMinor: 0 }],
    totals: { subtotalMinor: 9999, taxMinor: 0, discountMinor: 0, totalMinor: 9999, currency: 'USD' },
    issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 60 * 1000).toISOString(), source: { type: 'llm', requestId: 'configured-key-demo' },
  });

  const constraints = { merchantIds: ['demo-merchant-1'], payeeIds: ['demo-merchant-1'], maxQuantityPerProduct: 2, minAmountMinor: 1, maxAmountMinor: 20_000, currency: 'USD', totalBudgetMinor: 20_000, maxOperations: 5, frequencyWindowSeconds: 3600, maxOperationsPerWindow: 5, paymentInstrumentAlias: 'demo-card-••••4242' };
  const registry = new InMemoryOpenMandateRegistry();
  const common = { tenantId: 'tenant_1', userReference: owner.address, agentId: bound.agentId, agentPublicKeyJwk: mandateSigner.publicKeyJwk, constraints, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(), audience: 'kya-ap2' };
  const openCheckout = registry.create({ ...common, type: 'checkout', nonce: 'configured-open-checkout' });
  const openPayment = registry.create({ ...common, type: 'payment', nonce: 'configured-open-payment' });
  const trustedSurface = new Eip712TrustedSurfaceService({ repo, registry, approvalStore: new InMemoryTrustedSurfaceApprovalStore(), chainId: 84532, verifier: { verify: ({ address, domain, message, signature }) => verifyTypedData({ address, domain, message, signature, types: mandateApprovalTypes, primaryType: 'MandateApproval' }) } });
  for (const mandate of [openCheckout, openPayment]) {
    const { challenge, typedData } = await trustedSurface.createApprovalChallenge({ openMandateId: mandate.id, ownerAddress: owner.address });
    await trustedSurface.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: owner.address, signature: await owner.signTypedData(typedData) });
  }

  const closed = await createAutonomousClosedMandates({
    openCheckoutMandate: registry.get(openCheckout.id), openPaymentMandate: registry.get(openPayment.id), checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId,
    agentIdentity: { agentId: bound.agentId, tenantId: 'tenant_1' }, agentKeyReference: mandateSigner.keyId, paymentInstrumentAlias: constraints.paymentInstrumentAlias, payeeId: 'demo-merchant-1', merchantSigner, agentSigner: mandateSigner,
    agentTrustVerifier: new KyaAgentTrustVerifier(repo, { policyVersion: 'demo-configured-key-v1', isTenantAuthorized: () => true, riskLevel: () => 'low', requireMandateSigningKey: true }),
  });
  console.log(JSON.stringify({ ok: true, separateKeys: true, trust: closed.trust, policy: closed.policy, closedCheckoutHash: closed.closedCheckoutHash, closedPaymentHash: closed.closedPaymentHash, note: 'No merchant, Yuno, Supabase, or BSC write was executed.' }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
