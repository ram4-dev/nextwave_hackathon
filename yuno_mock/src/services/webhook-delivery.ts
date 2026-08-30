/**
 * Outbound Yuno webhook emission, HMAC signing, and retry scheduling (F4).
 * Clock + fetch are injected — tests advance time without sleeping.
 */
import {
  decidePaymentEventApplication,
} from '../../../src/providers/yuno/payment-event-guard.js';
import {
  signYunoWebhookBody,
  YUNO_HMAC_SIGNATURE_HEADER,
} from '../../../src/providers/yuno/webhook-verifier.js';
import {
  WEBHOOK_MAX_ATTEMPTS,
  nextWebhookAttemptAt,
} from '../domain/retry.js';
import { newYunoId, nowIso } from '../domain/ids.js';
import { redactWebhookSecretsForExport } from '../redact.js';
import type {
  AsyncActionRecord,
  DeliveryRecord,
  PaymentRecord,
  ProviderEventRecord,
  YunoMockRepository,
  YunoMockStore,
} from '../persistence/types.js';
import type { MockRuntime } from '../runtime.js';
import {
  asPaymentData,
  applyPaymentTerminalState,
  paymentTriggerFor,
  toCreateResponse,
  toWebhookPaymentBody,
  type StoredPaymentData,
  type StoredTransaction,
} from './payment-view.js';
import {
  decryptWebhookSecret,
  listActiveWebhooksForAccount,
  webhookUrl,
} from './webhooks.js';

export type EmitPaymentEventOptions = {
  /** Override event id (duplicate redelivery). */
  eventId?: string;
  /** When true, sign with a deliberately wrong secret. */
  corruptHmac?: boolean;
  /** Skip payment mutation / appliedEventIds (stale redelivery only). */
  skipApply?: boolean;
  /** Incoming status snapshot for rank guard (defaults to payment's current). */
  incomingStatus?: { status: string; sub_status?: string };
  /** Force type_event / payment_triggers match. */
  typeEvent?: string;
  /**
   * Exact outbound payload/raw body to persist and deliver.
   * Used for genuine stale out-of-order events that must not match current store state.
   */
  payloadOverride?: Record<string, unknown>;
  rawBodyOverride?: string;
  /**
   * When set, webhook `data.payment.transactions` is this action transaction
   * (CAPTURE/CANCEL/REFUND) instead of the primary AUTHORIZE/PURCHASE.
   */
  actionTransaction?: StoredTransaction;
};

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function buildEventPayload(
  eventId: string,
  typeEvent: string,
  payment: PaymentRecord,
  createdAt: string,
  actionTransaction?: StoredTransaction,
): Record<string, unknown> {
  const paymentBody = toWebhookPaymentBody(payment, actionTransaction);
  return {
    id: eventId,
    type: 'payment',
    type_event: typeEvent,
    created_at: createdAt,
    data: {
      payment: paymentBody,
    },
  };
}

/**
 * Build a genuine stale PENDING snapshot from a (possibly already-terminal) payment
 * without mutating the stored record. Used by out_of_order_webhooks.
 */
export function buildStalePendingPaymentPayload(
  payment: PaymentRecord,
  eventId: string,
  createdAt: string,
): Record<string, unknown> {
  const current = toCreateResponse(payment) as Record<string, unknown>;
  const amount = (current.amount as Record<string, unknown>) ?? {};
  const tx = (current.transactions as Record<string, unknown>) ?? {};
  const checkout = (current.checkout as Record<string, unknown>) ?? {};
  const stalePayment = {
    ...current,
    status: 'PENDING',
    sub_status: 'IN_PROCESS',
    amount: {
      ...amount,
      captured: 0,
    },
    checkout: {
      ...checkout,
      sdk_action_required: false,
    },
    transactions: {
      ...tx,
      status: 'PENDING',
      response_code: '09',
      response_message: 'Request in progress',
    },
  };
  return {
    id: eventId,
    type: 'payment',
    type_event: paymentTriggerFor(asPaymentData(payment)),
    created_at: createdAt,
    data: {
      payment: stalePayment,
    },
  };
}

/**
 * Apply a payment status event under dedup + rank guard, then schedule deliveries.
 * Returns whether the payment record was mutated.
 */
export function emitPaymentEvent(
  store: YunoMockStore,
  payment: PaymentRecord,
  secretsKey: Buffer,
  nowMs: number,
  options: EmitPaymentEventOptions = {},
): { eventId: string; applied: boolean; deliveryIds: string[] } {
  const data = asPaymentData(payment);
  const typeEvent = options.typeEvent ?? paymentTriggerFor(data);
  const eventId = options.eventId ?? newYunoId();
  const createdAt = isoFromMs(nowMs);

  const incoming = options.incomingStatus ?? {
    status: data.status,
    sub_status: data.sub_status,
  };

  let applied = false;
  if (!options.skipApply) {
    const decision = decidePaymentEventApplication({
      current: { status: data.status, sub_status: data.sub_status },
      incoming,
      eventId,
      seenEventIds: store.appliedEventIds,
    });
    if (decision.reason === 'duplicate_event') {
      applied = false;
    } else if (decision.apply) {
      if (
        incoming.status !== data.status ||
        (incoming.sub_status ?? '') !== (data.sub_status ?? '')
      ) {
        applyPaymentTerminalState(payment, {
          status: incoming.status,
          subStatus: incoming.sub_status ?? incoming.status,
          nowIso: createdAt,
        });
      }
      store.appliedEventIds.push(eventId);
      applied = true;
    } else {
      // same_state (local already matches) or stale_or_out_of_order:
      // record the event id so later duplicates skip mutation; never rewind.
      if (!store.appliedEventIds.includes(eventId)) {
        store.appliedEventIds.push(eventId);
      }
      applied = false;
    }
  }

  // Always persist the outbound event record (audit) when scheduling delivery.
  const existingEvent = store.events.find((e) => e.id === eventId);
  const payload =
    options.payloadOverride ??
    (existingEvent
      ? (JSON.parse(
          existingEvent.rawBody ?? JSON.stringify(existingEvent.payloadRedacted),
        ) as Record<string, unknown>)
      : buildEventPayload(
          eventId,
          typeEvent,
          payment,
          createdAt,
          options.actionTransaction,
        ));
  const rawBody =
    options.rawBodyOverride ??
    existingEvent?.rawBody ??
    JSON.stringify(payload);
  const payloadRedacted = existingEvent
    ? existingEvent.payloadRedacted
    : (redactWebhookSecretsForExport(payload) as Record<string, unknown>);

  if (!existingEvent) {
    const eventRecord: ProviderEventRecord = {
      id: eventId,
      type: 'payment',
      typeEvent,
      paymentId: payment.id,
      payloadRedacted,
      rawBody,
      createdAt,
    };
    store.events.push(eventRecord);
  }

  const webhooks = listActiveWebhooksForAccount(store, data.account_id, typeEvent);
  const deliveryIds: string[] = [];

  for (const webhook of webhooks) {
    // Avoid scheduling a brand-new pending delivery when this exact event+webhook
    // already has a delivery row (duplicate redelivery reuses / reactivates).
    let delivery = store.deliveries.find(
      (d) => d.eventId === eventId && d.webhookId === webhook.id,
    );
    if (!delivery) {
      delivery = {
        id: newYunoId(),
        eventId,
        webhookId: webhook.id,
        attempt: 0,
        status: 'pending',
        payloadRedacted,
        rawBody,
        firstAttemptAtMs: nowMs,
        nextAttemptAtMs: nowMs,
        attempts: [],
        createdAt,
        updatedAt: createdAt,
      };
      store.deliveries.push(delivery);
    } else if (options.eventId) {
      // Explicit redelivery of same event: reset to pending at now without new id.
      delivery.status = 'pending';
      delivery.nextAttemptAtMs = nowMs;
      delivery.rawBody = rawBody;
      delivery.payloadRedacted = payloadRedacted;
      delivery.updatedAt = createdAt;
    }
    if (options.corruptHmac) {
      delivery.corruptHmac = true;
    }
    deliveryIds.push(delivery.id);
  }

  void secretsKey; // signing happens at delivery time
  return { eventId, applied, deliveryIds };
}

async function attemptDelivery(
  store: YunoMockStore,
  delivery: DeliveryRecord,
  secretsKey: Buffer,
  runtime: MockRuntime,
): Promise<void> {
  const webhook = store.webhooks.find((w) => w.id === delivery.webhookId);
  const nowMs = runtime.clock.now();
  const at = isoFromMs(nowMs);
  const attemptNumber = delivery.attempt + 1;

  if (!webhook) {
    delivery.attempts.push({
      attempt: attemptNumber,
      at,
      error: 'webhook_missing',
      outcome: 'failed',
    });
    delivery.attempt = attemptNumber;
    delivery.status = 'exhausted';
    delivery.nextAttemptAtMs = undefined;
    delivery.updatedAt = at;
    return;
  }

  const rawBody = delivery.rawBody ?? JSON.stringify(delivery.payloadRedacted);
  const hmacSecret = decryptWebhookSecret(webhook, 'hmac_client_secret', secretsKey);
  const apiKey = decryptWebhookSecret(webhook, 'api_key', secretsKey);

  let signature = '';
  if (hmacSecret) {
    signature = delivery.corruptHmac
      ? signYunoWebhookBody(rawBody, `${hmacSecret}-corrupt`)
      : signYunoWebhookBody(rawBody, hmacSecret);
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [YUNO_HMAC_SIGNATURE_HEADER]: signature,
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  let statusCode: number | undefined;
  let error: string | undefined;
  try {
    const res = await runtime.fetch(webhookUrl(webhook), {
      method: 'POST',
      headers,
      body: rawBody,
    });
    statusCode = res.status;
  } catch (err) {
    error = err instanceof Error ? err.message : 'network_error';
  }

  delivery.attempt = attemptNumber;
  delivery.updatedAt = at;

  if (statusCode === 200) {
    delivery.attempts.push({
      attempt: attemptNumber,
      at,
      statusCode,
      outcome: 'acknowledged',
    });
    delivery.status = 'delivered';
    delivery.nextAttemptAtMs = undefined;
    return;
  }

  const nextIndex = attemptNumber; // zero-based index of next try
  const nextAt = nextWebhookAttemptAt(delivery.firstAttemptAtMs, nextIndex);
  if (nextAt === null || attemptNumber >= WEBHOOK_MAX_ATTEMPTS) {
    delivery.attempts.push({
      attempt: attemptNumber,
      at,
      statusCode,
      error,
      outcome: 'exhausted',
    });
    delivery.status = 'exhausted';
    delivery.nextAttemptAtMs = undefined;
    return;
  }

  delivery.attempts.push({
    attempt: attemptNumber,
    at,
    statusCode,
    error,
    outcome: 'scheduled',
  });
  delivery.status = 'pending';
  delivery.nextAttemptAtMs = nextAt;
}

function processAsyncAction(
  store: YunoMockStore,
  action: AsyncActionRecord,
  secretsKey: Buffer,
  nowMs: number,
): void {
  const payment = store.payments.find((p) => p.id === action.paymentId);
  if (!payment) {
    action.status = 'canceled';
    return;
  }
  const data = asPaymentData(payment);

  if (action.kind === 'processing_terminal') {
    const terminal = String(action.data.terminalStatus ?? 'SUCCEEDED');
    const sub = String(action.data.terminalSubStatus ?? 'APPROVED');
    const eventId = newYunoId();
    emitPaymentEvent(store, payment, secretsKey, nowMs, {
      eventId,
      incomingStatus: { status: terminal, sub_status: sub },
      typeEvent: paymentTriggerFor({
        ...data,
        status: terminal,
        transaction: data.transaction,
      }),
    });
    action.status = 'done';
    return;
  }

  if (action.kind === 'duplicate_redelivery') {
    const eventId = String(action.data.eventId ?? '');
    if (!eventId) {
      action.status = 'canceled';
      return;
    }
    emitPaymentEvent(store, payment, secretsKey, nowMs, {
      eventId,
      skipApply: true,
      typeEvent: String(action.data.typeEvent ?? paymentTriggerFor(data)),
    });
    action.status = 'done';
    return;
  }

  if (action.kind === 'out_of_order_stale') {
    // Emit a genuine stale PENDING payload after terminal — must not rewind store.
    const staleEventId = String(action.data.staleEventId ?? newYunoId());
    const createdAt = isoFromMs(nowMs);
    const stalePayload = buildStalePendingPaymentPayload(
      payment,
      staleEventId,
      createdAt,
    );
    emitPaymentEvent(store, payment, secretsKey, nowMs, {
      eventId: staleEventId,
      incomingStatus: {
        status: 'PENDING',
        sub_status: 'IN_PROCESS',
      },
      typeEvent: paymentTriggerFor(data),
      payloadOverride: stalePayload,
      rawBodyOverride: JSON.stringify(stalePayload),
    });
    action.status = 'done';
    return;
  }

  if (action.kind === 'invalid_hmac_delivery') {
    const eventId = String(action.data.eventId ?? newYunoId());
    emitPaymentEvent(store, payment, secretsKey, nowMs, {
      eventId,
      corruptHmac: true,
      skipApply: true,
      typeEvent: paymentTriggerFor(data),
    });
    action.status = 'done';
    return;
  }

  action.status = 'canceled';
}

/**
 * Advance due async actions using the injected clock.
 */
export async function processDueAsyncActions(
  repo: YunoMockRepository,
  runtime: MockRuntime,
  secretsKey: Buffer,
): Promise<number> {
  return repo.withLock((store) => {
    const nowMs = runtime.clock.now();
    let count = 0;
    for (const action of store.asyncActions) {
      if (action.status !== 'pending') continue;
      if (action.dueAtMs > nowMs) continue;
      processAsyncAction(store, action, secretsKey, nowMs);
      count += 1;
    }
    return count;
  });
}

/**
 * Attempt due webhook deliveries (may call injected fetch).
 */
export async function processDueDeliveries(
  repo: YunoMockRepository,
  runtime: MockRuntime,
  secretsKey: Buffer,
): Promise<number> {
  let deliveriesAttempted = 0;
  for (;;) {
    const deliveryId = await repo.withLock((store) => {
      const nowMs = runtime.clock.now();
      const due = store.deliveries.find(
        (d) =>
          d.status === 'pending' &&
          (d.nextAttemptAtMs === undefined || d.nextAttemptAtMs <= nowMs),
      );
      return due?.id;
    });
    if (!deliveryId) break;

    await repo.withLock(async (store) => {
      const delivery = store.deliveries.find((d) => d.id === deliveryId);
      if (!delivery || delivery.status !== 'pending') return;
      const nowMs = runtime.clock.now();
      if (delivery.nextAttemptAtMs !== undefined && delivery.nextAttemptAtMs > nowMs) {
        return;
      }
      await attemptDelivery(store, delivery, secretsKey, runtime);
      deliveriesAttempted += 1;
    });
  }
  return deliveriesAttempted;
}

/**
 * Advance due async actions and webhook delivery attempts using the injected clock.
 * Safe to call repeatedly; never sleeps.
 */
export type ProcessDueResult = {
  asyncActionsProcessed: number;
  deliveriesAttempted: number;
};

export async function processDueWork(
  repo: YunoMockRepository,
  runtime: MockRuntime,
  secretsKey: Buffer,
): Promise<ProcessDueResult> {
  const asyncActionsProcessed = await processDueAsyncActions(
    repo,
    runtime,
    secretsKey,
  );
  const deliveriesAttempted = await processDueDeliveries(
    repo,
    runtime,
    secretsKey,
  );
  return { asyncActionsProcessed, deliveriesAttempted };
}

export function scheduleAsyncAction(
  store: YunoMockStore,
  input: Omit<AsyncActionRecord, 'id' | 'createdAt' | 'status'> & {
    id?: string;
    status?: AsyncActionRecord['status'];
  },
): AsyncActionRecord {
  const record: AsyncActionRecord = {
    id: input.id ?? newYunoId(),
    kind: input.kind,
    paymentId: input.paymentId,
    dueAtMs: input.dueAtMs,
    status: input.status ?? 'pending',
    data: input.data,
    createdAt: nowIso(),
  };
  store.asyncActions.push(record);
  return record;
}

export type { StoredPaymentData };
