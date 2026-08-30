import type { MockApp } from '../app.js';
import { Errors } from '../errors.js';
import {
  completeThreeDs,
  inspectThreeDs,
  type ThreeDsCompleteResult,
} from '../services/payments.js';
import { processDueWork } from '../services/webhook-delivery.js';

function assertDevTest(c: { get: (k: 'config') => { NODE_ENV: string } }): void {
  if (c.get('config').NODE_ENV === 'production') {
    throw Errors.notFound('Not found');
  }
}

/**
 * Dev/test controls for 3DS challenge inspect/complete and work-queue ticks.
 * Outside /v1. 404 in production.
 */
export function registerTestActionRoutes(app: MockApp): void {
  app.get('/test/payments/:payment_id/3ds', async (c) => {
    assertDevTest(c);
    const result = await inspectThreeDs(c.get('repo'), c.req.param('payment_id'));
    return c.json(result, 200);
  });

  app.post('/test/payments/:payment_id/3ds/complete', async (c) => {
    assertDevTest(c);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw Errors.invalidJson();
    }
    const result = body.result ?? body.outcome;
    if (result !== 'success' && result !== 'fail' && result !== 'expire') {
      throw Errors.invalidRequest('result must be success, fail, or expire');
    }
    const config = c.get('config');
    const runtime = c.get('runtime');
    const payment = await completeThreeDs(
      c.get('repo'),
      c.req.param('payment_id'),
      result as ThreeDsCompleteResult,
      { secretsKey: config.secretsKey, nowMs: runtime.clock.now() },
    );
    await processDueWork(c.get('repo'), runtime, config.secretsKey);
    return c.json(payment, 200);
  });

  app.post('/test/work/process', async (c) => {
    assertDevTest(c);
    const config = c.get('config');
    const runtime = c.get('runtime');
    const summary = await processDueWork(
      c.get('repo'),
      runtime,
      config.secretsKey,
    );
    return c.json(summary, 200);
  });
}
