import pg from 'pg';
import { DomainError } from '../domain/state-machine.js';
import type { CheckoutSnapshot } from './types.js';

export type OpenMandateConstraints = {
  merchantIds: string[];
  payeeIds: string[];
  productIds?: string[];
  supplierIds?: string[];
  maxQuantityPerProduct: number;
  minAmountMinor: number;
  maxAmountMinor: number;
  currency: string;
  totalBudgetMinor: number;
  maxOperations: number;
  frequencyWindowSeconds: number;
  maxOperationsPerWindow: number;
  paymentInstrumentAlias: string;
  allowedPisp?: string;
};

export type OpenMandateActivationProof = {
  signature: string;
  payloadHash: string;
  activatedAt: string;
  challengeId?: string;
  ownerAddress?: string;
};

export type OpenMandateRecord = {
  id: string;
  type: 'checkout' | 'payment';
  tenantId: string;
  userReference: string;
  agentId: string;
  agentPublicKeyJwk: JsonWebKey;
  constraints: OpenMandateConstraints;
  /** SHA-256 base64url of the canonical open payload frozen at create time. */
  canonicalPayloadHash: string;
  issuedAt: string;
  expiresAt: string;
  audience: string;
  nonce: string;
  status: 'open_draft' | 'awaiting_user_signature' | 'open_signed' | 'active' | 'revoked' | 'expired' | 'rejected';
  userSignature?: string;
  activationProof?: OpenMandateActivationProof;
};

export type PolicyRejection = { code: string; detail: string };
export type PolicyEvaluation = { allowed: boolean; reasons: PolicyRejection[] };
export type PolicyDecision = {
  allowed: boolean;
  reasons: PolicyRejection[];
  /**
   * Authoritative minimum budget headroom across both mandates immediately after
   * this operation was reserved inside the ledger's serialization boundary.
   */
  remainingBudgetMinor: number;
};

export type MandatePolicyReservationResult = Pick<PolicyDecision, 'remainingBudgetMinor'>;

export type MandatePolicyReserveInput = {
  checkoutMandateId: string;
  paymentMandateId: string;
  transactionId: string;
  amountMinor: number;
  now: Date;
  checkoutConstraints: OpenMandateConstraints;
  paymentConstraints: OpenMandateConstraints;
};

export interface MandatePolicyLedger {
  reserve(input: MandatePolicyReserveInput): Promise<MandatePolicyReservationResult>;
  release(transactionId: string): Promise<void>;
}

type Reservation = { amountMinor: number; at: Date; checkoutId: string; paymentId: string };

const SQL_INTEGER_MAX = 2_147_483_647;

function assertSafeInteger(value: number, label: string, options: { positive?: boolean; sqlInteger?: boolean } = {}): void {
  const minimum = options.positive ? 1 : 0;
  if (!Number.isSafeInteger(value) || value < minimum || (options.sqlInteger && value > SQL_INTEGER_MAX)) {
    throw new DomainError(`${label} must be a ${options.positive ? 'positive' : 'non-negative'} SQL-compatible safe integer`, 'POLICY_INPUT');
  }
}

function assertConstraints(constraints: OpenMandateConstraints, label: string): void {
  if (!constraints || typeof constraints !== 'object') {
    throw new DomainError(`${label} constraints are required`, 'POLICY_INPUT');
  }
  assertSafeInteger(constraints.maxQuantityPerProduct, `${label}.maxQuantityPerProduct`, { positive: true, sqlInteger: true });
  assertSafeInteger(constraints.minAmountMinor, `${label}.minAmountMinor`);
  assertSafeInteger(constraints.maxAmountMinor, `${label}.maxAmountMinor`, { positive: true });
  assertSafeInteger(constraints.totalBudgetMinor, `${label}.totalBudgetMinor`);
  assertSafeInteger(constraints.maxOperations, `${label}.maxOperations`, { positive: true, sqlInteger: true });
  assertSafeInteger(constraints.frequencyWindowSeconds, `${label}.frequencyWindowSeconds`, { positive: true, sqlInteger: true });
  assertSafeInteger(constraints.maxOperationsPerWindow, `${label}.maxOperationsPerWindow`, { positive: true, sqlInteger: true });
  if (constraints.minAmountMinor > constraints.maxAmountMinor) {
    throw new DomainError(`${label}.minAmountMinor must not exceed maxAmountMinor`, 'POLICY_INPUT');
  }
  if (constraints.maxOperationsPerWindow > constraints.maxOperations) {
    throw new DomainError(`${label}.maxOperationsPerWindow must not exceed maxOperations`, 'POLICY_INPUT');
  }
}

function assertReserveInput(input: MandatePolicyReserveInput): void {
  if (
    !input
    || typeof input.checkoutMandateId !== 'string' || input.checkoutMandateId.length === 0
    || typeof input.paymentMandateId !== 'string' || input.paymentMandateId.length === 0
    || typeof input.transactionId !== 'string' || input.transactionId.length === 0
  ) {
    throw new DomainError('Policy reservation identifiers are required', 'POLICY_INPUT');
  }
  assertSafeInteger(input.amountMinor, 'amountMinor');
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new DomainError('Policy reservation clock must be a valid Date', 'POLICY_INPUT');
  }
  assertConstraints(input.checkoutConstraints, 'checkoutConstraints');
  assertConstraints(input.paymentConstraints, 'paymentConstraints');
}

function assertBudget(relevant: Reservation[], amountMinor: number, constraints: OpenMandateConstraints, label: string): void {
  const total = relevant.reduce((sum, value) => sum + BigInt(value.amountMinor), 0n) + BigInt(amountMinor);
  if (total > BigInt(constraints.totalBudgetMinor)) {
    throw new DomainError(`Open mandate budget exhausted (${label})`, 'POLICY_BUDGET');
  }
}

function assertOperations(relevant: Reservation[], constraints: OpenMandateConstraints, label: string): void {
  if (relevant.length >= constraints.maxOperations) {
    throw new DomainError(`Open mandate operation limit exceeded (${label})`, 'POLICY_OPERATIONS');
  }
}

function assertFrequency(relevant: Reservation[], now: Date, constraints: OpenMandateConstraints, label: string): void {
  const cutoff = now.getTime() - constraints.frequencyWindowSeconds * 1000;
  if (relevant.filter((value) => value.at.getTime() >= cutoff).length >= constraints.maxOperationsPerWindow) {
    throw new DomainError(`Open mandate frequency exceeded (${label})`, 'POLICY_FREQUENCY');
  }
}

/** Serialized in-process ledger. Production implementations must provide database transactions/row locks. */
export class InMemoryMandatePolicyLedger implements MandatePolicyLedger {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly reservations = new Map<string, Reservation>();

  async reserve(input: MandatePolicyReserveInput): Promise<MandatePolicyReservationResult> {
    assertReserveInput(input);
    const run = this.lock.then(() => {
      if (this.reservations.has(input.transactionId)) throw new DomainError('Transaction already reserved', 'MANDATE_IDEMPOTENCY');
      // Deterministic lock ordering is implicit in the single-process mutex; ids are still sorted for parity with SQL.
      const [first, second] = [input.checkoutMandateId, input.paymentMandateId].sort((a, b) => a.localeCompare(b));
      void first;
      void second;

      const byCheckout = [...this.reservations.values()].filter((value) => value.checkoutId === input.checkoutMandateId);
      const byPayment = [...this.reservations.values()].filter((value) => value.paymentId === input.paymentMandateId);

      assertBudget(byCheckout, input.amountMinor, input.checkoutConstraints, 'checkout');
      assertBudget(byPayment, input.amountMinor, input.paymentConstraints, 'payment');
      assertOperations(byCheckout, input.checkoutConstraints, 'checkout');
      assertOperations(byPayment, input.paymentConstraints, 'payment');
      assertFrequency(byCheckout, input.now, input.checkoutConstraints, 'checkout');
      assertFrequency(byPayment, input.now, input.paymentConstraints, 'payment');

      this.reservations.set(input.transactionId, {
        amountMinor: input.amountMinor,
        at: input.now,
        checkoutId: input.checkoutMandateId,
        paymentId: input.paymentMandateId,
      });
      const checkoutRemaining = BigInt(input.checkoutConstraints.totalBudgetMinor)
        - byCheckout.reduce((sum, value) => sum + BigInt(value.amountMinor), 0n)
        - BigInt(input.amountMinor);
      const paymentRemaining = BigInt(input.paymentConstraints.totalBudgetMinor)
        - byPayment.reduce((sum, value) => sum + BigInt(value.amountMinor), 0n)
        - BigInt(input.amountMinor);
      const remainingBudgetMinor = Number(checkoutRemaining < paymentRemaining ? checkoutRemaining : paymentRemaining);
      if (!Number.isSafeInteger(remainingBudgetMinor) || remainingBudgetMinor < 0) {
        throw new DomainError('Policy reservation produced an invalid remaining budget', 'POLICY_RESERVATION');
      }
      return { remainingBudgetMinor };
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async release(transactionId: string): Promise<void> {
    const run = this.lock.then(() => {
      this.reservations.delete(transactionId);
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }
}

/** Minimal shape this ledger needs from a `pg` pool/client — kept narrow so tests can fake it. */
export interface MandatePolicyQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Durable policy ledger backed by the same reserve/release SQL functions, over plain Postgres. */
export class PgMandatePolicyLedger implements MandatePolicyLedger {
  constructor(private readonly client: MandatePolicyQueryable) {}

  async reserve(input: MandatePolicyReserveInput): Promise<MandatePolicyReservationResult> {
    assertReserveInput(input);
    let rows: unknown[];
    try {
      const result = await this.client.query(
        `select remaining_budget_minor from reserve_mandate_policy($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          input.checkoutMandateId,
          input.paymentMandateId,
          input.transactionId,
          input.amountMinor,
          input.now.toISOString(),
          input.checkoutConstraints.totalBudgetMinor,
          input.checkoutConstraints.maxOperations,
          input.checkoutConstraints.frequencyWindowSeconds,
          input.checkoutConstraints.maxOperationsPerWindow,
          input.paymentConstraints.totalBudgetMinor,
          input.paymentConstraints.maxOperations,
          input.paymentConstraints.frequencyWindowSeconds,
          input.paymentConstraints.maxOperationsPerWindow,
        ],
      );
      rows = result.rows;
    } catch (error) {
      throw new DomainError(`Policy reservation rejected: ${(error as Error).message}`, 'POLICY_RESERVATION');
    }
    const row = rows[0] as { remaining_budget_minor?: number | string } | undefined;
    if (!row) {
      throw new DomainError('Policy reservation rejected: empty result', 'POLICY_RESERVATION');
    }
    const remainingBudgetMinor = Number(row.remaining_budget_minor);
    if (!Number.isSafeInteger(remainingBudgetMinor) || remainingBudgetMinor < 0) {
      throw new DomainError('Policy reservation returned invalid remaining budget', 'POLICY_RESERVATION');
    }
    return { remainingBudgetMinor };
  }

  async release(transactionId: string): Promise<void> {
    try {
      await this.client.query('select release_mandate_policy_reservation($1)', [transactionId]);
    } catch (error) {
      throw new DomainError(`Policy reservation release failed: ${(error as Error).message}`, 'POLICY_RESERVATION');
    }
  }
}

export function createPgMandatePolicyLedger(env: NodeJS.ProcessEnv = process.env): PgMandatePolicyLedger {
  const url = env.MANDATES_DATABASE_URL;
  if (!url || url.includes('<')) {
    throw new DomainError('MANDATES_DATABASE_URL must be configured', 'MANDATES_DATABASE_CONFIG');
  }
  return new PgMandatePolicyLedger(new pg.Pool({ connectionString: url }));
}

export class MandatePolicyEvaluator {
  evaluate(input: {
    checkout: CheckoutSnapshot;
    payeeId: string;
    paymentInstrumentAlias: string;
    openCheckout: OpenMandateRecord;
    openPayment: OpenMandateRecord;
    /** Required when any open mandate constrains allowedPisp. */
    pispId?: string;
    now?: Date;
  }): PolicyEvaluation {
    const now = input.now ?? new Date();
    const reasons: PolicyRejection[] = [];
    const all = [input.openCheckout, input.openPayment];
    for (const mandate of all) {
      if (mandate.status !== 'active') reasons.push({ code: 'OPEN_MANDATE_INACTIVE', detail: mandate.id });
      if (Date.parse(mandate.expiresAt) <= now.getTime()) reasons.push({ code: 'OPEN_MANDATE_EXPIRED', detail: mandate.id });
      if (!mandate.activationProof?.payloadHash || mandate.activationProof.payloadHash !== mandate.canonicalPayloadHash) {
        reasons.push({ code: 'OPEN_MANDATE_PROOF', detail: mandate.id });
      }
      const c = mandate.constraints;
      if (input.checkout.totals.currency !== c.currency) reasons.push({ code: 'CURRENCY_NOT_ALLOWED', detail: mandate.id });
      if (input.checkout.totals.totalMinor < c.minAmountMinor || input.checkout.totals.totalMinor > c.maxAmountMinor) {
        reasons.push({ code: 'AMOUNT_OUT_OF_RANGE', detail: mandate.id });
      }
      if (!c.merchantIds.includes(input.checkout.merchant.id)) reasons.push({ code: 'MERCHANT_NOT_ALLOWED', detail: mandate.id });
      if (!c.payeeIds.includes(input.payeeId)) reasons.push({ code: 'PAYEE_NOT_ALLOWED', detail: mandate.id });
      if (input.paymentInstrumentAlias !== c.paymentInstrumentAlias) reasons.push({ code: 'INSTRUMENT_NOT_ALLOWED', detail: mandate.id });
      if (c.allowedPisp !== undefined) {
        if (!input.pispId || input.pispId !== c.allowedPisp) {
          reasons.push({ code: 'PISP_NOT_ALLOWED', detail: mandate.id });
        }
      }

      const qtyByProduct = new Map<string, bigint>();
      for (const item of input.checkout.lineItems) {
        qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0n) + BigInt(item.quantity));
        if (c.productIds && !c.productIds.includes(item.productId)) reasons.push({ code: 'PRODUCT_NOT_ALLOWED', detail: item.productId });
        if (c.supplierIds) {
          if (!item.supplierId) {
            reasons.push({ code: 'SUPPLIER_REQUIRED', detail: item.productId });
          } else if (!c.supplierIds.includes(item.supplierId)) {
            reasons.push({ code: 'SUPPLIER_NOT_ALLOWED', detail: item.supplierId });
          }
        }
      }
      for (const [productId, quantity] of qtyByProduct) {
        if (quantity > BigInt(c.maxQuantityPerProduct)) reasons.push({ code: 'QUANTITY_EXCEEDED', detail: productId });
      }
    }

    return { allowed: reasons.length === 0, reasons };
  }

  assertAllowed(decision: PolicyEvaluation): void {
    if (!decision.allowed) {
      throw new DomainError(`Mandate policy rejected: ${decision.reasons.map((x) => x.code).join(',')}`, 'MANDATE_POLICY_DENIED');
    }
  }
}
