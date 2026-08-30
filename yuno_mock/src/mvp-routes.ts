/**
 * MVP path registry — consumes the pinned generated facade (no live fetches).
 * F1 registers awareness only; business handlers arrive in F2+.
 */
import {
  getYunoMvpOperation,
  listYunoMvpOperationKeys,
} from '../../src/providers/yuno/validate.js';
import type { YunoMvpOperationKey } from '../../src/providers/yuno/generated/mvp-operations.js';

export type MvpRoute = {
  key: YunoMvpOperationKey;
  method: string;
  /** Path relative to /v1 (as in the pin, e.g. /customers). */
  path: string;
};

export function listMvpRoutes(): MvpRoute[] {
  return listYunoMvpOperationKeys().map((key) => {
    const op = getYunoMvpOperation(key);
    return {
      key,
      method: op.method.toUpperCase(),
      path: op.path.startsWith('/') ? op.path : `/${op.path}`,
    };
  });
}

/** Match a request method+pathname under /v1 against pinned MVP ops. */
export function matchMvpRoute(
  method: string,
  pathnameUnderV1: string,
): MvpRoute | undefined {
  const normalized = pathnameUnderV1.startsWith('/')
    ? pathnameUnderV1
    : `/${pathnameUnderV1}`;
  const upper = method.toUpperCase();

  for (const route of listMvpRoutes()) {
    if (route.method !== upper) continue;
    if (pathMatches(route.path, normalized)) return route;
  }
  return undefined;
}

function pathMatches(template: string, actual: string): boolean {
  const tParts = template.split('/').filter(Boolean);
  const aParts = actual.split('/').filter(Boolean);
  if (tParts.length !== aParts.length) return false;
  for (let i = 0; i < tParts.length; i += 1) {
    const t = tParts[i]!;
    const a = aParts[i]!;
    if (t.startsWith('{') && t.endsWith('}')) continue;
    if (t !== a) return false;
  }
  return true;
}
