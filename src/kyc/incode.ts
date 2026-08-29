import type { AppConfig } from '../config/env.js';
import type { KycNormalizedStatus } from '../domain/types.js';
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
 * Incode Omni webhook lifecycle / review signals.
 *
 * ONBOARDING_FINISHED is lifecycle-complete only — NOT proof of approval.
 * verified requires MANUAL_REVIEW_APPROVED or a fetched overall.status of OK
 * from GET /omni/get/score?id=…
 * Docs: https://developer.incode.com/docs/onboarding-status-webhook
 * Scores: https://developer.incode.com/api-reference/get-score/
 */
export const INCODE_STATUS_MAP = {
  ONBOARDING_FINISHED: 'pending',
  FACE_VALIDATION_FINISHED: 'pending',
  ID_VALIDATION_FINISHED: 'pending',
  MANUAL_REVIEW_APPROVED: 'verified',
  MANUAL_REVIEW_REJECTED: 'rejected',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  UNKNOWN: 'pending',
  IN_PROGRESS: 'pending',
  NEEDS_REVIEW: 'needs_review',
} as const;

/** Statuses that are definitive from the webhook alone (no score fetch required). */
const DEFINITIVE_WEBHOOK_STATUSES = new Set([
  'MANUAL_REVIEW_APPROVED',
  'MANUAL_REVIEW_REJECTED',
  'REJECTED',
  'EXPIRED',
]);

/**
 * Lifecycle-complete signals that still need GET /omni/get/score validation
 * before any verified/rejected normalization.
 */
const REQUIRES_DECISION_FETCH = new Set(['ONBOARDING_FINISHED']);

export interface IncodeDecisionSummary {
  /** Normalized outcome only — never store raw provider score bodies. */
  status: KycNormalizedStatus;
  assuranceLevel?: string;
  /** Non-PII overall.status label only (e.g. OK/FAIL), for eventId — not raw scores. */
  outcomeLabel?: string;
}

export type IncodeDecisionFetcher = (
  interviewId: string,
) => Promise<IncodeDecisionSummary>;

/**
 * Map Incode GET /omni/get/score `overall.status` → normalized status.
 * Official enum: OK | WARN | FAIL | UNKNOWN | MANUAL | MANUAL_OK | MANUAL_FAIL | MANUAL_PENDING
 * Raw numeric scores and nested check payloads are discarded.
 */
export function normalizeIncodeOverallStatus(
  overallStatus: string | undefined | null,
): IncodeDecisionSummary {
  const raw = (overallStatus ?? '').toString().trim().toUpperCase();
  if (!raw) return { status: 'pending' };

  if (raw === 'OK' || raw === 'MANUAL_OK') {
    return {
      status: 'verified',
      assuranceLevel: 'incode_omni',
      outcomeLabel: raw,
    };
  }
  if (raw === 'FAIL' || raw === 'MANUAL_FAIL') {
    return { status: 'rejected', outcomeLabel: raw };
  }
  if (raw === 'WARN' || raw === 'MANUAL' || raw === 'MANUAL_PENDING') {
    return { status: 'needs_review', outcomeLabel: raw };
  }
  if (raw === 'UNKNOWN') {
    return { status: 'pending', outcomeLabel: raw };
  }
  return { status: 'pending', outcomeLabel: raw };
}

/** @deprecated Prefer normalizeIncodeOverallStatus — kept for narrow overall.status extraction. */
export function normalizeIncodeDecisionScores(decision: {
  overall?: { status?: string; value?: string };
  overallStatus?: string;
}): IncodeDecisionSummary {
  return normalizeIncodeOverallStatus(
    decision.overall?.status ?? decision.overallStatus,
  );
}

function equalSecret(a: string, b: string): boolean {
  return safe.equalHex(
    Buffer.from(a, 'utf8').toString('hex'),
    Buffer.from(b, 'utf8').toString('hex'),
  );
}

export class IncodeKycAdapter implements KycAdapter {
  readonly name = 'incode' as const;
  private readonly fetchDecision: IncodeDecisionFetcher;

  constructor(
    private readonly config: AppConfig,
    opts?: { fetchDecision?: IncodeDecisionFetcher },
  ) {
    this.fetchDecision = opts?.fetchDecision ?? ((id) => this.fetchOnboardingDecision(id));
  }

  async createSession(input: CreateKycSessionInput): Promise<CreateKycSessionResult> {
    if (!this.config.INCODE_API_KEY || !this.config.INCODE_API_URL || !this.config.INCODE_FLOW_ID) {
      throw new DomainError('Incode live credentials not configured', 'KYC_NOT_CONFIGURED');
    }
    const res = await fetch(`${this.config.INCODE_API_URL}/omni/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-version': '1.0',
        'x-api-key': this.config.INCODE_API_KEY,
        ...this.incodeAuthHeaders(),
      },
      body: JSON.stringify({
        configurationId: this.config.INCODE_FLOW_ID,
        externalCustomerId: input.vendorData,
        redirectionUrl: input.callbackUrl,
        language: input.language ?? 'en-US',
      }),
    });
    if (!res.ok) {
      throw new DomainError(`Incode session create failed: ${res.status}`, 'KYC_PROVIDER_ERROR');
    }
    const body = (await res.json()) as {
      interviewId?: string;
      token?: string;
      clientId?: string;
      url?: string;
    };
    const sessionId = body.interviewId ?? body.clientId;
    if (!sessionId) {
      throw new DomainError('Incode response missing interviewId', 'KYC_PROVIDER_ERROR');
    }
    const verificationUrl =
      body.url ??
      `${this.config.INCODE_API_URL.replace(/\/$/, '')}/onboarding?interviewId=${encodeURIComponent(sessionId)}`;
    return {
      provider: this.name,
      providerSessionId: sessionId,
      verificationUrl,
    };
  }

  /**
   * Official Fetch scores: GET /omni/get/score?id={interviewId}
   * https://developer.incode.com/api-reference/get-score/
   * Requires api-version, x-api-key, and X-Incode-Hardware-Id (or Authorization Bearer).
   * Only overall.status is retained — never the raw score payload.
   */
  async fetchOnboardingDecision(interviewId: string): Promise<IncodeDecisionSummary> {
    if (!this.config.INCODE_API_KEY || !this.config.INCODE_API_URL) {
      throw new DomainError('Incode live credentials not configured', 'KYC_NOT_CONFIGURED');
    }
    const auth = this.incodeAuthHeaders();
    if (!auth['X-Incode-Hardware-Id'] && !auth.Authorization) {
      throw new DomainError(
        'Incode get/score requires INCODE_HARDWARE_ID or INCODE_API_BEARER_TOKEN',
        'KYC_NOT_CONFIGURED',
      );
    }
    const base = this.config.INCODE_API_URL.replace(/\/$/, '');
    const url = `${base}/omni/get/score?id=${encodeURIComponent(interviewId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'api-version': '1.0',
        'x-api-key': this.config.INCODE_API_KEY,
        ...auth,
      },
    });
    if (!res.ok) {
      throw new DomainError(
        `Incode get/score failed: ${res.status}`,
        'KYC_PROVIDER_ERROR',
      );
    }
    const raw = (await res.json()) as {
      overall?: { status?: string };
    };
    // Extract overall.status only — discard nested checks, values, biometrics, PII.
    const overallStatus = raw.overall?.status;
    return normalizeIncodeOverallStatus(overallStatus);
  }

  /**
   * Webhook auth per Incode docs (not HMAC):
   * - OAuth2 client-credentials: Incode sends Authorization Bearer access_token
   *   obtained from the configured authentication URL
   *   (https://developer.incode.com/general-reference/authorizing-webhooks-requests/)
   * - Custom headers: static secret header configured in Dashboard → Webhooks
   *   (https://developer.incode.com/general-reference/webhooks-overview/)
   */
  verifyWebhookAuth(headers: Record<string, string | undefined>): void {
    const mode = this.config.INCODE_WEBHOOK_AUTH_MODE;

    if (mode === 'oauth_bearer') {
      const expected = this.config.INCODE_WEBHOOK_BEARER_TOKEN;
      if (!expected) {
        throw new DomainError(
          'Incode OAuth webhook bearer token not configured',
          'KYC_NOT_CONFIGURED',
        );
      }
      const auth = headers.authorization ?? headers.Authorization;
      if (!auth?.toLowerCase().startsWith('bearer ')) {
        throw new DomainError('Missing Incode webhook Bearer token', 'WEBHOOK_SIGNATURE');
      }
      const token = auth.slice('bearer '.length).trim();
      if (!equalSecret(token, expected)) {
        throw new DomainError('Invalid Incode webhook Bearer token', 'WEBHOOK_SIGNATURE');
      }
      return;
    }

    // custom_header (default)
    const headerName = (
      this.config.INCODE_WEBHOOK_SECRET_HEADER ?? 'x-incode-secret'
    ).toLowerCase();
    const secret = this.config.INCODE_WEBHOOK_SECRET;
    if (!secret) {
      throw new DomainError(
        'Incode webhook custom secret not configured',
        'KYC_NOT_CONFIGURED',
      );
    }
    const provided =
      headers[headerName] ??
      headers[this.config.INCODE_WEBHOOK_SECRET_HEADER ?? 'x-incode-secret'];
    if (!provided) {
      throw new DomainError('Missing Incode webhook custom secret header', 'WEBHOOK_SIGNATURE');
    }
    if (!equalSecret(provided, secret)) {
      throw new DomainError('Invalid Incode webhook custom secret header', 'WEBHOOK_SIGNATURE');
    }
  }

  async verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<NormalizedKycWebhook> {
    this.verifyWebhookAuth(headers);

    const payload = JSON.parse(rawBody) as {
      interviewId?: string;
      onboardingStatus?: string;
      status?: string;
      eventId?: string;
      timestamp?: string;
    };
    const sessionId = payload.interviewId;
    const rawStatus = payload.onboardingStatus ?? payload.status;
    if (!sessionId || !rawStatus) {
      throw new DomainError('Malformed Incode webhook payload', 'WEBHOOK_PAYLOAD');
    }

    const upper = rawStatus.toUpperCase();
    let status: KycNormalizedStatus;
    let assuranceLevel: string | undefined;
    let outcomeLabel = upper;

    if (DEFINITIVE_WEBHOOK_STATUSES.has(upper)) {
      status = mapStatus(
        INCODE_STATUS_MAP as unknown as Record<string, KycNormalizedStatus>,
        rawStatus,
      );
      if (status === 'verified') assuranceLevel = 'incode_omni';
    } else if (REQUIRES_DECISION_FETCH.has(upper)) {
      const decision = await this.fetchDecision(sessionId);
      status = decision.status;
      assuranceLevel = decision.assuranceLevel;
      outcomeLabel = decision.outcomeLabel ?? upper;
    } else {
      status = mapStatus(
        INCODE_STATUS_MAP as unknown as Record<string, KycNormalizedStatus>,
        rawStatus,
      );
    }

    // Normalized envelope only — never attach rawBody or raw score.
    return {
      provider: this.name,
      providerSessionId: sessionId,
      status,
      assuranceLevel,
      eventId:
        payload.eventId ??
        `incode:${sessionId}:${upper}:${outcomeLabel}:${payload.timestamp ?? ''}`,
      occurredAt: payload.timestamp ?? new Date().toISOString(),
    };
  }

  private incodeAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.INCODE_HARDWARE_ID) {
      headers['X-Incode-Hardware-Id'] = this.config.INCODE_HARDWARE_ID;
    }
    if (this.config.INCODE_API_BEARER_TOKEN) {
      headers.Authorization = `Bearer ${this.config.INCODE_API_BEARER_TOKEN}`;
    }
    return headers;
  }
}
