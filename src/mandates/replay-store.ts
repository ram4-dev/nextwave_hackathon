import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/state-machine.js';
import type { MandateReplayStore } from './types.js';

type ReplayState = {
  nonces: Record<string, true>;
  checkoutDrafts: Record<string, { transactionId: string; checkoutHash: string }>;
};

const emptyState = (): ReplayState => ({ nonces: {}, checkoutDrafts: {} });

export class InMemoryMandateReplayStore implements MandateReplayStore {
  private readonly state = emptyState();

  async consumeNonce(transactionId: string, nonce: string): Promise<void> {
    const key = `${transactionId}:${nonce}`;
    if (this.state.nonces[key]) throw new DomainError('Nonce already used for transaction', 'MANDATE_REPLAY');
    this.state.nonces[key] = true;
  }

  async rememberCheckoutDraft(id: string, transactionId: string, checkoutHash: string): Promise<void> {
    this.state.checkoutDrafts[id] = { transactionId, checkoutHash };
  }

  async getCheckoutDraft(id: string) {
    return this.state.checkoutDrafts[id];
  }
}

/** Local-only metadata store; it intentionally contains no JWTs, card data, or private keys. */
export class JsonFileMandateReplayStore implements MandateReplayStore {
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  private async read(): Promise<ReplayState> {
    try { return { ...emptyState(), ...JSON.parse(await readFile(this.filePath, 'utf8')) } as ReplayState; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
  }

  private async mutate<T>(fn: (state: ReplayState) => T): Promise<T> {
    const run = this.lock.then(async () => {
      const state = await this.read();
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

  async rememberCheckoutDraft(id: string, transactionId: string, checkoutHash: string): Promise<void> {
    await this.mutate((state) => { state.checkoutDrafts[id] = { transactionId, checkoutHash }; });
  }

  async getCheckoutDraft(id: string) { return (await this.read()).checkoutDrafts[id]; }
}
