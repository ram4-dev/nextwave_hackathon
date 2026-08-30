import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '../state-machine.js';
import type { PublicErrorCode } from '../../providers/yuno/state-mapper.js';

export class PaymentError extends DomainError {
  constructor(
    message: string,
    code: PublicErrorCode | string,
    readonly httpStatus: number = 400,
  ) {
    super(message, code);
    this.name = 'PaymentError';
  }
}

export function newPaymentId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
}

export function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString();
}

/** Canonical JSON body hash for platform idempotency binding. */
export function canonicalBodyHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Derive a stable UUID v5-like key from attempt identity for provider X-Idempotency-Key.
 * Uses SHA-256 truncated into UUID layout (deterministic, not RFC-4122 name-based).
 */
export function deriveProviderIdempotencyKey(seed: string): string {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Redact known sensitive keys from objects for audit/logs. */
export function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      lower.includes('vaulted') ||
      lower.includes('secret') ||
      lower.includes('api_key') ||
      lower.includes('apikey') ||
      lower === 'pan' ||
      lower === 'cvv' ||
      lower === 'cvc' ||
      lower === 'authorization' ||
      lower === 'private-secret-key' ||
      lower === 'public-api-key'
    ) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = redactSensitive(child);
  }
  return out;
}

/** Assert a public JSON payload has no forbidden fields. */
export function assertPublicSafe(payload: unknown): void {
  const json = JSON.stringify(payload).toLowerCase();
  for (const needle of [
    'vaulted_token',
    '"pan"',
    '"cvv"',
    'private-secret-key',
    'public-api-key',
    'yuno_private',
    'yuno_public',
  ]) {
    if (json.includes(needle)) {
      throw new PaymentError('public payload contains sensitive material', 'invalid_request', 500);
    }
  }
}
