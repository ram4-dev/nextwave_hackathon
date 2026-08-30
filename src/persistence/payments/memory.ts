import {
  emptyPaymentStore,
  normalizePaymentStore,
  type PaymentRepository,
  type PaymentStore,
} from './types.js';

/** In-memory payment repository for tests. */
export class MemoryPaymentRepository implements PaymentRepository {
  private store: PaymentStore = emptyPaymentStore();
  private lock: Promise<unknown> = Promise.resolve();

  async getStore(): Promise<PaymentStore> {
    return structuredClone(this.store);
  }

  async saveStore(store: PaymentStore): Promise<void> {
    this.store = normalizePaymentStore(structuredClone(store));
  }

  async withLock<T>(fn: (store: PaymentStore) => Promise<T> | T): Promise<T> {
    const run = this.lock.then(async () => {
      const result = await fn(this.store);
      this.store = normalizePaymentStore(this.store);
      return result;
    });
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
