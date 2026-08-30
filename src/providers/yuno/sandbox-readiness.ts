/**
 * Offline Yuno provider swap-readiness assessment (F7).
 *
 * Machine-safe issue codes and variable names only — never returns or logs
 * raw secret values. Does not call any external Yuno endpoint.
 */
import { DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX, parseSecretsKey } from '../../crypto/secrets-at-rest.js';
import {
  DEV_PAYMENT_ADMIN_API_KEY,
  DEV_PAYMENT_INTERNAL_API_KEY,
  DEV_YUNO_ACCOUNT_ID,
  DEV_YUNO_PRIVATE_SECRET_KEY,
  DEV_YUNO_PUBLIC_API_KEY,
  DEV_YUNO_WEBHOOK_HMAC_SECRET,
} from '../../config/payment-dev-fixtures.js';

export const YUNO_PROVIDER_ENVS = ['mock', 'sandbox', 'production'] as const;
export type YunoProviderEnv = (typeof YUNO_PROVIDER_ENVS)[number];

export type YunoReadinessIssueCode =
  | 'INVALID_YUNO_PROVIDER_ENV'
  | 'NON_LIVE_PROVIDER_ENV'
  | 'MISSING_YUNO_BASE_URL'
  | 'INVALID_YUNO_BASE_URL'
  | 'INSECURE_YUNO_BASE_URL'
  | 'YUNO_BASE_URL_USERINFO'
  | 'MISSING_YUNO_PUBLIC_API_KEY'
  | 'FIXTURE_YUNO_PUBLIC_API_KEY'
  | 'MISSING_YUNO_PRIVATE_SECRET_KEY'
  | 'FIXTURE_YUNO_PRIVATE_SECRET_KEY'
  | 'MISSING_YUNO_ACCOUNT_ID'
  | 'FIXTURE_YUNO_ACCOUNT_ID'
  | 'INVALID_YUNO_ACCOUNT_ID'
  | 'MISSING_YUNO_WEBHOOK_HMAC_SECRET'
  | 'FIXTURE_YUNO_WEBHOOK_HMAC_SECRET'
  | 'MISSING_PAYMENT_SECRETS_KEY'
  | 'FIXTURE_PAYMENT_SECRETS_KEY'
  | 'INVALID_PAYMENT_SECRETS_KEY'
  | 'MISSING_PAYMENT_ADMIN_API_KEY'
  | 'FIXTURE_PAYMENT_ADMIN_API_KEY'
  | 'MISSING_PAYMENT_INTERNAL_API_KEY'
  | 'FIXTURE_PAYMENT_INTERNAL_API_KEY';

export type YunoProviderReadiness = {
  providerEnv: YunoProviderEnv | 'unknown';
  ready: boolean;
  /** Always false — offline env-shape validation only; never a live sandbox probe. */
  liveSandboxCheck: false;
  issueCodes: YunoReadinessIssueCode[];
  missingVars: string[];
  invalidVars: string[];
};

export type EnvLike = Record<string, string | undefined>;

/** RFC 4122 UUID (versions 1–5); used for live-mode YUNO_ACCOUNT_ID. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const trimOrUndefined = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
};

export function parseYunoProviderEnv(
  raw: string | undefined,
): YunoProviderEnv | 'unknown' {
  const v = trimOrUndefined(raw) ?? 'mock';
  if ((YUNO_PROVIDER_ENVS as readonly string[]).includes(v)) {
    return v as YunoProviderEnv;
  }
  return 'unknown';
}

export function isYunoAccountIdUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Hostname only — never userinfo, path, or query. */
export function safeProviderHostname(baseUrl: string | undefined): string | undefined {
  const raw = trimOrUndefined(baseUrl);
  if (!raw) return undefined;
  try {
    return new URL(raw).hostname || undefined;
  } catch {
    return undefined;
  }
}

type SecretField = {
  envName: string;
  value: string | undefined;
  fixture: string;
  missingCode: YunoReadinessIssueCode;
  fixtureCode: YunoReadinessIssueCode;
};

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Assess whether env is shape-ready for the declared provider mode.
 * Mock mode is ready without live credentials (local fixture path).
 * Sandbox/production require explicit non-fixture secrets and HTTPS YUNO_BASE_URL
 * (legacy YUNO_MOCK_URL is not accepted in live modes).
 */
export function assessYunoProviderReadiness(env: EnvLike): YunoProviderReadiness {
  const issueCodes: YunoReadinessIssueCode[] = [];
  const missingVars: string[] = [];
  const invalidVars: string[] = [];

  const providerEnv = parseYunoProviderEnv(env.YUNO_PROVIDER_ENV);
  if (providerEnv === 'unknown') {
    issueCodes.push('INVALID_YUNO_PROVIDER_ENV');
    pushUnique(invalidVars, 'YUNO_PROVIDER_ENV');
    return {
      providerEnv,
      ready: false,
      liveSandboxCheck: false,
      issueCodes,
      missingVars,
      invalidVars,
    };
  }

  if (providerEnv === 'mock') {
    return {
      providerEnv,
      ready: true,
      liveSandboxCheck: false,
      issueCodes: [],
      missingVars: [],
      invalidVars: [],
    };
  }

  // sandbox | production — fail closed; never accept fixture defaults or YUNO_MOCK_URL.
  const baseUrl = trimOrUndefined(env.YUNO_BASE_URL);

  if (!baseUrl) {
    issueCodes.push('MISSING_YUNO_BASE_URL');
    pushUnique(missingVars, 'YUNO_BASE_URL');
  } else {
    let parsed: URL | undefined;
    try {
      parsed = new URL(baseUrl);
    } catch {
      issueCodes.push('INVALID_YUNO_BASE_URL');
      pushUnique(invalidVars, 'YUNO_BASE_URL');
    }
    if (parsed) {
      if (parsed.username || parsed.password) {
        issueCodes.push('YUNO_BASE_URL_USERINFO');
        pushUnique(invalidVars, 'YUNO_BASE_URL');
      }
      if (parsed.protocol !== 'https:') {
        issueCodes.push('INSECURE_YUNO_BASE_URL');
        pushUnique(invalidVars, 'YUNO_BASE_URL');
      }
    }
  }

  const secretFields: SecretField[] = [
    {
      envName: 'YUNO_PUBLIC_API_KEY',
      value: trimOrUndefined(env.YUNO_PUBLIC_API_KEY),
      fixture: DEV_YUNO_PUBLIC_API_KEY,
      missingCode: 'MISSING_YUNO_PUBLIC_API_KEY',
      fixtureCode: 'FIXTURE_YUNO_PUBLIC_API_KEY',
    },
    {
      envName: 'YUNO_PRIVATE_SECRET_KEY',
      value: trimOrUndefined(env.YUNO_PRIVATE_SECRET_KEY),
      fixture: DEV_YUNO_PRIVATE_SECRET_KEY,
      missingCode: 'MISSING_YUNO_PRIVATE_SECRET_KEY',
      fixtureCode: 'FIXTURE_YUNO_PRIVATE_SECRET_KEY',
    },
    {
      envName: 'YUNO_ACCOUNT_ID',
      value: trimOrUndefined(env.YUNO_ACCOUNT_ID),
      fixture: DEV_YUNO_ACCOUNT_ID,
      missingCode: 'MISSING_YUNO_ACCOUNT_ID',
      fixtureCode: 'FIXTURE_YUNO_ACCOUNT_ID',
    },
    {
      envName: 'YUNO_WEBHOOK_HMAC_SECRET',
      value: trimOrUndefined(env.YUNO_WEBHOOK_HMAC_SECRET),
      fixture: DEV_YUNO_WEBHOOK_HMAC_SECRET,
      missingCode: 'MISSING_YUNO_WEBHOOK_HMAC_SECRET',
      fixtureCode: 'FIXTURE_YUNO_WEBHOOK_HMAC_SECRET',
    },
    {
      envName: 'PAYMENT_SECRETS_KEY',
      value: trimOrUndefined(env.PAYMENT_SECRETS_KEY),
      fixture: DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX,
      missingCode: 'MISSING_PAYMENT_SECRETS_KEY',
      fixtureCode: 'FIXTURE_PAYMENT_SECRETS_KEY',
    },
    {
      envName: 'PAYMENT_ADMIN_API_KEY',
      value: trimOrUndefined(env.PAYMENT_ADMIN_API_KEY),
      fixture: DEV_PAYMENT_ADMIN_API_KEY,
      missingCode: 'MISSING_PAYMENT_ADMIN_API_KEY',
      fixtureCode: 'FIXTURE_PAYMENT_ADMIN_API_KEY',
    },
    {
      envName: 'PAYMENT_INTERNAL_API_KEY',
      value: trimOrUndefined(env.PAYMENT_INTERNAL_API_KEY),
      fixture: DEV_PAYMENT_INTERNAL_API_KEY,
      missingCode: 'MISSING_PAYMENT_INTERNAL_API_KEY',
      fixtureCode: 'FIXTURE_PAYMENT_INTERNAL_API_KEY',
    },
  ];

  for (const field of secretFields) {
    if (!field.value) {
      issueCodes.push(field.missingCode);
      pushUnique(missingVars, field.envName);
      continue;
    }
    if (field.value === field.fixture) {
      issueCodes.push(field.fixtureCode);
      pushUnique(invalidVars, field.envName);
    }
  }

  const accountId = trimOrUndefined(env.YUNO_ACCOUNT_ID);
  if (
    accountId &&
    accountId !== DEV_YUNO_ACCOUNT_ID &&
    !isYunoAccountIdUuid(accountId)
  ) {
    issueCodes.push('INVALID_YUNO_ACCOUNT_ID');
    pushUnique(invalidVars, 'YUNO_ACCOUNT_ID');
  }

  const secretsKey = trimOrUndefined(env.PAYMENT_SECRETS_KEY);
  if (secretsKey && secretsKey !== DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX) {
    try {
      parseSecretsKey(secretsKey, 'PAYMENT_SECRETS_KEY');
    } catch {
      issueCodes.push('INVALID_PAYMENT_SECRETS_KEY');
      pushUnique(invalidVars, 'PAYMENT_SECRETS_KEY');
    }
  }

  return {
    providerEnv,
    ready: issueCodes.length === 0,
    liveSandboxCheck: false,
    issueCodes,
    missingVars,
    invalidVars,
  };
}

/**
 * CLI gate for `yuno:sandbox:readiness`: success requires sandbox|production
 * plus live-mode shape readiness. Mock defaults never yield CLI exit 0.
 */
export function assessYunoSandboxCliReadiness(env: EnvLike): YunoProviderReadiness {
  const base = assessYunoProviderReadiness(env);
  if (base.providerEnv === 'sandbox' || base.providerEnv === 'production') {
    return base;
  }

  const issueCodes: YunoReadinessIssueCode[] =
    base.providerEnv === 'unknown'
      ? [...base.issueCodes]
      : ['NON_LIVE_PROVIDER_ENV'];
  const invalidVars = [...base.invalidVars];
  pushUnique(invalidVars, 'YUNO_PROVIDER_ENV');

  return {
    providerEnv: base.providerEnv,
    ready: false,
    liveSandboxCheck: false,
    issueCodes,
    missingVars: [...base.missingVars],
    invalidVars,
  };
}

/** Safe printable summary — never includes secret values. */
export function formatYunoProviderReadiness(
  readiness: YunoProviderReadiness,
): string {
  const lines = [
    `providerEnv=${readiness.providerEnv}`,
    `ready=${readiness.ready}`,
    `liveSandboxCheck=${readiness.liveSandboxCheck}`,
  ];
  if (readiness.issueCodes.length > 0) {
    lines.push(`issueCodes=${readiness.issueCodes.join(',')}`);
  }
  if (readiness.missingVars.length > 0) {
    lines.push(`missingVars=${readiness.missingVars.join(',')}`);
  }
  if (readiness.invalidVars.length > 0) {
    lines.push(`invalidVars=${readiness.invalidVars.join(',')}`);
  }
  return lines.join('\n');
}
