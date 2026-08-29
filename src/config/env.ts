import { z } from 'zod';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

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
    /** Paymaster capability TTL (wallet may retry within window). */
    PAYMASTER_CAPABILITY_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    KYC_TTL_DAYS: z.coerce.number().int().positive().default(365),
    BASE_SEPOLIA_RPC_URL: z.string().url().optional(),
    BASE_MAINNET_RPC_URL: optionalUrl,
    PAYMASTER_PROXY_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    PAYMASTER_URL: optionalSecret,
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
    SIWB_DOMAIN: z.string().default('localhost'),
    SIWB_URI: z.string().url().default('http://localhost:5173'),
    /** Live-only: inline ES256 private JWK JSON (secret-backed). Never put demo defaults here. */
    KYA_SIGNING_PRIVATE_JWK: optionalSecret,
    /** Live-only: filesystem path to ES256 private JWK JSON (secret-backed handle). */
    KYA_SIGNING_KEY_FILE: optionalSecret,
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
    if (data.PAYMASTER_PROXY_ENABLED && !data.PAYMASTER_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PAYMASTER_URL'],
        message: 'PAYMASTER_URL required when PAYMASTER_PROXY_ENABLED=true',
      });
    }
  });

export type AppConfig = z.infer<typeof envSchema> & {
  identityRegistrySepolia: `0x${string}`;
  identityRegistryMainnet: `0x${string}`;
  chainIdSepolia: 84532;
  chainIdMainnet: 8453;
};

/** Curated official ERC-8004 Identity Registry addresses (verify before live use). */
export const IDENTITY_REGISTRY_SEPOLIA =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
export const IDENTITY_REGISTRY_MAINNET =
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    identityRegistrySepolia: IDENTITY_REGISTRY_SEPOLIA,
    identityRegistryMainnet: IDENTITY_REGISTRY_MAINNET,
    chainIdSepolia: 84532,
    chainIdMainnet: 8453,
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
    paymasterProxyEnabled: config.PAYMASTER_PROXY_ENABLED,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    siwbDomain: config.SIWB_DOMAIN,
    siwbUri: config.SIWB_URI,
    // Never expose server secrets to the browser.
  };
}
