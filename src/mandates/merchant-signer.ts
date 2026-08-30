import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import type { CheckoutSnapshot, MerchantSigner } from './types.js';

const audience = 'ap2.checkout';
const allowedLocalEnvs = new Set(['development', 'test']);

function resolveNodeEnv(explicit?: string): string {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return process.env.NODE_ENV ?? '';
}

export async function createLocalMerchantSigner(input: {
  privateJwk?: JsonWebKey;
  issuer: string;
  /** Explicit environment override. When omitted, process.env.NODE_ENV is required and must be development/test. */
  nodeEnv?: string;
}): Promise<MerchantSigner> {
  const nodeEnv = resolveNodeEnv(input.nodeEnv);
  if (!allowedLocalEnvs.has(nodeEnv)) {
    throw new DomainError(
      'Local merchant signer is unavailable outside development/test (set nodeEnv explicitly or NODE_ENV)',
      'MERCHANT_SIGNER_ENV',
    );
  }
  let privateJwk = input.privateJwk;
  if (!privateJwk) {
    privateJwk = await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey);
  }
  if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || typeof privateJwk.d !== 'string') {
    throw new DomainError('Merchant key must be an ES256 (P-256) private JWK', 'MERCHANT_SIGNER_KEY');
  }
  const privateKey = await importJWK(privateJwk, 'ES256');
  const publicJwk = { ...privateJwk } as JsonWebKey;
  delete (publicJwk as Record<string, unknown>).d;
  const publicKey = await importJWK(publicJwk, 'ES256');
  const configuredKid = (privateJwk as JsonWebKey & { kid?: unknown }).kid;
  const kid = typeof configuredKid === 'string' && configuredKid ? configuredKid : 'merchant-local';

  return {
    issuer: input.issuer,
    async signCheckout(payload) {
      return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setIssuer(input.issuer)
        .setAudience(audience)
        .setIssuedAt(Math.floor(Date.parse(payload.issuedAt) / 1000))
        .setExpirationTime(Math.floor(Date.parse(payload.expiresAt) / 1000))
        .sign(privateKey);
    },
    async verifyCheckout(jwt) {
      try {
        const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
          issuer: input.issuer,
          audience,
          algorithms: ['ES256'],
          clockTolerance: 0,
          typ: 'JWT',
        });
        if (protectedHeader.alg !== 'ES256') throw new Error('Unexpected JWT algorithm');
        if (protectedHeader.typ !== 'JWT') throw new Error('Unexpected JWT typ');
        if (protectedHeader.kid !== kid) throw new Error('Unexpected JWT kid');
        if (payload.iss !== input.issuer) throw new Error('Unexpected JWT iss');
        if (payload.aud !== audience && !(Array.isArray(payload.aud) && payload.aud.includes(audience))) {
          throw new Error('Unexpected JWT aud');
        }
        if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp <= payload.iat) {
          throw new Error('Unexpected JWT iat/exp');
        }
        return payload as unknown as CheckoutSnapshot;
      } catch (error) {
        throw new DomainError(`Checkout JWT verification failed: ${(error as Error).message}`, 'CHECKOUT_JWT');
      }
    },
  };
}
