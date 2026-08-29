import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import {
  mapStatus,
  type CreateKycSessionInput,
  type CreateKycSessionResult,
  type KycAdapter,
  type NormalizedKycWebhook,
} from './types.js';

/**
 * Didit session statuses → normalized.
 * Source (2026-08-29): https://docs.didit.me/integration/verification-statuses
 * Exact case-sensitive labels including Abandoned / Kyc Expired / Awaiting User.
 */
export const DIDIT_STATUS_MAP = {
  'Not Started': 'pending',
  'In Progress': 'pending',
  'Awaiting User': 'pending',
  Approved: 'verified',
  Declined: 'rejected',
  'In Review': 'needs_review',
  Expired: 'expired',
  Abandoned: 'expired',
  'Kyc Expired': 'expired',
  Resubmitted: 'pending',
} as const;

export const DIDIT_TIMESTAMP_SKEW_SECONDS = 300;

export function equalHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a.toLowerCase(), 'utf8');
    const bb = Buffer.from(b.toLowerCase(), 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export const safe = { equalHex };

/**
 * Match Didit's float normalisation: whole-valued floats are serialised as ints.
 * https://docs.didit.me/integration/webhooks
 */
export function shortenFloats(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(shortenFloats);
  if (data !== null && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => [
        key,
        shortenFloats(value),
      ]),
    );
  }
  if (typeof data === 'number' && !Number.isInteger(data) && data % 1 === 0) {
    return Math.trunc(data);
  }
  return data;
}

/** Recursively sort object keys; arrays preserve order. */
export function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === 'object') {
    return Object.keys(obj as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((obj as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return obj;
}

/**
 * Didit X-Signature-V2 canonical JSON: recursively sorted keys, compact separators,
 * Unicode preserved (JSON.stringify default / ensure_ascii=False).
 */
export function diditCanonicalJsonV2(payload: unknown): string {
  return JSON.stringify(sortKeys(shortenFloats(payload)));
}

function stripShaPrefix(sig: string): string {
  return sig.replace(/^sha256=/i, '');
}

function assertTimestampFresh(
  timestampHeader: string | undefined,
  nowSeconds: number,
): number {
  if (timestampHeader == null || timestampHeader === '') {
    throw new DomainError('Missing Didit X-Timestamp', 'WEBHOOK_TIMESTAMP');
  }
  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) {
    throw new DomainError('Invalid Didit X-Timestamp', 'WEBHOOK_TIMESTAMP');
  }
  if (Math.abs(nowSeconds - ts) > DIDIT_TIMESTAMP_SKEW_SECONDS) {
    throw new DomainError('Didit webhook timestamp outside allowed window', 'WEBHOOK_TIMESTAMP');
  }
  return ts;
}

function signaturesMatch(expectedHex: string, provided: string): boolean {
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(stripShaPrefix(provided), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyDiditSignatureV2(
  payload: unknown,
  signatureHeader: string,
  secret: string,
): boolean {
  const canonical = diditCanonicalJsonV2(payload);
  const expected = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return signaturesMatch(expected, signatureHeader);
}

export function verifyDiditSignatureRaw(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return signaturesMatch(expected, signatureHeader);
}

export class DiditKycAdapter implements KycAdapter {
  readonly name = 'didit' as const;

  constructor(private readonly config: AppConfig) {}

  async createSession(input: CreateKycSessionInput): Promise<CreateKycSessionResult> {
    if (!this.config.DIDIT_API_KEY || !this.config.DIDIT_WORKFLOW_ID) {
      throw new DomainError('Didit live credentials not configured', 'KYC_NOT_CONFIGURED');
    }
    const res = await fetch(`${this.config.DIDIT_API_BASE}/session/`, {
      method: 'POST',
      headers: {
        'x-api-key': this.config.DIDIT_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workflow_id: this.config.DIDIT_WORKFLOW_ID,
        vendor_data: input.vendorData,
        callback: input.callbackUrl,
        language: input.language ?? 'en',
      }),
    });
    if (!res.ok) {
      throw new DomainError(`Didit session create failed: ${res.status}`, 'KYC_PROVIDER_ERROR');
    }
    const body = (await res.json()) as {
      session_id: string;
      url: string;
      status?: string;
    };
    return {
      provider: this.name,
      providerSessionId: body.session_id,
      verificationUrl: body.url,
      rawStatus: body.status,
    };
  }

  /**
   * Official Didit webhook verification (https://docs.didit.me/integration/webhooks):
   * 1. Require X-Timestamp; reject abs(now - ts) > 300
   * 2. Prefer X-Signature-V2 over canonical sorted Unicode JSON
   * 3. Fallback to X-Signature over exact rawBody
   * 4. Reject X-Signature-Simple (does not authenticate decision) and undocumented aliases
   */
  async verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
    opts?: { nowSeconds?: number },
  ): Promise<NormalizedKycWebhook> {
    const secret = this.config.DIDIT_WEBHOOK_SECRET;
    if (!secret) {
      throw new DomainError('Didit webhook secret not configured', 'KYC_NOT_CONFIGURED');
    }

    // Reject undocumented alias explicitly if present without a documented scheme.
    if (headers['x-didit-signature'] && !headers['x-signature-v2'] && !headers['x-signature']) {
      throw new DomainError(
        'Undocumented Didit signature header rejected',
        'WEBHOOK_SIGNATURE',
      );
    }

    if (headers['x-signature-simple'] && !headers['x-signature-v2'] && !headers['x-signature']) {
      throw new DomainError(
        'X-Signature-Simple is not accepted for KYA decision webhooks',
        'WEBHOOK_SIGNATURE',
      );
    }

    const nowSeconds = opts?.nowSeconds ?? Math.floor(Date.now() / 1000);
    assertTimestampFresh(headers['x-timestamp'], nowSeconds);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      throw new DomainError('Malformed Didit webhook JSON', 'WEBHOOK_PAYLOAD');
    }

    const sigV2 = headers['x-signature-v2'];
    const sigRaw = headers['x-signature'];

    let verified = false;
    if (sigV2) {
      verified = verifyDiditSignatureV2(payload, sigV2, secret);
    }
    if (!verified && sigRaw) {
      verified = verifyDiditSignatureRaw(rawBody, sigRaw, secret);
    }
    if (!verified) {
      throw new DomainError('Invalid Didit webhook signature', 'WEBHOOK_SIGNATURE');
    }

    const body = payload as {
      session_id?: string;
      status?: string;
      decision?: string;
      event_id?: string;
      webhook_type?: string;
      created_at?: string;
      timestamp?: string;
    };
    const sessionId = body.session_id;
    const rawStatus = body.status ?? body.decision;
    if (!sessionId || !rawStatus) {
      throw new DomainError('Malformed Didit webhook payload', 'WEBHOOK_PAYLOAD');
    }
    const status = mapStatus(
      DIDIT_STATUS_MAP as unknown as Record<
        string,
        import('../domain/types.js').KycNormalizedStatus
      >,
      rawStatus,
    );
    return {
      provider: this.name,
      providerSessionId: sessionId,
      status,
      assuranceLevel: status === 'verified' ? 'didit_v3_kyc' : undefined,
      eventId: body.event_id ?? `didit:${sessionId}:${rawStatus}:${body.timestamp ?? ''}`,
      occurredAt: body.created_at ?? body.timestamp ?? new Date().toISOString(),
    };
  }
}
