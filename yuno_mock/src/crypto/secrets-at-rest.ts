/**
 * AES-256-GCM encryption for webhook signing secrets at rest.
 * File/memory store must persist ciphertext/iv/tag only — never HMAC cleartext.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

export const SECRETS_AT_REST_ALG = 'aes-256-gcm' as const;

export type EncryptedSecretBlob = {
  v: 1;
  alg: typeof SECRETS_AT_REST_ALG;
  iv: string;
  tag: string;
  ciphertext: string;
};

const KEY_BYTES = 32;

/** Dev/test default — 32 zero-ish but distinct fixture bytes (hex). Never use in production. */
export const DEV_DEFAULT_SECRETS_KEY_HEX =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function isEncryptedSecretBlob(value: unknown): value is EncryptedSecretBlob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    v.alg === SECRETS_AT_REST_ALG &&
    typeof v.iv === 'string' &&
    typeof v.tag === 'string' &&
    typeof v.ciphertext === 'string'
  );
}

export function parseSecretsKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  try {
    const b64 = Buffer.from(trimmed, 'base64');
    if (b64.length === KEY_BYTES) return b64;
  } catch {
    // fall through
  }
  throw new Error(
    'YUNO_MOCK_SECRETS_KEY must be 32 bytes as 64-char hex or base64',
  );
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecretBlob {
  if (key.length !== KEY_BYTES) {
    throw new Error('secrets key must be 32 bytes');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(SECRETS_AT_REST_ALG, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: SECRETS_AT_REST_ALG,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptSecret(blob: EncryptedSecretBlob, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error('secrets key must be 32 bytes');
  }
  if (!isEncryptedSecretBlob(blob)) {
    throw new Error('invalid encrypted secret blob');
  }
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(SECRETS_AT_REST_ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8',
  );
}

/** True when JSON text appears to contain a cleartext secret field value (heuristic scan). */
export function storeJsonContainsCleartextSecretField(
  jsonText: string,
  knownPlaintexts: readonly string[],
): boolean {
  for (const secret of knownPlaintexts) {
    if (!secret || secret.length < 4) continue;
    if (jsonText.includes(secret)) return true;
  }
  return false;
}

export function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
