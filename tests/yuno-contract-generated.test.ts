import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  YUNO_GENERATED_MANIFEST,
  YUNO_GENERATED_SOURCE_OPENAPI_SHA256,
  YUNO_MVP_OPERATION_KEYS,
  YUNO_MVP_OPERATIONS,
} from '../src/providers/yuno/generated/index.js';
import {
  getYunoMvpOperation,
  listYunoMvpOperationKeys,
  validateRequest,
  validateResponse,
} from '../src/providers/yuno/validate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const YUNO_AUTH_HEADERS = {
  'public-api-key': 'test-public-key',
  'private-secret-key': 'test-private-key',
};

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('Yuno generated contract artifacts', () => {
  it('tracks the pinned OpenAPI SHA-256 and current generated file hashes', async () => {
    const openapi = await readFile(join(root, 'contracts/yuno/openapi.json'));
    expect(sha256Hex(openapi)).toBe(YUNO_GENERATED_SOURCE_OPENAPI_SHA256);
    expect(YUNO_GENERATED_MANIFEST.sourceOpenApiSha256).toBe(YUNO_GENERATED_SOURCE_OPENAPI_SHA256);

    for (const [name, expectedHash] of Object.entries(YUNO_GENERATED_MANIFEST.fileHashes)) {
      const bytes = await readFile(join(root, 'src/providers/yuno/generated', name));
      expect(sha256Hex(bytes), name).toBe(expectedHash);
    }
  });

  it('exposes all 18 MVP operation keys from the pin', () => {
    const keys = listYunoMvpOperationKeys();
    expect(keys).toHaveLength(18);
    expect([...keys].sort()).toEqual([...YUNO_MVP_OPERATION_KEYS]);
    for (const key of keys) {
      const operation = getYunoMvpOperation(key);
      expect(operation.key).toBe(key);
      expect(operation.method).toMatch(/^(GET|POST|PATCH|DELETE)$/);
      expect(operation.path.startsWith('/')).toBe(true);
      expect(YUNO_MVP_OPERATIONS[key]).toBe(operation);
    }
  });
});

describe('Yuno validateRequest / validateResponse', () => {
  it('accepts a representative valid create-customer body with required auth headers', () => {
    const result = validateRequest(
      'create-customer',
      { merchant_customer_id: 'usr_test_001' },
      YUNO_AUTH_HEADERS,
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects invalid create-customer bodies and missing auth headers', () => {
    const missingField = validateRequest('create-customer', {}, YUNO_AUTH_HEADERS);
    expect(missingField.ok).toBe(false);
    if (!missingField.ok) {
      expect(missingField.issues.some((issue) => issue.message.includes('required'))).toBe(true);
    }

    const wrongType = validateRequest(
      'create-customer',
      { merchant_customer_id: 42 },
      YUNO_AUTH_HEADERS,
    );
    expect(wrongType.ok).toBe(false);

    const missingHeaders = validateRequest('create-customer', {
      merchant_customer_id: 'usr_test_001',
    });
    expect(missingHeaders.ok).toBe(false);
    if (!missingHeaders.ok) {
      expect(
        missingHeaders.issues.some((issue) => issue.path.includes('public-api-key')),
      ).toBe(true);
      expect(
        missingHeaders.issues.some((issue) => issue.path.includes('private-secret-key')),
      ).toBe(true);
    }
  });

  it('requires X-Idempotency-Key for create-payment and validates the pinned request schema', () => {
    const validBody = {
      account_id: '493e9374-510a-4201-9e09-de669d75f256',
      description: 'Test Payment',
      country: 'CO',
      merchant_order_id: 'order-001',
      amount: { currency: 'COP', value: 1250.0 },
      payment_method: {
        type: 'CARD',
        vaulted_token: '12345678-1234-1234-1234-123456789abc',
      },
      // Pin lists checkout in required[]; description text contradicts for DIRECT.
      checkout: {},
    };

    const missingIdempotency = validateRequest('create-payment', validBody, YUNO_AUTH_HEADERS);
    expect(missingIdempotency.ok).toBe(false);
    if (!missingIdempotency.ok) {
      expect(
        missingIdempotency.issues.some((issue) => issue.path.includes('X-Idempotency-Key')),
      ).toBe(true);
    }

    const valid = validateRequest('create-payment', validBody, {
      ...YUNO_AUTH_HEADERS,
      'X-Idempotency-Key': '11111111-1111-1111-1111-111111111111',
    });
    expect(valid).toEqual({ ok: true });

    const missingCheckout = validateRequest(
      'create-payment',
      {
        account_id: '493e9374-510a-4201-9e09-de669d75f256',
        description: 'Test Payment',
        country: 'CO',
        merchant_order_id: 'order-001',
        amount: { currency: 'COP', value: 1250.0 },
        payment_method: { type: 'CARD' },
      },
      {
        ...YUNO_AUTH_HEADERS,
        'X-Idempotency-Key': '11111111-1111-1111-1111-111111111111',
      },
    );
    expect(missingCheckout.ok).toBe(false);
  });

  it('validates create-customer success responses and rejects undocumented statuses', () => {
    const okResponse = validateResponse('create-customer', 201, {
      id: 'bf64527c-5531-4ece-bf2c-51a8e775d8e1',
      merchant_customer_id: 'usr_test_001',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.com',
    });
    expect(okResponse).toEqual({ ok: true });

    const badStatus = validateResponse('create-customer', 204, null);
    expect(badStatus.ok).toBe(false);

    const badBody = validateResponse('create-customer', 201, 'not-an-object');
    expect(badBody.ok).toBe(false);
  });

  it('declares idempotency on every MVP operation that requires X-Idempotency-Key in the pin', () => {
    const withIdempotency = YUNO_MVP_OPERATION_KEYS.filter((key) =>
      YUNO_MVP_OPERATIONS[key].requiredHeaders.some(
        (header) => header.name === 'X-Idempotency-Key' && header.required,
      ),
    );
    expect(withIdempotency.length).toBeGreaterThan(0);
    for (const key of withIdempotency) {
      const result = validateRequest(key, YUNO_MVP_OPERATIONS[key].requestSchema ? {} : undefined, {
        ...YUNO_AUTH_HEADERS,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.some((issue) => issue.path.includes('X-Idempotency-Key'))).toBe(true);
      }
    }
  });
});
