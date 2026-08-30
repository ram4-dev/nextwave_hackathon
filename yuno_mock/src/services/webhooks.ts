import type {
  WebhookRecord,
  WebhookSecretKey,
  WebhookSecrets,
  YunoMockRepository,
  YunoMockStore,
} from '../persistence/types.js';
import { WEBHOOK_SECRET_KEYS } from '../persistence/types.js';
import { Errors } from '../errors.js';
import { newYunoId, nowIso } from '../domain/ids.js';
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecretBlob,
} from '../crypto/secrets-at-rest.js';

export type WebhookCreateBody = {
  account_id: string;
  name: string;
  url: string;
  api_key?: string;
  secret?: string;
  hmac_client_secret?: string;
  enrollment_triggers?: string[];
  payment_triggers?: string[];
  onboarding_triggers?: string[];
  subscription_triggers?: string[];
  report_triggers?: string[];
  renewal_days?: number;
  oauth2_authentication_url?: string;
  oauth2_authorization_name?: string;
  oauth2_client_id?: string;
  oauth2_client_secret?: string;
  oauth2_grant_type?: string;
  oauth2_include_client_id?: boolean;
  oauth2_scope?: string;
  [key: string]: unknown;
};

export type WebhookUpdateBody = {
  account_id: string;
  name?: string;
  url?: string;
  state?: 'ACTIVE' | 'INACTIVE';
  api_key?: string;
  secret?: string;
  hmac_client_secret?: string;
  enrollment_triggers?: string[];
  payment_triggers?: string[];
  onboarding_triggers?: string[];
  subscription_triggers?: string[];
  report_triggers?: string[];
  renewal_days?: number;
  clear_renewal_days?: boolean;
  oauth2_authentication_url?: string;
  oauth2_authorization_name?: string;
  oauth2_client_id?: string;
  oauth2_client_secret?: string;
  oauth2_grant_type?: string;
  oauth2_include_client_id?: boolean;
  oauth2_scope?: string;
  [key: string]: unknown;
};

type StoredWebhookData = {
  account_id: string;
  name: string;
  url: string;
  state: 'ACTIVE' | 'INACTIVE';
  enrollment_triggers: string[] | null;
  payment_triggers: string[] | null;
  onboarding_triggers: string[] | null;
  subscription_triggers: string[] | null;
  report_triggers: string[] | null;
  renewal_days: number | null;
  oauth2_authentication_url: string | null;
  oauth2_authorization_name: string | null;
  oauth2_client_id: string | null;
  oauth2_grant_type: string | null;
  oauth2_include_client_id: boolean;
  oauth2_scope: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asData(record: WebhookRecord): StoredWebhookData {
  return record.data as unknown as StoredWebhookData;
}

function assertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw Errors.invalidRequest('url must be a valid http or https URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Errors.invalidRequest('url must be a valid http or https URL');
  }
}

function assertOauthBundle(body: {
  oauth2_authentication_url?: unknown;
  oauth2_client_id?: unknown;
  oauth2_client_secret?: unknown;
  oauth2_grant_type?: unknown;
}): void {
  const present = [
    body.oauth2_authentication_url,
    body.oauth2_client_id,
    body.oauth2_client_secret,
    body.oauth2_grant_type,
  ].filter((v) => v !== undefined && v !== null && v !== '');
  if (present.length === 0) return;
  if (present.length !== 4) {
    throw Errors.invalidRequest(
      'oauth2_authentication_url, oauth2_client_id, oauth2_client_secret and oauth2_grant_type must be sent together',
    );
  }
}

function findById(store: YunoMockStore, id: string): WebhookRecord | undefined {
  return store.webhooks.find((w) => w.id === id);
}

function findByName(
  store: YunoMockStore,
  accountId: string,
  name: string,
  exceptId?: string,
): WebhookRecord | undefined {
  return store.webhooks.find((w) => {
    const data = asData(w);
    return (
      data.account_id === accountId &&
      data.name === name &&
      w.id !== exceptId
    );
  });
}

function hasSecret(secrets: WebhookSecrets | undefined, key: WebhookSecretKey): boolean {
  const value = secrets?.[key];
  if (value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  return isEncryptedSecretBlob(value);
}

function setEncryptedSecret(
  secrets: WebhookSecrets,
  key: WebhookSecretKey,
  plaintext: string,
  secretsKey: Buffer,
): void {
  secrets[key] = encryptSecret(plaintext, secretsKey);
}

/** Public API shape — secrets always masked (`***`) or null; never cleartext. */
export function toWebhookResponse(record: WebhookRecord): Record<string, unknown> {
  const data = asData(record);
  const secrets = record.secrets ?? {};
  return {
    id: record.id,
    account_id: data.account_id,
    name: data.name,
    url: data.url,
    state: data.state,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    enrollment_triggers: data.enrollment_triggers,
    payment_triggers: data.payment_triggers,
    onboarding_triggers: data.onboarding_triggers,
    subscription_triggers: data.subscription_triggers,
    report_triggers: data.report_triggers,
    renewal_days: data.renewal_days,
    oauth2_authentication_url: data.oauth2_authentication_url,
    oauth2_authorization_name: data.oauth2_authorization_name,
    oauth2_client_id: data.oauth2_client_id,
    oauth2_grant_type: data.oauth2_grant_type,
    oauth2_include_client_id: data.oauth2_include_client_id,
    oauth2_scope: data.oauth2_scope,
    hmac_client_secret: hasSecret(secrets, 'hmac_client_secret') ? '***' : null,
    api_key: hasSecret(secrets, 'api_key') ? '***' : null,
    secret: hasSecret(secrets, 'secret') ? '***' : null,
    oauth2_client_secret: hasSecret(secrets, 'oauth2_client_secret') ? '***' : null,
  };
}

export async function createWebhook(
  repo: YunoMockRepository,
  body: WebhookCreateBody,
  secretsKey: Buffer,
): Promise<Record<string, unknown>> {
  if (!body.account_id || !UUID_RE.test(body.account_id)) {
    throw Errors.invalidRequest('account_id must be a UUID');
  }
  if (!body.name || typeof body.name !== 'string') {
    throw Errors.invalidRequest('name is required');
  }
  if (!body.url || typeof body.url !== 'string') {
    throw Errors.invalidRequest('url is required');
  }
  assertUrl(body.url);
  assertOauthBundle(body);

  return repo.withLock((store) => {
    if (findByName(store, body.account_id, body.name)) {
      throw Errors.invalidRequest('webhook name must be unique within the account');
    }
    const ts = nowIso();
    const id = newYunoId();
    const secrets: WebhookSecrets = {};
    if (typeof body.hmac_client_secret === 'string' && body.hmac_client_secret) {
      setEncryptedSecret(secrets, 'hmac_client_secret', body.hmac_client_secret, secretsKey);
    }
    if (typeof body.api_key === 'string' && body.api_key) {
      setEncryptedSecret(secrets, 'api_key', body.api_key, secretsKey);
    }
    if (typeof body.secret === 'string' && body.secret) {
      setEncryptedSecret(secrets, 'secret', body.secret, secretsKey);
    }
    if (typeof body.oauth2_client_secret === 'string' && body.oauth2_client_secret) {
      setEncryptedSecret(secrets, 'oauth2_client_secret', body.oauth2_client_secret, secretsKey);
    }

    const data: StoredWebhookData = {
      account_id: body.account_id,
      name: body.name,
      url: body.url,
      state: 'ACTIVE',
      enrollment_triggers: body.enrollment_triggers ?? null,
      payment_triggers: body.payment_triggers ?? null,
      onboarding_triggers: body.onboarding_triggers ?? null,
      subscription_triggers: body.subscription_triggers ?? null,
      report_triggers: body.report_triggers ?? null,
      renewal_days: typeof body.renewal_days === 'number' ? body.renewal_days : null,
      oauth2_authentication_url: body.oauth2_authentication_url ?? null,
      oauth2_authorization_name: body.oauth2_authorization_name ?? null,
      oauth2_client_id: body.oauth2_client_id ?? null,
      oauth2_grant_type: body.oauth2_grant_type ?? null,
      oauth2_include_client_id: body.oauth2_include_client_id ?? false,
      oauth2_scope: typeof body.oauth2_scope === 'string' ? body.oauth2_scope : null,
    };

    const record: WebhookRecord = {
      id,
      data: data as unknown as Record<string, unknown>,
      secrets,
      createdAt: ts,
      updatedAt: ts,
    };
    store.webhooks.push(record);
    return toWebhookResponse(record);
  });
}

export async function listWebhooks(
  repo: YunoMockRepository,
): Promise<Record<string, unknown>[]> {
  return repo.withLock((store) => store.webhooks.map(toWebhookResponse));
}

export async function updateWebhook(
  repo: YunoMockRepository,
  webhookId: string,
  body: WebhookUpdateBody,
  secretsKey: Buffer,
): Promise<Record<string, unknown>> {
  if (!body.account_id || !UUID_RE.test(body.account_id)) {
    throw Errors.invalidRequest('account_id must be a UUID');
  }
  assertOauthBundle(body);
  if (body.url !== undefined) {
    if (typeof body.url !== 'string') throw Errors.invalidRequest('url must be a string');
    assertUrl(body.url);
  }
  if (body.clear_renewal_days && body.renewal_days !== undefined) {
    throw Errors.invalidRequest('clear_renewal_days must not be sent together with renewal_days');
  }

  return repo.withLock((store) => {
    const record = findById(store, webhookId);
    if (!record) throw Errors.notFound('webhook_id not found');
    const data = asData(record);
    if (data.account_id !== body.account_id) {
      throw Errors.invalidRequest('account_id does not match webhook');
    }
    if (body.name !== undefined) {
      if (findByName(store, body.account_id, body.name, webhookId)) {
        throw Errors.invalidRequest('webhook name must be unique within the account');
      }
      data.name = body.name;
    }
    if (body.url !== undefined) data.url = body.url;
    if (body.state !== undefined) data.state = body.state;
    if (body.enrollment_triggers !== undefined) {
      data.enrollment_triggers = body.enrollment_triggers;
    }
    if (body.payment_triggers !== undefined) data.payment_triggers = body.payment_triggers;
    if (body.onboarding_triggers !== undefined) {
      data.onboarding_triggers = body.onboarding_triggers;
    }
    if (body.subscription_triggers !== undefined) {
      data.subscription_triggers = body.subscription_triggers;
    }
    if (body.report_triggers !== undefined) data.report_triggers = body.report_triggers;
    if (body.clear_renewal_days) data.renewal_days = null;
    else if (body.renewal_days !== undefined) data.renewal_days = body.renewal_days;

    if (body.oauth2_authentication_url !== undefined) {
      data.oauth2_authentication_url = body.oauth2_authentication_url;
    }
    if (body.oauth2_authorization_name !== undefined) {
      data.oauth2_authorization_name = body.oauth2_authorization_name;
    }
    if (body.oauth2_client_id !== undefined) data.oauth2_client_id = body.oauth2_client_id;
    if (body.oauth2_grant_type !== undefined) data.oauth2_grant_type = body.oauth2_grant_type;
    if (body.oauth2_include_client_id !== undefined) {
      data.oauth2_include_client_id = body.oauth2_include_client_id;
    }
    if (body.oauth2_scope !== undefined) data.oauth2_scope = body.oauth2_scope;

    const secrets = record.secrets ?? {};
    if (typeof body.hmac_client_secret === 'string' && body.hmac_client_secret) {
      setEncryptedSecret(secrets, 'hmac_client_secret', body.hmac_client_secret, secretsKey);
    }
    if (typeof body.api_key === 'string' && body.api_key) {
      setEncryptedSecret(secrets, 'api_key', body.api_key, secretsKey);
    }
    if (typeof body.secret === 'string' && body.secret) {
      setEncryptedSecret(secrets, 'secret', body.secret, secretsKey);
    }
    if (typeof body.oauth2_client_secret === 'string' && body.oauth2_client_secret) {
      setEncryptedSecret(secrets, 'oauth2_client_secret', body.oauth2_client_secret, secretsKey);
    }
    record.secrets = secrets;
    record.data = data as unknown as Record<string, unknown>;
    record.updatedAt = nowIso();
    return toWebhookResponse(record);
  });
}

export async function deleteWebhook(
  repo: YunoMockRepository,
  webhookId: string,
): Promise<Record<string, unknown>> {
  return repo.withLock((store) => {
    const idx = store.webhooks.findIndex((w) => w.id === webhookId);
    if (idx < 0) throw Errors.notFound('webhook_id not found');
    const [removed] = store.webhooks.splice(idx, 1);
    return toWebhookResponse(removed!);
  });
}

export function listActiveWebhooksForAccount(
  store: YunoMockStore,
  accountId: string,
  paymentTrigger: string,
): WebhookRecord[] {
  return store.webhooks.filter((w) => {
    const data = asData(w);
    if (data.account_id !== accountId) return false;
    if (data.state !== 'ACTIVE') return false;
    const triggers = data.payment_triggers;
    if (!triggers || triggers.length === 0) return false;
    return triggers.includes(paymentTrigger);
  });
}

/**
 * Decrypt a webhook secret for signing only. Returns undefined when unset.
 * Never use the return value in API responses, logs, or audit payloads.
 */
export function decryptWebhookSecret(
  record: WebhookRecord,
  key: WebhookSecretKey,
  secretsKey: Buffer,
): string | undefined {
  const value = record.secrets?.[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    // Legacy cleartext — should have been migrated; allow ephemeral decrypt path.
    return value.length > 0 ? value : undefined;
  }
  if (!isEncryptedSecretBlob(value)) return undefined;
  return decryptSecret(value, secretsKey);
}

/** @deprecated Prefer decryptWebhookSecret — kept for call-site clarity during F4. */
export function getWebhookSecret(
  record: WebhookRecord,
  key: WebhookSecretKey,
  secretsKey: Buffer,
): string | undefined {
  return decryptWebhookSecret(record, key, secretsKey);
}

export function webhookUrl(record: WebhookRecord): string {
  return asData(record).url;
}

export function webhookHasAnySecret(record: WebhookRecord): boolean {
  return WEBHOOK_SECRET_KEYS.some((k) => hasSecret(record.secrets, k));
}
