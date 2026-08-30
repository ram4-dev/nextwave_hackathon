import type {
  AgentEnrollment,
  CredentialStatus,
  EnrollmentStatus,
  KycNormalizedStatus,
  Principal,
} from './types.js';

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isKycActive(principal: Principal, now = new Date()): boolean {
  if (principal.kycStatus !== 'verified') return false;
  if (!principal.kycExpiresAt) return true;
  return new Date(principal.kycExpiresAt).getTime() > now.getTime();
}

export function needsKyc(principal: Principal | undefined, now = new Date()): boolean {
  if (!principal) return true;
  if (principal.kycStatus === 'expired') return true;
  if (principal.kycStatus !== 'verified') return true;
  return !isKycActive(principal, now);
}

const ENROLLMENT_TRANSITIONS: Record<EnrollmentStatus, EnrollmentStatus[]> = {
  awaiting_device: ['awaiting_human', 'revoked'],
  awaiting_human: ['awaiting_kyc', 'awaiting_fingerprint', 'revoked'],
  awaiting_kyc: ['awaiting_fingerprint', 'awaiting_kyc', 'awaiting_human', 'revoked'],
  // awaiting_fingerprint → bound: key rotation / transfer rebind (Agent ID retained).
  awaiting_fingerprint: ['awaiting_register', 'bound', 'revoked'],
  awaiting_register: ['awaiting_onchain', 'revoked'],
  awaiting_onchain: ['bound', 'revoked'],
  bound: ['suspended', 'revoked', 'awaiting_fingerprint'],
  suspended: ['awaiting_fingerprint', 'bound', 'revoked'],
  revoked: [],
};

export function assertEnrollmentTransition(
  from: EnrollmentStatus,
  to: EnrollmentStatus,
): void {
  const allowed = ENROLLMENT_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new DomainError(
      `Invalid enrollment transition ${from} → ${to}`,
      'INVALID_TRANSITION',
    );
  }
}

export function transitionEnrollment(
  enrollment: AgentEnrollment,
  to: EnrollmentStatus,
  patch: Partial<AgentEnrollment> = {},
): AgentEnrollment {
  assertEnrollmentTransition(enrollment.status, to);
  return {
    ...enrollment,
    ...patch,
    status: to,
    updatedAt: new Date().toISOString(),
  };
}

export function canAuthorizeAgent(principal: Principal): boolean {
  return isKycActive(principal);
}

export function credentialUsable(status: CredentialStatus, expiresAt: string, now = new Date()): boolean {
  if (status !== 'active') return false;
  return new Date(expiresAt).getTime() > now.getTime();
}

export function applyKycStatus(
  principal: Principal,
  status: KycNormalizedStatus,
  meta: {
    provider: string;
    sessionRef: string;
    assuranceLevel?: string;
    ttlDays: number;
    now?: Date;
  },
): Principal {
  const now = meta.now ?? new Date();
  const next: Principal = {
    ...principal,
    kycStatus: status,
    kycProvider: meta.provider,
    kycSessionRef: meta.sessionRef,
    kycAssuranceLevel: meta.assuranceLevel,
    updatedAt: now.toISOString(),
  };
  if (status === 'verified') {
    next.kycVerifiedAt = now.toISOString();
    next.kycExpiresAt = new Date(
      now.getTime() + meta.ttlDays * 24 * 60 * 60 * 1000,
    ).toISOString();
  }
  if (status === 'expired') {
    next.kycExpiresAt = now.toISOString();
  }
  return next;
}

export function suspendOnTransfer(enrollment: AgentEnrollment): AgentEnrollment {
  if (enrollment.status === 'revoked') return enrollment;
  if (enrollment.status === 'suspended') return enrollment;
  if (enrollment.status === 'bound') {
    return transitionEnrollment(enrollment, 'suspended');
  }
  return {
    ...enrollment,
    status: 'suspended',
    updatedAt: new Date().toISOString(),
  };
}

export function mainnetPromotionAllowed(opts: {
  enabled: boolean;
  registryVerified: boolean;
  getVersionOk: boolean;
  codePresent: boolean;
}): { allowed: boolean; reason?: string } {
  if (!opts.enabled) {
    return { allowed: false, reason: 'MAINNET_PROMOTION_ENABLED is false' };
  }
  if (!opts.registryVerified) {
    return { allowed: false, reason: 'MAINNET_REGISTRY_VERIFIED is false' };
  }
  if (!opts.codePresent) {
    return { allowed: false, reason: 'No contract code at mainnet registry address' };
  }
  if (!opts.getVersionOk) {
    return {
      allowed: false,
      reason: 'getVersion must equal supported Identity Registry version 2.0.0',
    };
  }
  return { allowed: true };
}
