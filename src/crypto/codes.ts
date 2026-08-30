import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** High-entropy agent-held device code (never log or persist plaintext). */
export function generateHighEntropyDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/** Human-facing user code (short, unambiguous charset). */
export function generateUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i]! % alphabet.length]!;
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function hashOpaqueCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function codesEqualHash(plaintext: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueCode(plaintext), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
