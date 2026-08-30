/**
 * Sensitive material detection for:
 * - inbound /v1 JSON rejection (before any mutation)
 * - outbound/store regression scans in tests
 *
 * Never log or echo matched values — HTTP callers get a generic error only.
 */

import { Errors } from '../errors.js';

/** Keys rejected on authenticated /v1 JSON bodies at any nesting level. */
const FORBIDDEN_INPUT_KEYS = new Set([
  'pan',
  'cvv',
  'cvc',
  'card_number',
  'cardnumber',
  'primary_account_number',
  'security_code',
]);

/**
 * Documented provider/safe fields — leaf values under these keys are not
 * treated as raw PAN smuggling (iin/lfd/last4 are short; fingerprint/token opaque).
 */
const SAFE_LEAF_KEYS = new Set([
  'vaulted_token',
  'fingerprint',
  'iin',
  'lfd',
  'expiration_month',
  'expiration_year',
  'last4',
]);

export type SensitiveHit = {
  path: string;
  reason: string;
};

function normalizeKey(key: string): string {
  return key.replace(/_/g, '').toLowerCase();
}

function isForbiddenInputKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (FORBIDDEN_INPUT_KEYS.has(lower)) return true;
  return FORBIDDEN_INPUT_KEYS.has(normalizeKey(key));
}

function isSafeLeafKey(key: string): boolean {
  return SAFE_LEAF_KEYS.has(key.toLowerCase());
}

/** Luhn checksum — used so non-card numeric IDs (e.g. merchant_order_id) are not false positives. */
export function luhnValid(digits: string): boolean {
  if (!/^[0-9]+$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i)! - 48;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * True when the string contains a 13–19 digit candidate (spaces/hyphens stripped)
 * that passes Luhn — including embedded runs such as `card4111111111111111`.
 *
 * For a maximal digit run of length 13–19, only the full run is checked (so a
 * non-Luhn merchant_order_id is not rejected because a shorter window passes).
 * Runs longer than 19 are scanned with 13–19 windows.
 *
 * Canonical UUID strings are never treated as PANs: hyphen stripping would
 * otherwise concatenate adjacent decimal groups into Luhn-valid 13–19 runs.
 */
export function looksLikeRawPan(value: string): boolean {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  ) {
    return false;
  }
  const compact = value.replace(/[\s-]/g, '');
  const runs = compact.match(/[0-9]+/g);
  if (!runs) return false;

  for (const run of runs) {
    if (run.length >= 13 && run.length <= 19) {
      if (luhnValid(run)) return true;
      continue;
    }
    if (run.length > 19) {
      for (let len = 19; len >= 13; len -= 1) {
        for (let start = 0; start + len <= run.length; start += 1) {
          if (luhnValid(run.slice(start, start + len))) return true;
        }
      }
    }
  }
  return false;
}

/** Pure predicate used by middleware and tests. */
export function containsSensitiveV1Input(value: unknown): boolean {
  return findSensitiveV1Input(value) !== null;
}

function findSensitiveV1Input(value: unknown, parentKey?: string): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    if (parentKey && isSafeLeafKey(parentKey)) return null;
    if (looksLikeRawPan(value)) return 'pan-like value';
    return null;
  }

  if (typeof value === 'number') {
    if (parentKey && isSafeLeafKey(parentKey)) return null;
    const asString = String(value);
    if (/^[0-9]{13,19}$/.test(asString) && looksLikeRawPan(asString)) return 'pan-like number';
    return null;
  }

  if (typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSensitiveV1Input(item, parentKey);
      if (hit) return hit;
    }
    return null;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenInputKey(key)) return 'forbidden key';
    const hit = findSensitiveV1Input(child, key);
    if (hit) return hit;
  }
  return null;
}

/**
 * Reject sensitive instrument material in authenticated /v1 JSON bodies.
 * Throws generic INVALID_REQUEST — never includes the sensitive value or path.
 */
export function rejectSensitiveV1Body(value: unknown): void {
  if (containsSensitiveV1Input(value)) {
    throw Errors.invalidRequest('Request contains sensitive payment instrument data');
  }
}

/**
 * Recursive scan for tests / post-condition asserts (paths ok here; not for HTTP clients).
 */
export function scanForSensitiveMaterial(
  value: unknown,
  secrets: readonly string[] = [],
  path = '$',
  hits: SensitiveHit[] = [],
): SensitiveHit[] {
  if (value === null || value === undefined) return hits;

  if (typeof value === 'string') {
    for (const secret of secrets) {
      if (secret && secret.length >= 4 && value.includes(secret)) {
        hits.push({ path, reason: 'contains configured secret' });
      }
    }
    if (looksLikeRawPan(value)) {
      hits.push({ path, reason: 'value resembles raw PAN' });
    }
    return hits;
  }

  if (typeof value !== 'object') return hits;

  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForSensitiveMaterial(item, secrets, `${path}[${i}]`, hits));
    return hits;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (isForbiddenInputKey(key)) {
      hits.push({ path: childPath, reason: `forbidden key ${key}` });
    }
    if (isSafeLeafKey(key) && (typeof child === 'string' || typeof child === 'number')) {
      if (typeof child === 'string') {
        for (const secret of secrets) {
          if (secret && secret.length >= 4 && child.includes(secret)) {
            hits.push({ path: childPath, reason: 'contains configured secret' });
          }
        }
      }
      continue;
    }
    scanForSensitiveMaterial(child, secrets, childPath, hits);
  }
  return hits;
}

export function assertNoSensitiveMaterial(
  value: unknown,
  secrets: readonly string[] = [],
  label = 'payload',
): void {
  const hits = scanForSensitiveMaterial(value, secrets);
  if (hits.length > 0) {
    throw new Error(
      `${label} contains sensitive material: ${hits.map((h) => `${h.path} (${h.reason})`).join('; ')}`,
    );
  }
}
