import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppConfig } from '../config/env.js';
import { publicClientConfig } from '../config/env.js';
import { DomainError } from '../domain/state-machine.js';
import type { Repository } from '../persistence/repository.js';
import { CeremonyService } from '../services/ceremony.js';
import {
  issueSessionToken,
  issueSiwbNonce,
  verifySessionToken,
  verifySiwbLogin,
} from '../auth/siwb.js';
import { getJwks, verifyKyaCredential } from '../credentials/jws.js';
import { verifyTypedData, type Hex } from 'viem';
import {
  createAutonomousClosedMandates,
  createDemoAgentMandateSigner,
  createLocalMerchantSigner,
  createMandateService,
  Eip712TrustedSurfaceService,
  InMemoryMandateReplayStore,
  InMemoryOpenMandateRegistry,
  InMemoryTrustedSurfaceApprovalStore,
  KyaAgentTrustVerifier,
  mandateApprovalTypes,
  type OpenMandateConstraints,
} from '../mandates/index.js';
import {
  assertPaymasterRequestScoped,
  incrementPaymasterCapabilityUse,
  lookupPaymasterCapability,
} from './paymaster.js';

type Variables = {
  address: `0x${string}`;
};

export function createApp(repo: Repository, config: AppConfig) {
  const app = new Hono<{ Variables: Variables }>();
  const ceremony = new CeremonyService(repo, config);

  // Deliberately demo-only: these stores and signing keys are process-local.
  // Production must use durable mandate/outbox storage and a KMS-backed signer.
  let demoMandateLayerPromise: Promise<{
    merchantSigner: Awaited<ReturnType<typeof createLocalMerchantSigner>>;
    mandateService: ReturnType<typeof createMandateService>;
    openRegistry: InMemoryOpenMandateRegistry;
    trustedSurface: Eip712TrustedSurfaceService;
    agentSigners: Map<string, Awaited<ReturnType<typeof createDemoAgentMandateSigner>>>;
    agentTrustVerifier: KyaAgentTrustVerifier;
  }> | undefined;
  const demoMandateLayer = () => {
    if (config.KYA_MODE !== 'demo') throw new DomainError('Mandate demo routes are available only in KYA_MODE=demo', 'MODE');
    if (!demoMandateLayerPromise) {
      demoMandateLayerPromise = (async () => {
        const merchantSigner = await createLocalMerchantSigner({ issuer: 'demo-merchant-1', nodeEnv: config.NODE_ENV });
        const openRegistry = new InMemoryOpenMandateRegistry();
        const trustedSurface = new Eip712TrustedSurfaceService({
          repo, registry: openRegistry, approvalStore: new InMemoryTrustedSurfaceApprovalStore(), chainId: 84532,
          verifier: { verify: ({ address, domain, message, signature }) => verifyTypedData({ address, domain, message, signature, types: mandateApprovalTypes, primaryType: 'MandateApproval' }) },
        });
        return {
          merchantSigner,
          mandateService: createMandateService({ merchantSigner, replayStore: new InMemoryMandateReplayStore() }),
          openRegistry, trustedSurface, agentSigners: new Map(),
          agentTrustVerifier: new KyaAgentTrustVerifier(repo, {
            policyVersion: 'demo-v1',
            // Explicit demo adapters. KyaAgentTrustVerifier remains deny-by-default elsewhere.
            isTenantAuthorized: () => true,
            riskLevel: () => 'low',
          }),
        };
      })();
    }
    return demoMandateLayerPromise;
  };

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

  app.get('/health', (c) => c.json({ ok: true, mode: config.KYA_MODE }));

  app.get('/v1/config', (c) => c.json(publicClientConfig(config)));

  app.get('/.well-known/jwks.json', async (c) => c.json(await getJwks(repo)));

  // --- Auth (SIWB) ---
  app.get('/v1/auth/nonce', async (c) => {
    const nonce = await issueSiwbNonce(repo, config.NONCE_TTL_SECONDS);
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
      await issueSiwbNonce(repo, config.NONCE_TTL_SECONDS);
      const token = await issueSessionToken(repo, config, address);
      const principal = await ceremony.findOrCreatePrincipal(address);
      return c.json({ token, address, principalId: principal.id, demo: true });
    }
    const { address } = await verifySiwbLogin(repo, config, body);
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

  // --- AP2 mandate demo (no merchant, Yuno, chain, or durable storage calls) ---
  app.post('/v1/mandates/demo/agents', requireSession, async (c) => {
    const address = c.get('address')!;
    const store = await repo.getStore();
    const principal = store.principals.find((item) => item.ownerAddress.toLowerCase() === address.toLowerCase());
    if (!principal || principal.kycStatus !== 'verified' || (principal.kycExpiresAt && Date.parse(principal.kycExpiresAt) <= Date.now())) {
      throw new DomainError('Complete demo KYC before creating a demo purchasing agent', 'KYC_REQUIRED');
    }
    const layer = await demoMandateLayer();
    const signer = await createDemoAgentMandateSigner(config.KYA_MODE);
    // The signer public key is enrolled in KYA; this is required for JWK binding at close time.
    const started = await ceremony.startEnrollment({ publicJwk: signer.publicKeyJwk, keystoreProvider: 'encrypted_os_keystore' });
    await ceremony.attachHuman(started.agentUuid, address);
    await ceremony.approveFingerprint(started.agentUuid, address, started.thumbprint);
    const bound = await ceremony.confirmDemoRegistration(started.agentUuid, address);
    layer.agentSigners.set(bound.agentId, signer);
    return c.json({ agentUuid: started.agentUuid, agentId: bound.agentId, agentRegistry: bound.agentRegistry, status: 'bound', demo: true }, 201);
  });

  app.post('/v1/mandates/checkout', requireSession, async (c) => {
    const layer = await demoMandateLayer();
    return c.json(await layer.mandateService.createMerchantCheckout(await c.req.json()), 201);
  });

  app.post('/v1/mandates/open', requireSession, async (c) => {
    const address = c.get('address')!;
    const body = await c.req.json<{ agentUuid: string; constraints: OpenMandateConstraints; expiresAt?: string }>();
    const enrollment = await ceremony.getEnrollmentAuthorized(body.agentUuid, address);
    if (enrollment.status !== 'bound' || !enrollment.agentId) throw new DomainError('Agent must be KYA-bound before creating a mandate', 'NOT_BOUND');
    const layer = await demoMandateLayer();
    if (!layer.agentSigners.has(enrollment.agentId)) throw new DomainError('Agent was not created by the demo mandate flow', 'DEMO_AGENT_REQUIRED');
    const now = new Date();
    const expiresAt = body.expiresAt ?? new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime()) throw new DomainError('Open mandate expiry must be in the future', 'MANDATE_EXPIRY');
    const common = {
      tenantId: 'tenant_1', userReference: address, agentId: enrollment.agentId,
      agentPublicKeyJwk: enrollment.publicJwk, constraints: body.constraints,
      issuedAt: now.toISOString(), expiresAt, audience: 'kya-ap2',
    };
    const checkout = layer.openRegistry.create({ ...common, type: 'checkout', nonce: `open-checkout-${randomUUID()}` });
    const payment = layer.openRegistry.create({ ...common, type: 'payment', nonce: `open-payment-${randomUUID()}` });
    return c.json({ checkout, payment }, 201);
  });

  app.post('/v1/mandates/open/:id/challenge', requireSession, async (c) => {
    const layer = await demoMandateLayer();
    const result = await layer.trustedSurface.createApprovalChallenge({ openMandateId: c.req.param('id'), ownerAddress: c.get('address')! });
    // JSON cannot serialize bigint. Wallets can pass these decimal strings to eth_signTypedData_v4.
    return c.json({
      challenge: { ...result.challenge, message: { ...result.challenge.message, issuedAt: result.challenge.message.issuedAt.toString(), expiresAt: result.challenge.message.expiresAt.toString() } },
      typedData: { ...result.typedData, message: { ...result.typedData.message, issuedAt: result.typedData.message.issuedAt.toString(), expiresAt: result.typedData.message.expiresAt.toString() } },
    });
  });

  app.post('/v1/mandates/open/:id/approve', requireSession, async (c) => {
    const body = await c.req.json<{ challengeId: string; signature: Hex }>();
    const layer = await demoMandateLayer();
    const result = await layer.trustedSurface.verifyAndRecordApproval({ challengeId: body.challengeId, ownerAddress: c.get('address')!, signature: body.signature });
    if (result.mandate.id !== c.req.param('id')) throw new DomainError('Approval challenge does not belong to this mandate', 'APPROVAL_SUBJECT');
    return c.json({ mandate: result.mandate, proof: result.proof });
  });

  app.post('/v1/mandates/close', requireSession, async (c) => {
    const address = c.get('address')!;
    const body = await c.req.json<{
      openCheckoutMandateId: string; openPaymentMandateId: string; checkoutJwt: string; checkoutHash: string;
      transactionId: string; paymentInstrumentAlias: string; payeeId: string;
    }>();
    const layer = await demoMandateLayer();
    const openCheckoutMandate = layer.openRegistry.get(body.openCheckoutMandateId);
    const openPaymentMandate = layer.openRegistry.get(body.openPaymentMandateId);
    if (openCheckoutMandate.userReference.toLowerCase() !== address.toLowerCase() || openPaymentMandate.userReference.toLowerCase() !== address.toLowerCase()) throw new DomainError('Mandates do not belong to this session', 'FORBIDDEN');
    const agentSigner = layer.agentSigners.get(openCheckoutMandate.agentId);
    if (!agentSigner || openCheckoutMandate.agentId !== openPaymentMandate.agentId) throw new DomainError('Demo agent signer unavailable', 'DEMO_AGENT_REQUIRED');
    const closed = await createAutonomousClosedMandates({
      openCheckoutMandate, openPaymentMandate, checkoutJwt: body.checkoutJwt, checkoutHash: body.checkoutHash,
      transactionId: body.transactionId, agentIdentity: { agentId: openCheckoutMandate.agentId, tenantId: openCheckoutMandate.tenantId },
      agentKeyReference: agentSigner.keyId, paymentInstrumentAlias: body.paymentInstrumentAlias, payeeId: body.payeeId,
      merchantSigner: layer.merchantSigner,
      agentTrustVerifier: layer.agentTrustVerifier, agentSigner,
    });
    return c.json({ status: closed.status, closedCheckoutHash: closed.closedCheckoutHash, closedPaymentHash: closed.closedPaymentHash, policy: closed.policy, trust: closed.trust });
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

  app.post('/v1/enrollments/:agentUuid/mandate-signing-key', requireSession, async (c) => {
    const body = await c.req.json<{ publicJwk: JsonWebKey; keyId: string }>();
    const enrollment = await ceremony.bindMandateSigningKey(c.req.param('agentUuid'), c.get('address')!, body);
    return c.json({
      agentUuid: enrollment.agentUuid,
      mandateSigningKeyId: enrollment.mandateSigningKeyId,
      mandateSigningThumbprint: enrollment.mandateSigningThumbprint,
      boundAt: enrollment.mandateSigningBoundAt,
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

  // --- Paymaster proxy (capability-gated; provider credentials server-only) ---
  app.all('/v1/paymaster/proxy', async (c) => {
    if (!config.PAYMASTER_PROXY_ENABLED || !config.PAYMASTER_URL) {
      return c.json({ error: 'Paymaster proxy disabled' }, 503);
    }
    if (c.req.method !== 'POST') {
      return c.json({ error: 'POST only', code: 'PAYMASTER_METHOD' }, 405);
    }
    const rawToken =
      c.req.query('c') ??
      c.req.header('x-paymaster-capability') ??
      undefined;
    const cap = await lookupPaymasterCapability(repo, rawToken);
    const rawBody = await c.req.text();
    assertPaymasterRequestScoped(cap, rawBody);
    // Count only successfully scoped requests (after validation, before forward).
    await incrementPaymasterCapabilityUse(repo, cap.tokenHash);

    const res = await fetch(config.PAYMASTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      },
    });
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

  app.use(
    '/app/*',
    serveStatic({
      root: './web/dist',
      rewriteRequestPath: (p) => p.replace(/^\/app/, ''),
    }),
  );

  return { app, ceremony };
}
