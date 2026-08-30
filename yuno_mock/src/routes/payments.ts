import type { Context } from 'hono';
import type { MockApp, AppVariables } from '../app.js';
import { Errors } from '../errors.js';
import {
  headerMapFromHono,
  requireValidRequest,
  requireValidResponse,
} from '../contract.js';
import {
  assertCreatePaymentPreconditions,
  createPayment,
  getPayment,
  paymentIdempotencyScope,
  type CreatePaymentBody,
} from '../services/payments.js';
import {
  cancelIdempotencyScope,
  cancelOrRefundPayment,
  cancelOrRefundPaymentIdempotencyScope,
  cancelOrRefundPaymentTransaction,
  cancelOrRefundTxIdempotencyScope,
  cancelPayment,
  captureIdempotencyScope,
  capturePayment,
  lookupPaymentAccountId,
  refundIdempotencyScope,
  refundPayment,
  type CancelBody,
  type CancelOrRefundBody,
  type CaptureBody,
  type RefundBody,
} from '../services/post-pay.js';
import { assertNoSensitiveMaterial } from '../domain/sensitive.js';
import { processDueDeliveries } from '../services/webhook-delivery.js';
import type { YunoMvpOperationKey } from '../../../src/providers/yuno/generated/mvp-operations.js';

type AppContext = Context<{ Variables: AppVariables }>;

async function readJsonBody(c: AppContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw Errors.invalidJson();
  }
}

function secretList(config: {
  YUNO_PUBLIC_API_KEY: string;
  YUNO_PRIVATE_SECRET_KEY: string;
  YUNO_MOCK_FINGERPRINT_SECRET: string;
}): string[] {
  return [
    config.YUNO_PUBLIC_API_KEY,
    config.YUNO_PRIVATE_SECRET_KEY,
    config.YUNO_MOCK_FINGERPRINT_SECRET,
  ];
}

type PostPayOp =
  | 'capture-authorization'
  | 'cancel-payment'
  | 'refund-payment'
  | 'cancel-or-refund-a-payment'
  | 'cancel-or-refund-payment-with-transaction';

async function withIdempotentMutation(opts: {
  c: AppContext;
  operationKey: PostPayOp;
  successStatus: 200 | 201;
  scope: string;
  body: unknown;
  headers: Record<string, string | undefined>;
  run: () => Promise<Record<string, unknown>>;
}): Promise<Response> {
  const { c, operationKey, successStatus, scope, body, headers } = opts;
  const idempotency = c.get('idempotency');
  const idempotencyKey = headers['X-Idempotency-Key'];

  if (idempotencyKey?.trim() && scope) {
    const existing = await idempotency.lookupExistingOrThrow(idempotencyKey, scope);
    if (existing.kind === 'replay') {
      if (existing.status === successStatus) {
        requireValidResponse(operationKey, successStatus, existing.body);
      }
      return c.json(
        existing.body as Record<string, unknown>,
        existing.status as 200 | 201,
      );
    }
  }

  requireValidRequest(operationKey as YunoMvpOperationKey, body, headers);
  if (!idempotencyKey?.trim()) {
    throw Errors.invalidRequest('missing required header X-Idempotency-Key');
  }

  const gate = await idempotency.beginOrThrow(idempotencyKey, scope);
  if (gate.kind === 'replay') {
    if (gate.status === successStatus) {
      requireValidResponse(operationKey, successStatus, gate.body);
    }
    return c.json(gate.body as Record<string, unknown>, gate.status as 200 | 201);
  }

  try {
    const config = c.get('config');
    const runtime = c.get('runtime');
    const result = await opts.run();
    requireValidResponse(operationKey, successStatus, result);
    assertNoSensitiveMaterial(result, secretList(config));
    await idempotency.complete(idempotencyKey, successStatus, result, scope);
    await processDueDeliveries(c.get('repo'), runtime, config.secretsKey);
    return c.json(result, successStatus);
  } catch (err) {
    const { YunoHttpError } = await import('../errors.js');
    if (err instanceof YunoHttpError && err.status < 500) {
      await idempotency.abandonWithoutConsume(idempotencyKey, scope);
    } else {
      await idempotency.consumeWithoutResult(idempotencyKey, scope);
    }
    throw err;
  }
}

export function registerPaymentRoutes(app: MockApp): void {
  app.post('/v1/payments', async (c) => {
    const headers = headerMapFromHono(c);
    const body = (await readJsonBody(c)) as CreatePaymentBody;
    const idempotency = c.get('idempotency');
    const idempotencyKey = headers['X-Idempotency-Key'];

    const scope = paymentIdempotencyScope(body);
    if (idempotencyKey?.trim() && scope) {
      const existing = await idempotency.lookupExistingOrThrow(idempotencyKey, scope);
      if (existing.kind === 'replay') {
        if (existing.status === 201) {
          requireValidResponse('create-payment', 201, existing.body);
        }
        return c.json(
          existing.body as Record<string, unknown>,
          existing.status as 201 | 500,
        );
      }
    }

    requireValidRequest('create-payment', body, headers);
    if (!idempotencyKey?.trim()) {
      throw Errors.invalidRequest('missing required header X-Idempotency-Key');
    }
    if (!scope) {
      throw Errors.invalidRequest('account_id must be a UUID');
    }

    const repo = c.get('repo');
    await repo.withLock((store) => {
      assertCreatePaymentPreconditions(store, body);
    });

    const gate = await idempotency.beginOrThrow(idempotencyKey, scope);
    if (gate.kind === 'replay') {
      if (gate.status === 201) {
        requireValidResponse('create-payment', 201, gate.body);
      }
      return c.json(gate.body as Record<string, unknown>, gate.status as 201 | 500);
    }

    try {
      const config = c.get('config');
      const runtime = c.get('runtime');
      const result = await createPayment(repo, body, idempotencyKey, {
        secretsKey: config.secretsKey,
        nowMs: runtime.clock.now(),
      });
      if (result.httpStatus === 201) {
        requireValidResponse('create-payment', 201, result.body);
      }
      assertNoSensitiveMaterial(result.body, secretList(config));
      await idempotency.complete(idempotencyKey, result.httpStatus, result.body, scope);
      await processDueDeliveries(repo, runtime, config.secretsKey);
      return c.json(result.body, result.httpStatus);
    } catch (err) {
      const { YunoHttpError } = await import('../errors.js');
      if (err instanceof YunoHttpError && err.status < 500) {
        await idempotency.abandonWithoutConsume(idempotencyKey, scope);
      } else {
        await idempotency.consumeWithoutResult(idempotencyKey, scope);
      }
      throw err;
    }
  });

  app.get('/v1/payments/:payment_id', async (c) => {
    const headers = headerMapFromHono(c);
    requireValidRequest('retrieve-payment-by-id-v2', undefined, headers);

    const paymentId = c.req.param('payment_id');
    const result = await getPayment(c.get('repo'), paymentId);
    requireValidResponse('retrieve-payment-by-id-v2', 200, result);

    const config = c.get('config');
    assertNoSensitiveMaterial(result, secretList(config));

    return c.json(result, 200);
  });

  app.post(
    '/v1/payments/:payment_id/transactions/:transaction_id/capture',
    async (c) => {
      const headers = headerMapFromHono(c);
      const body = (await readJsonBody(c)) as CaptureBody;
      const paymentId = c.req.param('payment_id');
      const transactionId = c.req.param('transaction_id');
      const repo = c.get('repo');
      const accountId = await repo.withLock((store) =>
        lookupPaymentAccountId(store, paymentId),
      );
      const scope = captureIdempotencyScope(accountId, paymentId, transactionId);
      const config = c.get('config');
      const runtime = c.get('runtime');

      return withIdempotentMutation({
        c,
        operationKey: 'capture-authorization',
        successStatus: 200,
        scope,
        body,
        headers,
        run: () =>
          capturePayment(repo, paymentId, transactionId, body, {
            secretsKey: config.secretsKey,
            nowMs: runtime.clock.now(),
          }),
      });
    },
  );

  app.post(
    '/v1/payments/:payment_id/transactions/:transaction_id/cancel',
    async (c) => {
      const headers = headerMapFromHono(c);
      const body = (await readJsonBody(c)) as CancelBody;
      const paymentId = c.req.param('payment_id');
      const transactionId = c.req.param('transaction_id');
      const repo = c.get('repo');
      const accountId = await repo.withLock((store) =>
        lookupPaymentAccountId(store, paymentId),
      );
      const scope = cancelIdempotencyScope(accountId, paymentId, transactionId);
      const config = c.get('config');
      const runtime = c.get('runtime');

      return withIdempotentMutation({
        c,
        operationKey: 'cancel-payment',
        successStatus: 200,
        scope,
        body,
        headers,
        run: () =>
          cancelPayment(repo, paymentId, transactionId, body, {
            secretsKey: config.secretsKey,
            nowMs: runtime.clock.now(),
          }),
      });
    },
  );

  // Pin uses `{id}` for the payment path parameter on refund.
  app.post('/v1/payments/:id/transactions/:transaction_id/refund', async (c) => {
    const headers = headerMapFromHono(c);
    const body = (await readJsonBody(c)) as RefundBody;
    const paymentId = c.req.param('id');
    const transactionId = c.req.param('transaction_id');
    const repo = c.get('repo');
    const accountId = await repo.withLock((store) =>
      lookupPaymentAccountId(store, paymentId),
    );
    const scope = refundIdempotencyScope(accountId, paymentId, transactionId);
    const config = c.get('config');
    const runtime = c.get('runtime');

    return withIdempotentMutation({
      c,
      operationKey: 'refund-payment',
      successStatus: 200,
      scope,
      body,
      headers,
      run: () =>
        refundPayment(repo, paymentId, transactionId, body, {
          secretsKey: config.secretsKey,
          nowMs: runtime.clock.now(),
        }),
    });
  });

  app.post('/v1/payments/:payment_id/cancel-or-refund', async (c) => {
    const headers = headerMapFromHono(c);
    const body = (await readJsonBody(c)) as CancelOrRefundBody;
    const paymentId = c.req.param('payment_id');
    const repo = c.get('repo');
    const accountId = await repo.withLock((store) =>
      lookupPaymentAccountId(store, paymentId),
    );
    const scope = cancelOrRefundPaymentIdempotencyScope(accountId, paymentId);
    const config = c.get('config');
    const runtime = c.get('runtime');

    return withIdempotentMutation({
      c,
      operationKey: 'cancel-or-refund-a-payment',
      successStatus: 201,
      scope,
      body,
      headers,
      run: async () => {
        const result = await cancelOrRefundPayment(repo, paymentId, body, {
          secretsKey: config.secretsKey,
          nowMs: runtime.clock.now(),
        });
        return result.body;
      },
    });
  });

  app.post(
    '/v1/payments/:payment_id/transactions/:transaction_id/cancel-or-refund',
    async (c) => {
      const headers = headerMapFromHono(c);
      const body = (await readJsonBody(c)) as CancelOrRefundBody;
      const paymentId = c.req.param('payment_id');
      const transactionId = c.req.param('transaction_id');
      const repo = c.get('repo');
      const accountId = await repo.withLock((store) =>
        lookupPaymentAccountId(store, paymentId),
      );
      const scope = cancelOrRefundTxIdempotencyScope(
        accountId,
        paymentId,
        transactionId,
      );
      const config = c.get('config');
      const runtime = c.get('runtime');

      return withIdempotentMutation({
        c,
        operationKey: 'cancel-or-refund-payment-with-transaction',
        successStatus: 201,
        scope,
        body,
        headers,
        run: async () => {
          const result = await cancelOrRefundPaymentTransaction(
            repo,
            paymentId,
            transactionId,
            body,
            {
              secretsKey: config.secretsKey,
              nowMs: runtime.clock.now(),
            },
          );
          return result.body;
        },
      });
    },
  );
}
