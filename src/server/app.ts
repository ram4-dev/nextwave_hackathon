import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppConfig } from '../config/env.js';
import { publicClientConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import { AcpError } from '../catalog/acp-contract.js';
import { isCatalog503 } from '../catalog/domain.js';
import type { MerchantFeedAuthorizer } from '../catalog/acp-contract.js';
import type { AcpIngestionService } from '../catalog/ingestion.js';
import type { PostgresAcpIngestionService } from '../catalog/postgres-acp-store.js';
import type { CatalogSearchService } from '../catalog/search.js';
import type { Repository } from '../persistence/repository.js';
import { CeremonyService } from '../services/ceremony.js';
import { createAcpCatalogRoutes } from './acp-catalog-routes.js';
import { createCatalogRoutes } from './catalog-routes.js';
import { bindCdpIdentity, createCdpIdentityVerifier, createCdpUserOperationStatusProvider, CdpIdentityError, type CdpIdentityVerifier } from '../auth/cdp.js';
import { issueHumanSession, verifyHumanSession } from '../auth/session.js';
import {
  createRequireAgentAuth,
  type AgentAuthVariables,
} from '../auth/dpop.js';
import { getJwks, verifyKyaCredential } from '../credentials/jws.js';
import {
  createMemoryRateLimiter,
  createFailSafeClientKeyResolver,
  hasDurableRateLimitAuthority,
} from './rate-limit.js';
import type { ClientKeyResolver, RateLimiter } from './rate-limit.js';
import { readBoundedBody, readBoundedText } from './request-body.js';

type Variables = {
  principalId: string;
  address: `0x${string}`;
} & Partial<AgentAuthVariables>;

export function createApp(
  repo: Repository,
  config: AppConfig,
  deps: {
    catalogSearch?: CatalogSearchService;
    acpIngestion?: AcpIngestionService | PostgresAcpIngestionService;
    acpAuthorizer?: MerchantFeedAuthorizer;
    cdpVerifier?: CdpIdentityVerifier;
    persistenceReady?: () => Promise<boolean>;
    /** Optional injectable limiter. Default is in-process only — not multi-instance authority. */
    publicRateLimiter?: RateLimiter;
    clientKeyResolver?: ClientKeyResolver;
  } = {},
) {
  const app = new Hono<{ Variables: Variables }>();
  const ceremony = new CeremonyService(repo, config);
  const publicLimiter =
    deps.publicRateLimiter ?? createMemoryRateLimiter({ limit: 60, windowMs: 60_000 });
  const durableRequired =
    config.KYA_MODE === 'live' || config.PERSISTENCE_BACKEND === 'supabase';
  const durableAuthority = hasDurableRateLimitAuthority(publicLimiter);
  const resolveClientKey =
    deps.clientKeyResolver ?? createFailSafeClientKeyResolver();
  /** Rate-limit public pairing/auth surfaces. Live without durable limiter → UNAVAILABLE. */
  const checkPublicRate = async (c: {
    req: { header: (n: string) => string | undefined; path: string };
  }) => {
    if (durableRequired && !durableAuthority) {
      throw new DomainError('Durable rate limiter required in live mode', 'UNAVAILABLE');
    }
    const key = resolveClientKey({ header: (n) => c.req.header(n), path: c.req.path });
    const result = await publicLimiter.check(`pub:${key}`);
    if (!result.allowed) throw new DomainError('Rate limit exceeded', 'RATE_LIMIT');
  };

  const requireRateLimit = createMiddleware<{ Variables: Variables }>(
    async (c, next) => {
      await checkPublicRate(c);
      await next();
    },
  );

  const readJsonBody = async <T>(c: { req: { raw: Request } }): Promise<T> => {
    const raw = await readBoundedText(c.req.raw);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new DomainError('Invalid JSON body', 'INVALID_KEY');
    }
  };

  const discardBoundedBody = async (c: { req: { raw: Request } }): Promise<void> => {
    await readBoundedBody(c.req.raw);
  };

  app.use(
    '*',
    cors({
      origin: (origin) => origin === config.FRONTEND_ORIGIN || origin === config.PUBLIC_BASE_URL ? origin : '',
      credentials: true,
    }),
  );

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  });

  app.onError((err, c) => {
    if (err instanceof CdpIdentityError) {
      const status = err.code === 'CDP_UNAVAILABLE' ? 503 : 401;
      return c.json({ error: err.code === 'CDP_UNAVAILABLE' ? 'Authentication provider unavailable' : 'Authentication failed', code: err.code }, status);
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
            : err.code === 'RATE_LIMIT'
              ? 429
              : err.code === 'PAYLOAD_TOO_LARGE'
                ? 413
              : err.code === 'UNAVAILABLE' || err.code === 'CAS_CONFLICT'
                ? 503
            : err.code === 'NOT_FOUND'
              ? 404
              : 400;
      return c.json(
        {
          error:
            status === 503 ? 'Dependency unavailable' : err.message,
          code: err.code === 'CAS_CONFLICT' ? 'UNAVAILABLE' : err.code,
        },
        status,
      );
    }
    console.error('Unhandled KYA request error');
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

  app.get('/ready', async (c) => {
    const persistence = config.PERSISTENCE_BACKEND;
    const supabaseConfigured = Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
    const schemaOk =
      persistence !== 'supabase'
        ? true
        : Boolean(supabaseConfigured && (await deps.persistenceReady?.().catch(() => false)));
    const rateLimitOk =
      !durableRequired ||
      Boolean(
        durableAuthority &&
          (await Promise.resolve(publicLimiter.ready()).catch(() => false)),
      );
    // JSON is never ready for live; memory/json only ready in non-live modes.
    const ready =
      (persistence === 'memory' && config.KYA_MODE !== 'live') ||
      (persistence === 'json' && config.KYA_MODE !== 'live') ||
      (persistence === 'supabase' && schemaOk === true && rateLimitOk);
    const body = {
      ready,
      mode: config.KYA_MODE,
      persistence,
      dependencies: {
        supabase: persistence === 'supabase' ? (schemaOk ? 'ok' : 'unavailable') : 'not_configured',
        rateLimit: rateLimitOk ? 'ok' : 'unavailable',
        catalog: deps.catalogSearch ? 'configured' : 'not_configured',
      },
    };
    return c.json(body, ready ? 200 : 503);
  });

  app.get('/v1/config', (c) => c.json(publicClientConfig(config)));

  app.get('/.well-known/jwks.json', async (c) => c.json(await getJwks(repo)));

  // --- Auth (CDP email OTP access-token exchange) ---
  app.post('/v1/auth/cdp/exchange', async (c) => {
    await checkPublicRate(c);
    const body = await readJsonBody<{ accessToken?: unknown }>(c);
    if (typeof body.accessToken !== 'string' || body.accessToken.length < 1 || body.accessToken.length > 16_384) {
      throw new DomainError('Invalid authentication request', 'UNAUTHORIZED');
    }
    if (!deps.cdpVerifier && (!config.CDP_API_KEY_ID || !config.CDP_API_KEY_SECRET)) {
      throw new CdpIdentityError('CDP authentication provider unavailable', 'CDP_UNAVAILABLE');
    }
    const verifier = deps.cdpVerifier ?? await createCdpIdentityVerifier();
    const identity = await verifier.validate(body.accessToken);
    const principal = await bindCdpIdentity(repo, identity);
    const token = await issueHumanSession(repo, config, principal);
    return c.json({ token, wallet: principal.ownerAddress, principalId: principal.id });
  });

  const requireSession = createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
    }
    const token = header.slice('Bearer '.length);
    const session = await verifyHumanSession(repo, config, token);
    c.set('address', session.wallet);
    c.set('principalId', session.principalId);
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
  /** @deprecated Prefer POST /v1/device-enrollments — same rate limit and body cap; not a bypass. */
  app.post('/v1/enrollments', async (c) => {
    await checkPublicRate(c);
    const body = await readJsonBody<{
      publicJwk: JsonWebKey;
      keystoreProvider: 'os_hardware' | 'encrypted_os_keystore';
    }>(c);
    const result = await ceremony.startEnrollment(body);
    return c.json(result, 201);
  });

  app.post('/v1/device-enrollments', async (c) => {
    await checkPublicRate(c);
    const body = await readJsonBody<{
      publicJwk: JsonWebKey;
      keystoreProvider?: 'os_hardware' | 'encrypted_os_keystore';
    }>(c);
    const result = await ceremony.startDeviceEnrollment(body);
    return c.json(
      {
        agentUuid: result.agentUuid,
        device_code: result.device_code,
        user_code: result.user_code,
        verification_uri: result.verification_uri,
        verification_uri_complete: result.verification_uri_complete,
        expires_in: result.expires_in,
        interval: result.interval,
        thumbprint: result.thumbprint,
        fingerprintDisplay: result.fingerprintDisplay,
        agentUriUrl: result.agentUriUrl,
      },
      201,
    );
  });

  app.post('/v1/device-enrollments/claim', requireRateLimit, requireSession, async (c) => {
    const body = await readJsonBody<{ user_code?: string; thumbprint?: string }>(c);
    if (typeof body.user_code !== 'string' || typeof body.thumbprint !== 'string') {
      throw new DomainError('Invalid claim request', 'UNAUTHORIZED');
    }
    const result = await ceremony.claimDeviceEnrollment(
      body.user_code,
      c.get('principalId')!,
      body.thumbprint,
    );
    return c.json({
      status: result.enrollment.status,
      agentUuid: result.enrollment.agentUuid,
      principalId: result.principal.id,
      needsKyc: result.needsKyc,
      thumbprint: result.enrollment.thumbprint,
    });
  });

  app.post('/v1/device-enrollments/token', async (c) => {
    await checkPublicRate(c);
    const body = await readJsonBody<{ device_code?: string }>(c);
    if (typeof body.device_code !== 'string' || body.device_code.length < 8) {
      throw new DomainError('Invalid device code', 'UNAUTHORIZED');
    }
    const result = await ceremony.pollDeviceEnrollmentToken(body.device_code);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/approve-fingerprint', requireRateLimit, requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const body = await readJsonBody<{ thumbprint: string }>(c);
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

  app.post('/v1/enrollments/:agentUuid/registration-intent', requireRateLimit, requireSession, async (c) => {
    await discardBoundedBody(c);
    const agentUuid = c.req.param('agentUuid');
    const result = await ceremony.prepareRegistrationIntent(agentUuid, c.get('principalId')!);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/registration-submissions', requireRateLimit, requireSession, async (c) => {
    const body = await readJsonBody<{ intentHash?: unknown; userOpHash?: unknown; transactionHash?: unknown }>(c);
    if (typeof body.intentHash !== 'string' || typeof body.userOpHash !== 'string' || body.transactionHash !== undefined) {
      throw new DomainError('Invalid registration submission', 'USER_OPERATION');
    }
    const result = await ceremony.recordRegistrationSubmission(
      c.req.param('agentUuid'), c.get('principalId')!, body.intentHash, body.userOpHash as `0x${string}`,
    );
    return c.json(result, result.idempotent ? 200 : 201);
  });

  app.post('/v1/enrollments/:agentUuid/registration-submissions/resolve', requireRateLimit, requireSession, async (c) => {
    await discardBoundedBody(c);
    ceremony.setUserOperationStatusProvider(await createCdpUserOperationStatusProvider());
    const result = await ceremony.resolveRegistrationSubmission(c.req.param('agentUuid'), c.get('principalId')!);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/confirm-demo', requireRateLimit, requireSession, async (c) => {
    await discardBoundedBody(c);
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const result = await ceremony.confirmDemoRegistration(agentUuid, address);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/claim-credential', requireRateLimit, requireSession, async (c) => {
    await discardBoundedBody(c);
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const result = await ceremony.claimCredential(agentUuid, address);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/rotate', requireRateLimit, requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const body = await readJsonBody<{
      publicJwk: JsonWebKey;
      keystoreProvider: 'os_hardware' | 'encrypted_os_keystore';
    }>(c);
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

  app.post('/v1/enrollments/:agentUuid/revoke', requireRateLimit, requireSession, async (c) => {
    await discardBoundedBody(c);
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const enrollment = await ceremony.revokeAgent(agentUuid, address);
    return c.json({ status: enrollment.status });
  });

  app.post('/v1/enrollments/:agentUuid/rebind', requireRateLimit, requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const body = await readJsonBody<{ thumbprint: string }>(c);
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

  // Enrollment detail — session + owner auth; never return plaintext codes or hashes as secrets.
  app.get('/v1/enrollments/:agentUuid', requireRateLimit, requireSession, async (c) => {
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
      principalId: e.principalId,
      pairingExpiresAt: e.pairingExpiresAt,
      claimedAt: e.claimedAt,
      credentialDeliveredAt: e.credentialDeliveredAt,
    });
  });

  // --- KYC ---
  app.post('/v1/kyc/sessions', requireRateLimit, requireSession, async (c) => {
    await discardBoundedBody(c);
    const address = c.get('address')!;
    const provider = c.req.query('provider') ?? undefined;
    const result = await ceremony.startKyc(address, provider);
    return c.json(result, 201);
  });

  app.get('/v1/kyc/sessions/:sessionId', requireRateLimit, requireSession, async (c) => {
    const status = await ceremony.getKycSessionStatus(
      c.req.param('sessionId'),
      c.get('principalId')!,
    );
    return c.json(status);
  });

  app.get('/v1/kyc/callback', async (c) => {
    const location = await ceremony.resolveKycNavigationCallback(
      c.req.query('verificationSessionId'),
    );
    return c.redirect(location, 303);
  });

  app.post('/v1/kyc/webhooks/:provider', async (c) => {
    const provider = c.req.param('provider');
    if (config.KYA_MODE === 'live' && provider === 'demo') {
      return c.json(
        { error: 'Demo KYC webhook forbidden in live mode', code: 'KYC_DEMO_FORBIDDEN' },
        400,
      );
    }
    const rawBody = await readBoundedText(c.req.raw);
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

  app.post('/v1/kyc/demo/complete', requireRateLimit, requireSession, async (c) => {
    await discardBoundedBody(c);
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
    await checkPublicRate(c);
    const body = await readJsonBody<{ intent?: unknown }>(c);
    const challenge = await ceremony.createChallenge(
      c.req.param('agentUuid'),
      body.intent ?? { action: 'authenticate' },
    );
    return c.json(challenge);
  });

  app.post('/v1/agents/:agentUuid/challenges/verify', async (c) => {
    await checkPublicRate(c);
    const body = await readJsonBody<{
      nonce: string;
      audience: string;
      timestamp: string;
      intent_hash: string;
      signature: string;
    }>(c);
    const result = await ceremony.verifyChallenge(c.req.param('agentUuid'), body);
    return c.json(result);
  });

  const requireAgentAuth = createRequireAgentAuth(repo, config, {
    requireLiveOwnerOf: config.KYA_MODE === 'live',
    readOwnerOf: async ({ agentRegistry, agentId, principalOwner }) => {
      if (!agentRegistry || !agentId) {
        if (config.KYA_MODE === 'live') {
          throw new DomainError('Registry binding required', 'UNAUTHORIZED');
        }
        return principalOwner;
      }
      const store = await repo.getStore();
      const enrollment = store.enrollments.find(
        (e) => e.agentRegistry === agentRegistry && e.agentId === agentId,
      );
      if (!enrollment) throw new DomainError('Enrollment not found', 'UNAUTHORIZED');
      try {
        return await ceremony.readCurrentOwnerOf(enrollment.agentUuid);
      } catch {
        throw new DomainError('Owner authority unavailable', 'UNAVAILABLE');
      }
    },
  });

  app.get('/v1/agent/me', requireRateLimit, requireAgentAuth, async (c) => {
    const agent = c.get('agent');
    return c.json({
      agentUuid: agent.agentUuid,
      thumbprint: agent.thumbprint,
      credentialJti: agent.credentialJti,
      agentRegistry: agent.agentRegistry,
      agentId: agent.agentId,
      scopes: agent.scopes,
      tokenExpiresAt: agent.tokenExpiresAt,
    });
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
    const body = await readJsonBody<{ token: string }>(c);
    const claims = await verifyKyaCredential(repo, config, body.token);
    return c.json({ ok: true, claims });
  });

  // --- Principals ---
  app.get('/v1/me', requireRateLimit, requireSession, async (c) => {
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

  app.use(
    '/app/*',
    serveStatic({
      root: './web/dist',
      rewriteRequestPath: (p) => p.replace(/^\/app/, ''),
    }),
  );

  return { app, ceremony };
}
