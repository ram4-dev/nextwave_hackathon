import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import {
  DEV_PAYMENT_ADMIN_API_KEY,
  DEV_PAYMENT_INTERNAL_API_KEY,
  DEV_YUNO_ACCOUNT_ID,
  DEV_YUNO_PRIVATE_SECRET_KEY,
  DEV_YUNO_PUBLIC_API_KEY,
  DEV_YUNO_WEBHOOK_HMAC_SECRET,
} from '../src/config/payment-dev-fixtures.js';
import { DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX } from '../src/crypto/secrets-at-rest.js';
import {
  assessYunoProviderReadiness,
  assessYunoSandboxCliReadiness,
  formatYunoProviderReadiness,
} from '../src/providers/yuno/sandbox-readiness.js';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Distinctive fake sandbox values — shape-valid, not real credentials. */
const FAKE_SANDBOX = {
  YUNO_PROVIDER_ENV: 'sandbox',
  YUNO_BASE_URL: 'https://provider.example.test/v1',
  YUNO_PUBLIC_API_KEY: 'sandbox_fake_public_key_X9k2mQ',
  YUNO_PRIVATE_SECRET_KEY: 'sandbox_fake_private_key_P4n7wR',
  YUNO_ACCOUNT_ID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  YUNO_WEBHOOK_HMAC_SECRET: 'sandbox_fake_hmac_secret_H3t8uV',
  PAYMENT_SECRETS_KEY:
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  PAYMENT_ADMIN_API_KEY: 'sandbox_fake_admin_key_A1b2c3',
  PAYMENT_INTERNAL_API_KEY: 'sandbox_fake_internal_key_I4j5k6',
} as const;

const USERINFO_URL = 'https://leakuser:secretvalueZZ9@provider.example.test/v1';
const DISTINCTIVE_PRIVATE = 'sandbox_fake_private_key_P4n7wR';

const SECRET_VALUES = [
  FAKE_SANDBOX.YUNO_PUBLIC_API_KEY,
  FAKE_SANDBOX.YUNO_PRIVATE_SECRET_KEY,
  FAKE_SANDBOX.YUNO_WEBHOOK_HMAC_SECRET,
  FAKE_SANDBOX.PAYMENT_SECRETS_KEY,
  FAKE_SANDBOX.PAYMENT_ADMIN_API_KEY,
  FAKE_SANDBOX.PAYMENT_INTERNAL_API_KEY,
  FAKE_SANDBOX.YUNO_BASE_URL,
  USERINFO_URL,
  'secretvalueZZ9',
  'leakuser',
  DEV_YUNO_PUBLIC_API_KEY,
  DEV_YUNO_PRIVATE_SECRET_KEY,
  DEV_YUNO_WEBHOOK_HMAC_SECRET,
  DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX,
  DEV_PAYMENT_ADMIN_API_KEY,
  DEV_PAYMENT_INTERNAL_API_KEY,
];

function assertNoSecretInText(text: string): void {
  for (const secret of SECRET_VALUES) {
    expect(text).not.toContain(secret);
  }
}

describe('F7 Yuno provider readiness', () => {
  it('keeps mock defaults and fixture fallbacks', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      YUNO_BASE_URL: 'http://127.0.0.1:8080',
    });
    expect(config.YUNO_PROVIDER_ENV).toBe('mock');
    expect(config.paymentsConfigured).toBe(true);
    expect(config.YUNO_PUBLIC_API_KEY).toBe(DEV_YUNO_PUBLIC_API_KEY);
    expect(config.YUNO_PRIVATE_SECRET_KEY).toBe(DEV_YUNO_PRIVATE_SECRET_KEY);
    expect(config.YUNO_ACCOUNT_ID).toBe(DEV_YUNO_ACCOUNT_ID);
    expect(config.PAYMENT_ADMIN_API_KEY).toBe(DEV_PAYMENT_ADMIN_API_KEY);
    expect(config.PAYMENT_INTERNAL_API_KEY).toBe(DEV_PAYMENT_INTERNAL_API_KEY);

    const readiness = assessYunoProviderReadiness({ YUNO_PROVIDER_ENV: 'mock' });
    expect(readiness.ready).toBe(true);
    expect(readiness.liveSandboxCheck).toBe(false);
    assertNoSecretInText(formatYunoProviderReadiness(readiness));

    const cliMock = assessYunoSandboxCliReadiness({ YUNO_PROVIDER_ENV: 'mock' });
    expect(cliMock.ready).toBe(false);
    expect(cliMock.issueCodes).toContain('NON_LIVE_PROVIDER_ENV');
  });

  it('rejects sandbox mode when explicit secrets are missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        YUNO_PROVIDER_ENV: 'sandbox',
        YUNO_BASE_URL: 'https://provider.example.test',
      }),
    ).toThrow(/missing=/);

    const readiness = assessYunoProviderReadiness({
      YUNO_PROVIDER_ENV: 'sandbox',
      YUNO_BASE_URL: 'https://provider.example.test',
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.missingVars.length).toBeGreaterThan(0);
    expect(readiness.issueCodes).toContain('MISSING_YUNO_PUBLIC_API_KEY');
    assertNoSecretInText(formatYunoProviderReadiness(readiness));
  });

  it('rejects fixture defaults in sandbox/production', () => {
    const withFixtures = {
      YUNO_PROVIDER_ENV: 'sandbox',
      YUNO_BASE_URL: 'https://provider.example.test',
      YUNO_PUBLIC_API_KEY: DEV_YUNO_PUBLIC_API_KEY,
      YUNO_PRIVATE_SECRET_KEY: DEV_YUNO_PRIVATE_SECRET_KEY,
      YUNO_ACCOUNT_ID: DEV_YUNO_ACCOUNT_ID,
      YUNO_WEBHOOK_HMAC_SECRET: DEV_YUNO_WEBHOOK_HMAC_SECRET,
      PAYMENT_SECRETS_KEY: DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX,
      PAYMENT_ADMIN_API_KEY: DEV_PAYMENT_ADMIN_API_KEY,
      PAYMENT_INTERNAL_API_KEY: DEV_PAYMENT_INTERNAL_API_KEY,
    };

    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        ...withFixtures,
      }),
    ).toThrow(/FIXTURE_/);

    const readiness = assessYunoProviderReadiness(withFixtures);
    expect(readiness.ready).toBe(false);
    expect(readiness.issueCodes).toContain('FIXTURE_YUNO_PUBLIC_API_KEY');
    expect(readiness.issueCodes).toContain('FIXTURE_PAYMENT_SECRETS_KEY');
    const formatted = formatYunoProviderReadiness(readiness);
    assertNoSecretInText(formatted);
    expect(formatted).not.toContain(DEV_YUNO_PUBLIC_API_KEY);
  });

  it('rejects legacy YUNO_MOCK_URL alone in live modes with MISSING_YUNO_BASE_URL', () => {
    const liveWithLegacyOnly = {
      ...FAKE_SANDBOX,
      YUNO_BASE_URL: undefined,
      YUNO_MOCK_URL: 'https://provider.example.test/v1',
    };
    const readiness = assessYunoProviderReadiness(liveWithLegacyOnly);
    expect(readiness.ready).toBe(false);
    expect(readiness.issueCodes).toContain('MISSING_YUNO_BASE_URL');
    expect(readiness.missingVars).toContain('YUNO_BASE_URL');
    assertNoSecretInText(formatYunoProviderReadiness(readiness));

    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        YUNO_PROVIDER_ENV: 'sandbox',
        YUNO_MOCK_URL: 'https://provider.example.test/v1',
        YUNO_PUBLIC_API_KEY: FAKE_SANDBOX.YUNO_PUBLIC_API_KEY,
        YUNO_PRIVATE_SECRET_KEY: FAKE_SANDBOX.YUNO_PRIVATE_SECRET_KEY,
        YUNO_ACCOUNT_ID: FAKE_SANDBOX.YUNO_ACCOUNT_ID,
        YUNO_WEBHOOK_HMAC_SECRET: FAKE_SANDBOX.YUNO_WEBHOOK_HMAC_SECRET,
        PAYMENT_SECRETS_KEY: FAKE_SANDBOX.PAYMENT_SECRETS_KEY,
        PAYMENT_ADMIN_API_KEY: FAKE_SANDBOX.PAYMENT_ADMIN_API_KEY,
        PAYMENT_INTERNAL_API_KEY: FAKE_SANDBOX.PAYMENT_INTERNAL_API_KEY,
      }),
    ).toThrow(/MISSING_YUNO_BASE_URL/);

    // Mock mode still accepts legacy alias.
    const mockLegacy = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      YUNO_MOCK_URL: 'http://127.0.0.1:8080',
    });
    expect(mockLegacy.YUNO_BASE_URL).toBe('http://127.0.0.1:8080');
  });

  it('rejects non-UUID YUNO_ACCOUNT_ID in live modes', () => {
    const badAccount = 'not-a-uuid-account-id-ZZ';
    const readiness = assessYunoProviderReadiness({
      ...FAKE_SANDBOX,
      YUNO_ACCOUNT_ID: badAccount,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.issueCodes).toContain('INVALID_YUNO_ACCOUNT_ID');
    expect(readiness.invalidVars).toContain('YUNO_ACCOUNT_ID');
    const formatted = formatYunoProviderReadiness(readiness);
    assertNoSecretInText(formatted);
    expect(formatted).not.toContain(badAccount);

    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        ...FAKE_SANDBOX,
        YUNO_ACCOUNT_ID: badAccount,
      }),
    ).toThrow(/INVALID_YUNO_ACCOUNT_ID/);
  });

  it('rejects insecure and userinfo base URLs for sandbox without leaking values', () => {
    const insecureUrl = 'http://provider.example.test/distinctive-insecure-path';
    const insecure = assessYunoProviderReadiness({
      ...FAKE_SANDBOX,
      YUNO_BASE_URL: insecureUrl,
    });
    expect(insecure.ready).toBe(false);
    expect(insecure.issueCodes).toContain('INSECURE_YUNO_BASE_URL');

    const withUserinfo = assessYunoProviderReadiness({
      ...FAKE_SANDBOX,
      YUNO_BASE_URL: USERINFO_URL,
    });
    expect(withUserinfo.ready).toBe(false);
    expect(withUserinfo.issueCodes).toContain('YUNO_BASE_URL_USERINFO');

    let loadErr = '';
    try {
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        ...FAKE_SANDBOX,
        YUNO_BASE_URL: USERINFO_URL,
      });
    } catch (err) {
      loadErr = err instanceof Error ? err.message : String(err);
    }
    expect(loadErr).toMatch(/YUNO_BASE_URL_USERINFO/);
    expect(loadErr).not.toContain('secretvalueZZ9');
    expect(loadErr).not.toContain(USERINFO_URL);
    expect(loadErr).not.toContain(DISTINCTIVE_PRIVATE);

    const insecureOut = formatYunoProviderReadiness(insecure);
    const userinfoOut = formatYunoProviderReadiness(withUserinfo);
    assertNoSecretInText(insecureOut);
    assertNoSecretInText(userinfoOut);
    expect(insecureOut).not.toContain(insecureUrl);
    expect(userinfoOut).not.toContain(USERINFO_URL);
    expect(userinfoOut).not.toContain('secretvalueZZ9');
  });

  it('accepts fake-but-shape-valid sandbox config offline', () => {
    const readiness = assessYunoProviderReadiness({ ...FAKE_SANDBOX });
    expect(readiness.ready).toBe(true);
    expect(readiness.liveSandboxCheck).toBe(false);
    expect(readiness.providerEnv).toBe('sandbox');
    assertNoSecretInText(formatYunoProviderReadiness(readiness));

    const cli = assessYunoSandboxCliReadiness({ ...FAKE_SANDBOX });
    expect(cli.ready).toBe(true);

    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      ...FAKE_SANDBOX,
    });
    expect(config.paymentsConfigured).toBe(true);
    expect(config.YUNO_PROVIDER_ENV).toBe('sandbox');
    expect(config.YUNO_PUBLIC_API_KEY).toBe(FAKE_SANDBOX.YUNO_PUBLIC_API_KEY);
  });

  it('CLI fixture ready exits 0 without leaking secrets', () => {
    const result = spawnSync(
      'npx',
      ['tsx', 'scripts/yuno-sandbox-readiness.ts', '--fixture=ready'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, YUNO_READINESS_FIXTURE: undefined } },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ready=true');
    expect(result.stdout).toContain('liveSandboxCheck=false');
    expect(result.stdout).toMatch(/"liveSandboxCheck":false/);
    expect(result.stdout).toContain('offline_fixture_not_live_sandbox');
    assertNoSecretInText(result.stdout + result.stderr);
    expect(result.stdout + result.stderr).not.toContain('fixture_ready_public_api_key_aaaa');
    expect(result.stdout).not.toContain('https://provider.example.test');
  });

  it('CLI fixture unready exits nonzero without leaking secrets', () => {
    const result = spawnSync(
      'npx',
      ['tsx', 'scripts/yuno-sandbox-readiness.ts', '--fixture=unready'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, YUNO_READINESS_FIXTURE: undefined } },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ready=false');
    expect(result.stdout).toContain('liveSandboxCheck=false');
    expect(result.stdout).toMatch(/missingVars=/);
    expect(result.stdout).toMatch(/"liveSandboxCheck":false/);
    assertNoSecretInText(result.stdout + result.stderr);
  });

  it('CLI no-arg with scrubbed env exits 1 with NON_LIVE_PROVIDER_ENV', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, 'node_modules/tsx/dist/cli.mjs'),
        path.join(root, 'scripts/yuno-sandbox-readiness.ts'),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
        },
      },
    );
    expect(result.status).toBe(1);
    const out = result.stdout + result.stderr;
    expect(out).toContain('ready=false');
    expect(out).toContain('liveSandboxCheck=false');
    expect(out).toContain('NON_LIVE_PROVIDER_ENV');
    expect(out).not.toContain('ready=true');
    assertNoSecretInText(out);
  });

  it('loadConfig errors never embed distinctive URL userinfo or secrets', () => {
    const leakUrl = 'https://leakuser:secretvalueZZ9@provider.example.test/v1';
    let msg = '';
    try {
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        ...FAKE_SANDBOX,
        YUNO_BASE_URL: leakUrl,
      });
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toMatch(/YUNO_BASE_URL_USERINFO|issues=/);
    expect(msg).not.toContain(leakUrl);
    expect(msg).not.toContain('secretvalueZZ9');
    expect(msg).not.toContain('leakuser');
    expect(msg).not.toContain(FAKE_SANDBOX.YUNO_PRIVATE_SECRET_KEY);
    assertNoSecretInText(msg);

    let zodMsg = '';
    try {
      loadConfig({
        NODE_ENV: 'test',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        YUNO_PROVIDER_ENV: 'sandbox',
        YUNO_BASE_URL: 'not-a-valid-url-with-secretvalueZZ9',
      });
    } catch (err) {
      zodMsg = err instanceof Error ? err.message : String(err);
    }
    expect(zodMsg).toMatch(/invalid configuration/);
    expect(zodMsg).not.toContain('secretvalueZZ9');
    expect(zodMsg).not.toContain('not-a-valid-url');
  });
});
