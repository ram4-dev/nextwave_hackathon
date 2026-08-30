import {
  validateRequest,
  validateResponse,
} from '../../src/providers/yuno/validate.js';
import type { YunoMvpOperationKey } from '../../src/providers/yuno/generated/mvp-operations.js';
import { Errors } from './errors.js';

export function requireValidRequest(
  operationKey: YunoMvpOperationKey,
  body: unknown,
  headers?: Record<string, string | undefined>,
): void {
  const result = validateRequest(operationKey, body, headers);
  if (result.ok) return;
  const detail = result.issues
    .map((i) => `${i.path || '/'} ${i.message}`)
    .join('; ');
  throw Errors.invalidRequest(detail || 'request failed contract validation');
}

export function requireValidResponse(
  operationKey: YunoMvpOperationKey,
  status: number,
  body: unknown,
): void {
  const result = validateResponse(operationKey, status, body);
  if (result.ok) return;
  const detail = result.issues
    .map((i) => `${i.path || '/'} ${i.message}`)
    .join('; ');
  throw new Error(`response failed contract validation for ${operationKey}: ${detail}`);
}

export function headerMapFromHono(c: {
  req: { header: (name: string) => string | undefined };
}): Record<string, string | undefined> {
  return {
    'public-api-key': c.req.header('public-api-key'),
    'private-secret-key': c.req.header('private-secret-key'),
    'X-Idempotency-Key': c.req.header('X-Idempotency-Key') ?? c.req.header('x-idempotency-key'),
  };
}
