import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
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
import { needsKyc } from '../src/domain/state-machine.js';
import { SignJWT, generateKeyPair } from 'jose';

/** Curated Base Sepolia Identity Registry — display-only reference used across tests. */
const MOCK_REGISTRY = 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e';

function testConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    KYA_AUDIENCE: 'kya-agent',
    ...overrides,
  });
}

/**
 * Runs the full ceremony (fresh extractable key → bound agent) and returns the
 * bind result plus the matching CryptoKeyPair so callers can sign challenges.
 */
async function runCeremony(
  ceremony: CeremonyService,
  owner: `0x${string}`,
): Promise<{
  agentUuid: string;
  thumbprint: string;
  token: string;
  agentId: string;
  agentRegistry: string;
  keyPair: CryptoKeyPair;
}> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  const started = await ceremony.startEnrollment({
    publicJwk,
    keystoreProvider: 'encrypted_os_keystore',
  });
  await ceremony.attachHuman(started.agentUuid, owner);
  await ceremony.completeKyc(owner);
  await ceremony.attachHuman(started.agentUuid, owner);
  await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
  const bound = await ceremony.bindAgent(started.agentUuid, owner);
  return { agentUuid: started.agentUuid, thumbprint: started.thumbprint, ...bound, keyPair };
}

describe('configuration parsing', () => {
  it('treats blank YUNO_BASE_URL as unset and coerces MANDATE_MAX_AMOUNT', () => {
    const config = testConfig({ YUNO_BASE_URL: '', MANDATE_MAX_AMOUNT: '250' });
    expect(config.YUNO_BASE_URL).toBeUndefined();
    expect(config.MANDATE_MAX_AMOUNT).toBe(250);
    expect(config.paymentsConfigured).toBe(false);
  });

  it('accepts legacy YUNO_MOCK_URL as YUNO_BASE_URL alias', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      KYA_AUDIENCE: 'kya-agent',
      YUNO_MOCK_URL: 'http://127.0.0.1:8080',
    });
    expect(config.YUNO_BASE_URL).toBe('http://127.0.0.1:8080');
  });
});

describe('crypto + challenges', () => {
  it('generates public thumbprint without private material and verifies challenge', async () => {
    const key = await generateLocalAgentKey();
    assertNoPrivateKeyMaterial({ publicJwk: key.publicJwk, thumbprint: key.thumbprint });
    expect(key.publicJwk.d).toBeUndefined();
    const tp = await thumbprintFromJwk(key.publicJwk);
    expect(tp).toBe(key.thumbprint);

    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const owner = '0x1111111111111111111111111111111111111111' as const;
    const { agentUuid, keyPair } = await runCeremony(ceremony, owner);

    const challenge = await ceremony.createChallenge(agentUuid, { action: 'ping' });
    const signature = await signChallenge(keyPair.privateKey, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: challenge.intent_hash,
    });
    const ok = await ceremony.verifyChallenge(agentUuid, {
      nonce: challenge.nonce,
      audience: challenge.audience,
      timestamp: challenge.timestamp,
      intent_hash: challenge.intent_hash,
      signature,
    });
    expect(ok.ok).toBe(true);

    await expect(
      ceremony.verifyChallenge(agentUuid, {
        nonce: challenge.nonce,
        audience: challenge.audience,
        timestamp: challenge.timestamp,
        intent_hash: challenge.intent_hash,
        signature,
      }),
    ).rejects.toThrow(/replay/i);
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
    await ceremony.completeKyc(owner);
    await ceremony.attachHuman(started.agentUuid, owner);
    await ceremony.approveFingerprint(started.agentUuid, owner, started.thumbprint);
    await ceremony.bindAgent(started.agentUuid, owner);

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

describe('credentials no-PII', () => {
  it('issues and verifies JWS; rejects alg confusion, wrong iss/aud, expired, revoked', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig({ CREDENTIAL_TTL_SECONDS: '2' });
    await ensureSigningKey(repo);
    const { token, record } = await issueKyaCredential(repo, config, {
      agentUuid: 'agent_1',
      principalId: 'prin_1',
      thumbprint: 'thumb',
      agentRegistry: MOCK_REGISTRY,
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

describe('enrollment transitions', () => {
  it('lets one verified Principal authorize multiple agents without re-KYC', async () => {
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
      return ceremony.startEnrollment({
        publicJwk,
        keystoreProvider: 'encrypted_os_keystore',
      });
    }

    const a1 = await enrollOne();
    const a2 = await enrollOne();
    await ceremony.attachHuman(a1.agentUuid, owner);
    await ceremony.completeKyc(owner);

    // Second attach should skip KYC — Principal already verified.
    const attach2 = await ceremony.attachHuman(a2.agentUuid, owner);
    expect(attach2.needsKyc).toBe(false);
    expect(needsKyc(attach2.principal)).toBe(false);

    await ceremony.approveFingerprint(a1.agentUuid, owner, a1.thumbprint);
    const bound = await ceremony.bindAgent(a1.agentUuid, owner);
    expect(bound.agentId).toBeTruthy();
    expect(bound.agentRegistry).toContain('eip155:84532:');
  });

  it('rejects binding before fingerprint approval', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const owner = '0x6666666666666666666666666666666666666666' as const;
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
    await expect(ceremony.bindAgent(started.agentUuid, owner)).rejects.toThrow(
      /not ready to bind/i,
    );
  });
});

describe('end-to-end demo ceremony', () => {
  it('completes the full mocked happy path and issues a verifiable credential', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const owner = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const;

    const { thumbprint, token, agentId, agentRegistry } = await runCeremony(ceremony, owner);
    expect(agentId).toBeTruthy();
    const claims = await verifyKyaCredential(repo, config, token);
    expect(claims.cnf.jkt).toBe(thumbprint);
    expect(agentRegistry).toContain('eip155:84532:');
  });
});

describe('platform signing key persistence', () => {
  it('store.json / repository snapshots never contain private JWK fields or raw tokens', async () => {
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

    await ensureSigningKey(repo);
    const { token } = await runCeremony(ceremony, owner);

    const store = await repo.getStore();
    expect(() => assertStoreHasNoPrivateKeyMaterial(store)).not.toThrow();
    for (const sk of store.signingKeys) {
      expect(sk).not.toHaveProperty('privateJwk');
      expect(sk.publicJwk.d).toBeUndefined();
      expect((sk.publicJwk as Record<string, unknown>).p).toBeUndefined();
      expect((sk.publicJwk as Record<string, unknown>).q).toBeUndefined();
    }
    const snapshot = JSON.stringify(store);
    expect(snapshot).not.toContain(token);
    expect(snapshot).not.toMatch(/"privateJwk"/);
    expect(snapshot).not.toMatch(/"d"\s*:/);
    expect(snapshot).not.toMatch(/"dp"\s*:|"dq"\s*:|"qi"\s*:/);

    const onDisk = await readFile(filePath, 'utf8');
    expect(onDisk).not.toMatch(/"privateJwk"/);
    expect(onDisk).not.toMatch(/"d"\s*:/);
    expect(onDisk).not.toMatch(/"dp"\s*:|"dq"\s*:|"qi"\s*:/);
    expect(onDisk).not.toContain(token);
    expect(onDisk).not.toMatch(/-----BEGIN/);

    const jwks = await getJwks(repo);
    for (const k of jwks.keys) {
      expect(k.d).toBeUndefined();
      expect((k as Record<string, unknown>).privateJwk).toBeUndefined();
    }
  });
});

describe('signing key identity and duplicate-kid recovery', () => {
  it('verifies a session against the matching public key when legacy records share a kid', async () => {
    const { exportJWK, generateKeyPair: genKeyPair, SignJWT: SignJwtCtor } = await import('jose');
    const { verifySessionToken } = await import('../src/auth/session.js');
    const { getJwks } = await import('../src/credentials/jws.js');
    const oldPair = await genKeyPair('ES256', { extractable: true });
    const currentPair = await genKeyPair('ES256', { extractable: true });
    const oldPublic = await exportJWK(oldPair.publicKey);
    const currentPublic = await exportJWK(currentPair.publicKey);
    const repo = new InMemoryRepository();
    const kid = 'legacy-duplicate-kid';
    await repo.withLock(async (store) => {
      store.signingKeys.push(
        {
          kid,
          publicJwk: oldPublic,
          createdAt: '2026-08-28T00:00:00.000Z',
          active: false,
        },
        {
          kid,
          publicJwk: currentPublic,
          createdAt: '2026-08-29T00:00:00.000Z',
          active: true,
        },
      );
    });
    const config = testConfig();
    const address = '0x1111111111111111111111111111111111111111' as const;
    const token = await new SignJwtCtor({ sub: address, typ: 'kya_session' })
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setIssuer(config.KYA_ISSUER)
      .setAudience('kya-session')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(currentPair.privateKey);

    await expect(verifySessionToken(repo, config, token)).resolves.toBe(address);
    const jwks = await getJwks(repo);
    expect(
      jwks.keys.filter(
        (key) => (key as JsonWebKey & { kid?: string }).kid === kid,
      ),
    ).toHaveLength(1);
  });
});

describe('enrollment auth + public resolve', () => {
  it('hides enrollment detail without session; resolve has no PII', async () => {
    const repo = new InMemoryRepository();
    const config = testConfig();
    const ceremony = new CeremonyService(repo, config);
    const { createApp } = await import('../src/server/app.js');
    const { issueSessionToken } = await import('../src/auth/session.js');
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
      e.agentRegistry = MOCK_REGISTRY;
      e.status = 'bound';
      e.owner = owner;
    });
    const resolved = await ceremony.resolvePublic({
      agentRegistry: MOCK_REGISTRY,
      agentId: '42',
    });
    expect(resolved).not.toHaveProperty('principalId');
    expect(resolved).not.toHaveProperty('deviceCode');
    expect(JSON.stringify(resolved)).not.toMatch(/prin_|deviceCode/i);
  });
});
