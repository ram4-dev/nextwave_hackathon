import { readFile } from 'node:fs/promises';
import { CompactSign, compactVerify, importJWK } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import { sanitizePublicJwk, thumbprintFromJwk } from '../crypto/local-agent-key.js';
import type { AgentMandateSigner } from './autonomy.js';

/**
 * Production signer configuration. Inject it from the same secrets/KMS delivery
 * path as KYA, but use a different key and key policy from KYA credentials.
 */
export async function createConfiguredAgentMandateSigner(env: NodeJS.ProcessEnv = process.env): Promise<AgentMandateSigner> {
  const inline = env.MANDATE_SIGNING_PRIVATE_JWK;
  const file = env.MANDATE_SIGNING_KEY_FILE;
  if (Boolean(inline) === Boolean(file)) {
    throw new DomainError('Configure exactly one of MANDATE_SIGNING_PRIVATE_JWK or MANDATE_SIGNING_KEY_FILE', 'AGENT_SIGNER_CONFIG');
  }
  if ((inline && inline === env.KYA_SIGNING_PRIVATE_JWK) || (file && file === env.KYA_SIGNING_KEY_FILE)) {
    throw new DomainError('Mandate signer must use a key distinct from the KYA credential signing key', 'AGENT_SIGNER_KEY_SEPARATION');
  }
  const raw = inline ?? await readFile(file!, 'utf8');
  let privateJwk: JsonWebKey;
  try { privateJwk = JSON.parse(raw) as JsonWebKey; } catch { throw new DomainError('Mandate signing JWK is not valid JSON', 'AGENT_SIGNER_KEY'); }
  if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || typeof privateJwk.d !== 'string') {
    throw new DomainError('Mandate signing key must be an ES256 (P-256) private JWK', 'AGENT_SIGNER_KEY');
  }
  let privateKey: CryptoKey | Uint8Array;
  try {
    privateKey = await importJWK(privateJwk, 'ES256');
  } catch {
    throw new DomainError('Mandate signing JWK cannot be imported as ES256', 'AGENT_SIGNER_KEY');
  }
  const publicKeyJwk = sanitizePublicJwk({ ...privateJwk });
  const configuredKid = (privateJwk as JsonWebKey & { kid?: unknown }).kid;
  const keyId = typeof configuredKid === 'string' && configuredKid.trim()
    ? configuredKid.trim()
    : `mandate-${await thumbprintFromJwk(publicKeyJwk)}`;

  return {
    keyId,
    publicKeyJwk,
    async sign(payload) {
      return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
        .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
        .sign(privateKey);
    },
    async verify(jws) {
      const verified = await compactVerify(jws, await importJWK(publicKeyJwk, 'ES256'));
      return JSON.parse(new TextDecoder().decode(verified.payload)) as Record<string, unknown>;
    },
  };
}
