import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentEnrollment,
  AuthNonce,
  KyaCredentialRecord,
  Principal,
} from '../domain/types.js';

export interface KyaStore {
  principals: Principal[];
  enrollments: AgentEnrollment[];
  credentials: KyaCredentialRecord[];
  nonces: AuthNonce[];
  /** Public signing key metadata only — never private JWK material. */
  signingKeys: SigningKeyPublicRecord[];
}

/** Persisted platform signing key metadata (JWKS). Private keys stay out of the store. */
export interface SigningKeyPublicRecord {
  kid: string;
  publicJwk: JsonWebKey;
  createdAt: string;
  active: boolean;
}

/** @deprecated Use SigningKeyPublicRecord — kept as alias during migration. */
export type SigningKeyRecord = SigningKeyPublicRecord;

export interface Repository {
  getStore(): Promise<KyaStore>;
  saveStore(store: KyaStore): Promise<void>;
  withLock<T>(fn: (store: KyaStore) => Promise<T> | T): Promise<T>;
}

function emptyStore(): KyaStore {
  return {
    principals: [],
    enrollments: [],
    credentials: [],
    nonces: [],
    signingKeys: [],
  };
}

function scrubStoreForPersistence(store: KyaStore): KyaStore {
  const clone = structuredClone(store);
  clone.signingKeys = clone.signingKeys.map((k) => {
    const raw = k as SigningKeyPublicRecord & { privateJwk?: unknown };
    const { privateJwk: _drop, ...rest } = raw;
    void _drop;
    const publicJwk = { ...rest.publicJwk } as JsonWebKey;
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const) {
      delete (publicJwk as Record<string, unknown>)[field];
    }
    return {
      kid: rest.kid,
      publicJwk,
      createdAt: rest.createdAt,
      active: rest.active,
    };
  });
  return clone;
}

/** File-backed JSON repository suitable for local hackathon MVP. */
export class JsonFileRepository implements Repository {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getStore(): Promise<KyaStore> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = { ...emptyStore(), ...JSON.parse(raw) } as KyaStore;
      return scrubStoreForPersistence(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyStore();
      }
      throw err;
    }
  }

  async saveStore(store: KyaStore): Promise<void> {
    const { assertStoreHasNoPrivateKeyMaterial } = await import(
      '../credentials/signer.js'
    );
    const scrubbed = scrubStoreForPersistence(store);
    assertStoreHasNoPrivateKeyMaterial(scrubbed);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify(scrubbed, null, 2),
      'utf8',
    );
    await rename(tmp, this.filePath);
  }

  async withLock<T>(fn: (store: KyaStore) => Promise<T> | T): Promise<T> {
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

export class InMemoryRepository implements Repository {
  private store = emptyStore();
  private lock: Promise<unknown> = Promise.resolve();

  async getStore(): Promise<KyaStore> {
    return structuredClone(this.store);
  }

  async saveStore(store: KyaStore): Promise<void> {
    this.store = structuredClone(store);
  }

  async withLock<T>(fn: (store: KyaStore) => Promise<T> | T): Promise<T> {
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

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}
