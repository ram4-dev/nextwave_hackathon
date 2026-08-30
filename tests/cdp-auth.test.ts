import { describe, expect, it } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import {
  CdpIdentityError,
  bindCdpIdentity,
  createCdpIdentityVerifier,
  normalizeCdpEndUser,
  type CdpEndUserAccount,
  type CdpIdentity,
} from '../src/auth/cdp.js';
import {
  HUMAN_SESSION_TYP,
  issueHumanSession,
  verifyHumanSession,
} from '../src/auth/session.js';
import { createApp } from '../src/server/app.js';

const SMART = '0x1111111111111111111111111111111111111111' as const;
const OTHER_SMART = '0x2222222222222222222222222222222222222222' as const;

function config() {
  return loadConfig({
    NODE_ENV: 'test', KYA_MODE: 'demo', PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787', KYA_AUDIENCE: 'kya-agent',
  });
}

function identity(overrides: Partial<CdpIdentity> = {}): CdpIdentity {
  return {
    userId: 'cdp-user-1', emailAuthenticated: true, smartAccountAddress: SMART,
    ownerAddresses: ['0x3333333333333333333333333333333333333333'], ...overrides,
  };
}

describe('CDP identity binding', () => {
  it('creates one pseudonymous principal and reuses it on a repeated exchange', async () => {
    const repo = new InMemoryRepository();
    const first = await bindCdpIdentity(repo, identity());
    const second = await bindCdpIdentity(repo, identity());
    expect(second.id).toBe(first.id);
    expect(second.ownerAddress).toBe(SMART);
    expect((await repo.getStore()).principals).toHaveLength(1);
  });

  it('fails closed for unverified email, ambiguous wallet and conflicting binding', async () => {
    const repo = new InMemoryRepository();
    await expect(bindCdpIdentity(repo, identity({ emailAuthenticated: false }))).rejects.toMatchObject({ code: 'CDP_EMAIL' });
    await expect(bindCdpIdentity(repo, identity({ smartAccountAddress: undefined }))).rejects.toMatchObject({ code: 'CDP_ACCOUNT' });
    await bindCdpIdentity(repo, identity());
    await expect(bindCdpIdentity(repo, identity({ smartAccountAddress: OTHER_SMART }))).rejects.toBeInstanceOf(CdpIdentityError);
  });

  it('persists only the pseudonymous CDP user ID and public Smart Account binding', async () => {
    const repo = new InMemoryRepository();
    await bindCdpIdentity(repo, identity({ userId: 'opaque-cdp-user' }));
    const serialized = JSON.stringify(await repo.getStore());
    expect(serialized).toContain('opaque-cdp-user');
    expect(serialized).not.toMatch(
      /"accessToken"|otp|email@example|temporary.?wallet.?secret/i,
    );
  });

  it('requires explicit reconciliation instead of attaching a CDP user to a wallet-only Principal', async () => {
    const repo = new InMemoryRepository();
    await repo.withLock((store) => store.principals.push({ id: 'legacy', ownerAddress: SMART, kycStatus: 'verified', createdAt: '', updatedAt: '' }));
    await expect(bindCdpIdentity(repo, identity())).rejects.toMatchObject({ code: 'CDP_RECONCILIATION_REQUIRED' });
    expect((await repo.getStore()).principals[0]!.cdpUserId).toBeUndefined();
  });

  it('normalizes the installed SDK EndUser smart-account ownerAddresses shape', () => {
    const result = normalizeCdpEndUser({
      userId: 'cdp-user-1',
      authenticationMethods: [{ type: 'email', email: 'person@example.com' }],
      evmSmartAccountObjects: [{ address: SMART, ownerAddresses: ['0x3333333333333333333333333333333333333333'], createdAt: '2026-01-01T00:00:00.000Z' }],
    });
    expect(result).toEqual(identity());
  });
});

describe('official CDP verifier boundary', () => {
  it('validates the SDK EndUserAccount ownerAddresses contract through the injected production adapter', async () => {
    const validateAccessToken = async ({ accessToken }: { accessToken: string }) => {
      expect(accessToken).toBe('valid-access-token');
      return {
        userId: 'sdk-user',
        authenticationMethods: [{ type: 'email', email: 'person@example.com' }],
        evmSmartAccountObjects: [{ address: SMART, ownerAddresses: ['0x3333333333333333333333333333333333333333'], createdAt: '2026-08-30T00:00:00.000Z' }],
      } satisfies CdpEndUserAccount;
    };
    const verifier = await createCdpIdentityVerifier({ endUser: { validateAccessToken } });
    await expect(verifier.validate('valid-access-token')).resolves.toEqual({ userId: 'sdk-user', emailAuthenticated: true, smartAccountAddress: SMART, ownerAddresses: ['0x3333333333333333333333333333333333333333'] });
  });

  it('normalizes invalid, expired, and wrong-project validation failures without binding a Principal', async () => {
    for (const error of [{ status: 401 }, { status: 403 }, { statusCode: 401 }]) {
      const verifier = await createCdpIdentityVerifier({ endUser: { validateAccessToken: async () => { throw error; } } });
      const repo = new InMemoryRepository();
      const { app } = createApp(repo, config(), { cdpVerifier: verifier });
      const response = await app.request('/v1/auth/cdp/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'bad-token' }) });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Authentication failed', code: 'CDP_INVALID' });
      expect((await repo.getStore()).principals).toHaveLength(0);
    }
    const unavailable = await createCdpIdentityVerifier({ endUser: { validateAccessToken: async () => { throw new Error('network unavailable'); } } });
    await expect(unavailable.validate('expired-token')).rejects.toMatchObject({ code: 'CDP_UNAVAILABLE' });
  });
});

describe('KYA human session', () => {
  it('issues an ES256 principal-bound session and verifies its exact wallet', async () => {
    const repo = new InMemoryRepository();
    const principal = await bindCdpIdentity(repo, identity());
    const token = await issueHumanSession(repo, config(), principal);
    const { decodeProtectedHeader } = await import('jose');
    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: 'ES256',
      typ: HUMAN_SESSION_TYP,
    });
    await expect(verifyHumanSession(repo, config(), token)).resolves.toMatchObject({ principalId: principal.id, wallet: SMART });
  });

  it('rejects a forged algorithm, unrelated audience, and missing/wrong session type', async () => {
    const repo = new InMemoryRepository();
    const principal = await bindCdpIdentity(repo, identity());
    const token = await issueHumanSession(repo, config(), principal);
    await expect(verifyHumanSession(repo, config(), token.replace(/^ey[^.]+/, 'eyJhbGciOiJub25lIn0'))).rejects.toMatchObject({ code: 'JWT_ALG' });
    const { SignJWT } = await import('jose');
    const { ensureSigningKey, importActivePrivateKey } = await import('../src/credentials/signer.js');
    const key = await ensureSigningKey(repo, config());
    const wrongType = await new SignJWT({ wallet: SMART, typ: 'other' }).setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: HUMAN_SESSION_TYP }).setIssuer(config().KYA_ISSUER).setAudience('kya-human-session').setSubject(principal.id).setExpirationTime('5m').sign(await importActivePrivateKey(key));
    const missingType = await new SignJWT({ wallet: SMART }).setProtectedHeader({ alg: 'ES256', kid: key.kid, typ: HUMAN_SESSION_TYP }).setIssuer(config().KYA_ISSUER).setAudience('kya-human-session').setSubject(principal.id).setExpirationTime('5m').sign(await importActivePrivateKey(key));
    await expect(verifyHumanSession(repo, config(), wrongType)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(verifyHumanSession(repo, config(), missingType)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects signed token-confusion attempts with a generic or foreign protected typ', async () => {
    const repo = new InMemoryRepository();
    const principal = await bindCdpIdentity(repo, identity());
    const { SignJWT } = await import('jose');
    const { ensureSigningKey, importActivePrivateKey } = await import('../src/credentials/signer.js');
    const key = await ensureSigningKey(repo, config());
    const privateKey = await importActivePrivateKey(key);
    const signAs = (typ: string) =>
      new SignJWT({ wallet: SMART, typ: 'kya_session' })
        .setProtectedHeader({ alg: 'ES256', kid: key.kid, typ })
        .setIssuer(config().KYA_ISSUER)
        .setAudience('kya-human-session')
        .setSubject(principal.id)
        .setExpirationTime('5m')
        .sign(privateKey);

    for (const protectedTyp of ['JWT', 'KYA-CREDENTIAL+JWT', 'KYA-AGENT-ACCESS+JWT']) {
      await expect(
        verifyHumanSession(repo, config(), await signAs(protectedTyp)),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('rejects a still-signed session when its persisted Smart Account binding changes', async () => {
    const repo = new InMemoryRepository();
    const principal = await bindCdpIdentity(repo, identity());
    const token = await issueHumanSession(repo, config(), principal);
    await repo.withLock((store) => { store.principals.find((item) => item.id === principal.id)!.ownerAddress = OTHER_SMART; });
    await expect(verifyHumanSession(repo, config(), token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('CDP exchange HTTP boundary', () => {
  it('exchanges a validated CDP token and does not expose legacy SIWE routes', async () => {
    const repo = new InMemoryRepository();
    const { app } = createApp(repo, config(), { cdpVerifier: { validate: async () => identity() } });
    const exchange = await app.request('/v1/auth/cdp/exchange', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: JSON.stringify({ accessToken: 'opaque-token' }) });
    expect(exchange.status).toBe(200);
    expect(await exchange.json()).toMatchObject({ wallet: SMART });
    expect((await app.request('/v1/auth/nonce')).status).toBe(404);
  });

  it('normalizes an unavailable CDP dependency without creating a principal', async () => {
    const repo = new InMemoryRepository();
    const { app } = createApp(repo, config(), { cdpVerifier: { validate: async () => { throw new CdpIdentityError('provider internals', 'CDP_UNAVAILABLE'); } } });
    const response = await app.request('/v1/auth/cdp/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: 'opaque-token' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Authentication provider unavailable', code: 'CDP_UNAVAILABLE' });
    expect((await repo.getStore()).principals).toHaveLength(0);
  });

  it('allows only the configured frontend origin in CORS responses', async () => {
    const repo = new InMemoryRepository();
    const { app } = createApp(repo, config(), { cdpVerifier: { validate: async () => identity() } });
    const allowed = await app.request('/health', { headers: { origin: 'http://localhost:5173' } });
    const denied = await app.request('/health', { headers: { origin: 'https://evil.example' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(denied.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });
});

describe('removed wallet-auth runtime boundary', () => {
  it('contains no legacy auth routes, BrowserWallet connector, or SIWE runtime import', async () => {
    const runtimeSources = await Promise.all([
      readFile(new URL('../src/server/app.ts', import.meta.url), 'utf8'),
      readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8'),
      readFile(new URL('../web/src/main.tsx', import.meta.url), 'utf8'),
    ]);
    const source = runtimeSources.join('\n');
    expect(source).not.toContain('/v1/auth/nonce');
    expect(source).not.toContain('/v1/auth/verify');
    expect(source).not.toContain('BrowserWalletConnector');
    expect(source).not.toMatch(/from ['"].*auth\/siwe|import\(['"].*auth\/siwe/);
    await expect(access(new URL('../src/auth/siwe.ts', import.meta.url))).rejects.toThrow();
  });
});
