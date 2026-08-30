import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { serveStatic } from '@hono/node-server/serve-static';
import { getAddress } from 'viem';
import type { AppConfig } from '../config/env.js';
import { publicClientConfig } from '../config/env.js';
import { registerPaymentRoutes } from '../api/payments/routes.js';
import {
  createPaymentRuntime,
  type PaymentRuntime,
  type PaymentRuntimeOptions,
} from '../api/payments/runtime.js';
import type { CredentialClaims } from '../credentials/jws.js';
import { PaymentError } from '../domain/payments/helpers.js';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';
import { CeremonyService } from '../services/ceremony.js';
import { issueSessionToken, verifySessionToken } from '../auth/session.js';
import { getJwks, verifyKyaCredential } from '../credentials/jws.js';

type Variables = {
  address: `0x${string}`;
  agentClaims?: CredentialClaims;
};

/**
 * Create the root Hono app (KYA ceremony host).
 * Optional third argument wires provider-agnostic payment routes when configured.
 * Existing callers that pass only (repo, config) remain compatible.
 */
export function createApp(
  repo: Repository,
  config: AppConfig,
  paymentOptions?: PaymentRuntimeOptions | PaymentRuntime | null,
) {
  const app = new Hono<{ Variables: Variables }>();
  const ceremony = new CeremonyService(repo, config);

  const paymentRuntime: PaymentRuntime | null =
    paymentOptions && 'configured' in paymentOptions && paymentOptions.configured
      ? paymentOptions
      : createPaymentRuntime(config, (paymentOptions as PaymentRuntimeOptions | undefined) ?? {});

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
    if (err instanceof DomainError) {
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

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/v1/config', (c) => c.json(publicClientConfig(config)));

  app.get('/.well-known/jwks.json', async (c) => c.json(await getJwks(repo)));

  // --- Auth (mocked — no wallet signature verification in this build) ---
  app.post('/v1/auth/login', async (c) => {
    const body = await c.req.json<{ address: `0x${string}` }>();
    let address: `0x${string}`;
    try {
      address = getAddress(body.address).toLowerCase() as `0x${string}`;
    } catch {
      return c.json({ error: 'Invalid address', code: 'INVALID_ADDRESS' }, 400);
    }
    const token = await issueSessionToken(repo, config, address);
    const principal = await ceremony.findOrCreatePrincipal(address);
    return c.json({ token, address, principalId: principal.id });
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
    });
  });

  app.post('/v1/enrollments/:agentUuid/bind', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const result = await ceremony.bindAgent(agentUuid, address);
    return c.json(result);
  });

  app.post('/v1/enrollments/:agentUuid/revoke', requireSession, async (c) => {
    const address = c.get('address')!;
    const agentUuid = c.req.param('agentUuid');
    const enrollment = await ceremony.revokeAgent(agentUuid, address);
    return c.json({ status: enrollment.status });
  });

  // Enrollment detail — session + owner auth; no public PII dump.
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

  // --- KYC (mocked — no external provider in this build) ---
  app.post('/v1/kyc/complete', requireSession, async (c) => {
    const address = c.get('address')!;
    const result = await ceremony.completeKyc(address);
    return c.json({ kycStatus: result.principal.kycStatus });
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
