/**
 * Platform payment routes — provider-agnostic /v1 + /internal.
 */
import { createMiddleware } from 'hono/factory';
import type { Hono } from 'hono';
import type { AppConfig } from '../../config/env.js';
import { secretsEqual } from '../../crypto/secrets-at-rest.js';
import type { CredentialClaims } from '../../credentials/jws.js';
import { verifyKyaCredential } from '../../credentials/jws.js';
import { PaymentError } from '../../domain/payments/helpers.js';
import {
  captureBodySchema,
  createPaymentBodySchema,
  enrollmentBodySchema,
  parseStrictBody,
  patchPaymentMethodBodySchema,
  refundBodySchema,
  webhookEndpointBodySchema,
} from '../../domain/payments/validation.js';
import type { Repository } from '../../persistence/repository.js';
import type { PaymentService } from '../../services/payments/payment-service.js';
import type { PaymentRuntime } from './runtime.js';

type Variables = {
  address: `0x${string}`;
  agentClaims?: CredentialClaims;
};

async function resolvePrincipalId(
  repo: Repository,
  address: `0x${string}`,
): Promise<string> {
  const store = await repo.getStore();
  const principal = store.principals.find(
    (p) => p.ownerAddress.toLowerCase() === address.toLowerCase(),
  );
  if (!principal) {
    throw new PaymentError('Principal not found for session', 'unauthorized', 401);
  }
  return principal.id;
}

function paymentsUnavailable(): never {
  throw new PaymentError(
    'Payment routes require YUNO_BASE_URL and provider credentials',
    'payments_unavailable',
    503,
  );
}

export function registerPaymentRoutes(
  app: Hono<{ Variables: Variables }>,
  deps: {
    repo: Repository;
    config: AppConfig;
    payment: PaymentRuntime | null;
    requireSession: ReturnType<typeof createMiddleware<{ Variables: Variables }>>;
  },
): void {
  const { repo, config, payment, requireSession } = deps;

  const requirePayments = (): PaymentService => {
    if (!payment) paymentsUnavailable();
    return payment.service;
  };

  const requireAgent = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }
    const token = header.slice('Bearer '.length);
    try {
      const claims = await verifyKyaCredential(repo, config, token);
      c.set('agentClaims', claims);
      await next();
    } catch {
      return c.json({ error: 'Unauthorized', code: 'unauthorized' }, 401);
    }
  });

  const requireAdmin = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const key = c.req.header('x-admin-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const expected = config.PAYMENT_ADMIN_API_KEY;
    if (!expected || !key || !secretsEqual(key, expected)) {
      return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
    }
    await next();
  });

  const requireInternal = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const key =
      c.req.header('x-internal-api-key') ??
      c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const expected = config.PAYMENT_INTERNAL_API_KEY;
    if (!expected || !key || !secretsEqual(key, expected)) {
      return c.json({ error: 'Forbidden', code: 'forbidden' }, 403);
    }
    await next();
  });

  // --- Payment method enrollments (human session) ---

  app.post('/v1/payment-method-enrollments', requireSession, async (c) => {
    const service = requirePayments();
    const address = c.get('address')!;
    const principalId = await resolvePrincipalId(repo, address);
    const raw = await c.req.json().catch(() => ({}));
    const body = parseStrictBody(enrollmentBodySchema, raw);
    const result = await service.beginEnrollment({
      principalId,
      country: body.country,
      currency: body.currency,
    });
    return c.json(result, 201);
  });

  app.get('/v1/payment-method-enrollments/:id', requireSession, async (c) => {
    const service = requirePayments();
    const address = c.get('address')!;
    const principalId = await resolvePrincipalId(repo, address);
    const result = await service.getEnrollment({
      principalId,
      enrollmentId: c.req.param('id'),
    });
    return c.json(result);
  });

  app.get('/v1/payment-methods', requireSession, async (c) => {
    const service = requirePayments();
    const address = c.get('address')!;
    const principalId = await resolvePrincipalId(repo, address);
    const result = await service.listPaymentMethods(principalId);
    return c.json({ payment_methods: result });
  });

  app.get('/v1/payment-methods/:id', requireSession, async (c) => {
    const service = requirePayments();
    const address = c.get('address')!;
    const principalId = await resolvePrincipalId(repo, address);
    const result = await service.getPaymentMethod({
      principalId,
      paymentMethodId: c.req.param('id'),
    });
    return c.json(result);
  });

  app.patch('/v1/payment-methods/:id', requireSession, async (c) => {
    const service = requirePayments();
    const address = c.get('address')!;
    const principalId = await resolvePrincipalId(repo, address);
    const raw = await c.req.json().catch(() => ({}));
    const body = parseStrictBody(patchPaymentMethodBodySchema, raw);
    const result = await service.patchPaymentMethod({
      principalId,
      paymentMethodId: c.req.param('id'),
      alias: body.alias,
      isDefault: body.is_default,
    });
    return c.json(result);
  });

  app.delete('/v1/payment-methods/:id', requireSession, async (c) => {
    const service = requirePayments();
    const address = c.get('address')!;
    const principalId = await resolvePrincipalId(repo, address);
    await service.deletePaymentMethod({
      principalId,
      paymentMethodId: c.req.param('id'),
    });
    return c.json({ ok: true });
  });

  // --- Payments (buyer agent) ---

  app.post('/v1/payments', requireAgent, async (c) => {
    const service = requirePayments();
    const claims = c.get('agentClaims')!;
    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey) {
      throw new PaymentError('Idempotency-Key is required', 'invalid_request', 400);
    }
    const raw = await c.req.json().catch(() => {
      throw new PaymentError('Malformed JSON body', 'invalid_request', 400);
    });
    const body = parseStrictBody(createPaymentBodySchema, raw);
    const result = await service.createPayment({
      actorId: claims.sub,
      agentUuid: claims.sub,
      principalId: claims.principal_id,
      idempotencyKey,
      body,
    });
    return c.json(result.body, result.httpStatus as 201);
  });

  app.get('/v1/payments/:id', requireAgent, async (c) => {
    const service = requirePayments();
    const claims = c.get('agentClaims')!;
    const result = await service.getPayment({
      principalId: claims.principal_id,
      agentUuid: claims.sub,
      paymentId: c.req.param('id'),
    });
    return c.json(result);
  });

  app.get('/v1/payments', requireAgent, async (c) => {
    const service = requirePayments();
    const claims = c.get('agentClaims')!;
    const result = await service.listPayments({
      principalId: claims.principal_id,
      agentUuid: claims.sub,
    });
    return c.json({ payments: result });
  });

  app.post('/v1/payments/:id/capture', requireAdmin, async (c) => {
    const service = requirePayments();
    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey) {
      throw new PaymentError('Idempotency-Key is required', 'invalid_request', 400);
    }
    const raw = await c.req.json().catch(() => ({}));
    const body = parseStrictBody(captureBodySchema, raw);
    const result = await service.capturePayment({
      paymentId: c.req.param('id'),
      idempotencyKey,
      amount: body.amount,
    });
    return c.json(result.body, result.httpStatus as 200);
  });

  app.post('/v1/payments/:id/cancel', requireAgent, async (c) => {
    const service = requirePayments();
    const claims = c.get('agentClaims')!;
    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey) {
      throw new PaymentError('Idempotency-Key is required', 'invalid_request', 400);
    }
    const result = await service.cancelPayment({
      principalId: claims.principal_id,
      agentUuid: claims.sub,
      paymentId: c.req.param('id'),
      idempotencyKey,
    });
    return c.json(result.body, result.httpStatus as 200);
  });

  // --- Refunds (admin) ---

  app.post('/v1/refunds', requireAdmin, async (c) => {
    const service = requirePayments();
    const idempotencyKey = c.req.header('idempotency-key');
    if (!idempotencyKey) {
      throw new PaymentError('Idempotency-Key is required', 'invalid_request', 400);
    }
    const raw = await c.req.json().catch(() => {
      throw new PaymentError('Malformed JSON body', 'invalid_request', 400);
    });
    const body = parseStrictBody(refundBodySchema, raw);
    const result = await service.createRefund({
      paymentId: body.payment_id,
      idempotencyKey,
      amount: body.amount,
      reason: body.reason,
    });
    return c.json(result.body, result.httpStatus as 201);
  });

  app.get('/v1/refunds/:id', requireAdmin, async (c) => {
    const service = requirePayments();
    const result = await service.getRefund(c.req.param('id'));
    return c.json(result);
  });

  app.get('/v1/refunds', requireAdmin, async (c) => {
    const service = requirePayments();
    const paymentId = c.req.query('payment_id');
    if (!paymentId) {
      throw new PaymentError('payment_id query is required', 'invalid_request', 400);
    }
    const result = await service.listRefunds(paymentId);
    return c.json({ refunds: result });
  });

  // --- Capabilities (agent) ---

  app.get('/v1/payment-capabilities', requireAgent, async (c) => {
    const service = requirePayments();
    const result = await service.getCapabilities({
      merchantId: c.req.query('merchant_id'),
      country: c.req.query('country'),
      currency: c.req.query('currency'),
    });
    return c.json(result);
  });

  // --- Outbound webhook endpoints ---

  app.post('/v1/webhook-endpoints', requireAdmin, async (c) => {
    const service = requirePayments();
    const raw = await c.req.json().catch(() => {
      throw new PaymentError('Malformed JSON body', 'invalid_request', 400);
    });
    const body = parseStrictBody(webhookEndpointBodySchema, raw);
    const result = await service.createWebhookEndpoint(body.url);
    return c.json(
      {
        id: result.id,
        url: result.url,
        active: result.active,
        created_at: result.createdAt,
      },
      201,
    );
  });

  app.get('/v1/webhook-endpoints', requireAdmin, async (c) => {
    const service = requirePayments();
    const result = await service.listWebhookEndpoints();
    return c.json({ webhook_endpoints: result });
  });

  app.delete('/v1/webhook-endpoints/:id', requireAdmin, async (c) => {
    const service = requirePayments();
    await service.deleteWebhookEndpoint(c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- Internal ---

  app.post('/internal/webhooks/yuno', async (c) => {
    const service = requirePayments();
    const raw = await c.req.text();
    const signature = c.req.header('x-hmac-signature');
    service.verifyInboundWebhook(raw, signature ?? null);
    // Ack quickly; process asynchronously — catch so rejections are never unhandled.
    queueMicrotask(() => {
      void service.processYunoWebhookAsync(raw).catch(() => undefined);
    });
    return c.json({ received: true }, 200);
  });

  app.get('/internal/providers/yuno/health', requireInternal, async (c) => {
    const service = requirePayments();
    const health = await service.providerHealth();
    return c.json(health, health.ok ? 200 : 503);
  });
}
