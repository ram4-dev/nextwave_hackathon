import * as jose from 'jose';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';

export type KeystoreProviderKind = 'os_hardware' | 'encrypted_os_keystore';

export interface LocalAgentKey {
  publicJwk: JsonWebKey;
  thumbprint: string;
  keystoreProvider: KeystoreProviderKind;
  /** Private key handle — never serialize or log. */
  privateKey: CryptoKey;
  /** Demo-only extractable fallback material; undefined for HW path. */
  encryptedPrivateJwk?: never;
}

function webcrypto(): Crypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error('WebCrypto is required for local agent key generation');
}

/**
 * Prefer non-extractable P-256 (models OS hardware keystore).
 * If the runtime rejects non-extractable generation, fall back to extractable
 * keys representing an encrypted OS keystore (private material never logged/serialized by KYA).
 */
export async function generateLocalAgentKey(): Promise<LocalAgentKey> {
  const crypto = webcrypto();
  let keystoreProvider: KeystoreProviderKind = 'os_hardware';
  let keyPair: CryptoKeyPair;

  try {
    keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    );
    // Probe extractability: non-extractable export must fail.
    try {
      await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      // Runtime ignored extractable:false — treat as encrypted OS keystore model.
      keystoreProvider = 'encrypted_os_keystore';
      keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
    } catch {
      keystoreProvider = 'os_hardware';
    }
  } catch {
    keystoreProvider = 'encrypted_os_keystore';
    keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
  }

  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  sanitizePublicJwk(publicJwk);
  const thumbprint = await jose.calculateJwkThumbprint(publicJwk, 'sha256');

  return {
    publicJwk,
    thumbprint,
    keystoreProvider,
    privateKey: keyPair.privateKey,
  };
}

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const P256_COORD_BYTES = 32;

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeBase64UrlExact(value: string, expectedBytes: number): Uint8Array {
  if (!B64URL_RE.test(value) || value.includes('=')) {
    throw new Error('Invalid base64url coordinates');
  }
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const buf = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length !== expectedBytes) {
    throw new Error(`P-256 coordinate must decode to exactly ${expectedBytes} bytes`);
  }
  const out = new Uint8Array(buf);
  // Canonical: re-encode must match input exactly (rejects non-canonical padding bits).
  if (encodeBase64Url(out) !== value) {
    throw new Error('Non-canonical base64url coordinate encoding');
  }
  return out;
}

function assertPublicEs256Metadata(raw: Record<string, unknown>): void {
  if (raw.alg !== undefined && raw.alg !== 'ES256') {
    throw new Error('Public JWK alg must be ES256');
  }
  if (raw.use !== undefined && raw.use !== 'sig') {
    throw new Error('Public JWK use must be sig');
  }
  if (raw.key_ops !== undefined) {
    if (
      !Array.isArray(raw.key_ops) ||
      raw.key_ops.length !== 1 ||
      raw.key_ops[0] !== 'verify'
    ) {
      throw new Error('Public JWK key_ops must be the unique verification-only set');
    }
  }
  if (raw.ext !== undefined && raw.ext !== true) {
    throw new Error('Public JWK ext must be true');
  }
  if (
    raw.kid !== undefined &&
    (typeof raw.kid !== 'string' || raw.kid.trim().length === 0)
  ) {
    throw new Error('Public JWK kid must be a non-empty string');
  }
}

export function sanitizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  for (const field of PRIVATE_JWK_FIELDS) {
    delete (jwk as Record<string, unknown>)[field];
  }
  jwk.kty = 'EC';
  jwk.crv = 'P-256';
  return jwk;
}

/** Strict public EC P-256 JWK validation before persistence. */
export function assertPublicEcP256Jwk(jwk: JsonWebKey): JsonWebKey {
  const raw = jwk as Record<string, unknown>;
  for (const field of PRIVATE_JWK_FIELDS) {
    if (raw[field] !== undefined) {
      throw new Error(`Private JWK member rejected: ${field}`);
    }
  }
  if (jwk.kty !== 'EC') throw new Error('Unsupported key type');
  if (jwk.crv !== 'P-256') throw new Error('Unsupported curve');
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('Missing P-256 coordinates');
  }
  decodeBase64UrlExact(jwk.x, P256_COORD_BYTES);
  decodeBase64UrlExact(jwk.y, P256_COORD_BYTES);
  const allowed = new Set(['kty', 'crv', 'x', 'y', 'kid', 'use', 'alg', 'ext', 'key_ops']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Error(`Incompatible JWK field rejected: ${key}`);
    }
  }
  assertPublicEs256Metadata(raw);
  const cleaned = sanitizePublicJwk({ ...jwk });
  // Cryptographic curve-point validation — rejects (0,0) and off-curve points.
  try {
    createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: cleaned.x, y: cleaned.y },
      format: 'jwk',
    });
  } catch (err) {
    throw new Error(
      `Invalid P-256 public point: ${err instanceof Error ? err.message : 'rejected by crypto'}`,
    );
  }
  return cleaned;
}

export function isPrivateJwkMemberPresent(jwk: unknown): boolean {
  if (!jwk || typeof jwk !== 'object') return false;
  const raw = jwk as Record<string, unknown>;
  return PRIVATE_JWK_FIELDS.some((field) => raw[field] !== undefined);
}

export { PRIVATE_JWK_FIELDS };

export async function thumbprintFromJwk(jwk: JsonWebKey): Promise<string> {
  const publicJwk = sanitizePublicJwk({ ...jwk });
  return jose.calculateJwkThumbprint(publicJwk, 'sha256');
}

export function fingerprintDisplay(thumbprint: string): string {
  const compact = thumbprint.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const chunks = compact.match(/.{1,4}/g) ?? [compact];
  return chunks.slice(0, 8).join('-');
}

export function generateDeviceCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

export async function signChallenge(
  privateKey: CryptoKey,
  payload: {
    nonce: string;
    audience: string;
    timestamp: string;
    intent_hash: string;
  },
): Promise<string> {
  try {
    const jwk = await webcrypto().subtle.exportKey('jwk', privateKey);
    const key = await jose.importJWK(jwk, 'ES256');
    return new jose.CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: 'ES256', typ: 'KYA-CHALLENGE+JWT' })
      .sign(key);
  } catch {
    // Non-extractable path: raw ECDSA signature over canonical bytes.
  }

  const bytes = new TextEncoder().encode(canonicalChallenge(payload));
  const sig = await webcrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    bytes,
  );
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', typ: 'KYA-CHALLENGE-RAW' }),
  ).toString('base64url');
  const body = Buffer.from(bytes).toString('base64url');
  const signature = Buffer.from(sig).toString('base64url');
  return `${header}.${body}.${signature}`;
}

export function canonicalChallenge(payload: {
  nonce: string;
  audience: string;
  timestamp: string;
  intent_hash: string;
}): string {
  return [
    `nonce=${payload.nonce}`,
    `audience=${payload.audience}`,
    `timestamp=${payload.timestamp}`,
    `intent_hash=${payload.intent_hash}`,
  ].join('\n');
}

export async function verifyChallengeSignature(
  publicJwk: JsonWebKey,
  token: string,
  expected: {
    nonce: string;
    audience: string;
    timestamp: string;
    intent_hash: string;
  },
): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  if (!h || !p || !s) return false;

  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as {
    alg?: string;
    typ?: string;
  };
  if (header.alg !== 'ES256') return false;

  const crypto = webcrypto();
  const key = await crypto.subtle.importKey(
    'jwk',
    sanitizePublicJwk({ ...publicJwk }),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  if (header.typ === 'KYA-CHALLENGE+JWT') {
    try {
      const { payload } = await jose.compactVerify(token, await jose.importJWK(sanitizePublicJwk({ ...publicJwk }), 'ES256'));
      const parsed = JSON.parse(new TextDecoder().decode(payload)) as typeof expected;
      return (
        parsed.nonce === expected.nonce &&
        parsed.audience === expected.audience &&
        parsed.timestamp === expected.timestamp &&
        parsed.intent_hash === expected.intent_hash
      );
    } catch {
      return false;
    }
  }

  const body = Buffer.from(p, 'base64url');
  const expectedBytes = new TextEncoder().encode(canonicalChallenge(expected));
  if (!body.equals(Buffer.from(expectedBytes))) return false;
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(s, 'base64url'),
    expectedBytes,
  );
}

export function intentHash(intent: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(intent))
    .digest('hex');
}

/** Guard: never include private key material in logs or API responses. */
export function assertNoPrivateKeyMaterial(value: unknown, path = '$'): void {
  if (value == null) return;
  if (typeof value === 'string') {
    // JWK private exponent field appearance in JSON dumps
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPrivateKeyMaterial(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'privateKey', 'private_key'].includes(k)) {
        throw new Error(`Forbidden private key material at ${path}.${k}`);
      }
      assertNoPrivateKeyMaterial(v, `${path}.${k}`);
    }
  }
}
