import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/state-machine.js';

const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export type MandateAnchorJob = {
  id: string;
  closedCheckoutHash: string;
  closedPaymentHash: string;
  checkoutHash: string;
  transactionIdHash: string;
  agentIdHash: string;
  policyVersionHash: string;
  mandateType: number;
  attempts: number;
  status: 'pending' | 'processing' | 'anchored' | 'failed';
  /** Opaque claim lease token. Required for CAS updates from the claiming worker. */
  claimToken?: string;
  lastError?: string;
  txHash?: string;
  leaseUntil?: string;
  createdAt: string;
  updatedAt: string;
  anchoredAt?: string;
};

export type MandateAnchorEvidence = Pick<
  MandateAnchorJob,
  | 'closedCheckoutHash'
  | 'closedPaymentHash'
  | 'checkoutHash'
  | 'transactionIdHash'
  | 'agentIdHash'
  | 'policyVersionHash'
  | 'mandateType'
>;

/** Injectable chain boundary. Fake implementations never write to a real RPC. */
export interface MandateAnchorClient {
  anchor(evidence: MandateAnchorEvidence): Promise<{ txHash: string }>;
}

export interface MandateAnchorOutbox {
  enqueue(evidence: MandateAnchorEvidence): Promise<MandateAnchorJob>;
  claimNext(now?: Date): Promise<MandateAnchorJob | undefined>;
  markAnchored(id: string, txHash: string, claimToken: string, now?: Date): Promise<MandateAnchorJob>;
  markFailed(id: string, error: string, claimToken: string, now?: Date): Promise<MandateAnchorJob>;
  get(id: string): Promise<MandateAnchorJob>;
}

export function isStrictEvidenceHash(value: string): boolean {
  if (BYTES32_HEX.test(value)) return !/^0x0{64}$/i.test(value);
  if (!BASE64URL_SHA256.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === 32
    && decoded.toString('base64url') === value
    && decoded.some((byte) => byte !== 0);
}

function assertHashOnly(evidence: MandateAnchorEvidence): void {
  const values = [
    evidence.closedCheckoutHash,
    evidence.closedPaymentHash,
    evidence.checkoutHash,
    evidence.transactionIdHash,
    evidence.agentIdHash,
    evidence.policyVersionHash,
  ];
  for (const value of values) {
    if (typeof value !== 'string' || !isStrictEvidenceHash(value)) {
      throw new DomainError('Anchor evidence must be a canonical non-zero SHA-256 base64url or bytes32 hex value', 'ANCHOR_EVIDENCE');
    }
  }
  if (!Number.isInteger(evidence.mandateType) || evidence.mandateType < 0 || evidence.mandateType > 255) {
    throw new DomainError('Invalid mandate type for anchor', 'ANCHOR_EVIDENCE');
  }
}

function assertPositiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError(`${label} must be a positive integer`, 'ANCHOR_CONFIG');
  }
  return value;
}

/**
 * In-memory hash-only outbox. Sole authority for leaseMs and maxAttempts.
 * Workers must not carry a competing attempt budget.
 */
export class InMemoryMandateAnchorOutbox implements MandateAnchorOutbox {
  private readonly jobs = new Map<string, MandateAnchorJob>();
  private readonly byEvidence = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;

  constructor(options: { leaseMs?: number; maxAttempts?: number } = {}) {
    this.leaseMs = assertPositiveInt(options.leaseMs ?? 30_000, 'leaseMs');
    this.maxAttempts = assertPositiveInt(options.maxAttempts ?? 5, 'maxAttempts');
  }

  private evidenceKey(evidence: MandateAnchorEvidence): string {
    return `${evidence.closedCheckoutHash}:${evidence.closedPaymentHash}`;
  }

  async enqueue(evidence: MandateAnchorEvidence): Promise<MandateAnchorJob> {
    assertHashOnly(evidence);
    const key = this.evidenceKey(evidence);
    const existingId = this.byEvidence.get(key);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (!existing) throw new DomainError('Anchor job index corrupt', 'ANCHOR_NOT_FOUND');
      const same =
        existing.closedCheckoutHash === evidence.closedCheckoutHash
        && existing.closedPaymentHash === evidence.closedPaymentHash
        && existing.checkoutHash === evidence.checkoutHash
        && existing.transactionIdHash === evidence.transactionIdHash
        && existing.agentIdHash === evidence.agentIdHash
        && existing.policyVersionHash === evidence.policyVersionHash
        && existing.mandateType === evidence.mandateType;
      if (!same) {
        throw new DomainError('Anchor evidence conflicts with an existing job for the same closed-hash key', 'ANCHOR_EVIDENCE_CONFLICT');
      }
      return structuredClone(existing);
    }
    const now = new Date().toISOString();
    const job: MandateAnchorJob = {
      ...structuredClone(evidence),
      id: `anchor_${++this.seq}`,
      attempts: 0,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.byEvidence.set(key, job.id);
    return structuredClone(job);
  }

  async claimNext(now = new Date()): Promise<MandateAnchorJob | undefined> {
    const run = this.lock.then(() => {
      for (const job of this.jobs.values()) {
        const leaseExpired = job.leaseUntil ? Date.parse(job.leaseUntil) <= now.getTime() : true;
        const reclaimable = job.status === 'processing' && leaseExpired;
        if (job.status === 'pending' || reclaimable) {
          job.attempts += 1;
          job.updatedAt = now.toISOString();
          if (job.attempts > this.maxAttempts) {
            job.status = 'failed';
            job.claimToken = undefined;
            job.leaseUntil = undefined;
            job.lastError = 'max attempts exceeded';
            continue;
          }
          job.status = 'processing';
          job.claimToken = randomUUID();
          job.leaseUntil = new Date(now.getTime() + this.leaseMs).toISOString();
          return structuredClone(job);
        }
      }
      return undefined;
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async markAnchored(id: string, txHash: string, claimToken: string, now = new Date()): Promise<MandateAnchorJob> {
    if (!TX_HASH.test(txHash)) throw new DomainError('Anchor txHash must be bytes32 hex', 'ANCHOR_TXHASH');
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('Anchor job not found', 'ANCHOR_NOT_FOUND');
    if (job.status === 'anchored') return structuredClone(job);
    if (!claimToken || job.claimToken !== claimToken || job.status !== 'processing') {
      // Stale claim — do not mutate a newer worker's result.
      return structuredClone(job);
    }
    job.status = 'anchored';
    job.txHash = txHash;
    job.anchoredAt = now.toISOString();
    job.updatedAt = now.toISOString();
    job.leaseUntil = undefined;
    job.claimToken = undefined;
    job.lastError = undefined;
    return structuredClone(job);
  }

  async markFailed(id: string, error: string, claimToken: string, now = new Date()): Promise<MandateAnchorJob> {
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('Anchor job not found', 'ANCHOR_NOT_FOUND');
    if (job.status === 'anchored' || job.status === 'failed') return structuredClone(job);
    if (!claimToken || job.claimToken !== claimToken || job.status !== 'processing') {
      // Stale claim — never convert an anchored/reclaimed job back to pending/failed.
      return structuredClone(job);
    }
    job.lastError = error;
    job.updatedAt = now.toISOString();
    job.claimToken = undefined;
    if (job.attempts >= this.maxAttempts) {
      job.status = 'failed';
      job.leaseUntil = undefined;
    } else {
      job.status = 'pending';
      job.leaseUntil = undefined;
    }
    return structuredClone(job);
  }

  async get(id: string): Promise<MandateAnchorJob> {
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('Anchor job not found', 'ANCHOR_NOT_FOUND');
    return structuredClone(job);
  }
}

/** Fake anchor client for tests/dev. Does not connect to any RPC or sign transactions. */
export class FakeMandateAnchorClient implements MandateAnchorClient {
  readonly anchored: MandateAnchorEvidence[] = [];
  async anchor(evidence: MandateAnchorEvidence): Promise<{ txHash: string }> {
    assertHashOnly(evidence);
    this.anchored.push(structuredClone(evidence));
    const n = this.anchored.length.toString(16).padStart(64, '0');
    return { txHash: `0x${n}` };
  }
}

/** Worker uses the outbox as the sole maxAttempts/lease authority. */
export class MandateAnchorWorker {
  constructor(
    private readonly outbox: MandateAnchorOutbox,
    private readonly client: MandateAnchorClient,
    private readonly options: { now?: () => Date } = {},
  ) {}

  async processOnce(): Promise<MandateAnchorJob | undefined> {
    const now = this.options.now?.() ?? new Date();
    const job = await this.outbox.claimNext(now);
    if (!job) return undefined;
    if (job.status === 'failed') return job;
    if (!job.claimToken) {
      throw new DomainError('Claimed anchor job missing claimToken', 'ANCHOR_CLAIM');
    }
    const claimToken = job.claimToken;
    try {
      const result = await this.client.anchor({
        closedCheckoutHash: job.closedCheckoutHash,
        closedPaymentHash: job.closedPaymentHash,
        checkoutHash: job.checkoutHash,
        transactionIdHash: job.transactionIdHash,
        agentIdHash: job.agentIdHash,
        policyVersionHash: job.policyVersionHash,
        mandateType: job.mandateType,
      });
      return await this.outbox.markAnchored(job.id, result.txHash, claimToken, now);
    } catch (error) {
      return await this.outbox.markFailed(job.id, (error as Error).message, claimToken, now);
    }
  }
}
