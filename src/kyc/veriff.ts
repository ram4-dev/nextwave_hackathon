import { createHmac } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import { safe } from './didit.js';
import {
  mapStatus,
  type CreateKycSessionInput,
  type CreateKycSessionResult,
  type KycAdapter,
  type NormalizedKycWebhook,
} from './types.js';

/**
 * Veriff hosted sessions — production adapter with real request/response mappings.
 * Docs: https://devdocs.veriff.com/apidocs/v1sessions
 * HMAC: https://devdocs.veriff.com/v1/docs/hmac-authentication-and-endpoint-security
 * (retrieved 2026-08-29): POST /v1/sessions is the documented exception that does
 * NOT require X-HMAC-SIGNATURE. Webhooks use X-HMAC-SIGNATURE over raw body only.
 */
export const VERIFF_STATUS_MAP = {
  approved: 'verified',
  declined: 'rejected',
  resubmission_requested: 'needs_review',
  review: 'needs_review',
  expired: 'expired',
  abandoned: 'expired',
  started: 'pending',
  submitted: 'pending',
  created: 'pending',
} as const;

export class VeriffKycAdapter implements KycAdapter {
  readonly name = 'veriff' as const;

  constructor(private readonly config: AppConfig) {}

  async createSession(input: CreateKycSessionInput): Promise<CreateKycSessionResult> {
    if (!this.config.VERIFF_API_KEY) {
      throw new DomainError('Veriff live credentials not configured', 'KYC_NOT_CONFIGURED');
    }
    const bodyObj = {
      verification: {
        callback: input.callbackUrl,
        vendorData: input.vendorData,
        lang: input.language ?? 'en',
      },
    };
    const body = JSON.stringify(bodyObj);
    // Official exception: create-session requires X-AUTH-CLIENT only — no HMAC.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-AUTH-CLIENT': this.config.VERIFF_API_KEY,
    };
    const res = await fetch(`${this.config.VERIFF_API_URL}/v1/sessions`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      throw new DomainError(`Veriff session create failed: ${res.status}`, 'KYC_PROVIDER_ERROR');
    }
    let json: {
      status: string;
      verification: { id: string; url: string; status?: string };
    };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new DomainError('Malformed Veriff session response JSON', 'KYC_PROVIDER_ERROR');
    }
    if (!json.verification?.id || !json.verification?.url) {
      throw new DomainError('Malformed Veriff session response', 'KYC_PROVIDER_ERROR');
    }
    return {
      provider: this.name,
      providerSessionId: json.verification.id,
      verificationUrl: json.verification.url,
      rawStatus: json.verification.status,
    };
  }

  async verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<NormalizedKycWebhook> {
    const secret = this.config.VERIFF_WEBHOOK_SECRET ?? this.config.VERIFF_API_SECRET;
    if (!secret) {
      throw new DomainError('Veriff webhook secret not configured', 'KYC_NOT_CONFIGURED');
    }
    // Only documented webhook header — reject generic x-signature aliases.
    const signature = headers['x-hmac-signature'];
    if (!signature) {
      if (headers['x-signature']) {
        throw new DomainError(
          'Undocumented Veriff signature header rejected; use x-hmac-signature',
          'WEBHOOK_SIGNATURE',
        );
      }
      throw new DomainError('Missing Veriff webhook signature', 'WEBHOOK_SIGNATURE');
    }
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safe.equalHex(expected, signature.toLowerCase())) {
      throw new DomainError('Invalid Veriff webhook signature', 'WEBHOOK_SIGNATURE');
    }

    let payload: {
      id?: string;
      status?: string;
      verification?: { id?: string; status?: string; decision?: string };
      action?: string;
      time?: string;
    };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      throw new DomainError('Malformed Veriff webhook JSON', 'WEBHOOK_PAYLOAD');
    }
    const sessionId = payload.verification?.id ?? payload.id;
    const rawStatus =
      payload.verification?.status ??
      payload.verification?.decision ??
      payload.status ??
      payload.action;
    if (!sessionId || !rawStatus) {
      throw new DomainError('Malformed Veriff webhook payload', 'WEBHOOK_PAYLOAD');
    }
    const status = mapStatus(
      VERIFF_STATUS_MAP as unknown as Record<
        string,
        import('../domain/types.js').KycNormalizedStatus
      >,
      rawStatus,
    );
    return {
      provider: this.name,
      providerSessionId: sessionId,
      status,
      assuranceLevel: status === 'verified' ? 'veriff_idv' : undefined,
      eventId: `veriff:${sessionId}:${rawStatus}:${payload.time ?? ''}`,
      occurredAt: payload.time ?? new Date().toISOString(),
    };
  }
}
