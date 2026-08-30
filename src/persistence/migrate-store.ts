/**
 * Testable migrate helpers — never print secrets; never touch remote without caller.
 */
import type { KyaStore } from './repository.js';
import { assertPublicEcP256Jwk } from '../crypto/local-agent-key.js';

export const FORBIDDEN_MIGRATE_KEYS = [
  'deviceCode',
  'userCode',
  'accessToken',
  'cdpAccessToken',
  'otp',
  'email',
  'privateJwk',
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'oth',
  'k',
  'token',
  'jwt',
  'authorization',
] as const;

export function assertNoForbiddenMigrateMaterial(value: unknown, trail = ''): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenMigrateMaterial(v, `${trail}[${i}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if ((FORBIDDEN_MIGRATE_KEYS as readonly string[]).includes(k)) {
        throw new Error(`Forbidden material at ${trail}.${k}`);
      }
      if (k === 'publicJwk' && v && typeof v === 'object') {
        assertPublicEcP256Jwk(v as JsonWebKey);
      }
      assertNoForbiddenMigrateMaterial(v, `${trail}.${k}`);
    }
  }
}

export function validateImportStore(raw: KyaStore): KyaStore {
  assertNoForbiddenMigrateMaterial(raw);
  for (const enrollment of raw.enrollments ?? []) {
    assertPublicEcP256Jwk(enrollment.publicJwk);
  }
  return raw;
}

export type ImportTarget = {
  importStoreIdempotent(store: KyaStore): Promise<{ action: 'noop' | 'written'; version: number }>;
};

export async function importStoreWithOptions(
  target: ImportTarget,
  store: KyaStore,
  opts: { dryRun?: boolean } = {},
): Promise<{ action: 'noop' | 'written' | 'dry-run'; version?: number }> {
  const validated = validateImportStore(store);
  if (opts.dryRun) return { action: 'dry-run' };
  const result = await target.importStoreIdempotent(validated);
  return result;
}
