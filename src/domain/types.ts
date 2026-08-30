/** Domain types for KYA — no PII fields allowed. */

export type KycNormalizedStatus =
  | 'pending'
  | 'verified'
  | 'needs_review'
  | 'rejected'
  | 'expired';

export type CredentialStatus = 'active' | 'suspended' | 'revoked' | 'expired';

export type EnrollmentStatus =
  | 'awaiting_device'
  | 'awaiting_human'
  | 'awaiting_kyc'
  | 'awaiting_fingerprint'
  | 'awaiting_register'
  | 'awaiting_onchain'
  | 'bound'
  | 'suspended'
  | 'revoked';

export type KeystoreProviderKind = 'os_hardware' | 'encrypted_os_keystore';

export type NetworkMode = 'demo' | 'sepolia' | 'mainnet';

export interface Principal {
  id: string;
  ownerAddress: `0x${string}`;
  kycStatus: KycNormalizedStatus;
  kycProvider?: string;
  kycSessionRef?: string;
  kycAssuranceLevel?: string;
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
  agentUriPath: string;
  /** Separately delegated ES256 public key authorized to sign AP2 mandates. */
  mandateSigningPublicJwk?: JsonWebKey;
  mandateSigningThumbprint?: string;
  mandateSigningKeyId?: string;
  mandateSigningBoundAt?: string;
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
  purpose: 'siwe' | 'challenge' | 'enrollment';
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  audience?: string;
  agentUuid?: string;
  intentHash?: string;
  /** Exact challenge timestamp issued to the agent (bound into the signed payload). */
  challengeTimestamp?: string;
}

export interface KycSessionRecord {
  id: string;
  provider: 'didit' | 'incode' | 'veriff' | 'demo';
  providerSessionId: string;
  principalId?: string;
  ownerAddress?: `0x${string}`;
  status: KycNormalizedStatus;
  assuranceLevel?: string;
  webhookEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EventCursor {
  chainId: number;
  registryAddress: `0x${string}`;
  lastBlock: bigint;
  lastLogIndex: number;
  updatedAt: string;
}

export interface ProcessedEvent {
  id: string;
  chainId: number;
  txHash: `0x${string}`;
  logIndex: number;
  eventName: 'Registered' | 'Transfer';
  processedAt: string;
  payload: Record<string, string>;
}

export interface AgentUriDocument {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string;
  image?: string;
  services: Array<{ name: string; endpoint: string }>;
  x402Support?: boolean;
  registrations?: Array<{ agentId: number; agentRegistry: string }>;
  active: boolean;
}

export const FORBIDDEN_AGENT_URI_KEYS = [
  'principal_id',
  'principalId',
  'kyc',
  'kycProvider',
  'document',
  'documents',
  'selfie',
  'biometric',
  'biometrics',
  'pii',
  'email',
  'phone',
  'name_first',
  'first_name',
  'last_name',
  'date_of_birth',
] as const;
