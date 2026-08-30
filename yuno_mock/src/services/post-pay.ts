/**
 * F5 post-payment operations: capture, cancel, refund, cancel-or-refund.
 * Authority: pinned OpenAPI MVP ops + migration §7/§10–§13.
 */
import type {
  PaymentRecord,
  YunoMockRepository,
  YunoMockStore,
} from '../persistence/types.js';
import { Errors } from '../errors.js';
import { newYunoId, nowIso } from '../domain/ids.js';
import { emitPaymentEvent } from './webhook-delivery.js';
import {
  addAmounts,
  amountsEqual,
  amountLessOrEqual,
  appendTransaction,
  asPaymentData,
  hasExcessFractionalDigits,
  quantizeAmount,
  subAmounts,
  syncPrimaryTransaction,
  toActionTransactionResponse,
  toRefundPaymentResponse,
  type StoredPaymentData,
  type StoredTransaction,
} from './payment-view.js';
import { findPaymentById } from './payments.js';

export type CaptureBody = {
  merchant_reference: string;
  reason: string;
  amount: { currency: string; value: number };
  additional_data?: unknown;
  simplified_mode?: boolean;
};

export type CancelBody = {
  merchant_reference: string;
  description?: string;
  reason?: 'DUPLICATE' | 'FRAUDULENT' | 'REQUESTED_BY_CUSTOMER';
  response_additional_data?: unknown;
};

export type RefundBody = {
  merchant_reference: string;
  amount?: { currency?: string; value?: number };
  description?: string;
  reason?: 'DUPLICATE' | 'FRAUDULENT' | 'REQUESTED_BY_CUSTOMER' | 'REVERSE';
  [key: string]: unknown;
};

export type CancelOrRefundBody = {
  reason?: 'DUPLICATE' | 'FRAUDULENT' | 'REQUESTED_BY_CUSTOMER' | 'REVERSE';
  merchant_reference?: string;
  amount?: { currency?: string; value?: number };
  description?: string;
  [key: string]: unknown;
};

export type PostPayContext = {
  secretsKey: Buffer;
  nowMs: number;
};

export type CancelOrRefundBranch = 'cancel' | 'refund';

function remainingCapturable(data: StoredPaymentData): number {
  return quantizeAmount(Math.max(0, subAmounts(data.amount.value, data.amount.captured)));
}

function remainingRefundable(data: StoredPaymentData): number {
  return quantizeAmount(Math.max(0, subAmounts(data.amount.captured, data.amount.refunded)));
}

function assertMutablePayment(data: StoredPaymentData, action: string): void {
  if (data.three_ds?.status === 'pending') {
    throw Errors.invalidRequest(
      `cannot ${action}: payment requires 3DS completion (PENDING/WAITING_ADDITIONAL_STEP)`,
    );
  }
  if (data.status === 'PENDING') {
    throw Errors.invalidRequest(`cannot ${action}: payment is still PENDING`);
  }
  if (
    data.status === 'DECLINED' ||
    data.status === 'EXPIRED' ||
    data.status === 'ERROR'
  ) {
    throw Errors.invalidRequest(`cannot ${action}: payment is ${data.status}`);
  }
}

function findTargetTransaction(
  data: StoredPaymentData,
  transactionId: string,
): StoredTransaction | undefined {
  if (data.transaction.id === transactionId) return data.transaction;
  return data.transactions.find((tx) => tx.id === transactionId);
}

/** Capture/cancel target an open AUTHORIZE transaction. */
function assertAuthorizeTarget(
  data: StoredPaymentData,
  transactionId: string,
  action: string,
): StoredTransaction {
  const tx = findTargetTransaction(data, transactionId);
  if (!tx) {
    throw Errors.invalidRequest(`${action}: transaction_id not found on payment`);
  }
  if (tx.type !== 'AUTHORIZE') {
    throw Errors.invalidRequest(
      `${action}: transaction_id must reference an AUTHORIZE transaction`,
    );
  }
  return tx;
}

/** Refund targets a PURCHASE or CAPTURE with refundable captured funds. */
function assertRefundTarget(
  data: StoredPaymentData,
  transactionId: string,
): StoredTransaction {
  const tx = findTargetTransaction(data, transactionId);
  if (!tx) {
    throw Errors.invalidRequest('refund: transaction_id not found on payment');
  }
  if (tx.type !== 'PURCHASE' && tx.type !== 'CAPTURE') {
    throw Errors.invalidRequest(
      'refund: transaction_id must reference a PURCHASE or CAPTURE transaction',
    );
  }
  return tx;
}

function assertProviderAmount(
  value: number,
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Errors.invalidRequest(`${field} must be a finite number`);
  }
  if (value <= 0) {
    throw Errors.invalidRequest(`${field} must be positive`);
  }
  if (hasExcessFractionalDigits(value)) {
    throw Errors.invalidRequest(
      `${field} must be a multiple of 0.0001 (at most 4 fractional digits)`,
    );
  }
  return quantizeAmount(value);
}

function persist(record: PaymentRecord, data: StoredPaymentData, ts: string): void {
  record.data = data as unknown as Record<string, unknown>;
  record.updatedAt = ts;
}

function emitActionWebhook(
  store: YunoMockStore,
  record: PaymentRecord,
  typeEvent: 'CAPTURE' | 'CANCEL' | 'REFUND',
  actionTx: StoredTransaction,
  ctx: PostPayContext,
): void {
  const data = asPaymentData(record);
  emitPaymentEvent(store, record, ctx.secretsKey, ctx.nowMs, {
    typeEvent,
    skipApply: true,
    incomingStatus: { status: data.status, sub_status: data.sub_status },
    actionTransaction: actionTx,
  });
}

/** Idempotency scopes — operation + payment/transaction (+ account when present). */
export function captureIdempotencyScope(
  accountId: string | undefined,
  paymentId: string,
  transactionId: string,
): string {
  const acct = accountId && accountId.length > 0 ? accountId : '_';
  return `capture:${acct}:${paymentId}:${transactionId}`;
}

export function cancelIdempotencyScope(
  accountId: string | undefined,
  paymentId: string,
  transactionId: string,
): string {
  const acct = accountId && accountId.length > 0 ? accountId : '_';
  return `cancel:${acct}:${paymentId}:${transactionId}`;
}

export function refundIdempotencyScope(
  accountId: string | undefined,
  paymentId: string,
  transactionId: string,
): string {
  const acct = accountId && accountId.length > 0 ? accountId : '_';
  return `refund:${acct}:${paymentId}:${transactionId}`;
}

export function cancelOrRefundPaymentIdempotencyScope(
  accountId: string | undefined,
  paymentId: string,
): string {
  const acct = accountId && accountId.length > 0 ? accountId : '_';
  return `cancel-or-refund:${acct}:${paymentId}`;
}

export function cancelOrRefundTxIdempotencyScope(
  accountId: string | undefined,
  paymentId: string,
  transactionId: string,
): string {
  const acct = accountId && accountId.length > 0 ? accountId : '_';
  return `cancel-or-refund-tx:${acct}:${paymentId}:${transactionId}`;
}

export function lookupPaymentAccountId(
  store: YunoMockStore,
  paymentId: string,
): string | undefined {
  const record = findPaymentById(store, paymentId);
  if (!record) return undefined;
  return asPaymentData(record).account_id;
}

function buildActionTx(
  data: StoredPaymentData,
  input: {
    type: StoredTransaction['type'];
    amount: number;
    status: string;
    merchant_reference: string;
    description?: string;
    reason?: string;
    response_code: string;
    response_message: string;
    ts: string;
  },
): StoredTransaction {
  return {
    id: newYunoId(),
    type: input.type,
    status: input.status,
    category: data.transaction.category,
    amount: quantizeAmount(input.amount),
    currency: data.amount.currency,
    provider_id: data.transaction.provider_id,
    payment_method: {
      type: data.payment_method.type,
      vaulted_token: data.payment_method.vaulted_token,
    },
    response_code: input.response_code,
    response_message: input.response_message,
    created_at: input.ts,
    updated_at: input.ts,
    merchant_reference: input.merchant_reference,
    description: input.description,
    reason: input.reason,
  };
}

type ActionResult = {
  body: Record<string, unknown>;
  actionTx: StoredTransaction;
};

function captureInStore(
  store: YunoMockStore,
  paymentId: string,
  transactionId: string,
  body: CaptureBody,
  ctx: PostPayContext,
): ActionResult {
  const record = findPaymentById(store, paymentId);
  if (!record) throw Errors.invalidRequest('payment_id not found');
  const data = asPaymentData(record);
  assertMutablePayment(data, 'capture');
  assertAuthorizeTarget(data, transactionId, 'capture');

  const canCapture =
    data.status === 'AUTHORIZED' ||
    (data.status === 'SUCCEEDED' && data.sub_status === 'PARTIALLY_CAPTURED');
  if (!canCapture) {
    throw Errors.invalidRequest(
      `cannot capture: payment status ${data.status}/${data.sub_status} is not an open authorization`,
    );
  }

  if (body.amount.currency !== data.amount.currency) {
    throw Errors.invalidRequest('capture amount.currency must match payment currency');
  }
  const captureAmount = assertProviderAmount(body.amount.value, 'capture amount.value');

  const remaining = remainingCapturable(data);
  if (amountsEqual(remaining, 0)) {
    throw Errors.invalidRequest('cannot capture: authorization already fully captured');
  }
  if (!amountLessOrEqual(captureAmount, remaining)) {
    throw Errors.invalidRequest(
      `cannot capture: amount ${captureAmount} exceeds remaining authorization ${remaining}`,
    );
  }

  const ts = nowIso();
  data.amount.captured = addAmounts(data.amount.captured, captureAmount);
  const full = amountsEqual(data.amount.captured, data.amount.value);

  if (full) {
    data.status = 'SUCCEEDED';
    data.sub_status = 'CAPTURED';
    syncPrimaryTransaction(data, {
      status: 'SUCCEEDED',
      updated_at: ts,
      response_code: '00',
      response_message: 'Captured',
    });
  } else {
    data.status = 'SUCCEEDED';
    data.sub_status = 'PARTIALLY_CAPTURED';
    syncPrimaryTransaction(data, {
      status: 'AUTHORIZED',
      updated_at: ts,
    });
  }

  const captureTx = buildActionTx(data, {
    type: 'CAPTURE',
    amount: captureAmount,
    status: 'SUCCEEDED',
    merchant_reference: body.merchant_reference,
    reason: body.reason,
    response_code: '00',
    response_message: 'Approved',
    ts,
  });
  appendTransaction(data, captureTx);
  persist(record, data, ts);
  emitActionWebhook(store, record, 'CAPTURE', captureTx, ctx);
  return {
    body: toActionTransactionResponse(record, captureTx),
    actionTx: captureTx,
  };
}

function cancelInStore(
  store: YunoMockStore,
  paymentId: string,
  transactionId: string,
  body: CancelBody,
  ctx: PostPayContext,
): ActionResult {
  const record = findPaymentById(store, paymentId);
  if (!record) throw Errors.invalidRequest('payment_id not found');
  const data = asPaymentData(record);
  assertMutablePayment(data, 'cancel');
  assertAuthorizeTarget(data, transactionId, 'cancel');

  if (data.status === 'CANCELED' || data.status === 'CANCELLED') {
    throw Errors.invalidRequest('cannot cancel: payment is already CANCELED');
  }

  const openAuth =
    data.status === 'AUTHORIZED' ||
    (data.status === 'SUCCEEDED' &&
      data.sub_status === 'PARTIALLY_CAPTURED' &&
      remainingCapturable(data) > 0);
  if (!openAuth) {
    throw Errors.invalidRequest(
      `cannot cancel: payment status ${data.status}/${data.sub_status} has no remaining authorization`,
    );
  }

  const ts = nowIso();
  const cancelAmount = remainingCapturable(data);

  if (amountsEqual(data.amount.captured, 0)) {
    data.status = 'CANCELED';
    data.sub_status = 'CANCELED';
    syncPrimaryTransaction(data, {
      status: 'CANCELED',
      updated_at: ts,
      response_code: '00',
      response_message: 'Canceled',
    });
  } else {
    data.status = 'SUCCEEDED';
    data.sub_status = 'CAPTURED';
    syncPrimaryTransaction(data, {
      status: 'SUCCEEDED',
      updated_at: ts,
      response_code: '00',
      response_message: 'Remaining authorization canceled',
    });
  }

  const cancelTx = buildActionTx(data, {
    type: 'CANCEL',
    amount: cancelAmount > 0 ? cancelAmount : data.amount.value,
    status: 'SUCCEEDED',
    merchant_reference: body.merchant_reference,
    description: body.description,
    reason: body.reason,
    response_code: '00',
    response_message: 'Approved',
    ts,
  });
  appendTransaction(data, cancelTx);
  persist(record, data, ts);
  emitActionWebhook(store, record, 'CANCEL', cancelTx, ctx);
  return {
    body: toActionTransactionResponse(record, cancelTx),
    actionTx: cancelTx,
  };
}

function refundInStore(
  store: YunoMockStore,
  paymentId: string,
  transactionId: string,
  body: RefundBody,
  ctx: PostPayContext,
): ActionResult {
  const record = findPaymentById(store, paymentId);
  if (!record) throw Errors.invalidRequest('payment_id not found');
  const data = asPaymentData(record);
  assertMutablePayment(data, 'refund');
  assertRefundTarget(data, transactionId);

  const canRefund =
    data.status === 'SUCCEEDED' &&
    data.amount.captured > 0 &&
    (data.sub_status === 'APPROVED' ||
      data.sub_status === 'CAPTURED' ||
      data.sub_status === 'PARTIALLY_CAPTURED' ||
      data.sub_status === 'PARTIALLY_REFUNDED' ||
      amountsEqual(data.amount.captured, data.amount.value));

  if (data.status === 'REFUNDED') {
    throw Errors.invalidRequest('cannot refund: payment is already fully REFUNDED');
  }
  if (data.status === 'AUTHORIZED' || data.status === 'CANCELED') {
    throw Errors.invalidRequest(
      `cannot refund: payment status ${data.status} has no captured funds`,
    );
  }
  if (!canRefund) {
    throw Errors.invalidRequest(
      `cannot refund: payment status ${data.status}/${data.sub_status}`,
    );
  }

  const remaining = remainingRefundable(data);
  if (amountsEqual(remaining, 0)) {
    throw Errors.invalidRequest('cannot refund: captured amount already fully refunded');
  }

  let refundAmount = remaining;
  if (body.amount?.value !== undefined) {
    if (
      body.amount.currency !== undefined &&
      body.amount.currency !== data.amount.currency
    ) {
      throw Errors.invalidRequest('refund amount.currency must match payment currency');
    }
    refundAmount = assertProviderAmount(body.amount.value, 'refund amount.value');
  }
  if (!amountLessOrEqual(refundAmount, remaining)) {
    throw Errors.invalidRequest(
      `cannot refund: amount ${refundAmount} exceeds remaining refundable ${remaining}`,
    );
  }

  const ts = nowIso();
  const failed = data.scenario === 'refund_failed';

  if (failed) {
    const failedTx = buildActionTx(data, {
      type: 'REFUND',
      amount: refundAmount,
      status: 'DECLINED',
      merchant_reference: body.merchant_reference,
      description: body.description,
      reason: body.reason,
      response_code: '05',
      response_message: 'Refund declined',
      ts,
    });
    appendTransaction(data, failedTx);
    persist(record, data, ts);
    emitActionWebhook(store, record, 'REFUND', failedTx, ctx);
    return {
      body: toRefundPaymentResponse(record, failedTx),
      actionTx: failedTx,
    };
  }

  data.amount.refunded = addAmounts(data.amount.refunded, refundAmount);
  const full = amountsEqual(data.amount.refunded, data.amount.captured);
  if (full) {
    data.status = 'REFUNDED';
    data.sub_status = 'REFUNDED';
  } else {
    data.status = 'SUCCEEDED';
    data.sub_status = 'PARTIALLY_REFUNDED';
  }

  const refundTx = buildActionTx(data, {
    type: 'REFUND',
    amount: refundAmount,
    status: 'SUCCEEDED',
    merchant_reference: body.merchant_reference,
    description: body.description,
    reason: body.reason,
    response_code: '00',
    response_message: 'Approved',
    ts,
  });
  appendTransaction(data, refundTx);
  persist(record, data, ts);
  emitActionWebhook(store, record, 'REFUND', refundTx, ctx);
  return {
    body: toRefundPaymentResponse(record, refundTx),
    actionTx: refundTx,
  };
}

export async function capturePayment(
  repo: YunoMockRepository,
  paymentId: string,
  transactionId: string,
  body: CaptureBody,
  ctx: PostPayContext,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    return captureInStore(store, paymentId, transactionId, body, ctx).body;
  });
}

export async function cancelPayment(
  repo: YunoMockRepository,
  paymentId: string,
  transactionId: string,
  body: CancelBody,
  ctx: PostPayContext,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    return cancelInStore(store, paymentId, transactionId, body, ctx).body;
  });
}

export async function refundPayment(
  repo: YunoMockRepository,
  paymentId: string,
  transactionId: string,
  body: RefundBody,
  ctx: PostPayContext,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    return refundInStore(store, paymentId, transactionId, body, ctx).body;
  });
}

function cancelReasonFromBody(
  reason: CancelOrRefundBody['reason'],
): CancelBody['reason'] {
  if (
    reason === 'DUPLICATE' ||
    reason === 'FRAUDULENT' ||
    reason === 'REQUESTED_BY_CUSTOMER'
  ) {
    return reason;
  }
  return undefined;
}

/**
 * Payment-level cancel-or-refund: branch by payment state
 * (AUTHORIZED → cancel; captured SUCCEEDED → refund).
 * Entire mutation + response built under one lock using the exact action tx.
 */
export async function cancelOrRefundPayment(
  repo: YunoMockRepository,
  paymentId: string,
  body: CancelOrRefundBody,
  ctx: PostPayContext,
): Promise<{ body: Record<string, unknown>; branch: CancelOrRefundBranch }> {
  return repo.withLock((store) => {
    const record = findPaymentById(store, paymentId);
    if (!record) throw Errors.invalidRequest('payment_id not found');
    const data = asPaymentData(record);
    assertMutablePayment(data, 'cancel-or-refund');
    const branch = selectCancelOrRefundBranch(data);
    const merchantReference =
      body.merchant_reference && body.merchant_reference.length >= 3
        ? body.merchant_reference
        : data.merchant_order_id;

    if (branch === 'cancel') {
      const result = cancelInStore(
        store,
        paymentId,
        data.transaction.id,
        {
          merchant_reference: merchantReference,
          description: body.description,
          reason: cancelReasonFromBody(body.reason),
        },
        ctx,
      );
      return { body: result.body, branch: 'cancel' };
    }

    const result = refundInStore(
      store,
      paymentId,
      // Prefer a CAPTURE when present (manual auth path); else primary PURCHASE.
      findRefundableTransactionId(data),
      {
        merchant_reference: merchantReference,
        amount: body.amount as RefundBody['amount'],
        description: body.description,
        reason: body.reason,
      },
      ctx,
    );
    return {
      body: toActionTransactionResponse(record, result.actionTx),
      branch: 'refund',
    };
  });
}

/**
 * Transaction-level cancel-or-refund: branch by selected transaction type.
 * AUTHORIZE → cancel; PURCHASE/CAPTURE → refund; CANCEL/REFUND → reject.
 * Fully captured auth selecting AUTHORIZE does NOT silently refund.
 */
export async function cancelOrRefundPaymentTransaction(
  repo: YunoMockRepository,
  paymentId: string,
  transactionId: string,
  body: CancelOrRefundBody,
  ctx: PostPayContext,
): Promise<{ body: Record<string, unknown>; branch: CancelOrRefundBranch }> {
  return repo.withLock((store) => {
    const record = findPaymentById(store, paymentId);
    if (!record) throw Errors.invalidRequest('payment_id not found');
    const data = asPaymentData(record);
    assertMutablePayment(data, 'cancel-or-refund');
    const target = findTargetTransaction(data, transactionId);
    if (!target) {
      throw Errors.invalidRequest('cancel-or-refund: transaction_id not found on payment');
    }
    const branch = selectCancelOrRefundBranchByTransaction(target);
    const merchantReference =
      body.merchant_reference && body.merchant_reference.length >= 3
        ? body.merchant_reference
        : data.merchant_order_id;

    if (branch === 'cancel') {
      const result = cancelInStore(
        store,
        paymentId,
        transactionId,
        {
          merchant_reference: merchantReference,
          description: body.description,
          reason: cancelReasonFromBody(body.reason),
        },
        ctx,
      );
      return { body: result.body, branch: 'cancel' };
    }

    const result = refundInStore(
      store,
      paymentId,
      transactionId,
      {
        merchant_reference: merchantReference,
        amount: body.amount as RefundBody['amount'],
        description: body.description,
        reason: body.reason,
      },
      ctx,
    );
    return {
      body: toActionTransactionResponse(record, result.actionTx),
      branch: 'refund',
    };
  });
}

function findRefundableTransactionId(data: StoredPaymentData): string {
  const capture = [...data.transactions].reverse().find((tx) => tx.type === 'CAPTURE');
  if (capture) return capture.id;
  if (data.transaction.type === 'PURCHASE') return data.transaction.id;
  const purchase = data.transactions.find((tx) => tx.type === 'PURCHASE');
  if (purchase) return purchase.id;
  throw Errors.invalidRequest(
    'cancel-or-refund: no PURCHASE or CAPTURE transaction available to refund',
  );
}

/**
 * Deterministic payment-level branch: authorization → cancel; captured → refund.
 */
export function selectCancelOrRefundBranch(
  data: StoredPaymentData,
): CancelOrRefundBranch {
  if (data.status === 'CANCELED' || data.status === 'CANCELLED') {
    throw Errors.invalidRequest('cancel-or-refund: payment is already CANCELED');
  }
  if (data.status === 'AUTHORIZED') {
    return 'cancel';
  }
  if (data.status === 'SUCCEEDED' && data.amount.captured > 0 && remainingRefundable(data) > 0) {
    return 'refund';
  }
  throw Errors.invalidRequest(
    'cancel-or-refund: payment has no cancelable authorization or refundable captured amount',
  );
}

/**
 * Transaction-level branch by selected transaction type (migration semantics).
 */
export function selectCancelOrRefundBranchByTransaction(
  tx: StoredTransaction,
): CancelOrRefundBranch {
  if (tx.type === 'AUTHORIZE') return 'cancel';
  if (tx.type === 'PURCHASE' || tx.type === 'CAPTURE') return 'refund';
  throw Errors.invalidRequest(
    `cancel-or-refund: cannot cancel-or-refund a ${tx.type} transaction`,
  );
}
