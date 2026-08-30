import { emptyStore, type YunoMockRepository, type YunoMockStore } from './types.js';

/** In-memory repository for tests and ephemeral local runs. */
export class InMemoryYunoRepository implements YunoMockRepository {
  private store = emptyStore();
  private lock: Promise<unknown> = Promise.resolve();

  async getStore(): Promise<YunoMockStore> {
    return structuredClone(this.store);
  }

  async saveStore(store: YunoMockStore): Promise<void> {
    this.store = structuredClone(store);
  }

  async withLock<T>(fn: (store: YunoMockStore) => Promise<T> | T): Promise<T> {
    const run = this.lock.then(async () => {
      const result = await fn(this.store);
      return result;
    });
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
