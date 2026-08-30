import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  checkSupabaseSchemaReady,
  createSupabaseCasBackend,
  KYA_SCHEMA_VERSION,
  SupabaseRepository,
} from '../src/persistence/supabase-repository.js';
import type { KyaStore } from '../src/persistence/repository.js';
import { importStoreWithOptions, validateImportStore } from '../src/persistence/migrate-store.js';
import { assertPublicEcP256Jwk, generateLocalAgentKey } from '../src/crypto/local-agent-key.js';
import { createRequireAgentAuth } from '../src/auth/dpop.js';
import { buildDpopProof } from '../src/crypto/dpop-proof.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { loadConfig } from '../src/config/env.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { applyKycStatus } from '../src/domain/state-machine.js';
import { signChallenge } from '../src/crypto/local-agent-key.js';
import { Hono } from 'hono';
import { DomainError } from '../src/domain/state-machine.js';
import { createMemoryRateLimiter, createSupabaseRateLimiter } from '../src/server/rate-limit.js';
import { createApp } from '../src/server/app.js';
import { DEFAULT_AGENT_API_AUDIENCE } from '../src/auth/agent-access.js';
import { verifyKyaCredential } from '../src/credentials/jws.js';
import { ensureSigningKey, importActivePrivateKey } from '../src/credentials/signer.js';

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

type FakeState = {
  version: number;
  state: KyaStore;
  schemaVersion: string;
  replays: Set<string>;
  rpcError?: boolean;
  casError?: boolean;
  rejectAccessTokenCas?: boolean;
};

function createFakeSupabase(initial?: Partial<FakeState>) {
  const state: FakeState = {
    version: initial?.version ?? 0,
    state: structuredClone(initial?.state ?? emptyStore()),
    schemaVersion: initial?.schemaVersion ?? KYA_SCHEMA_VERSION,
    replays: initial?.replays ?? new Set(),
    rpcError: initial?.rpcError,
    casError: initial?.casError,
    rejectAccessTokenCas: initial?.rejectAccessTokenCas,
  };
  const client = {
    from(table: string) {
      const ctx: { eqKey?: string; eqVal?: unknown } = {};
      const chain = {
        select(_cols?: string) {
          return chain;
        },
        eq(key: string, val: unknown) {
          ctx.eqKey = key;
          ctx.eqVal = val;
          return chain;
        },
        async maybeSingle() {
          if (table === 'kya_schema_meta') {
            if (ctx.eqVal === 'kya_core_version') {
              return { data: { value: state.schemaVersion }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === 'kya_state') {
            return {
              data: { version: state.version, state: structuredClone(state.state) },
              error: null,
            };
          }
          return { data: null, error: { message: 'unknown table' } };
        },
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (state.rpcError || state.casError) {
        return { data: null, error: { message: 'rpc down' } };
      }
      if (name === 'kya_compare_and_swap_state') {
        const expected = Number(args.p_expected_version);
        const nextState = args.p_state as KyaStore;
        if (
          state.rejectAccessTokenCas &&
          (nextState.accessTokens?.length ?? 0) > (state.state.accessTokens?.length ?? 0)
        ) {
          return { data: null, error: { message: 'token CAS rejected' } };
        }
        if (expected !== state.version) {
          return {
            data: [{ ok: false, version: state.version, current_version: state.version }],
            error: null,
          };
        }
        state.version += 1;
        state.state = structuredClone(nextState);
        return {
          data: [{ ok: true, version: state.version, current_version: state.version }],
          error: null,
        };
      }
      if (name === 'kya_consume_dpop_replay') {
        const hash = String(args.p_jti_hash);
        if (state.replays.has(hash)) return { data: false, error: null };
        state.replays.add(hash);
        return { data: true, error: null };
      }
      if (name === 'kya_check_rate_limit') {
        return { data: [{ allowed: true, remaining: 1 }], error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
  };
  return { client: client as never, state };
}

async function boundAgentFixture(repo: InMemoryRepository, config = cfg()) {
  const prepared = await preparedChallengeFixture(repo, config);
  const verified = await prepared.ceremony.verifyChallenge(prepared.started.agentUuid, {
    ...prepared.challenge,
    signature: prepared.signature,
  });
  return { ...prepared, accessToken: verified.access_token! };
}

async function preparedChallengeFixture(repo: InMemoryRepository, config = cfg()) {
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
  return { key, started, principal, challenge, signature, ceremony };
}

describe('SupabaseRepository fake client', () => {
  it('accepts only exact schema version', async () => {
    const stale = createFakeSupabase({ schemaVersion: '20260830_01' });
    expect(await checkSupabaseSchemaReady(stale.client)).toBe(false);
    const ok = createFakeSupabase({ schemaVersion: KYA_SCHEMA_VERSION });
    expect(await checkSupabaseSchemaReady(ok.client)).toBe(true);
  });

  it('loads, CAS success, CAS conflict, and restart', async () => {
    const { client, state } = createFakeSupabase({ version: 1 });
    const backend = createSupabaseCasBackend(client);
    const loaded = await backend.load();
    expect(loaded.version).toBe(1);
    const next = emptyStore();
    next.principals.push({
      id: 'prin_1',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      kycStatus: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const swapped = await backend.compareAndSwap(1, next);
    expect(swapped.ok).toBe(true);
    expect(state.version).toBe(2);
    const conflict = await backend.compareAndSwap(1, next);
    expect(conflict.ok).toBe(false);
    const again = await backend.load();
    expect(again.version).toBe(2);
    expect(again.state.principals[0]?.id).toBe('prin_1');
  });

  it('maps CAS RPC error to UNAVAILABLE without partial mutation', async () => {
    const { client, state } = createFakeSupabase({ version: 0, casError: true });
    const before = state.version;
    const backend = createSupabaseCasBackend(client);
    await expect(backend.compareAndSwap(0, emptyStore())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(state.version).toBe(before);
  });

  it('replay consumed then replay; RPC error -> UNAVAILABLE', async () => {
    const { client } = createFakeSupabase();
    const repo = new SupabaseRepository(client);
    const hash = createHash('sha256').update('jti-1').digest('hex');
    const exp = new Date(Date.now() + 60_000).toISOString();
    expect(await repo.consumeDpopReplayAtomic(hash, exp)).toBe('consumed');
    expect(await repo.consumeDpopReplayAtomic(hash, exp)).toBe('replay');
    const down = createFakeSupabase({ rpcError: true });
    const bad = new SupabaseRepository(down.client);
    await expect(bad.consumeDpopReplayAtomic(hash, exp)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });

  it('importStoreIdempotent no-ops when content matches and CAS once when different', async () => {
    const { client, state } = createFakeSupabase({ version: 3 });
    const repo = new SupabaseRepository(client);
    const store = emptyStore();
    store.principals.push({
      id: 'prin_bootstrap',
      ownerAddress: '0x1111111111111111111111111111111111111111',
      kycStatus: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const first = await repo.importStoreIdempotent(store);
    expect(first.action).toBe('written');
    expect(state.version).toBe(4);
    const second = await repo.importStoreIdempotent(store);
    expect(second.action).toBe('noop');
    expect(state.version).toBe(4);
    store.principals.push({
      id: 'prin_x',
      ownerAddress: '0x2222222222222222222222222222222222222222',
      kycStatus: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const third = await repo.importStoreIdempotent(store);
    expect(third.action).toBe('written');
    expect(state.version).toBe(5);
  });

  it('scrubs private material before CAS serialize', async () => {
    const { client, state } = createFakeSupabase();
    const repo = new SupabaseRepository(client);
    const { publicKey } = await generateKeyPair('ES256');
    const pub = await exportJWK(publicKey);
    const dirty = emptyStore();
    dirty.enrollments.push({
      agentUuid: 'agent_1',
      deviceCodeHash: 'h',
      userCodeHash: 'u',
      pairingExpiresAt: new Date().toISOString(),
      pollIntervalSeconds: 5,
      status: 'awaiting_human',
      publicJwk: { ...pub, d: 'secret' } as JsonWebKey,
      thumbprint: 't',
      keystoreProvider: 'os_hardware',
      agentUriPath: '/x',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await expect(repo.importStoreIdempotent(dirty)).rejects.toThrow();
    expect(JSON.stringify(state.state)).not.toMatch(/"d"\s*:/);
  });
});

describe('migrate-store unit', () => {
  it('dry-run and idempotent import without remote', async () => {
    const { publicKey } = await generateKeyPair('ES256');
    const pub = await exportJWK(publicKey);
    const store = emptyStore();
    store.enrollments.push({
      agentUuid: 'agent_1',
      deviceCodeHash: 'h',
      userCodeHash: 'u',
      pairingExpiresAt: new Date().toISOString(),
      pollIntervalSeconds: 5,
      status: 'awaiting_human',
      publicJwk: pub,
      thumbprint: 't',
      keystoreProvider: 'os_hardware',
      agentUriPath: '/x',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(validateImportStore(store)).toBe(store);
    const dry = await importStoreWithOptions(
      { importStoreIdempotent: async () => ({ action: 'written', version: 1 }) },
      store,
      { dryRun: true },
    );
    expect(dry.action).toBe('dry-run');
    let calls = 0;
    const written = await importStoreWithOptions(
      {
        importStoreIdempotent: async () => {
          calls += 1;
          return { action: 'written', version: 2 };
        },
      },
      store,
    );
    expect(written).toEqual({ action: 'written', version: 2 });
    expect(calls).toBe(1);
    const contaminated: KyaStore = {
      ...store,
      enrollments: [
        {
          ...store.enrollments[0]!,
          publicJwk: { ...pub, d: 'secret-private-material' } as JsonWebKey,
        },
      ],
    };
    expect(() => validateImportStore(contaminated)).toThrow(/Private|Forbidden/i);
  });
});

describe('challenge validation order and token persistence atomicity', () => {
  it('validates nonce bindings and signature before ownerOf and preserves retry on owner failure', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const prepared = await preparedChallengeFixture(repo, config);
    const ownerOf = vi.fn<() => Promise<`0x${string}`>>();
    prepared.ceremony.setOwnerOfReader(ownerOf);

    await expect(
      prepared.ceremony.verifyChallenge(prepared.started.agentUuid, {
        ...prepared.challenge,
        nonce: 'unknown-challenge',
        signature: prepared.signature,
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE' });
    await expect(
      prepared.ceremony.verifyChallenge(prepared.started.agentUuid, {
        ...prepared.challenge,
        signature: 'not-a-valid-p256-signature',
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_SIG' });
    expect(ownerOf).not.toHaveBeenCalled();

    ownerOf.mockRejectedValueOnce(new DomainError('owner RPC down', 'UNAVAILABLE'));
    await expect(
      prepared.ceremony.verifyChallenge(prepared.started.agentUuid, {
        ...prepared.challenge,
        signature: prepared.signature,
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const afterOwnerFailure = await repo.getStore();
    expect(
      afterOwnerFailure.nonces.find((nonce) => nonce.nonce === prepared.challenge.nonce)
        ?.consumedAt,
    ).toBeUndefined();
    expect(afterOwnerFailure.accessTokens).toHaveLength(0);

    ownerOf.mockResolvedValue(prepared.principal.ownerAddress);
    await expect(
      prepared.ceremony.verifyChallenge(prepared.started.agentUuid, {
        ...prepared.challenge,
        signature: prepared.signature,
      }),
    ).resolves.toMatchObject({ ok: true });
    const afterSuccess = await repo.getStore();
    expect(
      afterSuccess.nonces.filter(
        (nonce) => nonce.nonce === prepared.challenge.nonce && nonce.consumedAt,
      ),
    ).toHaveLength(1);
    expect(afterSuccess.accessTokens).toHaveLength(1);
  });

  it('does not burn a valid challenge when the combined nonce/token CAS fails', async () => {
    const setupRepo = new InMemoryRepository();
    const config = cfg();
    const prepared = await preparedChallengeFixture(setupRepo, config);
    const initialState = await setupRepo.getStore();
    expect(initialState.accessTokens).toHaveLength(0);

    const remote = createFakeSupabase({
      version: 7,
      state: initialState,
      rejectAccessTokenCas: true,
    });
    const repo = new SupabaseRepository(remote.client);
    const ceremony = new CeremonyService(repo, config, {
      ownerOfReader: async () => prepared.principal.ownerAddress,
    });
    const response = { ...prepared.challenge, signature: prepared.signature };

    await expect(
      ceremony.verifyChallenge(prepared.started.agentUuid, response),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(
      remote.state.state.nonces.find((nonce) => nonce.nonce === prepared.challenge.nonce)
        ?.consumedAt,
    ).toBeUndefined();
    expect(remote.state.state.accessTokens).toHaveLength(0);

    remote.state.rejectAccessTokenCas = false;
    await expect(
      ceremony.verifyChallenge(prepared.started.agentUuid, response),
    ).resolves.toMatchObject({ ok: true });
    expect(
      remote.state.state.nonces.filter(
        (nonce) => nonce.nonce === prepared.challenge.nonce && nonce.consumedAt,
      ),
    ).toHaveLength(1);
    expect(remote.state.state.accessTokens).toHaveLength(1);

    await expect(
      ceremony.verifyChallenge(prepared.started.agentUuid, response),
    ).rejects.toMatchObject({ code: 'CHALLENGE_REPLAY' });
    expect(remote.state.state.accessTokens).toHaveLength(1);
  });
});

describe('DPoP order and ownerOf fail-closed', () => {
  it('invalid proof does not call ownerOf; unavailable ownerOf -> 503; transfer -> 403', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const { key, accessToken } = await boundAgentFixture(repo, config);
    const ownerOf = vi.fn(async () => '0x2222222222222222222222222222222222222222' as `0x${string}`);
    let handlerRan = false;
    const app = new Hono();
    app.get(
      '/v1/agent/me',
      createRequireAgentAuth(repo, config, { readOwnerOf: ownerOf, requireLiveOwnerOf: true }),
      (c) => {
        handlerRan = true;
        return c.json({ ok: true });
      },
    );

    const badProof = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'POST',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
    });
    const bad = await app.request('http://localhost:8787/v1/agent/me', {
      headers: { Authorization: `DPoP ${accessToken}`, DPoP: badProof },
    });
    expect(bad.status).toBe(401);
    expect(ownerOf).not.toHaveBeenCalled();
    expect(handlerRan).toBe(false);

    ownerOf.mockRejectedValueOnce(new DomainError('rpc down', 'UNAVAILABLE'));
    const goodProof = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
      jti: randomUUID(),
    });
    const unavailable = await app.request('http://localhost:8787/v1/agent/me', {
      headers: { Authorization: `DPoP ${accessToken}`, DPoP: goodProof },
    });
    expect(unavailable.status).toBe(503);
    expect(handlerRan).toBe(false);

    ownerOf.mockResolvedValue('0x9999999999999999999999999999999999999999');
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
    expect(handlerRan).toBe(false);
  });

  it('checks ownerOf before consuming replay and leaves a proof retryable while ownerOf is down', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const { key, accessToken } = await boundAgentFixture(repo, config);
    const order: string[] = [];
    const consume = repo.consumeDpopReplayAtomic.bind(repo);
    repo.consumeDpopReplayAtomic = async (hash, expiresAt) => {
      order.push('replay');
      return consume(hash, expiresAt);
    };
    let ownerAvailable = false;
    const app = new Hono();
    app.get(
      '/v1/agent/me',
      createRequireAgentAuth(repo, config, {
        requireLiveOwnerOf: true,
        readOwnerOf: async () => {
          order.push('ownerOf');
          if (!ownerAvailable) throw new DomainError('owner RPC down', 'UNAVAILABLE');
          return '0x2222222222222222222222222222222222222222';
        },
      }),
      (c) => c.json({ ok: true }),
    );
    const proof = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken,
      jti: randomUUID(),
    });
    const request = () =>
      app.request('http://localhost:8787/v1/agent/me', {
        headers: { Authorization: `DPoP ${accessToken}`, DPoP: proof },
      });

    expect((await request()).status).toBe(503);
    expect(order).toEqual(['ownerOf']);

    ownerAvailable = true;
    expect((await request()).status).toBe(200);
    expect(order).toEqual(['ownerOf', 'ownerOf', 'replay']);
    expect((await request()).status).toBe(401);
    expect(order).toEqual(['ownerOf', 'ownerOf', 'replay', 'ownerOf', 'replay']);
  });
});

describe('credential claim binding', () => {
  it('rejects correctly signed credential with claim/record mismatches', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const key = await ensureSigningKey(repo, config);
    const privateKey = await importActivePrivateKey(key);
    const { publicKey } = await generateKeyPair('ES256');
    const pub = await exportJWK(publicKey);
    await repo.withLock(async (s) => {
      s.credentials.push({
        id: 'cred_1',
        agentUuid: 'agent_a',
        principalId: 'prin_a',
        thumbprint: 'jkt-a',
        agentRegistry: 'eip155:84532:0x1',
        agentId: '1',
        owner: '0x1111111111111111111111111111111111111111',
        status: 'active',
        statusRef: 'http://localhost/status/cred_1',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        jti: 'cred_1',
      });
    });
    const good = await new SignJWT({
      principal_id: 'prin_a',
      agentRegistry: 'eip155:84532:0x1',
      agentId: '1',
      owner: '0x1111111111111111111111111111111111111111',
      status: 'active',
      status_ref: 'http://localhost/status/cred_1',
      cnf: { jkt: 'jkt-a' },
    })
      .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'KYA-CREDENTIAL+JWT' })
      .setIssuer(config.KYA_ISSUER)
      .setAudience(config.KYA_AUDIENCE)
      .setSubject('agent_a')
      .setJti('cred_1')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyKyaCredential(repo, config, good)).resolves.toBeTruthy();

    const wrongSub = await new SignJWT({
      principal_id: 'prin_a',
      agentRegistry: 'eip155:84532:0x1',
      agentId: '1',
      owner: '0x1111111111111111111111111111111111111111',
      status: 'active',
      status_ref: 'http://localhost/status/cred_1',
      cnf: { jkt: 'jkt-a' },
    })
      .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: 'KYA-CREDENTIAL+JWT' })
      .setIssuer(config.KYA_ISSUER)
      .setAudience(config.KYA_AUDIENCE)
      .setSubject('agent_other')
      .setJti('cred_1')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(verifyKyaCredential(repo, config, wrongSub)).rejects.toMatchObject({
      code: 'JWT_STATUS',
    });
    void pub;
  });
});

describe('rate limit durable + body cap', () => {
  it('Supabase rate limiter maps RPC failure to UNAVAILABLE', async () => {
    const limiter = createSupabaseRateLimiter(async () => ({ data: null, error: { message: 'down' } }), {
      limit: 1,
      windowMs: 1000,
    });
    await expect(limiter.check('k')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('live mode without durable limiter returns 503 on public routes', async () => {
    const repo = new InMemoryRepository();
    const config = cfg({
      KYA_MODE: 'live',
      PERSISTENCE_BACKEND: 'supabase',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-role-not-real',
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      DIDIT_API_KEY: 'k',
      DIDIT_WORKFLOW_ID: 'w',
      DIDIT_WEBHOOK_SECRET: 's',
      KYA_SIGNING_PRIVATE_JWK: JSON.stringify({
        kty: 'EC',
        crv: 'P-256',
        x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
        y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
        d: '0_HIxo-o-ZevHFzjmgWRLVTFJbMZtF-nT0uDh_H5YJY',
      }),
    });
    const callerControlledLie = {
      publicRateLimiter: {
        ...createMemoryRateLimiter({ limit: 10, windowMs: 60_000 }),
        durable: true,
      },
      durablePublicRateLimiter: true,
    };
    const { app } = createApp(repo, config, callerControlledLie);
    const key = await generateLocalAgentKey();
    const res = await app.request('/v1/device-enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicJwk: key.publicJwk }),
    });
    expect(res.status).toBe(503);
  });

  it('rejects oversized JSON body with 413', async () => {
    const repo = new InMemoryRepository();
    const { app } = createApp(repo, cfg());
    const big = 'x'.repeat(40_000);
    const res = await app.request('/v1/device-enrollments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"publicJwk":{"kty":"EC","pad":"${big}"}}`,
    });
    expect(res.status).toBe(413);
  });
});

describe('KYC ownership and callback authority', () => {
  it('rejects cross-principal KYC status reads; callback does not mutate', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const ceremony = new CeremonyService(repo, config);
    const a = await ceremony.findOrCreatePrincipal(
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    const b = await ceremony.findOrCreatePrincipal(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const started = await ceremony.startKyc(a.ownerAddress);
    await expect(
      ceremony.getKycSessionStatus(started.sessionId, b.id),
    ).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|UNAUTHORIZED|NOT_FOUND/i) });
    const before = await repo.getStore();
    const sessionBefore = before.kycSessions.find(
      (s) => s.id === started.sessionId || s.providerSessionId === started.sessionId,
    );
    expect(sessionBefore).toBeTruthy();
    const loc = await ceremony.resolveKycNavigationCallback(
      sessionBefore!.providerSessionId,
    );
    expect(loc).toMatch(/^http/);
    const after = await repo.getStore();
    const sessionAfter = after.kycSessions.find((s) => s.id === sessionBefore!.id);
    expect(sessionAfter?.status).toBe(sessionBefore?.status);
    expect(sessionAfter?.updatedAt).toBe(sessionBefore?.updatedAt);
  });
});

describe('JWK 32-byte coordinates', () => {
  it('rejects short coords and accepts real P-256 public JWK', async () => {
    expect(() =>
      assertPublicEcP256Jwk({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' }),
    ).toThrow(/32|coordinate/i);
    const { publicKey } = await generateKeyPair('ES256');
    const good = await exportJWK(publicKey);
    expect(() => assertPublicEcP256Jwk(good)).not.toThrow();
  });
});

describe('device enrollment private member class', () => {
  it('classifies all private JWK members as PII_FORBIDDEN', async () => {
    const ceremony = new CeremonyService(new InMemoryRepository(), cfg());
    const { publicKey } = await generateKeyPair('ES256');
    const pub = await exportJWK(publicKey);
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const) {
      await expect(
        ceremony.startDeviceEnrollment({
          publicJwk: { ...pub, [field]: field === 'oth' ? [] : 'x' } as JsonWebKey,
        }),
      ).rejects.toMatchObject({ code: 'PII_FORBIDDEN' });
    }
    await expect(
      ceremony.startDeviceEnrollment({
        publicJwk: { ...pub, n: 'rsa-n' } as JsonWebKey,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
  });

  it('rejects off-curve and private JWKs during bound-agent rotation without mutation', async () => {
    const repo = new InMemoryRepository();
    const config = cfg();
    const { started, principal, ceremony } = await boundAgentFixture(repo, config);
    const before = await repo.getStore();
    const beforeEnrollment = before.enrollments.find(
      (item) => item.agentUuid === started.agentUuid,
    )!;
    const zero = Buffer.alloc(32).toString('base64url');
    const offCurve = {
      kty: 'EC',
      crv: 'P-256',
      x: zero,
      y: zero,
    } as JsonWebKey;

    await expect(
      ceremony.rotateKey(
        started.agentUuid,
        principal.ownerAddress,
        offCurve,
        'os_hardware',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    await expect(
      ceremony.rotateKey(
        started.agentUuid,
        principal.ownerAddress,
        { ...beforeEnrollment.publicJwk, d: 'private' },
        'os_hardware',
      ),
    ).rejects.toMatchObject({ code: 'PII_FORBIDDEN' });

    const after = await repo.getStore();
    const afterEnrollment = after.enrollments.find(
      (item) => item.agentUuid === started.agentUuid,
    )!;
    expect(afterEnrollment.publicJwk).toEqual(beforeEnrollment.publicJwk);
    expect(afterEnrollment.thumbprint).toBe(beforeEnrollment.thumbprint);
    expect(afterEnrollment.status).toBe(beforeEnrollment.status);
  });
});
