import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { issueHumanSession } from '../src/auth/session.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { createApp } from '../src/server/app.js';
import { readBoundedBody } from '../src/server/request-body.js';
import { DemoKycAdapter } from '../src/kyc/demo.js';

const MAX_JSON_BODY = 32_768;

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    KYA_MODE: 'demo',
    PERSISTENCE_BACKEND: 'memory',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    KYA_ISSUER: 'http://localhost:8787',
    FRONTEND_ORIGIN: 'http://localhost:5173',
  });
}

describe('bounded KYA request bodies', () => {
  it('cancels the stream as soon as the byte limit is exceeded', async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(20_000));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    await expect(
      readBoundedBody({ body: stream, headers: new Headers() }, MAX_JSON_BODY),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(pulls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('returns deterministic 413 without Content-Length on every JSON-reading KYA route', async () => {
    const repo = new InMemoryRepository();
    const appConfig = config();
    const principal = {
      id: 'prin_body_limit',
      ownerAddress: '0x1111111111111111111111111111111111111111' as const,
      kycStatus: 'pending' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await repo.withLock((store) => {
      store.principals.push(principal);
    });
    const session = await issueHumanSession(repo, appConfig, principal);
    const { app } = createApp(repo, appConfig);
    const oversized = JSON.stringify({ pad: 'x'.repeat(MAX_JSON_BODY + 1) });

    const routes = [
      ['POST', '/v1/auth/cdp/exchange', undefined],
      ['POST', '/v1/enrollments', undefined],
      ['POST', '/v1/device-enrollments', undefined],
      ['POST', '/v1/device-enrollments/token', undefined],
      ['POST', '/v1/device-enrollments/claim', session],
      ['POST', '/v1/enrollments/agent_1/approve-fingerprint', session],
      ['POST', '/v1/enrollments/agent_1/registration-intent', session],
      ['POST', '/v1/enrollments/agent_1/registration-submissions', session],
      ['POST', '/v1/enrollments/agent_1/registration-submissions/resolve', session],
      ['POST', '/v1/enrollments/agent_1/confirm-demo', session],
      ['POST', '/v1/enrollments/agent_1/claim-credential', session],
      ['POST', '/v1/enrollments/agent_1/rotate', session],
      ['POST', '/v1/enrollments/agent_1/revoke', session],
      ['POST', '/v1/enrollments/agent_1/rebind', session],
      ['POST', '/v1/kyc/sessions', session],
      ['POST', '/v1/kyc/demo/complete', session],
      ['POST', '/v1/agents/agent_1/challenges', undefined],
      ['POST', '/v1/agents/agent_1/challenges/verify', undefined],
      ['POST', '/v1/credentials/verify', undefined],
    ] as const;

    for (const [method, path, token] of routes) {
      const headers = new Headers({ 'content-type': 'application/json' });
      if (token) headers.set('authorization', `Bearer ${token}`);
      expect(headers.has('content-length')).toBe(false);
      const response = await app.request(path, { method, headers, body: oversized });
      expect(response.status, `${method} ${path}`).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: 'Payload too large',
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
  });

  it('bounds the raw signed-webhook body while preserving exact bytes under the limit', async () => {
    const repo = new InMemoryRepository();
    const { app, ceremony } = createApp(repo, config());
    const oversized = 'x'.repeat(MAX_JSON_BODY + 1);
    const response = await app.request('/v1/kyc/webhooks/demo', {
      method: 'POST',
      headers: { 'x-demo-signature': 'invalid-on-purpose' },
      body: oversized,
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: 'Payload too large',
      code: 'PAYLOAD_TOO_LARGE',
    });

    const principal = await ceremony.findOrCreatePrincipal(
      '0x2222222222222222222222222222222222222222',
    );
    const started = await ceremony.startKyc(principal.ownerAddress);
    const signed = DemoKycAdapter.signWebhook({
      session_id: started.sessionId,
      status: 'verified',
      event_id: `evt-${started.sessionId}`,
    });
    const accepted = await app.request('/v1/kyc/webhooks/demo', {
      method: 'POST',
      headers: { 'x-demo-signature': signed.signature },
      body: signed.rawBody,
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      status: 'verified',
      provider: 'demo',
    });
  });
});
