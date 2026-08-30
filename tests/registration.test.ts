import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { CeremonyService } from '../src/services/ceremony.js';
import { generateLocalAgentKey } from '../src/crypto/local-agent-key.js';
import { applyRegisteredEvent, startEventWatcher } from '../src/registry/events.js';
import { normalizeCdpUserOperation } from '../src/auth/cdp.js';
import { createApp } from '../src/server/app.js';
import { issueHumanSession } from '../src/auth/session.js';

const SMART = '0x1111111111111111111111111111111111111111' as const;

function config(overrides: Record<string, string> = {}) {
  return loadConfig({ NODE_ENV: 'test', KYA_MODE: 'demo', PUBLIC_BASE_URL: 'http://localhost:8787', KYA_ISSUER: 'http://localhost:8787', KYA_AUDIENCE: 'kya-agent', ...overrides });
}

describe('Smart Account registration submission', () => {
  it('records only a matching UserOperation hash for the current intent, idempotently', async () => {
    const repo = new InMemoryRepository(); const ceremony = new CeremonyService(repo, config(), { userOperationStatusProvider: { resolve: async () => ({ status: 'confirmed', transactionHash: `0x${'ef'.repeat(32)}` as `0x${string}`, receiptSuccess: true }) } });
    const principal = await ceremony.findOrCreatePrincipal(SMART);
    const key = await generateLocalAgentKey();
    const started = await ceremony.startEnrollment({ publicJwk: key.publicJwk, keystoreProvider: key.keystoreProvider });
    await ceremony.attachHuman(started.agentUuid, SMART);
    await repo.withLock((store) => { const p = store.principals.find((item) => item.id === principal.id)!; p.kycStatus = 'verified'; const enrollment = store.enrollments.find((item) => item.agentUuid === started.agentUuid)!; enrollment.status = 'awaiting_fingerprint'; });
    await ceremony.approveFingerprint(started.agentUuid, SMART, started.thumbprint);
    const intent = await ceremony.prepareRegistrationIntent(started.agentUuid, principal.id);
    const first = await ceremony.recordRegistrationSubmission(started.agentUuid, principal.id, intent.intentHash, `0x${'ab'.repeat(32)}`);
    const replay = await ceremony.recordRegistrationSubmission(started.agentUuid, principal.id, intent.intentHash, `0x${'ab'.repeat(32)}`);
    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    await expect(ceremony.resolveRegistrationSubmission(started.agentUuid, principal.id)).resolves.toMatchObject({ transactionHash: `0x${'ef'.repeat(32)}` });
    const mismatched = await applyRegisteredEvent(repo, 84532, { agentId: '9001', agentURI: `http://localhost:8787/v1/agents/${started.agentUuid}/agent-uri.json`, owner: SMART, txHash: `0x${'aa'.repeat(32)}` as `0x${string}`, logIndex: 1, blockNumber: 2n }, { registryAddress: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', currentBlock: 2n });
    expect(mismatched).toMatchObject({ applied: false, reason: 'transaction_mismatch' });
    const confirmed = await applyRegisteredEvent(repo, 84532, { agentId: '9001', agentURI: `http://localhost:8787/v1/agents/${started.agentUuid}/agent-uri.json`, owner: SMART, txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, logIndex: 1, blockNumber: 2n }, { registryAddress: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', currentBlock: 2n, verifiedOwner: SMART });
    expect(confirmed).toEqual({ applied: true, bound: true });
    await expect(ceremony.recordRegistrationSubmission(started.agentUuid, principal.id, '0xwrong', `0x${'cd'.repeat(32)}`)).rejects.toMatchObject({ code: 'REGISTRATION_INTENT' });
  });
});

describe('ERC-001 prerequisites and submission HTTP boundary', () => {
  it('rejects missing KYC, fingerprint readiness, and Principal Smart Account mismatch without intent or submission mutation', async () => {
    const repo = new InMemoryRepository();
    const ceremony = new CeremonyService(repo, config());
    const principal = await ceremony.findOrCreatePrincipal(SMART);
    await repo.withLock((store) => store.enrollments.push({ agentUuid: 'not-ready', deviceCodeHash: 'hash-D', userCodeHash: 'uhash-D', pairingExpiresAt: new Date(Date.now()+600000).toISOString(), pollIntervalSeconds: 5, principalId: principal.id, status: 'awaiting_register', publicJwk: {}, thumbprint: 't', keystoreProvider: 'os_hardware', agentUriPath: '/v1/agents/not-ready/agent-uri.json', createdAt: '', updatedAt: '' }));
    await expect(ceremony.prepareRegistrationIntent('not-ready', principal.id)).rejects.toMatchObject({ code: 'REGISTRATION_PREREQUISITE' });
    await expect(ceremony.prepareRegistrationIntent('not-ready', 'other-principal')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const enrollment = (await repo.getStore()).enrollments[0]!;
    expect(enrollment.registrationIntentHash).toBeUndefined();
    expect(enrollment.registrationUserOpHash).toBeUndefined();
  });

  it('accepts only a UserOperation hash, stays idempotent, and denies cross-Principal submissions', async () => {
    const repo = new InMemoryRepository();
    const owner = await ceremonyReady(repo);
    const other = await new CeremonyService(repo, config()).findOrCreatePrincipal('0x2222222222222222222222222222222222222222');
    const ownerToken = await issueHumanSession(repo, config(), owner.principal);
    const otherToken = await issueHumanSession(repo, config(), other);
    const { app } = createApp(repo, config(), { cdpVerifier: { validate: async () => ({ userId: 'unused', emailAuthenticated: true, smartAccountAddress: SMART, ownerAddresses: ['0x3333333333333333333333333333333333333333'] }) } });
    const intentResponse = await app.request(`/v1/enrollments/${owner.agentUuid}/registration-intent`, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}` } });
    const intent = await intentResponse.json() as { intentHash: string };
    expect(intentResponse.status).toBe(200);
    const payload = { intentHash: intent.intentHash, userOpHash: `0x${'ab'.repeat(32)}` };
    const rejected = await app.request(`/v1/enrollments/${owner.agentUuid}/registration-submissions`, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, transactionHash: `0x${'ef'.repeat(32)}` }) });
    expect(rejected.status).toBe(400);
    expect((await repo.getStore()).enrollments.find((e) => e.agentUuid === owner.agentUuid)!.registrationUserOpHash).toBeUndefined();
    const first = await app.request(`/v1/enrollments/${owner.agentUuid}/registration-submissions`, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const duplicate = await app.request(`/v1/enrollments/${owner.agentUuid}/registration-submissions`, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const forbidden = await app.request(`/v1/enrollments/${owner.agentUuid}/registration-submissions`, { method: 'POST', headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(first.status).toBe(201); expect(duplicate.status).toBe(200); expect(forbidden.status).toBe(403);
  });

  it('reports CDP sponsorship as configured but unknown until Portal capability is proven', async () => {
    const repo = new InMemoryRepository();
    const ready = await ceremonyReady(repo);
    const result = await new CeremonyService(repo, config({ VITE_CDP_PROJECT_ID: 'public-project-id' })).prepareRegistrationIntent(ready.agentUuid, ready.principal.id);
    expect(result.sponsorship).toEqual({ provider: 'cdp', configured: true, ready: false, status: 'unknown' });
  });

  it('requires the current KYA session and full registry evidence, then ensures one active credential without reissuing it', async () => {
    const repo = new InMemoryRepository();
    const ready = await ceremonyReady(repo);
    const ceremony = new CeremonyService(repo, config());
    const intent = await ceremony.prepareRegistrationIntent(ready.agentUuid, ready.principal.id);
    const txHash = `0x${'ef'.repeat(32)}` as `0x${string}`;
    const session = await issueHumanSession(repo, config(), ready.principal);
    const { app } = createApp(repo, config(), {
      cdpVerifier: { validate: async () => ({ userId: 'unused', emailAuthenticated: true, smartAccountAddress: SMART, ownerAddresses: [SMART] }) },
    });
    const path = `/v1/enrollments/${ready.agentUuid}/claim-credential`;

    expect((await app.request(path, { method: 'POST' })).status).toBe(401);
    expect((await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${session}` } })).status).toBe(400);
    expect((await repo.getStore()).credentials).toHaveLength(0);

    await repo.withLock((store) => {
      const enrollment = store.enrollments.find((item) => item.agentUuid === ready.agentUuid)!;
      enrollment.registrationUserOpHash = `0x${'ab'.repeat(32)}`;
      enrollment.registrationTransactionHash = txHash;
      enrollment.registrationReceiptConfirmedAt = '2026-08-30T00:00:00.000Z';
    });
    await applyRegisteredEvent(repo, 84532, {
      agentId: '9010', agentURI: intent.agentURI, owner: SMART, txHash, logIndex: 10, blockNumber: 10n,
    }, {
      registryAddress: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', currentBlock: 10n, verifiedOwner: SMART,
    });

    const first = await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${session}` } });
    const second = await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${session}` } });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstClaim = await first.json() as { jti: string; token: string };
    const secondClaim = await second.json() as { jti: string; token: string };
    expect(secondClaim.jti).toBe(firstClaim.jti);
    expect(secondClaim.token).toEqual(expect.any(String));
    const credentials = (await repo.getStore()).credentials.filter((credential) => credential.agentUuid === ready.agentUuid);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.status).toBe('active');
  });
});

async function ceremonyReady(repo: InMemoryRepository) {
  const ceremony = new CeremonyService(repo, config());
  const principal = await ceremony.findOrCreatePrincipal(SMART);
  const started = await ceremony.startEnrollment({ publicJwk: (await generateLocalAgentKey()).publicJwk, keystoreProvider: 'os_hardware' });
  await ceremony.attachHuman(started.agentUuid, SMART);
  await repo.withLock((store) => { store.principals.find((item) => item.id === principal.id)!.kycStatus = 'verified'; store.enrollments.find((item) => item.agentUuid === started.agentUuid)!.status = 'awaiting_fingerprint'; });
  await ceremony.approveFingerprint(started.agentUuid, SMART, started.thumbprint);
  return { principal, agentUuid: started.agentUuid };
}

describe('UserOperation receipt gate', () => {
  it('does not record a transaction for pending, failed, or receipt-less resolution', async () => {
    for (const resolved of [
      { status: 'pending' as const }, { status: 'failed' as const },
      { status: 'confirmed' as const, transactionHash: `0x${'aa'.repeat(32)}` as `0x${string}`, receiptSuccess: false },
    ]) {
      const repo = new InMemoryRepository();
      const ceremony = new CeremonyService(repo, config(), { userOperationStatusProvider: { resolve: async () => resolved } });
      const principal = await ceremony.findOrCreatePrincipal(SMART);
      await repo.withLock((store) => store.enrollments.push({ agentUuid: 'agent-test', deviceCodeHash: 'hash-D', userCodeHash: 'uhash-D', pairingExpiresAt: new Date(Date.now()+600000).toISOString(), pollIntervalSeconds: 5, principalId: principal.id, status: 'awaiting_onchain', publicJwk: {}, thumbprint: 't', keystoreProvider: 'os_hardware', agentUriPath: '/x', registrationUserOpHash: `0x${'ab'.repeat(32)}` as `0x${string}`, createdAt: '', updatedAt: '' }));
      if (resolved.status === 'failed') await expect(ceremony.resolveRegistrationSubmission('agent-test', principal.id)).rejects.toMatchObject({ code: 'USER_OPERATION' });
      else await expect(ceremony.resolveRegistrationSubmission('agent-test', principal.id)).resolves.toEqual({ status: 'pending' });
      expect((await repo.getStore()).enrollments[0]!.registrationTransactionHash).toBeUndefined();
    }
  });
});

describe('authoritative CDP UserOperation evidence', () => {
  const transactionHash = `0x${'ef'.repeat(32)}` as `0x${string}`;

  it('accepts only a complete operation with its exact successful, non-reverted receipt', () => {
    expect(normalizeCdpUserOperation({
      status: 'complete', transactionHash,
      receipts: [{ transactionHash }],
    })).toEqual({ status: 'confirmed', transactionHash, receiptSuccess: true });

    expect(normalizeCdpUserOperation({ status: 'pending' })).toEqual({ status: 'pending' });
    expect(normalizeCdpUserOperation({ status: 'failed' })).toEqual({ status: 'failed' });
    expect(normalizeCdpUserOperation({ status: 'complete', transactionHash, receipts: [] })).toEqual({ status: 'pending' });
  });

  it('does not treat reverted or mismatched receipts as confirmation evidence', () => {
    expect(normalizeCdpUserOperation({
      status: 'complete', transactionHash,
      receipts: [{ transactionHash, revert: { message: 'reverted' } }],
    })).toEqual({ status: 'pending' });
    expect(normalizeCdpUserOperation({
      status: 'complete', transactionHash,
      receipts: [{ transactionHash }],
    })).toEqual({ status: 'confirmed', transactionHash, receiptSuccess: true });
    expect(normalizeCdpUserOperation({
      status: 'complete', transactionHash,
      receipts: [{ transactionHash: `0x${'aa'.repeat(32)}` }],
    })).toEqual({ status: 'pending' });
  });
});

describe('registry watcher Smart Account evidence', () => {
  it('rejects an event when its registry, intent, or ownerOf proof differs from the bound Smart Account', async () => {
    const repo = new InMemoryRepository();
    const ceremony = new CeremonyService(repo, config(), {
      userOperationStatusProvider: { resolve: async () => ({ status: 'confirmed', transactionHash: `0x${'ef'.repeat(32)}` as `0x${string}`, receiptSuccess: true }) },
    });
    const principal = await ceremony.findOrCreatePrincipal(SMART);
    const started = await ceremony.startEnrollment({ publicJwk: (await generateLocalAgentKey()).publicJwk, keystoreProvider: 'os_hardware' });
    await ceremony.attachHuman(started.agentUuid, SMART);
    await repo.withLock((store) => { store.principals.find((item) => item.id === principal.id)!.kycStatus = 'verified'; store.enrollments.find((item) => item.agentUuid === started.agentUuid)!.status = 'awaiting_fingerprint'; });
    await ceremony.approveFingerprint(started.agentUuid, SMART, started.thumbprint);
    const intent = await ceremony.prepareRegistrationIntent(started.agentUuid, principal.id);
    await ceremony.recordRegistrationSubmission(started.agentUuid, principal.id, intent.intentHash, `0x${'ab'.repeat(32)}`);
    await ceremony.resolveRegistrationSubmission(started.agentUuid, principal.id);
    const event = { agentId: '9002', agentURI: intent.agentURI, owner: SMART, txHash: `0x${'ef'.repeat(32)}` as `0x${string}`, logIndex: 2, blockNumber: 3n };

    await repo.withLock((store) => { store.enrollments.find((item) => item.agentUuid === started.agentUuid)!.registrationIntentHash = 'wrong-intent'; });
    await expect(applyRegisteredEvent(repo, 84532, event, { registryAddress: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', currentBlock: 3n, verifiedOwner: SMART })).resolves.toMatchObject({ applied: false, reason: 'intent_mismatch' });

    await repo.withLock((store) => { const enrollment = store.enrollments.find((item) => item.agentUuid === started.agentUuid)!; enrollment.registrationIntentHash = intent.intentHash; });
    await expect(applyRegisteredEvent(repo, 84532, { ...event, logIndex: 3 }, { registryAddress: '0x2222222222222222222222222222222222222222', publicBaseUrl: 'http://localhost:8787', currentBlock: 3n, verifiedOwner: SMART })).resolves.toMatchObject({ applied: false, reason: 'registry_mismatch' });
    await expect(applyRegisteredEvent(repo, 84532, { ...event, logIndex: 4 }, { registryAddress: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', currentBlock: 3n, verifiedOwner: '0x3333333333333333333333333333333333333333' })).resolves.toMatchObject({ applied: false, reason: 'owner_mismatch' });
  });
});

describe('ERC-003 complete evidence gate', () => {
  it('never binds or issues a credential when any recorded intent, UserOperation, successful receipt, or transaction evidence is absent', async () => {
    const txHash = `0x${'ef'.repeat(32)}` as `0x${string}`;
    for (const missing of ['registrationIntentHash', 'registrationUserOpHash', 'registrationReceiptConfirmedAt', 'registrationTransactionHash'] as const) {
      const repo = new InMemoryRepository();
      const ready = await ceremonyReady(repo);
      const intent = await new CeremonyService(repo, config()).prepareRegistrationIntent(ready.agentUuid, ready.principal.id);
      await repo.withLock((store) => {
        const enrollment = store.enrollments.find((item) => item.agentUuid === ready.agentUuid)! as typeof store.enrollments[number] & { registrationReceiptConfirmedAt?: string };
        enrollment.registrationUserOpHash = `0x${'ab'.repeat(32)}`;
        enrollment.registrationTransactionHash = txHash;
        enrollment.registrationReceiptConfirmedAt = '2026-08-30T00:00:00.000Z';
        enrollment[missing] = undefined;
      });
      const result = await applyRegisteredEvent(repo, 84532, { agentId: '9003', agentURI: intent.agentURI, owner: SMART, txHash, logIndex: 9, blockNumber: 4n }, { registryAddress: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', currentBlock: 4n, verifiedOwner: SMART });
      expect(result).toMatchObject({ applied: false, bound: false });
      const store = await repo.getStore();
      expect(store.enrollments.find((item) => item.agentUuid === ready.agentUuid)?.status).toBe('awaiting_onchain');
      expect(store.credentials).toHaveLength(0);
    }
  });
});

describe('durable Registered-event reconciliation', () => {
  it('retries a matching event received before UserOperation resolution after a watcher restart and binds exactly once', async () => {
    const repo = new InMemoryRepository();
    let resolved: { status: 'pending' | 'confirmed'; transactionHash?: `0x${string}`; receiptSuccess?: boolean } = { status: 'pending' };
    const ceremony = new CeremonyService(repo, config(), { userOperationStatusProvider: { resolve: async () => resolved } });
    const principal = await ceremony.findOrCreatePrincipal(SMART);
    const started = await ceremony.startEnrollment({ publicJwk: (await generateLocalAgentKey()).publicJwk, keystoreProvider: 'os_hardware' });
    await ceremony.attachHuman(started.agentUuid, SMART);
    await repo.withLock((store) => {
      store.principals.find((p) => p.id === principal.id)!.kycStatus = 'verified';
      store.enrollments.find((e) => e.agentUuid === started.agentUuid)!.status = 'awaiting_fingerprint';
    });
    await ceremony.approveFingerprint(started.agentUuid, SMART, started.thumbprint);
    const intent = await ceremony.prepareRegistrationIntent(started.agentUuid, principal.id);
    await ceremony.recordRegistrationSubmission(started.agentUuid, principal.id, intent.intentHash, `0x${'ab'.repeat(32)}`);

    let onRegistered: ((logs: Array<Record<string, unknown>>) => Promise<void>) | undefined;
    const client = {
      getBlockNumber: async () => 12n,
      readContract: async () => SMART,
      watchContractEvent: (args: Record<string, unknown>) => {
        if (args.eventName === 'Registered') onRegistered = args.onLogs as typeof onRegistered;
        return () => undefined;
      },
    };
    const event = {
      args: { agentId: 77n, agentURI: intent.agentURI, owner: SMART },
      transactionHash: `0x${'ef'.repeat(32)}` as `0x${string}`,
      logIndex: 4,
      blockNumber: 12n,
    };
    const first = await startEventWatcher(client, repo, { chainId: 84532, registry: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', flushIntervalMs: 60_000 });
    await onRegistered!([event]);
    expect((await repo.getStore()).pendingRegistryEvents).toHaveLength(1);
    first.stop();

    resolved = { status: 'confirmed', transactionHash: event.transactionHash, receiptSuccess: true };
    await ceremony.resolveRegistrationSubmission(started.agentUuid, principal.id);
    const restarted = await startEventWatcher(client, repo, { chainId: 84532, registry: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', flushIntervalMs: 60_000 });
    await restarted.flush();
    await onRegistered!([event]);
    await restarted.flush();
    await onRegistered!([{ ...event, transactionHash: `0x${'cd'.repeat(32)}` as `0x${string}`, logIndex: 5 }]);
    const store = await repo.getStore();
    expect(store.enrollments.find((e) => e.agentUuid === started.agentUuid)?.status).toBe('bound');
    expect(store.pendingRegistryEvents).toHaveLength(0);
    expect(store.processedEvents.filter((e) => e.eventName === 'Registered' && e.txHash === event.transactionHash)).toHaveLength(1);
    expect(store.credentials).toHaveLength(0);
    restarted.stop();
  });

  it('binds a resolution-before-event watcher delivery exactly once without leaving durable work', async () => {
    const repo = new InMemoryRepository();
    const ready = await ceremonyReady(repo);
    const txHash = `0x${'ef'.repeat(32)}` as `0x${string}`;
    const ceremony = new CeremonyService(repo, config(), { userOperationStatusProvider: { resolve: async () => ({ status: 'confirmed', transactionHash: txHash, receiptSuccess: true }) } });
    const intent = await ceremony.prepareRegistrationIntent(ready.agentUuid, ready.principal.id);
    await ceremony.recordRegistrationSubmission(ready.agentUuid, ready.principal.id, intent.intentHash, `0x${'ab'.repeat(32)}`);
    await ceremony.resolveRegistrationSubmission(ready.agentUuid, ready.principal.id);
    let onRegistered: ((logs: Array<Record<string, unknown>>) => Promise<void>) | undefined;
    const watcher = await startEventWatcher({ getBlockNumber: async () => 20n, readContract: async () => SMART, watchContractEvent: (args: Record<string, unknown>) => { if (args.eventName === 'Registered') onRegistered = args.onLogs as typeof onRegistered; return () => undefined; } }, repo, { chainId: 84532, registry: config().identityRegistrySepolia, publicBaseUrl: 'http://localhost:8787', flushIntervalMs: 60_000 });
    const event = { args: { agentId: 88n, agentURI: intent.agentURI, owner: SMART }, transactionHash: txHash, logIndex: 6, blockNumber: 20n };
    await onRegistered!([event]);
    await onRegistered!([event]);
    const store = await repo.getStore();
    expect(store.enrollments.find((item) => item.agentUuid === ready.agentUuid)?.status).toBe('bound');
    expect(store.pendingRegistryEvents).toHaveLength(0);
    expect(store.processedEvents.filter((item) => item.eventName === 'Registered')).toHaveLength(1);
    watcher.stop();
  });
});
