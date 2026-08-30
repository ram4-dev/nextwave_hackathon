/**
 * Offline Yuno sandbox/production swap-readiness CLI (F7).
 *
 * Validates supplied env shape only — never calls external Yuno endpoints and
 * never prints secret values. Exit 0 only when providerEnv is sandbox|production
 * and live-mode shape checks pass; nonzero otherwise.
 *
 * Usage:
 *   npm run yuno:sandbox:readiness
 *   npm run yuno:sandbox:readiness -- --fixture=ready
 *   npm run yuno:sandbox:readiness -- --fixture=unready
 *
 * No-arg success requires an explicitly configured live provider mode
 * (`YUNO_PROVIDER_ENV=sandbox|production`). A scrubbed env (default mock)
 * exits 1 with NON_LIVE_PROVIDER_ENV — it never exits 0.
 *
 * `--fixture` supplies reproducible fake env for automated tests. It is not a
 * live sandbox check (`liveSandboxCheck` is always false).
 */
import {
  assessYunoSandboxCliReadiness,
  formatYunoProviderReadiness,
  type EnvLike,
} from '../src/providers/yuno/sandbox-readiness.js';

/** Distinctive fake values for offline fixture mode — not real credentials. */
const FIXTURE_READY_ENV: EnvLike = {
  YUNO_PROVIDER_ENV: 'sandbox',
  YUNO_BASE_URL: 'https://provider.example.test/v1',
  YUNO_PUBLIC_API_KEY: 'fixture_ready_public_api_key_aaaa',
  YUNO_PRIVATE_SECRET_KEY: 'fixture_ready_private_secret_key_bbbb',
  YUNO_ACCOUNT_ID: '11111111-2222-4333-8444-555555555555',
  YUNO_WEBHOOK_HMAC_SECRET: 'fixture_ready_webhook_hmac_cccc',
  PAYMENT_SECRETS_KEY:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  PAYMENT_ADMIN_API_KEY: 'fixture_ready_admin_api_key_dddd',
  PAYMENT_INTERNAL_API_KEY: 'fixture_ready_internal_api_key_eeee',
};

const FIXTURE_UNREADY_ENV: EnvLike = {
  YUNO_PROVIDER_ENV: 'sandbox',
  // Intentionally omit secrets and base URL.
};

function parseFixtureArg(argv: string[]): 'ready' | 'unready' | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--fixture=')) {
      const v = arg.slice('--fixture='.length);
      if (v === 'ready' || v === 'unready') return v;
      console.error(`Unknown fixture mode: ${v} (use ready|unready)`);
      process.exit(2);
    }
    if (arg === '--fixture') {
      const v = argv[i + 1];
      if (v === 'ready' || v === 'unready') return v;
      console.error('Missing --fixture value (ready|unready)');
      process.exit(2);
    }
  }
  const fromEnv = process.env.YUNO_READINESS_FIXTURE?.trim();
  if (fromEnv === 'ready' || fromEnv === 'unready') return fromEnv;
  return undefined;
}

function buildEnv(fixture: 'ready' | 'unready' | undefined): EnvLike {
  if (fixture === 'ready') return { ...FIXTURE_READY_ENV };
  if (fixture === 'unready') return { ...FIXTURE_UNREADY_ENV };
  return { ...process.env } as EnvLike;
}

function assertNoSecretLeak(output: string, env: EnvLike): void {
  const secretKeys = [
    'YUNO_PUBLIC_API_KEY',
    'YUNO_PRIVATE_SECRET_KEY',
    'YUNO_WEBHOOK_HMAC_SECRET',
    'PAYMENT_SECRETS_KEY',
    'PAYMENT_ADMIN_API_KEY',
    'PAYMENT_INTERNAL_API_KEY',
    'YUNO_BASE_URL',
  ] as const;
  for (const key of secretKeys) {
    const value = env[key];
    if (value && value.length > 0 && output.includes(value)) {
      console.error(`Refusing to print: output contained value of ${key}`);
      process.exit(3);
    }
  }
}

function main(): void {
  const fixture = parseFixtureArg(process.argv.slice(2));
  const env = buildEnv(fixture);
  const readiness = assessYunoSandboxCliReadiness(env);
  const output = formatYunoProviderReadiness(readiness);
  // Safe machine-readable JSON — codes/booleans only, never secret values.
  const json = JSON.stringify({
    providerEnv: readiness.providerEnv,
    ready: readiness.ready,
    liveSandboxCheck: readiness.liveSandboxCheck,
    issueCodes: readiness.issueCodes,
    missingVars: readiness.missingVars,
    invalidVars: readiness.invalidVars,
  });
  assertNoSecretLeak(output, env);
  assertNoSecretLeak(json, env);
  console.log(output);
  console.log(`json=${json}`);
  if (fixture) {
    console.log(`fixtureMode=${fixture}`);
    console.log('note=offline_fixture_not_live_sandbox');
  }
  process.exit(readiness.ready ? 0 : 1);
}

main();
