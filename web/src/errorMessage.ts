const MESSAGE_KEYS = ['message', 'shortMessage', 'reason', 'details'] as const;
const NESTED_ERROR_KEYS = ['error', 'cause', 'data'] as const;

function usefulMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const message = value.trim();
  if (!message || message === '[object Object]') return undefined;
  return message;
}

function findErrorMessage(value: unknown, seen: Set<object>): string | undefined {
  const direct = usefulMessage(value);
  if (direct) return direct;
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of MESSAGE_KEYS) {
    const message = findErrorMessage(record[key], seen);
    if (message) return message;
  }
  for (const key of NESTED_ERROR_KEYS) {
    const message = findErrorMessage(record[key], seen);
    if (message) return message;
  }
  return undefined;
}

/** Extract a human-readable message from Error and structured provider/API failures. */
export function formatUnknownError(
  error: unknown,
  fallback = 'Unexpected error. Please try again.',
): string {
  return findErrorMessage(error, new Set()) ?? fallback;
}
