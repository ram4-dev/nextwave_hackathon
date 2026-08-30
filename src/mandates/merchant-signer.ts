import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import type { CheckoutSnapshot, MerchantSigner } from './types.js';

const audience = 'ap2.checkout';

export async function createLocalMerchantSigner(input: {
  privateJwk?: JsonWebKey;
  issuer: string;
  nodeEnv?: string;
}): Promise<MerchantSigner> {
  if (input.nodeEnv === 'production') {
    throw new DomainError('Local merchant signer is unavailable in production', 'MERCHANT_SIGNER_ENV');
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
      return new SignJWT(payload)
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
          issuer: input.issuer, audience, algorithms: ['ES256'], clockTolerance: 0,
        });
        if (protectedHeader.alg !== 'ES256') throw new Error('Unexpected JWT algorithm');
        return payload as unknown as CheckoutSnapshot;
      } catch (error) {
        throw new DomainError(`Checkout JWT verification failed: ${(error as Error).message}`, 'CHECKOUT_JWT');
      }
    },
  };
}
