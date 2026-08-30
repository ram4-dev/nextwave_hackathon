import { createHash, randomUUID } from 'node:crypto';
import { createPublicClient, getAddress, http, type Hex, type TypedDataDomain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { credentialUsable, isKycActive, DomainError } from '../domain/state-machine.js';
import type { AppConfig } from '../config/env.js';
import type { Repository } from '../persistence/repository.js';
import { openPayload, type InMemoryOpenMandateRegistry } from './autonomy.js';
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
      if (challenge.consumedAt || this.proofs.has(input.challengeId)) throw new DomainError('Approval challenge already used', 'APPROVAL_REPLAY');
      if (new Date(challenge.expiresAt).getTime() <= now.getTime()) throw new DomainError('Approval challenge expired', 'APPROVAL_EXPIRED');
      if (challenge.openMandateId !== input.openMandateId || challenge.ownerAddress !== input.ownerAddress) throw new DomainError('Approval challenge subject mismatch', 'APPROVAL_SUBJECT');
      challenge.consumedAt = now.toISOString();
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

function hash32(value: string): Hex {
  return `0x${createHash('sha256').update(value).digest('hex')}` as Hex;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function mandateApprovalDomain(chainId: 8453 | 84532): TypedDataDomain {
  return { name: 'KYA AP2 Trusted Surface', version: '1', chainId };
}

function assertKyaUserCanApprove(repoStore: Awaited<ReturnType<Repository['getStore']>>, mandate: OpenMandateRecord, ownerAddress: `0x${string}`, now: Date): void {
  const enrollment = repoStore.enrollments.find((item) => item.agentUuid === mandate.agentId || item.agentId === mandate.agentId);
  if (!enrollment || enrollment.status !== 'bound' || !enrollment.principalId) throw new DomainError('Mandate agent is not an active KYA enrollment', 'APPROVAL_AGENT');
  const principal = repoStore.principals.find((item) => item.id === enrollment.principalId);
  if (!principal || principal.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase() || !isKycActive(principal, now)) throw new DomainError('Session wallet is not an active KYA principal for this mandate', 'APPROVAL_PRINCIPAL');
  const credential = repoStore.credentials.find((item) => item.agentUuid === enrollment.agentUuid && item.principalId === principal.id && credentialUsable(item.status, item.expiresAt, now));
  if (!credential) throw new DomainError('Mandate agent has no active KYA credential', 'APPROVAL_CREDENTIAL');
}

export class Eip712TrustedSurfaceService {
  constructor(
    private readonly dependencies: {
      repo: Repository;
      registry: InMemoryOpenMandateRegistry;
      approvalStore: TrustedSurfaceApprovalStore;
      verifier: TypedDataVerifier;
      chainId: 8453 | 84532;
      challengeTtlSeconds?: number;
      now?: () => Date;
    },
  ) {}

  async createApprovalChallenge(input: { openMandateId: string; ownerAddress: `0x${string}` }): Promise<{ challenge: Eip712ApprovalChallenge; typedData: { domain: TypedDataDomain; types: typeof mandateApprovalTypes; primaryType: 'MandateApproval'; message: MandateApprovalMessage } }> {
    let ownerAddress: `0x${string}`;
    try { ownerAddress = getAddress(input.ownerAddress) as `0x${string}`; } catch { throw new DomainError('Invalid owner wallet address', 'APPROVAL_ADDRESS'); }
    const now = this.dependencies.now?.() ?? new Date();
    const mandate = this.dependencies.registry.get(input.openMandateId);
    if (mandate.status !== 'awaiting_user_signature') throw new DomainError('Open mandate is not awaiting user approval', 'APPROVAL_MANDATE_STATE');
    if (Date.parse(mandate.expiresAt) <= now.getTime()) throw new DomainError('Open mandate expired', 'APPROVAL_EXPIRED');
    assertKyaUserCanApprove(await this.dependencies.repo.getStore(), mandate, ownerAddress, now);
    const ttl = this.dependencies.challengeTtlSeconds ?? 300;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new DomainError('Challenge TTL must be positive', 'APPROVAL_CONFIG');
    const expiresAt = new Date(Math.min(Date.parse(mandate.expiresAt), now.getTime() + ttl * 1000)).toISOString();
    const nonce = randomUUID();
    const message: MandateApprovalMessage = {
      mandateHash: hash32(canonicalJson(openPayload(mandate))),
      userReferenceHash: hash32(mandate.userReference), agentIdHash: hash32(mandate.agentId), nonceHash: hash32(nonce),
      issuedAt: BigInt(Math.floor(now.getTime() / 1000)), expiresAt: BigInt(Math.floor(Date.parse(expiresAt) / 1000)),
    };
    const challenge: Eip712ApprovalChallenge = { id: `approval_${randomUUID().replace(/-/g, '')}`, openMandateId: mandate.id, ownerAddress, chainId: this.dependencies.chainId, nonce, issuedAt: now.toISOString(), expiresAt, domain: mandateApprovalDomain(this.dependencies.chainId), message };
    await this.dependencies.approvalStore.create(challenge);
    return { challenge, typedData: { domain: challenge.domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message } };
  }

  async verifyAndRecordApproval(input: { challengeId: string; ownerAddress: `0x${string}`; signature: Hex }): Promise<{ mandate: OpenMandateRecord; proof: Eip712ApprovalProof }> {
    let ownerAddress: `0x${string}`;
    try { ownerAddress = getAddress(input.ownerAddress) as `0x${string}`; } catch { throw new DomainError('Invalid owner wallet address', 'APPROVAL_ADDRESS'); }
    const now = this.dependencies.now?.() ?? new Date();
    const challenge = await this.dependencies.approvalStore.get(input.challengeId);
    if (challenge.ownerAddress.toLowerCase() !== ownerAddress.toLowerCase()) throw new DomainError('Approval wallet mismatch', 'APPROVAL_SUBJECT');
    if (challenge.chainId !== this.dependencies.chainId || new Date(challenge.expiresAt).getTime() <= now.getTime()) throw new DomainError('Approval challenge expired', 'APPROVAL_EXPIRED');
    const mandate = this.dependencies.registry.get(challenge.openMandateId);
    assertKyaUserCanApprove(await this.dependencies.repo.getStore(), mandate, ownerAddress, now);
    const valid = await this.dependencies.verifier.verify({ address: ownerAddress, domain: challenge.domain, message: challenge.message, signature: input.signature });
    if (!valid) throw new DomainError('Invalid EIP-712 approval signature', 'APPROVAL_SIGNATURE');
    const proof = await this.dependencies.approvalStore.consume({ challengeId: challenge.id, openMandateId: mandate.id, ownerAddress, signature: input.signature, signedAt: now.toISOString() }, now);
    // Registry transition follows signature persistence. A durable registry is required in production.
    const active = await this.dependencies.registry.recordUserSignature(mandate.id, input.signature, { verify: async () => true });
    return { mandate: active, proof };
  }
}
