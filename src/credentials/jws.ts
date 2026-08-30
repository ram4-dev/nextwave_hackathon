import * as jose from 'jose';
import { importJWK } from 'jose';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { CredentialStatus, KyaCredentialRecord } from '../domain/types.js';
import type { Repository } from '../persistence/repository.js';
import { newId } from '../persistence/repository.js';
import { sanitizePublicJwk } from '../crypto/local-agent-key.js';
import {
  assertPublicJwkOnly,
  ensureSigningKey,
  importActivePrivateKey,
} from './signer.js';

export interface CredentialClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  principal_id: string;
  agentRegistry: string;
  agentId: string;
  owner: string;
  status: string;
  status_ref: string;
  cnf: { jkt: string };
}

const ALLOWED_ALGS = new Set(['ES256']);

export { ensureSigningKey } from './signer.js';
export {
  assertStoreHasNoPrivateKeyMaterial,
  resetEphemeralSigningKeysForTests,
} from './signer.js';

export async function getJwks(repo: Repository): Promise<{ keys: JsonWebKey[] }> {
  const store = await repo.getStore();
  const seenKids = new Set<string>();
  const uniqueKeys = [...store.signingKeys]
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
    .filter((key) => {
      if (seenKids.has(key.kid)) return false;
      seenKids.add(key.kid);
      return true;
    });
  return {
    keys: uniqueKeys.map((k) => {
      const pub = sanitizePublicJwk({ ...k.publicJwk }) as JsonWebKey & {
        kid?: string;
        use?: string;
        alg?: string;
      };
      assertPublicJwkOnly(pub);
      pub.kid = k.kid;
      pub.use = 'sig';
      pub.alg = 'ES256';
      return pub;
    }),
  };
}

export async function issueKyaCredential(
  repo: Repository,
  config: AppConfig,
  input: {
    agentUuid: string;
    principalId: string;
    thumbprint: string;
    agentRegistry: string;
    agentId: string;
    owner: `0x${string}`;
  },
): Promise<{ token: string; record: KyaCredentialRecord }> {
  const now = Math.floor(Date.now() / 1000);
  const jti = newId('cred');
  const exp = now + config.CREDENTIAL_TTL_SECONDS;
  const statusRef = `${config.PUBLIC_BASE_URL}/v1/credentials/${jti}/status`;

  const claims: CredentialClaims = {
    iss: config.KYA_ISSUER,
    aud: config.KYA_AUDIENCE,
    sub: input.agentUuid,
    iat: now,
    nbf: now,
    exp,
    jti,
    principal_id: input.principalId,
    agentRegistry: input.agentRegistry,
    agentId: input.agentId,
    owner: input.owner,
    status: 'active',
    status_ref: statusRef,
    cnf: { jkt: input.thumbprint },
  };

  assertNoPiiInClaims(claims);

  const token = await signCredentialClaims(repo, config, claims);

  const record: KyaCredentialRecord = {
    id: jti,
    agentUuid: input.agentUuid,
    principalId: input.principalId,
    thumbprint: input.thumbprint,
    agentRegistry: input.agentRegistry,
    agentId: input.agentId,
    owner: input.owner,
    status: 'active',
    statusRef,
    issuedAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
    jti,
  };

  await repo.withLock(async (store) => {
    for (const c of store.credentials) {
      if (c.agentUuid === input.agentUuid && c.status === 'active') {
        c.status = 'revoked';
      }
    }
    // Metadata only — never persist the JWT string or private key material.
    store.credentials.push(record);
  });

  return { token, record };
}

/** Re-sign existing active credential claims without mutating credential state. */
export async function reissueActiveKyaCredential(
  repo: Repository,
  config: AppConfig,
  record: KyaCredentialRecord,
): Promise<string> {
  const issuedAt = Math.floor(Date.parse(record.issuedAt) / 1000);
  const expiresAt = Math.floor(Date.parse(record.expiresAt) / 1000);
  if (record.status !== 'active' || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new DomainError('Credential is not active', 'JWT_STATUS');
  }
  const claims: CredentialClaims = {
    iss: config.KYA_ISSUER,
    aud: config.KYA_AUDIENCE,
    sub: record.agentUuid,
    iat: issuedAt,
    nbf: issuedAt,
    exp: expiresAt,
    jti: record.jti,
    principal_id: record.principalId,
    agentRegistry: record.agentRegistry,
    agentId: record.agentId,
    owner: record.owner,
    status: 'active',
    status_ref: record.statusRef,
    cnf: { jkt: record.thumbprint },
  };
  return signCredentialClaims(repo, config, claims);
}

async function signCredentialClaims(
  repo: Repository,
  config: AppConfig,
  claims: CredentialClaims,
): Promise<string> {
  assertNoPiiInClaims(claims);
  const key = await ensureSigningKey(repo, config);
  const privateKey = await importActivePrivateKey(key);
  return new jose.SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'KYA-CREDENTIAL+JWT' })
    .sign(privateKey);
}

export async function verifyKyaCredential(
  repo: Repository,
  config: AppConfig,
  token: string,
  opts?: { expectAudience?: string },
): Promise<CredentialClaims> {
  if (token.length < 16 || token.length > 16_384) {
    throw new DomainError('Invalid credential token', 'JWT_VERIFY');
  }
  const header = jose.decodeProtectedHeader(token);
  if (!header.alg || !ALLOWED_ALGS.has(header.alg) || header.alg !== 'ES256') {
    throw new DomainError('Disallowed JWT algorithm', 'JWT_ALG');
  }
  if (header.typ !== 'KYA-CREDENTIAL+JWT') {
    throw new DomainError('Invalid credential typ', 'JWT_TYP');
  }
  if (!header.kid) {
    throw new DomainError('Missing signing kid', 'JWT_KID');
  }

  const store = await repo.getStore();
  const kid = header.kid;
  const keyRecords = store.signingKeys
    .filter((key) => key.kid === kid)
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  if (keyRecords.length === 0) {
    throw new DomainError('Unknown signing key', 'JWT_KID');
  }
  let verifiedPayload: jose.JWTPayload | undefined;
  let lastError: unknown;
  for (const keyRecord of keyRecords) {
    assertPublicJwkOnly(keyRecord.publicJwk);
    try {
      const publicKey = await importJWK(
        sanitizePublicJwk({ ...keyRecord.publicJwk }),
        'ES256',
      );
      verifiedPayload = (
        await jose.jwtVerify(token, publicKey, {
          issuer: config.KYA_ISSUER,
          audience: opts?.expectAudience ?? config.KYA_AUDIENCE,
          algorithms: ['ES256'],
          typ: 'KYA-CREDENTIAL+JWT',
          clockTolerance: 5,
        })
      ).payload;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!verifiedPayload) {
    throw new DomainError(
      `JWT verification failed: ${(lastError as Error | undefined)?.message ?? 'invalid signature'}`,
      'JWT_VERIFY',
    );
  }
  const payload = verifiedPayload;

  const jti = String(payload.jti ?? '');
  const record = store.credentials.find((c) => c.jti === jti);
  if (!record) {
    throw new DomainError('Unknown credential id', 'JWT_STATUS');
  }
  if (record.status === 'revoked') {
    throw new DomainError('Credential revoked', 'JWT_REVOKED');
  }
  if (record.status === 'suspended') {
    throw new DomainError('Credential suspended', 'JWT_SUSPENDED');
  }
  if (record.status === 'expired' || new Date(record.expiresAt).getTime() <= Date.now()) {
    throw new DomainError('Credential expired', 'JWT_EXPIRED');
  }
  if (String(payload.sub ?? '') !== record.agentUuid) {
    throw new DomainError('Credential subject mismatch', 'JWT_STATUS');
  }
  if (String(payload.principal_id ?? '') !== record.principalId) {
    throw new DomainError('Credential principal mismatch', 'JWT_STATUS');
  }
  const cnf = payload.cnf as { jkt?: string } | undefined;
  if (!cnf?.jkt || cnf.jkt !== record.thumbprint) {
    throw new DomainError('Credential cnf mismatch', 'JWT_STATUS');
  }
  if (String(payload.agentRegistry ?? '') !== record.agentRegistry) {
    throw new DomainError('Credential registry mismatch', 'JWT_STATUS');
  }
  if (String(payload.agentId ?? '') !== record.agentId) {
    throw new DomainError('Credential agentId mismatch', 'JWT_STATUS');
  }
  if (String(payload.owner ?? '').toLowerCase() !== record.owner.toLowerCase()) {
    throw new DomainError('Credential owner mismatch', 'JWT_STATUS');
  }
  if (String(payload.status ?? '') !== record.status) {
    throw new DomainError('Credential status claim mismatch', 'JWT_STATUS');
  }
  if (String(payload.status_ref ?? '') !== record.statusRef) {
    throw new DomainError('Credential status_ref mismatch', 'JWT_STATUS');
  }

  return payload as unknown as CredentialClaims;
}

export async function setCredentialStatus(
  repo: Repository,
  jti: string,
  status: CredentialStatus,
): Promise<KyaCredentialRecord> {
  return repo.withLock(async (store) => {
    const record = store.credentials.find((c) => c.jti === jti);
    if (!record) throw new DomainError('Credential not found', 'NOT_FOUND');
    record.status = status;
    return record;
  });
}

function assertNoPiiInClaims(claims: CredentialClaims): void {
  const json = JSON.stringify(claims).toLowerCase();
  for (const banned of [
    'selfie',
    'biometric',
    'passport',
    'date_of_birth',
    'first_name',
    'last_name',
    'email',
    'phone',
  ]) {
    if (json.includes(`"${banned}"`)) {
      throw new DomainError(`Forbidden PII claim: ${banned}`, 'PII_FORBIDDEN');
    }
  }
}
