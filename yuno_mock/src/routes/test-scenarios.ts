import type { MockApp } from '../app.js';
import { Errors } from '../errors.js';
import {
  DEFAULT_PAYMENT_SCENARIO,
  PAYMENT_SCENARIOS,
  isPaymentScenario,
} from '../domain/scenarios.js';
import {
  getPaymentScenario,
  resetPaymentScenario,
  setPaymentScenario,
} from '../services/scenarios.js';

/**
 * Test/dev scenario control — outside /v1. 404 in production.
 * Never accept scenario selection on public payment request bodies.
 */
export function registerTestScenarioRoutes(app: MockApp): void {
  app.get('/test/scenarios/payments', async (c) => {
    const config = c.get('config');
    if (config.NODE_ENV === 'production') {
      throw Errors.notFound('Not found');
    }
    const current = await getPaymentScenario(c.get('repo'));
    return c.json({
      ...current,
      available: [...PAYMENT_SCENARIOS],
      default: DEFAULT_PAYMENT_SCENARIO,
    });
  });

  app.put('/test/scenarios/payments', async (c) => {
    const config = c.get('config');
    if (config.NODE_ENV === 'production') {
      throw Errors.notFound('Not found');
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      throw Errors.invalidJson();
    }
    const scenario = body.scenario;
    if (!isPaymentScenario(scenario)) {
      throw Errors.invalidRequest(
        `scenario must be one of: ${PAYMENT_SCENARIOS.join(', ')}`,
      );
    }
    const result = await setPaymentScenario(c.get('repo'), scenario);
    return c.json(result, 200);
  });

  app.delete('/test/scenarios/payments', async (c) => {
    const config = c.get('config');
    if (config.NODE_ENV === 'production') {
      throw Errors.notFound('Not found');
    }
    const result = await resetPaymentScenario(c.get('repo'));
    return c.json(result, 200);
  });
}
