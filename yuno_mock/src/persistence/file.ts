import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertNoCleartextWebhookSecrets,
  emptyStore,
  migrateWebhookSecretsInPlace,
  normalizeStore,
  type YunoMockRepository,
  type YunoMockStore,
} from './types.js';

/**
 * File-backed atomic JSON repository for the Yuno mock.
 * Separate from KYA store.json. Writes via temp file + rename.
 * Webhook HMAC secrets are migrated to AES-256-GCM blobs on load and
 * never written as cleartext.
 */
export class FileYunoRepository implements YunoMockRepository {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly secretsKey: Buffer,
  ) {}

  async getStore(): Promise<YunoMockStore> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const store = normalizeStore(JSON.parse(raw) as Partial<YunoMockStore>);
      migrateWebhookSecretsInPlace(store, this.secretsKey);
      return store;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyStore();
      }
      throw err;
    }
  }

  async saveStore(store: YunoMockStore): Promise<void> {
    migrateWebhookSecretsInPlace(store, this.secretsKey);
    assertNoCleartextWebhookSecrets(store);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(store, null, 2);
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, this.filePath);
  }

  async withLock<T>(fn: (store: YunoMockStore) => Promise<T> | T): Promise<T> {
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
