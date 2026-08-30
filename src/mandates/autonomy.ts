import { createHash, randomUUID } from 'node:crypto';
import { CompactSign, compactVerify, exportJWK, generateKeyPair, importJWK } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import { assertTrustedAgent, type AgentTrustVerifier } from './agent-trust.js';
import { freezeConstraints, openMandatePayload, openMandatePayloadHash } from './canonical.js';
import { checkoutHash } from './canonical.js';
import {
  createSupabaseMandatePolicyLedger,
  InMemoryMandatePolicyLedger,
  MandatePolicyEvaluator,
  type MandatePolicyLedger,
  type OpenMandateActivationProof,
  type OpenMandateRecord,
} from './policy.js';
import type { CheckoutSnapshot, MerchantSigner } from './types.js';

export interface TrustedSurfaceSignatureVerifier {
  verify(input: { payload: Record<string, unknown>; signature: string; userReference: string; expectedPayloadHash: string }): Promise<boolean>;
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
    keyId: `test-agent-${randomUUID()}`,
    publicKeyJwk,
    async sign(payload) {
      return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
        .sign(privateKey);
    },
    async verify(jws) {
      const verified = await compactVerify(jws, await importJWK(publicKeyJwk, 'ES256'));
      return JSON.parse(new TextDecoder().decode(verified.payload)) as Record<string, unknown>;
    },
  };
}

export type OpenMandateCreateInput = Omit<OpenMandateRecord, 'id' | 'status' | 'canonicalPayloadHash' | 'userSignature' | 'activationProof'>;

export interface OpenMandateRegistry {
  create(input: OpenMandateCreateInput): OpenMandateRecord;
  get(id: string): OpenMandateRecord;
  /** Load an active mandate from the store boundary; rejects fabricated caller records. */
  getAuthorizedActive(input: {
    id: string;
    userReference: string;
    agentId: string;
    tenantId: string;
    audience: string;
    now?: Date;
  }): OpenMandateRecord;
  activateWithVerifiedSignature(input: {
    id: string;
    signature: string;
    expectedPayloadHash: string;
    verifier: TrustedSurfaceSignatureVerifier;
    proof?: Omit<OpenMandateActivationProof, 'signature' | 'payloadHash' | 'activatedAt'> & { activatedAt?: string };
    now?: Date;
  }): Promise<OpenMandateRecord>;
  revoke(id: string): OpenMandateRecord;
}

function cloneRecord(record: OpenMandateRecord): OpenMandateRecord {
  return structuredClone(record);
}

export class InMemoryOpenMandateRegistry implements OpenMandateRegistry {
  private readonly records = new Map<string, OpenMandateRecord>();
  private lock: Promise<unknown> = Promise.resolve();

  create(input: OpenMandateCreateInput): OpenMandateRecord {
    const frozenConstraints = freezeConstraints(input.constraints);
    const id = `open_${randomUUID().replace(/-/g, '')}`;
    const draft: OpenMandateRecord = {
      ...structuredClone({ ...input, constraints: frozenConstraints }),
      id,
      constraints: frozenConstraints,
      canonicalPayloadHash: '',
      status: 'awaiting_user_signature',
    };
    draft.canonicalPayloadHash = openMandatePayloadHash(draft);
    this.records.set(draft.id, cloneRecord(draft));
    return cloneRecord(draft);
  }

  get(id: string): OpenMandateRecord {
    const record = this.records.get(id);
    if (!record) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND');
    return cloneRecord(record);
  }

  getAuthorizedActive(input: {
    id: string;
    userReference: string;
    agentId: string;
    tenantId: string;
    audience: string;
    now?: Date;
  }): OpenMandateRecord {
    const record = this.get(input.id);
    const now = input.now ?? new Date();
    if (record.status !== 'active') throw new DomainError('Open mandate is not active', 'OPEN_MANDATE_INACTIVE');
    if (Date.parse(record.expiresAt) <= now.getTime()) throw new DomainError('Open mandate expired', 'OPEN_MANDATE_EXPIRED');
    if (record.userReference !== input.userReference) throw new DomainError('Open mandate user mismatch', 'OPEN_MANDATE_USER');
    if (record.agentId !== input.agentId) throw new DomainError('Open mandate agent mismatch', 'OPEN_MANDATE_AGENT');
    if (record.tenantId !== input.tenantId) throw new DomainError('Open mandate tenant mismatch', 'OPEN_MANDATE_TENANT');
    if (record.audience !== input.audience) throw new DomainError('Open mandate audience mismatch', 'OPEN_MANDATE_AUDIENCE');
    if (!record.activationProof || record.activationProof.payloadHash !== record.canonicalPayloadHash) {
      throw new DomainError('Open mandate activation proof missing or unbound', 'OPEN_MANDATE_PROOF');
    }
    if (openMandatePayloadHash(record) !== record.canonicalPayloadHash) {
      throw new DomainError('Open mandate payload hash integrity failure', 'OPEN_MANDATE_HASH');
    }
    return record;
  }

  async activateWithVerifiedSignature(input: {
    id: string;
    signature: string;
    expectedPayloadHash: string;
    verifier: TrustedSurfaceSignatureVerifier;
    proof?: Omit<OpenMandateActivationProof, 'signature' | 'payloadHash' | 'activatedAt'> & { activatedAt?: string };
    now?: Date;
  }): Promise<OpenMandateRecord> {
    const run = this.lock.then(async () => {
      const stored = this.records.get(input.id);
      if (!stored) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND');
      if (stored.status !== 'awaiting_user_signature') {
        throw new DomainError('Open mandate is not awaiting user signature', 'OPEN_MANDATE_STATE');
      }
      const now = input.now ?? new Date();
      if (Date.parse(stored.expiresAt) <= now.getTime()) throw new DomainError('Open mandate expired', 'OPEN_MANDATE_EXPIRED');
      const liveHash = openMandatePayloadHash(stored);
      if (liveHash !== stored.canonicalPayloadHash) {
        throw new DomainError('Open mandate payload mutated after create', 'OPEN_MANDATE_HASH');
      }
      if (input.expectedPayloadHash !== stored.canonicalPayloadHash) {
        throw new DomainError('Activation payload hash mismatch', 'OPEN_MANDATE_HASH');
      }
      const payload = openMandatePayload(stored);
      const valid = await input.verifier.verify({
        payload,
        signature: input.signature,
        userReference: stored.userReference,
        expectedPayloadHash: stored.canonicalPayloadHash,
      });
      if (!valid) throw new DomainError('Trusted Surface signature invalid', 'USER_SIGNATURE_INVALID');

      const activatedAt = input.proof?.activatedAt ?? now.toISOString();
      const next: OpenMandateRecord = {
        ...cloneRecord(stored),
        status: 'active',
        userSignature: input.signature,
        activationProof: {
          signature: input.signature,
          payloadHash: stored.canonicalPayloadHash,
          activatedAt,
          challengeId: input.proof?.challengeId,
          ownerAddress: input.proof?.ownerAddress,
        },
      };
      this.records.set(input.id, next);
      return cloneRecord(next);
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  revoke(id: string): OpenMandateRecord {
    const stored = this.records.get(id);
    if (!stored) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND');
    stored.status = 'revoked';
    return cloneRecord(stored);
  }
}

/** @deprecated Prefer openMandatePayload; kept for Trusted Surface call sites during remediation. */
export function openPayload(record: OpenMandateRecord): Record<string, unknown> {
  return openMandatePayload(record);
}

export function createOpenMandate(
  registry: OpenMandateRegistry,
  input: OpenMandateCreateInput,
): { mandate: OpenMandateRecord; signingRequest: { payload: Record<string, unknown>; purpose: 'user_explicit_consent'; payloadHash: string } } {
  const mandate = registry.create(input);
  return {
    mandate,
    signingRequest: {
      payload: openMandatePayload(mandate),
      purpose: 'user_explicit_consent',
      payloadHash: mandate.canonicalPayloadHash,
    },
  };
}

function parseCheckout(value: CheckoutSnapshot & Record<string, unknown>): CheckoutSnapshot {
  const { iss: _iss, aud: _aud, iat: _iat, exp: _exp, nbf: _nbf, jti: _jti, ...checkout } = value;
  return checkout as CheckoutSnapshot;
}

export async function createAutonomousClosedMandates(input: {
  /** Authorized open checkout mandate id loaded from the registry/store boundary. */
  openCheckoutMandateId: string;
  /** Authorized open payment mandate id loaded from the registry/store boundary. */
  openPaymentMandateId: string;
  registry: OpenMandateRegistry;
  userReference: string;
  audience: string;
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
  const openCheckoutMandate = input.registry.getAuthorizedActive({
    id: input.openCheckoutMandateId,
    userReference: input.userReference,
    agentId: input.agentIdentity.agentId,
    tenantId: input.agentIdentity.tenantId,
    audience: input.audience,
    now,
  });
  const openPaymentMandate = input.registry.getAuthorizedActive({
    id: input.openPaymentMandateId,
    userReference: input.userReference,
    agentId: input.agentIdentity.agentId,
    tenantId: input.agentIdentity.tenantId,
    audience: input.audience,
    now,
  });
  if (openCheckoutMandate.type !== 'checkout' || openPaymentMandate.type !== 'payment') {
    throw new DomainError('Open mandate type mismatch', 'OPEN_MANDATE_TYPE');
  }
  if (checkoutHash(input.checkoutJwt) !== input.checkoutHash) throw new DomainError('Checkout hash mismatch', 'CHECKOUT_HASH');
  const checkout = parseCheckout(await input.merchantSigner.verifyCheckout(input.checkoutJwt) as CheckoutSnapshot & Record<string, unknown>);
  if (checkout.transactionId !== input.transactionId) throw new DomainError('Checkout transaction mismatch', 'CHECKOUT_TRANSACTION');

  const trust = await input.agentTrustVerifier.verifyAgent({
    agentId: input.agentIdentity.agentId,
    tenantId: input.agentIdentity.tenantId,
    keyId: input.agentKeyReference,
    publicKeyJwk: input.agentSigner.publicKeyJwk,
    action: 'autonomous_payment_mandate',
  });
  assertTrustedAgent(trust);

  const evaluator = input.policyEvaluator ?? new MandatePolicyEvaluator();
  const policy = evaluator.evaluate({
    checkout,
    payeeId: input.payeeId,
    paymentInstrumentAlias: input.paymentInstrumentAlias,
    openCheckout: openCheckoutMandate,
    openPayment: openPaymentMandate,
    now,
  });
  evaluator.assertAllowed(policy);

  const ledger = input.policyLedger ?? (process.env.NODE_ENV === 'production'
    ? createSupabaseMandatePolicyLedger()
    : new InMemoryMandatePolicyLedger());

  await ledger.reserve({
    checkoutMandateId: openCheckoutMandate.id,
    paymentMandateId: openPaymentMandate.id,
    transactionId: input.transactionId,
    amountMinor: checkout.totals.totalMinor,
    checkoutConstraints: openCheckoutMandate.constraints,
    paymentConstraints: openPaymentMandate.constraints,
    now,
  });

  const common = {
    transaction_id: input.transactionId,
    checkout_hash: input.checkoutHash,
    agent_id: input.agentIdentity.agentId,
    tenant_id: input.agentIdentity.tenantId,
    agent_key_id: input.agentKeyReference,
    cnf: { jwk: input.agentSigner.publicKeyJwk },
    iat: Math.floor(now.getTime() / 1000),
    policy_version: trust.policyVersion,
    open_checkout_mandate_id: openCheckoutMandate.id,
    open_payment_mandate_id: openPaymentMandate.id,
    open_checkout_payload_hash: openCheckoutMandate.canonicalPayloadHash,
    open_payment_payload_hash: openPaymentMandate.canonicalPayloadHash,
  };
  const checkoutPayload = { ...common, vct: 'mandate.checkout.1', jti: `closed_checkout_${randomUUID().replace(/-/g, '')}` };
  const paymentPayload = {
    ...common,
    vct: 'mandate.payment.1',
    jti: `closed_payment_${randomUUID().replace(/-/g, '')}`,
    payee_id: input.payeeId,
    payment_instrument_alias: input.paymentInstrumentAlias,
    amount_minor: checkout.totals.totalMinor,
    currency: checkout.totals.currency,
  };
  try {
    const [closedCheckoutJws, closedPaymentJws] = await Promise.all([
      input.agentSigner.sign(checkoutPayload),
      input.agentSigner.sign(paymentPayload),
    ]);
    await Promise.all([input.agentSigner.verify(closedCheckoutJws), input.agentSigner.verify(closedPaymentJws)]);
    return {
      status: 'verified' as const,
      closedCheckoutJws,
      closedPaymentJws,
      closedCheckoutHash: createHash('sha256').update(closedCheckoutJws).digest('base64url'),
      closedPaymentHash: createHash('sha256').update(closedPaymentJws).digest('base64url'),
      policy,
      trust,
      openCheckoutMandate,
      openPaymentMandate,
    };
  } catch (error) {
    await ledger.release(input.transactionId);
    throw error;
  }
}

export type { OpenMandateConstraints } from './policy.js';
