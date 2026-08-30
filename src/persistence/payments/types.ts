import type { EncryptedSecretBlob } from '../../crypto/secrets-at-rest.js';
import type { PublicPaymentStatus } from '../../providers/yuno/state-mapper.js';

export type MoneyMinor = {
  currency: string;
  value_minor: number;
};

export type PaymentCustomerRecord = {
  id: string;
  principalId: string;
  providerCustomerId: string;
  merchantCustomerId: string;
  createdAt: string;
  updatedAt: string;
};

export type EnrollmentStatus = 'pending_user_action' | 'completed' | 'failed' | 'expired';

export type PaymentMethodEnrollmentRecord = {
  id: string;
  principalId: string;
  status: EnrollmentStatus;
  country: string;
  currency: string;
  providerCustomerId: string;
  providerSessionId: string;
  providerPaymentMethodId?: string;
  paymentMethodId?: string;
  nextActionUrl: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type PaymentMethodRecord = {
  id: string;
  principalId: string;
  status: 'active' | 'inactive';
  type: 'card';
  brand: string;
  last4: string;
  expirationMonth: number;
  expirationYear: number;
  isDefault: boolean;
  alias?: string;
  providerPaymentMethodId: string;
  providerCustomerId: string;
  /** AES-256-GCM encrypted vaulted_token — never logged or returned publicly. */
  encryptedVaultedToken: EncryptedSecretBlob;
  createdAt: string;
  updatedAt: string;
};

export type PaymentAttemptRecord = {
  id: string;
  paymentId: string;
  providerIdempotencyKey: string;
  providerPaymentId?: string;
  providerTransactionId?: string;
  status: 'processing' | 'succeeded' | 'failed' | 'unknown';
  createdAt: string;
  updatedAt: string;
};

export type PaymentRecord = {
  id: string;
  principalId: string;
  agentUuid: string;
  merchantId: string;
  merchantOrderId: string;
  description: string;
  authorizationId: string;
  paymentMethodId: string;
  amount: MoneyMinor;
  captureMethod: 'automatic' | 'manual';
  status: PublicPaymentStatus;
  country: string;
  providerPaymentId?: string;
  providerTransactionId?: string;
  /** PURCHASE/CAPTURE provider tx for refunds. */
  providerRefundableTransactionId?: string;
  providerIdempotencyKey: string;
  capturedMinor: number;
  refundedMinor: number;
  nextAction: { type: string; url?: string } | null;
  createdAt: string;
  updatedAt: string;
};

export type RefundRecord = {
  id: string;
  paymentId: string;
  principalId: string;
  amount: MoneyMinor;
  status: 'processing' | 'succeeded' | 'failed';
  reason?: string;
  providerRefundId?: string;
  providerIdempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};

export type ProviderEventRecord = {
  id: string;
  providerEventId: string;
  type: string;
  typeEvent: string;
  providerPaymentId?: string;
  platformPaymentId?: string;
  /** Redacted audit only — no secrets/PAN/CVV/vaulted_token. */
  payloadRedacted: Record<string, unknown>;
  applied: boolean;
  applyReason: string;
  createdAt: string;
};

export type WebhookEndpointRecord = {
  id: string;
  url: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type WebhookDeliveryRecord = {
  id: string;
  endpointId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type IdempotencyRecordStatus = 'in_progress' | 'completed' | 'failed';

export type IdempotencyRecord = {
  key: string;
  actorId: string;
  operation: string;
  bodyHash: string;
  status: IdempotencyRecordStatus;
  httpStatus?: number;
  responseBody?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type PaymentStore = {
  customers: PaymentCustomerRecord[];
  enrollments: PaymentMethodEnrollmentRecord[];
  paymentMethods: PaymentMethodRecord[];
  payments: PaymentRecord[];
  attempts: PaymentAttemptRecord[];
  refunds: RefundRecord[];
  providerEvents: ProviderEventRecord[];
  webhookEndpoints: WebhookEndpointRecord[];
  webhookDeliveries: WebhookDeliveryRecord[];
  idempotency: IdempotencyRecord[];
  /** Provider event ids already applied (dedup). */
  appliedProviderEventIds: string[];
};

export function emptyPaymentStore(): PaymentStore {
  return {
    customers: [],
    enrollments: [],
    paymentMethods: [],
    payments: [],
    attempts: [],
    refunds: [],
    providerEvents: [],
    webhookEndpoints: [],
    webhookDeliveries: [],
    idempotency: [],
    appliedProviderEventIds: [],
  };
}

export function normalizePaymentStore(partial: Partial<PaymentStore>): PaymentStore {
  const base = emptyPaymentStore();
  return {
    customers: partial.customers ?? base.customers,
    enrollments: partial.enrollments ?? base.enrollments,
    paymentMethods: partial.paymentMethods ?? base.paymentMethods,
    payments: partial.payments ?? base.payments,
    attempts: partial.attempts ?? base.attempts,
    refunds: partial.refunds ?? base.refunds,
    providerEvents: partial.providerEvents ?? base.providerEvents,
    webhookEndpoints: partial.webhookEndpoints ?? base.webhookEndpoints,
    webhookDeliveries: partial.webhookDeliveries ?? base.webhookDeliveries,
    idempotency: partial.idempotency ?? base.idempotency,
    appliedProviderEventIds:
      partial.appliedProviderEventIds ?? base.appliedProviderEventIds,
  };
}

export interface PaymentRepository {
  getStore(): Promise<PaymentStore>;
  saveStore(store: PaymentStore): Promise<void>;
  withLock<T>(fn: (store: PaymentStore) => Promise<T> | T): Promise<T>;
}
