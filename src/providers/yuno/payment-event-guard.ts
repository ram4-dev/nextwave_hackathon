/**
 * Reusable payment event transition guard (F4/F5).
 * Deduplicates by event id and refuses out-of-order rewinds from terminal ranks.
 * Platform F6 can reuse this when applying inbound Yuno webhooks.
 *
 * F5 ranking allows legitimate money-path progression:
 * AUTHORIZED → PARTIALLY_CAPTURED → SUCCEEDED/CAPTURED → PARTIALLY_REFUNDED → REFUNDED
 * while hard terminals (DECLINED/REJECTED/ERROR/EXPIRED/CANCELED/REFUNDED) reject
 * every different incoming state regardless of numeric rank.
 */

export type PaymentStatusSnapshot = {
  status: string;
  sub_status?: string;
};

/** Higher rank = later in lifecycle. Terminal ranks never decrease. */
export function paymentStateRank(status: string, subStatus?: string): number {
  const s = status.toUpperCase();
  const sub = (subStatus ?? '').toUpperCase();

  if (s === 'DECLINED' || s === 'REJECTED') return 100;
  if (s === 'ERROR' || s === 'EXPIRED') return 100;

  // Refund path (check before generic SUCCEEDED).
  if (s === 'REFUNDED' || sub === 'REFUNDED') return 90;
  if (sub === 'PARTIALLY_REFUNDED') return 80;

  // Cancel only ranks just above AUTHORIZED so SUCCEEDED cannot rewind to CANCELED.
  if (s === 'CANCELED' || s === 'CANCELLED') return 55;

  if (sub === 'PARTIALLY_CAPTURED') return 60;

  if (
    s === 'SUCCEEDED' ||
    s === 'APPROVED' ||
    s === 'CAPTURED' ||
    sub === 'CAPTURED' ||
    sub === 'APPROVED'
  ) {
    return 70;
  }

  if (s === 'AUTHORIZED' || sub === 'AUTHORIZED') return 50;

  if (s === 'PENDING') {
    if (sub === 'WAITING_ADDITIONAL_STEP') return 20;
    if (sub === 'IN_PROCESS' || sub === 'PENDING') return 30;
    return 25;
  }
  if (s === 'CREATED' || s === 'READY_TO_PAY') return 10;
  return 0;
}

/**
 * Hard terminals that reject every different incoming state (rank-independent).
 * SUCCEEDED is intentionally omitted so PARTIALLY_REFUNDED / REFUNDED can apply.
 */
export function isTerminalPaymentStatus(status: string): boolean {
  const s = status.toUpperCase();
  return (
    s === 'DECLINED' ||
    s === 'REJECTED' ||
    s === 'ERROR' ||
    s === 'EXPIRED' ||
    s === 'CANCELED' ||
    s === 'CANCELLED' ||
    s === 'REFUNDED'
  );
}

export type ApplyPaymentEventDecision =
  | { apply: true; reason: 'accepted' }
  | { apply: false; reason: 'duplicate_event' | 'stale_or_out_of_order' | 'same_state' };

/**
 * Decide whether an inbound payment status event should mutate stored state.
 * - Duplicate event ids never re-apply money effects.
 * - Hard terminals reject every different incoming status (even higher rank).
 * - Soft states allow strictly higher-rank money-path progress only.
 */
export function decidePaymentEventApplication(input: {
  current: PaymentStatusSnapshot;
  incoming: PaymentStatusSnapshot;
  eventId: string;
  seenEventIds: ReadonlySet<string> | readonly string[];
}): ApplyPaymentEventDecision {
  const seen =
    input.seenEventIds instanceof Set
      ? input.seenEventIds
      : new Set(input.seenEventIds);
  if (seen.has(input.eventId)) {
    return { apply: false, reason: 'duplicate_event' };
  }

  if (
    input.current.status === input.incoming.status &&
    (input.current.sub_status ?? '') === (input.incoming.sub_status ?? '')
  ) {
    return { apply: false, reason: 'same_state' };
  }

  // Hard terminal: reject every different incoming state, regardless of rank.
  if (isTerminalPaymentStatus(input.current.status)) {
    return { apply: false, reason: 'stale_or_out_of_order' };
  }

  const currentRank = paymentStateRank(input.current.status, input.current.sub_status);
  const incomingRank = paymentStateRank(input.incoming.status, input.incoming.sub_status);

  if (incomingRank < currentRank) {
    return { apply: false, reason: 'stale_or_out_of_order' };
  }

  // Soft-terminal (AUTHORIZED / SUCCEEDED family): allow strictly higher-rank progress.
  if (currentRank >= 50 && incomingRank <= currentRank) {
    return { apply: false, reason: 'stale_or_out_of_order' };
  }

  return { apply: true, reason: 'accepted' };
}
