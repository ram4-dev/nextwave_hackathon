import { createHash, randomUUID } from 'node:crypto';
import { decodeProtectedHeader, importJWK, jwtVerify, SignJWT } from 'jose';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { AccessTokenRecord } from '../domain/types.js';
import type { Repository } from '../persistence/repository.js';
import { canAuthorizeAgent } from '../domain/state-machine.js';
import {
  assertPublicEcP256Jwk,
  thumbprintFromJwk,
} from '../crypto/local-agent-key.js';

export const AGENT_ACCESS_TYP = 'KYA-AGENT-ACCESS+JWT';
export const DEFAULT_AGENT_API_AUDIENCE = 'kya-agent-api';
export const ACCESS_TTL_SECONDS = 600;
export const DEFAULT_AGENT_SCOPES = ['agent:me', 'agent:read'] as const;

export type AuthenticatedAgentContext = {
  agentUuid: string;
  thumbprint: string;
  credentialJti: string;
  principalId: string;
  agentRegistry?: string;
  agentId?: string;
  scopes: string[];
  tokenExpiresAt: string;
};

function agentApiAudience(config: AppConfig): string {
  return config.AGENT_API_AUDIENCE ?? DEFAULT_AGENT_API_AUDIENCE;
}

export type AgentAccessTokenInput = {
  agentUuid: string;
  principalId: string;
  thumbprint: string;
  credentialJti: string;
  scopes?: string[];
  agentRegistry?: string;
  agentId?: string;
};

/** Build and sign an access token without mutating repository state. */
export async function buildAgentAccessToken(
  repo: Repository,
  config: AppConfig,
  input: AgentAccessTokenInput,
): Promise<{ token: string; record: AccessTokenRecord }> {
  const { ensureSigningKey, importActivePrivateKey } = await import(
    '../credentials/signer.js'
  );
  const key = await ensureSigningKey(repo, config);
  const privateKey = await importActivePrivateKey(key);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.min(ACCESS_TTL_SECONDS, 600);
  const jti = `atk_${randomUUID().replace(/-/g, '')}`;
  const scopes = [...(input.scopes ?? DEFAULT_AGENT_SCOPES)];
  const aud = agentApiAudience(config);

  const token = await new SignJWT({
    scopes,
    credential_jti: input.credentialJti,
    cnf: { jkt: input.thumbprint },
    ...(input.agentRegistry ? { agentRegistry: input.agentRegistry } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: AGENT_ACCESS_TYP })
    .setIssuer(config.KYA_ISSUER)
    .setAudience(aud)
    .setSubject(input.agentUuid)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(privateKey);

  const record: AccessTokenRecord = {
    jti,
    agentUuid: input.agentUuid,
    principalId: input.principalId,
    credentialJti: input.credentialJti,
    jkt: input.thumbprint,
    scopes,
    status: 'active',
    issuedAt: new Date(now * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
  };

  return { token, record };
}

/** Convenience issuer for callers that do not own a wider atomic transaction. */
export async function issueAgentAccessToken(
  repo: Repository,
  config: AppConfig,
  input: AgentAccessTokenInput,
): Promise<{ token: string; record: AccessTokenRecord }> {
  const issued = await buildAgentAccessToken(repo, config, input);
  await repo.withLock(async (store) => {
    store.accessTokens = store.accessTokens ?? [];
    store.accessTokens.push(issued.record);
  });
  return issued;
}

export async function verifyAgentAccessToken(
  repo: Repository,
  config: AppConfig,
  token: string,
): Promise<{
  payload: Record<string, unknown>;
  record: AccessTokenRecord;
  header: ReturnType<typeof decodeProtectedHeader>;
}> {
  if (token.length < 16 || token.length > 16_384) {
    throw new DomainError('Invalid access token', 'UNAUTHORIZED');
  }
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new DomainError('Invalid access token', 'UNAUTHORIZED');
  }
  if (header.alg !== 'ES256' || header.typ !== AGENT_ACCESS_TYP || !header.kid) {
    throw new DomainError('Invalid access token class', 'UNAUTHORIZED');
  }
  const store = await repo.getStore();
  const keys = (store.signingKeys ?? []).filter((k) => k.kid === header.kid);
  if (keys.length === 0) throw new DomainError('Unknown access key', 'UNAUTHORIZED');

  let payload: Record<string, unknown> | undefined;
  for (const key of keys) {
    try {
      const verified = await jwtVerify(token, await importJWK(key.publicJwk, 'ES256'), {
        issuer: config.KYA_ISSUER,
        audience: agentApiAudience(config),
        algorithms: ['ES256'],
        typ: AGENT_ACCESS_TYP,
        clockTolerance: 5,
      });
      payload = verified.payload as Record<string, unknown>;
      break;
    } catch {
      // try next key
    }
  }
  if (!payload) throw new DomainError('Invalid access token', 'UNAUTHORIZED');

  const jti = String(payload.jti ?? '');
  if (jti.length < 8 || jti.length > 128) {
    throw new DomainError('Invalid access token jti', 'UNAUTHORIZED');
  }
  const record = (store.accessTokens ?? []).find((t) => t.jti === jti);
  if (!record || record.status !== 'active') {
    throw new DomainError('Access token revoked or unknown', 'UNAUTHORIZED');
  }
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    throw new DomainError('Access token expired', 'UNAUTHORIZED');
  }
  const sub = String(payload.sub ?? '');
  if (sub !== record.agentUuid) {
    throw new DomainError('Access token subject mismatch', 'UNAUTHORIZED');
  }
  const credentialJti = String(payload.credential_jti ?? '');
  if (!credentialJti || credentialJti !== record.credentialJti) {
    throw new DomainError('Access token credential mismatch', 'UNAUTHORIZED');
  }
  const cnf = payload.cnf as { jkt?: string } | undefined;
  if (!cnf?.jkt || cnf.jkt !== record.jkt) {
    throw new DomainError('Access token cnf mismatch', 'UNAUTHORIZED');
  }
  const scopes = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];
  if (scopes.length === 0 || JSON.stringify(scopes) !== JSON.stringify(record.scopes)) {
    throw new DomainError('Access token scopes mismatch', 'UNAUTHORIZED');
  }
  const allowedScopes = new Set<string>(DEFAULT_AGENT_SCOPES);
  const seen = new Set<string>();
  for (const scope of scopes) {
    if (typeof scope !== 'string' || !allowedScopes.has(scope) || seen.has(scope)) {
      throw new DomainError('Access token scopes invalid', 'UNAUTHORIZED');
    }
    seen.add(scope);
  }
  const credential = (store.credentials ?? []).find((c) => c.jti === record.credentialJti);
  if (!credential || credential.status !== 'active') {
    throw new DomainError('Access token credential inactive', 'UNAUTHORIZED');
  }
  if (
    credential.agentUuid !== record.agentUuid ||
    credential.principalId !== record.principalId ||
    credential.thumbprint !== record.jkt
  ) {
    throw new DomainError('Access token credential binding mismatch', 'UNAUTHORIZED');
  }
  if (payload.iss !== config.KYA_ISSUER) {
    throw new DomainError('Access token issuer mismatch', 'UNAUTHORIZED');
  }
  const aud = payload.aud;
  const expectedAud = agentApiAudience(config);
  const audOk = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!audOk) {
    throw new DomainError('Access token audience mismatch', 'UNAUTHORIZED');
  }
  return { payload, record, header };
}

export function assertAgentScope(
  ctx: AuthenticatedAgentContext,
  required: string,
): void {
  if (!ctx.scopes.includes(required) && !ctx.scopes.includes('*')) {
    throw new DomainError('Insufficient scope', 'FORBIDDEN');
  }
}

export function assertAgentSubject(
  ctx: AuthenticatedAgentContext,
  routeAgentUuid: string | undefined,
): void {
  if (routeAgentUuid && routeAgentUuid !== ctx.agentUuid) {
    throw new DomainError('Agent subject mismatch', 'FORBIDDEN');
  }
}

export async function resolveAuthenticatedAgentContext(
  repo: Repository,
  config: AppConfig,
  token: string,
): Promise<AuthenticatedAgentContext> {
  const { payload, record } = await verifyAgentAccessToken(repo, config, token);
  const store = await repo.getStore();
  const enrollment = store.enrollments.find((e) => e.agentUuid === record.agentUuid);
  if (!enrollment || enrollment.status !== 'bound') {
    throw new DomainError('Enrollment not bound', 'UNAUTHORIZED');
  }
  try {
    const enrolledJkt = await thumbprintFromJwk(
      assertPublicEcP256Jwk(enrollment.publicJwk),
    );
    if (enrolledJkt !== enrollment.thumbprint || enrolledJkt !== record.jkt) {
      throw new DomainError('Enrollment public key mismatch', 'UNAUTHORIZED');
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('Enrollment public key invalid', 'UNAUTHORIZED');
  }
  if (enrollment.principalId !== record.principalId) {
    throw new DomainError('Enrollment principal mismatch', 'UNAUTHORIZED');
  }
  if (enrollment.thumbprint !== record.jkt) {
    throw new DomainError('Enrollment key changed', 'UNAUTHORIZED');
  }
  const credential = store.credentials.find(
    (c) => c.jti === record.credentialJti && c.status === 'active',
  );
  if (!credential || new Date(credential.expiresAt).getTime() <= Date.now()) {
    throw new DomainError('Credential not active', 'UNAUTHORIZED');
  }
  if (
    credential.agentUuid !== record.agentUuid ||
    credential.principalId !== record.principalId ||
    credential.thumbprint !== record.jkt
  ) {
    throw new DomainError('Credential binding mismatch', 'UNAUTHORIZED');
  }
  if (
    (enrollment.agentRegistry && credential.agentRegistry !== enrollment.agentRegistry) ||
    (enrollment.agentId && credential.agentId !== enrollment.agentId)
  ) {
    throw new DomainError('Credential registry mismatch', 'UNAUTHORIZED');
  }
  const principal = store.principals.find((p) => p.id === record.principalId);
  if (!principal || !canAuthorizeAgent(principal)) {
    throw new DomainError('Principal KYC not active', 'UNAUTHORIZED');
  }
  if (
    enrollment.owner &&
    principal.ownerAddress.toLowerCase() !== enrollment.owner.toLowerCase()
  ) {
    throw new DomainError('Owner binding changed', 'UNAUTHORIZED');
  }
  if (
    credential.owner &&
    principal.ownerAddress.toLowerCase() !== credential.owner.toLowerCase()
  ) {
    throw new DomainError('Credential owner mismatch', 'UNAUTHORIZED');
  }
  const scopes = Array.isArray(payload.scopes)
    ? (payload.scopes as string[])
    : record.scopes;
  return {
    agentUuid: record.agentUuid,
    thumbprint: record.jkt,
    credentialJti: record.credentialJti,
    principalId: record.principalId,
    agentRegistry: enrollment.agentRegistry,
    agentId: enrollment.agentId,
    scopes,
    tokenExpiresAt: record.expiresAt,
  };
}

export function hashDpopJti(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex');
}
