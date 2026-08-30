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
  markAnchored(id: string, txHash: string, now?: Date): Promise<MandateAnchorJob>;
  markFailed(id: string, error: string, now?: Date): Promise<MandateAnchorJob>;
  get(id: string): Promise<MandateAnchorJob>;
}

export function isStrictEvidenceHash(value: string): boolean {
  return BASE64URL_SHA256.test(value) || BYTES32_HEX.test(value);
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
      throw new DomainError('Anchor evidence must be SHA-256 base64url (43) or bytes32 hex', 'ANCHOR_EVIDENCE');
    }
  }
  if (!Number.isInteger(evidence.mandateType) || evidence.mandateType < 0 || evidence.mandateType > 255) {
    throw new DomainError('Invalid mandate type for anchor', 'ANCHOR_EVIDENCE');
  }
}

export class InMemoryMandateAnchorOutbox implements MandateAnchorOutbox {
  private readonly jobs = new Map<string, MandateAnchorJob>();
  private readonly byEvidence = new Map<string, string>();
  private lock: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private readonly options: { leaseMs?: number; maxAttempts?: number } = {}) {}

  private evidenceKey(evidence: MandateAnchorEvidence): string {
    return `${evidence.closedCheckoutHash}:${evidence.closedPaymentHash}`;
  }

  async enqueue(evidence: MandateAnchorEvidence): Promise<MandateAnchorJob> {
    assertHashOnly(evidence);
    const key = this.evidenceKey(evidence);
    const existingId = this.byEvidence.get(key);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing) return structuredClone(existing);
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
    const leaseMs = this.options.leaseMs ?? 30_000;
    const run = this.lock.then(() => {
      for (const job of this.jobs.values()) {
        const leaseExpired = job.leaseUntil ? Date.parse(job.leaseUntil) <= now.getTime() : true;
        const reclaimable = job.status === 'processing' && leaseExpired;
        if (job.status === 'pending' || reclaimable) {
          job.status = 'processing';
          job.attempts += 1;
          job.leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
          job.updatedAt = now.toISOString();
          return structuredClone(job);
        }
      }
      return undefined;
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async markAnchored(id: string, txHash: string, now = new Date()): Promise<MandateAnchorJob> {
    if (!TX_HASH.test(txHash)) throw new DomainError('Anchor txHash must be bytes32 hex', 'ANCHOR_TXHASH');
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('Anchor job not found', 'ANCHOR_NOT_FOUND');
    if (job.status === 'anchored') return structuredClone(job);
    job.status = 'anchored';
    job.txHash = txHash;
    job.anchoredAt = now.toISOString();
    job.updatedAt = now.toISOString();
    job.leaseUntil = undefined;
    job.lastError = undefined;
    return structuredClone(job);
  }

  async markFailed(id: string, error: string, now = new Date()): Promise<MandateAnchorJob> {
    const maxAttempts = this.options.maxAttempts ?? 5;
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('Anchor job not found', 'ANCHOR_NOT_FOUND');
    job.lastError = error;
    job.updatedAt = now.toISOString();
    if (job.attempts >= maxAttempts) {
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

export class MandateAnchorWorker {
  constructor(
    private readonly outbox: MandateAnchorOutbox,
    private readonly client: MandateAnchorClient,
    private readonly options: { maxAttempts?: number; now?: () => Date } = {},
  ) {}

  async processOnce(): Promise<MandateAnchorJob | undefined> {
    const now = this.options.now?.() ?? new Date();
    const job = await this.outbox.claimNext(now);
    if (!job) return undefined;
    const maxAttempts = this.options.maxAttempts ?? 5;
    if (job.attempts > maxAttempts) {
      return this.outbox.markFailed(job.id, 'max attempts exceeded', now);
    }
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
      return await this.outbox.markAnchored(job.id, result.txHash, now);
    } catch (error) {
      return await this.outbox.markFailed(job.id, (error as Error).message, now);
    }
  }
}
