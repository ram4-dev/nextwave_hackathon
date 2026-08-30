import type { KycNormalizedStatus } from '../domain/types.js';

export interface CreateKycSessionInput {
  vendorData: string;
  callbackUrl?: string;
  language?: string;
}

export interface CreateKycSessionResult {
  provider: string;
  providerSessionId: string;
  verificationUrl: string;
  rawStatus?: string;
}

export interface NormalizedKycWebhook {
  provider: string;
  providerSessionId: string;
  status: KycNormalizedStatus;
  assuranceLevel?: string;
  eventId: string;
  occurredAt: string;
}

export interface KycAdapter {
  readonly name: 'didit' | 'incode' | 'veriff' | 'demo';
  createSession(input: CreateKycSessionInput): Promise<CreateKycSessionResult>;
  verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<NormalizedKycWebhook>;
}

const ALLOWED_NORMALIZED_KEYS = new Set([
  'provider',
  'providerSessionId',
  'status',
  'assuranceLevel',
  'eventId',
  'occurredAt',
]);

/** Guard: never persist full provider webhooks or raw decision payloads. */
export function assertNormalizedKycOnly(value: NormalizedKycWebhook): void {
  for (const key of Object.keys(value)) {
    if (!ALLOWED_NORMALIZED_KEYS.has(key)) {
      throw new Error(`Forbidden KYC persistence field: ${key}`);
    }
  }
  const forbidden = ['rawBody', 'raw', 'webhook', 'decision', 'payload', 'document', 'selfie', 'biometric'];
  const json = JSON.stringify(value).toLowerCase();
  for (const f of forbidden) {
    if (json.includes(`"${f}"`)) {
      throw new Error(`Forbidden KYC raw material key: ${f}`);
    }
  }
}

/** Shared status mapper helpers — provider-specific tables live in each adapter. */
export function mapStatus(
  table: Record<string, KycNormalizedStatus>,
  raw: string,
  fallback: KycNormalizedStatus = 'pending',
): KycNormalizedStatus {
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, ' ');
  for (const [k, v] of Object.entries(table)) {
    if (k.toLowerCase() === key || k.toLowerCase().replace(/_/g, ' ') === key) {
      return v;
    }
  }
  // Also try exact original
  if (table[raw]) return table[raw];
  const lower = Object.entries(table).find(([k]) => k.toLowerCase() === raw.toLowerCase());
  return lower?.[1] ?? fallback;
}
