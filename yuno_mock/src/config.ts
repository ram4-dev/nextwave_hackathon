import { z } from 'zod';
import {
  DEV_DEFAULT_SECRETS_KEY_HEX,
  parseSecretsKey,
} from './crypto/secrets-at-rest.js';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const DEFAULT_PUBLIC_KEY = 'yuno_public_test_key';
const DEFAULT_PRIVATE_KEY = 'yuno_private_test_key';
const DEFAULT_FINGERPRINT_SECRET = 'yuno_mock_fingerprint_test_secret';

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8080),
  YUNO_PUBLIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  YUNO_PRIVATE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  YUNO_MOCK_FINGERPRINT_SECRET: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** 32-byte AES key as 64-char hex or base64 — encrypts webhook signing secrets at rest. */
  YUNO_MOCK_SECRETS_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /**
   * Background work-processor poll interval (ms) for retries + async actions.
   * Safe default 1000; must be an integer in [100, 600_000].
   */
  YUNO_MOCK_WORK_POLL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(600_000)
    .default(1000),
  YUNO_STORE_BACKEND: z.enum(['memory', 'file']).default('memory'),
  YUNO_DATA_DIR: z.string().min(1).default('.yuno-data'),
});

export type MockConfig = {
  NODE_ENV: 'development' | 'test' | 'production';
  HOST: string;
  PORT: number;
  YUNO_PUBLIC_API_KEY: string;
  YUNO_PRIVATE_SECRET_KEY: string;
  YUNO_MOCK_FINGERPRINT_SECRET: string;
  /** Raw configured key material (hex/base64 string). */
  YUNO_MOCK_SECRETS_KEY: string;
  /** Parsed 32-byte AES-256 key for secret-at-rest encryption. */
  secretsKey: Buffer;
  /** Background processor poll interval in milliseconds. */
  YUNO_MOCK_WORK_POLL_MS: number;
  YUNO_STORE_BACKEND: 'memory' | 'file';
  YUNO_DATA_DIR: string;
  storeFilePath: string;
};

/**
 * Load mock configuration.
 * Dev/test: safe fixture defaults for keys + fingerprint + secrets-at-rest key.
 * Production: fail-closed — API keys, fingerprint secret, and secrets key must be explicit.
 */
export function loadMockConfig(env: NodeJS.ProcessEnv = process.env): MockConfig {
  const parsed = baseSchema.parse(env);
  const isProd = parsed.NODE_ENV === 'production';

  const publicKey = parsed.YUNO_PUBLIC_API_KEY ?? (isProd ? undefined : DEFAULT_PUBLIC_KEY);
  const privateKey =
    parsed.YUNO_PRIVATE_SECRET_KEY ?? (isProd ? undefined : DEFAULT_PRIVATE_KEY);
  const fingerprintSecret =
    parsed.YUNO_MOCK_FINGERPRINT_SECRET ?? (isProd ? undefined : DEFAULT_FINGERPRINT_SECRET);
  const secretsKeyRaw =
    parsed.YUNO_MOCK_SECRETS_KEY ?? (isProd ? undefined : DEV_DEFAULT_SECRETS_KEY_HEX);

  if (!publicKey || !privateKey) {
    throw new Error(
      'production requires explicit YUNO_PUBLIC_API_KEY and YUNO_PRIVATE_SECRET_KEY',
    );
  }
  if (!fingerprintSecret) {
    throw new Error('production requires explicit YUNO_MOCK_FINGERPRINT_SECRET');
  }
  if (!secretsKeyRaw) {
    throw new Error('production requires explicit YUNO_MOCK_SECRETS_KEY');
  }

  if (isProd && parsed.YUNO_STORE_BACKEND === 'file' && !env.YUNO_DATA_DIR?.trim()) {
    throw new Error('production file backend requires explicit YUNO_DATA_DIR');
  }

  const secretsKey = parseSecretsKey(secretsKeyRaw);

  return {
    NODE_ENV: parsed.NODE_ENV,
    HOST: parsed.HOST,
    PORT: parsed.PORT,
    YUNO_PUBLIC_API_KEY: publicKey,
    YUNO_PRIVATE_SECRET_KEY: privateKey,
    YUNO_MOCK_FINGERPRINT_SECRET: fingerprintSecret,
    YUNO_MOCK_SECRETS_KEY: secretsKeyRaw,
    secretsKey,
    YUNO_MOCK_WORK_POLL_MS: parsed.YUNO_MOCK_WORK_POLL_MS,
    YUNO_STORE_BACKEND: parsed.YUNO_STORE_BACKEND,
    YUNO_DATA_DIR: parsed.YUNO_DATA_DIR,
    storeFilePath: `${parsed.YUNO_DATA_DIR.replace(/\/$/, '')}/yuno-mock-store.json`,
  };
}

export const DEV_DEFAULT_PUBLIC_API_KEY = DEFAULT_PUBLIC_KEY;
export const DEV_DEFAULT_PRIVATE_SECRET_KEY = DEFAULT_PRIVATE_KEY;
export const DEV_DEFAULT_FINGERPRINT_SECRET = DEFAULT_FINGERPRINT_SECRET;
export { DEV_DEFAULT_SECRETS_KEY_HEX };
