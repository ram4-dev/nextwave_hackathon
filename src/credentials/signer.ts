import { readFile } from 'node:fs/promises';
import { exportJWK, generateKeyPair, importJWK } from 'jose';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import { sanitizePublicJwk, thumbprintFromJwk } from '../crypto/local-agent-key.js';
import type { Repository, SigningKeyPublicRecord } from '../persistence/repository.js';
import { newId } from '../persistence/repository.js';

export interface ActiveSigningKey {
  kid: string;
  publicJwk: JsonWebKey;
  /** In-memory / secret-injected only — never write to repository or store.json. */
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

async function loadLivePrivateJwk(config: AppConfig): Promise<JsonWebKey> {
  let raw: string | undefined;
  if (config.KYA_SIGNING_PRIVATE_JWK) {
    raw = config.KYA_SIGNING_PRIVATE_JWK;
  } else if (config.KYA_SIGNING_KEY_FILE) {
    raw = await readFile(config.KYA_SIGNING_KEY_FILE, 'utf8');
  }
  if (!raw?.trim()) {
    throw new DomainError(
      'Live mode requires KYA_SIGNING_PRIVATE_JWK or KYA_SIGNING_KEY_FILE',
      'SIGNING_KEY_REQUIRED',
    );
  }
  let parsed: JsonWebKey;
  try {
    parsed = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new DomainError('Signing private JWK is not valid JSON', 'SIGNING_KEY_INVALID');
  }
  if (parsed.kty !== 'EC' || parsed.crv !== 'P-256' || typeof parsed.d !== 'string') {
    throw new DomainError(
      'Signing key must be an ES256 (P-256) private JWK',
      'SIGNING_KEY_INVALID',
    );
  }
  // Prove import works before accepting.
  await importJWK(parsed, 'ES256');
  return parsed;
}

/**
 * Resolve the active platform signing key.
 * - Demo: ephemeral in-memory private key; repository stores public metadata only.
 * - Live: fail closed unless private ES256 JWK is injected via env or file handle.
 */
export async function ensureSigningKey(
  repo: Repository,
  config: AppConfig,
): Promise<ActiveSigningKey> {
  const store = await repo.getStore();
  const activePublic = store.signingKeys.find((k) => k.active);

  if (config.KYA_MODE === 'live') {
    const privateJwk = await loadLivePrivateJwk(config);
    const publicJwk = sanitizePublicJwk({ ...privateJwk });
    const publicThumbprint = await thumbprintFromJwk(publicJwk);
    const rawConfiguredKid = (privateJwk as JsonWebKey & { kid?: unknown }).kid;
    if (
      rawConfiguredKid != null &&
      (typeof rawConfiguredKid !== 'string' || rawConfiguredKid.trim() === '')
    ) {
      throw new DomainError('Signing key kid must be a non-empty string', 'SIGNING_KEY_INVALID');
    }
    const kid =
      typeof rawConfiguredKid === 'string'
        ? rawConfiguredKid.trim()
        : `kya-${publicThumbprint}`;

    const recordsWithKid = store.signingKeys.filter((record) => record.kid === kid);
    for (const record of recordsWithKid) {
      const recordThumbprint = await thumbprintFromJwk(record.publicJwk);
      if (recordThumbprint !== publicThumbprint) {
        throw new DomainError(
          `Signing key kid ${kid} conflicts with different public key metadata`,
          'SIGNING_KEY_INVALID',
        );
      }
    }

    const activeMatches =
      activePublic?.kid === kid &&
      (await thumbprintFromJwk(activePublic.publicJwk)) === publicThumbprint;
    const activeCount = store.signingKeys.filter((record) => record.active).length;
    if (!activeMatches || activeCount !== 1 || recordsWithKid.length !== 1) {
      await repo.withLock(async (current) => {
        for (const record of current.signingKeys) record.active = false;
        current.signingKeys = current.signingKeys.filter((record) => record.kid !== kid);
        current.signingKeys.push(publicRecordFrom(kid, publicJwk));
      });
    }

    ephemeralPrivateByKid.set(kid, privateJwk);
    return {
      kid,
      publicJwk: publicRecordFrom(kid, publicJwk).publicJwk,
      privateJwk,
    };
  }

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
    // Demo: public metadata persisted but private lost (e.g. process restart) — rotate.
  }

  // Demo: generate ephemeral ES256 keypair; persist public only.
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
