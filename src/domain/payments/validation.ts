/**
 * Strict platform request validation (zod) + sensitive-input rejection.
 * Key/schema based — does not use Luhn/PAN heuristics that false-positive UUIDs.
 */
import { z } from 'zod';
import { currencyExponent } from './currency.js';
import { PaymentError } from './helpers.js';

const FORBIDDEN_BODY_KEYS = new Set([
  'pan',
  'cvv',
  'cvc',
  'card_number',
  'cardnumber',
  'primary_account_number',
  'security_code',
  'vaulted_token',
  'public_api_key',
  'private_secret_key',
  'public-api-key',
  'private-secret-key',
  'yuno_public_api_key',
  'yuno_private_secret_key',
]);

function normalizeKey(key: string): string {
  return key.replace(/[-_]/g, '').toLowerCase();
}

/** Deep-scan for forbidden sensitive keys (schema-based, not Luhn). */
export function assertNoSensitiveInputFields(value: unknown, path = '$'): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSensitiveInputFields(item, `${path}[${i}]`));
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_BODY_KEYS.has(lower) || FORBIDDEN_BODY_KEYS.has(normalizeKey(key))) {
      throw new PaymentError(
        'Request contains forbidden sensitive fields',
        'invalid_request',
        400,
      );
    }
    assertNoSensitiveInputFields(child, `${path}.${key}`);
  }
}

const moneySchema = z
  .object({
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .refine((c) => {
        try {
          currencyExponent(c);
          return true;
        } catch {
          return false;
        }
      }, 'unsupported currency'),
    value_minor: z
      .number()
      .int()
      .positive()
      .refine((n) => Number.isSafeInteger(n), 'value_minor must be a safe integer'),
  })
  .strict();

export const createPaymentBodySchema = z
  .object({
    merchant_id: z.string().min(1),
    authorization_id: z.string().min(1),
    payment_method_id: z.string().min(1),
    merchant_order_id: z.string().min(1),
    description: z.string().min(1),
    amount: moneySchema,
    capture_method: z.enum(['automatic', 'manual']),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    return_url: z.string().url().optional(),
  })
  .strict();

export const captureBodySchema = z
  .object({
    amount: moneySchema.optional(),
  })
  .strict();

export const refundBodySchema = z
  .object({
    payment_id: z.string().min(1),
    amount: moneySchema.optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

export const enrollmentBodySchema = z
  .object({
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();

export const patchPaymentMethodBodySchema = z
  .object({
    alias: z.string().min(1).optional(),
    is_default: z.boolean().optional(),
  })
  .strict();

export const webhookEndpointBodySchema = z
  .object({
    url: z
      .string()
      .url()
      .refine((u) => {
        try {
          const parsed = new URL(u);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      }, 'url must be http or https'),
  })
  .strict();

export function parseStrictBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  assertNoSensitiveInputFields(raw);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PaymentError(
      parsed.error.issues[0]?.message ?? 'Invalid request body',
      'invalid_request',
      400,
    );
  }
  return parsed.data;
}

export type CreatePaymentBody = z.infer<typeof createPaymentBodySchema>;
export type CaptureBody = z.infer<typeof captureBodySchema>;
export type RefundBody = z.infer<typeof refundBodySchema>;
