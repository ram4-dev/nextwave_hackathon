import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository, type KyaStore, type Repository } from '../src/persistence/repository.js';
import {
  CasConflictError,
  compareAndSwapState,
  loadVersionedState,
  type VersionedStateBackend,
} from '../src/persistence/cas-store.js';
import { DomainError } from '../src/domain/state-machine.js';
import { assertPublicEcP256Jwk, sanitizePublicJwk } from '../src/crypto/local-agent-key.js';
import { verifyKyaCredential } from '../src/credentials/jws.js';
import { ensureSigningKey, importActivePrivateKey } from '../src/credentials/signer.js';
import {
  AGENT_ACCESS_TYP,
  issueAgentAccessToken,
  resolveAuthenticatedAgentContext,
  verifyAgentAccessToken,
  DEFAULT_AGENT_API_AUDIENCE,
} from '../src/auth/agent-access.js';
import { createRequireAgentAuth, consumeDpopReplay } from '../src/auth/dpop.js';
import { buildDpopProof } from '../src/crypto/dpop-proof.js';
import { generateLocalAgentKey, signChallenge } from '../src/crypto/local-agent-key.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { applyKycStatus } from '../src/domain/state-machine.js';
import { createApp } from '../src/server/app.js';
import { Hono } from 'hono';
import { createMemoryRateLimiter } from '../src/server/rate-limit.js';

function cfg(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    FRONTEND_ORIGIN: 'http://localhost:5173',
    PERSISTENCE_BACKEND: 'memory',
    AGENT_API_AUDIENCE: DEFAULT_AGENT_API_AUDIENCE,
    ...extra,
  });
}

function emptyStore(): KyaStore {
  return {
    principals: [],
    enrollments: [],
    credentials: [],
    nonces: [],
    kycSessions: [],
    processedEvents: [],
    pendingRegistryEvents: [],
    cursors: [],
    signingKeys: [],
    accessTokens: [],
    dpopReplays: [],
  };
}

describe('CAS versioned state authority', () => {
  it('rejects CAS when expected_version mismatches without mutating state', async () => {
    const backend: VersionedStateBackend = {
      async load() {
        return { version: 3, state: emptyStore() };
      },
      async compareAndSwap(expected, _next) {
        if (expected !== 3) return { ok: false as const, currentVersion: 3 };
        return { ok: true as const, version: 4 };
      },
    };
    const loaded = await loadVersionedState(backend);
    expect(loaded.version).toBe(3);
    await expect(compareAndSwapState(backend, 2, emptyStore())).rejects.toBeInstanceOf(
      CasConflictError,
    );
  });

  it('round-trips state through successful CAS and load', async () => {
    let version = 0;
    let state = emptyStore();
    const backend: VersionedStateBackend = {
      async load() {
        return { version, state: structuredClone(state) };
      },
      async compareAndSwap(expected, next) {
        if (expected !== version) return { ok: false as const, currentVersion: version };
        version += 1;
        state = structuredClone(next);
        return { ok: true as const, version };
      },
    };
    state.principals.push({
      id: 'prin_1',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      kycStatus: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const next = await compareAndSwapState(backend, 0, state);
    expect(next).toBe(1);
    const loaded = await loadVersionedState(backend);
    expect(loaded.version).toBe(1);
    expect(loaded.state.principals[0]?.id).toBe('prin_1');
  });
});

describe('atomic DPoP replay on Repository', () => {
  it('exposes consumeDpopReplayAtomic and rejects second consume', async () => {
    const repo = new InMemoryRepository();
    expect(typeof repo.consumeDpopReplayAtomic).toBe('function');
    const jti = 'proof-jti-abcdef';
    const expires = new Date(Date.now() + 60_000).toISOString();
    const first = await repo.consumeDpopReplayAtomic!(
      createHash('sha256').update(jti).digest('hex'),
      expires,
    );
    expect(first).toBe('consumed');
    const second = await repo.consumeDpopReplayAtomic!(
      createHash('sha256').update(jti).digest('hex'),
      expires,
    );
    expect(second).toBe('replay');
  });

  it('consumeDpopReplay uses atomic API and maps UNAVAILABLE', async () => {
    const repo: Repository = {
      async getStore() {
        return emptyStore();
      },
      async saveStore() {},
      async withLock(fn) {
        return fn(emptyStore());
      },
      async consumeDpopReplayAtomic() {
        throw new DomainError('DPoP replay store unavailable', 'UNAVAILABLE');
      },
    };
    await expect(consumeDpopReplay(repo, 'abcdefgh', new Date().toISOString())).rejects.toMatchObject(
      { code: 'UNAVAILABLE' },
    );
  });
});

describe('public JWK validation matrix', () => {
  it('rejects private members and non P-256 shapes', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const good = await exportJWK(publicKey);
    expect(() => assertPublicEcP256Jwk({ ...good, d: 'secret' })).toThrow(/private|PII|FORBIDDEN|INVALID/i);
    expect(() => assertPublicEcP256Jwk({ ...good, p: 'x' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, q: 'x' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, dp: 'x' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, dq: 'x' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, qi: 'x' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, oth: [] })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, k: 'x' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, n: 'rsa-n' } as JsonWebKey)).toThrow(
      /Incompatible|Private/i,
    );
    expect(() => assertPublicEcP256Jwk({ ...good, kty: 'RSA' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, crv: 'P-384' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ kty: 'EC', crv: 'P-256' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, x: '!!not-b64url!!' })).toThrow();
    const cleaned = sanitizePublicJwk({ ...good, d: 'secret' } as JsonWebKey);
    expect((cleaned as { d?: string }).d).toBeUndefined();
    expect(() => assertPublicEcP256Jwk(good)).not.toThrow();
  });
});

describe('credential typ class separation', () => {
  it('rejects wrong typ/alg for KYA credential verifier', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const key = await ensureSigningKey(repo, config);
    const privateKey = await importActivePrivateKey(key);
    const wrongTyp = await new SignJWT({ status: 'active' })
      .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'KYA-AGENT-ACCESS+JWT' })
      .setIssuer(config.KYA_ISSUER)
      .setAudience(config.KYA_AUDIENCE)
      .setSubject('agent_x')
      .setJti('cred_fake')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyKyaCredential(repo, config, wrongTyp)).rejects.toMatchObject({
      code: expect.stringMatching(/JWT|UNAUTHORIZED|TYP/i),
    });

    const wrongKid = await new SignJWT({ status: 'active' })
      .setProtectedHeader({ alg: 'ES256', kid: 'unknown-kid', typ: 'KYA-CREDENTIAL+JWT' })
      .setIssuer(config.KYA_ISSUER)
      .setAudience(config.KYA_AUDIENCE)
      .setSubject('agent_x')
      .setJti('cred_fake2')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyKyaCredential(repo, config, wrongKid)).rejects.toMatchObject({
      code: expect.stringMatching(/JWT|KID/i),
    });
  });
});

describe('access token binding', () => {
  it('rejects signed token whose sub mismatches persisted record', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    await repo.withLock(async (s) => {
      s.credentials.push({
        id: 'cred_1',
        agentUuid: 'agent_a',
        principalId: 'prin_a',
        thumbprint: 'jkt',
        agentRegistry: 'eip155:84532:0x1',
        agentId: '1',
        owner: '0x1111111111111111111111111111111111111111',
        status: 'active',
        statusRef: 'http://localhost/status',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        jti: 'cred_1',
      });
    });
    const { token, record } = await issueAgentAccessToken(repo, config, {
      agentUuid: 'agent_a',
      principalId: 'prin_a',
      thumbprint: 'jkt',
      credentialJti: 'cred_1',
    });
    expect(record.agentUuid).toBe('agent_a');
    // Tamper persisted binding
    await repo.withLock(async (s) => {
      const t = s.accessTokens.find((x) => x.jti === record.jti)!;
      t.agentUuid = 'agent_b';
    });
    await expect(verifyAgentAccessToken(repo, config, token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('rejects scope, credential_jti, cnf, and wrong typ mismatches', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    await repo.withLock(async (s) => {
      s.credentials.push({
        id: 'cred_2',
        agentUuid: 'agent_a',
        principalId: 'prin_a',
        thumbprint: 'jkt-a',
        agentRegistry: 'eip155:84532:0x1',
        agentId: '1',
        owner: '0x1111111111111111111111111111111111111111',
        status: 'active',
        statusRef: 'http://localhost/status',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        jti: 'cred_2',
      });
    });
    const { token, record } = await issueAgentAccessToken(repo, config, {
      agentUuid: 'agent_a',
      principalId: 'prin_a',
      thumbprint: 'jkt-a',
      credentialJti: 'cred_2',
    });

    await repo.withLock(async (s) => {
      const t = s.accessTokens.find((x) => x.jti === record.jti)!;
      t.scopes = ['agent:admin'];
    });
    await expect(verifyAgentAccessToken(repo, config, token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    await repo.withLock(async (s) => {
      const t = s.accessTokens.find((x) => x.jti === record.jti)!;
      t.scopes = record.scopes;
      t.credentialJti = 'other-cred';
    });
    await expect(verifyAgentAccessToken(repo, config, token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    await repo.withLock(async (s) => {
      const t = s.accessTokens.find((x) => x.jti === record.jti)!;
      t.credentialJti = 'cred_2';
      t.jkt = 'other-jkt';
    });
    await expect(verifyAgentAccessToken(repo, config, token)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });

    const key = await ensureSigningKey(repo, config);
    const privateKey = await importActivePrivateKey(key);
    const wrongClass = await new SignJWT({
      scopes: record.scopes,
      credential_jti: 'cred_2',
      cnf: { jkt: 'jkt-a' },
    })
      .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'KYA-CREDENTIAL+JWT' })
      .setIssuer(config.KYA_ISSUER)
      .setAudience(DEFAULT_AGENT_API_AUDIENCE)
      .setSubject('agent_a')
      .setJti(record.jti)
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyAgentAccessToken(repo, config, wrongClass)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('enforces access-token issuer, audience, and expiry while accepting the exact profile', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    await repo.withLock((store) => {
      store.credentials.push({
        id: 'cred_rules',
        agentUuid: 'agent_rules',
        principalId: 'prin_rules',
        thumbprint: 'jkt-rules',
        agentRegistry: 'eip155:84532:0x1',
        agentId: '1',
        owner: '0x1111111111111111111111111111111111111111',
        status: 'active',
        statusRef: 'http://localhost/status/cred_rules',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        jti: 'cred_rules',
      });
    });
    const issued = await issueAgentAccessToken(repo, config, {
      agentUuid: 'agent_rules',
      principalId: 'prin_rules',
      thumbprint: 'jkt-rules',
      credentialJti: 'cred_rules',
    });
    const key = await ensureSigningKey(repo, config);
    const privateKey = await importActivePrivateKey(key);
    const now = Math.floor(Date.now() / 1000);
    const sign = (input: { issuer: string; audience: string; expiresAt: number }) =>
      new SignJWT({
        scopes: issued.record.scopes,
        credential_jti: issued.record.credentialJti,
        cnf: { jkt: issued.record.jkt },
      })
        .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: AGENT_ACCESS_TYP })
        .setIssuer(input.issuer)
        .setAudience(input.audience)
        .setSubject(issued.record.agentUuid)
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(input.expiresAt)
        .setJti(issued.record.jti)
        .sign(privateKey);

    const exact = await sign({
      issuer: config.KYA_ISSUER,
      audience: DEFAULT_AGENT_API_AUDIENCE,
      expiresAt: now + 60,
    });
    await expect(verifyAgentAccessToken(repo, config, exact)).resolves.toMatchObject({
      record: { jti: issued.record.jti },
    });
    for (const invalid of [
      await sign({
        issuer: 'https://wrong-issuer.example',
        audience: DEFAULT_AGENT_API_AUDIENCE,
        expiresAt: now + 60,
      }),
      await sign({
        issuer: config.KYA_ISSUER,
        audience: 'wrong-agent-api',
        expiresAt: now + 60,
      }),
      await sign({
        issuer: config.KYA_ISSUER,
        audience: DEFAULT_AGENT_API_AUDIENCE,
        expiresAt: now - 10,
      }),
    ]) {
      await expect(verifyAgentAccessToken(repo, config, invalid)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
  });

  it('recomputes the enrolled public JWK thumbprint before resolving the full binding chain', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const { accessToken, started } = await boundAgentFixture(repo, config);
    const replacement = await generateLocalAgentKey();
    await repo.withLock((store) => {
      const enrollment = store.enrollments.find(
        (item) => item.agentUuid === started.agentUuid,
      )!;
      enrollment.publicJwk = replacement.publicJwk;
      // Deliberately leave enrollment.thumbprint and all credential/token
      // records unchanged to model a partial or malicious persistence write.
    });
    await expect(
      resolveAuthenticatedAgentContext(repo, config, accessToken),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('resolveAuthenticatedAgentContext negatives', () => {
  it('rejects revoked credential, unbound enrollment, and expired KYC', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const { accessToken } = await boundAgentFixture(repo, config);

    await repo.withLock(async (s) => {
      for (const c of s.credentials) c.status = 'revoked';
    });
    await expect(verifyAgentAccessToken(repo, config, accessToken).then(async () => {
      const { resolveAuthenticatedAgentContext } = await import('../src/auth/agent-access.js');
      return resolveAuthenticatedAgentContext(repo, config, accessToken);
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    // Restore credential; revoke enrollment
    await repo.withLock(async (s) => {
      for (const c of s.credentials) c.status = 'active';
      for (const e of s.enrollments) e.status = 'revoked';
    });
    {
      const { resolveAuthenticatedAgentContext } = await import('../src/auth/agent-access.js');
      await expect(resolveAuthenticatedAgentContext(repo, config, accessToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }

    await repo.withLock(async (s) => {
      for (const e of s.enrollments) e.status = 'bound';
      for (const p of s.principals) {
        p.kycStatus = 'expired';
        p.kycExpiresAt = new Date(Date.now() - 60_000).toISOString();
      }
    });
    {
      const { resolveAuthenticatedAgentContext } = await import('../src/auth/agent-access.js');
      await expect(resolveAuthenticatedAgentContext(repo, config, accessToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
  });
});

describe('live fail-closed config', () => {
  it('rejects KYA_MODE=live without supabase persistence', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        KYA_MODE: 'live',
        PERSISTENCE_BACKEND: 'json',
        BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
        DIDIT_API_KEY: 'x',
        DIDIT_WORKFLOW_ID: 'x',
        DIDIT_WEBHOOK_SECRET: 'x',
        KYA_SIGNING_PRIVATE_JWK: JSON.stringify({
          kty: 'EC',
          crv: 'P-256',
          x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
          y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
          d: '0_HIxo-o-ZevHFzjmgWRLVTFJbMZtF-nT0uDh_H5YJY',
        }),
      }),
    ).toThrow();
  });
});

describe('rate limiting public pairing endpoints', () => {
  it('returns 429 after limit is exhausted', async () => {
    const limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000 });
    expect(limiter.check('ip:1')).toEqual({ allowed: true, remaining: 1 });
    expect(limiter.check('ip:1')).toEqual({ allowed: true, remaining: 0 });
    expect(limiter.check('ip:1')).toEqual({ allowed: false, remaining: 0 });
  });

  it('HTTP device enrollment returns 429 when limiter exhausted', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000 });
    const { app } = createApp(repo, config, { publicRateLimiter: limiter });
    const key = await generateLocalAgentKey();
    const first = await app.request('/v1/device-enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicJwk: key.publicJwk }),
    });
    expect(first.status).toBe(201);
    const second = await app.request('/v1/device-enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicJwk: key.publicJwk }),
    });
    expect(second.status).toBe(429);
  });
});

async function boundAgentFixture(repo: InMemoryRepository, config = cfg()) {
  const ceremony = new CeremonyService(repo, config);
  const key = await generateLocalAgentKey();
  const started = await ceremony.startEnrollment({
    publicJwk: key.publicJwk,
    keystoreProvider: key.keystoreProvider,
  });
  const principal = await ceremony.findOrCreatePrincipal(
    '0x2222222222222222222222222222222222222222',
  );
  await repo.withLock(async (s) => {
    Object.assign(
      s.principals.find((x) => x.id === principal.id)!,
      applyKycStatus(principal, 'verified', {
        provider: 'demo',
        sessionRef: 's',
        assuranceLevel: 'high',
        ttlDays: 365,
      }),
    );
  });
  await ceremony.attachHuman(started.agentUuid, principal.ownerAddress);
  await ceremony.approveFingerprint(started.agentUuid, principal.ownerAddress, started.thumbprint);
  await ceremony.confirmDemoRegistration(started.agentUuid, principal.ownerAddress);
  const challenge = await ceremony.createChallenge(started.agentUuid, { action: 'authenticate' });
  const signature = await signChallenge(key.privateKey, challenge);
  const verified = await ceremony.verifyChallenge(started.agentUuid, { ...challenge, signature });
  return { key, started, principal, accessToken: verified.access_token!, ceremony };
}

describe('requireAgentAuth live ownerOf and HTTP classes', () => {
  it('rejects when on-chain owner changes during token lifetime', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const { key, accessToken } = await boundAgentFixture(repo, config);
    let owner = '0x2222222222222222222222222222222222222222' as `0x${string}`;
    const app = new Hono();
    const requireAgentAuth = createRequireAgentAuth(repo, config, {
      readOwnerOf: async () => owner,
    });
    app.get('/v1/agent/me', requireAgentAuth, (c) => c.json({ ok: true }));

    const proof1 = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
    });
    const ok = await app.request('http://localhost:8787/v1/agent/me', {
      headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof1 },
    });
    expect(ok.status).toBe(200);

    owner = '0x9999999999999999999999999999999999999999';
    const proof2 = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
      jti: randomUUID(),
    });
    const denied = await app.request('http://localhost:8787/v1/agent/me', {
      headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof2 },
    });
    expect(denied.status).toBe(403);
  });

  it('maps UNAVAILABLE from DPoP replay store to 503', async () => {
    const base = new InMemoryRepository();
    const config = cfg();
    const { key, accessToken } = await boundAgentFixture(base, config);
    const repo: Repository = {
      getStore: () => base.getStore(),
      saveStore: (s) => base.saveStore(s),
      withLock: (fn) => base.withLock(fn),
      async consumeDpopReplayAtomic() {
        throw new DomainError('DPoP replay store unavailable', 'UNAVAILABLE');
      },
    };
    const app = new Hono();
    app.get('/v1/agent/me', createRequireAgentAuth(repo, config), (c) => c.json({ ok: true }));
    const proof = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
    });
    const res = await app.request('http://localhost:8787/v1/agent/me', {
      headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof },
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('UNAVAILABLE');
    expect(JSON.stringify(body)).not.toMatch(/stack|supabase|service.role/i);
  });

  it('rejects wrong DPoP key, htm, htu, ath, expired/future iat, and short jti', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const { key, accessToken } = await boundAgentFixture(repo, config);
    const other = await generateLocalAgentKey();
    const { app } = createApp(repo, config);

    const wrongKey = await buildDpopProof(other.privateKey, other.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
    });
    expect(
      (
        await app.request('/v1/agent/me', {
          headers: { Authorization: `DPoP ${accessToken}`, DPoP: wrongKey },
        })
      ).status,
    ).toBe(401);

    const wrongHtm = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'POST',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
    });
    expect(
      (
        await app.request('/v1/agent/me', {
          headers: { Authorization: `DPoP ${accessToken}`, DPoP: wrongHtm },
        })
      ).status,
    ).toBe(401);

    const wrongHtu = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/other',
      accessToken,
    });
    expect(
      (
        await app.request('/v1/agent/me', {
          headers: { Authorization: `DPoP ${accessToken}`, DPoP: wrongHtu },
        })
      ).status,
    ).toBe(401);

    const wrongAth = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken: 'not-the-access-token',
    });
    expect(
      (
        await app.request('/v1/agent/me', {
          headers: { Authorization: `DPoP ${accessToken}`, DPoP: wrongAth },
        })
      ).status,
    ).toBe(401);

    const stale = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
      iat: Math.floor(Date.now() / 1000) - 10_000,
    });
    expect(
      (
        await app.request('/v1/agent/me', {
          headers: { Authorization: `DPoP ${accessToken}`, DPoP: stale },
        })
      ).status,
    ).toBe(401);

    const future = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
      iat: Math.floor(Date.now() / 1000) + 10_000,
      jti: randomUUID(),
    });
    expect(
      (
        await app.request('/v1/agent/me', {
          headers: { Authorization: `DPoP ${accessToken}`, DPoP: future },
        })
      ).status,
    ).toBe(401);

    const shortJti = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
      jti: 'short',
    });
    expect(
      (
        await app.request('/v1/agent/me', {
          headers: { Authorization: `DPoP ${accessToken}`, DPoP: shortJti },
        })
      ).status,
    ).toBe(401);
  });
});

describe('/ready fail-closed', () => {
  it('reports not ready when supabase backend lacks schema readiness', async () => {
    const repo = new InMemoryRepository();
    const config = cfg({
      PERSISTENCE_BACKEND: 'supabase',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-role-not-a-real-secret',
    });
    const { app } = createApp(repo, config, {
      persistenceReady: async () => false,
    });
    const res = await app.request('/ready');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ready).toBe(false);
  });
});

describe('migrate fixture JWK rejection (no remote)', () => {
  it('rejects private JWK fields in synthetic store fixtures', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const good = await exportJWK(publicKey);
    expect(() => assertPublicEcP256Jwk({ ...good, d: 'secret' })).toThrow();
    expect(() => assertPublicEcP256Jwk({ ...good, p: '1', q: '2' } as JsonWebKey)).toThrow();
  });
});

describe('frontend dpopClient pure units', () => {
  it('computeAth and buildDpopProof produce RFC-shaped proof without private material', async () => {
    const { computeAth, buildDpopProof: webBuild } = await import('../web/src/agent/dpopClient.js');
    const key = await generateLocalAgentKey();
    const ath = await computeAth('access-token-sample');
    expect(ath).toMatch(/^[A-Za-z0-9_-]+$/);
    const proof = await webBuild(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken: 'access-token-sample',
    });
    const [h] = proof.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'));
    expect(header.typ).toBe('dpop+jwt');
    expect(header.jwk.d).toBeUndefined();
    expect(header.jwk.p).toBeUndefined();
    expect(header.jwk.q).toBeUndefined();
    // Contaminated input must not leak private members into proof header.
    const contaminated = { ...key.publicJwk, p: 'leak', q: 'leak', d: 'leak' } as JsonWebKey;
    await expect(webBuild(key.privateKey, contaminated, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken: 'access-token-sample',
    })).rejects.toThrow(/Private|P-256|coordinate/i);
  });
});
