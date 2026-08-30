import { Errors, YunoHttpError } from '../errors.js';
import type { IdempotencyRecord, YunoMockRepository } from '../persistence/types.js';

export type IdempotencyBeginResult =
  | { kind: 'acquired'; record: IdempotencyRecord }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'consumed_without_result' };

/** Non-mutating view of an existing idempotency record (no acquire). */
export type IdempotencyLookupResult =
  | { kind: 'absent' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'consumed_without_result' };

function nowIso(): string {
  return new Date().toISOString();
}

function recordKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}

function findRecord(
  records: IdempotencyRecord[],
  scope: string,
  key: string,
): IdempotencyRecord | undefined {
  return records.find((r) => r.scope === scope && r.key === key);
}

/**
 * Provider-layer idempotency (X-Idempotency-Key) per migration spec §11.
 * Persisted states: IN_PROGRESS | COMPLETED | CONSUMED_WITHOUT_RESULT.
 */
export class ProviderIdempotency {
  constructor(private readonly repo: YunoMockRepository) {}

  /**
   * Non-mutating lookup of an existing idempotency record.
   * Used so completed keys can replay (and in-progress/consumed can throw)
   * before full request/business validation — migration §11 ignores retry body.
   */
  async lookupExisting(key: string, scope = ''): Promise<IdempotencyLookupResult> {
    if (!key.trim()) {
      throw Errors.invalidRequest('X-Idempotency-Key must be non-empty when required');
    }

    const result = await this.repo.withLock((store) => {
      const existing = findRecord(store.idempotency, scope, key);
      if (!existing) {
        const absent: IdempotencyLookupResult = { kind: 'absent' };
        return absent;
      }
      if (existing.state === 'COMPLETED') {
        const replay: IdempotencyLookupResult = {
          kind: 'replay',
          status: existing.responseStatus ?? 200,
          body: structuredClone(existing.responseBody),
        };
        return replay;
      }
      if (existing.state === 'IN_PROGRESS') {
        const inProgress: IdempotencyLookupResult = { kind: 'in_progress' };
        return inProgress;
      }
      const consumed: IdempotencyLookupResult = { kind: 'consumed_without_result' };
      return consumed;
    });
    return result;
  }

  /**
   * Replay or throw when a record already exists; return absent when free.
   * Does not acquire IN_PROGRESS.
   */
  async lookupExistingOrThrow(
    key: string,
    scope = '',
  ): Promise<
    { kind: 'absent' } | { kind: 'replay'; status: number; body: unknown }
  > {
    const result = await this.lookupExisting(key, scope);
    if (result.kind === 'absent') return { kind: 'absent' };
    if (result.kind === 'replay') {
      return { kind: 'replay', status: result.status, body: result.body };
    }
    if (result.kind === 'in_progress') {
      throw Errors.requestInProcess();
    }
    throw Errors.idempotencyDuplicated();
  }

  /**
   * Begin an idempotent operation.
   * - No record → acquire IN_PROGRESS
   * - COMPLETED → stable replay
   * - IN_PROGRESS → REQUEST_IN_PROCESS
   * - CONSUMED_WITHOUT_RESULT → IDEMPOTENCY_DUPLICATED
   *
   * Rejected-before-start: do not call begin (or call releaseIfInProgress /
   * abandonWithoutConsume) so the key remains unused.
   */
  async begin(key: string, scope = ''): Promise<IdempotencyBeginResult> {
    if (!key.trim()) {
      throw Errors.invalidRequest('X-Idempotency-Key must be non-empty when required');
    }

    return this.repo.withLock((store) => {
      const existing = findRecord(store.idempotency, scope, key);
      if (!existing) {
        const ts = nowIso();
        const record: IdempotencyRecord = {
          key,
          scope,
          state: 'IN_PROGRESS',
          createdAt: ts,
          updatedAt: ts,
        };
        store.idempotency.push(record);
        return { kind: 'acquired', record: structuredClone(record) };
      }

      if (existing.state === 'COMPLETED') {
        return {
          kind: 'replay',
          status: existing.responseStatus ?? 200,
          body: structuredClone(existing.responseBody),
        };
      }
      if (existing.state === 'IN_PROGRESS') {
        return { kind: 'in_progress' };
      }
      return { kind: 'consumed_without_result' };
    });
  }

  /** Mark successful completion; subsequent begin() replays status/body. */
  async complete(
    key: string,
    responseStatus: number,
    responseBody: unknown,
    scope = '',
  ): Promise<void> {
    await this.repo.withLock((store) => {
      const existing = findRecord(store.idempotency, scope, key);
      if (!existing) {
        throw new Error(`idempotency record missing for ${recordKey(scope, key)}`);
      }
      if (existing.state !== 'IN_PROGRESS') {
        throw new Error(
          `idempotency record ${recordKey(scope, key)} is ${existing.state}, expected IN_PROGRESS`,
        );
      }
      existing.state = 'COMPLETED';
      existing.responseStatus = responseStatus;
      existing.responseBody = structuredClone(responseBody);
      existing.updatedAt = nowIso();
    });
  }

  /**
   * Key was consumed (operation started) but no stable result to replay.
   * Later retries with the same key get IDEMPOTENCY_DUPLICATED.
   */
  async consumeWithoutResult(key: string, scope = ''): Promise<void> {
    await this.repo.withLock((store) => {
      const existing = findRecord(store.idempotency, scope, key);
      if (!existing) {
        throw new Error(`idempotency record missing for ${recordKey(scope, key)}`);
      }
      if (existing.state !== 'IN_PROGRESS') {
        throw new Error(
          `idempotency record ${recordKey(scope, key)} is ${existing.state}, expected IN_PROGRESS`,
        );
      }
      existing.state = 'CONSUMED_WITHOUT_RESULT';
      existing.updatedAt = nowIso();
      delete existing.responseStatus;
      delete existing.responseBody;
    });
  }

  /**
   * Rejected before start / abandon without consuming the key.
   * Removes an IN_PROGRESS record so a valid retry may proceed.
   */
  async abandonWithoutConsume(key: string, scope = ''): Promise<void> {
    await this.repo.withLock((store) => {
      const idx = store.idempotency.findIndex((r) => r.scope === scope && r.key === key);
      if (idx < 0) return;
      const existing = store.idempotency[idx];
      if (existing?.state === 'IN_PROGRESS') {
        store.idempotency.splice(idx, 1);
      }
    });
  }

  /** Map begin() result to throw/replay for HTTP handlers. */
  async beginOrThrow(
    key: string,
    scope = '',
  ): Promise<{ kind: 'acquired' } | { kind: 'replay'; status: number; body: unknown }> {
    const result = await this.begin(key, scope);
    if (result.kind === 'acquired') return { kind: 'acquired' };
    if (result.kind === 'replay') {
      return { kind: 'replay', status: result.status, body: result.body };
    }
    if (result.kind === 'in_progress') {
      throw Errors.requestInProcess();
    }
    throw Errors.idempotencyDuplicated();
  }
}

export function assertYunoHttpError(err: unknown): asserts err is YunoHttpError {
  if (!(err instanceof YunoHttpError)) {
    throw err;
  }
}
