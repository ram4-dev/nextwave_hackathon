import { getAddress } from 'viem';
import type { AppConfig } from '../config/env.js';
import { IDENTITY_REGISTRY_SEPOLIA } from '../config/env.js';
import {
  applyKycStatus,
  canAuthorizeAgent,
  DomainError,
  needsKyc,
  transitionEnrollment,
} from '../domain/state-machine.js';
import type {
  AgentEnrollment,
  KeystoreProviderKind,
  Principal,
} from '../domain/types.js';
import {
  fingerprintDisplay,
  generateDeviceCode,
  intentHash,
  sanitizePublicJwk,
  thumbprintFromJwk,
  verifyChallengeSignature,
} from '../crypto/local-agent-key.js';
import { issueKyaCredential } from '../credentials/jws.js';
import { newId, type Repository } from '../persistence/repository.js';

/** Display-only mock chain reference — no on-chain reads/writes in this build. */
const MOCK_CHAIN_ID = 84532;

function mockAgentRegistryRef(): string {
  return `eip155:${MOCK_CHAIN_ID}:${IDENTITY_REGISTRY_SEPOLIA}`;
}

/** Cosmetic ERC-8004-shaped token id — no real mint. */
function mockAgentId(): string {
  return String(8000 + Math.floor(Math.random() * 999));
}

export class CeremonyService {
  constructor(
    private readonly repo: Repository,
    private readonly config: AppConfig,
  ) {}

  async findOrCreatePrincipal(ownerAddress: `0x${string}`): Promise<Principal> {
    return this.repo.withLock(async (store) => {
      const existing = store.principals.find(
        (p) => p.ownerAddress.toLowerCase() === ownerAddress.toLowerCase(),
      );
      if (existing) return existing;
      const principal: Principal = {
        id: newId('prin'),
        ownerAddress: ownerAddress.toLowerCase() as `0x${string}`,
        kycStatus: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.principals.push(principal);
      return principal;
    });
  }

  async startEnrollment(input: {
    publicJwk: JsonWebKey;
    keystoreProvider: KeystoreProviderKind;
  }): Promise<{
    agentUuid: string;
    deviceCode: string;
    thumbprint: string;
    fingerprintDisplay: string;
  }> {
    const publicJwk = sanitizePublicJwk({ ...input.publicJwk });
    if ((publicJwk as Record<string, unknown>).d) {
      throw new DomainError('Private key material rejected', 'PII_FORBIDDEN');
    }
    const thumbprint = await thumbprintFromJwk(publicJwk);
    const agentUuid = newId('agent');
    const deviceCode = generateDeviceCode();
    const enrollment: AgentEnrollment = {
      agentUuid,
      deviceCode,
      status: 'awaiting_human',
      publicJwk,
      thumbprint,
      keystoreProvider: input.keystoreProvider,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.repo.withLock(async (store) => {
      store.enrollments.push(enrollment);
    });
    return {
      agentUuid,
      deviceCode,
      thumbprint,
      fingerprintDisplay: fingerprintDisplay(thumbprint),
    };
  }

  async getEnrollmentAuthorized(
    agentUuid: string,
    ownerAddress: `0x${string}`,
  ): Promise<AgentEnrollment> {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
    const principal = enrollment.principalId
      ? store.principals.find((p) => p.id === enrollment.principalId)
      : undefined;
    const isOwner =
      (principal &&
        principal.ownerAddress.toLowerCase() === ownerAddress.toLowerCase()) ||
      (enrollment.owner &&
        enrollment.owner.toLowerCase() === ownerAddress.toLowerCase());
    if (!isOwner) {
      throw new DomainError('Forbidden', 'FORBIDDEN');
    }
    return enrollment;
  }

  /** Public resolver — no PII, principalId, or deviceCode. */
  async resolvePublic(query: {
    agentUuid?: string;
    agentRegistry?: string;
    agentId?: string;
  }): Promise<{
    agentUuid?: string;
    status: string;
    agentRegistry?: string;
    agentId?: string;
    owner?: string;
    thumbprint?: string;
    active: boolean;
  }> {
    const store = await this.repo.getStore();
    let enrollment: AgentEnrollment | undefined;
    if (query.agentUuid) {
      enrollment = store.enrollments.find((e) => e.agentUuid === query.agentUuid);
    } else if (query.agentRegistry && query.agentId) {
      enrollment = store.enrollments.find(
        (e) =>
          e.agentRegistry?.toLowerCase() === query.agentRegistry!.toLowerCase() &&
          e.agentId === query.agentId,
      );
    }
    if (!enrollment) throw new DomainError('Not found', 'NOT_FOUND');
    return {
      agentUuid: enrollment.agentUuid,
      status: enrollment.status,
      agentRegistry: enrollment.agentRegistry,
      agentId: enrollment.agentId,
      owner: enrollment.owner,
      thumbprint: enrollment.thumbprint,
      active: enrollment.status === 'bound',
    };
  }

  async attachHuman(
    agentUuid: string,
    ownerAddress: `0x${string}`,
  ): Promise<{
    enrollment: AgentEnrollment;
    principal: Principal;
    needsKyc: boolean;
  }> {
    const principal = await this.findOrCreatePrincipal(ownerAddress);
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Enrollment not found', 'NOT_FOUND');
      let enrollment = store.enrollments[idx]!;
      const attachable = new Set([
        'awaiting_human',
        'awaiting_kyc',
        'awaiting_fingerprint',
      ]);
      if (!attachable.has(enrollment.status)) {
        throw new DomainError('Enrollment not awaiting human', 'INVALID_TRANSITION');
      }
      enrollment = {
        ...enrollment,
        principalId: principal.id,
        updatedAt: new Date().toISOString(),
      };
      const kycNeeded = needsKyc(principal);
      if (enrollment.status === 'awaiting_human' || enrollment.status === 'awaiting_kyc') {
        const target = kycNeeded ? 'awaiting_kyc' : 'awaiting_fingerprint';
        if (enrollment.status !== target) {
          enrollment = transitionEnrollment(enrollment, target);
        } else {
          enrollment = { ...enrollment, updatedAt: new Date().toISOString() };
        }
      }
      store.enrollments[idx] = enrollment;
      return { enrollment, principal, needsKyc: kycNeeded };
    });
  }

  /** Mocked KYC: instantly verifies the Principal. No external provider in this build. */
  async completeKyc(ownerAddress: `0x${string}`): Promise<{ principal: Principal }> {
    const principal = await this.findOrCreatePrincipal(ownerAddress);
    if (!needsKyc(principal)) {
      throw new DomainError('Active KYC already present', 'KYC_NOT_NEEDED');
    }
    return this.repo.withLock(async (store) => {
      const idx = store.principals.findIndex((p) => p.id === principal.id);
      const updated = applyKycStatus(store.principals[idx]!, 'verified', {
        ttlDays: this.config.KYC_TTL_DAYS,
      });
      store.principals[idx] = updated;
      for (let i = 0; i < store.enrollments.length; i++) {
        const e = store.enrollments[i]!;
        if (e.principalId === principal.id && e.status === 'awaiting_kyc') {
          store.enrollments[i] = transitionEnrollment(e, 'awaiting_fingerprint');
        }
      }
      return { principal: updated };
    });
  }

  async approveFingerprint(
    agentUuid: string,
    ownerAddress: `0x${string}`,
    expectedThumbprint: string,
  ): Promise<AgentEnrollment> {
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Enrollment not found', 'NOT_FOUND');
      let enrollment = store.enrollments[idx]!;
      if (enrollment.thumbprint !== expectedThumbprint) {
        throw new DomainError('Fingerprint mismatch', 'FINGERPRINT');
      }
      const principal = store.principals.find((p) => p.id === enrollment.principalId);
      if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        throw new DomainError('Principal mismatch', 'FORBIDDEN');
      }
      if (!canAuthorizeAgent(principal)) {
        throw new DomainError('Principal KYC not active', 'KYC_REQUIRED');
      }
      if (enrollment.status !== 'awaiting_fingerprint') {
        throw new DomainError('Not awaiting fingerprint', 'INVALID_TRANSITION');
      }
      enrollment = transitionEnrollment(enrollment, 'awaiting_register', {
        fingerprintApprovedAt: new Date().toISOString(),
      });
      store.enrollments[idx] = enrollment;
      return enrollment;
    });
  }

  /**
   * Instant mock bind: assigns a display-plausible agentId/agentRegistry (no on-chain
   * write) and issues the real KYA credential (genuine ES256 JWS, cnf.jkt-bound).
   */
  async bindAgent(
    agentUuid: string,
    ownerAddress: `0x${string}`,
  ): Promise<{ token: string; agentId: string; agentRegistry: string }> {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment) throw new DomainError('Enrollment not found', 'NOT_FOUND');
    if (enrollment.status !== 'awaiting_register') {
      throw new DomainError('Enrollment not ready to bind', 'INVALID_TRANSITION');
    }
    const principal = store.principals.find((p) => p.id === enrollment.principalId);
    if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new DomainError('Principal mismatch', 'FORBIDDEN');
    }

    const agentId = mockAgentId();
    const agentRegistry = mockAgentRegistryRef();
    const owner = getAddress(ownerAddress);

    await this.repo.withLock(async (s) => {
      const idx = s.enrollments.findIndex((x) => x.agentUuid === agentUuid);
      const e = s.enrollments[idx]!;
      s.enrollments[idx] = transitionEnrollment(e, 'bound', {
        agentId,
        agentRegistry,
        owner,
      });
    });

    const { token } = await issueKyaCredential(this.repo, this.config, {
      agentUuid,
      principalId: principal.id,
      thumbprint: enrollment.thumbprint,
      agentRegistry,
      agentId,
      owner,
    });

    return { token, agentId, agentRegistry };
  }

  async createChallenge(agentUuid: string, intent: unknown) {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment || enrollment.status !== 'bound') {
      throw new DomainError('Agent not bound', 'NOT_BOUND');
    }
    const nonce = newId('chal').replace('chal_', '');
    const timestamp = new Date().toISOString();
    const intent_hash = intentHash(intent);
    const expiresAt = new Date(
      Date.now() + this.config.CHALLENGE_TTL_SECONDS * 1000,
    ).toISOString();
    await this.repo.withLock(async (s) => {
      s.nonces.push({
        nonce,
        purpose: 'challenge',
        createdAt: new Date().toISOString(),
        expiresAt,
        audience: this.config.KYA_AUDIENCE,
        agentUuid,
        intentHash: intent_hash,
        challengeTimestamp: timestamp,
      });
    });
    return {
      nonce,
      audience: this.config.KYA_AUDIENCE,
      timestamp,
      intent_hash,
      expiresAt,
    };
  }

  async verifyChallenge(
    agentUuid: string,
    response: {
      nonce: string;
      audience: string;
      timestamp: string;
      intent_hash: string;
      signature: string;
    },
  ) {
    const store = await this.repo.getStore();
    const enrollment = store.enrollments.find((e) => e.agentUuid === agentUuid);
    if (!enrollment || enrollment.status !== 'bound') {
      throw new DomainError('Agent not bound', 'NOT_BOUND');
    }

    const activeCred = store.credentials.find(
      (c) => c.agentUuid === agentUuid && c.status === 'active',
    );
    if (!activeCred) throw new DomainError('No active credential', 'JWT_STATUS');

    const nonceRecord = store.nonces.find(
      (x) => x.nonce === response.nonce && x.purpose === 'challenge',
    );
    if (!nonceRecord) throw new DomainError('Unknown challenge nonce', 'CHALLENGE');
    if (nonceRecord.consumedAt) {
      throw new DomainError('Challenge replay', 'CHALLENGE_REPLAY');
    }
    if (new Date(nonceRecord.expiresAt).getTime() <= Date.now()) {
      throw new DomainError('Challenge expired', 'CHALLENGE_EXPIRED');
    }
    if (nonceRecord.agentUuid !== agentUuid) {
      throw new DomainError('Challenge agent mismatch', 'CHALLENGE');
    }

    const storedAudience = nonceRecord.audience;
    const storedIntent = nonceRecord.intentHash;
    const storedTimestamp = nonceRecord.challengeTimestamp;
    if (!storedAudience || !storedIntent || !storedTimestamp) {
      throw new DomainError('Challenge missing bound fields', 'CHALLENGE');
    }
    if (storedAudience !== this.config.KYA_AUDIENCE) {
      throw new DomainError('Challenge audience config mismatch', 'CHALLENGE_AUDIENCE');
    }
    if (response.audience !== storedAudience) {
      throw new DomainError('Challenge audience mismatch', 'CHALLENGE_AUDIENCE');
    }
    if (response.intent_hash !== storedIntent) {
      throw new DomainError('Challenge intent_hash mismatch', 'CHALLENGE_INTENT');
    }
    if (response.timestamp !== storedTimestamp) {
      throw new DomainError('Challenge timestamp mismatch', 'CHALLENGE_TIMESTAMP');
    }

    const bound = {
      nonce: response.nonce,
      audience: storedAudience,
      timestamp: storedTimestamp,
      intent_hash: storedIntent,
    };
    const ok = await verifyChallengeSignature(
      enrollment.publicJwk,
      response.signature,
      bound,
    );
    if (!ok) throw new DomainError('Invalid challenge signature', 'CHALLENGE_SIG');

    await this.repo.withLock(async (s) => {
      const n = s.nonces.find(
        (x) => x.nonce === response.nonce && x.purpose === 'challenge',
      );
      if (!n) throw new DomainError('Unknown challenge nonce', 'CHALLENGE');
      if (n.consumedAt) throw new DomainError('Challenge replay', 'CHALLENGE_REPLAY');
      if (new Date(n.expiresAt).getTime() <= Date.now()) {
        throw new DomainError('Challenge expired', 'CHALLENGE_EXPIRED');
      }
      if (n.agentUuid !== agentUuid) {
        throw new DomainError('Challenge agent mismatch', 'CHALLENGE');
      }
      if (
        n.audience !== storedAudience ||
        n.intentHash !== storedIntent ||
        n.challengeTimestamp !== storedTimestamp ||
        n.audience !== this.config.KYA_AUDIENCE
      ) {
        throw new DomainError('Challenge binding changed', 'CHALLENGE');
      }
      const stillActive = s.credentials.find(
        (c) => c.agentUuid === agentUuid && c.status === 'active',
      );
      if (!stillActive) throw new DomainError('No active credential', 'JWT_STATUS');
      n.consumedAt = new Date().toISOString();
    });

    return {
      ok: true as const,
      thumbprint: enrollment.thumbprint,
      credentialId: activeCred.jti,
    };
  }

  async revokeAgent(agentUuid: string, ownerAddress: `0x${string}`) {
    return this.repo.withLock(async (store) => {
      const idx = store.enrollments.findIndex((e) => e.agentUuid === agentUuid);
      if (idx < 0) throw new DomainError('Not found', 'NOT_FOUND');
      const e = store.enrollments[idx]!;
      const principal = store.principals.find((p) => p.id === e.principalId);
      if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) {
        throw new DomainError('Forbidden', 'FORBIDDEN');
      }
      store.enrollments[idx] = {
        ...e,
        status: 'revoked',
        updatedAt: new Date().toISOString(),
      };
      for (const c of store.credentials) {
        if (c.agentUuid === agentUuid && c.status !== 'revoked') c.status = 'revoked';
      }
      return store.enrollments[idx]!;
    });
  }
}
