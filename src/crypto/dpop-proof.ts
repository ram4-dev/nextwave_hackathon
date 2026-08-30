import { createHash, randomUUID } from 'node:crypto';
import * as jose from 'jose';
import {
  assertPublicEcP256Jwk,
  sanitizePublicJwk,
} from './local-agent-key.js';

function webcrypto(): Crypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto;
  }
  throw new Error('WebCrypto is required for DPoP proof signing');
}

export function computeAth(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'utf8').digest('base64url');
}

/**
 * Build an RFC 9449 DPoP proof JWT. Accepts a CryptoKey handle so external
 * local agents can keep private material in their own keystore.
 */
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
  const pub = sanitizePublicJwk({ ...assertPublicEcP256Jwk(publicJwk) });
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const jti = input.jti ?? randomUUID();
  const payload = {
    htm: input.htm.toUpperCase(),
    htu: input.htu,
    iat,
    jti,
    ath: computeAth(input.accessToken),
  };

  try {
    const jwk = await webcrypto().subtle.exportKey('jwk', privateKey);
    const key = await jose.importJWK(jwk, 'ES256');
    return new jose.SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: pub })
      .sign(key);
  } catch {
    // Non-extractable: manual compact JWS with SubtleCrypto.
    const header = Buffer.from(
      JSON.stringify({ alg: 'ES256', typ: 'dpop+jwt', jwk: pub }),
    ).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const data = new TextEncoder().encode(`${header}.${body}`);
    const sig = await webcrypto().subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      data,
    );
    // Convert IEEE P1363 to JOSE if needed — SubtleCrypto ES256 is P1363.
    const signature = Buffer.from(sig).toString('base64url');
    return `${header}.${body}.${signature}`;
  }
}

/** Thin HTTP helper: attach DPoP Authorization + proof headers. */
export async function dpopFetch(
  privateKey: CryptoKey,
  publicJwk: JsonWebKey,
  accessToken: string,
  url: string,
  init: RequestInit & { publicBaseUrl: string } = { publicBaseUrl: '' },
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const target = new URL(url);
  const htu = `${init.publicBaseUrl ? new URL(init.publicBaseUrl).origin : target.origin}${target.pathname}`;
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
