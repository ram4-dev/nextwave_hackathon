/**
 * Yuno mock store — separate from KYA store.json.
 * Collections are explicit even when later phases fill them.
 */

import type { EncryptedSecretBlob } from '../crypto/secrets-at-rest.js';
import {
  encryptSecret,
  isEncryptedSecretBlob,
} from '../crypto/secrets-at-rest.js';

export type IdempotencyState =
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CONSUMED_WITHOUT_RESULT';

export type IdempotencyRecord = {
  key: string;
  /** Optional account scope; empty string when unbound. */
  scope: string;
  state: IdempotencyState;
  /** Stable HTTP status from the completed attempt. */
  responseStatus?: number;
  /** Stable JSON-serializable response body. */
  responseBody?: unknown;
  createdAt: string;
  updatedAt: string;
};

export type CustomerRecord = {
  id: string;
  merchantCustomerId?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SessionRecord = {
  id: string;
  customerId?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type PaymentMethodRecord = {
  id: string;
  customerId?: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type PaymentRecord = {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Webhook configuration. Signing secrets live only under `secrets`
 * as AES-256-GCM blobs (never cleartext in file store; never echoed in
 * API responses or redacted audit exports). Legacy string values are
 * migrated on load via {@link migrateWebhookSecretsInPlace}.
 */
export type WebhookSecretValue = EncryptedSecretBlob | string;

export type WebhookSecrets = {
  hmac_client_secret?: WebhookSecretValue;
  api_key?: WebhookSecretValue;
  secret?: WebhookSecretValue;
  oauth2_client_secret?: WebhookSecretValue;
};

export const WEBHOOK_SECRET_KEYS = [
  'hmac_client_secret',
  'api_key',
  'secret',
  'oauth2_client_secret',
] as const;

export type WebhookSecretKey = (typeof WEBHOOK_SECRET_KEYS)[number];

export type WebhookRecord = {
  id: string;
  data: Record<string, unknown>;
  /** Isolated at-rest secrets — encrypted blobs only after migration. */
  secrets?: WebhookSecrets;
  createdAt: string;
  updatedAt: string;
};

export type ProviderEventRecord = {
  id: string;
  type: string;
  typeEvent: string;
  paymentId?: string;
  /** Redacted JSON-serializable payload (no secrets/PAN/CVV). */
  payloadRedacted: Record<string, unknown>;
  /** Exact raw JSON bytes that were (or will be) signed/delivered. */
  rawBody?: string;
  createdAt: string;
};

export type DeliveryAttemptRecord = {
  attempt: number;
  at: string;
  statusCode?: number;
  error?: string;
  outcome: 'acknowledged' | 'failed' | 'scheduled' | 'exhausted';
};

export type DeliveryRecord = {
  id: string;
  eventId: string;
  webhookId: string;
  attempt: number;
  status: 'pending' | 'delivered' | 'failed' | 'exhausted';
  /** Redacted payload snapshot for audit. */
  payloadRedacted: Record<string, unknown>;
  /** Exact raw body used for HMAC (audit may omit in exports that strip secrets). */
  rawBody?: string;
  firstAttemptAtMs: number;
  nextAttemptAtMs?: number;
  attempts: DeliveryAttemptRecord[];
  /** When true, delivery signs with a corrupted HMAC (invalid_hmac scenario). */
  corruptHmac?: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Deterministic async work (processing scenarios, deferred webhook quirks). */
export type AsyncActionRecord = {
  id: string;
  kind:
    | 'processing_terminal'
    | 'duplicate_redelivery'
    | 'out_of_order_stale'
    | 'invalid_hmac_delivery';
  paymentId: string;
  dueAtMs: number;
  status: 'pending' | 'done' | 'canceled';
  data: Record<string, unknown>;
  createdAt: string;
};

export type ScenarioRecord = {
  id: string;
  name: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type YunoMockStore = {
  customers: CustomerRecord[];
  sessions: SessionRecord[];
  paymentMethods: PaymentMethodRecord[];
  payments: PaymentRecord[];
  webhooks: WebhookRecord[];
  idempotency: IdempotencyRecord[];
  events: ProviderEventRecord[];
  deliveries: DeliveryRecord[];
  asyncActions: AsyncActionRecord[];
  scenarios: ScenarioRecord[];
  /** Event ids already applied to payment mutations (dedup). */
  appliedEventIds: string[];
};

export function emptyStore(): YunoMockStore {
  return {
    customers: [],
    sessions: [],
    paymentMethods: [],
    payments: [],
    webhooks: [],
    idempotency: [],
    events: [],
    deliveries: [],
    asyncActions: [],
    scenarios: [],
    appliedEventIds: [],
  };
}

/** Normalize older file stores missing F4/F5 collections and payment history. */
export function normalizeStore(raw: Partial<YunoMockStore> | null | undefined): YunoMockStore {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  return {
    customers: raw.customers ?? [],
    sessions: raw.sessions ?? [],
    paymentMethods: raw.paymentMethods ?? [],
    payments: (raw.payments ?? []).map((p) => {
      const data = { ...(p.data ?? {}) } as Record<string, unknown>;
      const tx = data.transaction as Record<string, unknown> | undefined;
      if (!Array.isArray(data.transactions) || data.transactions.length === 0) {
        data.transactions = tx ? [tx] : [];
      }
      const amount = (data.amount ?? {}) as Record<string, unknown>;
      if (typeof amount.captured !== 'number') {
        amount.captured = data.status === 'SUCCEEDED' ? Number(amount.value ?? 0) : 0;
      }
      if (typeof amount.refunded !== 'number') {
        amount.refunded = 0;
      }
      data.amount = amount;
      return { ...p, data };
    }),
    webhooks: raw.webhooks ?? [],
    idempotency: raw.idempotency ?? [],
    events: raw.events ?? [],
    deliveries: (raw.deliveries ?? []).map((d) => ({
      ...d,
      attempts: d.attempts ?? [],
      payloadRedacted: d.payloadRedacted ?? {},
      attempt: d.attempt ?? 0,
      status: d.status ?? 'pending',
      eventId: d.eventId ?? '',
      webhookId: d.webhookId ?? '',
      firstAttemptAtMs: d.firstAttemptAtMs ?? 0,
      createdAt: d.createdAt ?? new Date(0).toISOString(),
      updatedAt: d.updatedAt ?? d.createdAt ?? new Date(0).toISOString(),
    })),
    asyncActions: raw.asyncActions ?? [],
    scenarios: raw.scenarios ?? [],
    appliedEventIds: raw.appliedEventIds ?? [],
  };
}

/**
 * Encrypt any legacy cleartext webhook secrets in-place.
 * Safe to call repeatedly — already-encrypted blobs are left alone.
 */
export function migrateWebhookSecretsInPlace(
  store: YunoMockStore,
  secretsKey: Buffer,
): void {
  for (const webhook of store.webhooks) {
    if (!webhook.secrets) continue;
    for (const key of WEBHOOK_SECRET_KEYS) {
      const value = webhook.secrets[key];
      if (typeof value === 'string' && value.length > 0) {
        webhook.secrets[key] = encryptSecret(value, secretsKey);
      }
    }
  }
}

/** Fail closed if any webhook secret is still a cleartext string. */
export function assertNoCleartextWebhookSecrets(store: YunoMockStore): void {
  for (const webhook of store.webhooks) {
    if (!webhook.secrets) continue;
    for (const key of WEBHOOK_SECRET_KEYS) {
      const value = webhook.secrets[key];
      if (value === undefined) continue;
      if (typeof value === 'string') {
        throw new Error(
          `refusing to persist cleartext webhook secret field ${key} for ${webhook.id}`,
        );
      }
      if (!isEncryptedSecretBlob(value)) {
        throw new Error(
          `invalid encrypted webhook secret field ${key} for ${webhook.id}`,
        );
      }
    }
  }
}

export interface YunoMockRepository {
  getStore(): Promise<YunoMockStore>;
  saveStore(store: YunoMockStore): Promise<void>;
  withLock<T>(fn: (store: YunoMockStore) => Promise<T> | T): Promise<T>;
}
