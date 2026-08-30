import type { MockApp } from '../app.js';
import { Errors } from '../errors.js';
import {
  headerMapFromHono,
  requireValidRequest,
  requireValidResponse,
} from '../contract.js';
import { createCustomer } from '../services/customers.js';
import { createCustomerSession } from '../services/sessions.js';
import {
  enrollPaymentMethod,
  getPaymentMethod,
  listAvailablePaymentMethods,
  listCustomerPaymentMethods,
  unenrollPaymentMethod,
} from '../services/payment-methods.js';

async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw Errors.invalidJson();
  }
}

export function registerEnrollmentRoutes(app: MockApp): void {
  app.post('/v1/customers', async (c) => {
    const headers = headerMapFromHono(c);
    const body = await readJsonBody(c);
    requireValidRequest('create-customer', body, headers);
    const result = await createCustomer(
      c.get('repo'),
      body as { merchant_customer_id: string },
    );
    requireValidResponse('create-customer', 201, result);
    return c.json(result, 201);
  });

  app.post('/v1/customers/sessions', async (c) => {
    const headers = headerMapFromHono(c);
    const body = await readJsonBody(c);
    requireValidRequest('create-customer-session', body, headers);
    const result = await createCustomerSession(
      c.get('repo'),
      body as { account_id: string; country: string; customer_id: string },
    );
    requireValidResponse('create-customer-session', 201, result);
    return c.json(result, 201);
  });

  app.get('/v1/checkout/customers/sessions/:customer_session/payment-methods', async (c) => {
    const headers = headerMapFromHono(c);
    requireValidRequest('retrieve-payment-methods-to-enroll-checkout', undefined, headers);
    const customerSession = c.req.param('customer_session');
    const result = await listAvailablePaymentMethods(c.get('repo'), customerSession);
    requireValidResponse('retrieve-payment-methods-to-enroll-checkout', 200, result);
    return c.json(result, 200);
  });

  app.post('/v1/customers/sessions/:customer_session/payment-methods', async (c) => {
    const headers = headerMapFromHono(c);
    const customerSession = c.req.param('customer_session');
    const idempotency = c.get('idempotency');
    const idempotencyKey = headers['X-Idempotency-Key'];
    const scope = `enroll:${customerSession}`;

    // §11: path session scopes the key — replay/throw before body validation.
    if (idempotencyKey?.trim()) {
      const existing = await idempotency.lookupExistingOrThrow(idempotencyKey, scope);
      if (existing.kind === 'replay') {
        requireValidResponse('enroll-payment-method-checkout', existing.status, existing.body);
        return c.json(existing.body as Record<string, unknown>, existing.status as 201);
      }
    }

    const body = await readJsonBody(c);
    requireValidRequest('enroll-payment-method-checkout', body, headers);
    if (!idempotencyKey?.trim()) {
      throw Errors.invalidRequest('missing required header X-Idempotency-Key');
    }

    const gate = await idempotency.beginOrThrow(idempotencyKey, scope);
    if (gate.kind === 'replay') {
      requireValidResponse('enroll-payment-method-checkout', gate.status, gate.body);
      return c.json(gate.body as Record<string, unknown>, gate.status as 201);
    }

    try {
      const result = await enrollPaymentMethod(
        c.get('repo'),
        customerSession,
        body as {
          account_id: string;
          payment_method_type: string;
          country: string;
          verify?: { vault_on_success: boolean; currency?: string };
        },
        idempotencyKey,
      );
      requireValidResponse('enroll-payment-method-checkout', 201, result);
      await idempotency.complete(idempotencyKey, 201, result, scope);
      return c.json(result, 201);
    } catch (err) {
      // Business rejection after key acquired → leave key consumed without result
      // only for unexpected failures; YunoHttpError (validation-like) abandons key
      // so clients may fix and retry with same key when appropriate.
      const { YunoHttpError } = await import('../errors.js');
      if (err instanceof YunoHttpError && err.status < 500) {
        await idempotency.abandonWithoutConsume(idempotencyKey, scope);
      } else {
        await idempotency.consumeWithoutResult(idempotencyKey, scope);
      }
      throw err;
    }
  });

  app.get('/v1/payment-methods/:payment_method_id', async (c) => {
    const headers = headerMapFromHono(c);
    requireValidRequest('retrieve-payment-method-by-id-checkout', undefined, headers);
    const result = await getPaymentMethod(c.get('repo'), c.req.param('payment_method_id'));
    requireValidResponse('retrieve-payment-method-by-id-checkout', 200, result);
    return c.json(result, 200);
  });

  app.get('/v1/customers/:customer_id/payment-methods', async (c) => {
    const headers = headerMapFromHono(c);
    requireValidRequest('retrieve-enrolled-payment-methods-api', undefined, headers);
    const result = await listCustomerPaymentMethods(c.get('repo'), c.req.param('customer_id'));
    requireValidResponse('retrieve-enrolled-payment-methods-api', 200, result);
    return c.json(result, 200);
  });

  app.post('/v1/customers/payment-methods/:payment_method_id/unenroll', async (c) => {
    const headers = headerMapFromHono(c);
    requireValidRequest('unenroll-payment-method-checkout', undefined, headers);
    const result = await unenrollPaymentMethod(
      c.get('repo'),
      c.req.param('payment_method_id'),
    );
    requireValidResponse('unenroll-payment-method-checkout', 200, result);
    return c.json(result, 200);
  });
}
