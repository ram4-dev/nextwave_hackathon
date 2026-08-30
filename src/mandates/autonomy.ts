import { createHash, randomUUID } from 'node:crypto';
import { CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import { checkoutHash } from './index.js';
import { assertTrustedAgent, type AgentTrustVerifier } from './agent-trust.js';
import { InMemoryMandatePolicyLedger, MandatePolicyEvaluator, type MandatePolicyLedger, type OpenMandateConstraints, type OpenMandateRecord } from './policy.js';
import type { CheckoutSnapshot, MerchantSigner } from './types.js';

export interface TrustedSurfaceSignatureVerifier {
  verify(input: { payload: Record<string, unknown>; signature: string; userReference: string }): Promise<boolean>;
}

export interface AgentMandateSigner {
  readonly keyId: string;
  readonly publicKeyJwk: JsonWebKey;
  sign(payload: Record<string, unknown>): Promise<string>;
  verify(jws: string): Promise<Record<string, unknown>>;
}

/** Test-only signer. Production must supply a KMS/HSM-backed AgentMandateSigner. */
export async function createTestAgentMandateSigner(nodeEnv: string): Promise<AgentMandateSigner> {
  if (nodeEnv !== 'test') throw new DomainError('Test agent signer is restricted to NODE_ENV=test', 'AGENT_SIGNER_ENV');
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const publicKeyJwk = await exportJWK(publicKey);
  return {
    keyId: `test-agent-${randomUUID()}`, publicKeyJwk,
    async sign(payload) {
      return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT' }).sign(privateKey);
    },
    async verify(jws) {
      const verified = await compactVerify(jws, await importJWK(publicKeyJwk, 'ES256'));
      return JSON.parse(new TextDecoder().decode(verified.payload)) as Record<string, unknown>;
    },
  };
}

export class InMemoryOpenMandateRegistry {
  private readonly records = new Map<string, OpenMandateRecord>();
  create(input: Omit<OpenMandateRecord, 'id' | 'status'>): OpenMandateRecord {
    const record: OpenMandateRecord = { ...input, id: `open_${randomUUID().replace(/-/g, '')}`, status: 'awaiting_user_signature' };
    this.records.set(record.id, record); return structuredClone(record);
  }
  get(id: string): OpenMandateRecord {
    const record = this.records.get(id); if (!record) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND'); return structuredClone(record);
  }
  async recordUserSignature(id: string, signature: string, verifier: TrustedSurfaceSignatureVerifier): Promise<OpenMandateRecord> {
    const record = this.records.get(id); if (!record) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND');
    if (record.status !== 'awaiting_user_signature') throw new DomainError('Open mandate is not awaiting user signature', 'OPEN_MANDATE_STATE');
    const valid = await verifier.verify({ payload: openPayload(record), signature, userReference: record.userReference });
    if (!valid) throw new DomainError('Trusted Surface signature invalid', 'USER_SIGNATURE_INVALID');
    record.status = 'active'; record.userSignature = signature; return structuredClone(record);
  }
  revoke(id: string): OpenMandateRecord {
    const record = this.records.get(id); if (!record) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND');
    record.status = 'revoked'; return structuredClone(record);
  }
}

export function openPayload(record: OpenMandateRecord): Record<string, unknown> {
  return { vct: record.type === 'checkout' ? 'mandate.checkout.open.1' : 'mandate.payment.open.1', jti: record.id, sub: record.userReference, tenant_id: record.tenantId, agent_id: record.agentId, cnf: { jwk: record.agentPublicKeyJwk }, constraints: record.constraints, iat: Math.floor(Date.parse(record.issuedAt) / 1000), exp: Math.floor(Date.parse(record.expiresAt) / 1000), aud: record.audience, nonce: record.nonce };
}

export function createOpenMandate(registry: InMemoryOpenMandateRegistry, input: Omit<OpenMandateRecord, 'id' | 'status'>): { mandate: OpenMandateRecord; signingRequest: { payload: Record<string, unknown>; purpose: 'user_explicit_consent' } } {
  const mandate = registry.create(input);
  return { mandate, signingRequest: { payload: openPayload(mandate), purpose: 'user_explicit_consent' } };
}

function parseCheckout(value: CheckoutSnapshot & Record<string, unknown>): CheckoutSnapshot {
  const { iss: _iss, aud: _aud, iat: _iat, exp: _exp, nbf: _nbf, jti: _jti, ...checkout } = value;
  return checkout as CheckoutSnapshot;
}

export async function createAutonomousClosedMandates(input: {
  openCheckoutMandate: OpenMandateRecord;
  openPaymentMandate: OpenMandateRecord;
  checkoutJwt: string;
  checkoutHash: string;
  transactionId: string;
  agentIdentity: { agentId: string; tenantId: string };
  agentKeyReference: string;
  paymentInstrumentAlias: string;
  payeeId: string;
  merchantSigner: MerchantSigner;
  agentTrustVerifier: AgentTrustVerifier;
  agentSigner: AgentMandateSigner;
  policyEvaluator?: MandatePolicyEvaluator;
  policyLedger?: MandatePolicyLedger;
  now?: () => Date;
}) {
  const now = input.now?.() ?? new Date();
  if (checkoutHash(input.checkoutJwt) !== input.checkoutHash) throw new DomainError('Checkout hash mismatch', 'CHECKOUT_HASH');
  const checkout = parseCheckout(await input.merchantSigner.verifyCheckout(input.checkoutJwt) as CheckoutSnapshot & Record<string, unknown>);
  if (checkout.transactionId !== input.transactionId) throw new DomainError('Checkout transaction mismatch', 'CHECKOUT_TRANSACTION');
  if (input.openCheckoutMandate.agentId !== input.agentIdentity.agentId || input.openPaymentMandate.agentId !== input.agentIdentity.agentId || input.openCheckoutMandate.tenantId !== input.agentIdentity.tenantId || input.openPaymentMandate.tenantId !== input.agentIdentity.tenantId) throw new DomainError('Open mandate subject mismatch', 'OPEN_MANDATE_SUBJECT');
  if (input.openCheckoutMandate.type !== 'checkout' || input.openPaymentMandate.type !== 'payment') throw new DomainError('Open mandate type mismatch', 'OPEN_MANDATE_TYPE');
  const trust = await input.agentTrustVerifier.verifyAgent({ agentId: input.agentIdentity.agentId, tenantId: input.agentIdentity.tenantId, keyId: input.agentKeyReference, publicKeyJwk: input.agentSigner.publicKeyJwk, action: 'autonomous_payment_mandate' });
  assertTrustedAgent(trust);
  const evaluator = input.policyEvaluator ?? new MandatePolicyEvaluator();
  const policy = evaluator.evaluate({ checkout, payeeId: input.payeeId, paymentInstrumentAlias: input.paymentInstrumentAlias, openCheckout: input.openCheckoutMandate, openPayment: input.openPaymentMandate, now });
  evaluator.assertAllowed(policy);
  const ledger = input.policyLedger ?? new InMemoryMandatePolicyLedger();
  await ledger.reserve({ checkoutMandateId: input.openCheckoutMandate.id, paymentMandateId: input.openPaymentMandate.id, transactionId: input.transactionId, amountMinor: checkout.totals.totalMinor, constraints: input.openPaymentMandate.constraints, now });
  const common = { transaction_id: input.transactionId, checkout_hash: input.checkoutHash, agent_id: input.agentIdentity.agentId, tenant_id: input.agentIdentity.tenantId, agent_key_id: input.agentKeyReference, cnf: { jwk: input.agentSigner.publicKeyJwk }, iat: Math.floor(now.getTime() / 1000), policy_version: trust.policyVersion, open_checkout_mandate_id: input.openCheckoutMandate.id, open_payment_mandate_id: input.openPaymentMandate.id };
  const checkoutPayload = { ...common, vct: 'mandate.checkout.1', jti: `closed_checkout_${randomUUID().replace(/-/g, '')}` };
  const paymentPayload = { ...common, vct: 'mandate.payment.1', jti: `closed_payment_${randomUUID().replace(/-/g, '')}`, payee_id: input.payeeId, payment_instrument_alias: input.paymentInstrumentAlias, amount_minor: checkout.totals.totalMinor, currency: checkout.totals.currency };
  try {
    const [closedCheckoutJws, closedPaymentJws] = await Promise.all([input.agentSigner.sign(checkoutPayload), input.agentSigner.sign(paymentPayload)]);
    await Promise.all([input.agentSigner.verify(closedCheckoutJws), input.agentSigner.verify(closedPaymentJws)]);
    return { status: 'verified' as const, closedCheckoutJws, closedPaymentJws, closedCheckoutHash: createHash('sha256').update(closedCheckoutJws).digest('base64url'), closedPaymentHash: createHash('sha256').update(closedPaymentJws).digest('base64url'), policy, trust };
  } catch (error) { await ledger.release(input.transactionId); throw error; }
}

export type { OpenMandateConstraints };
