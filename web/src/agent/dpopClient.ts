/**
 * Browser-safe DPoP helpers. Validates public JWK via SubtleCrypto importKey
 * (curve point check). Server cnf.jkt binding remains the authoritative
 * proof↔enrollment match after the proof is verified.
 */

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const P256_COORD_BYTES = 32;

function encodeBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64UrlExact(value: string, expectedBytes: number): Uint8Array {
  if (!B64URL_RE.test(value) || value.includes('=')) {
    throw new Error('Invalid base64url coordinates');
  }
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  if (bin.length !== expectedBytes) {
    throw new Error(`P-256 coordinate must decode to exactly ${expectedBytes} bytes`);
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
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

/** Browser-safe public JWK sanitizer — strips all private members. */
export function sanitizePublicJwk(jwk: JsonWebKey): JsonWebKey {
  const copy = { ...jwk } as JsonWebKey & Record<string, unknown>;
  for (const field of PRIVATE_JWK_FIELDS) {
    delete copy[field];
  }
  copy.kty = 'EC';
  copy.crv = 'P-256';
  return copy;
}

export async function assertPublicEcP256Jwk(jwk: JsonWebKey): Promise<JsonWebKey> {
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
    if (!allowed.has(key)) throw new Error(`Incompatible JWK field rejected: ${key}`);
  }
  assertPublicEs256Metadata(raw);
  const cleaned = sanitizePublicJwk({ ...jwk });
  try {
    await crypto.subtle.importKey(
      'jwk',
      cleaned,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
  } catch (err) {
    throw new Error(
      `Invalid P-256 public point: ${err instanceof Error ? err.message : 'rejected by SubtleCrypto'}`,
    );
  }
  return cleaned;
}

export async function computeAth(accessToken: string): Promise<string> {
  const data = new TextEncoder().encode(accessToken);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function buildDpopProof(
  privateKey: CryptoKey,
  publicJwk: JsonWebKey,
  input: {
    htm: string;
    htu: string;
    accessToken: string;
    iat?: number;
    jti?: string;
  },
): Promise<string> {
  const pub = await assertPublicEcP256Jwk({ ...publicJwk });
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const jti = input.jti ?? crypto.randomUUID();
  const payload = {
    htm: input.htm.toUpperCase(),
    htu: input.htu,
    iat,
    jti,
    ath: await computeAth(input.accessToken),
  };
  const header = JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: pub });
  const toB64Url = (value: string | ArrayBuffer) => {
    const u8 =
      typeof value === 'string'
        ? new TextEncoder().encode(value)
        : new Uint8Array(value);
    let s = '';
    for (const b of u8) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const h = toB64Url(header);
  const p = toB64Url(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${h}.${p}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  return `${h}.${p}.${toB64Url(sig)}`;
}

export async function dpopFetch(
  privateKey: CryptoKey,
  publicJwk: JsonWebKey,
  accessToken: string,
  url: string,
  init: RequestInit & { publicBaseUrl: string },
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const target = new URL(url);
  const origin = new URL(init.publicBaseUrl).origin;
  const htu = `${origin}${target.pathname}`;
  const proof = await buildDpopProof(privateKey, publicJwk, {
    htm: method,
    htu,
    accessToken,
  });
  const headers = new Headers(init.headers);
  headers.set('Authorization', `DPoP ${accessToken}`);
  headers.set('DPoP', proof);
  const { publicBaseUrl: _p, ...rest } = init;
  void _p;
  return fetch(url, { ...rest, method, headers });
}
