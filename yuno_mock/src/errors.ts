/**
 * Canonical Yuno-style error envelope from the pinned OpenAPI
 * (code + messages[]). Used for auth, JSON, idempotency, and stubs.
 */
export type YunoErrorBody = {
  code: string;
  messages: string[];
};

export class YunoHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly messages: string[];

  constructor(status: number, code: string, messages: string | string[]) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list[0] ?? code);
    this.name = 'YunoHttpError';
    this.status = status;
    this.code = code;
    this.messages = list;
  }

  toBody(): YunoErrorBody {
    return { code: this.code, messages: this.messages };
  }
}

export function yunoError(
  status: number,
  code: string,
  messages: string | string[],
): YunoHttpError {
  return new YunoHttpError(status, code, messages);
}

export const Errors = {
  invalidCredentials: () =>
    yunoError(401, 'INVALID_CREDENTIALS', 'Invalid credentials'),
  missingCredentials: () =>
    yunoError(401, 'INVALID_CREDENTIALS', 'Missing public-api-key or private-secret-key'),
  invalidJson: () =>
    yunoError(400, 'INVALID_REQUEST', 'Request body must be valid JSON'),
  invalidRequest: (message: string) => yunoError(400, 'INVALID_REQUEST', message),
  notFound: (message = 'Resource not found') =>
    yunoError(404, 'NOT_FOUND', message),
  notImplemented: (path: string) =>
    yunoError(501, 'NOT_IMPLEMENTED', `MVP route not implemented yet: ${path}`),
  requestInProcess: () =>
    yunoError(400, 'REQUEST_IN_PROCESS', 'A request with this idempotency key is still in process'),
  idempotencyDuplicated: () =>
    yunoError(
      400,
      'IDEMPOTENCY_DUPLICATED',
      'Idempotency key was consumed without a result; use a new key',
    ),
} as const;
