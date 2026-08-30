import { z } from 'zod';

const emptyToUndefined = (v: unknown) =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:8787'),
  KYA_ISSUER: z.string().url().default('http://localhost:8787'),
  KYA_AUDIENCE: z.string().min(1).default('kya-agent'),
  KYA_DATA_DIR: z.string().default('.kya-data'),
  CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  CHALLENGE_TTL_SECONDS: z.coerce.number().int().positive().default(120),
  KYC_TTL_DAYS: z.coerce.number().int().positive().default(365),
  /**
   * Mandate placeholder rule: max amount (major currency units) auto-approved
   * by evaluateMandate. Deliberately simple — refine once the real rule is defined.
   */
  MANDATE_MAX_AMOUNT: z.coerce.number().positive().default(500),
  /** Mock Yuno endpoint (parallel dev). Unset = local synthetic stub response. */
  YUNO_MOCK_URL: optionalUrl,
});

export type AppConfig = z.infer<typeof envSchema> & {
  /** Curated Base Sepolia Identity Registry — display-only in this build (no on-chain calls). */
  identityRegistrySepolia: `0x${string}`;
  chainIdSepolia: 84532;
};

/** Curated official ERC-8004 Identity Registry (Base Sepolia) — display-only, no live chain calls. */
export const IDENTITY_REGISTRY_SEPOLIA =
  '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    identityRegistrySepolia: IDENTITY_REGISTRY_SEPOLIA,
    chainIdSepolia: 84532,
  };
}

export function publicClientConfig(config: AppConfig) {
  return {
    issuer: config.KYA_ISSUER,
    audience: config.KYA_AUDIENCE,
    chainIdSepolia: config.chainIdSepolia,
    identityRegistrySepolia: config.identityRegistrySepolia,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    // Never expose server secrets to the browser.
  };
}
