import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  AccessTokenRecord,
  AgentEnrollment,
  AuthNonce,
  DpopReplayRecord,
  EventCursor,
  KyaCredentialRecord,
  KycSessionRecord,
  Principal,
  PendingRegistryEvent,
  ProcessedEvent,
} from '../domain/types.js';

export interface KyaStore {
  principals: Principal[];
  enrollments: AgentEnrollment[];
  credentials: KyaCredentialRecord[];
  nonces: AuthNonce[];
  kycSessions: KycSessionRecord[];
  processedEvents: ProcessedEvent[];
  pendingRegistryEvents: PendingRegistryEvent[];
  cursors: EventCursor[];
  /** Public signing key metadata only — never private JWK material. */
  signingKeys: SigningKeyPublicRecord[];
  accessTokens: AccessTokenRecord[];
  dpopReplays: DpopReplayRecord[];
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

export type DpopReplayConsumeResult = 'consumed' | 'replay';

export interface Repository {
  getStore(): Promise<KyaStore>;
  saveStore(store: KyaStore): Promise<void>;
  withLock<T>(fn: (store: KyaStore) => Promise<T> | T): Promise<T>;
  /**
   * Atomically consume a DPoP proof jti hash.
   * Returns 'consumed' on first use, 'replay' if already present.
   * Throws DomainError UNAVAILABLE when the durable store cannot be reached.
   */
  consumeDpopReplayAtomic?(
    jtiHash: string,
    expiresAt: string,
  ): Promise<DpopReplayConsumeResult>;
}

function emptyStore(): KyaStore {
  return {
    principals: [],
    enrollments: [],
    credentials: [],
    nonces: [],
    kycSessions: [],
    processedEvents: [],
    pendingRegistryEvents: [],
    cursors: [],
    signingKeys: [],
    accessTokens: [],
    dpopReplays: [],
  };
}

function hashLegacyCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function normalizeEnrollment(raw: Record<string, unknown>): AgentEnrollment {
  const legacyDevice = typeof raw.deviceCode === 'string' ? raw.deviceCode : undefined;
  const legacyUser = typeof raw.userCode === 'string' ? raw.userCode : undefined;
  const deviceCodeHash =
    typeof raw.deviceCodeHash === 'string'
      ? raw.deviceCodeHash
      : legacyDevice
        ? hashLegacyCode(legacyDevice)
        : hashLegacyCode(`legacy-missing-${raw.agentUuid ?? randomUUID()}`);
  const userCodeHash =
    typeof raw.userCodeHash === 'string'
      ? raw.userCodeHash
      : legacyUser
        ? hashLegacyCode(legacyUser)
        : hashLegacyCode(`legacy-user-${raw.agentUuid ?? randomUUID()}`);
  const {
    deviceCode: _d,
    userCode: _u,
    ...rest
  } = raw as unknown as AgentEnrollment & { deviceCode?: string; userCode?: string };
  void _d;
  void _u;
  return {
    ...(rest as AgentEnrollment),
    deviceCodeHash,
    userCodeHash,
    pairingExpiresAt:
      typeof raw.pairingExpiresAt === 'string'
        ? raw.pairingExpiresAt
        : new Date(Date.now() + 600_000).toISOString(),
    pollIntervalSeconds:
      typeof raw.pollIntervalSeconds === 'number' ? raw.pollIntervalSeconds : 5,
  };
}

export function scrubStoreForPersistence(store: KyaStore): KyaStore {
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
  clone.enrollments = clone.enrollments.map((e) => {
    const normalized = normalizeEnrollment(e as unknown as Record<string, unknown>);
    const publicJwk = { ...normalized.publicJwk } as JsonWebKey;
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const) {
      delete (publicJwk as Record<string, unknown>)[field];
    }
    return { ...normalized, publicJwk };
  });
  clone.accessTokens = (clone.accessTokens ?? []).map((t) => {
    const raw = t as AccessTokenRecord & { token?: string; jwt?: string };
    const { token: _t, jwt: _j, ...rest } = raw as AccessTokenRecord & {
      token?: string;
      jwt?: string;
    };
    void _t;
    void _j;
    return rest;
  });
  return clone;
}

/** File-backed JSON repository suitable for local hackathon demo only. */
export class JsonFileRepository implements Repository {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getStore(): Promise<KyaStore> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const source = JSON.parse(raw) as Partial<KyaStore> & {
        enrollments?: Array<Record<string, unknown>>;
      };
      const parsed: KyaStore = {
        principals: source.principals ?? [],
        enrollments: (source.enrollments ?? []).map((e) =>
          normalizeEnrollment(e as unknown as Record<string, unknown>),
        ),
        credentials: source.credentials ?? [],
        nonces: source.nonces ?? [],
        kycSessions: source.kycSessions ?? [],
        processedEvents: source.processedEvents ?? [],
        pendingRegistryEvents: source.pendingRegistryEvents ?? [],
        cursors: source.cursors ?? [],
        signingKeys: source.signingKeys ?? [],
        accessTokens: source.accessTokens ?? [],
        dpopReplays: source.dpopReplays ?? [],
      };
      for (const cursor of parsed.cursors) {
        if (typeof cursor.lastBlock === 'string') {
          cursor.lastBlock = BigInt(cursor.lastBlock);
        }
      }
      for (const event of parsed.pendingRegistryEvents) {
        if (typeof event.blockNumber === 'string') {
          event.blockNumber = BigInt(event.blockNumber);
        }
      }
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
      JSON.stringify(
        scrubbed,
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        2,
      ),
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

  async consumeDpopReplayAtomic(
    jtiHash: string,
    expiresAt: string,
  ): Promise<import('./repository.js').DpopReplayConsumeResult> {
    return this.withLock(async (store) => {
      store.dpopReplays = store.dpopReplays ?? [];
      const now = Date.now();
      store.dpopReplays = store.dpopReplays.filter((r) => Date.parse(r.expiresAt) > now);
      if (store.dpopReplays.some((r) => r.jtiHash === jtiHash)) return 'replay';
      store.dpopReplays.push({
        jtiHash,
        consumedAt: new Date().toISOString(),
        expiresAt,
      });
      return 'consumed';
    });
  }
}

export class InMemoryRepository implements Repository {
  private store = emptyStore();
  private lock: Promise<unknown> = Promise.resolve();

  async getStore(): Promise<KyaStore> {
    return structuredClone(this.store);
  }

  async saveStore(store: KyaStore): Promise<void> {
    this.store = scrubStoreForPersistence(structuredClone(store));
  }

  async withLock<T>(fn: (store: KyaStore) => Promise<T> | T): Promise<T> {
    const run = this.lock.then(async () => {
      const result = await fn(this.store);
      this.store = scrubStoreForPersistence(this.store);
      return result;
    });
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async consumeDpopReplayAtomic(
    jtiHash: string,
    expiresAt: string,
  ): Promise<import('./repository.js').DpopReplayConsumeResult> {
    return this.withLock(async (store) => {
      store.dpopReplays = store.dpopReplays ?? [];
      const now = Date.now();
      store.dpopReplays = store.dpopReplays.filter((r) => Date.parse(r.expiresAt) > now);
      if (store.dpopReplays.some((r) => r.jtiHash === jtiHash)) return 'replay';
      store.dpopReplays.push({
        jtiHash,
        consumedAt: new Date().toISOString(),
        expiresAt,
      });
      return 'consumed';
    });
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function eventId(
  chainId: number,
  txHash: string,
  logIndex: number,
): string {
  return `${chainId}:${txHash.toLowerCase()}:${logIndex}`;
}
