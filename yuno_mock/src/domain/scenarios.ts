/**
 * Deterministic payment scenarios — selected only via test/dev control state,
 * never via a public POST /v1/payments field (migration §13).
 */

export const PAYMENT_SCENARIOS = [
  'success',
  'declined',
  'insufficient_funds',
  'requires_3ds',
  'processing_then_success',
  'processing_then_declined',
  'authorized',
  'provider_timeout',
  'duplicate_webhook',
  'out_of_order_webhooks',
  'invalid_hmac',
  'refund_success',
  'refund_failed',
] as const;

export type PaymentScenario = (typeof PAYMENT_SCENARIOS)[number];

export const DEFAULT_PAYMENT_SCENARIO: PaymentScenario = 'success';

export const PAYMENT_SCENARIO_CONTROL_ID = 'payments';

export function isPaymentScenario(value: unknown): value is PaymentScenario {
  return (
    typeof value === 'string' &&
    (PAYMENT_SCENARIOS as readonly string[]).includes(value)
  );
}
