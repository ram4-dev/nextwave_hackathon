/**
 * Yuno documented webhook retry schedule (migration §12 / Yuno docs).
 * At most 7 total delivery attempts at these offsets from the initial try.
 */
export const WEBHOOK_RETRY_OFFSETS_MS = [
  0, // first try
  5 * 60 * 1000, // 5 minutes
  50 * 60 * 1000, // 50 minutes
  6 * 60 * 60 * 1000, // 6 hours
  24 * 60 * 60 * 1000, // 24 hours
  48 * 60 * 60 * 1000, // 48 hours
  96 * 60 * 60 * 1000, // 96 hours
] as const;

export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_OFFSETS_MS.length;

export function nextWebhookAttemptAt(
  firstAttemptAtMs: number,
  attemptIndexZeroBased: number,
): number | null {
  if (attemptIndexZeroBased < 0 || attemptIndexZeroBased >= WEBHOOK_MAX_ATTEMPTS) {
    return null;
  }
  return firstAttemptAtMs + WEBHOOK_RETRY_OFFSETS_MS[attemptIndexZeroBased]!;
}
