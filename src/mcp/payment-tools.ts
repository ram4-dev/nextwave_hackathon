/**
 * Platform REST client for MCP payment tools.
 * Calls only platform /v1 via HTTP/fetch — never Yuno URLs/keys/IDs.
 */
export type PlatformRestClientConfig = {
  baseUrl: string;
  /** Buyer agent KYA credential (Bearer). */
  agentToken?: string;
  /** Human session token for enrollment/method management. */
  sessionToken?: string;
  /** Admin API key for capture/refunds. */
  adminApiKey?: string;
  fetchImpl?: typeof fetch;
};

export type PlatformRestResult = {
  status: number;
  body: unknown;
};

export class PlatformRestClient {
  private readonly baseUrl: string;
  private readonly agentToken?: string;
  private readonly sessionToken?: string;
  private readonly adminApiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: PlatformRestClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.agentToken = config.agentToken;
    this.sessionToken = config.sessionToken;
    this.adminApiKey = config.adminApiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private async request(
    method: string,
    path: string,
    opts: {
      auth: 'agent' | 'session' | 'admin';
      body?: unknown;
      idempotencyKey?: string;
      query?: Record<string, string | undefined>;
    },
  ): Promise<PlatformRestResult> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (opts.auth === 'agent') {
      if (!this.agentToken) throw new Error('agent token not configured');
      headers.authorization = `Bearer ${this.agentToken}`;
    } else if (opts.auth === 'session') {
      if (!this.sessionToken) throw new Error('session token not configured');
      headers.authorization = `Bearer ${this.sessionToken}`;
    } else {
      if (!this.adminApiKey) throw new Error('admin api key not configured');
      headers['x-admin-api-key'] = this.adminApiKey;
    }
    if (opts.idempotencyKey) {
      headers['idempotency-key'] = opts.idempotencyKey;
    }
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { raw: text };
      }
    }
    return { status: res.status, body };
  }

  // Buyer / human tools
  beginEnrollment(body?: { country?: string; currency?: string }) {
    return this.request('POST', '/v1/payment-method-enrollments', {
      auth: 'session',
      body: body ?? {},
    });
  }

  listPaymentMethods() {
    return this.request('GET', '/v1/payment-methods', { auth: 'session' });
  }

  removePaymentMethod(id: string) {
    return this.request('DELETE', `/v1/payment-methods/${encodeURIComponent(id)}`, {
      auth: 'session',
    });
  }

  getCapabilities(query?: {
    merchant_id?: string;
    country?: string;
    currency?: string;
  }) {
    return this.request('GET', '/v1/payment-capabilities', {
      auth: 'agent',
      query,
    });
  }

  createPayment(
    body: Record<string, unknown>,
    idempotencyKey: string,
  ) {
    return this.request('POST', '/v1/payments', {
      auth: 'agent',
      body,
      idempotencyKey,
    });
  }

  getPayment(id: string) {
    return this.request('GET', `/v1/payments/${encodeURIComponent(id)}`, {
      auth: 'agent',
    });
  }

  listPayments() {
    return this.request('GET', '/v1/payments', { auth: 'agent' });
  }

  cancelPayment(id: string, idempotencyKey: string) {
    return this.request('POST', `/v1/payments/${encodeURIComponent(id)}/cancel`, {
      auth: 'agent',
      body: {},
      idempotencyKey,
    });
  }

  // Admin-restricted
  capturePayment(
    id: string,
    idempotencyKey: string,
    body?: { amount?: { currency: string; value_minor: number } },
  ) {
    return this.request('POST', `/v1/payments/${encodeURIComponent(id)}/capture`, {
      auth: 'admin',
      body: body ?? {},
      idempotencyKey,
    });
  }

  createRefund(
    body: {
      payment_id: string;
      amount?: { currency: string; value_minor: number };
      reason?: string;
    },
    idempotencyKey: string,
  ) {
    return this.request('POST', '/v1/refunds', {
      auth: 'admin',
      body,
      idempotencyKey,
    });
  }

  getRefund(id: string) {
    return this.request('GET', `/v1/refunds/${encodeURIComponent(id)}`, {
      auth: 'admin',
    });
  }
}

export type PaymentToolResult = {
  ok: boolean;
  tool: string;
  status: number;
  data: unknown;
  error?: string;
};

/**
 * In-process MCP-style tool adapter over PlatformRestClient.
 * Role limits are enforced by which credentials the client was constructed with.
 */
export function createPaymentToolAdapter(client: PlatformRestClient) {
  async function wrap(
    tool: string,
    fn: () => Promise<PlatformRestResult>,
  ): Promise<PaymentToolResult> {
    try {
      const result = await fn();
      const ok = result.status >= 200 && result.status < 300;
      return {
        ok,
        tool,
        status: result.status,
        data: result.body,
        error: ok
          ? undefined
          : String((result.body as { error?: string })?.error ?? 'request failed'),
      };
    } catch (err) {
      return {
        ok: false,
        tool,
        status: 0,
        data: null,
        error: err instanceof Error ? err.message : 'tool failed',
      };
    }
  }

  return {
    'payment_methods.begin_enrollment': (args?: {
      country?: string;
      currency?: string;
    }) => wrap('payment_methods.begin_enrollment', () => client.beginEnrollment(args)),
    'payment_methods.list': () =>
      wrap('payment_methods.list', () => client.listPaymentMethods()),
    'payment_methods.remove': (args: { id: string }) =>
      wrap('payment_methods.remove', () => client.removePaymentMethod(args.id)),
    'payment_capabilities.get': (args?: {
      merchant_id?: string;
      country?: string;
      currency?: string;
    }) => wrap('payment_capabilities.get', () => client.getCapabilities(args)),
    'payments.create': (args: {
      body: Record<string, unknown>;
      idempotency_key: string;
    }) =>
      wrap('payments.create', () =>
        client.createPayment(args.body, args.idempotency_key),
      ),
    'payments.get': (args: { id: string }) =>
      wrap('payments.get', () => client.getPayment(args.id)),
    'payments.list': () => wrap('payments.list', () => client.listPayments()),
    'payments.cancel': (args: { id: string; idempotency_key: string }) =>
      wrap('payments.cancel', () =>
        client.cancelPayment(args.id, args.idempotency_key),
      ),
    'payments.capture': (args: {
      id: string;
      idempotency_key: string;
      amount?: { currency: string; value_minor: number };
    }) =>
      wrap('payments.capture', () =>
        client.capturePayment(args.id, args.idempotency_key, {
          amount: args.amount,
        }),
      ),
    'refunds.create': (args: {
      payment_id: string;
      idempotency_key: string;
      amount?: { currency: string; value_minor: number };
      reason?: string;
    }) =>
      wrap('refunds.create', () =>
        client.createRefund(
          {
            payment_id: args.payment_id,
            amount: args.amount,
            reason: args.reason,
          },
          args.idempotency_key,
        ),
      ),
    'refunds.get': (args: { id: string }) =>
      wrap('refunds.get', () => client.getRefund(args.id)),
  };
}

export type PaymentToolAdapter = ReturnType<typeof createPaymentToolAdapter>;
