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
  /** Stable CDP end-user identifier; pseudonymous, never email or token. */
  cdpUserId?: string;
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
  /** SHA-256 hex of agent-held device_code — never store plaintext. */
  deviceCodeHash: string;
  /** SHA-256 hex of human user_code — never store plaintext. */
  userCodeHash: string;
  pairingExpiresAt: string;
  pollIntervalSeconds: number;
  lastPollAt?: string;
  claimedAt?: string;
  /** Set when the identity credential was delivered once via device poll. */
  credentialDeliveredAt?: string;
  pairingDeniedAt?: string;
  principalId?: string;
  status: EnrollmentStatus;
  publicJwk: JsonWebKey;
  thumbprint: string;
  keystoreProvider: KeystoreProviderKind;
  fingerprintApprovedAt?: string;
  /** Hash binding the one executable registration intent to this enrollment. */
  registrationIntentHash?: string;
  registrationUserOpHash?: `0x${string}`;
  registrationTransactionHash?: `0x${string}`;
  /** Set only after CDP reports `complete` with the matching non-reverted receipt. */
  registrationReceiptConfirmedAt?: string;
  agentRegistry?: string;
  agentId?: string;
  owner?: `0x${string}`;
  agentUriPath: string;
  createdAt: string;
  updatedAt: string;
}

/** Metadata only — never persist the raw access JWT. */
export interface AccessTokenRecord {
  jti: string;
  agentUuid: string;
  principalId: string;
  credentialJti: string;
  jkt: string;
  scopes: string[];
  status: 'active' | 'revoked' | 'expired';
  issuedAt: string;
  expiresAt: string;
}

/** Atomic DPoP proof jti ledger — store hash only. */
export interface DpopReplayRecord {
  jtiHash: string;
  consumedAt: string;
  expiresAt: string;
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
  purpose: 'challenge' | 'enrollment';
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

/**
 * A confirmed registry event that arrived before its UserOperation can be
 * authoritatively resolved. This is deliberately narrow, pseudonymous chain
 * evidence; it lets a restarted watcher retry without trusting a frontend tx.
 */
export interface PendingRegistryEvent {
  id: string;
  chainId: number;
  registryAddress: `0x${string}`;
  agentId: string;
  agentURI: string;
  owner: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  publicBaseUrl?: string;
  createdAt: string;
  updatedAt: string;
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
