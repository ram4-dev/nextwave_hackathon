import { exportJWK, generateKeyPair, importJWK } from 'jose';
import { DomainError } from '../domain/state-machine.js';
import { sanitizePublicJwk } from '../crypto/local-agent-key.js';
import type { Repository, SigningKeyPublicRecord } from '../persistence/repository.js';
import { newId } from '../persistence/repository.js';

export interface ActiveSigningKey {
  kid: string;
  publicJwk: JsonWebKey;
  /** In-memory only — never write to repository or store.json. */
  privateJwk: JsonWebKey;
}

/** Process-local private key material keyed by kid. Cleared on process exit. */
const ephemeralPrivateByKid = new Map<string, JsonWebKey>();

const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const;

export function assertPublicJwkOnly(jwk: JsonWebKey, path = 'publicJwk'): void {
  for (const field of PRIVATE_JWK_FIELDS) {
    if (field in jwk && (jwk as Record<string, unknown>)[field] != null) {
      throw new DomainError(
        `Private JWK field "${field}" must not appear at ${path}`,
        'PRIVATE_KEY_PERSISTENCE',
      );
    }
  }
}

export function assertStoreHasNoPrivateKeyMaterial(value: unknown, path = '$'): void {
  if (value == null) return;
  if (typeof value === 'string') {
    // Heuristic: compact JWTs and PEM blobs must not be persisted in the store.
    if (value.startsWith('-----BEGIN') || /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./.test(value)) {
      throw new DomainError(
        `Forbidden raw token/key material at ${path}`,
        'PRIVATE_KEY_PERSISTENCE',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertStoreHasNoPrivateKeyMaterial(v, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        k === 'privateJwk' ||
        k === 'private_key' ||
        k === 'privateKey' ||
        PRIVATE_JWK_FIELDS.includes(k as (typeof PRIVATE_JWK_FIELDS)[number])
      ) {
        throw new DomainError(
          `Forbidden private key field "${k}" at ${path}`,
          'PRIVATE_KEY_PERSISTENCE',
        );
      }
      assertStoreHasNoPrivateKeyMaterial(v, `${path}.${k}`);
    }
  }
}

function publicRecordFrom(
  kid: string,
  publicJwk: JsonWebKey,
): SigningKeyPublicRecord {
  const pub = sanitizePublicJwk({ ...publicJwk }) as JsonWebKey & {
    kid?: string;
    use?: string;
    alg?: string;
  };
  assertPublicJwkOnly(pub);
  pub.kid = kid;
  pub.use = 'sig';
  pub.alg = 'ES256';
  return {
    kid,
    publicJwk: pub,
    createdAt: new Date().toISOString(),
    active: true,
  };
}

/**
 * Resolve the active platform signing key.
 * Always an ephemeral in-memory ES256 keypair — repository stores public metadata only.
 * A process restart rotates the key (demo/hackathon scope; no persisted private material).
 */
export async function ensureSigningKey(repo: Repository): Promise<ActiveSigningKey> {
  const store = await repo.getStore();
  const activePublic = store.signingKeys.find((k) => k.active);

  if (activePublic) {
    assertPublicJwkOnly(activePublic.publicJwk);
    const cached = ephemeralPrivateByKid.get(activePublic.kid);
    if (cached) {
      return {
        kid: activePublic.kid,
        publicJwk: activePublic.publicJwk,
        privateJwk: cached,
      };
    }
    // Private key lost (e.g. process restart) — rotate.
  }

  const { privateKey, publicKey } = await generateKeyPair('ES256', {
    extractable: true,
  });
  const privateJwk = (await exportJWK(privateKey)) as JsonWebKey;
  const publicJwk = sanitizePublicJwk(await exportJWK(publicKey));
  const kid = `kya-${newId('kid').slice(0, 12)}`;
  ephemeralPrivateByKid.set(kid, privateJwk);

  await repo.withLock(async (s) => {
    for (const k of s.signingKeys) k.active = false;
    s.signingKeys = s.signingKeys.map((k) => {
      const { privateJwk: _drop, ...rest } = k as SigningKeyPublicRecord & {
        privateJwk?: unknown;
      };
      void _drop;
      return rest as SigningKeyPublicRecord;
    });
    s.signingKeys.push(publicRecordFrom(kid, publicJwk));
  });

  return {
    kid,
    publicJwk: publicRecordFrom(kid, publicJwk).publicJwk,
    privateJwk,
  };
}

export async function importActivePrivateKey(
  key: ActiveSigningKey,
): Promise<CryptoKey | Uint8Array> {
  return importJWK(key.privateJwk, 'ES256') as Promise<CryptoKey | Uint8Array>;
}

/** Test helper — clear ephemeral vault between cases. */
export function resetEphemeralSigningKeysForTests(): void {
  ephemeralPrivateByKid.clear();
}
