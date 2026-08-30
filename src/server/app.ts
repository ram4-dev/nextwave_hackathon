import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hex } from 'viem';
import type { AppConfig } from '../config/env.js';
import { publicClientConfig } from '../config/env.js';
import { registerPaymentRoutes } from '../api/payments/routes.js';
import {
  createPaymentRuntime,
  type PaymentRuntime,
  type PaymentRuntimeOptions,
} from '../api/payments/runtime.js';
import { AcpError } from '../catalog/acp-contract.js';
import type { MerchantFeedAuthorizer } from '../catalog/acp-contract.js';
import { isCatalog503 } from '../catalog/domain.js';
import type { AcpIngestionService } from '../catalog/ingestion.js';
import type { PostgresAcpIngestionService } from '../catalog/postgres-acp-store.js';
import type { CatalogSearchService } from '../catalog/search.js';
import { PaymentError } from '../domain/payments/helpers.js';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';
import { CeremonyService } from '../services/ceremony.js';
import { createAcpCatalogRoutes } from './acp-catalog-routes.js';
import { createCatalogRoutes } from './catalog-routes.js';
import {
  issueSessionToken,
  issueSiweNonce,
  verifySessionToken,
  verifySiweLogin,
} from '../auth/siwe.js';
import type { CredentialClaims } from '../credentials/jws.js';
import { getJwks, verifyKyaCredential } from '../credentials/jws.js';

type Variables = {
  address: `0x${string}`;
  agentClaims?: CredentialClaims;
};

export type CreateAppDeps = {
  catalogSearch?: CatalogSearchService;
  acpIngestion?: AcpIngestionService | PostgresAcpIngestionService;
  acpAuthorizer?: MerchantFeedAuthorizer;
} & PaymentRuntimeOptions & {
  /** Pre-built payment runtime (e.g. from index.ts). */
  payment?: PaymentRuntime | null;
};

function isPaymentRuntime(
  value: CreateAppDeps | PaymentRuntime | null | undefined,
): value is PaymentRuntime {
  return Boolean(value && typeof value === 'object' && 'configured' in value && value.configured);
}

/**
 * Create the root Hono app (KYA ceremony host + optional catalog + payments).
 *
 * Third argument accepts:
 * - catalog/ACP deps object (origin/main)
 * - PaymentRuntime / PaymentRuntimeOptions (demo_mock F6)
 * - a combined CreateAppDeps bag
 * - null / omitted (ceremony-only)
 */
export function createApp(
  repo: Repository,
  config: AppConfig,
  depsOrPayment: CreateAppDeps | PaymentRuntime | null = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const ceremony = new CeremonyService(repo, config);

  const deps: CreateAppDeps = isPaymentRuntime(depsOrPayment)
    ? { payment: depsOrPayment }
    : (depsOrPayment ?? {});

  const paymentRuntime: PaymentRuntime | null = isPaymentRuntime(deps.payment)
    ? deps.payment
    : createPaymentRuntime(config, deps);

  app.use(
    '*',
    cors({
      origin: ['http://localhost:5173', 'http://127.0.0.1:5173', config.PUBLIC_BASE_URL],
      credentials: true,
    }),
  );

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  });

  app.onError((err, c) => {
    if (err instanceof PaymentError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus as 400);
    }
    if (err instanceof AcpError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus as 400);
    }
    if (err instanceof DomainError) {
      if (err.code === 'INTERNAL_ERROR') {
        return c.json({ error: 'Internal error', code: 'INTERNAL_ERROR' }, 500);
      }
      if (isCatalog503(err.code)) {
        const error =
          err.code === 'CATALOG_UNAVAILABLE'
            ? 'Catalog unavailable'
            : err.code === 'EMBEDDING_UNAVAILABLE'
              ? 'Embedding unavailable'
              : 'Search unavailable';
        return c.json({ error, code: err.code }, 503);
      }
      const status =
        err.code === 'UNAUTHORIZED'
          ? 401
          : err.code === 'FORBIDDEN'
            ? 403
            : err.code === 'NOT_FOUND'
              ? 404
              : 400;
      return c.json({ error: err.message, code: err.code }, status);
    }
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  app.route('/', createCatalogRoutes(deps.catalogSearch));
  app.route(
    '/',
    createAcpCatalogRoutes({
      enabled: config.CATALOG_ACP_ENABLED,
      authorizer: deps.acpAuthorizer,
      ingestion: deps.acpIngestion,
    }),
  );

  app.get('/health', (c) => c.json({ ok: true, mode: config.KYA_MODE }));

  app.get('/v1/config', (c) => c.json(publicClientConfig(config)));

  app.get('/.well-known/jwks.json', async (c) => c.json(await getJwks(repo)));

  // --- Auth (SIWE) ---
  app.get('/v1/auth/nonce', async (c) => {
    const nonce = await issueSiweNonce(repo, config.NONCE_TTL_SECONDS);
    return c.json(nonce);
  });

  app.post('/v1/auth/verify', async (c) => {
    const body = await c.req.json<{
      address: `0x${string}`;
      message: string;
      signature: Hex;
    }>();
    if (config.KYA_MODE === 'demo' && body.message.includes('DEMO_BYPASS')) {
      const address = body.address.toLowerCase() as `0x${string}`;
      await issueSiweNonce(repo, config.NONCE_TTL_SECONDS);
      const token = await issueSessionToken(repo, config, address);
      const principal = await ceremony.findOrCreatePrincipal(address);
      return c.json({ token, address, principalId: principal.id, demo: true });
    }
    const { address } = await verifySiweLogin(repo, config, body);
    const token = await issueSessionToken(repo, config, address);
    const principal = await ceremony.findOrCreatePrincipal(address);
    return c.json({ token, address, principalId: principal.id, demo: false });
  });

  const requireSession = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    const token = header.slice('Bearer '.length);
    const address = await verifySessionToken(repo, config, token);
    c.set('address', address);
    await next();
  });

  // --- Public resolve (no PII) ---
  app.get('/v1/resolve', async (c) => {
    const agentUuid = c.req.query('agentUuid') ?? undefined;
    const agentRegistry = c.req.query('agentRegistry') ?? undefined;
    const agentId = c.req.query('agentId') ?? undefined;
    const result = await ceremony.resolvePublic({ agentUuid, agentRegistry, agentId });
    return c.json(result);
  });

  // --- Enrollment ---
  app.post('/v1/enrollments', async (c) => {
    const body = await c.req.json<{
      publicJwk: JsonWebKey;
      keystoreProvider: 'os_hardware' | 'encrypted_os_keystore';
    }>();
    const result = await ceremony.startEnrollment(body);
    return c.json(result, 201);
  });

  app.post('/v1/enrollments/:agentUuid/attach', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const result = await ceremony.attachHuman(agentUuid, address);
    return c.json({
      status: result.enrollment.status,
      principalId: result.principal.id,
      needsKyc: result.needsKyc,
      thumbprint: result.enrollment.thumbprint,
    });
  });

  app.post('/v1/enrollments/:agentUuid/approve-fingerprint', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const body = await c.req.json<{ thumbprint: string }>();
    const enrollment = await ceremony.approveFingerprint(
      agentUuid,
      address,
      body.thumbprint,
    );
    return c.json({
      status: enrollment.status,
      fingerprintApprovedAt: enrollment.fingerprintApprovedAt,
      agentId: enrollment.agentId,
      agentRegistry: enrollment.agentRegistry,
    });
  });

  app.post('/v1/enrollments/:agentUuid/prepare-register', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const chainId = Number(c.req.query('chainId') ?? 84532);
    const result = await ceremony.prepareRegister(agentUuid, address, chainId);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/confirm-demo', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const result = await ceremony.confirmDemoRegistration(agentUuid, address);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/claim-credential', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const result = await ceremony.claimCredential(agentUuid, address);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/rotate', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const body = await c.req.json<{
      publicJwk: JsonWebKey;
      keystoreProvider: 'os_hardware' | 'encrypted_os_keystore';
    }>();
    const enrollment = await ceremony.rotateKey(
      agentUuid,
      address,
      body.publicJwk,
      body.keystoreProvider,
    );
    return c.json({
      status: enrollment.status,
      thumbprint: enrollment.thumbprint,
      agentId: enrollment.agentId,
      agentRegistry: enrollment.agentRegistry,
      fingerprintDisplay: enrollment.thumbprint.slice(0, 16),
    });
  });

  app.post('/v1/enrollments/:agentUuid/revoke', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const enrollment = await ceremony.revokeAgent(agentUuid, address);
    return c.json({ status: enrollment.status });
  });

  app.post('/v1/enrollments/:agentUuid/rebind', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const body = await c.req.json<{ thumbprint: string }>();
    const enrollment = await ceremony.rebindAfterTransfer(
      agentUuid,
      address,
      body.thumbprint,
    );
    return c.json({
      status: enrollment.status,
      agentId: enrollment.agentId,
      agentRegistry: enrollment.agentRegistry,
      principalId: enrollment.principalId,
    });
  });

  // Enrollment detail — session + owner/current-owner auth; no public PII dump.
  app.get('/v1/enrollments/:agentUuid', requireSession, async (c) => {
    const address = c.get('address')!;
    const e = await ceremony.getEnrollmentAuthorized(c.req.param('agentUuid'), address);
    return c.json({
      agentUuid: e.agentUuid,
      status: e.status,
      thumbprint: e.thumbprint,
      keystoreProvider: e.keystoreProvider,
      agentRegistry: e.agentRegistry,
      agentId: e.agentId,
      owner: e.owner,
      // deviceCode / principalId only for authorized owner session
      deviceCode: e.deviceCode,
      principalId: e.principalId,
    });
  });

  // --- KYC ---
  app.post('/v1/kyc/sessions', requireSession, async (c) => {
    const address = c.get('address')!;
    const provider = c.req.query('provider') ?? undefined;
    const result = await ceremony.startKyc(address, provider);
    return c.json(result, 201);
  });

  app.post('/v1/kyc/webhooks/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (config.KYA_MODE === 'live' && provider === 'demo') {
      return c.json(
        { error: 'Demo KYC webhook forbidden in live mode', code: 'KYC_DEMO_FORBIDDEN' },
        400,
      );
    }
    const rawBody = await c.req.text();
    const headers: Record<string, string | undefined> = {};
    c.req.raw.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const result = await ceremony.handleKycWebhook(provider, headers, rawBody);
    return c.json({
      ok: true,
      idempotent: result.idempotent,
      status: result.normalized.status,
      provider: result.normalized.provider,
    });
  });

  app.post('/v1/kyc/demo/complete', requireSession, async (c) => {
    if (config.KYA_MODE !== 'demo') {
      return c.json(
        { error: 'Demo KYC completion forbidden in live mode', code: 'KYC_DEMO_FORBIDDEN' },
        400,
      );
    }
    const address = c.get('address')!;
    const started = await ceremony.startKyc(address);
    const { DemoKycAdapter } = await import('../kyc/demo.js');
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: started.sessionId,
      status: 'verified',
      event_id: `demo-complete-${started.sessionId}`,
    });
    const result = await ceremony.handleKycWebhook(
      'demo',
      { 'x-demo-signature': signature },
      rawBody,
    );
    return c.json({ ok: true, status: result.normalized.status });
  });

  // --- Agent URI ---
  app.get('/v1/agents/:agentUuid/agent-uri.json', async (c) => {
    const doc = await ceremony.getAgentUriDocument(c.req.param('agentUuid'));
    return c.json(doc);
  });

  // --- Challenges ---
  app.post('/v1/agents/:agentUuid/challenges', async (c) => {
    const body = await c.req.json<{ intent?: unknown }>();
    const challenge = await ceremony.createChallenge(
      c.req.param('agentUuid'),
      body.intent ?? { action: 'authenticate' },
    );
    return c.json(challenge);
  });

  app.post('/v1/agents/:agentUuid/challenges/verify', async (c) => {
    const body = await c.req.json<{
      nonce: string;
      audience: string;
      timestamp: string;
      intent_hash: string;
      signature: string;
    }>();
    const result = await ceremony.verifyChallenge(c.req.param('agentUuid'), body);
    return c.json(result);
  });

  // --- Credentials ---
  app.get('/v1/credentials/:jti/status', async (c) => {
    const store = await repo.getStore();
    const cred = store.credentials.find((x) => x.jti === c.req.param('jti'));
    if (!cred) return c.json({ error: 'Not found' }, 404);
    return c.json({
      jti: cred.jti,
      status: cred.status,
      expiresAt: cred.expiresAt,
    });
  });

  app.post('/v1/credentials/verify', async (c) => {
    const body = await c.req.json<{ token: string }>();
    const claims = await verifyKyaCredential(repo, config, body.token);
    return c.json({ ok: true, claims });
  });

  // --- Principals ---
  app.get('/v1/me', requireSession, async (c) => {
    const address = c.get('address')!;
    const store = await repo.getStore();
    const principal = store.principals.find(
      (p) => p.ownerAddress.toLowerCase() === address.toLowerCase(),
    );
    const agents = store.enrollments.filter(
      (e) =>
        e.principalId === principal?.id ||
        (e.owner && e.owner.toLowerCase() === address.toLowerCase()),
    );
    return c.json({
      address,
      principal: principal
        ? {
            id: principal.id,
            kycStatus: principal.kycStatus,
            kycExpiresAt: principal.kycExpiresAt,
            agentCount: agents.length,
          }
        : null,
      agents: agents.map((a) => ({
        agentUuid: a.agentUuid,
        status: a.status,
        thumbprint: a.thumbprint,
        agentId: a.agentId,
      })),
    });
  });

  registerPaymentRoutes(app, {
    repo,
    config,
    payment: paymentRuntime,
    requireSession,
  });

  app.use(
    '/app/*',
    serveStatic({
      root: './web/dist',
      rewriteRequestPath: (p) => p.replace(/^\/app/, ''),
    }),
  );

  return { app, ceremony, payment: paymentRuntime };
}
