/**
 * Final-audit probes A/B — must fail before fixes, pass after.
 */
import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertPublicEcP256Jwk,
  generateLocalAgentKey,
} from '../src/crypto/local-agent-key.js';
import { buildDpopProof as buildServerDpopProof } from '../src/crypto/dpop-proof.js';
import { assertPublicEcP256Jwk as assertBrowserPublicEcP256Jwk } from '../web/src/agent/dpopClient.js';
import { saveAgentKeyHandle } from '../web/src/agent/keyStore.js';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { createBootstrappedApp } from '../src/server/bootstrap.js';
import { generateKeyPair, exportJWK } from 'jose';

describe('final audit probes', () => {
  it('PROBE A: rejects zero/off-curve P-256 point that is exactly 32 bytes', async () => {
    const z = Buffer.alloc(32).toString('base64url');
    const jwk = { kty: 'EC', crv: 'P-256', x: z, y: z } as JsonWebKey;
    let curveValid = true;
    try {
      createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
        format: 'jwk',
      });
    } catch {
      curveValid = false;
    }
    expect(curveValid).toBe(false);
    expect(() => assertPublicEcP256Jwk(jwk)).toThrow(/curve|point|Invalid|P-256|crypto/i);
    await expect(assertBrowserPublicEcP256Jwk(jwk)).rejects.toThrow(
      /curve|point|Invalid|P-256|crypto/i,
    );

    const { publicKey } = await generateKeyPair('ES256');
    const valid = await exportJWK(publicKey);
    expect(assertPublicEcP256Jwk(valid)).toMatchObject({ kty: 'EC', crv: 'P-256' });
    await expect(assertBrowserPublicEcP256Jwk(valid)).resolves.toMatchObject({
      kty: 'EC',
      crv: 'P-256',
    });

    const localKey = await generateLocalAgentKey();
    await expect(
      buildServerDpopProof(localKey.privateKey, jwk, {
        htm: 'GET',
        htu: 'http://localhost:8787/v1/agent/me',
        accessToken: 'not-a-real-access-token',
      }),
    ).rejects.toThrow(/curve|point|Invalid|P-256|crypto/i);
    await expect(
      saveAgentKeyHandle({
        privateKey: localKey.privateKey,
        publicJwk: jwk,
        thumbprint: 'invalid-off-curve',
        keystoreProvider: localKey.keystoreProvider,
      }),
    ).rejects.toThrow(/curve|point|Invalid|P-256|crypto/i);
  });

  it('PROBE B: live bootstrap wires durable Supabase rate limiter (not 503 by default)', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    void publicKey;
    const config = loadConfig({
      NODE_ENV: 'test',
      KYA_MODE: 'live',
      PERSISTENCE_BACKEND: 'supabase',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-not-real',
      PUBLIC_BASE_URL: 'http://localhost:8787',
      KYA_ISSUER: 'http://localhost:8787',
      FRONTEND_ORIGIN: 'http://localhost:5173',
      BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
      DIDIT_API_KEY: 'k',
      DIDIT_WORKFLOW_ID: 'w',
      DIDIT_WEBHOOK_SECRET: 's',
      KYA_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    });

    let rpcCalls = 0;
    let rateStoreAvailable = true;
    const fakeClient = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return { data: { value: '20260830_02' }, error: null };
          },
        };
      },
      async rpc(name: string) {
        if (name === 'kya_check_rate_limit') {
          rpcCalls += 1;
          if (!rateStoreAvailable) {
            return { data: null, error: { message: 'rate store down' } };
          }
          return { data: [{ allowed: true, remaining: 59 }], error: null };
        }
        return { data: null, error: { message: 'unused' } };
      },
    };

    const repo = new InMemoryRepository();
    const { app } = createBootstrappedApp({
      config,
      repo,
      supabaseClient: fakeClient as never,
      persistenceReady: async () => true,
      appDeps: {
        cdpVerifier: {
        validate: async () => ({
          userId: 'user_1',
            emailAuthenticated: true,
            smartAccountAddress:
              '0x1111111111111111111111111111111111111111' as `0x${string}`,
            ownerAddresses: [
              '0x2222222222222222222222222222222222222222' as `0x${string}`,
            ],
        }),
      },
      },
    });

    const ready = await app.request('/ready');
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({
      ready: true,
      dependencies: { rateLimit: 'ok', supabase: 'ok' },
    });

    const res = await app.request('/v1/auth/cdp/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'opaque-cdp-token-value-xxxxxxxx' }),
    });
    expect(res.status).toBe(200);
    expect(rpcCalls).toBeGreaterThanOrEqual(1);

    rateStoreAvailable = false;
    const notReady = await app.request('/ready');
    expect(notReady.status).toBe(503);
    await expect(notReady.json()).resolves.toMatchObject({
      ready: false,
      dependencies: { rateLimit: 'unavailable', supabase: 'ok' },
    });

    const failClosed = await app.request('/v1/auth/cdp/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: 'opaque-cdp-token-value-yyyyyyyy' }),
    });
    expect(failClosed.status).toBe(503);
    expect(await failClosed.json()).toEqual({
      error: 'Dependency unavailable',
      code: 'UNAVAILABLE',
    });
  });
});
