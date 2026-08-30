import { createHmac } from 'node:crypto';
import { DomainError } from '../domain/state-machine.js';
import { safe } from './didit.js';
import {
  mapStatus,
  type CreateKycSessionInput,
  type CreateKycSessionResult,
  type KycAdapter,
  type NormalizedKycWebhook,
} from './types.js';

const DEMO_STATUS_MAP = {
  pending: 'pending',
  verified: 'verified',
  needs_review: 'needs_review',
  rejected: 'rejected',
  expired: 'expired',
} as const;

/**
 * Deterministic demo KYC adapter — clearly labeled, no external calls.
 * Webhook HMAC uses the fixed demo secret only inside demo mode.
 */
export class DemoKycAdapter implements KycAdapter {
  readonly name = 'demo' as const;
  static readonly DEMO_WEBHOOK_SECRET = 'demo-kyc-webhook-secret-not-for-production';

  async createSession(input: CreateKycSessionInput): Promise<CreateKycSessionResult> {
    const providerSessionId = `demo_session_${hashVendor(input.vendorData)}`;
    return {
      provider: this.name,
      providerSessionId,
      verificationUrl: `demo://kyc/${providerSessionId}`,
      rawStatus: 'pending',
    };
  }

  async verifyWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): Promise<NormalizedKycWebhook> {
    const signature = headers['x-demo-signature'] ?? headers['x-signature'];
    if (!signature) {
      throw new DomainError('Missing demo webhook signature', 'WEBHOOK_SIGNATURE');
    }
    const expected = createHmac('sha256', DemoKycAdapter.DEMO_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    if (!safe.equalHex(expected, signature.replace(/^sha256=/i, ''))) {
      throw new DomainError('Invalid demo webhook signature', 'WEBHOOK_SIGNATURE');
    }
    const payload = JSON.parse(rawBody) as {
      session_id: string;
      status: string;
      event_id?: string;
    };
    const status = mapStatus(
      DEMO_STATUS_MAP as unknown as Record<string, import('../domain/types.js').KycNormalizedStatus>,
      payload.status,
    );
    return {
      provider: this.name,
      providerSessionId: payload.session_id,
      status,
      assuranceLevel: status === 'verified' ? 'demo_assurance' : undefined,
      eventId: payload.event_id ?? `demo:${payload.session_id}:${payload.status}`,
      occurredAt: new Date().toISOString(),
    };
  }

  /** Helper for demo ceremony / tests. */
  static signWebhook(body: object): { rawBody: string; signature: string } {
    const rawBody = JSON.stringify(body);
    const signature = createHmac('sha256', DemoKycAdapter.DEMO_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex');
    return { rawBody, signature };
  }
}

function hashVendor(vendorData: string): string {
  return createHmac('sha256', 'demo')
    .update(vendorData)
    .digest('hex')
    .slice(0, 16);
}
