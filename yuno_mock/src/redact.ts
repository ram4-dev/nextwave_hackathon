import { randomUUID } from 'node:crypto';

const SECRET_HEADER_NAMES = new Set([
  'public-api-key',
  'private-secret-key',
  'x-public-api-key',
  'x-private-secret-key',
  'authorization',
  'x-api-key',
  'x-secret',
  'x-hmac-signature',
]);

/** Webhook config / audit keys that must never appear in cleartext exports. */
const WEBHOOK_SECRET_FIELD_KEYS = new Set([
  'hmac_client_secret',
  'api_key',
  'secret',
  'oauth2_client_secret',
  'secrets',
]);

export function resolveRequestId(headerValue: string | undefined): string {
  const trimmed = headerValue?.trim();
  if (trimmed && trimmed.length > 0 && trimmed.length <= 128) {
    return trimmed;
  }
  return randomUUID();
}

/** Redact known secret header values and common key substrings from a string. */
export function redactSecrets(
  value: string,
  secrets: readonly string[] = [],
): string {
  let out = value;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export function redactHeaderRecord(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SECRET_HEADER_NAMES.has(name.toLowerCase())) {
      out[name] = value === undefined || value === '' ? value : '[REDACTED]';
    } else {
      out[name] = value;
    }
  }
  return out;
}

export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_NAMES.has(name.toLowerCase());
}

export function isWebhookSecretFieldKey(key: string): boolean {
  return WEBHOOK_SECRET_FIELD_KEYS.has(key.toLowerCase());
}

/**
 * Deep-clone audit/export material, replacing webhook secret fields with `***`
 * or omitting the isolated `secrets` bag entirely.
 */
export function redactWebhookSecretsForExport(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactWebhookSecretsForExport(item));
  }
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'secrets') continue;
    if (isWebhookSecretFieldKey(key)) {
      out[key] = child == null || child === '' ? null : '***';
      continue;
    }
    out[key] = redactWebhookSecretsForExport(child);
  }
  return out;
}
