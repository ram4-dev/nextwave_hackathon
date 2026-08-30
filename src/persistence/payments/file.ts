import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  emptyPaymentStore,
  normalizePaymentStore,
  type PaymentRepository,
  type PaymentStore,
} from './types.js';

/**
 * Atomic JSON file payment repository — separate from KYA store.json.
 * Writes via temp file + rename.
 */
export class FilePaymentRepository implements PaymentRepository {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getStore(): Promise<PaymentStore> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      return normalizePaymentStore(JSON.parse(raw) as Partial<PaymentStore>);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyPaymentStore();
      }
      throw err;
    }
  }

  async saveStore(store: PaymentStore): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(normalizePaymentStore(store), null, 2);
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, this.filePath);
  }

  async withLock<T>(fn: (store: PaymentStore) => Promise<T> | T): Promise<T> {
    const run = this.lock.then(async () => {
      const store = await this.getStore();
      const result = await fn(store);
      await this.saveStore(store);
      return result;
    });
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
