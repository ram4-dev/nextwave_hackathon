import { Hono } from 'hono';
import type { MockConfig } from './config.js';
import { authenticateApiKeys } from './auth.js';
import { Errors, YunoHttpError } from './errors.js';
import { matchMvpRoute } from './mvp-routes.js';
import type { YunoMockRepository } from './persistence/index.js';
import { redactSecrets, resolveRequestId } from './redact.js';
import { ProviderIdempotency } from './idempotency/primitive.js';
import { rejectSensitiveV1Body } from './domain/sensitive.js';
import { registerEnrollmentRoutes } from './routes/enrollment.js';
import { registerPaymentRoutes } from './routes/payments.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerTestEnrollmentRoutes } from './routes/test-enrollment.js';
import { registerTestScenarioRoutes } from './routes/test-scenarios.js';
import { registerTestActionRoutes } from './routes/test-actions.js';
import { createRuntime, type MockRuntime } from './runtime.js';

export type AppVariables = {
  requestId: string;
  config: MockConfig;
  repo: YunoMockRepository;
  idempotency: ProviderIdempotency;
  runtime: MockRuntime;
};

export type MockApp = Hono<{ Variables: AppVariables }>;

export type CreateAppOptions = {
  config: MockConfig;
  repo: YunoMockRepository;
  runtime?: MockRuntime;
};

function header(
  c: { req: { header: (name: string) => string | undefined } },
  name: string,
): string | undefined {
  return c.req.header(name) ?? c.req.header(name.toLowerCase());
}

export function createApp(options: CreateAppOptions): MockApp {
  const { config, repo } = options;
  const runtime = options.runtime ?? createRuntime();
  const idempotency = new ProviderIdempotency(repo);
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', async (c, next) => {
    const requestId = resolveRequestId(header(c, 'X-Request-Id'));
    c.set('requestId', requestId);
    c.set('config', config);
    c.set('repo', repo);
    c.set('idempotency', idempotency);
    c.set('runtime', runtime);
    c.header('X-Request-Id', requestId);
    await next();
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? resolveRequestId(undefined);
    c.header('X-Request-Id', requestId);
    if (err instanceof YunoHttpError) {
      return c.json(err.toBody(), err.status as 400 | 401 | 404 | 501);
    }
    const secrets = [
      config.YUNO_PUBLIC_API_KEY,
      config.YUNO_PRIVATE_SECRET_KEY,
      config.YUNO_MOCK_FINGERPRINT_SECRET,
    ];
    const message = redactSecrets(
      err instanceof Error ? err.message : 'Internal error',
      secrets,
    );
    console.error(`[yuno-mock] ${requestId} ${message}`);
    return c.json({ code: 'INTERNAL_ERROR', messages: ['Internal server error'] }, 500);
  });

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'yuno-rest-mock',
      phase: 'F5',
    }),
  );

  // Test/dev controls — outside /v1; 404 in production.
  registerTestEnrollmentRoutes(app);
  registerTestScenarioRoutes(app);
  registerTestActionRoutes(app);

  // Authenticated /v1 boundary
  app.use('/v1/*', async (c, next) => {
    const result = authenticateApiKeys({
      expectedPublic: config.YUNO_PUBLIC_API_KEY,
      expectedPrivate: config.YUNO_PRIVATE_SECRET_KEY,
      publicKey: header(c, 'public-api-key'),
      privateKey: header(c, 'private-secret-key'),
    });
    if (result === 'missing') throw Errors.missingCredentials();
    if (result === 'invalid') throw Errors.invalidCredentials();
    await next();
  });

  // JSON body guard for mutating methods under /v1 — parse + reject sensitive
  // instrument material before any repository/idempotency mutation.
  // /test/enrollment/tokenize is outside /v1 and is the only PAN/CVV exception.
  app.use('/v1/*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const contentType = header(c, 'content-type') ?? '';
      if (contentType.includes('application/json')) {
        const raw = await c.req.text();
        if (raw.trim() !== '') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw Errors.invalidJson();
          }
          rejectSensitiveV1Body(parsed);
        }
      }
    }
    await next();
  });

  registerEnrollmentRoutes(app);
  registerPaymentRoutes(app);
  registerWebhookRoutes(app);

  app.all('/v1/*', (c) => {
    const url = new URL(c.req.url);
    const underV1 = url.pathname.replace(/^\/v1/, '') || '/';
    const matched = matchMvpRoute(c.req.method, underV1);
    if (matched) {
      throw Errors.notImplemented(`${matched.method} /v1${matched.path}`);
    }
    throw Errors.notFound(`No Yuno MVP route for ${c.req.method} /v1${underV1}`);
  });

  return app;
}
