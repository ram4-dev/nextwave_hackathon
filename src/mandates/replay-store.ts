import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/state-machine.js';
import { isDraftIdBoundToExactWindow } from './canonical.js';
import type { MandateReplayStore, StoredCheckoutDraft, StoredPaymentDraft } from './types.js';

type ReplayState = {
  nonces: Record<string, true>;
  checkoutDrafts: Record<string, StoredCheckoutDraft>;
  paymentDrafts: Record<string, StoredPaymentDraft>;
};

const emptyState = (): ReplayState => ({ nonces: {}, checkoutDrafts: {}, paymentDrafts: {} });

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function assertCheckoutRecord(id: string, record: StoredCheckoutDraft): StoredCheckoutDraft {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || !hasExactKeys(record, [
      'transactionId', 'checkoutHash', 'payloadHash', 'sub', 'aud', 'issuedAt', 'expiresAt', 'iat', 'exp',
    ])
    || typeof record.issuedAt !== 'string'
    || typeof record.expiresAt !== 'string'
  ) {
    throw new DomainError('Invalid checkout draft lineage metadata', 'CHECKOUT_DRAFT_LINEAGE');
  }
  const issuedAtMs = Date.parse(record.issuedAt);
  const expiresAtMs = Date.parse(record.expiresAt);
  if (
    !record.transactionId
    || !record.checkoutHash
    || !record.payloadHash
    || !record.sub
    || !record.aud
    || !Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= issuedAtMs
    || !Number.isSafeInteger(record.iat)
    || !Number.isSafeInteger(record.exp)
    || record.exp <= record.iat
    || Math.floor(issuedAtMs / 1000) !== record.iat
    || Math.floor(expiresAtMs / 1000) !== record.exp
    || !isDraftIdBoundToExactWindow('checkout', id, record)
  ) {
    throw new DomainError('Invalid checkout draft lineage metadata', 'CHECKOUT_DRAFT_LINEAGE');
  }
  return structuredClone(record);
}

function assertPaymentRecord(id: string, record: StoredPaymentDraft): StoredPaymentDraft {
  if (
    !record
    || typeof record !== 'object'
    || Array.isArray(record)
    || !hasExactKeys(record, [
      'transactionId', 'checkoutHash', 'checkoutMandateDraftId', 'payloadHash',
      'issuedAt', 'expiresAt', 'iat', 'exp',
    ])
    || typeof record.issuedAt !== 'string'
    || typeof record.expiresAt !== 'string'
  ) {
    throw new DomainError('Invalid payment draft lineage metadata', 'PAYMENT_DRAFT_LINEAGE');
  }
  const issuedAtMs = Date.parse(record.issuedAt);
  const expiresAtMs = Date.parse(record.expiresAt);
  if (
    !record.transactionId
    || !record.checkoutHash
    || !record.checkoutMandateDraftId
    || !record.payloadHash
    || !Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= issuedAtMs
    || !Number.isSafeInteger(record.iat)
    || !Number.isSafeInteger(record.exp)
    || record.exp <= record.iat
    || Math.floor(issuedAtMs / 1000) !== record.iat
    || Math.floor(expiresAtMs / 1000) !== record.exp
    || !isDraftIdBoundToExactWindow('payment', id, record)
  ) {
    throw new DomainError('Invalid payment draft lineage metadata', 'PAYMENT_DRAFT_LINEAGE');
  }
  return structuredClone(record);
}

export class InMemoryMandateReplayStore implements MandateReplayStore {
  private readonly state = emptyState();

  async consumeNonce(transactionId: string, nonce: string): Promise<void> {
    const key = `${transactionId}:${nonce}`;
    if (this.state.nonces[key]) throw new DomainError('Nonce already used for transaction', 'MANDATE_REPLAY');
    this.state.nonces[key] = true;
  }

  async rememberCheckoutDraft(id: string, record: StoredCheckoutDraft): Promise<void> {
    this.state.checkoutDrafts[id] = assertCheckoutRecord(id, record);
  }

  async getCheckoutDraft(id: string) {
    const record = this.state.checkoutDrafts[id];
    return record ? assertCheckoutRecord(id, record) : undefined;
  }

  async rememberPaymentDraft(id: string, record: StoredPaymentDraft): Promise<void> {
    this.state.paymentDrafts[id] = assertPaymentRecord(id, record);
  }

  async getPaymentDraft(id: string) {
    const record = this.state.paymentDrafts[id];
    return record ? assertPaymentRecord(id, record) : undefined;
  }
}

/** Local-only metadata store; it intentionally contains no JWTs, card data, or private keys. */
export class JsonFileMandateReplayStore implements MandateReplayStore {
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  private async read(): Promise<ReplayState> {
    try {
      return { ...emptyState(), ...JSON.parse(await readFile(this.filePath, 'utf8')) } as ReplayState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  private async mutate<T>(fn: (state: ReplayState) => T): Promise<T> {
    const run = this.lock.then(async () => {
      const state = await this.read();
      if (!state.paymentDrafts) state.paymentDrafts = {};
      if (!state.checkoutDrafts) state.checkoutDrafts = {};
      const result = fn(state);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
      await rename(temp, this.filePath);
      return result;
    });
    this.lock = run.then(() => undefined, () => undefined);
    return run;
  }

  async consumeNonce(transactionId: string, nonce: string): Promise<void> {
    await this.mutate((state) => {
      const key = `${transactionId}:${nonce}`;
      if (state.nonces[key]) throw new DomainError('Nonce already used for transaction', 'MANDATE_REPLAY');
      state.nonces[key] = true;
    });
  }

  async rememberCheckoutDraft(id: string, record: StoredCheckoutDraft): Promise<void> {
    await this.mutate((state) => { state.checkoutDrafts[id] = assertCheckoutRecord(id, record); });
  }

  async getCheckoutDraft(id: string) {
    const record = (await this.read()).checkoutDrafts[id];
    return record ? assertCheckoutRecord(id, record) : undefined;
  }

  async rememberPaymentDraft(id: string, record: StoredPaymentDraft): Promise<void> {
    await this.mutate((state) => { state.paymentDrafts[id] = assertPaymentRecord(id, record); });
  }

  async getPaymentDraft(id: string) {
    const record = (await this.read()).paymentDrafts?.[id];
    return record ? assertPaymentRecord(id, record) : undefined;
  }
}
