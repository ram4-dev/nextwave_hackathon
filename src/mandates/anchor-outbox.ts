import { DomainError } from '../domain/state-machine.js';

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
  status: 'pending' | 'anchored' | 'failed';
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  anchoredAt?: string;
};

export type MandateAnchorEvidence = Omit<MandateAnchorJob, 'id' | 'attempts' | 'status' | 'lastError' | 'createdAt' | 'updatedAt' | 'anchoredAt'>;

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
    if (typeof value !== 'string' || value.length < 16) {
      throw new DomainError('Anchor evidence must be opaque hashes only', 'ANCHOR_EVIDENCE');
    }
    // Reject obvious plaintext payloads (JWT-like, prompts, long free text).
    if (value.includes('.') || value.includes(' ') || value.length > 128) {
      throw new DomainError('Anchor evidence must be opaque hashes only', 'ANCHOR_EVIDENCE');
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
    void now;
    const run = this.lock.then(() => {
      for (const job of this.jobs.values()) {
        if (job.status === 'pending') {
          job.attempts += 1;
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
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('Anchor job not found', 'ANCHOR_NOT_FOUND');
    if (job.status === 'anchored') return structuredClone(job);
    job.status = 'anchored';
    job.anchoredAt = now.toISOString();
    job.updatedAt = now.toISOString();
    job.lastError = undefined;
    void txHash;
    return structuredClone(job);
  }

  async markFailed(id: string, error: string, now = new Date()): Promise<MandateAnchorJob> {
    const job = this.jobs.get(id);
    if (!job) throw new DomainError('Anchor job not found', 'ANCHOR_NOT_FOUND');
    job.status = job.attempts >= 5 ? 'failed' : 'pending';
    job.lastError = error;
    job.updatedAt = now.toISOString();
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
    return { txHash: `0xfake${this.anchored.length.toString(16).padStart(8, '0')}` };
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
