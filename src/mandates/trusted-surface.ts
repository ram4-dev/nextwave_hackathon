import { randomUUID } from 'node:crypto';
import { calculateJwkThumbprint } from 'jose';
import { createPublicClient, getAddress, http, type Hex, type TypedDataDomain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { credentialUsable, isKycActive, DomainError } from '../domain/state-machine.js';
import type { AppConfig } from '../config/env.js';
import type { Repository } from '../persistence/repository.js';
import { type OpenMandateRegistry, openPayload } from './autonomy.js';
import { canonicalJson, openMandatePayloadHash, sha256Hex32 } from './canonical.js';
import type { OpenMandateRecord } from './policy.js';

export const mandateApprovalTypes = {
  MandateApproval: [
    { name: 'mandateHash', type: 'bytes32' },
    { name: 'userReferenceHash', type: 'bytes32' },
    { name: 'agentIdHash', type: 'bytes32' },
    { name: 'nonceHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

export type MandateApprovalMessage = {
  mandateHash: Hex;
  userReferenceHash: Hex;
  agentIdHash: Hex;
  nonceHash: Hex;
  issuedAt: bigint;
  expiresAt: bigint;
};

export type Eip712ApprovalChallenge = {
  id: string;
  openMandateId: string;
  ownerAddress: `0x${string}`;
  chainId: 8453 | 84532;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  /** Canonical open-mandate payload hash bound into the typed-data message. */
  expectedPayloadHash: string;
  domain: TypedDataDomain;
  message: MandateApprovalMessage;
  consumedAt?: string;
};

export type Eip712ApprovalProof = {
  challengeId: string;
  openMandateId: string;
  ownerAddress: `0x${string}`;
  signature: Hex;
  signedAt: string;
  payloadHash: string;
};

/** Storage boundary. Implement this with a transaction/row lock outside demo mode. */
export interface TrustedSurfaceApprovalStore {
  create(challenge: Eip712ApprovalChallenge): Promise<Eip712ApprovalChallenge>;
  get(id: string): Promise<Eip712ApprovalChallenge>;
  consume(input: Eip712ApprovalProof, now: Date): Promise<Eip712ApprovalProof>;
}

export class InMemoryTrustedSurfaceApprovalStore implements TrustedSurfaceApprovalStore {
  private readonly challenges = new Map<string, Eip712ApprovalChallenge>();
  private readonly proofs = new Map<string, Eip712ApprovalProof>();
  private lock: Promise<unknown> = Promise.resolve();

  async create(challenge: Eip712ApprovalChallenge): Promise<Eip712ApprovalChallenge> {
    if (this.challenges.has(challenge.id)) throw new DomainError('Approval challenge already exists', 'APPROVAL_CHALLENGE_EXISTS');
    this.challenges.set(challenge.id, structuredClone(challenge));
    return structuredClone(challenge);
  }

  async get(id: string): Promise<Eip712ApprovalChallenge> {
    const challenge = this.challenges.get(id);
    if (!challenge) throw new DomainError('Approval challenge not found', 'APPROVAL_CHALLENGE_NOT_FOUND');
    return structuredClone(challenge);
  }

  async consume(input: Eip712ApprovalProof, now: Date): Promise<Eip712ApprovalProof> {
    const run = this.lock.then(() => {
      const challenge = this.challenges.get(input.challengeId);
      if (!challenge) throw new DomainError('Approval challenge not found', 'APPROVAL_CHALLENGE_NOT_FOUND');
      if (challenge.consumedAt || this.proofs.has(input.challengeId)) {
        throw new DomainError('Approval challenge already used', 'APPROVAL_REPLAY');
      }
      if (new Date(challenge.expiresAt).getTime() <= now.getTime()) {
        throw new DomainError('Approval challenge expired', 'APPROVAL_EXPIRED');
      }
      if (challenge.openMandateId !== input.openMandateId || challenge.ownerAddress !== input.ownerAddress) {
        throw new DomainError('Approval challenge subject mismatch', 'APPROVAL_SUBJECT');
      }
      if (challenge.expectedPayloadHash !== input.payloadHash) {
        throw new DomainError('Approval challenge payload hash mismatch', 'APPROVAL_HASH');
      }
      const nextChallenge = { ...challenge, consumedAt: now.toISOString() };
      this.challenges.set(input.challengeId, nextChallenge);
      this.proofs.set(input.challengeId, structuredClone(input));
      return structuredClone(input);
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }
}

export interface TypedDataVerifier {
  verify(input: { address: `0x${string}`; domain: TypedDataDomain; message: MandateApprovalMessage; signature: Hex }): Promise<boolean>;
}

/** Uses KYA's Base RPC configuration and supports ERC-1271 / smart-account verification. */
export function createBaseTypedDataVerifier(config: AppConfig, chainId: 8453 | 84532): TypedDataVerifier {
  const client = createPublicClient({
    chain: chainId === 84532 ? baseSepolia : base,
    transport: http(chainId === 84532 ? config.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org' : config.BASE_MAINNET_RPC_URL ?? 'https://mainnet.base.org'),
  });
  return {
    verify: ({ address, domain, message, signature }) => client.verifyTypedData({
      address, domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message, signature,
    }),
  };
}

export function mandateApprovalDomain(chainId: 8453 | 84532): TypedDataDomain {
  return { name: 'KYA AP2 Trusted Surface', version: '1', chainId };
}

function approvalIntegrityError(field: string): never {
  throw new DomainError(`Stored approval challenge integrity failure: ${field}`, 'APPROVAL_INTEGRITY');
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function assertExactApprovalDomain(domain: TypedDataDomain, chainId: 8453 | 84532): void {
  const expected = mandateApprovalDomain(chainId);
  if (
    !domain
    || typeof domain !== 'object'
    || !hasExactKeys(domain, ['name', 'version', 'chainId'])
    || domain.name !== expected.name
    || domain.version !== expected.version
    || domain.chainId !== expected.chainId
  ) {
    approvalIntegrityError('domain');
  }
}

function assertKyaUserCanApprove(
  repoStore: Awaited<ReturnType<Repository['getStore']>>,
  mandate: OpenMandateRecord,
  ownerAddress: `0x${string}`,
  now: Date,
  mandateKeyThumbprint: string,
): void {
  const enrollment = repoStore.enrollments.find((item) => item.agentUuid === mandate.agentId || item.agentId === mandate.agentId);
  if (!enrollment || enrollment.status !== 'bound' || !enrollment.principalId) {
    throw new DomainError('Mandate agent is not an active KYA enrollment', 'APPROVAL_AGENT');
  }
  if (enrollment.thumbprint !== mandateKeyThumbprint) {
    throw new DomainError('Open mandate agent key thumbprint does not match enrollment', 'APPROVAL_KEY_THUMBPRINT');
  }
  const principal = repoStore.principals.find((item) => item.id === enrollment.principalId);
  if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase() || !isKycActive(principal, now)) {
    throw new DomainError('Session wallet is not an active KYA principal for this mandate', 'APPROVAL_PRINCIPAL');
  }
  const credential = repoStore.credentials.find(
    (item) => item.agentUuid === enrollment.agentUuid
      && item.principalId === principal.id
      && item.thumbprint === enrollment.thumbprint
      && item.thumbprint === mandateKeyThumbprint
      && credentialUsable(item.status, item.expiresAt, now),
  );
  if (!credential) throw new DomainError('Mandate agent has no active KYA credential for matching thumbprint', 'APPROVAL_CREDENTIAL');
}

export class Eip712TrustedSurfaceService {
  private readonly clockSkewMs: number;

  constructor(
    private readonly dependencies: {
      repo: Repository;
      registry: OpenMandateRegistry;
      approvalStore: TrustedSurfaceApprovalStore;
      verifier: TypedDataVerifier;
      chainId: 8453 | 84532;
      challengeTtlSeconds?: number;
      clockSkewMs?: number;
      now?: () => Date;
    },
  ) {
    this.clockSkewMs = dependencies.clockSkewMs ?? 5_000;
    if (!Number.isSafeInteger(this.clockSkewMs) || this.clockSkewMs < 0) {
      throw new DomainError('clockSkewMs must be a non-negative safe integer', 'APPROVAL_CONFIG');
    }
  }

  private currentTime(): Date {
    const now = this.dependencies.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new DomainError('Trusted Surface clock must return a valid Date', 'APPROVAL_CONFIG');
    }
    return now;
  }

  async createApprovalChallenge(input: {
    openMandateId: string;
    ownerAddress: `0x${string}`;
  }): Promise<{
    challenge: Eip712ApprovalChallenge;
    typedData: {
      domain: TypedDataDomain;
      types: typeof mandateApprovalTypes;
      primaryType: 'MandateApproval';
      message: MandateApprovalMessage;
    };
  }> {
    let ownerAddress: `0x${string}`;
    try {
      ownerAddress = getAddress(input.ownerAddress) as `0x${string}`;
    } catch {
      throw new DomainError('Invalid owner wallet address', 'APPROVAL_ADDRESS');
    }
    const now = this.currentTime();
    const mandate = this.dependencies.registry.get(input.openMandateId);
    if (mandate.status !== 'awaiting_user_signature') {
      throw new DomainError('Open mandate is not awaiting user approval', 'APPROVAL_MANDATE_STATE');
    }
    const mandateExpiresAtMs = Date.parse(mandate.expiresAt);
    if (!Number.isFinite(mandateExpiresAtMs) || mandateExpiresAtMs <= now.getTime()) {
      throw new DomainError('Open mandate expired', 'APPROVAL_EXPIRED');
    }
    const issuedAtMs = Date.parse(mandate.issuedAt);
    if (!Number.isFinite(issuedAtMs) || now.getTime() < issuedAtMs) {
      throw new DomainError('Open mandate cannot be challenged before issuedAt', 'OPEN_MANDATE_NOT_YET_VALID');
    }
    const liveHash = openMandatePayloadHash(mandate);
    if (liveHash !== mandate.canonicalPayloadHash) {
      throw new DomainError('Open mandate payload mutated after create', 'OPEN_MANDATE_HASH');
    }
    const mandateKeyThumbprint = await calculateJwkThumbprint(mandate.agentPublicKeyJwk, 'sha256');
    assertKyaUserCanApprove(await this.dependencies.repo.getStore(), mandate, ownerAddress, now, mandateKeyThumbprint);
    const ttl = this.dependencies.challengeTtlSeconds ?? 300;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new DomainError('Challenge TTL must be positive', 'APPROVAL_CONFIG');
    const issuedAtSeconds = Math.max(
      Math.floor(now.getTime() / 1000),
      Math.ceil(issuedAtMs / 1000),
    );
    const expiresAtSeconds = Math.floor(
      Math.min(mandateExpiresAtMs, now.getTime() + ttl * 1000) / 1000,
    );
    if (expiresAtSeconds <= issuedAtSeconds) {
      throw new DomainError('Approval challenge has no canonical validity window', 'APPROVAL_EXPIRED');
    }
    const issuedAt = new Date(issuedAtSeconds * 1000).toISOString();
    const expiresAt = new Date(expiresAtSeconds * 1000).toISOString();
    const nonce = randomUUID();
    const message: MandateApprovalMessage = {
      mandateHash: sha256Hex32(canonicalJson(openPayload(mandate))),
      userReferenceHash: sha256Hex32(mandate.userReference),
      agentIdHash: sha256Hex32(mandate.agentId),
      nonceHash: sha256Hex32(nonce),
      issuedAt: BigInt(issuedAtSeconds),
      expiresAt: BigInt(expiresAtSeconds),
    };
    const challenge: Eip712ApprovalChallenge = {
      id: `approval_${randomUUID().replace(/-/g, '')}`,
      openMandateId: mandate.id,
      ownerAddress,
      chainId: this.dependencies.chainId,
      nonce,
      issuedAt,
      expiresAt,
      expectedPayloadHash: mandate.canonicalPayloadHash,
      domain: mandateApprovalDomain(this.dependencies.chainId),
      message,
    };
    await this.dependencies.approvalStore.create(challenge);
    return {
      challenge,
      typedData: { domain: challenge.domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message },
    };
  }

  async verifyAndRecordApproval(input: {
    challengeId: string;
    ownerAddress: `0x${string}`;
    signature: Hex;
  }): Promise<{ mandate: OpenMandateRecord; proof: Eip712ApprovalProof }> {
    let ownerAddress: `0x${string}`;
    try {
      ownerAddress = getAddress(input.ownerAddress) as `0x${string}`;
    } catch {
      throw new DomainError('Invalid owner wallet address', 'APPROVAL_ADDRESS');
    }
    const now = this.currentTime();
    const challenge = await this.dependencies.approvalStore.get(input.challengeId);
    if (!challenge || challenge.id !== input.challengeId) approvalIntegrityError('challengeId');
    if (challenge.consumedAt) throw new DomainError('Approval challenge already used', 'APPROVAL_REPLAY');
    let storedOwner: `0x${string}`;
    try {
      storedOwner = getAddress(challenge.ownerAddress) as `0x${string}`;
    } catch {
      approvalIntegrityError('ownerAddress');
    }
    if (storedOwner !== challenge.ownerAddress) approvalIntegrityError('ownerAddress');
    if (storedOwner !== ownerAddress) {
      throw new DomainError('Approval wallet mismatch', 'APPROVAL_SUBJECT');
    }
    if (challenge.chainId !== this.dependencies.chainId) approvalIntegrityError('chainId');
    assertExactApprovalDomain(challenge.domain, this.dependencies.chainId);
    if (
      !challenge.message
      || typeof challenge.message !== 'object'
      || !hasExactKeys(challenge.message, ['mandateHash', 'userReferenceHash', 'agentIdHash', 'nonceHash', 'issuedAt', 'expiresAt'])
    ) {
      approvalIntegrityError('message');
    }
    const challengeIssuedAt = Date.parse(challenge.issuedAt);
    const challengeExpiresAt = Date.parse(challenge.expiresAt);
    if (
      !Number.isFinite(challengeIssuedAt)
      || !Number.isFinite(challengeExpiresAt)
      || new Date(challengeIssuedAt).toISOString() !== challenge.issuedAt
      || new Date(challengeExpiresAt).toISOString() !== challenge.expiresAt
      || challengeExpiresAt <= challengeIssuedAt
      || challengeIssuedAt > now.getTime() + this.clockSkewMs
    ) {
      approvalIntegrityError('timestamps');
    }
    if (
      typeof challenge.message.issuedAt !== 'bigint'
      || typeof challenge.message.expiresAt !== 'bigint'
      || BigInt(challengeIssuedAt) !== challenge.message.issuedAt * 1000n
      || BigInt(challengeExpiresAt) !== challenge.message.expiresAt * 1000n
    ) {
      approvalIntegrityError('timestamps');
    }
    if (challengeExpiresAt <= now.getTime()) {
      throw new DomainError('Approval challenge expired', 'APPROVAL_EXPIRED');
    }
    if (typeof challenge.openMandateId !== 'string' || challenge.openMandateId.length === 0) {
      approvalIntegrityError('openMandateId');
    }
    let mandate: OpenMandateRecord;
    try {
      mandate = this.dependencies.registry.get(challenge.openMandateId);
    } catch {
      approvalIntegrityError('openMandateId');
    }
    if (mandate.id !== challenge.openMandateId) approvalIntegrityError('openMandateId');
    if (typeof challenge.nonce !== 'string' || challenge.nonce.length === 0) approvalIntegrityError('nonce');
    const mandateIssuedAt = Date.parse(mandate.issuedAt);
    const mandateExpiresAt = Date.parse(mandate.expiresAt);
    if (
      !Number.isFinite(mandateIssuedAt)
      || !Number.isFinite(mandateExpiresAt)
      || challengeIssuedAt < mandateIssuedAt
      || challengeExpiresAt > mandateExpiresAt
    ) {
      approvalIntegrityError('mandateWindow');
    }
    const liveHash = openMandatePayloadHash(mandate);
    if (liveHash !== mandate.canonicalPayloadHash || challenge.expectedPayloadHash !== liveHash) {
      approvalIntegrityError('expectedPayloadHash');
    }
    const expectedMessage: MandateApprovalMessage = {
      mandateHash: sha256Hex32(canonicalJson(openPayload(mandate))),
      userReferenceHash: sha256Hex32(mandate.userReference),
      agentIdHash: sha256Hex32(mandate.agentId),
      nonceHash: sha256Hex32(challenge.nonce),
      issuedAt: BigInt(challengeIssuedAt / 1000),
      expiresAt: BigInt(challengeExpiresAt / 1000),
    };
    for (const field of Object.keys(expectedMessage) as Array<keyof MandateApprovalMessage>) {
      if (challenge.message[field] !== expectedMessage[field]) approvalIntegrityError(`message.${field}`);
    }
    const mandateKeyThumbprint = await calculateJwkThumbprint(mandate.agentPublicKeyJwk, 'sha256');
    assertKyaUserCanApprove(await this.dependencies.repo.getStore(), mandate, ownerAddress, now, mandateKeyThumbprint);
    const valid = await this.dependencies.verifier.verify({
      address: ownerAddress,
      domain: challenge.domain,
      message: challenge.message,
      signature: input.signature,
    });
    if (!valid) throw new DomainError('Invalid EIP-712 approval signature', 'APPROVAL_SIGNATURE');

    // Persist challenge consumption inside the registry activation critical section.
    // Local in-memory atomicity only — durable production must share one DB transaction for
    // mandate activation + challenge consumption. Failure leaves mandate awaiting_user_signature
    // and the challenge unconsumed/retryable.
    const active = await this.dependencies.registry.activateWithVerifiedSignature({
      id: mandate.id,
      signature: input.signature,
      expectedPayloadHash: challenge.expectedPayloadHash,
      now,
      clockSkewMs: this.clockSkewMs,
      proof: { challengeId: challenge.id, ownerAddress, activatedAt: now.toISOString() },
      verifier: {
        verify: async ({ expectedPayloadHash }) => expectedPayloadHash === challenge.expectedPayloadHash && valid,
      },
      persistProof: async (activationProof) => {
        await this.dependencies.approvalStore.consume({
          challengeId: challenge.id,
          openMandateId: mandate.id,
          ownerAddress,
          signature: input.signature,
          signedAt: activationProof.activatedAt,
          payloadHash: challenge.expectedPayloadHash,
        }, now);
      },
    });
    const proof: Eip712ApprovalProof = {
      challengeId: challenge.id,
      openMandateId: mandate.id,
      ownerAddress,
      signature: input.signature,
      signedAt: now.toISOString(),
      payloadHash: challenge.expectedPayloadHash,
    };
    return { mandate: active, proof };
  }
}
