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
  awaiting_kyc: ['awaiting_fingerprint', 'awaiting_human', 'revoked'],
  awaiting_fingerprint: ['awaiting_register', 'revoked'],
  awaiting_register: ['bound', 'revoked'],
  bound: ['revoked'],
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

/** Mocked KYC completion — no external provider, no session/assurance metadata. */
export function applyKycStatus(
  principal: Principal,
  status: KycNormalizedStatus,
  meta: {
    ttlDays: number;
    now?: Date;
  },
): Principal {
  const now = meta.now ?? new Date();
  const next: Principal = {
    ...principal,
    kycStatus: status,
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
