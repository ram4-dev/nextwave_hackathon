/**
 * YunoAdapter — maps platform domain ↔ Yuno HTTP via YunoHttpClient.
 * Decrypts vaulted tokens only here when building provider requests.
 */
import { decryptSecret, encryptSecret } from '../../crypto/secrets-at-rest.js';
import { minorToMajor, majorToMinor } from '../../domain/payments/currency.js';
import { PaymentError } from '../../domain/payments/helpers.js';
import {
  mapYunoHttpErrorToPublic,
  mapYunoPaymentStatus,
  type PublicPaymentStatus,
} from './state-mapper.js';
import { YunoHttpClient, YunoHttpError, type YunoHttpResult } from './yuno-http-client.js';
import type { EncryptedSecretBlob } from '../../crypto/secrets-at-rest.js';

export type YunoAdapterConfig = {
  accountId: string;
  baseUrl: string;
  secretsKey: Buffer;
};

export type ProviderCustomer = {
  id: string;
  merchant_customer_id: string;
};

export type ProviderSession = {
  customer_session: string;
  customer_id: string;
  country: string;
};

export type ProviderEnrolledMethod = {
  id: string;
  vaultedToken: string;
  brand: string;
  last4: string;
  expirationMonth: number;
  expirationYear: number;
};

export type ProviderPaymentView = {
  id: string;
  status: PublicPaymentStatus;
  providerStatus: string;
  providerSubStatus: string;
  transactionId?: string;
  /** PURCHASE or CAPTURE tx id only — never AUTHORIZE. */
  refundableTransactionId?: string;
  amountMinor: number;
  currency: string;
  capturedMinor: number;
  refundedMinor: number;
  sdkActionRequired: boolean;
  /** Present when mapping a refund action response. */
  refundActionStatus?: 'succeeded' | 'failed' | 'processing';
  rawRedacted: Record<string, unknown>;
};

export class YunoAdapter {
  constructor(
    private readonly client: YunoHttpClient,
    private readonly config: YunoAdapterConfig,
  ) {}

  get enrollmentTestUrl(): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}/test/enrollment`;
  }

  private handleError(err: unknown): never {
    if (err instanceof YunoHttpError) {
      if (err.code === 'TIMEOUT' || err.code === 'NETWORK') {
        throw new PaymentError(
          err.message,
          'payment_outcome_unknown',
          502,
        );
      }
      const mapped = mapYunoHttpErrorToPublic({
        status: err.status,
        code: err.code,
      });
      throw new PaymentError(mapped.message, mapped.code, err.status >= 400 && err.status < 600 ? err.status : 502);
    }
    throw err;
  }

  /**
   * Non-create provider calls: any non-2xx (including 500) throws normalized PaymentError.
   * Never map an error body into a fake success/processing view.
   */
  private async call(opts: Parameters<YunoHttpClient['request']>[0]): Promise<YunoHttpResult> {
    try {
      const result = await this.client.request(opts);
      if (result.status === 0 || result.status >= 500) {
        throw new YunoHttpError(
          'Provider outcome unknown',
          result.status || 0,
          result.status === 0 ? 'NETWORK' : 'TIMEOUT',
          true,
        );
      }
      this.client.assertOk(result);
      return result;
    } catch (err) {
      this.handleError(err);
    }
  }

  async createOrFindCustomer(merchantCustomerId: string): Promise<ProviderCustomer> {
    const create = await this.client.request({
      method: 'POST',
      path: '/v1/customers',
      body: { merchant_customer_id: merchantCustomerId },
    });
    if (create.status === 201) {
      const body = create.body as { id: string; merchant_customer_id: string };
      return { id: body.id, merchant_customer_id: body.merchant_customer_id };
    }
    // Duplicate merchant_customer_id — recover via list is not in MVP; rethrow mapped.
    // Mock returns 400 invalid request for duplicate. Tests create once per principal.
    try {
      this.client.assertOk(create);
    } catch (err) {
      this.handleError(err);
    }
    throw new PaymentError('Failed to create provider customer', 'invalid_request', 400);
  }

  async createCustomerSession(input: {
    customerId: string;
    country: string;
  }): Promise<ProviderSession> {
    const result = await this.call({
      method: 'POST',
      path: '/v1/customers/sessions',
      body: {
        account_id: this.config.accountId,
        country: input.country,
        customer_id: input.customerId,
      },
    });
    const body = result.body as ProviderSession;
    return body;
  }

  async enrollCheckout(input: {
    customerSession: string;
    country: string;
    currency: string;
    idempotencyKey: string;
  }): Promise<ProviderEnrolledMethod | null> {
    const result = await this.client.request({
      method: 'POST',
      path: `/v1/customers/sessions/${encodeURIComponent(input.customerSession)}/payment-methods`,
      idempotencyKey: input.idempotencyKey,
      body: {
        account_id: this.config.accountId,
        payment_method_type: 'CARD',
        country: input.country,
        verify: { vault_on_success: true, currency: input.currency },
      },
    });

    if (result.status >= 400) {
      const msg = JSON.stringify(result.body).toLowerCase();
      if (msg.includes('no pending vault') || msg.includes('pending vaulted')) {
        return null;
      }
      try {
        this.client.assertOk(result);
      } catch (err) {
        this.handleError(err);
      }
    }

    const enrollBody = result.body as {
      id: string;
      customer_payer?: { id?: string };
    };
    const customerId = enrollBody.customer_payer?.id;
    if (!customerId) {
      throw new PaymentError('Enrollment missing customer reference', 'invalid_request', 502);
    }

    const getRes = await this.call({
      method: 'GET',
      path: `/v1/payment-methods/${encodeURIComponent(enrollBody.id)}`,
    });
    const getBody = getRes.body as {
      card_data?: {
        brand?: string;
        lfd?: string;
        expiration_month?: number;
        expiration_year?: number;
      };
    };

    const listRes = await this.call({
      method: 'GET',
      path: `/v1/customers/${encodeURIComponent(customerId)}/payment-methods`,
    });
    const methods =
      (listRes.body as { payment_methods?: Array<Record<string, unknown>> })
        .payment_methods ?? [];
    const last4 = String(getBody.card_data?.lfd ?? '');
    const match = methods.find((m) => {
      const cd = m.card_data as { lfd?: string } | undefined;
      return cd?.lfd === last4 && typeof m.vaulted_token === 'string';
    });
    if (!match || typeof match.vaulted_token !== 'string') {
      throw new PaymentError('Enrolled method missing vaulted reference', 'invalid_request', 502);
    }

    return {
      id: enrollBody.id,
      vaultedToken: match.vaulted_token,
      brand: String(getBody.card_data?.brand ?? 'card').toLowerCase(),
      last4,
      expirationMonth: Number(getBody.card_data?.expiration_month ?? 0),
      expirationYear: Number(getBody.card_data?.expiration_year ?? 0),
    };
  }

  encryptVaultedToken(token: string): EncryptedSecretBlob {
    return encryptSecret(token, this.config.secretsKey);
  }

  decryptVaultedToken(blob: EncryptedSecretBlob): string {
    return decryptSecret(blob, this.config.secretsKey);
  }

  async unenroll(providerPaymentMethodId: string): Promise<void> {
    await this.call({
      method: 'POST',
      path: `/v1/customers/payment-methods/${encodeURIComponent(providerPaymentMethodId)}/unenroll`,
    });
  }

  async createPayment(input: {
    merchantOrderId: string;
    description: string;
    country: string;
    currency: string;
    valueMinor: number;
    vaultedToken: string;
    capture: boolean;
    idempotencyKey: string;
  }): Promise<
    | { kind: 'ok'; payment: ProviderPaymentView }
    | { kind: 'unknown'; payment?: ProviderPaymentView }
  > {
    const value = minorToMajor(input.valueMinor, input.currency);
    const result = await this.client.request({
      method: 'POST',
      path: '/v1/payments',
      idempotencyKey: input.idempotencyKey,
      body: {
        account_id: this.config.accountId,
        merchant_order_id: input.merchantOrderId,
        description: input.description,
        country: input.country,
        amount: { currency: input.currency, value },
        workflow: 'DIRECT',
        checkout: {},
        payment_method: {
          type: 'CARD',
          vaulted_token: input.vaultedToken,
          ...(input.capture
            ? {}
            : { detail: { card: { capture: false } } }),
        },
      },
    });

    if (result.status === 0 || result.status >= 500) {
      return { kind: 'unknown' };
    }
    if (result.status < 200 || result.status >= 300) {
      try {
        this.client.assertOk(result);
      } catch (err) {
        this.handleError(err);
      }
    }
    return { kind: 'ok', payment: this.mapPaymentResponse(result.body) };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPaymentView> {
    const result = await this.call({
      method: 'GET',
      path: `/v1/payments/${encodeURIComponent(providerPaymentId)}`,
    });
    const body = result.body as { payment?: unknown };
    return this.mapPaymentResponse(body.payment ?? result.body);
  }

  async capture(input: {
    providerPaymentId: string;
    providerTransactionId: string;
    currency: string;
    valueMinor: number;
    merchantReference: string;
    idempotencyKey: string;
  }): Promise<ProviderPaymentView> {
    const value = minorToMajor(input.valueMinor, input.currency);
    const result = await this.call({
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(input.providerPaymentId)}/transactions/${encodeURIComponent(input.providerTransactionId)}/capture`,
      idempotencyKey: input.idempotencyKey,
      body: {
        merchant_reference: input.merchantReference,
        reason: 'REQUESTED_BY_CUSTOMER',
        amount: { currency: input.currency, value },
      },
    });
    return this.mapPaymentResponse(result.body);
  }

  async cancel(input: {
    providerPaymentId: string;
    providerTransactionId: string;
    merchantReference: string;
    idempotencyKey: string;
  }): Promise<ProviderPaymentView> {
    const result = await this.call({
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(input.providerPaymentId)}/transactions/${encodeURIComponent(input.providerTransactionId)}/cancel`,
      idempotencyKey: input.idempotencyKey,
      body: { merchant_reference: input.merchantReference },
    });
    return this.mapPaymentResponse(result.body);
  }

  async refund(input: {
    providerPaymentId: string;
    providerTransactionId: string;
    currency: string;
    valueMinor?: number;
    merchantReference: string;
    idempotencyKey: string;
  }): Promise<ProviderPaymentView> {
    const body: Record<string, unknown> = {
      merchant_reference: input.merchantReference,
      reason: 'REQUESTED_BY_CUSTOMER',
    };
    if (input.valueMinor !== undefined) {
      body.amount = {
        currency: input.currency,
        value: minorToMajor(input.valueMinor, input.currency),
      };
    }
    const result = await this.call({
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(input.providerPaymentId)}/transactions/${encodeURIComponent(input.providerTransactionId)}/refund`,
      idempotencyKey: input.idempotencyKey,
      body,
    });
    return this.mapPaymentResponse(result.body, { expectRefundAction: true });
  }

  async health(): Promise<{ ok: boolean; status: number }> {
    try {
      const result = await this.client.request({ method: 'GET', path: '/health' });
      return { ok: result.status === 200, status: result.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  mapPaymentResponse(
    raw: unknown,
    opts?: { expectRefundAction?: boolean },
  ): ProviderPaymentView {
    const body = (raw ?? {}) as Record<string, unknown>;
    const payment = (body.payment as Record<string, unknown> | undefined) ?? body;
    const status = String(payment.status ?? '');
    const sub = String(payment.sub_status ?? payment.subStatus ?? '');
    const amount = payment.amount as
      | { currency?: string; value?: number; captured?: number; refunded?: number }
      | undefined;
    const currency = String(amount?.currency ?? 'USD');
    const valueMajor = Number(amount?.value ?? 0);
    const capturedMajor = Number(amount?.captured ?? 0);
    const refundedMajor = Number(amount?.refunded ?? 0);

    const txsRaw =
      (payment.transactions as unknown) ??
      body.transactions ??
      payment.transaction;
    let transactionId: string | undefined;
    let refundableTransactionId: string | undefined;
    let refundActionStatus: ProviderPaymentView['refundActionStatus'];

    const list: Array<Record<string, unknown>> = Array.isArray(txsRaw)
      ? (txsRaw as Array<Record<string, unknown>>)
      : txsRaw && typeof txsRaw === 'object'
        ? [txsRaw as Record<string, unknown>]
        : [];

    for (const tx of list) {
      const id = String(tx.id ?? '');
      const type = String(tx.type ?? '').toUpperCase();
      const txStatus = String(tx.status ?? '').toUpperCase();
      if (!transactionId && id) transactionId = id;
      if ((type === 'PURCHASE' || type === 'CAPTURE') && id) {
        refundableTransactionId = id;
      }
      if (type === 'REFUND' && id) {
        if (txStatus === 'DECLINED' || txStatus === 'ERROR' || txStatus === 'FAILED') {
          refundActionStatus = 'failed';
        } else if (txStatus === 'SUCCEEDED' || txStatus === 'APPROVED') {
          refundActionStatus = 'succeeded';
        } else {
          refundActionStatus = 'processing';
        }
      }
    }

    // Action responses: top-level type + nested payment.
    if (body.type) {
      const actionType = String(body.type).toUpperCase();
      const actionTx =
        (body.transactions as Record<string, unknown> | undefined) ?? undefined;
      const actionId = String(actionTx?.id ?? body.id ?? '');
      const actionStatus = String(actionTx?.status ?? '').toUpperCase();
      if ((actionType === 'CAPTURE' || actionType === 'PURCHASE') && actionId) {
        refundableTransactionId = actionId;
      }
      if (actionType === 'REFUND' || opts?.expectRefundAction) {
        if (
          actionStatus === 'DECLINED' ||
          actionStatus === 'ERROR' ||
          actionStatus === 'FAILED'
        ) {
          refundActionStatus = 'failed';
        } else if (actionStatus === 'SUCCEEDED' || actionStatus === 'APPROVED') {
          refundActionStatus = 'succeeded';
        } else if (!refundActionStatus) {
          refundActionStatus = 'processing';
        }
      }
    }

    // Never fall back to AUTHORIZE (or any non-PURCHASE/CAPTURE) as refundable.
    const checkout = payment.checkout as { sdk_action_required?: boolean } | undefined;

    return {
      id: String(payment.id ?? body.id ?? ''),
      status: mapYunoPaymentStatus({ status, sub_status: sub }),
      providerStatus: status,
      providerSubStatus: sub,
      transactionId: transactionId || undefined,
      refundableTransactionId: refundableTransactionId || undefined,
      amountMinor: majorToMinor(valueMajor, currency),
      currency,
      capturedMinor: majorToMinor(capturedMajor, currency),
      refundedMinor: majorToMinor(refundedMajor, currency),
      sdkActionRequired: Boolean(checkout?.sdk_action_required),
      refundActionStatus,
      rawRedacted: {
        id: payment.id ?? body.id,
        status,
        sub_status: sub,
        amount: { currency, value: valueMajor },
      },
    };
  }
}
