import { DomainError } from '../domain/state-machine.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
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

export type OpenMandateRecord = {
  id: string;
  type: 'checkout' | 'payment';
  tenantId: string;
  userReference: string;
  agentId: string;
  agentPublicKeyJwk: JsonWebKey;
  constraints: OpenMandateConstraints;
  issuedAt: string;
  expiresAt: string;
  audience: string;
  nonce: string;
  status: 'open_draft' | 'awaiting_user_signature' | 'open_signed' | 'active' | 'revoked' | 'expired' | 'rejected';
  userSignature?: string;
};

export type PolicyRejection = { code: string; detail: string };
export type PolicyDecision = { allowed: boolean; reasons: PolicyRejection[]; remainingBudgetMinor: number };

export interface MandatePolicyLedger {
  reserve(input: { checkoutMandateId: string; paymentMandateId: string; transactionId: string; amountMinor: number; now: Date; constraints: OpenMandateConstraints }): Promise<void>;
  release(transactionId: string): Promise<void>;
}

/** Serialized in-process ledger. Production implementations must provide database transactions/row locks. */
export class InMemoryMandatePolicyLedger implements MandatePolicyLedger {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly reservations = new Map<string, { amountMinor: number; at: Date; checkoutId: string; paymentId: string }>();
  async reserve(input: Parameters<MandatePolicyLedger['reserve']>[0]): Promise<void> {
    const run = this.lock.then(() => {
      if (this.reservations.has(input.transactionId)) throw new DomainError('Transaction already reserved', 'MANDATE_IDEMPOTENCY');
      const relevant = [...this.reservations.values()].filter((value) => value.checkoutId === input.checkoutMandateId && value.paymentId === input.paymentMandateId);
      const total = relevant.reduce((sum, value) => sum + BigInt(value.amountMinor), 0n) + BigInt(input.amountMinor);
      if (total > BigInt(input.constraints.totalBudgetMinor)) throw new DomainError('Open mandate budget exhausted', 'POLICY_BUDGET');
      if (relevant.length >= input.constraints.maxOperations) throw new DomainError('Open mandate operation limit exceeded', 'POLICY_OPERATIONS');
      const cutoff = input.now.getTime() - input.constraints.frequencyWindowSeconds * 1000;
      if (relevant.filter((value) => value.at.getTime() >= cutoff).length >= input.constraints.maxOperationsPerWindow) throw new DomainError('Open mandate frequency exceeded', 'POLICY_FREQUENCY');
      this.reservations.set(input.transactionId, { amountMinor: input.amountMinor, at: input.now, checkoutId: input.checkoutMandateId, paymentId: input.paymentMandateId });
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }
  async release(transactionId: string): Promise<void> { this.reservations.delete(transactionId); }
}

/** Durable policy ledger backed by Supabase RPC transactions. */
export class SupabaseMandatePolicyLedger implements MandatePolicyLedger {
  constructor(private readonly client: SupabaseClient) {}

  async reserve(input: Parameters<MandatePolicyLedger['reserve']>[0]): Promise<void> {
    const { error } = await this.client.rpc('reserve_mandate_policy', {
      p_checkout_mandate_id: input.checkoutMandateId,
      p_payment_mandate_id: input.paymentMandateId,
      p_transaction_id: input.transactionId,
      p_amount_minor: input.amountMinor,
      p_reserved_at: input.now.toISOString(),
      p_total_budget_minor: input.constraints.totalBudgetMinor,
      p_max_operations: input.constraints.maxOperations,
      p_frequency_window_seconds: input.constraints.frequencyWindowSeconds,
      p_max_operations_per_window: input.constraints.maxOperationsPerWindow,
    });
    if (error) throw new DomainError(`Policy reservation rejected: ${error.message}`, 'POLICY_RESERVATION');
  }

  async release(transactionId: string): Promise<void> {
    const { error } = await this.client.rpc('release_mandate_policy_reservation', {
      p_transaction_id: transactionId,
    });
    if (error) throw new DomainError(`Policy reservation release failed: ${error.message}`, 'POLICY_RESERVATION');
  }
}

export function createSupabaseMandatePolicyLedger(env: NodeJS.ProcessEnv = process.env): SupabaseMandatePolicyLedger {
  const url = env.SUPABASE_URL;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey || url.includes('<') || secretKey.includes('<')) {
    throw new DomainError('SUPABASE_URL and SUPABASE_SECRET_KEY must be configured', 'SUPABASE_CONFIG');
  }
  return new SupabaseMandatePolicyLedger(createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } }));
}

export class MandatePolicyEvaluator {
  evaluate(input: { checkout: CheckoutSnapshot; payeeId: string; paymentInstrumentAlias: string; openCheckout: OpenMandateRecord; openPayment: OpenMandateRecord; now?: Date }): PolicyDecision {
    const now = input.now ?? new Date(); const reasons: PolicyRejection[] = [];
    const all = [input.openCheckout, input.openPayment];
    for (const mandate of all) {
      if (mandate.status !== 'active' && mandate.status !== 'open_signed') reasons.push({ code: 'OPEN_MANDATE_INACTIVE', detail: mandate.id });
      if (Date.parse(mandate.expiresAt) <= now.getTime()) reasons.push({ code: 'OPEN_MANDATE_EXPIRED', detail: mandate.id });
      const c = mandate.constraints;
      if (input.checkout.totals.currency !== c.currency) reasons.push({ code: 'CURRENCY_NOT_ALLOWED', detail: mandate.id });
      if (input.checkout.totals.totalMinor < c.minAmountMinor || input.checkout.totals.totalMinor > c.maxAmountMinor) reasons.push({ code: 'AMOUNT_OUT_OF_RANGE', detail: mandate.id });
      if (!c.merchantIds.includes(input.checkout.merchant.id)) reasons.push({ code: 'MERCHANT_NOT_ALLOWED', detail: mandate.id });
      if (!c.payeeIds.includes(input.payeeId)) reasons.push({ code: 'PAYEE_NOT_ALLOWED', detail: mandate.id });
      if (input.paymentInstrumentAlias !== c.paymentInstrumentAlias) reasons.push({ code: 'INSTRUMENT_NOT_ALLOWED', detail: mandate.id });
      for (const item of input.checkout.lineItems) {
        if (item.quantity > c.maxQuantityPerProduct) reasons.push({ code: 'QUANTITY_EXCEEDED', detail: item.productId });
        if (c.productIds && !c.productIds.includes(item.productId)) reasons.push({ code: 'PRODUCT_NOT_ALLOWED', detail: item.productId });
        if (item.supplierId && c.supplierIds && !c.supplierIds.includes(item.supplierId)) reasons.push({ code: 'SUPPLIER_NOT_ALLOWED', detail: item.supplierId });
      }
    }
    const remaining = Math.min(...all.map((m) => m.constraints.totalBudgetMinor - input.checkout.totals.totalMinor));
    return { allowed: reasons.length === 0, reasons, remainingBudgetMinor: Math.max(0, remaining) };
  }
  assertAllowed(decision: PolicyDecision): void {
    if (!decision.allowed) throw new DomainError(`Mandate policy rejected: ${decision.reasons.map((x) => x.code).join(',')}`, 'MANDATE_POLICY_DENIED');
  }
}
