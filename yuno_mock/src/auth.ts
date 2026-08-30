import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string compare where practical.
 * Different lengths still short-circuit after a dummy compare to reduce
 * trivial timing leaks; equal-length paths use timingSafeEqual.
 */
export function secureCompare(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) {
    // Touch both buffers so length mismatch is not a pure early return oracle.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function authenticateApiKeys(input: {
  expectedPublic: string;
  expectedPrivate: string;
  publicKey: string | undefined;
  privateKey: string | undefined;
}): 'ok' | 'missing' | 'invalid' {
  const { publicKey, privateKey } = input;
  if (
    publicKey === undefined ||
    publicKey.trim() === '' ||
    privateKey === undefined ||
    privateKey.trim() === ''
  ) {
    return 'missing';
  }
  const publicOk = secureCompare(input.expectedPublic, publicKey);
  const privateOk = secureCompare(input.expectedPrivate, privateKey);
  return publicOk && privateOk ? 'ok' : 'invalid';
}
