/**
 * Provider-neutral Yuno HTTP client.
 * Same code path for independent mock and future real Yuno via YUNO_BASE_URL.
 * Never logs credentials. Injectable fetch for tests.
 */

export type YunoHttpClientConfig = {
  baseUrl: string;
  publicApiKey: string;
  privateSecretKey: string;
  /** Request timeout in ms (default 15_000). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type YunoRequestOptions = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
};

export type YunoHttpResult = {
  status: number;
  body: unknown;
  headers: Headers;
};

export class YunoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'YunoHttpError';
  }
}

export class YunoHttpClient {
  private readonly baseUrl: string;
  private readonly publicApiKey: string;
  private readonly privateSecretKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: YunoHttpClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.publicApiKey = config.publicApiKey;
    this.privateSecretKey = config.privateSecretKey;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async request(opts: YunoRequestOptions): Promise<YunoHttpResult> {
    const url = `${this.baseUrl}${opts.path.startsWith('/') ? opts.path : `/${opts.path}`}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'public-api-key': this.publicApiKey,
      'private-secret-key': this.privateSecretKey,
      ...(opts.headers ?? {}),
    };
    if (opts.idempotencyKey) {
      headers['X-Idempotency-Key'] = opts.idempotencyKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      let body: unknown = null;
      const text = await res.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = { raw: '[unreadable]' };
        }
      }
      return { status: res.status, body, headers: res.headers };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new YunoHttpError(
          'Provider request timed out',
          0,
          'TIMEOUT',
          true,
        );
      }
      throw new YunoHttpError(
        'Provider request failed',
        0,
        'NETWORK',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Throw normalized YunoHttpError when status is not 2xx. Never includes secrets. */
  assertOk(result: YunoHttpResult): void {
    if (result.status >= 200 && result.status < 300) return;
    const body = result.body as { code?: string; messages?: string[] } | null;
    const code =
      typeof body?.code === 'string' ? body.code : `HTTP_${result.status}`;
    throw new YunoHttpError(
      'Provider returned an error',
      result.status,
      code,
      result.status >= 500 || result.status === 0,
    );
  }
}
