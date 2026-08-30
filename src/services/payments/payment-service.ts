/**
 * PaymentService — platform payment domain rules, idempotency, authz.
 * Never reads MANDATE_MAX_AMOUNT. Never exposes provider IDs/vaulted tokens publicly.
 */
import type { AuthorizationVerifier } from '../../domain/authorization/verifier.js';
import { majorToMinor } from '../../domain/payments/currency.js';
import {
  assertPublicSafe,
  canonicalBodyHash,
  deriveProviderIdempotencyKey,
  newPaymentId,
  nowIso,
  PaymentError,
  redactSensitive,
} from '../../domain/payments/helpers.js';
import type {
  IdempotencyRecord,
  PaymentMethodEnrollmentRecord,
  PaymentMethodRecord,
  PaymentRecord,
  PaymentRepository,
  ProviderEventRecord,
  RefundRecord,
  WebhookEndpointRecord,
} from '../../persistence/payments/types.js';
import { decidePaymentEventApplication } from '../../providers/yuno/payment-event-guard.js';
import { mapYunoPaymentStatus } from '../../providers/yuno/state-mapper.js';
import { verifyYunoWebhookSignature } from '../../providers/yuno/webhook-verifier.js';
import type { YunoAdapter } from '../../providers/yuno/yuno-adapter.js';

export type PaymentServiceDeps = {
  repo: PaymentRepository;
  adapter: YunoAdapter;
  authz: AuthorizationVerifier;
  webhookHmacSecret: string;
  accountId: string;
  /** Default country for enrollments when not provided. */
  defaultCountry?: string;
  /** Default currency for enrollment verify. */
  defaultCurrency?: string;
  /** Injected fetch for outbound platform webhook delivery (tests). */
  outboundFetch?: typeof fetch;
};

export type PublicPaymentMethod = {
  id: string;
  type: 'card';
  status: 'active' | 'inactive';
  brand: string;
  last4: string;
  expiration_month: number;
  expiration_year: number;
  is_default: boolean;
  alias?: string;
};

export type PublicPayment = {
  id: string;
  status: string;
  amount: { currency: string; value_minor: number };
  capture_method: 'automatic' | 'manual';
  merchant_order_id: string;
  description: string;
  payment_method_id: string;
  next_action: { type: string; url?: string } | null;
  created_at: string;
  updated_at: string;
};

export type PublicRefund = {
  id: string;
  payment_id: string;
  status: string;
  amount: { currency: string; value_minor: number };
  created_at: string;
};

export type PublicEnrollment = {
  id: string;
  status: string;
  next_action: { type: 'open_url'; url: string } | null;
  payment_method_id?: string;
  created_at: string;
};

function toPublicMethod(m: PaymentMethodRecord): PublicPaymentMethod {
  const out: PublicPaymentMethod = {
    id: m.id,
    type: 'card',
    status: m.status,
    brand: m.brand,
    last4: m.last4,
    expiration_month: m.expirationMonth,
    expiration_year: m.expirationYear,
    is_default: m.isDefault,
  };
  if (m.alias) out.alias = m.alias;
  return out;
}

function toPublicPayment(p: PaymentRecord): PublicPayment {
  return {
    id: p.id,
    status: p.status,
    amount: p.amount,
    capture_method: p.captureMethod,
    merchant_order_id: p.merchantOrderId,
    description: p.description,
    payment_method_id: p.paymentMethodId,
    next_action: p.nextAction,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

function toPublicRefund(r: RefundRecord): PublicRefund {
  return {
    id: r.id,
    payment_id: r.paymentId,
    status: r.status,
    amount: r.amount,
    created_at: r.createdAt,
  };
}

function toPublicEnrollment(e: PaymentMethodEnrollmentRecord): PublicEnrollment {
  const out: PublicEnrollment = {
    id: e.id,
    status: e.status,
    next_action:
      e.status === 'pending_user_action'
        ? { type: 'open_url', url: e.nextActionUrl }
        : null,
    created_at: e.createdAt,
  };
  if (e.paymentMethodId) out.payment_method_id = e.paymentMethodId;
  return out;
}

function idemKey(actorId: string, operation: string, key: string): string {
  return `${actorId}::${operation}::${key}`;
}

export class PaymentService {
  constructor(private readonly deps: PaymentServiceDeps) {}

  private async withIdempotency<T>(input: {
    actorId: string;
    operation: string;
    idempotencyKey: string | undefined;
    body: unknown;
    requireKey: boolean;
    run: () => Promise<{ httpStatus: number; body: T }>;
  }): Promise<{ httpStatus: number; body: T }> {
    if (input.requireKey && !input.idempotencyKey?.trim()) {
      throw new PaymentError('Idempotency-Key is required', 'invalid_request', 400);
    }
    if (!input.idempotencyKey?.trim()) {
      return input.run();
    }
    const key = idemKey(input.actorId, input.operation, input.idempotencyKey.trim());
    const bodyHash = canonicalBodyHash(input.body);
    const ts = nowIso();

    const early = await this.deps.repo.withLock((store) => {
      const existing = store.idempotency.find((r) => r.key === key);
      if (!existing) {
        const rec: IdempotencyRecord = {
          key,
          actorId: input.actorId,
          operation: input.operation,
          bodyHash,
          status: 'in_progress',
          createdAt: ts,
          updatedAt: ts,
        };
        store.idempotency.push(rec);
        return { kind: 'proceed' as const };
      }
      if (existing.bodyHash !== bodyHash) {
        throw new PaymentError(
          'Idempotency-Key reused with a different body',
          'idempotency_key_reused',
          409,
        );
      }
      if (existing.status === 'in_progress') {
        throw new PaymentError(
          'Request already in progress',
          'request_in_progress',
          409,
        );
      }
      // Durable success or error replay
      if (
        (existing.status === 'completed' || existing.status === 'failed') &&
        existing.responseBody !== undefined &&
        existing.httpStatus !== undefined
      ) {
        return {
          kind: 'replay' as const,
          httpStatus: existing.httpStatus,
          body: existing.responseBody as T,
        };
      }
      throw new PaymentError(
        'Idempotency-Key reused with a different body',
        'idempotency_key_reused',
        409,
      );
    });

    if (early.kind === 'replay') {
      if (early.httpStatus >= 400) {
        const errBody = early.body as { error?: string; code?: string };
        throw new PaymentError(
          String(errBody.error ?? 'Request failed'),
          String(errBody.code ?? 'invalid_request'),
          early.httpStatus,
        );
      }
      return { httpStatus: early.httpStatus, body: early.body };
    }

    try {
      const result = await input.run();
      await this.deps.repo.withLock((store) => {
        const rec = store.idempotency.find((r) => r.key === key);
        if (rec) {
          rec.status = 'completed';
          rec.httpStatus = result.httpStatus;
          rec.responseBody = result.body;
          rec.updatedAt = nowIso();
        }
      });
      return result;
    } catch (err) {
      if (err instanceof PaymentError) {
        const errorBody = { error: err.message, code: err.code };
        await this.deps.repo.withLock((store) => {
          const rec = store.idempotency.find((r) => r.key === key);
          if (rec && rec.status === 'in_progress') {
            rec.status = 'failed';
            rec.httpStatus = err.httpStatus;
            rec.responseBody = errorBody;
            rec.updatedAt = nowIso();
          }
        });
      } else {
        // Unexpected errors: leave in_progress cleared only for non-PaymentError
        // so clients may retry; do not store a false success.
        await this.deps.repo.withLock((store) => {
          const idx = store.idempotency.findIndex((r) => r.key === key);
          if (idx >= 0 && store.idempotency[idx]!.status === 'in_progress') {
            store.idempotency.splice(idx, 1);
          }
        });
      }
      throw err;
    }
  }

  // --- Enrollment (human session) ---

  async beginEnrollment(input: {
    principalId: string;
    country?: string;
    currency?: string;
  }): Promise<PublicEnrollment> {
    const country = input.country ?? this.deps.defaultCountry ?? 'CO';
    const currency = input.currency ?? this.deps.defaultCurrency ?? 'COP';
    const merchantCustomerId = `usr_${input.principalId}`;

    let customer = await this.deps.repo.withLock((store) =>
      store.customers.find((c) => c.principalId === input.principalId),
    );

    if (!customer) {
      const provider = await this.deps.adapter.createOrFindCustomer(merchantCustomerId);
      const ts = nowIso();
      customer = await this.deps.repo.withLock((store) => {
        const existing = store.customers.find((c) => c.principalId === input.principalId);
        if (existing) return existing;
        const rec = {
          id: newPaymentId('pcus'),
          principalId: input.principalId,
          providerCustomerId: provider.id,
          merchantCustomerId,
          createdAt: ts,
          updatedAt: ts,
        };
        store.customers.push(rec);
        return rec;
      });
    }

    const session = await this.deps.adapter.createCustomerSession({
      customerId: customer.providerCustomerId,
      country,
    });

    const ts = nowIso();
    const enrollmentId = newPaymentId('pme');
    const nextUrl = `${this.deps.adapter.enrollmentTestUrl}?customer_session=${encodeURIComponent(session.customer_session)}`;
    const record: PaymentMethodEnrollmentRecord = {
      id: enrollmentId,
      principalId: input.principalId,
      status: 'pending_user_action',
      country,
      currency,
      providerCustomerId: customer.providerCustomerId,
      providerSessionId: session.customer_session,
      nextActionUrl: nextUrl,
      createdAt: ts,
      updatedAt: ts,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };

    await this.deps.repo.withLock((store) => {
      store.enrollments.push(record);
    });

    const pub = toPublicEnrollment(record);
    assertPublicSafe(pub);
    return pub;
  }

  async getEnrollment(input: {
    principalId: string;
    enrollmentId: string;
  }): Promise<PublicEnrollment> {
    const enrollment = await this.deps.repo.withLock((store) => {
      const e = store.enrollments.find((x) => x.id === input.enrollmentId);
      if (!e) throw new PaymentError('Enrollment not found', 'not_found', 404);
      if (e.principalId !== input.principalId) {
        throw new PaymentError('Forbidden', 'forbidden', 403);
      }
      return e;
    });

    if (enrollment.status === 'pending_user_action') {
      const currency = enrollment.currency || this.deps.defaultCurrency || 'COP';
      const providerKey = deriveProviderIdempotencyKey(`enroll:${enrollment.id}`);
      try {
        const enrolled = await this.deps.adapter.enrollCheckout({
          customerSession: enrollment.providerSessionId,
          country: enrollment.country,
          currency,
          idempotencyKey: providerKey,
        });
        if (enrolled) {
          const ts = nowIso();
          const pmId = newPaymentId('pm');
          await this.deps.repo.withLock((store) => {
            const e = store.enrollments.find((x) => x.id === enrollment.id);
            if (!e || e.status !== 'pending_user_action') return;
            const encrypted = this.deps.adapter.encryptVaultedToken(enrolled.vaultedToken);
            const method: PaymentMethodRecord = {
              id: pmId,
              principalId: input.principalId,
              status: 'active',
              type: 'card',
              brand: enrolled.brand,
              last4: enrolled.last4,
              expirationMonth: enrolled.expirationMonth,
              expirationYear: enrolled.expirationYear,
              isDefault: store.paymentMethods.filter(
                (m) => m.principalId === input.principalId && m.status === 'active',
              ).length === 0,
              providerPaymentMethodId: enrolled.id,
              providerCustomerId: e.providerCustomerId,
              encryptedVaultedToken: encrypted,
              createdAt: ts,
              updatedAt: ts,
            };
            store.paymentMethods.push(method);
            e.status = 'completed';
            e.providerPaymentMethodId = enrolled.id;
            e.paymentMethodId = pmId;
            e.updatedAt = ts;
          });
        }
      } catch (err) {
        if (err instanceof PaymentError && err.code === 'invalid_request') {
          // still pending
        } else {
          throw err;
        }
      }
    }

    const latest = await this.deps.repo.withLock((store) => {
      const e = store.enrollments.find((x) => x.id === input.enrollmentId);
      if (!e) throw new PaymentError('Enrollment not found', 'not_found', 404);
      return e;
    });
    const pub = toPublicEnrollment(latest);
    assertPublicSafe(pub);
    return pub;
  }

  async listPaymentMethods(principalId: string): Promise<PublicPaymentMethod[]> {
    const methods = await this.deps.repo.withLock((store) =>
      store.paymentMethods.filter(
        (m) => m.principalId === principalId && m.status === 'active',
      ),
    );
    const pub = methods.map(toPublicMethod);
    assertPublicSafe(pub);
    return pub;
  }

  async getPaymentMethod(input: {
    principalId: string;
    paymentMethodId: string;
  }): Promise<PublicPaymentMethod> {
    const method = await this.deps.repo.withLock((store) => {
      const m = store.paymentMethods.find((x) => x.id === input.paymentMethodId);
      if (!m) throw new PaymentError('Payment method not found', 'not_found', 404);
      if (m.principalId !== input.principalId) {
        throw new PaymentError('Forbidden', 'forbidden', 403);
      }
      return m;
    });
    const pub = toPublicMethod(method);
    assertPublicSafe(pub);
    return pub;
  }

  async patchPaymentMethod(input: {
    principalId: string;
    paymentMethodId: string;
    alias?: string;
    isDefault?: boolean;
  }): Promise<PublicPaymentMethod> {
    const method = await this.deps.repo.withLock((store) => {
      const m = store.paymentMethods.find((x) => x.id === input.paymentMethodId);
      if (!m) throw new PaymentError('Payment method not found', 'not_found', 404);
      if (m.principalId !== input.principalId) {
        throw new PaymentError('Forbidden', 'forbidden', 403);
      }
      if (input.alias !== undefined) m.alias = input.alias;
      if (input.isDefault === true) {
        for (const other of store.paymentMethods) {
          if (other.principalId === input.principalId) other.isDefault = false;
        }
        m.isDefault = true;
      }
      m.updatedAt = nowIso();
      return m;
    });
    const pub = toPublicMethod(method);
    assertPublicSafe(pub);
    return pub;
  }

  async deletePaymentMethod(input: {
    principalId: string;
    paymentMethodId: string;
  }): Promise<{ ok: true }> {
    const method = await this.deps.repo.withLock((store) => {
      const m = store.paymentMethods.find((x) => x.id === input.paymentMethodId);
      if (!m) throw new PaymentError('Payment method not found', 'not_found', 404);
      if (m.principalId !== input.principalId) {
        throw new PaymentError('Forbidden', 'forbidden', 403);
      }
      return m;
    });
    await this.deps.adapter.unenroll(method.providerPaymentMethodId);
    await this.deps.repo.withLock((store) => {
      const m = store.paymentMethods.find((x) => x.id === input.paymentMethodId);
      if (m) {
        m.status = 'inactive';
        m.updatedAt = nowIso();
      }
    });
    const out = { ok: true as const };
    assertPublicSafe(out);
    return out;
  }

  // --- Payments (agent) ---

  async createPayment(input: {
    actorId: string;
    agentUuid: string;
    principalId: string;
    idempotencyKey: string;
    body: {
      merchant_id: string;
      authorization_id: string;
      payment_method_id: string;
      merchant_order_id: string;
      description: string;
      amount: { currency: string; value_minor: number };
      capture_method: 'automatic' | 'manual';
      country?: string;
      return_url?: string;
    };
  }): Promise<{ httpStatus: number; body: PublicPayment }> {
    return this.withIdempotency({
      actorId: input.actorId,
      operation: 'payments.create',
      idempotencyKey: input.idempotencyKey,
      body: input.body,
      requireKey: true,
      run: async () => {
        const authz = await this.deps.authz.verify({
          authorizationId: input.body.authorization_id,
          actorId: input.principalId,
          amount: input.body.amount,
          merchantId: input.body.merchant_id,
          paymentMethodId: input.body.payment_method_id,
        });
        if (!authz.ok) {
          throw new PaymentError(
            'Authorization invalid',
            'authorization_invalid',
            403,
          );
        }
        if (authz.principalId !== input.principalId) {
          throw new PaymentError(
            'Authorization principal mismatch',
            'authorization_invalid',
            403,
          );
        }
        if (authz.agentUuid !== undefined && authz.agentUuid !== input.agentUuid) {
          throw new PaymentError(
            'Authorization agent mismatch',
            'authorization_invalid',
            403,
          );
        }

        const method = await this.deps.repo.withLock((store) => {
          const m = store.paymentMethods.find(
            (x) => x.id === input.body.payment_method_id,
          );
          if (!m || m.status !== 'active') {
            throw new PaymentError(
              'Payment method unavailable',
              'payment_method_unavailable',
              400,
            );
          }
          if (m.principalId !== input.principalId) {
            throw new PaymentError('Forbidden', 'forbidden', 403);
          }
          return m;
        });

        // Stable provider key bound to platform idempotency key (not random payment id).
        const providerKey = deriveProviderIdempotencyKey(
          `payments.create:${input.actorId}:${input.idempotencyKey}`,
        );

        // Reuse existing draft if a prior unknown outcome already created one.
        const existing = await this.deps.repo.withLock((store) =>
          store.payments.find((p) => p.providerIdempotencyKey === providerKey),
        );
        if (existing) {
          const pub = toPublicPayment(existing);
          assertPublicSafe(pub);
          if (
            existing.status === 'processing' &&
            !existing.providerPaymentId
          ) {
            // Still unknown — re-attempt provider with same key, or surface unknown.
            const vaultedToken = this.deps.adapter.decryptVaultedToken(
              method.encryptedVaultedToken,
            );
            const retry = await this.deps.adapter.createPayment({
              merchantOrderId: input.body.merchant_order_id,
              description: input.body.description,
              country: existing.country,
              currency: input.body.amount.currency,
              valueMinor: input.body.amount.value_minor,
              vaultedToken,
              capture: input.body.capture_method === 'automatic',
              idempotencyKey: providerKey,
            });
            if (retry.kind === 'unknown') {
              throw new PaymentError(
                'Provider outcome unknown; query payment status — do not recreate',
                'payment_outcome_unknown',
                502,
              );
            }
            await this.applyProviderPaymentView(existing.id, retry.payment);
            const latest = await this.getPaymentInternal(existing.id);
            const out = toPublicPayment(latest);
            assertPublicSafe(out);
            return { httpStatus: 201, body: out };
          }
          // Known terminal/processing with provider id — return stored (shouldn't normally
          // reach here because idempotency replays first).
          return { httpStatus: 201, body: pub };
        }

        const paymentId = newPaymentId('pay');
        const vaultedToken = this.deps.adapter.decryptVaultedToken(
          method.encryptedVaultedToken,
        );
        const country = input.body.country ?? 'CO';
        const ts = nowIso();

        const draft: PaymentRecord = {
          id: paymentId,
          principalId: input.principalId,
          agentUuid: input.agentUuid,
          merchantId: input.body.merchant_id,
          merchantOrderId: input.body.merchant_order_id,
          description: input.body.description,
          authorizationId: input.body.authorization_id,
          paymentMethodId: method.id,
          amount: input.body.amount,
          captureMethod: input.body.capture_method,
          status: 'processing',
          country,
          providerIdempotencyKey: providerKey,
          capturedMinor: 0,
          refundedMinor: 0,
          nextAction: null,
          createdAt: ts,
          updatedAt: ts,
        };

        await this.deps.repo.withLock((store) => {
          store.payments.push(draft);
          store.attempts.push({
            id: newPaymentId('att'),
            paymentId,
            providerIdempotencyKey: providerKey,
            status: 'processing',
            createdAt: ts,
            updatedAt: ts,
          });
        });

        let result: Awaited<ReturnType<YunoAdapter['createPayment']>>;
        try {
          result = await this.deps.adapter.createPayment({
            merchantOrderId: input.body.merchant_order_id,
            description: input.body.description,
            country,
            currency: input.body.amount.currency,
            valueMinor: input.body.amount.value_minor,
            vaultedToken,
            capture: input.body.capture_method === 'automatic',
            idempotencyKey: providerKey,
          });
        } catch (err) {
          // Known rejection after draft — remove phantom processing payment.
          await this.deps.repo.withLock((store) => {
            store.payments = store.payments.filter((p) => p.id !== paymentId);
            store.attempts = store.attempts.filter((a) => a.paymentId !== paymentId);
          });
          throw err;
        }

        if (result.kind === 'unknown') {
          await this.deps.repo.withLock((store) => {
            const p = store.payments.find((x) => x.id === paymentId);
            if (p) {
              p.status = 'processing';
              p.updatedAt = nowIso();
            }
            const att = store.attempts.find((a) => a.paymentId === paymentId);
            if (att) {
              att.status = 'unknown';
              att.updatedAt = nowIso();
            }
          });
          throw new PaymentError(
            'Provider outcome unknown; query payment status — do not recreate',
            'payment_outcome_unknown',
            502,
          );
        }

        await this.applyProviderPaymentView(paymentId, result.payment);
        const latest = await this.getPaymentInternal(paymentId);
        const pub = toPublicPayment(latest);
        assertPublicSafe(pub);
        return { httpStatus: 201, body: pub };
      },
    });
  }

  private async applyProviderPaymentView(
    paymentId: string,
    view: import('../../providers/yuno/yuno-adapter.js').ProviderPaymentView,
  ): Promise<void> {
    await this.deps.repo.withLock((store) => {
      const p = store.payments.find((x) => x.id === paymentId);
      if (!p) return;
      p.providerPaymentId = view.id;
      p.providerTransactionId = view.transactionId;
      p.providerRefundableTransactionId =
        view.refundableTransactionId ?? p.providerRefundableTransactionId;
      p.status = view.status;
      p.capturedMinor = view.capturedMinor;
      p.refundedMinor = view.refundedMinor;
      p.nextAction =
        view.sdkActionRequired || view.status === 'requires_user_action'
          ? { type: 'complete_3ds' }
          : null;
      p.updatedAt = nowIso();
      const att = store.attempts.find((a) => a.paymentId === paymentId);
      if (att) {
        att.providerPaymentId = view.id;
        att.providerTransactionId = view.transactionId;
        att.status =
          view.status === 'declined' || view.status === 'failed'
            ? 'failed'
            : view.status === 'processing' || view.status === 'requires_user_action'
              ? 'processing'
              : 'succeeded';
        att.updatedAt = nowIso();
      }
    });
  }

  private async getPaymentInternal(paymentId: string): Promise<PaymentRecord> {
    return this.deps.repo.withLock((store) => {
      const p = store.payments.find((x) => x.id === paymentId);
      if (!p) throw new PaymentError('Payment not found', 'not_found', 404);
      return p;
    });
  }

  async getPayment(input: {
    principalId: string;
    agentUuid: string;
    paymentId: string;
  }): Promise<PublicPayment> {
    const payment = await this.getPaymentInternal(input.paymentId);
    if (
      payment.principalId !== input.principalId ||
      payment.agentUuid !== input.agentUuid
    ) {
      throw new PaymentError('Forbidden', 'forbidden', 403);
    }
    // Reconcile from provider when processing/unknown
    if (
      payment.providerPaymentId &&
      (payment.status === 'processing' || payment.status === 'requires_user_action')
    ) {
      try {
        const view = await this.deps.adapter.getPayment(payment.providerPaymentId);
        await this.deps.repo.withLock((store) => {
          const p = store.payments.find((x) => x.id === payment.id);
          if (!p) return;
          p.status = view.status;
          p.capturedMinor = view.capturedMinor;
          p.refundedMinor = view.refundedMinor;
          p.providerTransactionId = view.transactionId ?? p.providerTransactionId;
          p.nextAction = view.sdkActionRequired ? { type: 'complete_3ds' } : null;
          p.updatedAt = nowIso();
        });
      } catch {
        // keep stored
      }
    }
    const latest = await this.getPaymentInternal(input.paymentId);
    const pub = toPublicPayment(latest);
    assertPublicSafe(pub);
    return pub;
  }

  async listPayments(input: {
    principalId: string;
    agentUuid: string;
  }): Promise<PublicPayment[]> {
    const payments = await this.deps.repo.withLock((store) =>
      store.payments.filter(
        (p) =>
          p.principalId === input.principalId && p.agentUuid === input.agentUuid,
      ),
    );
    const pub = payments.map(toPublicPayment);
    assertPublicSafe(pub);
    return pub;
  }

  async cancelPayment(input: {
    principalId: string;
    agentUuid: string;
    paymentId: string;
    idempotencyKey: string;
  }): Promise<{ httpStatus: number; body: PublicPayment }> {
    return this.withIdempotency({
      actorId: input.agentUuid,
      operation: 'payments.cancel',
      idempotencyKey: input.idempotencyKey,
      body: { payment_id: input.paymentId },
      requireKey: true,
      run: async () => {
        const payment = await this.getPaymentInternal(input.paymentId);
        if (
          payment.principalId !== input.principalId ||
          payment.agentUuid !== input.agentUuid
        ) {
          throw new PaymentError('Forbidden', 'forbidden', 403);
        }
        if (
          !payment.providerPaymentId ||
          !payment.providerTransactionId ||
          payment.status !== 'authorized'
        ) {
          throw new PaymentError(
            'Cancel not allowed in current state',
            'operation_not_allowed',
            400,
          );
        }
        const providerKey = deriveProviderIdempotencyKey(
          `payments.cancel:${input.idempotencyKey}`,
        );
        const view = await this.deps.adapter.cancel({
          providerPaymentId: payment.providerPaymentId,
          providerTransactionId: payment.providerTransactionId,
          merchantReference: payment.merchantOrderId,
          idempotencyKey: providerKey,
        });
        await this.deps.repo.withLock((store) => {
          const p = store.payments.find((x) => x.id === payment.id);
          if (p) {
            p.status = view.status;
            p.updatedAt = nowIso();
          }
        });
        const latest = await this.getPaymentInternal(payment.id);
        const pub = toPublicPayment(latest);
        assertPublicSafe(pub);
        return { httpStatus: 200, body: pub };
      },
    });
  }

  async capturePayment(input: {
    paymentId: string;
    idempotencyKey: string;
    amount?: { currency: string; value_minor: number };
  }): Promise<{ httpStatus: number; body: PublicPayment }> {
    return this.withIdempotency({
      actorId: 'admin',
      operation: 'payments.capture',
      idempotencyKey: input.idempotencyKey,
      body: { payment_id: input.paymentId, amount: input.amount },
      requireKey: true,
      run: async () => {
        const payment = await this.getPaymentInternal(input.paymentId);
        if (
          !payment.providerPaymentId ||
          !payment.providerTransactionId ||
          payment.status !== 'authorized'
        ) {
          throw new PaymentError(
            'Capture not allowed in current state',
            'operation_not_allowed',
            400,
          );
        }
        const valueMinor = input.amount?.value_minor ?? payment.amount.value_minor;
        const currency = input.amount?.currency ?? payment.amount.currency;
        if (input.amount && input.amount.currency !== payment.amount.currency) {
          throw new PaymentError(
            'Capture currency must match payment currency',
            'invalid_request',
            400,
          );
        }
        const providerKey = deriveProviderIdempotencyKey(
          `payments.capture:${input.idempotencyKey}`,
        );
        const view = await this.deps.adapter.capture({
          providerPaymentId: payment.providerPaymentId,
          providerTransactionId: payment.providerTransactionId,
          currency,
          valueMinor,
          merchantReference: payment.merchantOrderId,
          idempotencyKey: providerKey,
        });
        await this.deps.repo.withLock((store) => {
          const p = store.payments.find((x) => x.id === payment.id);
          if (p) {
            p.status = view.status;
            p.capturedMinor = view.capturedMinor;
            p.providerRefundableTransactionId =
              view.refundableTransactionId ?? p.providerRefundableTransactionId;
            p.updatedAt = nowIso();
          }
        });
        const latest = await this.getPaymentInternal(payment.id);
        const pub = toPublicPayment(latest);
        assertPublicSafe(pub);
        return { httpStatus: 200, body: pub };
      },
    });
  }

  async createRefund(input: {
    paymentId: string;
    idempotencyKey: string;
    amount?: { currency: string; value_minor: number };
    reason?: string;
  }): Promise<{ httpStatus: number; body: PublicRefund }> {
    return this.withIdempotency({
      actorId: 'admin',
      operation: 'refunds.create',
      idempotencyKey: input.idempotencyKey,
      body: {
        payment_id: input.paymentId,
        amount: input.amount,
        reason: input.reason,
      },
      requireKey: true,
      run: async () => {
        const payment = await this.getPaymentInternal(input.paymentId);
        if (
          !payment.providerPaymentId ||
          (payment.status !== 'succeeded' &&
            payment.status !== 'partially_refunded')
        ) {
          throw new PaymentError(
            'Refund not allowed in current state',
            'operation_not_allowed',
            400,
          );
        }
        if (input.amount && input.amount.currency !== payment.amount.currency) {
          throw new PaymentError(
            'Refund currency must match payment currency',
            'invalid_request',
            400,
          );
        }

        let refundTxId = payment.providerRefundableTransactionId;
        if (!refundTxId) {
          const fresh = await this.deps.adapter.getPayment(payment.providerPaymentId);
          refundTxId = fresh.refundableTransactionId;
        }
        if (!refundTxId) {
          throw new PaymentError(
            'Refund not allowed: no refundable provider transaction',
            'operation_not_allowed',
            400,
          );
        }

        const valueMinor = input.amount?.value_minor;
        const currency = input.amount?.currency ?? payment.amount.currency;
        const refundId = newPaymentId('ref');
        const providerKey = deriveProviderIdempotencyKey(
          `refunds.create:${input.idempotencyKey}`,
        );
        const priorRefunded = payment.refundedMinor;
        const view = await this.deps.adapter.refund({
          providerPaymentId: payment.providerPaymentId,
          providerTransactionId: refundTxId,
          currency,
          valueMinor,
          merchantReference: `${payment.merchantOrderId}-refund`,
          idempotencyKey: providerKey,
        });

        // Inspect exact REFUND action status — refund_failed keeps parent SUCCEEDED
        // but must not report refund as succeeded or change refunded total.
        const refundFailed = view.refundActionStatus === 'failed';
        const ts = nowIso();
        const refund: RefundRecord = {
          id: refundId,
          paymentId: payment.id,
          principalId: payment.principalId,
          amount: {
            currency,
            value_minor:
              valueMinor ??
              Math.max(0, payment.capturedMinor - payment.refundedMinor),
          },
          status: refundFailed ? 'failed' : 'succeeded',
          reason: input.reason,
          providerIdempotencyKey: providerKey,
          createdAt: ts,
          updatedAt: ts,
        };
        await this.deps.repo.withLock((store) => {
          store.refunds.push(refund);
          const p = store.payments.find((x) => x.id === payment.id);
          if (p) {
            if (refundFailed) {
              // Parent may remain succeeded; refunded total unchanged.
              p.refundedMinor = priorRefunded;
            } else {
              p.status = view.status;
              p.refundedMinor = view.refundedMinor;
              p.capturedMinor = view.capturedMinor;
            }
            p.providerRefundableTransactionId = refundTxId;
            p.updatedAt = ts;
          }
        });
        const pub = toPublicRefund(refund);
        assertPublicSafe(pub);
        return { httpStatus: 201, body: pub };
      },
    });
  }

  async getRefund(refundId: string): Promise<PublicRefund> {
    const refund = await this.deps.repo.withLock((store) => {
      const r = store.refunds.find((x) => x.id === refundId);
      if (!r) throw new PaymentError('Refund not found', 'not_found', 404);
      return r;
    });
    const pub = toPublicRefund(refund);
    assertPublicSafe(pub);
    return pub;
  }

  async listRefunds(paymentId: string): Promise<PublicRefund[]> {
    const refunds = await this.deps.repo.withLock((store) =>
      store.refunds.filter((r) => r.paymentId === paymentId),
    );
    const pub = refunds.map(toPublicRefund);
    assertPublicSafe(pub);
    return pub;
  }

  async getCapabilities(input: {
    merchantId?: string;
    country?: string;
    currency?: string;
  }): Promise<Record<string, unknown>> {
    return {
      merchant_id: input.merchantId ?? null,
      country: input.country ?? 'CO',
      currency: input.currency ?? 'COP',
      capture_methods: ['automatic', 'manual'],
      refunds: true,
      partial_refunds: true,
      payment_method_types: ['card'],
    };
  }

  // --- Platform webhook endpoints ---

  async createWebhookEndpoint(url: string): Promise<WebhookEndpointRecord> {
    const ts = nowIso();
    const rec: WebhookEndpointRecord = {
      id: newPaymentId('whe'),
      url,
      active: true,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.deps.repo.withLock((store) => {
      store.webhookEndpoints.push(rec);
    });
    return rec;
  }

  async listWebhookEndpoints(): Promise<
    Array<{ id: string; url: string; active: boolean; created_at: string }>
  > {
    return this.deps.repo.withLock((store) =>
      store.webhookEndpoints.map((e) => ({
        id: e.id,
        url: e.url,
        active: e.active,
        created_at: e.createdAt,
      })),
    );
  }

  async deleteWebhookEndpoint(id: string): Promise<{ ok: true }> {
    await this.deps.repo.withLock((store) => {
      const e = store.webhookEndpoints.find((x) => x.id === id);
      if (!e) throw new PaymentError('Webhook endpoint not found', 'not_found', 404);
      e.active = false;
      e.updatedAt = nowIso();
    });
    return { ok: true };
  }

  /**
   * Deliver pending outbound webhook rows via HTTP POST (normalized payload only).
   * Bounded: processes current pending set once; updates attempt/status.
   */
  async deliverPendingOutboundWebhooks(): Promise<{
    delivered: number;
    failed: number;
  }> {
    const fetchImpl = this.deps.outboundFetch ?? fetch;
    const pending = await this.deps.repo.withLock((store) =>
      store.webhookDeliveries
        .filter((d) => d.status === 'pending')
        .map((d) => ({
          ...d,
          endpointUrl: store.webhookEndpoints.find((e) => e.id === d.endpointId)?.url,
        })),
    );
    let delivered = 0;
    let failed = 0;
    for (const row of pending) {
      if (!row.endpointUrl) {
        await this.deps.repo.withLock((store) => {
          const d = store.webhookDeliveries.find((x) => x.id === row.id);
          if (d) {
            d.status = 'failed';
            d.attempts += 1;
            d.updatedAt = nowIso();
          }
        });
        failed += 1;
        continue;
      }
      try {
        assertPublicSafe(row.payload);
        const res = await fetchImpl(row.endpointUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: row.eventType,
            data: row.payload,
          }),
        });
        await this.deps.repo.withLock((store) => {
          const d = store.webhookDeliveries.find((x) => x.id === row.id);
          if (!d) return;
          d.attempts += 1;
          d.updatedAt = nowIso();
          if (res.ok) {
            d.status = 'delivered';
          } else {
            d.status = 'failed';
          }
        });
        if (res.ok) delivered += 1;
        else failed += 1;
      } catch {
        await this.deps.repo.withLock((store) => {
          const d = store.webhookDeliveries.find((x) => x.id === row.id);
          if (d) {
            d.status = 'failed';
            d.attempts += 1;
            d.updatedAt = nowIso();
          }
        });
        failed += 1;
      }
    }
    return { delivered, failed };
  }

  // --- Inbound Yuno webhooks ---

  verifyInboundWebhook(rawBody: string | Buffer, signatureHeader: string | null): void {
    const ok = verifyYunoWebhookSignature({
      rawBody,
      signatureHeader,
      secret: this.deps.webhookHmacSecret,
    });
    if (!ok) {
      throw new PaymentError('Invalid webhook signature', 'unauthorized', 401);
    }
  }

  async processYunoWebhookAsync(rawBody: string): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return;
    }

    const eventId = String(parsed.id ?? parsed.event_id ?? '');
    if (!eventId) return;

    const data = parsed.data as Record<string, unknown> | undefined;
    const paymentObj = (data?.payment ?? data) as Record<string, unknown> | undefined;
    const providerPaymentId = paymentObj
      ? String(paymentObj.id ?? '')
      : undefined;
    const status = String(paymentObj?.status ?? '');
    const subStatus = String(paymentObj?.sub_status ?? '');
    const amount = paymentObj?.amount as
      | { currency?: string; value?: number; captured?: number; refunded?: number }
      | undefined;
    const txs = paymentObj?.transactions;

    await this.deps.repo.withLock((store) => {
      if (store.appliedProviderEventIds.includes(eventId)) {
        store.providerEvents.push({
          id: newPaymentId('pev'),
          providerEventId: eventId,
          type: String(parsed.type ?? 'payment'),
          typeEvent: String(parsed.type_event ?? parsed.typeEvent ?? ''),
          providerPaymentId,
          payloadRedacted: redactSensitive(parsed) as Record<string, unknown>,
          applied: false,
          applyReason: 'duplicate_event',
          createdAt: nowIso(),
        });
        return;
      }

      const platformPayment = providerPaymentId
        ? store.payments.find((p) => p.providerPaymentId === providerPaymentId)
        : undefined;

      if (!platformPayment) {
        // Unmatched — record audit but DO NOT add to applied dedup set so a later
        // redelivery after provider mapping can apply.
        store.providerEvents.push({
          id: newPaymentId('pev'),
          providerEventId: eventId,
          type: String(parsed.type ?? 'payment'),
          typeEvent: String(parsed.type_event ?? parsed.typeEvent ?? ''),
          providerPaymentId,
          payloadRedacted: redactSensitive(parsed) as Record<string, unknown>,
          applied: false,
          applyReason: 'unmatched_provider_payment',
          createdAt: nowIso(),
        });
        return;
      }

      const decision = decidePaymentEventApplication({
        current: {
          status:
            platformPayment.status === 'authorized'
              ? 'AUTHORIZED'
              : platformPayment.status === 'succeeded'
                ? 'SUCCEEDED'
                : platformPayment.status === 'declined'
                  ? 'DECLINED'
                  : platformPayment.status === 'canceled'
                    ? 'CANCELED'
                    : platformPayment.status === 'refunded'
                      ? 'REFUNDED'
                      : platformPayment.status === 'partially_refunded'
                        ? 'SUCCEEDED'
                        : platformPayment.status === 'failed'
                          ? 'ERROR'
                          : platformPayment.status === 'processing'
                            ? 'PENDING'
                            : platformPayment.status === 'requires_user_action'
                              ? 'PENDING'
                              : 'CREATED',
          sub_status:
            platformPayment.status === 'partially_refunded'
              ? 'PARTIALLY_REFUNDED'
              : platformPayment.status === 'authorized'
                ? 'AUTHORIZED'
                : platformPayment.status === 'requires_user_action'
                  ? 'WAITING_ADDITIONAL_STEP'
                  : platformPayment.status === 'processing'
                    ? 'IN_PROCESS'
                    : platformPayment.status === 'succeeded'
                      ? 'APPROVED'
                      : undefined,
        },
        incoming: { status, sub_status: subStatus },
        eventId,
        seenEventIds: store.appliedProviderEventIds,
      });

      const eventRec: ProviderEventRecord = {
        id: newPaymentId('pev'),
        providerEventId: eventId,
        type: String(parsed.type ?? 'payment'),
        typeEvent: String(parsed.type_event ?? parsed.typeEvent ?? ''),
        providerPaymentId,
        platformPaymentId: platformPayment.id,
        payloadRedacted: redactSensitive(parsed) as Record<string, unknown>,
        applied: false,
        applyReason: decision.reason,
        createdAt: nowIso(),
      };

      if (decision.apply) {
        const mapped = mapYunoPaymentStatus({ status, sub_status: subStatus });
        platformPayment.status = mapped;
        if (amount?.currency) {
          try {
            if (typeof amount.captured === 'number') {
              platformPayment.capturedMinor = majorToMinor(
                amount.captured,
                amount.currency,
              );
            }
            if (typeof amount.refunded === 'number') {
              platformPayment.refundedMinor = majorToMinor(
                amount.refunded,
                amount.currency,
              );
            }
            // Successful purchase/capture must not leave captured=0
            if (
              (mapped === 'succeeded' || mapped === 'partially_refunded') &&
              platformPayment.capturedMinor === 0 &&
              typeof amount.value === 'number'
            ) {
              platformPayment.capturedMinor = majorToMinor(
                amount.value,
                amount.currency,
              );
            }
          } catch {
            // keep prior amounts on conversion failure
          }
        }
        const sdkRequired =
          (paymentObj?.checkout as { sdk_action_required?: boolean } | undefined)
            ?.sdk_action_required === true;
        platformPayment.nextAction = sdkRequired
          ? { type: 'complete_3ds' }
          : mapped === 'requires_user_action'
            ? { type: 'complete_3ds' }
            : null;

        // Update refundable tx ids from webhook payload when present
        const txList = Array.isArray(txs)
          ? txs
          : txs && typeof txs === 'object'
            ? [txs]
            : [];
        for (const tx of txList as Array<Record<string, unknown>>) {
          const type = String(tx.type ?? '').toUpperCase();
          const id = String(tx.id ?? '');
          if ((type === 'PURCHASE' || type === 'CAPTURE') && id) {
            platformPayment.providerRefundableTransactionId = id;
          }
        }

        platformPayment.updatedAt = nowIso();
        store.appliedProviderEventIds.push(eventId);
        eventRec.applied = true;
        eventRec.applyReason = 'accepted';

        for (const endpoint of store.webhookEndpoints.filter((e) => e.active)) {
          store.webhookDeliveries.push({
            id: newPaymentId('wd'),
            endpointId: endpoint.id,
            eventType: 'payment.updated',
            payload: toPublicPayment(platformPayment),
            status: 'pending',
            attempts: 0,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        }
      } else if (
        decision.reason === 'duplicate_event' ||
        decision.reason === 'same_state' ||
        decision.reason === 'stale_or_out_of_order'
      ) {
        // Known payment, non-apply — mark seen so exact duplicates don't re-enter.
        store.appliedProviderEventIds.push(eventId);
      }

      store.providerEvents.push(eventRec);
    });

    // Fire-and-forget outbound delivery (bounded)
    void this.deliverPendingOutboundWebhooks().catch(() => undefined);
  }

  async providerHealth(): Promise<{ ok: boolean; status: number }> {
    return this.deps.adapter.health();
  }
}
