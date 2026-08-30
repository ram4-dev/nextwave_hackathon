/**
 * Shared payment view/state helpers — imported by payments + webhook-delivery
 * without creating a cycle.
 */
import type { PaymentRecord } from '../persistence/types.js';
import type { PaymentScenario } from '../domain/scenarios.js';

export type TransactionType =
  | 'PURCHASE'
  | 'AUTHORIZE'
  | 'CAPTURE'
  | 'CANCEL'
  | 'REFUND';

export type StoredTransaction = {
  id: string;
  type: TransactionType;
  status: string;
  category: string;
  amount: number;
  currency: string;
  provider_id: string;
  payment_method: { type: string; vaulted_token?: string };
  response_code: string;
  response_message: string;
  created_at: string;
  updated_at: string;
  merchant_reference?: string;
  description?: string;
  reason?: string;
};

export type ThreeDsChallenge = {
  status: 'pending' | 'succeeded' | 'failed' | 'expired';
  created_at: string;
  completed_at?: string;
  result?: 'success' | 'fail' | 'expire';
};

export type StoredPaymentData = {
  account_id: string;
  description: string;
  country: string;
  merchant_order_id: string;
  amount: { currency: string; value: number; captured: number; refunded: number };
  status: string;
  sub_status: string;
  workflow: string;
  checkout: { session: string; sdk_action_required: boolean };
  customer_payer: { id: string };
  payment_method: {
    type: string;
    vaulted_token: string;
    detail?: { card?: { capture: boolean } };
  };
  /** Primary AUTHORIZE/PURCHASE transaction (create-response object shape). */
  transaction: StoredTransaction;
  /** Full history including primary + CAPTURE/CANCEL/REFUND entries. */
  transactions: StoredTransaction[];
  scenario: PaymentScenario;
  idempotency_key: string;
  outcome_uncertain?: boolean;
  three_ds?: ThreeDsChallenge;
};

/** Provider amounts are multiples of 0.0001 (pin). */
export const AMOUNT_SCALE = 10_000;

/** Round to exact 1e-4 so 0.1 + 0.2 === 0.3. */
export function quantizeAmount(value: number): number {
  return Math.round(value * AMOUNT_SCALE) / AMOUNT_SCALE;
}

export function addAmounts(a: number, b: number): number {
  return quantizeAmount(a + b);
}

export function subAmounts(a: number, b: number): number {
  return quantizeAmount(a - b);
}

/** Provider decimal compare after 1e-4 quantization. */
export function amountsEqual(a: number, b: number): boolean {
  return quantizeAmount(a) === quantizeAmount(b);
}

export function amountLessOrEqual(a: number, b: number): boolean {
  return quantizeAmount(a) <= quantizeAmount(b);
}

/**
 * True when `value` has more than 4 fractional digits (beyond pin multiple of 0.0001).
 */
export function hasExcessFractionalDigits(value: number): boolean {
  if (!Number.isFinite(value)) return true;
  const scaled = value * AMOUNT_SCALE;
  return Math.abs(scaled - Math.round(scaled)) > 1e-8;
}

/**
 * Normalize F3/F4 payments that only stored a single primary `transaction`
 * into a `transactions` history array. Safe for file restart.
 */
export function normalizePaymentData(data: StoredPaymentData): StoredPaymentData {
  if (!data.amount || typeof data.amount !== 'object') {
    data.amount = {
      currency: 'USD',
      value: 0,
      captured: 0,
      refunded: 0,
    };
  }
  if (typeof data.amount.captured !== 'number' || !Number.isFinite(data.amount.captured)) {
    data.amount.captured = data.status === 'SUCCEEDED' ? data.amount.value : 0;
  }
  if (typeof data.amount.refunded !== 'number' || !Number.isFinite(data.amount.refunded)) {
    data.amount.refunded = 0;
  }
  if (!Array.isArray(data.transactions) || data.transactions.length === 0) {
    data.transactions = data.transaction ? [data.transaction] : [];
  } else if (data.transaction) {
    const hasPrimary = data.transactions.some((tx) => tx.id === data.transaction.id);
    if (!hasPrimary) {
      data.transactions = [data.transaction, ...data.transactions];
    } else {
      // Keep primary slot in history in sync with `transaction`.
      data.transactions = data.transactions.map((tx) =>
        tx.id === data.transaction.id ? { ...data.transaction } : tx,
      );
    }
  }
  return data;
}

export function asPaymentData(record: PaymentRecord): StoredPaymentData {
  const data = record.data as unknown as StoredPaymentData;
  normalizePaymentData(data);
  record.data = data as unknown as Record<string, unknown>;
  return data;
}

export function serializeContractAmountValue(value: number): number {
  return quantizeAmount(value);
}

export function paymentTriggerFor(
  data: Pick<StoredPaymentData, 'transaction' | 'status'>,
): string {
  if (data.transaction.type === 'AUTHORIZE') return 'AUTHORIZE';
  return 'PURCHASE';
}

export function syncPrimaryTransaction(
  data: StoredPaymentData,
  patch: Partial<StoredTransaction>,
): void {
  Object.assign(data.transaction, patch);
  const idx = data.transactions.findIndex((tx) => tx.id === data.transaction.id);
  if (idx >= 0) {
    data.transactions[idx] = { ...data.transaction };
  } else {
    data.transactions.unshift({ ...data.transaction });
  }
}

export function appendTransaction(
  data: StoredPaymentData,
  tx: StoredTransaction,
): void {
  data.transactions.push(tx);
}

export function applyPaymentTerminalState(
  record: PaymentRecord,
  input: {
    status: string;
    subStatus: string;
    nowIso: string;
    responseCode?: string;
    responseMessage?: string;
    sdkActionRequired?: boolean;
  },
): void {
  const data = asPaymentData(record);
  data.status = input.status;
  data.sub_status = input.subStatus;
  const nextTxStatus =
    input.status === 'SUCCEEDED'
      ? 'SUCCEEDED'
      : input.status === 'AUTHORIZED'
        ? 'AUTHORIZED'
        : input.status === 'DECLINED'
          ? 'DECLINED'
          : input.status === 'EXPIRED'
            ? 'EXPIRED'
            : data.transaction.status;
  syncPrimaryTransaction(data, {
    status: nextTxStatus,
    ...(input.responseCode ? { response_code: input.responseCode } : {}),
    ...(input.responseMessage ? { response_message: input.responseMessage } : {}),
    updated_at: input.nowIso,
  });
  if (input.status === 'SUCCEEDED') {
    data.amount.captured = data.amount.value;
  }
  if (input.sdkActionRequired !== undefined) {
    data.checkout.sdk_action_required = input.sdkActionRequired;
  } else if (
    input.status === 'SUCCEEDED' ||
    input.status === 'DECLINED' ||
    input.status === 'EXPIRED' ||
    input.status === 'AUTHORIZED'
  ) {
    data.checkout.sdk_action_required = false;
  }
  record.data = data as unknown as Record<string, unknown>;
  record.updatedAt = input.nowIso;
}

export function toTransactionObject(tx: StoredTransaction): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    category: tx.category,
    amount: serializeContractAmountValue(tx.amount),
    provider_id: tx.provider_id,
    payment_method: {
      type: tx.payment_method.type,
    },
    response_code: tx.response_code,
    response_message: tx.response_message,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
    // Pin retrieve/create transaction branches type these as string (not null).
    merchant_reference: tx.merchant_reference ?? '',
    description: tx.description ?? '',
  };
  return out;
}

function toPaymentCore(record: PaymentRecord): Record<string, unknown> {
  const data = asPaymentData(record);
  return {
    id: record.id,
    account_id: data.account_id,
    description: data.description,
    country: data.country,
    merchant_order_id: data.merchant_order_id,
    status: data.status,
    sub_status: data.sub_status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    amount: {
      currency: data.amount.currency,
      value: serializeContractAmountValue(data.amount.value),
      captured: serializeContractAmountValue(data.amount.captured),
      refunded: serializeContractAmountValue(data.amount.refunded),
    },
    payment_method: {
      type: data.payment_method.type,
      vaulted_token: data.payment_method.vaulted_token,
      detail: data.payment_method.detail,
    },
    checkout: {
      session: data.checkout.session,
      sdk_action_required: data.checkout.sdk_action_required,
    },
    customer_payer: { id: data.customer_payer.id },
    workflow: data.workflow,
  };
}

/** Nested payment summary on capture/cancel/cancel-or-refund transaction responses. */
export function toPaymentSummary(record: PaymentRecord): Record<string, unknown> {
  const data = asPaymentData(record);
  return {
    id: record.id,
    account_id: data.account_id,
    description: data.description,
    country: data.country,
    merchant_order_id: data.merchant_order_id,
    status: data.status,
    sub_status: data.sub_status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    amount: {
      currency: data.amount.currency,
      value: serializeContractAmountValue(data.amount.value),
      captured: serializeContractAmountValue(data.amount.captured),
      refunded: serializeContractAmountValue(data.amount.refunded),
    },
  };
}

/**
 * Action response shape (capture/cancel/cancel-or-refund): transaction + nested payment.
 * Pin examples type CAPTURE/CANCEL/REFUND with status SUCCEEDED (or REFUNDED for full refund branch).
 */
export function toActionTransactionResponse(
  record: PaymentRecord,
  tx: StoredTransaction,
): Record<string, unknown> {
  const data = asPaymentData(record);
  return {
    id: tx.id,
    type: tx.type,
    status: tx.status,
    category: tx.category,
    amount: {
      currency: tx.currency,
      value: serializeContractAmountValue(tx.amount),
      captured: 0,
      refunded: 0,
    },
    merchant_reference: tx.merchant_reference ?? data.merchant_order_id,
    response_code: tx.response_code,
    response_message: tx.response_message,
    created_at: tx.created_at,
    updated_at: tx.updated_at,
    payment: toPaymentSummary(record),
    provider_data: {
      id: tx.provider_id,
      account_id: data.account_id,
      response_code: tx.response_code,
      response_message: tx.response_message,
      iso8583_response_code: tx.response_code,
      iso8583_response_message: tx.response_message,
    },
  };
}

/**
 * Refund pin returns a payment-shaped body with `transactions` as the REFUND
 * object (not an array) — matching OpenAPI examples.
 */
export function toRefundPaymentResponse(
  record: PaymentRecord,
  refundTx: StoredTransaction,
): Record<string, unknown> {
  return {
    ...toPaymentCore(record),
    transactions: toTransactionObject(refundTx),
  };
}

export function toCreateResponse(record: PaymentRecord): Record<string, unknown> {
  const data = asPaymentData(record);
  return {
    ...toPaymentCore(record),
    transactions: toTransactionObject(data.transaction),
  };
}

/**
 * Webhook `data.payment` body. When `actionTx` is set (CAPTURE/CANCEL/REFUND),
 * `transactions` is that action transaction — not the primary AUTHORIZE/PURCHASE.
 */
export function toWebhookPaymentBody(
  record: PaymentRecord,
  actionTx?: StoredTransaction,
): Record<string, unknown> {
  const data = asPaymentData(record);
  return {
    ...toPaymentCore(record),
    transactions: toTransactionObject(actionTx ?? data.transaction),
  };
}

export function toRetrieveResponse(record: PaymentRecord): Record<string, unknown> {
  const data = asPaymentData(record);
  return {
    payment: {
      ...toPaymentCore(record),
      transactions: data.transactions.map((tx) => toTransactionObject(tx)),
    },
  };
}
