import { createHash } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  importJWK,
} from 'jose';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';
import {
  assertAgentScope,
  assertAgentSubject,
  hashDpopJti,
  resolveAuthenticatedAgentContext,
  type AuthenticatedAgentContext,
} from './agent-access.js';
import { assertPublicEcP256Jwk, sanitizePublicJwk } from '../crypto/local-agent-key.js';

export type { AuthenticatedAgentContext };
export { assertAgentScope, assertAgentSubject };

export type AgentAuthVariables = {
  agent: AuthenticatedAgentContext;
};

export type OwnerOfReaderHook = (input: {
  agentRegistry?: string;
  agentId?: string;
  enrollmentOwner?: `0x${string}`;
  principalOwner: `0x${string}`;
}) => Promise<`0x${string}`>;

const DPOP_IAT_SKEW_SECONDS = 300;
const MAX_ACCESS_TOKEN_CHARS = 16_384;
const MAX_DPOP_PROOF_CHARS = 16_384;
const MAX_DPOP_JTI_CHARS = 128;
const MIN_DPOP_JTI_CHARS = 8;

export function computeAth(accessToken: string): string {
  return createHash('sha256').update(accessToken, 'utf8').digest('base64url');
}

export function canonicalHtu(publicBaseUrl: string, pathWithOptionalQuery: string): string {
  const base = new URL(publicBaseUrl);
  const pathOnly = pathWithOptionalQuery.split('?')[0]?.split('#')[0] ?? '/';
  const normalizedPath = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  return `${base.origin}${normalizedPath}`;
}

export async function consumeDpopReplay(
  repo: Repository,
  jti: string,
  expiresAt: string,
): Promise<void> {
  if (!repo.consumeDpopReplayAtomic) {
    throw new DomainError('DPoP replay store unavailable', 'UNAVAILABLE');
  }
  const jtiHash = hashDpopJti(jti);
  const result = await repo.consumeDpopReplayAtomic(jtiHash, expiresAt);
  if (result === 'replay') {
    throw new DomainError('DPoP proof replay', 'UNAUTHORIZED');
  }
}

async function validateDpopProof(input: {
  proof: string;
  accessToken: string;
  method: string;
  htu: string;
  expectedJkt: string;
}): Promise<{ jti: string; iat: number }> {
  if (input.proof.length > MAX_DPOP_PROOF_CHARS) {
    throw new DomainError('DPoP proof too large', 'UNAUTHORIZED');
  }
  const header = decodeProtectedHeader(input.proof);
  if (header.typ !== 'dpop+jwt') {
    throw new DomainError('Invalid DPoP typ', 'UNAUTHORIZED');
  }
  if (header.alg !== 'ES256') {
    throw new DomainError('Invalid DPoP alg', 'UNAUTHORIZED');
  }
  const jwk = header.jwk as JsonWebKey | undefined;
  if (!jwk || typeof jwk !== 'object') {
    throw new DomainError('DPoP missing jwk', 'UNAUTHORIZED');
  }
  try {
    assertPublicEcP256Jwk(jwk);
  } catch {
    throw new DomainError('DPoP jwk must be public P-256', 'UNAUTHORIZED');
  }
  const publicJwk = sanitizePublicJwk({ ...jwk });
  const jkt = await calculateJwkThumbprint(publicJwk, 'sha256');
  if (jkt !== input.expectedJkt) {
    throw new DomainError('DPoP key mismatch', 'UNAUTHORIZED');
  }

  let payloadBytes: Uint8Array;
  try {
    const key = await importJWK(publicJwk, 'ES256');
    const verified = await compactVerify(input.proof, key);
    payloadBytes = verified.payload;
  } catch {
    throw new DomainError('Invalid DPoP signature', 'UNAUTHORIZED');
  }

  let payload: {
    htm?: string;
    htu?: string;
    iat?: number;
    jti?: string;
    ath?: string;
  };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new DomainError('Invalid DPoP payload', 'UNAUTHORIZED');
  }

  if (typeof payload.htm !== 'string' || payload.htm.toUpperCase() !== input.method.toUpperCase()) {
    throw new DomainError('DPoP htm mismatch', 'UNAUTHORIZED');
  }
  if (typeof payload.htu !== 'string' || payload.htu !== input.htu) {
    throw new DomainError('DPoP htu mismatch', 'UNAUTHORIZED');
  }
  if (typeof payload.iat !== 'number') {
    throw new DomainError('DPoP iat missing', 'UNAUTHORIZED');
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - payload.iat) > DPOP_IAT_SKEW_SECONDS) {
    throw new DomainError('DPoP iat out of window', 'UNAUTHORIZED');
  }
  if (
    typeof payload.jti !== 'string' ||
    payload.jti.length < MIN_DPOP_JTI_CHARS ||
    payload.jti.length > MAX_DPOP_JTI_CHARS
  ) {
    throw new DomainError('DPoP jti invalid', 'UNAUTHORIZED');
  }
  const expectedAth = computeAth(input.accessToken);
  if (payload.ath !== expectedAth) {
    throw new DomainError('DPoP ath mismatch', 'UNAUTHORIZED');
  }
  return { jti: payload.jti, iat: payload.iat };
}

function httpStatusForDomain(code: string): 401 | 403 | 429 | 503 {
  if (code === 'UNAVAILABLE' || code === 'CAS_CONFLICT') return 503;
  if (code === 'RATE_LIMIT') return 429;
  if (code === 'FORBIDDEN' || code === 'OWNER_MISMATCH') return 403;
  return 401;
}

export function createRequireAgentAuth(
  repo: Repository,
  config: AppConfig,
  opts?: {
    readOwnerOf?: OwnerOfReaderHook;
    /** When true (live), missing ownerOf authority or registry IDs fail closed. */
    requireLiveOwnerOf?: boolean;
  },
) {
  return createMiddleware<{ Variables: AgentAuthVariables }>(async (c, next) => {
    if (config.PERSISTENCE_BACKEND === 'supabase' && !config.SUPABASE_URL) {
      return c.json({ error: 'Persistence unavailable', code: 'UNAVAILABLE' }, 503);
    }

    const auth = c.req.header('authorization');
    if (!auth) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    if (auth.toLowerCase().startsWith('bearer ')) {
      return c.json({ error: 'Bearer not accepted', code: 'UNAUTHORIZED' }, 401);
    }
    if (!auth.startsWith('DPoP ')) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    const accessToken = auth.slice('DPoP '.length).trim();
    if (accessToken.length < 16 || accessToken.length > MAX_ACCESS_TOKEN_CHARS) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    const proof = c.req.header('dpop');
    if (!proof) {
      return c.json({ error: 'DPoP proof required', code: 'UNAUTHORIZED' }, 401);
    }
    if (proof.length > MAX_DPOP_PROOF_CHARS) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }

    try {
      // 1) Access token + enrollment/credential context
      const ctx = await resolveAuthenticatedAgentContext(repo, config, accessToken);

      // 2) Cryptographic DPoP validation (htm/htu/ath/sig) BEFORE ownerOf — no amplify
      const htu = canonicalHtu(config.PUBLIC_BASE_URL, c.req.path);
      const { jti, iat } = await validateDpopProof({
        proof,
        accessToken,
        method: c.req.method,
        htu,
        expectedJkt: ctx.thumbprint,
      });

      // 3) Live ownerOf (after proof validates; fail closed in live)
      const requireOwner = opts?.requireLiveOwnerOf ?? config.KYA_MODE === 'live';
      if (requireOwner || opts?.readOwnerOf) {
        if (!opts?.readOwnerOf) {
          throw new DomainError('Owner authority unavailable', 'UNAVAILABLE');
        }
        if (!ctx.agentId || !ctx.agentRegistry) {
          throw new DomainError('Registry binding required', 'UNAUTHORIZED');
        }
        const store = await repo.getStore();
        const enrollment = store.enrollments.find((e) => e.agentUuid === ctx.agentUuid);
        const principal = store.principals.find((p) => p.id === ctx.principalId);
        if (!principal) throw new DomainError('Principal missing', 'UNAUTHORIZED');
        let onChain: `0x${string}`;
        try {
          onChain = await opts.readOwnerOf({
            agentRegistry: ctx.agentRegistry,
            agentId: ctx.agentId,
            enrollmentOwner: enrollment?.owner,
            principalOwner: principal.ownerAddress,
          });
        } catch (err) {
          if (err instanceof DomainError) throw err;
          throw new DomainError('Owner authority unavailable', 'UNAVAILABLE');
        }
        if (onChain.toLowerCase() !== principal.ownerAddress.toLowerCase()) {
          throw new DomainError('On-chain owner mismatch', 'OWNER_MISMATCH');
        }
      }

      // 4) Atomic replay consume only after crypto + owner checks
      const replayExpires = new Date((iat + DPOP_IAT_SKEW_SECONDS + 60) * 1000).toISOString();
      await consumeDpopReplay(repo, jti, replayExpires);

      const routeAgent = c.req.param('agentUuid');
      assertAgentSubject(ctx, routeAgent);

      c.set('agent', ctx);
      await next();
    } catch (err) {
      if (err instanceof DomainError) {
        const status = httpStatusForDomain(err.code);
        const message =
          status === 503 ? 'Dependency unavailable' : err.message;
        return c.json({ error: message, code: err.code === 'CAS_CONFLICT' ? 'UNAVAILABLE' : err.code }, status);
      }
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
  });
}
