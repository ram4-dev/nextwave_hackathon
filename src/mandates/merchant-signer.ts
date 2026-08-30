import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import type { CheckoutSnapshot, MerchantSigner } from './types.js';

const audience = 'ap2.checkout';
const allowedLocalEnvs = new Set(['development', 'test']);

function resolveNodeEnv(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  return process.env.NODE_ENV ?? '';
}

export async function createLocalMerchantSigner(input: {
  privateJwk?: JsonWebKey;
  issuer: string;
  /** Explicit environment override. When omitted, process.env.NODE_ENV must be set to development/test. */
  nodeEnv?: string;
}): Promise<MerchantSigner> {
  const nodeEnv = resolveNodeEnv(input.nodeEnv);
  if (!allowedLocalEnvs.has(nodeEnv)) {
    throw new DomainError(
      'Local merchant signer requires an explicit development/test environment (nodeEnv or NODE_ENV)',
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
      const iat = Math.floor(Date.parse(payload.issuedAt) / 1000);
      const exp = Math.floor(Date.parse(payload.expiresAt) / 1000);
      if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) {
        throw new DomainError('Checkout issuedAt/expiresAt produce invalid JWT iat/exp', 'CHECKOUT_JWT');
      }
      return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
        .setIssuer(input.issuer)
        .setAudience(audience)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
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
        const snapshot = payload as unknown as CheckoutSnapshot;
        if (typeof snapshot.issuedAt !== 'string' || typeof snapshot.expiresAt !== 'string') {
          throw new Error('Checkout issuedAt/expiresAt missing');
        }
        const expectedIat = Math.floor(Date.parse(snapshot.issuedAt) / 1000);
        const expectedExp = Math.floor(Date.parse(snapshot.expiresAt) / 1000);
        if (payload.iat !== expectedIat || payload.exp !== expectedExp) {
          throw new Error('JWT iat/exp diverge from checkout issuedAt/expiresAt');
        }
        if (expectedExp * 1000 <= Date.now()) throw new Error('Checkout JWT expired by schema timestamps');
        return snapshot;
      } catch (error) {
        throw new DomainError(`Checkout JWT verification failed: ${(error as Error).message}`, 'CHECKOUT_JWT');
      }
    },
  };
}
