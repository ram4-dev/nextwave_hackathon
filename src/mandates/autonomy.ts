import { createHash, randomUUID } from 'node:crypto';
import { CompactSign, compactVerify, calculateJwkThumbprint, decodeProtectedHeader, exportJWK, generateKeyPair, importJWK } from 'jose';
import { z } from 'zod';
import { DomainError } from '../domain/state-machine.js';
import { assertTrustedAgent, type AgentTrustVerifier } from './agent-trust.js';
import { canonicalJson, checkoutHash, freezeConstraints, openMandatePayload, openMandatePayloadHash, sha256Base64Url } from './canonical.js';
import {
  createPgMandatePolicyLedger,
  InMemoryMandatePolicyLedger,
  MandatePolicyEvaluator,
  type MandatePolicyLedger,
  type OpenMandateActivationProof,
  type OpenMandateConstraints,
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
  const keyId = `test-agent-${randomUUID()}`;
  return {
    keyId,
    publicKeyJwk,
    async sign(payload) {
      return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
        .setProtectedHeader({ alg: 'ES256', typ: 'JWT', kid: keyId })
        .sign(privateKey);
    },
    async verify(jws) {
      const verified = await compactVerify(jws, await importJWK(publicKeyJwk, 'ES256'));
      return JSON.parse(new TextDecoder().decode(verified.payload)) as Record<string, unknown>;
    },
  };
}

const opaqueId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const utcDate = z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z'));
const sqlPositiveInteger = z.number().int().safe().positive().max(2_147_483_647);
const publicJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().min(1).optional(),
  alg: z.string().optional(),
  use: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if ('d' in value) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'private key material forbidden' });
});

const constraintsSchema = z.object({
  merchantIds: z.array(opaqueId).min(1),
  payeeIds: z.array(opaqueId).min(1),
  productIds: z.array(opaqueId).optional(),
  supplierIds: z.array(opaqueId).optional(),
  maxQuantityPerProduct: sqlPositiveInteger,
  minAmountMinor: z.number().int().safe().nonnegative(),
  maxAmountMinor: z.number().int().safe().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  totalBudgetMinor: z.number().int().safe().nonnegative(),
  maxOperations: sqlPositiveInteger,
  frequencyWindowSeconds: sqlPositiveInteger,
  maxOperationsPerWindow: sqlPositiveInteger,
  paymentInstrumentAlias: opaqueId,
  allowedPisp: opaqueId.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.minAmountMinor > value.maxAmountMinor) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'minAmountMinor exceeds maxAmountMinor' });
  }
  if (value.maxOperationsPerWindow > value.maxOperations) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'maxOperationsPerWindow exceeds maxOperations' });
  }
});

const openMandateCreateSchema = z.object({
  type: z.enum(['checkout', 'payment']),
  tenantId: opaqueId,
  userReference: opaqueId,
  agentId: opaqueId,
  agentPublicKeyJwk: publicJwkSchema,
  constraints: constraintsSchema,
  issuedAt: utcDate,
  expiresAt: utcDate,
  audience: opaqueId,
  nonce: opaqueId.max(512),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expiresAt must be after issuedAt' });
  }
});

export type OpenMandateCreateInput = Omit<z.input<typeof openMandateCreateSchema>, 'agentPublicKeyJwk'> & {
  agentPublicKeyJwk: JsonWebKey;
};

function parseOpenMandateCreate(input: OpenMandateCreateInput): z.infer<typeof openMandateCreateSchema> {
  try {
    return openMandateCreateSchema.parse(input);
  } catch (error) {
    throw new DomainError(`Invalid open mandate input: ${(error as z.ZodError).message}`, 'OPEN_MANDATE_INPUT');
  }
}

export interface OpenMandateRegistry {
  /** Shared in-process policy ledger for this registry scope, when available. */
  readonly policyLedger?: MandatePolicyLedger;
  create(input: OpenMandateCreateInput): OpenMandateRecord;
  get(id: string): OpenMandateRecord;
  getAuthorizedActive(input: {
    id: string;
    userReference: string;
    agentId: string;
    tenantId: string;
    audience: string;
    now?: Date;
    clockSkewMs?: number;
  }): OpenMandateRecord;
  activateWithVerifiedSignature(input: {
    id: string;
    signature: string;
    expectedPayloadHash: string;
    verifier: TrustedSurfaceSignatureVerifier;
    proof?: Omit<OpenMandateActivationProof, 'signature' | 'payloadHash' | 'activatedAt'> & { activatedAt?: string };
    /** Runs inside the activation critical section before status becomes active. Failure leaves mandate awaiting signature. */
    persistProof?: (proof: OpenMandateActivationProof) => Promise<void>;
    now?: Date;
    clockSkewMs?: number;
  }): Promise<OpenMandateRecord>;
  /** Serialized with activation so a resolved revocation can never be overwritten by an in-flight activation. */
  revoke(id: string): Promise<OpenMandateRecord>;
}

function cloneRecord(record: OpenMandateRecord): OpenMandateRecord {
  return structuredClone(record);
}

async function publicJwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const publicOnly = { ...jwk } as JsonWebKey;
  delete (publicOnly as Record<string, unknown>).d;
  return calculateJwkThumbprint(publicOnly, 'sha256');
}

export async function verifyClosedMandateJws(input: {
  jws: string;
  publicKeyJwk: JsonWebKey;
  expectedPayload: Record<string, unknown>;
  /** Required non-empty key id; missing/mismatched JWS kid always fails. */
  expectedKeyId: string;
}): Promise<Record<string, unknown>> {
  if (typeof input.expectedKeyId !== 'string' || input.expectedKeyId.trim().length === 0) {
    throw new DomainError('Closed mandate JWS expectedKeyId is required', 'CLOSED_MANDATE_JWS');
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(input.jws);
  } catch (error) {
    throw new DomainError(`Closed mandate JWS header decode failed: ${(error as Error).message}`, 'CLOSED_MANDATE_JWS');
  }
  if (header.alg !== 'ES256') throw new DomainError('Closed mandate JWS alg must be ES256', 'CLOSED_MANDATE_JWS');
  if (header.typ !== 'JWT') throw new DomainError('Closed mandate JWS typ must be JWT', 'CLOSED_MANDATE_JWS');
  if (header.kid !== input.expectedKeyId) {
    throw new DomainError('Closed mandate JWS kid mismatch', 'CLOSED_MANDATE_JWS');
  }
  let key;
  try {
    key = await importJWK({ ...input.publicKeyJwk, d: undefined } as JsonWebKey, 'ES256');
  } catch (error) {
    throw new DomainError(`Closed mandate JWS key import failed: ${(error as Error).message}`, 'CLOSED_MANDATE_JWS');
  }
  let payloadBytes: Uint8Array;
  try {
    const verified = await compactVerify(input.jws, key);
    payloadBytes = verified.payload;
  } catch {
    throw new DomainError('Closed mandate JWS signature invalid', 'CLOSED_MANDATE_JWS');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as Record<string, unknown>;
  } catch (error) {
    throw new DomainError(`Closed mandate JWS payload JSON decode failed: ${(error as Error).message}`, 'CLOSED_MANDATE_JWS');
  }
  if (sha256Base64Url(canonicalJson(payload)) !== sha256Base64Url(canonicalJson(input.expectedPayload))) {
    throw new DomainError('Closed mandate JWS payload mismatch', 'CLOSED_MANDATE_JWS');
  }
  return payload;
}

export class InMemoryOpenMandateRegistry implements OpenMandateRegistry {
  private readonly records = new Map<string, OpenMandateRecord>();
  private lock: Promise<unknown> = Promise.resolve();
  /** Shared across all autonomous closures that use this registry without an injected ledger. */
  readonly policyLedger = new InMemoryMandatePolicyLedger();

  create(input: OpenMandateCreateInput): OpenMandateRecord {
    const checked = parseOpenMandateCreate(input);
    const frozenConstraints = freezeConstraints(checked.constraints as OpenMandateConstraints);
    const id = `open_${randomUUID().replace(/-/g, '')}`;
    const draft: OpenMandateRecord = {
      ...structuredClone({ ...checked, constraints: frozenConstraints }),
      id,
      constraints: frozenConstraints,
      agentPublicKeyJwk: checked.agentPublicKeyJwk as JsonWebKey,
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
    clockSkewMs?: number;
  }): OpenMandateRecord {
    const record = this.get(input.id);
    const now = input.now ?? new Date();
    assertValidNow(now, 'OPEN_MANDATE_TIME');
    const clockSkewMs = resolveClockSkewMs(input.clockSkewMs);
    if (record.status !== 'active') throw new DomainError('Open mandate is not active', 'OPEN_MANDATE_INACTIVE');
    const issuedAtMs = Date.parse(record.issuedAt);
    if (!Number.isFinite(issuedAtMs)) throw new DomainError('Open mandate issuedAt invalid', 'OPEN_MANDATE_ISSUED');
    if (now.getTime() < issuedAtMs) {
      throw new DomainError('Open mandate is not yet valid (before issuedAt)', 'OPEN_MANDATE_NOT_YET_VALID');
    }
    if (Date.parse(record.expiresAt) <= now.getTime()) throw new DomainError('Open mandate expired', 'OPEN_MANDATE_EXPIRED');
    if (record.userReference !== input.userReference) throw new DomainError('Open mandate user mismatch', 'OPEN_MANDATE_USER');
    if (record.agentId !== input.agentId) throw new DomainError('Open mandate agent mismatch', 'OPEN_MANDATE_AGENT');
    if (record.tenantId !== input.tenantId) throw new DomainError('Open mandate tenant mismatch', 'OPEN_MANDATE_TENANT');
    if (record.audience !== input.audience) throw new DomainError('Open mandate audience mismatch', 'OPEN_MANDATE_AUDIENCE');
    const proof = record.activationProof;
    if (!proof || proof.payloadHash !== record.canonicalPayloadHash) {
      throw new DomainError('Open mandate activation proof missing or unbound', 'OPEN_MANDATE_PROOF');
    }
    if (proof.signature !== record.userSignature) {
      throw new DomainError('Open mandate activation proof signature mismatch', 'OPEN_MANDATE_PROOF');
    }
    const activatedAt = Date.parse(proof.activatedAt);
    if (!Number.isFinite(activatedAt) || activatedAt > now.getTime() + clockSkewMs) {
      throw new DomainError('Open mandate activation proof timestamp invalid', 'OPEN_MANDATE_PROOF');
    }
    if (activatedAt < issuedAtMs) {
      throw new DomainError('Open mandate activation proof precedes issuedAt', 'OPEN_MANDATE_PROOF');
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
    persistProof?: (proof: OpenMandateActivationProof) => Promise<void>;
    now?: Date;
    clockSkewMs?: number;
  }): Promise<OpenMandateRecord> {
    const run = this.lock.then(async () => {
      const stored = this.records.get(input.id);
      if (!stored) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND');
      if (stored.status !== 'awaiting_user_signature') {
        throw new DomainError('Open mandate is not awaiting user signature', 'OPEN_MANDATE_STATE');
      }
      const now = input.now ?? new Date();
      assertValidNow(now, 'OPEN_MANDATE_TIME');
      const clockSkewMs = resolveClockSkewMs(input.clockSkewMs);
      const issuedAtMs = Date.parse(stored.issuedAt);
      if (!Number.isFinite(issuedAtMs)) throw new DomainError('Open mandate issuedAt invalid', 'OPEN_MANDATE_ISSUED');
      if (now.getTime() < issuedAtMs) {
        throw new DomainError('Open mandate cannot activate before issuedAt', 'OPEN_MANDATE_NOT_YET_VALID');
      }
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
      const activatedAtMs = Date.parse(activatedAt);
      if (!Number.isFinite(activatedAtMs) || activatedAtMs < issuedAtMs || activatedAtMs > now.getTime() + clockSkewMs) {
        throw new DomainError('Open mandate activationProof.activatedAt outside issuedAt/now skew window', 'OPEN_MANDATE_PROOF');
      }
      const activationProof: OpenMandateActivationProof = {
        signature: input.signature,
        payloadHash: stored.canonicalPayloadHash,
        activatedAt,
        challengeId: input.proof?.challengeId,
        ownerAddress: input.proof?.ownerAddress,
      };

      // Persist proof inside the critical section before committing active status.
      // Local in-memory atomicity only — durable production must share one DB transaction.
      if (input.persistProof) await input.persistProof(activationProof);

      const next: OpenMandateRecord = {
        ...cloneRecord(stored),
        status: 'active',
        userSignature: input.signature,
        activationProof,
      };
      this.records.set(input.id, next);
      return cloneRecord(next);
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async revoke(id: string): Promise<OpenMandateRecord> {
    const run = this.lock.then(() => {
      const stored = this.records.get(id);
      if (!stored) throw new DomainError('Open mandate not found', 'OPEN_MANDATE_NOT_FOUND');
      stored.status = 'revoked';
      return cloneRecord(stored);
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
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

function resolvePolicyLedger(input: {
  policyLedger?: MandatePolicyLedger;
  registry: OpenMandateRegistry;
}): MandatePolicyLedger {
  if (input.policyLedger) return input.policyLedger;
  if (input.registry.policyLedger) return input.registry.policyLedger;
  if (process.env.NODE_ENV === 'production') return createPgMandatePolicyLedger();
  throw new DomainError(
    'policyLedger is required when the registry does not expose a shared in-process ledger',
    'POLICY_LEDGER_REQUIRED',
  );
}

function assertValidNow(now: Date, code: string): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DomainError('Clock must return a valid Date', code);
  }
}

function resolveClockSkewMs(value: number | undefined): number {
  const clockSkewMs = value ?? 5_000;
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) {
    throw new DomainError('clockSkewMs must be a non-negative safe integer', 'OPEN_MANDATE_CONFIG');
  }
  return clockSkewMs;
}

export async function createAutonomousClosedMandates(input: {
  openCheckoutMandateId: string;
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
  /** Required when either open mandate constrains allowedPisp. */
  pispId?: string;
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
  if (input.agentKeyReference !== input.agentSigner.keyId) {
    throw new DomainError('Agent key reference does not match signer key id', 'AGENT_KEY_REFERENCE');
  }
  const signerThumbprint = await publicJwkThumbprint(input.agentSigner.publicKeyJwk);
  const checkoutCnf = await publicJwkThumbprint(openCheckoutMandate.agentPublicKeyJwk);
  const paymentCnf = await publicJwkThumbprint(openPaymentMandate.agentPublicKeyJwk);
  if (signerThumbprint !== checkoutCnf || signerThumbprint !== paymentCnf) {
    throw new DomainError('Agent signer JWK does not match open mandate cnf', 'AGENT_KEY_CNF');
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
  const evaluation = evaluator.evaluate({
    checkout,
    payeeId: input.payeeId,
    paymentInstrumentAlias: input.paymentInstrumentAlias,
    openCheckout: openCheckoutMandate,
    openPayment: openPaymentMandate,
    pispId: input.pispId,
    now,
  });
  evaluator.assertAllowed(evaluation);

  const ledger = resolvePolicyLedger(input);
  const reservation = await ledger.reserve({
    checkoutMandateId: openCheckoutMandate.id,
    paymentMandateId: openPaymentMandate.id,
    transactionId: input.transactionId,
    amountMinor: checkout.totals.totalMinor,
    checkoutConstraints: openCheckoutMandate.constraints,
    paymentConstraints: openPaymentMandate.constraints,
    now,
  });
  const policy = { ...evaluation, remainingBudgetMinor: reservation.remainingBudgetMinor };

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
    ...(input.pispId ? { pisp_id: input.pispId } : {}),
    payment_instrument_alias: input.paymentInstrumentAlias,
    amount_minor: checkout.totals.totalMinor,
    currency: checkout.totals.currency,
  };
  try {
    const [closedCheckoutJws, closedPaymentJws] = await Promise.all([
      input.agentSigner.sign(checkoutPayload),
      input.agentSigner.sign(paymentPayload),
    ]);
    await Promise.all([
      verifyClosedMandateJws({
        jws: closedCheckoutJws,
        publicKeyJwk: input.agentSigner.publicKeyJwk,
        expectedPayload: checkoutPayload,
        expectedKeyId: input.agentSigner.keyId,
      }),
      verifyClosedMandateJws({
        jws: closedPaymentJws,
        publicKeyJwk: input.agentSigner.publicKeyJwk,
        expectedPayload: paymentPayload,
        expectedKeyId: input.agentSigner.keyId,
      }),
    ]);
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
