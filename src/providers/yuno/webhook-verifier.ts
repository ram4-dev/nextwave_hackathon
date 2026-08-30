/**
 * Shared Yuno webhook HMAC verifier (F4).
 * Signs/verifies over the exact raw body bytes — never re-serialized JSON.
 * Constant-time comparison. Used by the mock emitter tests and future F6 receiver.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const YUNO_HMAC_SIGNATURE_HEADER = 'x-hmac-signature';

/** HMAC-SHA256(rawBody, secret) → Base64, matching Yuno docs. */
export function signYunoWebhookBody(
  rawBody: string | Buffer | Uint8Array,
  secret: string,
): string {
  const body =
    typeof rawBody === 'string'
      ? Buffer.from(rawBody, 'utf8')
      : Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(rawBody);
  return createHmac('sha256', secret).update(body).digest('base64');
}

/**
 * Verify `x-hmac-signature` against the exact raw request body and secret.
 * Returns false for missing/invalid inputs without throwing.
 */
export function verifyYunoWebhookSignature(input: {
  rawBody: string | Buffer | Uint8Array;
  signatureHeader: string | null | undefined;
  secret: string;
}): boolean {
  const { rawBody, signatureHeader, secret } = input;
  if (!secret || typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return false;
  }
  let expected: string;
  try {
    expected = signYunoWebhookBody(rawBody, secret);
  } catch {
    return false;
  }

  const a = Buffer.from(signatureHeader, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
