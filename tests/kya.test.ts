import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { DemoKycAdapter, DIDIT_STATUS_MAP, mapStatus } from '../src/kyc/index.js';
import { IncodeKycAdapter, INCODE_STATUS_MAP } from '../src/kyc/incode.js';
import { VeriffKycAdapter, VERIFF_STATUS_MAP } from '../src/kyc/veriff.js';
import {
  generateLocalAgentKey,
  signChallenge,
  assertNoPrivateKeyMaterial,
  thumbprintFromJwk,
} from '../src/crypto/local-agent-key.js';
import {
  issueKyaCredential,
  verifyKyaCredential,
  setCredentialStatus,
  ensureSigningKey,
} from '../src/credentials/jws.js';
import { assertNoPiiInAgentUri, buildAgentUriDocument } from '../src/agent-uri/document.js';
import {
  encodeRegisterAgentUri,
  agentRegistryRef,
  IDENTITY_REGISTRY_SEPOLIA,
  buildRegisterSendCalls,
  IDENTITY_REGISTRY_ABI,
} from '../src/registry/identity.js';
import { applyTransferEvent, applyRegisteredEvent } from '../src/registry/events.js';
import { mainnetPromotionAllowed, needsKyc } from '../src/domain/state-machine.js';
import { decodeFunctionData } from 'viem';
import { SignJWT, generateKeyPair } from 'jose';

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    KYA_AUDIENCE: 'kya-agent',
    ...overrides,
  });
}

describe('KYC normalization', () => {
  it('maps Didit statuses including Abandoned and Kyc Expired', () => {
    expect(mapStatus(DIDIT_STATUS_MAP as never, 'Approved')).toBe('verified');
    expect(mapStatus(DIDIT_STATUS_MAP as never, 'Declined')).toBe('rejected');
    expect(mapStatus(DIDIT_STATUS_MAP as never, 'In Review')).toBe('needs_review');
    expect(mapStatus(DIDIT_STATUS_MAP as never, 'Expired')).toBe('expired');
    expect(mapStatus(DIDIT_STATUS_MAP as never, 'Abandoned')).toBe('expired');
    expect(mapStatus(DIDIT_STATUS_MAP as never, 'Kyc Expired')).toBe('expired');
    expect(mapStatus(DIDIT_STATUS_MAP as never, 'Awaiting User')).toBe('pending');
  });

  it('maps Incode and Veriff statuses', () => {
    expect(mapStatus(INCODE_STATUS_MAP as never, 'ONBOARDING_FINISHED')).toBe('pending');
    expect(mapStatus(INCODE_STATUS_MAP as never, 'MANUAL_REVIEW_APPROVED')).toBe('verified');
    expect(mapStatus(INCODE_STATUS_MAP as never, 'MANUAL_REVIEW_REJECTED')).toBe('rejected');
    expect(mapStatus(INCODE_STATUS_MAP as never, 'EXPIRED')).toBe('expired');
    expect(mapStatus(VERIFF_STATUS_MAP as never, 'approved')).toBe('verified');
    expect(mapStatus(VERIFF_STATUS_MAP as never, 'resubmission_requested')).toBe('needs_review');
  });
});

describe('Incode ONBOARDING_FINISHED decision fetch', () => {
  it('maps overall.status per official get/score enum', async () => {
    const { normalizeIncodeOverallStatus } = await import('../src/kyc/incode.js');
    expect(normalizeIncodeOverallStatus('OK').status).toBe('verified');
    expect(normalizeIncodeOverallStatus('WARN').status).toBe('needs_review');
    expect(normalizeIncodeOverallStatus('MANUAL').status).toBe('needs_review');
    expect(normalizeIncodeOverallStatus('MANUAL_PENDING').status).toBe('needs_review');
    expect(normalizeIncodeOverallStatus('FAIL').status).toBe('rejected');
    expect(normalizeIncodeOverallStatus('MANUAL_FAIL').status).toBe('rejected');
    expect(normalizeIncodeOverallStatus('UNKNOWN').status).toBe('pending');
    expect(normalizeIncodeOverallStatus('MANUAL_OK').status).toBe('verified');
  });

  it('GET /omni/get/score?id= uses required headers and keeps only overall.status', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        overall: { status: 'OK', value: '0.99' },
        idValidation: { overall: { status: 'OK' }, documentNumber: 'SECRET' },
      }), { status: 200 });
    }) as typeof fetch;

    try {
      const adapter = new IncodeKycAdapter(
        testConfig({
          INCODE_API_KEY: 'api-key',
          INCODE_API_URL: 'https://demo-api.incodesmile.com',
          INCODE_HARDWARE_ID: 'hw-admin-token',
          INCODE_WEBHOOK_SECRET: 'incode-secret',
        }),
      );
      const decision = await adapter.fetchOnboardingDecision('interview-123');
      expect(decision.status).toBe('verified');
      expect(decision.outcomeLabel).toBe('OK');
      expect(JSON.stringify(decision)).not.toMatch(/0\.99|SECRET|documentNumber|idValidation/i);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(
        'https://demo-api.incodesmile.com/omni/get/score?id=interview-123',
      );
      expect(calls[0]!.init?.method).toBe('GET');
      const headers = calls[0]!.init?.headers as Record<string, string>;
      expect(headers['api-version']).toBe('1.0');
      expect(headers['x-api-key']).toBe('api-key');
      expect(headers['X-Incode-Hardware-Id']).toBe('hw-admin-token');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fetches scores on ONBOARDING_FINISHED; MANUAL_REVIEW_* are definitive; auth is custom header not HMAC', async () => {
    let fetched = false;
    const adapter = new IncodeKycAdapter(
      testConfig({
        INCODE_WEBHOOK_AUTH_MODE: 'custom_header',
        INCODE_WEBHOOK_SECRET: 'incode-secret',
        INCODE_WEBHOOK_SECRET_HEADER: 'x-incode-secret',
      }),
      {
        fetchDecision: async () => {
          fetched = true;
          return { status: 'verified', assuranceLevel: 'incode_omni', outcomeLabel: 'OK' };
        },
      },
    );

    const finishedBody = JSON.stringify({
      interviewId: 'i-finish',
      onboardingStatus: 'ONBOARDING_FINISHED',
      eventId: 'ie-finish',
    });
    await expect(
      adapter.verifyWebhook({ 'x-incode-secret': 'wrong' }, finishedBody),
    ).rejects.toThrow(/Invalid|secret/i);

    const finished = await adapter.verifyWebhook(
      { 'x-incode-secret': 'incode-secret' },
      finishedBody,
    );
    expect(fetched).toBe(true);
    expect(finished.status).toBe('verified');
    expect(finished).not.toHaveProperty('rawBody');
    expect(JSON.stringify(finished)).not.toMatch(/document|selfie|biometric/i);

    fetched = false;
    const approvedBody = JSON.stringify({
      interviewId: 'i-approved',
      onboardingStatus: 'MANUAL_REVIEW_APPROVED',
      eventId: 'ie-approved',
    });
    const approved = await adapter.verifyWebhook(
      { 'x-incode-secret': 'incode-secret' },
      approvedBody,
    );
    expect(fetched).toBe(false);
    expect(approved.status).toBe('verified');

    const rejectedBody = JSON.stringify({
      interviewId: 'i-rejected',
      onboardingStatus: 'MANUAL_REVIEW_REJECTED',
      eventId: 'ie-rejected',
    });
    expect(
      (
        await adapter.verifyWebhook(
          { 'x-incode-secret': 'incode-secret' },
          rejectedBody,
        )
      ).status,
    ).toBe('rejected');

    const expiredBody = JSON.stringify({
      interviewId: 'i-expired',
      onboardingStatus: 'EXPIRED',
      eventId: 'ie-expired',
    });
    expect(
      (
        await adapter.verifyWebhook(
          { 'x-incode-secret': 'incode-secret' },
          expiredBody,
        )
      ).status,
    ).toBe('expired');

    const oauthAdapter = new IncodeKycAdapter(
      testConfig({
        INCODE_WEBHOOK_AUTH_MODE: 'oauth_bearer',
        INCODE_WEBHOOK_BEARER_TOKEN: 'access-token-from-client-credentials',
      }),
    );
    expect(
      (
        await oauthAdapter.verifyWebhook(
          { authorization: 'Bearer access-token-from-client-credentials' },
          approvedBody,
        )
      ).status,
    ).toBe('verified');
  });
});

describe('KYC webhooks', () => {
  it('verifies demo signature, rejects bad sig, and is idempotent', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const principal = await ceremony.findOrCreatePrincipal(
      '0x1111111111111111111111111111111111111111',
    );
    const started = await ceremony.startKyc(principal.ownerAddress);
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: started.sessionId,
      status: 'verified',
      event_id: 'evt-1',
    });

    await expect(
      ceremony.handleKycWebhook('demo', { 'x-demo-signature': 'deadbeef' }, rawBody),
    ).rejects.toThrow(/Invalid/);

    const first = await ceremony.handleKycWebhook(
      'demo',
      { 'x-demo-signature': signature },
      rawBody,
    );
    expect(first.normalized.status).toBe('verified');
    expect(first.idempotent).toBe(false);

    const second = await ceremony.handleKycWebhook(
      'demo',
      { 'x-demo-signature': signature },
      rawBody,
    );
    expect(second.idempotent).toBe(true);
  });

  it('Didit webhooks: V2 canonical, raw fallback, timestamp, reject Simple/undocumented', async () => {
    const { generateKeyPair, exportJWK } = await import('jose');
    const {
      diditCanonicalJsonV2,
      verifyDiditSignatureV2,
      DiditKycAdapter: Adapter,
    } = await import('../src/kyc/didit.js');
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const secret = 'test-didit-secret';
    const adapter = new Adapter(
      testConfig({
        KYA_MODE: 'live',
        DIDIT_API_KEY: 'k',
        DIDIT_WORKFLOW_ID: 'w',
        DIDIT_WEBHOOK_SECRET: secret,
        BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
        KYA_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      }),
    );

    const nested = {
      z_last: 'end',
      a_first: {
        nested_b: 1,
        nested_a: 'José',
        arr: [{ y: 2, x: 1 }, { b: 'β', a: 'α' }],
      },
      session_id: 's1',
      status: 'Approved',
      event_id: 'e1',
      webhook_type: 'status.updated',
    };
    // Unsorted key order in transmitted raw body (raw signature uses exact bytes).
    const rawBody = JSON.stringify(nested);
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);

    const canonical = diditCanonicalJsonV2(nested);
    expect(canonical).toContain('José');
    expect(canonical.indexOf('"a_first"')).toBeLessThan(canonical.indexOf('"session_id"'));
    expect(canonical.indexOf('"nested_a"')).toBeLessThan(canonical.indexOf('"nested_b"'));
    const v2Sig = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
    expect(verifyDiditSignatureV2(nested, v2Sig, secret)).toBe(true);

    const v2 = await adapter.verifyWebhook(
      { 'x-signature-v2': v2Sig, 'x-timestamp': ts },
      rawBody,
      { nowSeconds: now },
    );
    expect(v2.status).toBe('verified');

    const rawSig = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const rawOk = await adapter.verifyWebhook(
      { 'x-signature': rawSig, 'x-timestamp': ts },
      rawBody,
      { nowSeconds: now },
    );
    expect(rawOk.status).toBe('verified');

    await expect(
      adapter.verifyWebhook(
        { 'x-signature-v2': v2Sig, 'x-timestamp': String(now - 301) },
        rawBody,
        { nowSeconds: now },
      ),
    ).rejects.toThrow(/timestamp/i);

    await expect(
      adapter.verifyWebhook(
        { 'x-signature-v2': v2Sig, 'x-timestamp': String(now + 301) },
        rawBody,
        { nowSeconds: now },
      ),
    ).rejects.toThrow(/timestamp/i);

    await expect(
      adapter.verifyWebhook(
        { 'x-signature-v2': 'deadbeef', 'x-timestamp': ts },
        rawBody,
        { nowSeconds: now },
      ),
    ).rejects.toThrow(/signature/i);

    await expect(
      adapter.verifyWebhook(
        { 'x-didit-signature': v2Sig, 'x-timestamp': ts },
        rawBody,
        { nowSeconds: now },
      ),
    ).rejects.toThrow(/Undocumented|signature/i);

    await expect(
      adapter.verifyWebhook(
        {
          'x-signature-simple': createHmac('sha256', secret)
            .update(`${ts}:s1:Approved:status.updated`)
            .digest('hex'),
          'x-timestamp': ts,
        },
        rawBody,
        { nowSeconds: now },
      ),
    ).rejects.toThrow(/Simple|signature/i);

    await expect(
      adapter.verifyWebhook(
        { 'x-signature-v2': v2Sig, 'x-timestamp': ts },
        '{not-json',
        { nowSeconds: now },
      ),
    ).rejects.toThrow(/Malformed|JSON|payload/i);
  });

  it('Incode custom-header auth and Veriff HMAC mappings', async () => {
    const incode = new IncodeKycAdapter(
      testConfig({
        INCODE_WEBHOOK_AUTH_MODE: 'custom_header',
        INCODE_WEBHOOK_SECRET: 'incode-secret',
        INCODE_WEBHOOK_SECRET_HEADER: 'x-incode-secret',
      }),
      {
        fetchDecision: async () => ({
          status: 'verified',
          assuranceLevel: 'incode_omni',
          outcomeLabel: 'OK',
        }),
      },
    );
    const ibody = JSON.stringify({
      interviewId: 'i1',
      onboardingStatus: 'MANUAL_REVIEW_APPROVED',
      eventId: 'ie1',
    });
    expect(
      (await incode.verifyWebhook({ 'x-incode-secret': 'incode-secret' }, ibody)).status,
    ).toBe('verified');

    const veriff = new VeriffKycAdapter(
      testConfig({ VERIFF_WEBHOOK_SECRET: 'veriff-secret' }),
    );
    const vbody = JSON.stringify({
      verification: { id: 'v1', status: 'approved' },
      time: '2026-08-29T00:00:00Z',
    });
    const vsig = createHmac('sha256', 'veriff-secret').update(vbody).digest('hex');
    expect(
      (await veriff.verifyWebhook({ 'x-hmac-signature': vsig }, vbody)).status,
    ).toBe('verified');
    await expect(
      veriff.verifyWebhook({ 'x-signature': vsig }, vbody),
    ).rejects.toThrow(/x-hmac-signature|Undocumented/i);
    const badJson = '{not-json';
    const badSig = createHmac('sha256', 'veriff-secret').update(badJson).digest('hex');
    await expect(
      veriff.verifyWebhook({ 'x-hmac-signature': badSig }, badJson),
    ).rejects.toThrow(/Malformed|JSON/i);
  });
});

describe('crypto + challenges', () => {
  it('generates public thumbprint without private material and verifies challenge', async () => {
    const key = await generateLocalAgentKey();
    assertNoPrivateKeyMaterial({ publicJwk: key.publicJwk, thumbprint: key.thumbprint });
    expect(key.publicJwk.d).toBeUndefined();
    const tp = await thumbprintFromJwk(key.publicJwk);
    expect(tp).toBe(key.thumbprint);

    const payload = {
      nonce: 'n1',
      audience: 'kya-agent',
      timestamp: new Date().toISOString(),
      intent_hash: 'abc',
    };
    // Force extractable path for signing in test if needed
    const extractable = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const pub = await crypto.subtle.exportKey('jwk', extractable.publicKey);
    const sig = await signChallenge(extractable.privateKey, payload);

    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const started = await ceremony.startEnrollment({
      publicJwk: pub,
      keystoreProvider: 'encrypted_os_keystore',
    });
    const owner = '0x1111111111111111111111111111111111111111' as const;
    await ceremony.findOrCreatePrincipal(owner);
    await ceremony.startKyc(owner);
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: (await repo.getStore()).kycSessions[0]!.providerSessionId,
      status: 'verified',
      event_id: 'kyc-e',
    });
    await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);
    await ceremony.attachHuman(started.agentUuid, owner);
    await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
    await ceremony.confirmDemoRegistration(started.agentUuid, owner);

    const challenge = await ceremony.createChallenge(started.agentUuid, { action: 'ping' });
    const signed = await signChallenge(extractable.privateKey, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: challenge.intent_hash,
    });
    const ok = await ceremony.verifyChallenge(started.agentUuid, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: challenge.intent_hash,
      signature: signed,
    });
    expect(ok.ok).toBe(true);

    await expect(
      ceremony.verifyChallenge(started.agentUuid, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: challenge.timestamp,
        intent_hash: challenge.intent_hash,
        signature: signed,
      }),
    ).rejects.toThrow(/replay/i);
    void sig;
  });

  it('binds challenge fields and only consumes nonce after valid signature', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const owner = '0x5555555555555555555555555555555555555555' as const;
    const extractable = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', extractable.publicKey);
    const started = await ceremony.startEnrollment({
      publicJwk,
      keystoreProvider: 'encrypted_os_keystore',
    });
    await ceremony.attachHuman(started.agentUuid, owner);
    const kyc = await ceremony.startKyc(owner);
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: kyc.sessionId,
      status: 'verified',
      event_id: 'chal-bind',
    });
    await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);
    await ceremony.attachHuman(started.agentUuid, owner);
    await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
    await ceremony.confirmDemoRegistration(started.agentUuid, owner);

    const challenge = await ceremony.createChallenge(started.agentUuid, { action: 'pay' });
    const goodSig = await signChallenge(extractable.privateKey, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: challenge.intent_hash,
    });

    await expect(
      ceremony.verifyChallenge(started.agentUuid, {
        nonce: challenge.nonce,
        audience: 'wrong-aud',
        timestamp: challenge.timestamp,
        intent_hash: challenge.intent_hash,
        signature: goodSig,
      }),
    ).rejects.toThrow(/audience/i);

    await expect(
      ceremony.verifyChallenge(started.agentUuid, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: challenge.timestamp,
        intent_hash: 'deadbeef',
        signature: goodSig,
      }),
    ).rejects.toThrow(/intent/i);

    await expect(
      ceremony.verifyChallenge(started.agentUuid, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: '1999-01-01T00:00:00.000Z',
        intent_hash: challenge.intent_hash,
        signature: goodSig,
      }),
    ).rejects.toThrow(/timestamp/i);

    const badSig = await signChallenge(extractable.privateKey, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: 'ffffffff',
    });
    await expect(
      ceremony.verifyChallenge(started.agentUuid, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: challenge.timestamp,
        intent_hash: challenge.intent_hash,
        signature: badSig,
      }),
    ).rejects.toThrow(/signature/i);

    // Invalid signature must not consume — retry with valid signature succeeds.
    const storeAfterBad = await repo.getStore();
    expect(
      storeAfterBad.nonces.find((n) => n.nonce === challenge.nonce)?.consumedAt,
    ).toBeUndefined();

    const ok = await ceremony.verifyChallenge(started.agentUuid, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: challenge.intent_hash,
      signature: goodSig,
    });
    expect(ok.ok).toBe(true);

    await expect(
      ceremony.verifyChallenge(started.agentUuid, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: challenge.timestamp,
        intent_hash: challenge.intent_hash,
        signature: goodSig,
      }),
    ).rejects.toThrow(/replay/i);
  });
});

describe('agentURI and credentials no-PII', () => {
  it('rejects PII fields in agentURI', () => {
    expect(() =>
      assertNoPiiInAgentUri({
        type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        principal_id: 'x',
      }),
    ).toThrow(/Forbidden/);
    const doc = buildAgentUriDocument({
      name: 'a',
      description: 'b',
      resolverEndpoint: 'http://localhost/v1/resolve',
      active: true,
      agentRegistry: agentRegistryRef(84532, IDENTITY_REGISTRY_SEPOLIA),
      agentId: '1',
    });
    expect(JSON.stringify(doc)).not.toMatch(/principal/i);
    expect(JSON.stringify(doc)).not.toMatch(/kyc/i);
  });

  it('issues and verifies JWS; rejects alg confusion, wrong iss/aud, expired, revoked', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig({ CREDENTIAL_TTL_SECONDS: '2' });
    await ensureSigningKey(repo, config);
    const { token, record } = await issueKyaCredential(repo, config, {
      agentUuid: 'agent_1',
      principalId: 'prin_1',
      thumbprint: 'thumb',
      agentRegistry: agentRegistryRef(84532, IDENTITY_REGISTRY_SEPOLIA),
      agentId: '42',
      owner: '0x1111111111111111111111111111111111111111',
    });
    expect(JSON.stringify(record)).not.toMatch(/selfie|passport|email/i);
    const claims = await verifyKyaCredential(repo, config, token);
    expect(claims.cnf.jkt).toBe('thumb');
    expect(claims.principal_id).toBe('prin_1');

    // alg none / confusion
    const evil = [
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ iss: config.KYA_ISSUER })).toString('base64url'),
      '',
    ].join('.');
    await expect(verifyKyaCredential(repo, config, evil)).rejects.toThrow();

    // wrong audience
    await expect(
      verifyKyaCredential(repo, config, token, { expectAudience: 'other' }),
    ).rejects.toThrow();

    // revoked
    await setCredentialStatus(repo, record.jti, 'revoked');
    await expect(verifyKyaCredential(repo, config, token)).rejects.toThrow(/revoked/i);

    // wrong issuer crafted token
    const { privateKey } = await generateKeyPair('ES256');
    const badIss = await new SignJWT({
      sub: 'x',
      cnf: { jkt: 't' },
      jti: 'forged',
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setIssuer('http://evil.example')
      .setAudience(config.KYA_AUDIENCE)
      .setExpirationTime('1h')
      .sign(privateKey);
    await expect(verifyKyaCredential(repo, config, badIss)).rejects.toThrow();
  });
});

describe('enrollment transitions + transfer suspension + mainnet gate', () => {
  it('runs multi-agent principal and transfer suspension', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const owner = '0x2222222222222222222222222222222222222222' as const;

    async function enrollOne() {
      const key = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
      );
      const publicJwk = await crypto.subtle.exportKey('jwk', key.publicKey);
      const started = await ceremony.startEnrollment({
        publicJwk,
        keystoreProvider: 'encrypted_os_keystore',
      });
      return started;
    }

    const a1 = await enrollOne();
    const a2 = await enrollOne();
    await ceremony.attachHuman(a1.agentUuid, owner);
    const kyc = await ceremony.startKyc(owner);
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: kyc.sessionId,
      status: 'verified',
      event_id: 'multi-kyc',
    });
    await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);

    // Second attach should skip KYC
    const attach2 = await ceremony.attachHuman(a2.agentUuid, owner);
    expect(attach2.needsKyc).toBe(false);
    expect(needsKyc(attach2.principal)).toBe(false);

    await ceremony.approveFingerprint(a1.agentUuid, owner, a1.thumbprint);
    await ceremony.confirmDemoRegistration(a1.agentUuid, owner);

    const transfer = await ceremony.simulateTransfer(
      a1.agentUuid,
      '0x3333333333333333333333333333333333333333',
    );
    expect(transfer.suspendedAgentUuid).toBe(a1.agentUuid);
    const store = await repo.getStore();
    expect(store.enrollments.find((e) => e.agentUuid === a1.agentUuid)?.status).toBe(
      'suspended',
    );
    expect(store.credentials.find((c) => c.agentUuid === a1.agentUuid)?.status).toBe(
      'suspended',
    );
  });

  it('enforces mainnet promotion gate', () => {
    expect(
      mainnetPromotionAllowed({
        enabled: false,
        registryVerified: true,
        getVersionOk: true,
        codePresent: true,
      }).allowed,
    ).toBe(false);
    expect(
      mainnetPromotionAllowed({
        enabled: true,
        registryVerified: false,
        getVersionOk: true,
        codePresent: true,
      }).allowed,
    ).toBe(false);
    expect(
      mainnetPromotionAllowed({
        enabled: true,
        registryVerified: true,
        getVersionOk: true,
        codePresent: true,
      }).allowed,
    ).toBe(true);
  });

  it('encodes register(agentURI) and rejects KYA as implicit owner in sendCalls target', () => {
    const uri = 'https://kya.example/v1/agents/x/agent-uri.json';
    const data = encodeRegisterAgentUri(uri);
    const decoded = decodeFunctionData({
      abi: IDENTITY_REGISTRY_ABI,
      data,
    });
    expect(decoded.functionName).toBe('register');
    expect(decoded.args?.[0]).toBe(uri);

    const calls = buildRegisterSendCalls({
      chainId: 84532,
      registry: IDENTITY_REGISTRY_SEPOLIA,
      agentURI: uri,
      from: '0x1111111111111111111111111111111111111111',
      paymasterUrl: 'http://localhost:8787/v1/paymaster/proxy',
    });
    expect(calls.calls[0]?.to.toLowerCase()).toBe(IDENTITY_REGISTRY_SEPOLIA.toLowerCase());
    expect(calls.from).toBe('0x1111111111111111111111111111111111111111');
    expect(calls.capabilities?.paymasterService?.url).toContain('/v1/paymaster/proxy');
  });
});

describe('event idempotency', () => {
  it('Registered and Transfer are idempotent by txHash+logIndex', async () => {
    const repo = new InMemoryRepository();
    const payload = {
      agentId: '9',
      agentURI: 'http://localhost/v1/agents/agent_x/agent-uri.json',
      owner: '0x1111111111111111111111111111111111111111' as const,
      txHash: ('0x' + '11'.repeat(32)) as `0x${string}`,
      logIndex: 0,
      blockNumber: 10n,
    };
    await repo.withLock(async (s) => {
      s.principals.push({
        id: 'prin_x',
        ownerAddress: payload.owner,
        kycStatus: 'verified',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      s.enrollments.push({
        agentUuid: 'agent_x',
        deviceCode: 'ABCD',
        principalId: 'prin_x',
        status: 'awaiting_onchain',
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        thumbprint: 't',
        keystoreProvider: 'os_hardware',
        agentUriPath: '/v1/agents/agent_x/agent-uri.json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    const a = await applyRegisteredEvent(repo, 84532, payload, {
      currentBlock: 12n,
      confirmations: 1,
    });
    const b = await applyRegisteredEvent(repo, 84532, payload, {
      currentBlock: 12n,
      confirmations: 1,
    });
    expect(a.applied).toBe(true);
    expect(a.bound).toBe(true);
    expect(b.applied).toBe(false);

    const t1 = await applyTransferEvent(
      repo,
      84532,
      {
        from: payload.owner,
        to: '0x2222222222222222222222222222222222222222',
        tokenId: '9',
        txHash: ('0x' + '22'.repeat(32)) as `0x${string}`,
        logIndex: 1,
        blockNumber: 11n,
      },
      { currentBlock: 12n, confirmations: 1 },
    );
    expect(t1.applied).toBe(true);
  });
});

describe('end-to-end demo ceremony', () => {
  it('completes deterministic F0-F5 happy path', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const owner = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;

    const key = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', key.publicKey);
    const started = await ceremony.startEnrollment({
      publicJwk,
      keystoreProvider: 'encrypted_os_keystore',
    });
    const attached = await ceremony.attachHuman(started.agentUuid, owner);
    expect(attached.needsKyc).toBe(true);
    const kyc = await ceremony.startKyc(owner);
    expect(kyc.demo).toBe(true);
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: kyc.sessionId,
      status: 'verified',
      event_id: 'e2e',
    });
    await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);
    await ceremony.attachHuman(started.agentUuid, owner);
    await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
    const bound = await ceremony.confirmDemoRegistration(started.agentUuid, owner);
    expect(bound.agentId).toBeTruthy();
    const claims = await verifyKyaCredential(repo, config, bound.token);
    expect(claims.cnf.jkt).toBe(started.thumbprint);
    expect(claims.agentRegistry).toContain('eip155:84532:');
    const uri = await ceremony.getAgentUriDocument(started.agentUuid);
    assertNoPiiInAgentUri(uri);
    expect(uri.type).toContain('registration-v1');
  });
});

describe('platform signing key persistence', () => {
  it('demo store.json / repository snapshots never contain private JWK fields or raw tokens', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const {
      resetEphemeralSigningKeysForTests,
      assertStoreHasNoPrivateKeyMaterial,
    } = await import('../src/credentials/signer.js');
    const { JsonFileRepository } = await import('../src/persistence/repository.js');
    const { getJwks } = await import('../src/credentials/jws.js');

    resetEphemeralSigningKeysForTests();
    const dir = await mkdtemp(path.join(tmpdir(), 'kya-sign-'));
    const filePath = path.join(dir, 'store.json');
    const repo = new JsonFileRepository(filePath);
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const owner = '0x4444444444444444444444444444444444444444' as const;

    await ensureSigningKey(repo, config);
    const key = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', key.publicKey);
    const started = await ceremony.startEnrollment({
      publicJwk,
      keystoreProvider: 'encrypted_os_keystore',
    });
    await ceremony.attachHuman(started.agentUuid, owner);
    const kyc = await ceremony.startKyc(owner);
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: kyc.sessionId,
      status: 'verified',
      event_id: 'sign-persist',
    });
    await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);
    await ceremony.attachHuman(started.agentUuid, owner);
    await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
    const bound = await ceremony.confirmDemoRegistration(started.agentUuid, owner);

    const store = await repo.getStore();
    expect(() => assertStoreHasNoPrivateKeyMaterial(store)).not.toThrow();
    for (const sk of store.signingKeys) {
      expect(sk).not.toHaveProperty('privateJwk');
      expect(sk.publicJwk.d).toBeUndefined();
      expect((sk.publicJwk as Record<string, unknown>).p).toBeUndefined();
      expect((sk.publicJwk as Record<string, unknown>).q).toBeUndefined();
    }
    const snapshot = JSON.stringify(store, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(snapshot).not.toContain(bound.token);
    expect(snapshot).not.toMatch(/"privateJwk"/);
    expect(snapshot).not.toMatch(/"d"\s*:/);
    expect(snapshot).not.toMatch(/"dp"\s*:|"dq"\s*:|"qi"\s*:/);

    const onDisk = await readFile(filePath, 'utf8');
    expect(onDisk).not.toMatch(/"privateJwk"/);
    expect(onDisk).not.toMatch(/"d"\s*:/);
    expect(onDisk).not.toMatch(/"dp"\s*:|"dq"\s*:|"qi"\s*:/);
    expect(onDisk).not.toContain(bound.token);
    expect(onDisk).not.toMatch(/-----BEGIN/);

    const jwks = await getJwks(repo);
    for (const k of jwks.keys) {
      expect(k.d).toBeUndefined();
      expect((k as Record<string, unknown>).privateJwk).toBeUndefined();
    }
  });

  it('live mode fails closed without injected ES256 private key', async () => {
    const { resetEphemeralSigningKeysForTests } = await import(
      '../src/credentials/signer.js'
    );
    resetEphemeralSigningKeysForTests();
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        KYA_MODE: 'live',
        PUBLIC_BASE_URL: 'http://localhost:8787',
        KYA_ISSUER: 'http://localhost:8787',
        KYA_AUDIENCE: 'kya-agent',
        BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
        DIDIT_API_KEY: 'k',
        DIDIT_WORKFLOW_ID: 'w',
        DIDIT_WEBHOOK_SECRET: 's',
      }),
    ).toThrow(/KYA_SIGNING_PRIVATE_JWK|fail-closed|SIGNING/i);
  });

  it('live mode accepts secret-injected private JWK and persists public metadata only', async () => {
    const { generateKeyPair, exportJWK } = await import('jose');
    const {
      resetEphemeralSigningKeysForTests,
      assertStoreHasNoPrivateKeyMaterial,
    } = await import('../src/credentials/signer.js');
    const { InMemoryRepository } = await import('../src/persistence/repository.js');

    resetEphemeralSigningKeysForTests();
    const { privateKey, publicKey } = await generateKeyPair('ES256', {
      extractable: true,
    });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);
    void publicJwk;

    const config = loadConfig({
      NODE_ENV: 'test',
      KYA_MODE: 'live',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      DIDIT_API_KEY: 'k',
      DIDIT_WORKFLOW_ID: 'w',
      DIDIT_WEBHOOK_SECRET: 's',
      KYA_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    });
    const repo = new InMemoryRepository();
    const active = await ensureSigningKey(repo, config);
    expect(active.privateJwk.d).toBeTruthy();

    const store = await repo.getStore();
    expect(() => assertStoreHasNoPrivateKeyMaterial(store)).not.toThrow();
    expect(store.signingKeys[0]).not.toHaveProperty('privateJwk');
    expect(store.signingKeys[0]?.publicJwk.d).toBeUndefined();
    expect(JSON.stringify(store)).not.toMatch(/"d"\s*:/);
  });
});

describe('SIWB verification', () => {
  function siweMessage(opts: {
    domain: string;
    address: string;
    uri: string;
    chainId: number;
    nonce: string;
    issuedAt?: string;
    expirationTime?: string;
    notBefore?: string;
  }) {
    let msg = `${opts.domain} wants you to sign in with your Ethereum account:
${opts.address}

Sign in with Base to KYA.

URI: ${opts.uri}
Version: 1
Chain ID: ${opts.chainId}
Nonce: ${opts.nonce}
Issued At: ${opts.issuedAt ?? '2026-08-29T18:00:00.000Z'}`;
    if (opts.expirationTime) msg += `\nExpiration Time: ${opts.expirationTime}`;
    if (opts.notBefore) msg += `\nNot Before: ${opts.notBefore}`;
    return msg;
  }

  it('rejects domain/URI mismatch without consuming nonce; consumes only after valid sig via verifySiweMessage', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig({
      SIWB_DOMAIN: 'localhost',
      SIWB_URI: 'http://localhost:5173',
    });
    const { issueSiwbNonce, verifySiwbLogin } = await import('../src/auth/siwb.js');
    const { nonce } = await issueSiwbNonce(repo, 300);
    const address = '0x1111111111111111111111111111111111111111' as const;
    const now = new Date('2026-08-29T18:00:00.000Z');

    await expect(
      verifySiwbLogin(
        repo,
        config,
        {
          address,
          message: siweMessage({
            domain: 'evil.example',
            address,
            uri: 'http://localhost:5173',
            chainId: 84532,
            nonce,
          }),
          signature: '0xdead',
        },
        { time: now },
      ),
    ).rejects.toThrow(/domain/i);

    expect(
      (await repo.getStore()).nonces.find((n) => n.nonce === nonce)?.consumedAt,
    ).toBeUndefined();

    await expect(
      verifySiwbLogin(
        repo,
        config,
        {
          address,
          message: siweMessage({
            domain: 'localhost',
            address,
            uri: 'http://evil.example/',
            chainId: 84532,
            nonce,
          }),
          signature: '0xdead',
        },
        { time: now },
      ),
    ).rejects.toThrow(/URI/i);

    const message = siweMessage({
      domain: 'localhost',
      address,
      uri: 'http://localhost:5173',
      chainId: 84532,
      nonce,
    });

    await expect(
      verifySiwbLogin(
        repo,
        config,
        { address, message, signature: '0xbad' },
        {
          time: now,
          publicClient: { verifySiweMessage: async () => false },
        },
      ),
    ).rejects.toThrow(/signature/i);

    expect(
      (await repo.getStore()).nonces.find((n) => n.nonce === nonce)?.consumedAt,
    ).toBeUndefined();

    const ok = await verifySiwbLogin(
      repo,
      config,
      { address, message, signature: '0xgood' },
      {
        time: now,
        publicClient: { verifySiweMessage: async () => true },
      },
    );
    expect(ok.address).toBe(address.toLowerCase());
    expect(
      (await repo.getStore()).nonces.find((n) => n.nonce === nonce)?.consumedAt,
    ).toBeTruthy();

    await expect(
      verifySiwbLogin(
        repo,
        config,
        { address, message, signature: '0xgood' },
        {
          time: now,
          publicClient: { verifySiweMessage: async () => true },
        },
      ),
    ).rejects.toThrow(/already used|replay/i);
  });

  it('rejects stale/future issuedAt, notBefore, and expired presentation without burning nonce', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const { issueSiwbNonce, verifySiwbLogin } = await import('../src/auth/siwb.js');
    const address = '0x1111111111111111111111111111111111111111' as const;
    const now = new Date('2026-08-29T18:00:00.000Z');
    const client = { verifySiweMessage: async () => true };

    const { nonce: n1 } = await issueSiwbNonce(repo, 300);
    await expect(
      verifySiwbLogin(
        repo,
        config,
        {
          address,
          message: siweMessage({
            domain: 'localhost',
            address,
            uri: 'http://localhost:5173',
            chainId: 84532,
            nonce: n1,
            issuedAt: '2026-08-29T17:00:00.000Z', // >300s stale
          }),
          signature: '0xgood',
        },
        { time: now, publicClient: client },
      ),
    ).rejects.toThrow(/stale|issuedAt/i);
    expect(
      (await repo.getStore()).nonces.find((n) => n.nonce === n1)?.consumedAt,
    ).toBeUndefined();

    const { nonce: n2 } = await issueSiwbNonce(repo, 300);
    await expect(
      verifySiwbLogin(
        repo,
        config,
        {
          address,
          message: siweMessage({
            domain: 'localhost',
            address,
            uri: 'http://localhost:5173',
            chainId: 84532,
            nonce: n2,
            issuedAt: '2026-08-29T18:10:00.000Z', // future
          }),
          signature: '0xgood',
        },
        { time: now, publicClient: client },
      ),
    ).rejects.toThrow(/future|issuedAt/i);

    const { nonce: n3 } = await issueSiwbNonce(repo, 300);
    await expect(
      verifySiwbLogin(
        repo,
        config,
        {
          address,
          message: siweMessage({
            domain: 'localhost',
            address,
            uri: 'http://localhost:5173',
            chainId: 84532,
            nonce: n3,
            notBefore: '2026-08-29T19:00:00.000Z',
          }),
          signature: '0xgood',
        },
        { time: now, publicClient: client },
      ),
    ).rejects.toThrow(/not yet valid|notBefore/i);

    const { nonce: n4 } = await issueSiwbNonce(repo, 300);
    await expect(
      verifySiwbLogin(
        repo,
        config,
        {
          address,
          message: siweMessage({
            domain: 'localhost',
            address,
            uri: 'http://localhost:5173',
            chainId: 84532,
            nonce: n4,
            expirationTime: '2026-08-29T17:59:00.000Z',
          }),
          signature: '0xgood',
        },
        { time: now, publicClient: client },
      ),
    ).rejects.toThrow(/expired/i);
    expect(
      (await repo.getStore()).nonces.find((n) => n.nonce === n4)?.consumedAt,
    ).toBeUndefined();
  });

  it('rejects address mismatch in message vs claimed address', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const { issueSiwbNonce, verifySiwbLogin } = await import('../src/auth/siwb.js');
    const { nonce } = await issueSiwbNonce(repo, 300);
    const address = '0x1111111111111111111111111111111111111111' as const;
    const other = '0x2222222222222222222222222222222222222222';
    await expect(
      verifySiwbLogin(
        repo,
        config,
        {
          address,
          message: siweMessage({
            domain: 'localhost',
            address: other,
            uri: 'http://localhost:5173',
            chainId: 84532,
            nonce,
          }),
          signature: '0xgood',
        },
        {
          time: new Date('2026-08-29T18:00:00.000Z'),
          publicClient: { verifySiweMessage: async () => true },
        },
      ),
    ).rejects.toThrow(/address/i);
  });
});

describe('siwbConnect capability validation', () => {
  it('rejects wallet_connect responses missing signInWithEthereum capability', () => {
    function guard(siwe: unknown): void {
      if (
        !siwe ||
        typeof siwe !== 'object' ||
        ('code' in siwe && !('signature' in siwe)) ||
        typeof (siwe as { message?: unknown }).message !== 'string' ||
        typeof (siwe as { signature?: unknown }).signature !== 'string' ||
        !(siwe as { signature: string }).signature.startsWith('0x')
      ) {
        throw new Error('Missing or invalid signInWithEthereum capability');
      }
    }
    expect(() => guard(undefined)).toThrow(/Missing|invalid/i);
    expect(() => guard({ code: -32000, message: 'rejected' })).toThrow(/Missing|invalid/i);
    expect(() => guard({ message: 'ok', signature: '0xabc' })).not.toThrow();
  });
});

describe('live KYC demo forbid', () => {
  async function liveConfig() {
    const { generateKeyPair, exportJWK } = await import('jose');
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    return testConfig({
      KYA_MODE: 'live',
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      DIDIT_API_KEY: 'k',
      DIDIT_WORKFLOW_ID: 'w',
      DIDIT_WEBHOOK_SECRET: 's',
      KYA_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    });
  }

  it('forbids provider=demo, demo webhook, and demo adapter in live mode', async () => {
    const config = await liveConfig();
    const repo = new InMemoryRepository();
    const ceremony = new CeremonyService(repo, config);
    expect(ceremony.kyc.byName.demo).toBeUndefined();
    const owner = '0x1111111111111111111111111111111111111111' as const;
    await ceremony.findOrCreatePrincipal(owner);
    await expect(ceremony.startKyc(owner, 'demo')).rejects.toThrow(/Demo KYC forbidden/i);
    await expect(
      ceremony.handleKycWebhook('demo', {}, '{}'),
    ).rejects.toThrow(/Demo KYC|Unknown KYC/i);

    const { createApp } = await import('../src/server/app.js');
    const { app } = createApp(repo, config);
    const res = await app.request('/v1/kyc/webhooks/demo', {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('KYC_DEMO_FORBIDDEN');
  });
});

describe('paymaster capability proxy', () => {
  it('persists only tokenHash; enforces sender/chain/callData scope; rejects mismatches', async () => {
    const { generateKeyPair, exportJWK } = await import('jose');
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const config = testConfig({
      KYA_MODE: 'live',
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      DIDIT_API_KEY: 'k',
      DIDIT_WORKFLOW_ID: 'w',
      DIDIT_WEBHOOK_SECRET: 's',
      KYA_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      PAYMASTER_PROXY_ENABLED: 'true',
      PAYMASTER_URL: 'https://paymaster.example/rpc',
      PAYMASTER_CAPABILITY_TTL_SECONDS: '60',
    });
    const repo = new InMemoryRepository();
    const {
      issuePaymasterCapability,
      lookupPaymasterCapability,
      assertPaymasterRequestScoped,
      hashCapabilityToken,
      incrementPaymasterCapabilityUse,
    } = await import('../src/server/paymaster.js');
    const { encodeRegisterAgentUri } = await import('../src/registry/identity.js');
    const { createApp } = await import('../src/server/app.js');

    const owner = '0x1111111111111111111111111111111111111111' as const;
    const agentURI = 'http://localhost:8787/v1/agents/agent_y/agent-uri.json';
    const registerData = encodeRegisterAgentUri(agentURI);

    await expect(lookupPaymasterCapability(repo, undefined)).rejects.toThrow(/required/i);
    await expect(lookupPaymasterCapability(repo, 'nope')).rejects.toThrow(/Unknown/i);

    const { rawToken, record } = await issuePaymasterCapability(repo, config, {
      agentUuid: 'agent_y',
      chainId: 84532,
      registry: IDENTITY_REGISTRY_SEPOLIA,
      agentURI,
      ownerAddress: owner,
    });
    expect(record.tokenHash).toBe(hashCapabilityToken(rawToken));
    const persisted = JSON.stringify(await repo.getStore());
    expect(persisted).not.toContain(rawToken);
    expect(persisted).toContain(record.tokenHash);

    const wrappedCallData =
      (`0x34fcd5be` + // execute selector placeholder
        '0'.repeat(24) +
        IDENTITY_REGISTRY_SEPOLIA.slice(2).toLowerCase() +
        '0'.repeat(64) +
        registerData.slice(2)) as `0x${string}`;

    const goodBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_getPaymasterData',
      params: [
        {
          sender: owner,
          nonce: '0x1',
          callData: wrappedCallData,
          callGasLimit: '0x0',
          verificationGasLimit: '0x0',
          preVerificationGas: '0x0',
          maxFeePerGas: '0x0',
          maxPriorityFeePerGas: '0x0',
        },
        '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
        '0x14a34',
        {},
      ],
    });

    expect(() => assertPaymasterRequestScoped(record, goodBody)).not.toThrow();

    await expect(async () =>
      assertPaymasterRequestScoped(
        record,
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'pm_getPaymasterData',
          params: [],
          id: 1,
        }),
      ),
    ).rejects.toThrow(/empty/i);

    const wrongOwnerBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_getPaymasterData',
      params: [
        {
          sender: '0x2222222222222222222222222222222222222222',
          callData: wrappedCallData,
        },
        '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
        '0x14a34',
        {},
      ],
    });
    expect(() => assertPaymasterRequestScoped(record, wrongOwnerBody)).toThrow(/sender/i);

    const malformedSenderBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_getPaymasterData',
      params: [
        {
          sender: '0x11111111111111111111111111111111111111', // 38 hex chars — invalid address length
          callData: wrappedCallData,
        },
        '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
        '0x14a34',
        {},
      ],
    });
    expect(() => assertPaymasterRequestScoped(record, malformedSenderBody)).toThrow(
      /sender invalid|DomainError/i,
    );
    try {
      assertPaymasterRequestScoped(record, malformedSenderBody);
      expect.unreachable('expected DomainError');
    } catch (err) {
      const { DomainError } = await import('../src/domain/state-machine.js');
      expect(err).toBeInstanceOf(DomainError);
      expect((err as InstanceType<typeof DomainError>).code).toBe('PAYMASTER_SENDER');
    }

    const wrongChainBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_getPaymasterData',
      params: [
        { sender: owner, callData: wrappedCallData },
        '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
        '0x2105',
        {},
      ],
    });
    expect(() => assertPaymasterRequestScoped(record, wrongChainBody)).toThrow(/chainId/i);

    const wrongCallDataBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'pm_getPaymasterData',
      params: [
        { sender: owner, callData: '0xdeadbeef' },
        '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
        '0x14a34',
        {},
      ],
    });
    expect(() => assertPaymasterRequestScoped(record, wrongCallDataBody)).toThrow(/callData/i);

    // Expired
    await repo.withLock(async (s) => {
      const c = s.paymasterCapabilities.find((x) => x.tokenHash === record.tokenHash)!;
      c.expiresAt = new Date(Date.now() - 1000).toISOString();
    });
    await expect(lookupPaymasterCapability(repo, rawToken)).rejects.toThrow(/expired/i);

    const fresh = await issuePaymasterCapability(repo, config, {
      agentUuid: 'agent_z',
      chainId: 84532,
      registry: IDENTITY_REGISTRY_SEPOLIA,
      agentURI,
      ownerAddress: owner,
    });
    const beforeUses = (await repo.getStore()).paymasterCapabilities.find(
      (c) => c.tokenHash === fresh.record.tokenHash,
    )!.useCount;

    const { app } = createApp(repo, config);
    const denied = await app.request('/v1/paymaster/proxy', {
      method: 'POST',
      body: goodBody,
    });
    expect(denied.status).toBe(400);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }), {
        status: 200,
      })) as typeof fetch;
    try {
      const ok = await app.request(`/v1/paymaster/proxy?c=${fresh.rawToken}`, {
        method: 'POST',
        body: goodBody,
      });
      expect(ok.status).toBe(200);
      const after = (await repo.getStore()).paymasterCapabilities.find(
        (c) => c.tokenHash === fresh.record.tokenHash,
      )!;
      expect(after.useCount).toBe(beforeUses + 1);

      // Failed scope must not increment
      await incrementPaymasterCapabilityUse(repo, fresh.record.tokenHash);
      const mid = (await repo.getStore()).paymasterCapabilities.find(
        (c) => c.tokenHash === fresh.record.tokenHash,
      )!.useCount;
      const bad = await app.request(`/v1/paymaster/proxy?c=${fresh.rawToken}`, {
        method: 'POST',
        body: wrongOwnerBody,
      });
      expect(bad.status).toBe(400);
      expect(
        (await repo.getStore()).paymasterCapabilities.find(
          (c) => c.tokenHash === fresh.record.tokenHash,
        )!.useCount,
      ).toBe(mid);

      const malformedHttp = await app.request(`/v1/paymaster/proxy?c=${fresh.rawToken}`, {
        method: 'POST',
        body: malformedSenderBody,
      });
      expect(malformedHttp.status).toBe(400);
      const malformedJson = (await malformedHttp.json()) as { code?: string };
      expect(malformedJson.code).toBe('PAYMASTER_SENDER');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('enrollment auth + public resolve', () => {
  it('hides enrollment detail without session; resolve has no PII', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const { createApp } = await import('../src/server/app.js');
    const { issueSessionToken } = await import('../src/auth/siwb.js');
    const { app } = createApp(repo, config);

    const key = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', key.publicKey);
    const started = await ceremony.startEnrollment({
      publicJwk,
      keystoreProvider: 'encrypted_os_keystore',
    });
    const owner = '0x1111111111111111111111111111111111111111' as const;
    await ceremony.attachHuman(started.agentUuid, owner);

    const anon = await app.request(`/v1/enrollments/${started.agentUuid}`);
    expect(anon.status).toBe(401);

    const token = await issueSessionToken(repo, config, owner);
    const ok = await app.request(`/v1/enrollments/${started.agentUuid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);

    const stranger = await issueSessionToken(
      repo,
      config,
      '0x2222222222222222222222222222222222222222',
    );
    const forbidden = await app.request(`/v1/enrollments/${started.agentUuid}`, {
      headers: { Authorization: `Bearer ${stranger}` },
    });
    expect(forbidden.status).toBe(403);

    await repo.withLock(async (s) => {
      const e = s.enrollments.find((x) => x.agentUuid === started.agentUuid)!;
      e.agentId = '42';
      e.agentRegistry = agentRegistryRef(84532, IDENTITY_REGISTRY_SEPOLIA);
      e.status = 'bound';
      e.owner = owner;
    });
    const resolved = await ceremony.resolvePublic({
      agentRegistry: agentRegistryRef(84532, IDENTITY_REGISTRY_SEPOLIA),
      agentId: '42',
    });
    expect(resolved).not.toHaveProperty('principalId');
    expect(resolved).not.toHaveProperty('deviceCode');
    expect(JSON.stringify(resolved)).not.toMatch(/prin_|deviceCode/i);
  });
});

describe('key rotation and transfer rebind', () => {
  it('rotates key retaining agentId; transfer rebind updates principal without re-KYC when active', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ownerA = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
    const ownerB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
    const ceremony = new CeremonyService(repo, config, {
      ownerOfReader: async () => ownerA,
    });

    const key1 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const pub1 = await crypto.subtle.exportKey('jwk', key1.publicKey);
    const started = await ceremony.startEnrollment({
      publicJwk: pub1,
      keystoreProvider: 'encrypted_os_keystore',
    });
    await ceremony.attachHuman(started.agentUuid, ownerA);
    const kyc = await ceremony.startKyc(ownerA);
    const signed = DemoKycAdapter.signWebhook({
      session_id: kyc.sessionId,
      status: 'verified',
      event_id: 'rot-kyc',
    });
    await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signed.signature }, signed.rawBody);
    await ceremony.attachHuman(started.agentUuid, ownerA);
    await ceremony.approveFingerprint(started.agentUuid, ownerA, started.thumbprint);
    const bound = await ceremony.confirmDemoRegistration(started.agentUuid, ownerA);
    const oldAgentId = bound.agentId;
    const oldRegistry = bound.agentRegistry;
    const oldJti = (await repo.getStore()).credentials.find(
      (c) => c.agentUuid === started.agentUuid && c.status === 'active',
    )!.jti;

    const key2 = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const pub2 = await crypto.subtle.exportKey('jwk', key2.publicKey);
    const rotated = await ceremony.rotateKey(
      started.agentUuid,
      ownerA,
      pub2,
      'encrypted_os_keystore',
    );
    expect(rotated.status).toBe('awaiting_fingerprint');
    expect(rotated.agentId).toBe(oldAgentId);
    expect(rotated.agentRegistry).toBe(oldRegistry);
    expect(
      (await repo.getStore()).credentials.find((c) => c.jti === oldJti)?.status,
    ).toBe('revoked');

    const afterApprove = await ceremony.approveFingerprint(
      started.agentUuid,
      ownerA,
      rotated.thumbprint,
    );
    expect(afterApprove.status).toBe('bound');
    expect(afterApprove.agentId).toBe(oldAgentId);
    ceremony.setOwnerOfReader(async () => ownerA);
    const claimed = await ceremony.claimCredential(started.agentUuid, ownerA);
    expect(claimed.agentId).toBe(oldAgentId);

    // Pre-verify new owner (no re-KYC on rebind).
    await ceremony.findOrCreatePrincipal(ownerB);
    const kycB = await ceremony.startKyc(ownerB);
    const signedB = DemoKycAdapter.signWebhook({
      session_id: kycB.sessionId,
      status: 'verified',
      event_id: 'rebind-kyc',
    });
    await ceremony.handleKycWebhook(
      'demo',
      { 'x-demo-signature': signedB.signature },
      signedB.rawBody,
    );
    expect(needsKyc((await repo.getStore()).principals.find((p) => p.ownerAddress === ownerB)!)).toBe(
      false,
    );

    ceremony.setOwnerOfReader(async () => ownerB);
    await ceremony.simulateTransfer(started.agentUuid, ownerB);
    const suspended = (await repo.getStore()).enrollments.find(
      (e) => e.agentUuid === started.agentUuid,
    )!;
    expect(suspended.status).toBe('suspended');
    expect(suspended.owner?.toLowerCase()).toBe(ownerB);
    const oldPrincipalId = suspended.principalId;

    const rebound = await ceremony.rebindAfterTransfer(
      started.agentUuid,
      ownerB,
      rotated.thumbprint,
    );
    expect(rebound.status).toBe('bound');
    expect(rebound.agentId).toBe(oldAgentId);
    expect(rebound.agentRegistry).toBe(oldRegistry);
    expect(rebound.principalId).not.toBe(oldPrincipalId);
    const newCred = await ceremony.claimCredential(started.agentUuid, ownerB);
    expect(newCred.agentId).toBe(oldAgentId);
  });
});

describe('challenge ownerOf fail-closed', () => {
  it('fails when on-chain owner differs from enrollment', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const owner = '0x1111111111111111111111111111111111111111' as const;
    const ceremony = new CeremonyService(repo, config, {
      ownerOfReader: async () => '0x9999999999999999999999999999999999999999',
    });
    const key = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', key.publicKey);
    const started = await ceremony.startEnrollment({
      publicJwk,
      keystoreProvider: 'encrypted_os_keystore',
    });
    await ceremony.attachHuman(started.agentUuid, owner);
    const kyc = await ceremony.startKyc(owner);
    const { rawBody, signature } = DemoKycAdapter.signWebhook({
      session_id: kyc.sessionId,
      status: 'verified',
      event_id: 'own-mismatch',
    });
    await ceremony.handleKycWebhook('demo', { 'x-demo-signature': signature }, rawBody);
    await ceremony.attachHuman(started.agentUuid, owner);
    await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
    await ceremony.confirmDemoRegistration(started.agentUuid, owner);

    const challenge = await ceremony.createChallenge(started.agentUuid, { action: 'x' });
    const { signChallenge } = await import('../src/crypto/local-agent-key.js');
    const sig = await signChallenge(key.privateKey, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: challenge.intent_hash,
    });
    await expect(
      ceremony.verifyChallenge(started.agentUuid, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: challenge.timestamp,
        intent_hash: challenge.intent_hash,
        signature: sig,
      }),
    ).rejects.toThrow(/owner/i);
  });
});

describe('registry readiness', () => {
  it('requires exact getVersion 2.0.0; rejects wrong non-empty versions', async () => {
    const { generateKeyPair, exportJWK } = await import('jose');
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const config = testConfig({
      KYA_MODE: 'live',
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      DIDIT_API_KEY: 'k',
      DIDIT_WORKFLOW_ID: 'w',
      DIDIT_WEBHOOK_SECRET: 's',
      KYA_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
      MAINNET_PROMOTION_ENABLED: 'true',
      MAINNET_REGISTRY_VERIFIED: 'true',
    });
    const {
      resolveRegistryAddress,
      assertRegistryReadyForChain,
      verifyRegistryReady,
      selectLiveWatcherChains,
      SUPPORTED_IDENTITY_REGISTRY_VERSION,
      isSupportedIdentityRegistryVersion,
    } = await import('../src/registry/identity.js');

    expect(SUPPORTED_IDENTITY_REGISTRY_VERSION).toBe('2.0.0');
    expect(isSupportedIdentityRegistryVersion('2.0.0')).toBe(true);
    expect(isSupportedIdentityRegistryVersion('1.0.0')).toBe(false);
    expect(isSupportedIdentityRegistryVersion('')).toBe(false);

    expect(() => resolveRegistryAddress(config, 8453)).toThrow(/verification|Mainnet/i);
    expect(() =>
      resolveRegistryAddress(config, 8453, { codePresent: true, getVersionOk: false }),
    ).toThrow(/getVersion|2\.0\.0/i);

    await expect(
      assertRegistryReadyForChain(config, 84532, {
        getCode: async () => '0x',
        readContract: async () => {
          throw new Error('no code');
        },
      }),
    ).rejects.toThrow(/not ready/i);

    const wrong = await verifyRegistryReady(
      {
        getCode: async () => '0x60016001',
        readContract: async () => '1.0.0',
      },
      IDENTITY_REGISTRY_SEPOLIA,
    );
    expect(wrong.codePresent).toBe(true);
    expect(wrong.version).toBe('1.0.0');
    expect(wrong.getVersionOk).toBe(false);

    await expect(
      assertRegistryReadyForChain(config, 84532, {
        getCode: async () => '0x60016001',
        readContract: async () => '1.0.0',
      }),
    ).rejects.toThrow(/2\.0\.0|not ready/i);

    await expect(
      assertRegistryReadyForChain(config, 84532, {
        getCode: async () => '0x60016001',
        readContract: async () => '2.0.0',
      }),
    ).resolves.toMatchObject({ version: '2.0.0' });

    expect(selectLiveWatcherChains({
      MAINNET_PROMOTION_ENABLED: false,
      MAINNET_REGISTRY_VERIFIED: false,
    })).toEqual([84532]);
    expect(selectLiveWatcherChains({
      MAINNET_PROMOTION_ENABLED: true,
      MAINNET_REGISTRY_VERIFIED: false,
    })).toEqual([84532]);
    expect(selectLiveWatcherChains({
      MAINNET_PROMOTION_ENABLED: true,
      MAINNET_REGISTRY_VERIFIED: true,
    })).toEqual([84532, 8453]);
  });
});

describe('Registered URI exact match + confirmation depth', () => {
  it('does not bind on substring URI includes; applies at confirmation depth 1 on same block', async () => {
    const repo = new InMemoryRepository();
    const owner = '0x1111111111111111111111111111111111111111' as const;
    await repo.withLock(async (s) => {
      s.principals.push({
        id: 'prin_exact',
        ownerAddress: owner,
        kycStatus: 'verified',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      s.enrollments.push({
        agentUuid: 'agent_exact',
        deviceCode: 'ABCD',
        principalId: 'prin_exact',
        status: 'awaiting_onchain',
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        thumbprint: 't',
        keystoreProvider: 'os_hardware',
        agentUriPath: '/v1/agents/agent_exact/agent-uri.json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    const { hasEnoughConfirmations } = await import('../src/registry/events.js');
    expect(hasEnoughConfirmations(10n, 10n, 1)).toBe(true);
    expect(hasEnoughConfirmations(10n, 10n, 2)).toBe(false);

    await applyRegisteredEvent(
      repo,
      84532,
      {
        agentId: '1',
        agentURI: 'http://localhost/v1/agents/agent_exact_EXTRA/agent-uri.json',
        owner,
        txHash: ('0x' + '33'.repeat(32)) as `0x${string}`,
        logIndex: 0,
        blockNumber: 10n,
      },
      {
        currentBlock: 10n,
        confirmations: 1,
        publicBaseUrl: 'http://localhost',
        registryAddress: IDENTITY_REGISTRY_SEPOLIA,
      },
    );
    expect(
      (await repo.getStore()).enrollments.find((e) => e.agentUuid === 'agent_exact')?.status,
    ).toBe('awaiting_onchain');

    await applyRegisteredEvent(
      repo,
      84532,
      {
        agentId: '2',
        agentURI: 'http://localhost/v1/agents/agent_exact/agent-uri.json',
        owner,
        txHash: ('0x' + '44'.repeat(32)) as `0x${string}`,
        logIndex: 1,
        blockNumber: 11n,
      },
      {
        currentBlock: 11n,
        confirmations: 1,
        publicBaseUrl: 'http://localhost',
        registryAddress: IDENTITY_REGISTRY_SEPOLIA,
      },
    );
    const e = (await repo.getStore()).enrollments.find((x) => x.agentUuid === 'agent_exact')!;
    expect(e.status).toBe('bound');
    expect(e.agentId).toBe('2');
    expect(e.agentRegistry).toContain(IDENTITY_REGISTRY_SEPOLIA);
  });
});

describe('applyRegisteredEvent fail-closed', () => {
  it('does not bind when enrollment has no Principal or owner mismatches', async () => {
    const repo = new InMemoryRepository();
    const owner = '0x1111111111111111111111111111111111111111' as const;
    await repo.withLock(async (s) => {
      s.enrollments.push({
        agentUuid: 'agent_noprin',
        deviceCode: 'ABCD',
        status: 'awaiting_onchain',
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        thumbprint: 't',
        keystoreProvider: 'os_hardware',
        agentUriPath: '/v1/agents/agent_noprin/agent-uri.json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      s.principals.push({
        id: 'prin_other',
        ownerAddress: '0x2222222222222222222222222222222222222222',
        kycStatus: 'verified',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      s.enrollments.push({
        agentUuid: 'agent_mismatch',
        deviceCode: 'EFGH',
        principalId: 'prin_other',
        status: 'awaiting_onchain',
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'c', y: 'd' },
        thumbprint: 'u',
        keystoreProvider: 'os_hardware',
        agentUriPath: '/v1/agents/agent_mismatch/agent-uri.json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    const r1 = await applyRegisteredEvent(
      repo,
      84532,
      {
        agentId: '7',
        agentURI: 'http://localhost/v1/agents/agent_noprin/agent-uri.json',
        owner,
        txHash: ('0x' + '55'.repeat(32)) as `0x${string}`,
        logIndex: 0,
        blockNumber: 1n,
      },
      {
        currentBlock: 1n,
        confirmations: 1,
        publicBaseUrl: 'http://localhost',
        registryAddress: IDENTITY_REGISTRY_SEPOLIA,
      },
    );
    expect(r1.applied).toBe(true);
    expect(r1.bound).toBe(false);
    expect(
      (await repo.getStore()).enrollments.find((e) => e.agentUuid === 'agent_noprin')?.status,
    ).toBe('awaiting_onchain');

    const r2 = await applyRegisteredEvent(
      repo,
      84532,
      {
        agentId: '8',
        agentURI: 'http://localhost/v1/agents/agent_mismatch/agent-uri.json',
        owner,
        txHash: ('0x' + '66'.repeat(32)) as `0x${string}`,
        logIndex: 1,
        blockNumber: 2n,
      },
      {
        currentBlock: 2n,
        confirmations: 1,
        publicBaseUrl: 'http://localhost',
        registryAddress: IDENTITY_REGISTRY_SEPOLIA,
      },
    );
    expect(r2.applied).toBe(true);
    expect(r2.bound).toBe(false);
    expect(
      (await repo.getStore()).enrollments.find((e) => e.agentUuid === 'agent_mismatch')?.status,
    ).toBe('awaiting_onchain');
  });
});

describe('watcher pending confirmations', () => {
  it('queues log at block N with confirmations=2 and applies exactly once at N+1 via flush', async () => {
    const repo = new InMemoryRepository();
    const owner = '0x1111111111111111111111111111111111111111' as const;
    await repo.withLock(async (s) => {
      s.principals.push({
        id: 'prin_w',
        ownerAddress: owner,
        kycStatus: 'verified',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      s.enrollments.push({
        agentUuid: 'agent_w',
        deviceCode: 'WATCH',
        principalId: 'prin_w',
        status: 'awaiting_onchain',
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        thumbprint: 't',
        keystoreProvider: 'os_hardware',
        agentUriPath: '/v1/agents/agent_w/agent-uri.json',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    let block = 100n;
    let registeredHandler:
      | ((logs: Array<Record<string, unknown>>) => Promise<void>)
      | undefined;
    const client = {
      getBlockNumber: async () => block,
      watchContractEvent: (args: Record<string, unknown>) => {
        if (args.eventName === 'Registered') {
          registeredHandler = args.onLogs as typeof registeredHandler;
        }
        return () => undefined;
      },
    };

    const { startEventWatcher } = await import('../src/registry/events.js');
    const watcher = await startEventWatcher(client, repo, {
      chainId: 84532,
      registry: IDENTITY_REGISTRY_SEPOLIA,
      confirmations: 2,
      publicBaseUrl: 'http://localhost',
      flushIntervalMs: 60_000,
    });

    await registeredHandler!([
      {
        args: {
          agentId: 99n,
          agentURI: 'http://localhost/v1/agents/agent_w/agent-uri.json',
          owner,
        },
        transactionHash: ('0x' + '77'.repeat(32)) as `0x${string}`,
        logIndex: 0,
        blockNumber: 100n,
      },
    ]);

    expect(watcher.pendingCount()).toBe(1);
    expect(
      (await repo.getStore()).enrollments.find((e) => e.agentUuid === 'agent_w')?.status,
    ).toBe('awaiting_onchain');

    block = 101n;
    await watcher.flush();
    expect(watcher.pendingCount()).toBe(0);
    const bound = (await repo.getStore()).enrollments.find((e) => e.agentUuid === 'agent_w')!;
    expect(bound.status).toBe('bound');
    expect(bound.agentId).toBe('99');

    // Flush again — exactly once (idempotent processedEvents).
    await watcher.flush();
    expect(
      (await repo.getStore()).processedEvents.filter((e) => e.eventName === 'Registered'),
    ).toHaveLength(1);

    watcher.stop();
    expect(watcher.pendingCount()).toBe(0);
  });
});
