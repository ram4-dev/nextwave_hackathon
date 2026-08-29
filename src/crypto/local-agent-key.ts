import * as jose from 'jose';
import { createHash, randomBytes } from 'node:crypto';

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

export function sanitizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  delete (jwk as Record<string, unknown>).d;
  delete (jwk as Record<string, unknown>).p;
  delete (jwk as Record<string, unknown>).q;
  delete (jwk as Record<string, unknown>).dp;
  delete (jwk as Record<string, unknown>).dq;
  delete (jwk as Record<string, unknown>).qi;
  jwk.kty = 'EC';
  jwk.crv = 'P-256';
  return jwk;
}

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
  const key = await jose.importJWK(
    await webcrypto().subtle.exportKey('jwk', privateKey).catch(async () => {
      // Non-extractable: use CryptoKey directly via SubtleCrypto sign
      throw new NonExtractableSignError();
    }),
    'ES256',
  ).catch(() => null);

  if (key) {
    return new jose.CompactSign(
      new TextEncoder().encode(JSON.stringify(payload)),
    )
      .setProtectedHeader({ alg: 'ES256', typ: 'KYA-CHALLENGE+JWT' })
      .sign(key);
  }

  // Non-extractable path: raw ECDSA signature over canonical bytes, wrapped as JWS-like token.
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

class NonExtractableSignError extends Error {
  constructor() {
    super('private key is non-extractable');
  }
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
