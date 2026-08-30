import type {
  PaymentMethodRecord,
  PaymentRecord,
  YunoMockRepository,
  YunoMockStore,
} from '../persistence/types.js';
import { Errors } from '../errors.js';
import { newYunoId, nowIso } from '../domain/ids.js';
import type { PaymentScenario } from '../domain/scenarios.js';
import { readPaymentScenario } from './scenarios.js';
import {
  emitPaymentEvent,
  scheduleAsyncAction,
} from './webhook-delivery.js';
import {
  applyPaymentTerminalState,
  asPaymentData,
  hasExcessFractionalDigits,
  paymentTriggerFor,
  quantizeAmount,
  toCreateResponse,
  toRetrieveResponse,
  type StoredPaymentData,
  type StoredTransaction,
  type ThreeDsChallenge,
} from './payment-view.js';

export type { StoredPaymentData, StoredTransaction, ThreeDsChallenge };
export {
  asPaymentData,
  applyPaymentTerminalState,
  paymentTriggerFor,
  serializeContractAmountValue,
  toCreateResponse,
  toRetrieveResponse,
} from './payment-view.js';

export type CreatePaymentBody = {
  account_id: string;
  description: string;
  country: string;
  merchant_order_id: string;
  amount: { currency: string; value: number };
  payment_method: {
    type: string;
    vaulted_token?: string;
    detail?: {
      card?: {
        capture?: boolean;
      };
    };
  };
  checkout?: Record<string, unknown>;
  workflow?: string;
  customer_id?: string;
  [key: string]: unknown;
};

type StoredMethodData = {
  account_id: string;
  country: string;
  category: string;
  type: string;
  name: string;
  status: string;
  vaulted_token: string;
  card_data: Record<string, unknown>;
};

function asMethod(record: PaymentMethodRecord): StoredMethodData {
  return record.data as unknown as StoredMethodData;
}

function asPayment(record: PaymentRecord): StoredPaymentData {
  return asPaymentData(record);
}

export function findPaymentById(
  store: YunoMockStore,
  id: string,
): PaymentRecord | undefined {
  return store.payments.find((p) => p.id === id);
}

function findEnrolledByVaultedToken(
  store: YunoMockStore,
  vaultedToken: string,
  accountId: string,
): PaymentMethodRecord | undefined {
  return store.paymentMethods.find((pm) => {
    const data = asMethod(pm);
    return (
      data.vaulted_token === vaultedToken &&
      data.status === 'ENROLLED' &&
      data.account_id === accountId
    );
  });
}

const ISO_COUNTRY = /^[A-Z]{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Account-scoped idempotency namespace when body carries a UUID account_id. */
export function paymentIdempotencyScope(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const accountId = (body as { account_id?: unknown }).account_id;
  if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) return undefined;
  return `payment:${accountId}`;
}

/**
 * Validate create-payment business rules before consuming X-Idempotency-Key.
 * Throws YunoHttpError (400) on rejection.
 */
export function assertCreatePaymentPreconditions(
  store: YunoMockStore,
  body: CreatePaymentBody,
): PaymentMethodRecord {
  if (!body.account_id || !UUID_RE.test(body.account_id)) {
    throw Errors.invalidRequest('account_id must be a UUID');
  }
  if (!body.country || !ISO_COUNTRY.test(body.country)) {
    throw Errors.invalidRequest('country must be an ISO 3166-1 alpha-2 code');
  }
  if (!body.amount?.currency || !ISO_CURRENCY.test(body.amount.currency)) {
    throw Errors.invalidRequest('amount.currency must be an ISO 4217 code');
  }
  if (typeof body.amount.value !== 'number' || !Number.isFinite(body.amount.value)) {
    throw Errors.invalidRequest('amount.value must be a finite number');
  }
  if (body.amount.value <= 0) {
    throw Errors.invalidRequest('amount.value must be positive');
  }
  if (hasExcessFractionalDigits(body.amount.value)) {
    throw Errors.invalidRequest(
      'amount.value must be a multiple of 0.0001 (at most 4 fractional digits)',
    );
  }
  body.amount.value = quantizeAmount(body.amount.value);

  const vaultedToken = body.payment_method?.vaulted_token;
  if (!vaultedToken || typeof vaultedToken !== 'string') {
    throw Errors.invalidRequest('payment_method.vaulted_token is required for F3 vaulted payments');
  }

  const method = findEnrolledByVaultedToken(store, vaultedToken, body.account_id);
  if (!method) {
    const any = store.paymentMethods.find((pm) => asMethod(pm).vaulted_token === vaultedToken);
    if (any) {
      throw Errors.invalidRequest('payment method is not ENROLLED (inactive or unenrolled token)');
    }
    throw Errors.invalidRequest('unknown vaulted_token');
  }

  const data = asMethod(method);
  if (data.country && data.country !== body.country) {
    throw Errors.invalidRequest('country does not match enrolled payment method');
  }

  return method;
}

function captureRequested(body: CreatePaymentBody): boolean {
  const capture = body.payment_method?.detail?.card?.capture;
  return capture !== false;
}

type Outcome = {
  paymentStatus: string;
  subStatus: string;
  txStatus: string;
  responseCode: string;
  responseMessage: string;
  uncertain: boolean;
  httpStatus: 201 | 500;
  sdkActionRequired: boolean;
};

function resolveOutcome(
  scenario: PaymentScenario,
  isPurchase: boolean,
): Outcome {
  switch (scenario) {
    case 'declined':
      return {
        paymentStatus: 'DECLINED',
        subStatus: 'DECLINED',
        txStatus: 'DECLINED',
        responseCode: '05',
        responseMessage: 'Do not honor',
        uncertain: false,
        httpStatus: 201,
        sdkActionRequired: false,
      };
    case 'insufficient_funds':
      return {
        paymentStatus: 'DECLINED',
        subStatus: 'INSUFFICIENT_FUNDS',
        txStatus: 'DECLINED',
        responseCode: '51',
        responseMessage: 'Insufficient funds',
        uncertain: false,
        httpStatus: 201,
        sdkActionRequired: false,
      };
    case 'requires_3ds':
      return {
        paymentStatus: 'PENDING',
        subStatus: 'WAITING_ADDITIONAL_STEP',
        txStatus: 'PENDING',
        responseCode: '09',
        responseMessage: 'Additional authentication required',
        uncertain: false,
        httpStatus: 201,
        sdkActionRequired: true,
      };
    case 'processing_then_success':
    case 'processing_then_declined':
      return {
        paymentStatus: 'PENDING',
        subStatus: 'IN_PROCESS',
        txStatus: 'PENDING',
        responseCode: '09',
        responseMessage: 'Request in progress',
        uncertain: false,
        httpStatus: 201,
        sdkActionRequired: false,
      };
    case 'duplicate_webhook':
    case 'out_of_order_webhooks':
    case 'invalid_hmac':
      if (!isPurchase) {
        return {
          paymentStatus: 'AUTHORIZED',
          subStatus: 'AUTHORIZED',
          txStatus: 'AUTHORIZED',
          responseCode: '00',
          responseMessage: 'Authorized',
          uncertain: false,
          httpStatus: 201,
          sdkActionRequired: false,
        };
      }
      return {
        paymentStatus: 'SUCCEEDED',
        subStatus: 'APPROVED',
        txStatus: 'SUCCEEDED',
        responseCode: '00',
        responseMessage: 'Approved',
        uncertain: false,
        httpStatus: 201,
        sdkActionRequired: false,
      };
    case 'authorized':
      return {
        paymentStatus: 'AUTHORIZED',
        subStatus: 'AUTHORIZED',
        txStatus: 'AUTHORIZED',
        responseCode: '00',
        responseMessage: 'Authorized',
        uncertain: false,
        httpStatus: 201,
        sdkActionRequired: false,
      };
    case 'provider_timeout':
      return {
        paymentStatus: 'PENDING',
        subStatus: 'IN_PROCESS',
        txStatus: 'PENDING',
        responseCode: '91',
        responseMessage: 'Issuer or switch inoperative',
        uncertain: true,
        httpStatus: 500,
        sdkActionRequired: false,
      };
    case 'success':
    default: {
      if (!isPurchase) {
        return {
          paymentStatus: 'AUTHORIZED',
          subStatus: 'AUTHORIZED',
          txStatus: 'AUTHORIZED',
          responseCode: '00',
          responseMessage: 'Authorized',
          uncertain: false,
          httpStatus: 201,
          sdkActionRequired: false,
        };
      }
      return {
        paymentStatus: 'SUCCEEDED',
        subStatus: 'APPROVED',
        txStatus: 'SUCCEEDED',
        responseCode: '00',
        responseMessage: 'Approved',
        uncertain: false,
        httpStatus: 201,
        sdkActionRequired: false,
      };
    }
  }
}

export type CreatePaymentResult = {
  httpStatus: 201 | 500;
  body: Record<string, unknown>;
};

export type CreatePaymentContext = {
  secretsKey: Buffer;
  nowMs: number;
};

export async function createPayment(
  repo: YunoMockRepository,
  body: CreatePaymentBody,
  idempotencyKey: string,
  ctx: CreatePaymentContext,
): Promise<CreatePaymentResult> {
  return repo.withLock((store) => {
    const method = assertCreatePaymentPreconditions(store, body);
    const methodData = asMethod(method);
    const scenario = readPaymentScenario(store);
    const isPurchase = captureRequested(body) && scenario !== 'authorized';
    const outcome = resolveOutcome(scenario, isPurchase);
    const ts = nowIso();
    const paymentId = newYunoId();
    const transactionId = newYunoId();

    const amountValue = quantizeAmount(body.amount.value);
    const captured = outcome.paymentStatus === 'SUCCEEDED' ? amountValue : 0;

    const txType: StoredTransaction['type'] = isPurchase ? 'PURCHASE' : 'AUTHORIZE';
    const transaction: StoredTransaction = {
      id: transactionId,
      type: txType,
      status: outcome.txStatus,
      category: 'CARD',
      amount: amountValue,
      currency: body.amount.currency,
      provider_id: 'YUNO',
      payment_method: {
        type: body.payment_method.type || 'CARD',
        vaulted_token: methodData.vaulted_token,
      },
      response_code: outcome.responseCode,
      response_message: outcome.responseMessage,
      created_at: ts,
      updated_at: ts,
      merchant_reference: body.merchant_order_id,
      description: body.description,
    };

    const stored: StoredPaymentData = {
      account_id: body.account_id,
      description: body.description,
      country: body.country,
      merchant_order_id: body.merchant_order_id,
      amount: {
        currency: body.amount.currency,
        value: amountValue,
        captured,
        refunded: 0,
      },
      status: outcome.paymentStatus,
      sub_status: outcome.subStatus,
      workflow: body.workflow ?? 'DIRECT',
      checkout: {
        session:
          typeof body.checkout?.session === 'string'
            ? body.checkout.session
            : '',
        sdk_action_required: outcome.sdkActionRequired,
      },
      customer_payer: { id: method.customerId ?? newYunoId() },
      payment_method: {
        type: body.payment_method.type || 'CARD',
        vaulted_token: methodData.vaulted_token,
        detail: { card: { capture: isPurchase } },
      },
      transaction,
      transactions: [transaction],
      scenario,
      idempotency_key: idempotencyKey,
      outcome_uncertain: outcome.uncertain || undefined,
      three_ds:
        scenario === 'requires_3ds'
          ? { status: 'pending', created_at: ts }
          : undefined,
    };

    const record: PaymentRecord = {
      id: paymentId,
      data: stored as unknown as Record<string, unknown>,
      createdAt: ts,
      updatedAt: ts,
    };
    store.payments.push(record);

    schedulePostCreateSideEffects(store, record, ctx);

    if (outcome.httpStatus === 500) {
      return {
        httpStatus: 500,
        body: {
          code: 'PROVIDER_ERROR',
          messages: [
            'Provider timeout — payment outcome uncertain; retry with the same X-Idempotency-Key or GET when id is known',
          ],
        },
      };
    }

    return {
      httpStatus: 201,
      body: toCreateResponse(record),
    };
  });
}

function schedulePostCreateSideEffects(
  store: YunoMockStore,
  record: PaymentRecord,
  ctx: CreatePaymentContext,
): void {
  const data = asPayment(record);
  const scenario = data.scenario;
  const nowMs = ctx.nowMs;

  if (scenario === 'requires_3ds') return;

  if (scenario === 'processing_then_success') {
    scheduleAsyncAction(store, {
      kind: 'processing_terminal',
      paymentId: record.id,
      dueAtMs: nowMs,
      data: {
        terminalStatus: 'SUCCEEDED',
        terminalSubStatus: 'APPROVED',
      },
    });
    return;
  }

  if (scenario === 'processing_then_declined') {
    scheduleAsyncAction(store, {
      kind: 'processing_terminal',
      paymentId: record.id,
      dueAtMs: nowMs,
      data: {
        terminalStatus: 'DECLINED',
        terminalSubStatus: 'DECLINED',
      },
    });
    return;
  }

  if (scenario === 'provider_timeout') return;

  const isTerminal =
    data.status === 'SUCCEEDED' ||
    data.status === 'DECLINED' ||
    data.status === 'AUTHORIZED';

  if (!isTerminal) return;

  // invalid_hmac: payment is already terminal in-store; emit ONLY a corrupted
  // signature delivery so a verifying receiver sees zero valid mutations.
  if (scenario === 'invalid_hmac') {
    scheduleAsyncAction(store, {
      kind: 'invalid_hmac_delivery',
      paymentId: record.id,
      dueAtMs: nowMs,
      data: { eventId: newYunoId() },
    });
    return;
  }

  const { eventId } = emitPaymentEvent(store, record, ctx.secretsKey, nowMs, {
    incomingStatus: { status: data.status, sub_status: data.sub_status },
  });

  if (scenario === 'duplicate_webhook') {
    scheduleAsyncAction(store, {
      kind: 'duplicate_redelivery',
      paymentId: record.id,
      dueAtMs: nowMs,
      data: { eventId, typeEvent: paymentTriggerFor(data) },
    });
  }

  if (scenario === 'out_of_order_webhooks') {
    scheduleAsyncAction(store, {
      kind: 'out_of_order_stale',
      paymentId: record.id,
      dueAtMs: nowMs,
      data: { staleEventId: newYunoId() },
    });
  }
}

export async function getPayment(
  repo: YunoMockRepository,
  paymentId: string,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const record = findPaymentById(store, paymentId);
    if (!record) {
      throw Errors.invalidRequest('payment_id not found');
    }
    return toRetrieveResponse(record);
  });
}

export type ThreeDsInspect = {
  payment_id: string;
  status: string;
  sub_status: string;
  sdk_action_required: boolean;
  three_ds: ThreeDsChallenge | null;
};

export async function inspectThreeDs(
  repo: YunoMockRepository,
  paymentId: string,
): Promise<ThreeDsInspect> {
  return repo.withLock((store) => {
    const record = findPaymentById(store, paymentId);
    if (!record) throw Errors.notFound('payment_id not found');
    const data = asPayment(record);
    return {
      payment_id: record.id,
      status: data.status,
      sub_status: data.sub_status,
      sdk_action_required: data.checkout.sdk_action_required,
      three_ds: data.three_ds ?? null,
    };
  });
}

export type ThreeDsCompleteResult = 'success' | 'fail' | 'expire';

/**
 * Complete a pending 3DS challenge. Idempotent for repeated/stale actions:
 * terminal three_ds states never rewind.
 */
export async function completeThreeDs(
  repo: YunoMockRepository,
  paymentId: string,
  result: ThreeDsCompleteResult,
  ctx: CreatePaymentContext,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const record = findPaymentById(store, paymentId);
    if (!record) throw Errors.notFound('payment_id not found');
    const data = asPayment(record);

    if (!data.three_ds) {
      throw Errors.invalidRequest('payment does not require 3DS');
    }

    if (data.three_ds.status !== 'pending') {
      return toRetrieveResponse(record);
    }

    if (
      data.status !== 'PENDING' ||
      data.sub_status !== 'WAITING_ADDITIONAL_STEP'
    ) {
      return toRetrieveResponse(record);
    }

    const ts = nowIso();
    if (result === 'success') {
      const isPurchase = data.transaction.type === 'PURCHASE';
      applyPaymentTerminalState(record, {
        status: isPurchase ? 'SUCCEEDED' : 'AUTHORIZED',
        subStatus: isPurchase ? 'APPROVED' : 'AUTHORIZED',
        nowIso: ts,
        responseCode: '00',
        responseMessage: isPurchase ? 'Approved' : 'Authorized',
        sdkActionRequired: false,
      });
      data.three_ds = {
        status: 'succeeded',
        created_at: data.three_ds.created_at,
        completed_at: ts,
        result: 'success',
      };
    } else if (result === 'fail') {
      applyPaymentTerminalState(record, {
        status: 'DECLINED',
        subStatus: 'DECLINED',
        nowIso: ts,
        responseCode: '05',
        responseMessage: '3DS authentication failed',
        sdkActionRequired: false,
      });
      data.three_ds = {
        status: 'failed',
        created_at: data.three_ds.created_at,
        completed_at: ts,
        result: 'fail',
      };
    } else {
      applyPaymentTerminalState(record, {
        status: 'EXPIRED',
        subStatus: 'EXPIRED',
        nowIso: ts,
        responseCode: '91',
        responseMessage: '3DS challenge expired',
        sdkActionRequired: false,
      });
      data.three_ds = {
        status: 'expired',
        created_at: data.three_ds.created_at,
        completed_at: ts,
        result: 'expire',
      };
    }
    record.data = data as unknown as Record<string, unknown>;

    const fresh = asPayment(record);
    emitPaymentEvent(store, record, ctx.secretsKey, ctx.nowMs, {
      incomingStatus: { status: fresh.status, sub_status: fresh.sub_status },
    });

    return toRetrieveResponse(record);
  });
}
