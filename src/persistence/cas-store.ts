import type { KyaStore } from './repository.js';
import { DomainError } from '../domain/state-machine.js';

export class CasConflictError extends DomainError {
  constructor(readonly currentVersion: number) {
    super('Optimistic concurrency conflict', 'CAS_CONFLICT');
    this.name = 'CasConflictError';
  }
}

export type VersionedState = { version: number; state: KyaStore };

export type VersionedStateBackend = {
  load(): Promise<VersionedState>;
  compareAndSwap(
    expectedVersion: number,
    nextState: KyaStore,
  ): Promise<{ ok: true; version: number } | { ok: false; currentVersion: number }>;
};

export async function loadVersionedState(
  backend: VersionedStateBackend,
): Promise<VersionedState> {
  return backend.load();
}

/**
 * Persist via optimistic CAS. Does not retry — callers must not re-run
 * side-effecting callbacks after a conflict.
 */
export async function compareAndSwapState(
  backend: VersionedStateBackend,
  expectedVersion: number,
  nextState: KyaStore,
): Promise<number> {
  const result = await backend.compareAndSwap(expectedVersion, nextState);
  if (!result.ok) throw new CasConflictError(result.currentVersion);
  return result.version;
}
