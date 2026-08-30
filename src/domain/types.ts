/** Domain types for KYA — no PII fields allowed. */

export type KycNormalizedStatus = 'pending' | 'verified' | 'expired';

export type CredentialStatus = 'active' | 'revoked' | 'expired';

export type EnrollmentStatus =
  | 'awaiting_device'
  | 'awaiting_human'
  | 'awaiting_kyc'
  | 'awaiting_fingerprint'
  | 'awaiting_register'
  | 'bound'
  | 'revoked';

export type KeystoreProviderKind = 'os_hardware' | 'encrypted_os_keystore';

export interface Principal {
  id: string;
  ownerAddress: `0x${string}`;
  kycStatus: KycNormalizedStatus;
  kycVerifiedAt?: string;
  kycExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentEnrollment {
  agentUuid: string;
  deviceCode: string;
  principalId?: string;
  status: EnrollmentStatus;
  publicJwk: JsonWebKey;
  thumbprint: string;
  keystoreProvider: KeystoreProviderKind;
  fingerprintApprovedAt?: string;
  agentRegistry?: string;
  agentId?: string;
  owner?: `0x${string}`;
  createdAt: string;
  updatedAt: string;
}

export interface KyaCredentialRecord {
  id: string;
  agentUuid: string;
  principalId: string;
  thumbprint: string;
  agentRegistry: string;
  agentId: string;
  owner: `0x${string}`;
  status: CredentialStatus;
  statusRef: string;
  issuedAt: string;
  expiresAt: string;
  jti: string;
}

export interface AuthNonce {
  nonce: string;
  purpose: 'challenge';
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  audience?: string;
  agentUuid?: string;
  intentHash?: string;
  /** Exact challenge timestamp issued to the agent (bound into the signed payload). */
  challengeTimestamp?: string;
}
