/**
 * Yuno provider status/sub_status → platform public payment status.
 * PENDING and AUTHORIZED are never treated as success.
 */

export type PublicPaymentStatus =
  | 'created'
  | 'requires_user_action'
  | 'processing'
  | 'authorized'
  | 'succeeded'
  | 'declined'
  | 'failed'
  | 'canceled'
  | 'partially_refunded'
  | 'refunded';

export type YunoStatusSnapshot = {
  status: string;
  sub_status?: string;
};

export function mapYunoPaymentStatus(input: YunoStatusSnapshot): PublicPaymentStatus {
  const status = (input.status ?? '').toUpperCase();
  const sub = (input.sub_status ?? '').toUpperCase();

  if (status === 'CREATED' || status === 'READY_TO_PAY') return 'created';

  if (status === 'PENDING' || status === 'WAITING_ADDITIONAL_STEP') {
    if (sub === 'WAITING_ADDITIONAL_STEP') return 'requires_user_action';
    if (sub === 'AUTHORIZED') return 'authorized';
    if (sub === 'IN_PROCESS' || sub === 'PENDING' || sub === '') return 'processing';
    // Unknown pending sub-status → processing (never success).
    return 'processing';
  }

  if (status === 'AUTHORIZED' || sub === 'AUTHORIZED') return 'authorized';

  if (sub === 'PARTIALLY_REFUNDED') return 'partially_refunded';
  if (status === 'REFUNDED' || sub === 'REFUNDED') return 'refunded';

  if (
    status === 'SUCCEEDED' ||
    status === 'APPROVED' ||
    status === 'CAPTURED' ||
    sub === 'CAPTURED' ||
    sub === 'APPROVED'
  ) {
    return 'succeeded';
  }

  if (status === 'DECLINED' || status === 'REJECTED') return 'declined';
  if (status === 'ERROR' || status === 'EXPIRED') return 'failed';
  if (status === 'CANCELED' || status === 'CANCELLED') return 'canceled';

  return 'processing';
}

/** True when public status means funds are confirmed captured/succeeded. */
export function isPublicPaymentSuccess(status: PublicPaymentStatus): boolean {
  return status === 'succeeded' || status === 'partially_refunded' || status === 'refunded';
}

export type PublicErrorCode =
  | 'payment_method_unavailable'
  | 'authorization_invalid'
  | 'payment_declined'
  | 'user_action_required'
  | 'provider_temporarily_unavailable'
  | 'payment_outcome_unknown'
  | 'idempotency_key_reused'
  | 'request_in_progress'
  | 'operation_not_allowed'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_request'
  | 'payments_unavailable';

export function mapYunoHttpErrorToPublic(input: {
  status: number;
  code?: string;
  message?: string;
}): { code: PublicErrorCode; retryable: boolean; message: string } {
  const code = (input.code ?? '').toUpperCase();
  if (input.status === 401 || input.status === 403) {
    return {
      code: 'provider_temporarily_unavailable',
      retryable: true,
      message: 'Provider authentication failed',
    };
  }
  if (code === 'REQUEST_IN_PROCESS') {
    return {
      code: 'request_in_progress',
      retryable: true,
      message: 'Request already in progress',
    };
  }
  if (code === 'IDEMPOTENCY_DUPLICATED') {
    return {
      code: 'idempotency_key_reused',
      retryable: false,
      message: 'Provider idempotency key conflict',
    };
  }
  if (input.status >= 500) {
    return {
      code: 'payment_outcome_unknown',
      retryable: true,
      message: 'Provider outcome unknown; query status — do not recreate',
    };
  }
  if (input.status === 404) {
    return { code: 'not_found', retryable: false, message: 'Provider resource not found' };
  }
  return {
    code: 'invalid_request',
    retryable: false,
    message: 'Provider rejected the request',
  };
}
