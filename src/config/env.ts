import { z } from 'zod';
import {
  DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX,
  parseSecretsKey,
} from '../crypto/secrets-at-rest.js';
import {
  DeterministicDevAuthorizationVerifier,
  FailClosedAuthorizationVerifier,
  type AuthorizationVerifier,
} from '../domain/authorization/verifier.js';
import {
  DEV_PAYMENT_ADMIN_API_KEY,
  DEV_PAYMENT_INTERNAL_API_KEY,
  DEV_YUNO_ACCOUNT_ID,
  DEV_YUNO_PRIVATE_SECRET_KEY,
  DEV_YUNO_PUBLIC_API_KEY,
  DEV_YUNO_WEBHOOK_HMAC_SECRET,
} from './payment-dev-fixtures.js';
import {
  assessYunoProviderReadiness,
  type YunoProviderEnv,
} from '../providers/yuno/sandbox-readiness.js';

export {
  DEV_PAYMENT_ADMIN_API_KEY,
  DEV_PAYMENT_INTERNAL_API_KEY,
  DEV_YUNO_ACCOUNT_ID,
  DEV_YUNO_PRIVATE_SECRET_KEY,
  DEV_YUNO_PUBLIC_API_KEY,
  DEV_YUNO_WEBHOOK_HMAC_SECRET,
} from './payment-dev-fixtures.js';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8787),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
    KYA_ISSUER: z.string().url().default('http://localhost:8787'),
    KYA_AUDIENCE: z.string().min(1).default('kya-agent'),
    KYA_MODE: z.enum(['demo', 'live']).default('demo'),
    KYA_DATA_DIR: z.string().default('.kya-data'),
    CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    NONCE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    KYC_TTL_DAYS: z.coerce.number().int().positive().default(365),
    BASE_SEPOLIA_RPC_URL: z.string().url().optional(),
    BASE_MAINNET_RPC_URL: optionalUrl,
    DIDIT_API_KEY: optionalSecret,
    DIDIT_WORKFLOW_ID: optionalSecret,
    DIDIT_WEBHOOK_SECRET: optionalSecret,
    DIDIT_API_BASE: z
      .string()
      .url()
      .default('https://verification.didit.me/v3'),
    INCODE_API_KEY: optionalSecret,
    INCODE_API_URL: optionalUrl,
    /** Admin/session token for X-Incode-Hardware-Id on Omni API calls (get/score). */
    INCODE_HARDWARE_ID: optionalSecret,
    /** Optional OAuth Bearer for Omni API when Hardware-Id is not used. */
    INCODE_API_BEARER_TOKEN: optionalSecret,
    /**
     * Webhook auth (Incode docs: OAuth2 client-credentials Bearer OR Dashboard custom header).
     * Not HMAC.
     */
    INCODE_WEBHOOK_AUTH_MODE: z.enum(['custom_header', 'oauth_bearer']).default('custom_header'),
    INCODE_WEBHOOK_SECRET: optionalSecret,
    INCODE_WEBHOOK_SECRET_HEADER: z.string().min(1).default('x-incode-secret'),
    /** Expected Bearer access_token Incode obtains via client_credentials against your auth URL. */
    INCODE_WEBHOOK_BEARER_TOKEN: optionalSecret,
    INCODE_FLOW_ID: optionalSecret,
    VERIFF_API_KEY: optionalSecret,
    VERIFF_API_SECRET: optionalSecret,
    VERIFF_API_URL: z.string().url().default('https://stationapi.veriff.com'),
    VERIFF_WEBHOOK_SECRET: optionalSecret,
    MAINNET_PROMOTION_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    MAINNET_REGISTRY_VERIFIED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    SIWE_DOMAIN: z.string().default('localhost'),
    SIWE_URI: z.string().url().default('http://localhost:5173'),
    /** Live-only: inline ES256 private JWK JSON (secret-backed). Never put demo defaults here. */
    KYA_SIGNING_PRIVATE_JWK: optionalSecret,
    /** Live-only: filesystem path to ES256 private JWK JSON (secret-backed handle). */
    KYA_SIGNING_KEY_FILE: optionalSecret,
    CATALOG_DATABASE_URL: optionalUrl,
    CATALOG_EMBEDDING_MODEL: z
      .string()
      .min(1)
      .default('Xenova/paraphrase-multilingual-MiniLM-L12-v2'),
    CATALOG_ACP_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    CATALOG_WORKER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    CATALOG_WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(30),
    CATALOG_WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    CATALOG_ACP_RATE_LIMIT: z.coerce.number().int().positive().optional(),

    /**
     * Mandate placeholder for a *separate* authorization-policy module.
     * Must NOT be read by PaymentService as payment authorization.
     */
    MANDATE_MAX_AMOUNT: z.coerce.number().positive().default(500),

    /**
     * Provider environment/mode. Default `mock` keeps local fixture credentials.
     * `sandbox` / `production` never fall back to fixtures and fail closed when
     * explicit secrets or a secure base URL are missing/invalid.
     */
    YUNO_PROVIDER_ENV: z.enum(['mock', 'sandbox', 'production']).default('mock'),

    /** Provider-neutral base URL (mock process or real Yuno). Replaces YUNO_MOCK_URL. */
    YUNO_BASE_URL: optionalUrl,
    YUNO_PUBLIC_API_KEY: optionalString,
    YUNO_PRIVATE_SECRET_KEY: optionalString,
    /** UUID account_id for provider bodies when required. */
    YUNO_ACCOUNT_ID: optionalString,
    YUNO_WEBHOOK_HMAC_SECRET: optionalString,
    /** AES-256 key (64-char hex or base64) for vaulted_token encryption at rest. */
    PAYMENT_SECRETS_KEY: optionalString,
    PAYMENT_DATA_DIR: z.string().default('.kya-data'),
    PAYMENT_ADMIN_API_KEY: optionalString,
    PAYMENT_INTERNAL_API_KEY: optionalString,
    /** Provider HTTP timeout ms. */
    YUNO_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  })
  .superRefine((data, ctx) => {
    if (data.KYA_MODE === 'live') {
      if (!data.BASE_SEPOLIA_RPC_URL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['BASE_SEPOLIA_RPC_URL'],
          message: 'Required when KYA_MODE=live',
        });
      }
      if (!data.DIDIT_API_KEY || !data.DIDIT_WORKFLOW_ID || !data.DIDIT_WEBHOOK_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DIDIT_API_KEY'],
          message: 'Didit credentials required when KYA_MODE=live',
        });
      }
      if (!data.KYA_SIGNING_PRIVATE_JWK && !data.KYA_SIGNING_KEY_FILE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['KYA_SIGNING_PRIVATE_JWK'],
          message:
            'Live mode fail-closed: set KYA_SIGNING_PRIVATE_JWK or KYA_SIGNING_KEY_FILE (ES256 private JWK)',
        });
      }
    }
    if (data.MAINNET_PROMOTION_ENABLED && !data.MAINNET_REGISTRY_VERIFIED) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAINNET_REGISTRY_VERIFIED'],
        message: 'Mainnet gate requires MAINNET_REGISTRY_VERIFIED=true after address/version check',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  identityRegistrySepolia: `0x${string}`;
  identityRegistryMainnet: `0x${string}`;
  chainIdSepolia: 84532;
  chainIdMainnet: 8453;
  /** Parsed payment secrets key when payments are configured; undefined otherwise. */
  paymentSecretsKey?: Buffer;
  paymentsConfigured: boolean;
  YUNO_PROVIDER_ENV: YunoProviderEnv;
};

/** Curated official ERC-8004 Identity Registry addresses (verify before live use). */
export const IDENTITY_REGISTRY_SEPOLIA =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
export const IDENTITY_REGISTRY_MAINNET =
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;

function formatReadinessFailure(env: NodeJS.ProcessEnv): string {
  const readiness = assessYunoProviderReadiness(env as Record<string, string | undefined>);
  const parts = [
    `YUNO_PROVIDER_ENV=${readiness.providerEnv} is not ready for payment runtime`,
    readiness.issueCodes.length > 0 ? `issues=${readiness.issueCodes.join(',')}` : undefined,
    readiness.missingVars.length > 0
      ? `missing=${readiness.missingVars.join(',')}`
      : undefined,
    readiness.invalidVars.length > 0
      ? `invalid=${readiness.invalidVars.join(',')}`
      : undefined,
  ].filter(Boolean);
  return parts.join('; ');
}

/** Zod errors can embed received values — never surface those for payment/provider keys. */
function sanitizeConfigParseError(err: unknown): Error {
  if (!(err instanceof z.ZodError)) {
    return err instanceof Error ? err : new Error('invalid configuration');
  }
  const sensitive = new Set([
    'YUNO_BASE_URL',
    'YUNO_PUBLIC_API_KEY',
    'YUNO_PRIVATE_SECRET_KEY',
    'YUNO_ACCOUNT_ID',
    'YUNO_WEBHOOK_HMAC_SECRET',
    'PAYMENT_SECRETS_KEY',
    'PAYMENT_ADMIN_API_KEY',
    'PAYMENT_INTERNAL_API_KEY',
    'YUNO_PROVIDER_ENV',
    'DIDIT_API_KEY',
    'DIDIT_WEBHOOK_SECRET',
    'INCODE_API_KEY',
    'INCODE_WEBHOOK_SECRET',
    'INCODE_WEBHOOK_BEARER_TOKEN',
    'INCODE_API_BEARER_TOKEN',
    'INCODE_HARDWARE_ID',
    'VERIFF_API_KEY',
    'VERIFF_API_SECRET',
    'VERIFF_WEBHOOK_SECRET',
    'KYA_SIGNING_PRIVATE_JWK',
  ]);
  const paths = [
    ...new Set(
      err.issues.map((i) => String(i.path[0] ?? 'config')).filter(Boolean),
    ),
  ];
  const hasSensitive = paths.some((p) => sensitive.has(p));
  if (hasSensitive) {
    return new Error(
      `invalid configuration: ${paths.filter((p) => sensitive.has(p)).join(',')}`,
    );
  }
  return new Error(`invalid configuration: ${paths.join(',') || 'unknown'}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  let parsed: z.infer<typeof envSchema>;
  try {
    parsed = envSchema.parse(env);
  } catch (err) {
    throw sanitizeConfigParseError(err);
  }

  const providerEnv = parsed.YUNO_PROVIDER_ENV;
  const isLiveProvider = providerEnv === 'sandbox' || providerEnv === 'production';
  const isProdNode = parsed.NODE_ENV === 'production';

  // Live provider modes: assess before applying any defaults; never fixture-fallback.
  if (isLiveProvider) {
    const readiness = assessYunoProviderReadiness(env as Record<string, string | undefined>);
    if (!readiness.ready) {
      throw new Error(formatReadinessFailure(env));
    }
  }

  // Backward-compat: accept legacy YUNO_MOCK_URL if YUNO_BASE_URL unset (mock only).
  let baseUrl = parsed.YUNO_BASE_URL;
  if (!isLiveProvider && !baseUrl && env.YUNO_MOCK_URL?.trim()) {
    const legacy = optionalUrl.safeParse(env.YUNO_MOCK_URL);
    if (legacy.success) baseUrl = legacy.data;
  }

  const allowFixtures = !isLiveProvider && !isProdNode;

  const publicKey =
    parsed.YUNO_PUBLIC_API_KEY ?? (allowFixtures ? DEV_YUNO_PUBLIC_API_KEY : undefined);
  const privateKey =
    parsed.YUNO_PRIVATE_SECRET_KEY ??
    (allowFixtures ? DEV_YUNO_PRIVATE_SECRET_KEY : undefined);
  const accountId =
    parsed.YUNO_ACCOUNT_ID ?? (allowFixtures ? DEV_YUNO_ACCOUNT_ID : undefined);
  const hmacSecret =
    parsed.YUNO_WEBHOOK_HMAC_SECRET ??
    (allowFixtures ? DEV_YUNO_WEBHOOK_HMAC_SECRET : undefined);
  const adminKey =
    parsed.PAYMENT_ADMIN_API_KEY ??
    (allowFixtures ? DEV_PAYMENT_ADMIN_API_KEY : undefined);
  const internalKey =
    parsed.PAYMENT_INTERNAL_API_KEY ??
    (allowFixtures ? DEV_PAYMENT_INTERNAL_API_KEY : undefined);
  const secretsKeyRaw =
    parsed.PAYMENT_SECRETS_KEY ??
    (allowFixtures ? DEV_DEFAULT_PAYMENT_SECRETS_KEY_HEX : undefined);

  const paymentsWanted = Boolean(baseUrl);

  // NODE_ENV=production with mock provider still requires explicit secrets when payments on.
  if (isProdNode && paymentsWanted && !isLiveProvider) {
    if (!publicKey || !privateKey || !accountId || !hmacSecret) {
      throw new Error(
        'production payments require YUNO_PUBLIC_API_KEY, YUNO_PRIVATE_SECRET_KEY, YUNO_ACCOUNT_ID, YUNO_WEBHOOK_HMAC_SECRET',
      );
    }
    if (!secretsKeyRaw) {
      throw new Error('production payments require explicit PAYMENT_SECRETS_KEY');
    }
    if (!adminKey || !internalKey) {
      throw new Error(
        'production payments require explicit PAYMENT_ADMIN_API_KEY and PAYMENT_INTERNAL_API_KEY',
      );
    }
  }

  let paymentSecretsKey: Buffer | undefined;
  if (secretsKeyRaw && (paymentsWanted || allowFixtures)) {
    paymentSecretsKey = parseSecretsKey(secretsKeyRaw, 'PAYMENT_SECRETS_KEY');
  }

  const paymentsConfigured = Boolean(
    baseUrl && publicKey && privateKey && accountId && paymentSecretsKey && hmacSecret,
  );

  // Live provider: readiness already required full material; refuse incomplete runtime.
  if (isLiveProvider && !paymentsConfigured) {
    throw new Error(formatReadinessFailure(env));
  }

  return {
    ...parsed,
    YUNO_PROVIDER_ENV: providerEnv,
    YUNO_BASE_URL: baseUrl,
    YUNO_PUBLIC_API_KEY: publicKey,
    YUNO_PRIVATE_SECRET_KEY: privateKey,
    YUNO_ACCOUNT_ID: accountId,
    YUNO_WEBHOOK_HMAC_SECRET: hmacSecret,
    PAYMENT_SECRETS_KEY: secretsKeyRaw,
    PAYMENT_ADMIN_API_KEY: adminKey,
    PAYMENT_INTERNAL_API_KEY: internalKey,
    identityRegistrySepolia: IDENTITY_REGISTRY_SEPOLIA,
    identityRegistryMainnet: IDENTITY_REGISTRY_MAINNET,
    chainIdSepolia: 84532,
    chainIdMainnet: 8453,
    paymentSecretsKey,
    paymentsConfigured,
  };
}

export function isLiveConfigured(config: AppConfig): boolean {
  return config.KYA_MODE === 'live';
}

export function publicClientConfig(config: AppConfig) {
  return {
    mode: config.KYA_MODE,
    issuer: config.KYA_ISSUER,
    audience: config.KYA_AUDIENCE,
    chainIdSepolia: config.chainIdSepolia,
    chainIdMainnet: config.chainIdMainnet,
    identityRegistrySepolia: config.identityRegistrySepolia,
    identityRegistryMainnet: config.identityRegistryMainnet,
    mainnetPromotionEnabled: config.MAINNET_PROMOTION_ENABLED,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    siweDomain: config.SIWE_DOMAIN,
    siweUri: config.SIWE_URI,
    paymentsEnabled: config.paymentsConfigured,
    providerEnv: config.YUNO_PROVIDER_ENV,
    // Never expose server secrets to the browser.
  };
}

/** Build the AuthorizationVerifier for this environment. */
export function createAuthorizationVerifier(
  config: AppConfig,
  override?: AuthorizationVerifier,
): AuthorizationVerifier {
  if (override) return override;
  if (config.NODE_ENV === 'production') {
    return new FailClosedAuthorizationVerifier();
  }
  return new DeterministicDevAuthorizationVerifier();
}
