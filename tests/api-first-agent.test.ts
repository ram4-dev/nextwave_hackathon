import { describe, expect, it } from 'vitest';
import { generateKeyPair, exportJWK } from 'jose';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { createApp } from '../src/server/app.js';
import { hashOpaqueCode } from '../src/crypto/codes.js';
import { issueHumanSession } from '../src/auth/session.js';
import { buildDpopProof, computeAth } from '../src/crypto/dpop-proof.js';
import { generateLocalAgentKey, signChallenge } from '../src/crypto/local-agent-key.js';
import { applyKycStatus } from '../src/domain/state-machine.js';

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    FRONTEND_ORIGIN: 'http://localhost:5173',
    PERSISTENCE_BACKEND: 'memory',
  });
}

async function publicJwk() {
  const { publicKey } = await generateKeyPair('ES256');
  return exportJWK(publicKey);
}

describe('device enrollment API', () => {
  it('rejects private JWK and stores only hashes', async () => {
    const repo = new InMemoryRepository();
    const ceremony = new CeremonyService(repo, config());
    const jwk = await publicJwk();
    await expect(
      ceremony.startDeviceEnrollment({
        publicJwk: { ...jwk, d: 'not-a-real-d' } as JsonWebKey,
      }),
    ).rejects.toMatchObject({ code: 'PII_FORBIDDEN' });

    const started = await ceremony.startDeviceEnrollment({ publicJwk: jwk });
    const store = await repo.getStore();
    const e = store.enrollments[0]!;
    expect(e.deviceCodeHash).toBe(hashOpaqueCode(started.device_code));
    expect(e.userCodeHash).toBe(hashOpaqueCode(started.user_code));
    expect(JSON.stringify(store)).not.toContain(started.device_code);
    expect(JSON.stringify(store)).not.toContain(started.user_code);
  });

  it('claims with thumbprint and delivers credential once', async () => {
    const repo = new InMemoryRepository();
    const cfg = config();
    const ceremony = new CeremonyService(repo, cfg);
    const key = await generateLocalAgentKey();
    const started = await ceremony.startDeviceEnrollment({
      publicJwk: key.publicJwk,
      keystoreProvider: key.keystoreProvider,
    });

    const principal = await ceremony.findOrCreatePrincipal(
      '0x1111111111111111111111111111111111111111',
    );
    await repo.withLock(async (s) => {
      const p = s.principals.find((x) => x.id === principal.id)!;
      Object.assign(
        p,
        applyKycStatus(p, 'verified', {
          provider: 'demo',
          sessionRef: 's1',
          assuranceLevel: 'high',
          ttlDays: 365,
        }),
      );
    });

    const claimed = await ceremony.claimDeviceEnrollment(
      started.user_code,
      principal.id,
      started.thumbprint,
    );
    expect(claimed.enrollment.claimedAt).toBeTruthy();

    await ceremony.approveFingerprint(
      started.agentUuid,
      principal.ownerAddress,
      started.thumbprint,
    );
    await ceremony.confirmDemoRegistration(started.agentUuid, principal.ownerAddress);

    const first = await ceremony.pollDeviceEnrollmentToken(started.device_code);
    expect(first.status).toBe('complete');
    expect(first.credential).toBeTruthy();
    const second = await ceremony.pollDeviceEnrollmentToken(started.device_code);
    expect(second.status).toBe('complete');
    expect(second.credential).toBeUndefined();
  });

  it('returns slow_down when polling too fast', async () => {
    const repo = new InMemoryRepository();
    const ceremony = new CeremonyService(repo, config());
    const jwk = await publicJwk();
    const started = await ceremony.startDeviceEnrollment({ publicJwk: jwk });
    const a = await ceremony.pollDeviceEnrollmentToken(started.device_code);
    expect(a.status).toBe('pending');
    const b = await ceremony.pollDeviceEnrollmentToken(started.device_code);
    expect(b.status).toBe('slow_down');
  });
});

describe('agent access + DPoP', () => {
  it('issues distinct access typ and rejects Bearer on /v1/agent/me', async () => {
    const repo = new InMemoryRepository();
    const cfg = config();
    const ceremony = new CeremonyService(repo, cfg);
    const { app } = createApp(repo, cfg);
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
    await ceremony.approveFingerprint(
      started.agentUuid,
      principal.ownerAddress,
      started.thumbprint,
    );
    await ceremony.confirmDemoRegistration(started.agentUuid, principal.ownerAddress);

    const challenge = await ceremony.createChallenge(started.agentUuid, {
      action: 'authenticate',
    });
    const signature = await signChallenge(key.privateKey, challenge);
    const verified = await ceremony.verifyChallenge(started.agentUuid, {
      ...challenge,
      signature,
    });
    expect(verified.access_token).toBeTruthy();
    const [headerB64] = verified.access_token!.split('.');
    const header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'));
    expect(header.typ).toBe('KYA-AGENT-ACCESS+JWT');

    const bearer = await app.request('/v1/agent/me', {
      headers: { Authorization: `Bearer ${verified.access_token}` },
    });
    expect(bearer.status).toBe(401);

    const proof = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken: verified.access_token!,
    });
    const ok = await app.request('/v1/agent/me', {
      headers: {
        Authorization: `DPoP ${verified.access_token}`,
        DPoP: proof,
      },
    });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.agentUuid).toBe(started.agentUuid);
    expect(body).not.toHaveProperty('principalId');

    const replay = await app.request('/v1/agent/me', {
      headers: {
        Authorization: `DPoP ${verified.access_token}`,
        DPoP: proof,
      },
    });
    expect(replay.status).toBe(401);

    const wrongMethod = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'POST',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken: verified.access_token!,
    });
    const badMethod = await app.request('/v1/agent/me', {
      headers: {
        Authorization: `DPoP ${verified.access_token}`,
        DPoP: wrongMethod,
      },
    });
    expect(badMethod.status).toBe(401);

    const wrongAth = await buildDpopProof(key.privateKey, key.publicJwk, {
      htm: 'GET',
      htu: 'http://localhost:8787/v1/agent/me',
      accessToken: 'not-the-token',
    });
    // ath binds to wrong token string while Authorization carries real token
    const badAth = await app.request('/v1/agent/me', {
      headers: {
        Authorization: `DPoP ${verified.access_token}`,
        DPoP: wrongAth,
      },
    });
    expect(badAth.status).toBe(401);
    expect(computeAth(verified.access_token!)).not.toBe(computeAth('not-the-token'));
  });

  it('ready is liveness-separate and health stays simple', async () => {
    const repo = new InMemoryRepository();
    const { app } = createApp(repo, config());
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const ready = await app.request('/ready');
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body.ready).toBe(true);
    expect(body.persistence).toBe('memory');
  });

  it('permits pairing only through user_code claim and exposes no legacy attach authority', async () => {
    const repo = new InMemoryRepository();
    const cfg = config();
    const { app, ceremony } = createApp(repo, cfg);
    const jwk = await publicJwk();
    const started = await ceremony.startDeviceEnrollment({ publicJwk: jwk });
    const principal = await ceremony.findOrCreatePrincipal(
      '0x3333333333333333333333333333333333333333',
    );
    const token = await issueHumanSession(repo, cfg, principal);
    const attach = await app.request(`/v1/enrollments/${started.agentUuid}/attach`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(attach.status).toBe(404);
    const beforeClaim = (await repo.getStore()).enrollments.find(
      (enrollment) => enrollment.agentUuid === started.agentUuid,
    )!;
    expect(beforeClaim.principalId).toBeUndefined();
    expect(beforeClaim.claimedAt).toBeUndefined();
    expect(beforeClaim.status).toBe('awaiting_human');

    const res = await app.request('/v1/device-enrollments/claim', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        user_code: started.user_code,
        thumbprint: started.thumbprint,
      }),
    });
    expect(res.status).toBe(200);
    const claimed = (await repo.getStore()).enrollments.find(
      (enrollment) => enrollment.agentUuid === started.agentUuid,
    )!;
    expect(claimed.principalId).toBe(principal.id);
    expect(claimed.claimedAt).toBeTruthy();
  });
});
