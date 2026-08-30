import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { KyaStore, Repository, DpopReplayConsumeResult } from './repository.js';
import { scrubStoreForPersistence } from './repository.js';
import {
  CasConflictError,
  compareAndSwapState,
  loadVersionedState,
  type VersionedStateBackend,
} from './cas-store.js';

export const KYA_SCHEMA_VERSION = '20260830_02';

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

export function createSupabaseServiceClient(config: AppConfig): SupabaseClient {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new DomainError('Supabase not configured', 'UNAVAILABLE');
  }
  return createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export async function checkSupabaseSchemaReady(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client
    .from('kya_schema_meta')
    .select('value')
    .eq('key', 'kya_core_version')
    .maybeSingle();
  if (error || !data) return false;
  return data.value === KYA_SCHEMA_VERSION;
}

function reviveBigints(store: KyaStore): KyaStore {
  for (const cursor of store.cursors ?? []) {
    if (typeof cursor.lastBlock === 'string') cursor.lastBlock = BigInt(cursor.lastBlock);
  }
  for (const event of store.pendingRegistryEvents ?? []) {
    if (typeof event.blockNumber === 'string') event.blockNumber = BigInt(event.blockNumber);
  }
  return store;
}

function serializeStore(store: KyaStore): Record<string, unknown> {
  const scrubbed = scrubStoreForPersistence(store);
  return JSON.parse(
    JSON.stringify(scrubbed, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Record<string, unknown>;
}

function stableStoreJson(store: KyaStore): string {
  return JSON.stringify(serializeStore(store));
}

export function createSupabaseCasBackend(client: SupabaseClient): VersionedStateBackend {
  return {
    async load() {
      const { data, error } = await client
        .from('kya_state')
        .select('version, state')
        .eq('id', 'singleton')
        .maybeSingle();
      if (error) throw new DomainError('Supabase read failed', 'UNAVAILABLE');
      if (!data) {
        return { version: 0, state: emptyStore() };
      }
      const state = reviveBigints({
        ...emptyStore(),
        ...(data.state as Partial<KyaStore>),
      });
      return { version: Number(data.version), state: scrubStoreForPersistence(state) };
    },
    async compareAndSwap(expectedVersion, nextState) {
      const scrubbed = scrubStoreForPersistence(nextState);
      const { assertStoreHasNoPrivateKeyMaterial } = await import('../credentials/signer.js');
      assertStoreHasNoPrivateKeyMaterial(scrubbed);
      const { data, error } = await client.rpc('kya_compare_and_swap_state', {
        p_expected_version: expectedVersion,
        p_state: serializeStore(scrubbed),
      });
      if (error) throw new DomainError('Supabase CAS unavailable', 'UNAVAILABLE');
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || row.ok !== true) {
        return {
          ok: false as const,
          currentVersion: Number(row?.current_version ?? expectedVersion),
        };
      }
      return { ok: true as const, version: Number(row.version) };
    },
  };
}

/**
 * Backend-only Supabase repository using a single versioned JSON aggregate
 * and optimistic CAS. Never uses multi-table replaceAll.
 */
export class SupabaseRepository implements Repository {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly backend: VersionedStateBackend;
  private cachedVersion = 0;

  constructor(private readonly client: SupabaseClient) {
    this.backend = createSupabaseCasBackend(client);
  }

  async getStore(): Promise<KyaStore> {
    const ready = await checkSupabaseSchemaReady(this.client);
    if (!ready) throw new DomainError('Supabase schema not ready', 'UNAVAILABLE');
    const loaded = await loadVersionedState(this.backend);
    this.cachedVersion = loaded.version;
    return structuredClone(loaded.state);
  }

  async saveStore(store: KyaStore): Promise<void> {
    const ready = await checkSupabaseSchemaReady(this.client);
    if (!ready) throw new DomainError('Supabase schema not ready', 'UNAVAILABLE');
    const { assertStoreHasNoPrivateKeyMaterial } = await import('../credentials/signer.js');
    assertStoreHasNoPrivateKeyMaterial(store);
    const scrubbed = scrubStoreForPersistence(store);
    assertStoreHasNoPrivateKeyMaterial(scrubbed);
    // Always load current version — never CAS from stale cachedVersion=0.
    const loaded = await loadVersionedState(this.backend);
    this.cachedVersion = loaded.version;
    try {
      this.cachedVersion = await compareAndSwapState(
        this.backend,
        loaded.version,
        scrubbed,
      );
    } catch (err) {
      if (err instanceof CasConflictError) {
        throw new DomainError('State conflict; retry from fresh load', 'CAS_CONFLICT');
      }
      throw err;
    }
  }

  /**
   * Idempotent import: load current, no-op if content matches, else CAS once.
   * Does not retry side effects.
   */
  async importStoreIdempotent(
    store: KyaStore,
  ): Promise<{ action: 'noop' | 'written'; version: number }> {
    const ready = await checkSupabaseSchemaReady(this.client);
    if (!ready) throw new DomainError('Supabase schema not ready', 'UNAVAILABLE');
    const { assertStoreHasNoPrivateKeyMaterial } = await import('../credentials/signer.js');
    assertStoreHasNoPrivateKeyMaterial(store);
    const scrubbed = scrubStoreForPersistence(store);
    assertStoreHasNoPrivateKeyMaterial(scrubbed);
    const loaded = await loadVersionedState(this.backend);
    this.cachedVersion = loaded.version;
    if (stableStoreJson(loaded.state) === stableStoreJson(scrubbed)) {
      return { action: 'noop', version: loaded.version };
    }
    try {
      const version = await compareAndSwapState(this.backend, loaded.version, scrubbed);
      this.cachedVersion = version;
      return { action: 'written', version };
    } catch (err) {
      if (err instanceof CasConflictError) {
        throw new DomainError('State conflict; retry from fresh load', 'CAS_CONFLICT');
      }
      throw err;
    }
  }

  async withLock<T>(fn: (store: KyaStore) => Promise<T> | T): Promise<T> {
    const run = this.lock.then(async () => {
      const store = await this.getStore();
      const expected = this.cachedVersion;
      const result = await fn(store);
      const scrubbed = scrubStoreForPersistence(store);
      try {
        this.cachedVersion = await compareAndSwapState(this.backend, expected, scrubbed);
      } catch (err) {
        if (err instanceof CasConflictError) {
          throw new DomainError('State conflict; retry from fresh load', 'CAS_CONFLICT');
        }
        throw err;
      }
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
  ): Promise<DpopReplayConsumeResult> {
    const { data, error } = await this.client.rpc('kya_consume_dpop_replay', {
      p_jti_hash: jtiHash,
      p_consumed_at: new Date().toISOString(),
      p_expires_at: expiresAt,
    });
    if (error) throw new DomainError('DPoP replay store unavailable', 'UNAVAILABLE');
    if (data === true || data === 'consumed') return 'consumed';
    if (data === false || data === 'replay') return 'replay';
    throw new DomainError('DPoP replay store unavailable', 'UNAVAILABLE');
  }
}
