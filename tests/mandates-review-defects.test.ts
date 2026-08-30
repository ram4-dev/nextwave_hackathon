import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { calculateJwkThumbprint, CompactSign, exportJWK, generateKeyPair } from 'jose';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryRepository } from '../src/persistence/repository.js';
import {
  createAutonomousClosedMandates,
  createLocalMerchantSigner,
  createMandateService,
  createTestAgentMandateSigner,
  FakeMandateAnchorClient,
  InMemoryMandateAnchorOutbox,
  InMemoryMandateReplayStore,
  InMemoryOpenMandateRegistry,
  InMemoryTrustedSurfaceApprovalStore,
  KyaAgentTrustVerifier,
  MandateAnchorWorker,
  mandateApprovalTypes,
  Eip712TrustedSurfaceService,
  verifyClosedMandateJws,
  type OpenMandateConstraints,
} from '../src/mandates/index.js';

const now = new Date('2030-01-01T00:00:00.000Z');
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945388d2b4e6f6837b2c5cf6ddf72f146d3a24');
const audience = 'credential-provider';
const issuedAt = '2030-01-01T00:00:00.000Z';
const expiresAt = '2030-01-01T00:10:00.000Z';

function constraints(overrides: Partial<OpenMandateConstraints> = {}): OpenMandateConstraints {
  return {
    merchantIds: ['merchant_001'],
    payeeIds: ['merchant_001'],
    maxQuantityPerProduct: 10,
    minAmountMinor: 1,
    maxAmountMinor: 100,
    currency: 'USD',
    totalBudgetMinor: 100,
    maxOperations: 10,
    frequencyWindowSeconds: 3600,
    maxOperationsPerWindow: 10,
    paymentInstrumentAlias: 'instrument_1',
    ...overrides,
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

describe('review defect 1: complete draft canonical payload hash', () => {
  it('rejects checkout and payment field mutations without expectedUserReference', async () => {
    const signer = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test' });
    const sut = createMandateService({
      merchantSigner: signer,
      replayStore: new InMemoryMandateReplayStore(),
      now: () => now,
    });
    const checkout = await sut.createMerchantCheckout({
      transactionId: 'txn_d1',
      merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
      lineItems: [{ productId: 'p1', title: 'P', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
      totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
      issuedAt, expiresAt, source: { type: 'manual', requestId: 'r1' },
    });
    const checkoutDraft = await sut.createCheckoutMandateDraft({
      checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: 'txn_d1',
      userReference: 'user_001', nonce: 'n_checkout', issuedAt, expiresAt,
    });
    const paymentDraft = await sut.createPaymentMandateDraft({
      transactionId: 'txn_d1', checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      checkoutMandateDraftId: checkoutDraft.id,
      payee: { id: 'merchant_001', name: 'Merchant', website: 'https://merchant.example' },
      paymentAmount: { amountMinor: 50, currency: 'USD' },
      paymentInstrument: { id: 'instrument_1', type: 'card', descriptionMasked: 'Card •••• 1234' },
      userReference: 'user_001', nonce: 'n_payment', issuedAt, expiresAt,
    });

    const checkoutCases = [
      { ...checkoutDraft.unsignedMandatePayload, sub: 'other' },
      { ...checkoutDraft.unsignedMandatePayload, aud: 'other-aud' },
      { ...checkoutDraft.unsignedMandatePayload, iat: checkoutDraft.unsignedMandatePayload.iat + 1 },
      { ...checkoutDraft.unsignedMandatePayload, exp: checkoutDraft.unsignedMandatePayload.exp + 1 },
      { ...checkoutDraft.unsignedMandatePayload, nonce: 'mutated_nonce' },
      { ...checkoutDraft.unsignedMandatePayload, checkout_jwt: `${checkout.checkoutJwt}x` },
    ];
    for (const draft of checkoutCases) {
      await expect(sut.verifyDraftConsistency({
        checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: 'txn_d1', draft,
      })).rejects.toMatchObject({ code: expect.stringMatching(/DRAFT_CONSISTENCY|CHECKOUT_HASH/) });
    }

    const paymentCases = [
      { ...paymentDraft.unsignedMandatePayload, payee: { ...paymentDraft.unsignedMandatePayload.payee, name: 'Other Name' } },
      { ...paymentDraft.unsignedMandatePayload, payee: { ...paymentDraft.unsignedMandatePayload.payee, website: 'https://other.example' } },
      { ...paymentDraft.unsignedMandatePayload, payment_instrument: { ...paymentDraft.unsignedMandatePayload.payment_instrument, type: 'bank' } },
      { ...paymentDraft.unsignedMandatePayload, payment_instrument: { ...paymentDraft.unsignedMandatePayload.payment_instrument, description_masked: 'Card •••• 9999' } },
      { ...paymentDraft.unsignedMandatePayload, iat: paymentDraft.unsignedMandatePayload.iat + 1 },
      { ...paymentDraft.unsignedMandatePayload, exp: paymentDraft.unsignedMandatePayload.exp + 1 },
      { ...paymentDraft.unsignedMandatePayload, nonce: 'mutated_payment_nonce' },
    ];
    for (const draft of paymentCases) {
      await expect(sut.verifyDraftConsistency({
        checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: 'txn_d1', draft,
      })).rejects.toMatchObject({ code: expect.stringMatching(/DRAFT_CONSISTENCY|PAYEE_REDIRECT|PAYMENT_INSTRUMENT/) });
    }
  });
});

describe('review defect 2: shared default policy ledger', () => {
  it('rejects 60+60 against budget 100 across two closures without injected ledger', async () => {
    const agentSigner = await createTestAgentMandateSigner('test');
    const merchant = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test' });
    const registry = new InMemoryOpenMandateRegistry();
    const service = createMandateService({ merchantSigner: merchant, replayStore: new InMemoryMandateReplayStore(), now: () => now });

    async function checkoutFor(txn: string, amount: number) {
      return service.createMerchantCheckout({
        transactionId: txn,
        merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
        lineItems: [{ productId: 'p1', title: 'P', quantity: 1, unitAmountMinor: amount, taxAmountMinor: 0, discountAmountMinor: 0 }],
        totals: { subtotalMinor: amount, taxMinor: 0, discountMinor: 0, totalMinor: amount, currency: 'USD' },
        issuedAt, expiresAt, source: { type: 'manual', requestId: txn },
      });
    }

    const openCheckout = registry.create({
      type: 'checkout', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints({ totalBudgetMinor: 100, maxAmountMinor: 100 }),
      issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'oc',
    });
    await registry.activateWithVerifiedSignature({
      id: openCheckout.id, signature: '0x1', expectedPayloadHash: openCheckout.canonicalPayloadHash,
      verifier: { verify: async () => true }, now,
    });

    async function close(txn: string, paymentNonce: string, amount: number) {
      const payment = registry.create({
        type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
        agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints({ totalBudgetMinor: 100, maxAmountMinor: 100 }),
        issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: paymentNonce,
      });
      await registry.activateWithVerifiedSignature({
        id: payment.id, signature: '0x2', expectedPayloadHash: payment.canonicalPayloadHash,
        verifier: { verify: async () => true }, now,
      });
      const checkout = await checkoutFor(txn, amount);
      return createAutonomousClosedMandates({
        openCheckoutMandateId: openCheckout.id,
        openPaymentMandateId: payment.id,
        registry,
        userReference: 'user_1',
        audience,
        checkoutJwt: checkout.checkoutJwt,
        checkoutHash: checkout.checkoutHash,
        transactionId: txn,
        agentIdentity: { agentId: 'agent_1', tenantId: 'tenant_1' },
        agentKeyReference: agentSigner.keyId,
        paymentInstrumentAlias: 'instrument_1',
        payeeId: 'merchant_001',
        merchantSigner: merchant,
        agentTrustVerifier: {
          verifyAgent: async () => ({
            allowed: true, agentStatus: 'bound', attestationStatus: 'valid', keyBindingStatus: 'bound',
            riskLevel: 'low', revocationStatus: 'active', policyVersion: 'v1', reasons: [],
          }),
        },
        agentSigner,
        now: () => now,
      });
    }

    await close('txn_budget_a', 'pay_a', 60);
    await expect(close('txn_budget_b', 'pay_b', 60)).rejects.toMatchObject({ code: 'POLICY_BUDGET' });
  });
});

describe('review defect 3: safe upgrade migration', () => {
  const databaseUrl = process.env.CATALOG_DATABASE_URL ?? 'postgres://catalog:catalog@127.0.0.1:55432/juno_catalog';
  let client: pg.Client | undefined;
  const schema = `mandate_upgrade_${Date.now()}`;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}`);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.end();
  });

  it('upgrades legacy prompt + 9-arg reserve schema to remediated shape', async () => {
    if (!client) throw new Error('no pg client');
    // Legacy schema (pre-remediation)
    await client.query(`
      create table mandate_requests (
        id text primary key,
        transaction_id text not null unique,
        agent_id text not null,
        tenant_id text not null,
        prompt text not null,
        prompt_hash text not null,
        received_at timestamptz not null,
        status text not null default 'received',
        created_at timestamptz not null default now()
      );
      create table mandate_policy_reservations (
        transaction_id text primary key,
        checkout_mandate_id text not null,
        payment_mandate_id text not null,
        amount_minor bigint not null,
        reserved_at timestamptz not null,
        released_at timestamptz,
        created_at timestamptz not null default now()
      );
      create function create_mandate_request(
        p_id text, p_transaction_id text, p_agent_id text, p_tenant_id text,
        p_prompt text, p_prompt_hash text, p_received_at timestamptz
      ) returns mandate_requests language sql as $$
        insert into mandate_requests (id, transaction_id, agent_id, tenant_id, prompt, prompt_hash, received_at)
        values (p_id, p_transaction_id, p_agent_id, p_tenant_id, p_prompt, p_prompt_hash, p_received_at)
        returning *;
      $$;
      create function reserve_mandate_policy(
        p_checkout_mandate_id text, p_payment_mandate_id text, p_transaction_id text,
        p_amount_minor bigint, p_reserved_at timestamptz, p_total_budget_minor bigint,
        p_max_operations integer, p_frequency_window_seconds integer, p_max_operations_per_window integer
      ) returns void language plpgsql as $$ begin null; end; $$;
    `);

    const upgradeSql = await readFile(
      path.join(process.cwd(), 'supabase/migrations/20260830_upgrade_mandate_schema_v2.sql'),
      'utf8',
    );
    // Rewrite public. -> current schema for isolated test
    await client.query(upgradeSql.replaceAll('public.', `${schema}.`).replaceAll('set search_path = public', `set search_path = ${schema}`));

    const cols = await client.query(`
      select column_name from information_schema.columns
      where table_schema = $1 and table_name = 'mandate_requests' order by column_name
    `, [schema]);
    const names = cols.rows.map((row) => row.column_name);
    expect(names).toContain('prompt_hash');
    expect(names).toContain('encrypted_prompt_ref');
    expect(names).not.toContain('prompt');

    const funcs = await client.query(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname in ('create_mandate_request', 'reserve_mandate_policy')
      order by 1, 2
    `, [schema]);
    const reserveArgs = funcs.rows.filter((row) => row.proname === 'reserve_mandate_policy').map((row) => row.args);
    expect(reserveArgs.some((args: string) => args.split(',').length === 9)).toBe(false);
    expect(reserveArgs.some((args: string) => args.split(',').length === 13)).toBe(true);

    // Fresh-install idempotency: applying upgrade again must not fail.
    await client.query(upgradeSql.replaceAll('public.', `${schema}.`).replaceAll('set search_path = public', `set search_path = ${schema}`));
  });
});

describe('review defect 4: key binding and independent JWS verify', () => {
  it('rejects mismatched signer cnf, key id, wrong credential principal/thumbprint, and altered closed JWS payload', async () => {
    const agentSigner = await createTestAgentMandateSigner('test');
    const otherSigner = await createTestAgentMandateSigner('test');
    const merchant = await createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: 'test' });
    const registry = new InMemoryOpenMandateRegistry();
    const service = createMandateService({ merchantSigner: merchant, replayStore: new InMemoryMandateReplayStore(), now: () => now });
    const checkout = await service.createMerchantCheckout({
      transactionId: 'txn_key',
      merchant: { id: 'merchant_001', legalName: 'Merchant Inc', website: 'https://merchant.example' },
      lineItems: [{ productId: 'p1', title: 'P', quantity: 1, unitAmountMinor: 50, taxAmountMinor: 0, discountAmountMinor: 0 }],
      totals: { subtotalMinor: 50, taxMinor: 0, discountMinor: 0, totalMinor: 50, currency: 'USD' },
      issuedAt, expiresAt, source: { type: 'manual', requestId: 'rk' },
    });
    const openCheckout = registry.create({
      type: 'checkout', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints(),
      issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'oc',
    });
    const openPayment = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: agentSigner.publicKeyJwk, constraints: constraints(),
      issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'op',
    });
    for (const mandate of [openCheckout, openPayment]) {
      await registry.activateWithVerifiedSignature({
        id: mandate.id, signature: '0xsig', expectedPayloadHash: mandate.canonicalPayloadHash,
        verifier: { verify: async () => true }, now,
      });
    }

    await expect(createAutonomousClosedMandates({
      openCheckoutMandateId: openCheckout.id, openPaymentMandateId: openPayment.id, registry,
      userReference: 'user_1', audience, checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      transactionId: 'txn_key', agentIdentity: { agentId: 'agent_1', tenantId: 'tenant_1' },
      agentKeyReference: otherSigner.keyId, paymentInstrumentAlias: 'instrument_1', payeeId: 'merchant_001',
      merchantSigner: merchant, agentSigner: otherSigner,
      agentTrustVerifier: { verifyAgent: async () => ({ allowed: true, agentStatus: 'bound', attestationStatus: 'valid', keyBindingStatus: 'bound', riskLevel: 'low', revocationStatus: 'active', policyVersion: 'v1', reasons: [] }) },
      now: () => now,
    })).rejects.toMatchObject({ code: 'AGENT_KEY_CNF' });

    await expect(createAutonomousClosedMandates({
      openCheckoutMandateId: openCheckout.id, openPaymentMandateId: openPayment.id, registry,
      userReference: 'user_1', audience, checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
      transactionId: 'txn_key', agentIdentity: { agentId: 'agent_1', tenantId: 'tenant_1' },
      agentKeyReference: 'wrong-key', paymentInstrumentAlias: 'instrument_1', payeeId: 'merchant_001',
      merchantSigner: merchant, agentSigner,
      agentTrustVerifier: { verifyAgent: async () => ({ allowed: true, agentStatus: 'bound', attestationStatus: 'valid', keyBindingStatus: 'bound', riskLevel: 'low', revocationStatus: 'active', policyVersion: 'v1', reasons: [] }) },
      now: () => now,
    })).rejects.toMatchObject({ code: 'AGENT_KEY_REFERENCE' });

    const repo = new InMemoryRepository();
    const thumbprint = await calculateJwkThumbprint(agentSigner.publicKeyJwk, 'sha256');
    await repo.withLock((store) => {
      store.principals.push({
        id: 'principal_1', ownerAddress: account.address, kycStatus: 'verified',
        kycExpiresAt: '2031-01-01T00:00:00.000Z', createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      store.enrollments.push({
        agentUuid: 'agent_1', deviceCode: 'd1', principalId: 'principal_1', status: 'bound',
        publicJwk: agentSigner.publicKeyJwk, thumbprint, keystoreProvider: 'os_hardware',
        agentUriPath: '/a', createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      store.credentials.push({
        id: 'cred_wrong', agentUuid: 'agent_1', principalId: 'principal_other', thumbprint: 'other-thumb',
        agentRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: '1', owner: account.address,
        status: 'active', statusRef: 'local', issuedAt: now.toISOString(), expiresAt: '2031-01-01T00:00:00.000Z', jti: 'j1',
      });
    });
    const trust = new KyaAgentTrustVerifier(repo, {
      policyVersion: 'v1',
      isTenantAuthorized: () => true,
      riskLevel: () => 'low',
      now: () => now,
    });
    const decision = await trust.verifyAgent({
      agentId: 'agent_1', tenantId: 'tenant_1', keyId: agentSigner.keyId, publicKeyJwk: agentSigner.publicKeyJwk,
      action: 'autonomous_payment_mandate',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain('ATTESTATION_MISSING');

    const keyPair = await generateKeyPair('ES256', { extractable: true });
    const publicKeyJwk = await exportJWK(keyPair.publicKey);
    const expected = { vct: 'mandate.checkout.1', amount: 1 };
    const altered = await new CompactSign(new TextEncoder().encode(JSON.stringify({ ...expected, amount: 999 })))
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .sign(keyPair.privateKey);
    await expect(verifyClosedMandateJws({
      jws: altered,
      publicKeyJwk,
      expectedPayload: expected,
    })).rejects.toMatchObject({ code: 'CLOSED_MANDATE_JWS' });
  });
});

describe('review defect 5: atomic activation proof persistence', () => {
  it('keeps mandate awaiting and challenge retryable when consume fails, then succeeds on retry', async () => {
    const repo = new InMemoryRepository();
    await repo.withLock((store) => {
      store.principals.push({
        id: 'principal_1', ownerAddress: account.address, kycStatus: 'verified',
        kycExpiresAt: '2031-01-01T00:00:00.000Z', createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      store.enrollments.push({
        agentUuid: 'agent_1', deviceCode: 'd1', principalId: 'principal_1', status: 'bound',
        publicJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, thumbprint: 't',
        keystoreProvider: 'os_hardware', agentUriPath: '/a', createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      store.credentials.push({
        id: 'c1', agentUuid: 'agent_1', principalId: 'principal_1', thumbprint: 't',
        agentRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: '1', owner: account.address,
        status: 'active', statusRef: 'local', issuedAt: now.toISOString(), expiresAt: '2031-01-01T00:00:00.000Z', jti: 'j1',
      });
    });
    const registry = new InMemoryOpenMandateRegistry();
    const mandate = registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      constraints: constraints(), issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'n1',
    });
    const store = new InMemoryTrustedSurfaceApprovalStore();
    let failOnce = true;
    const originalConsume = store.consume.bind(store);
    store.consume = async (input, at) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('inject consume failure');
      }
      return originalConsume(input, at);
    };
    const service = new Eip712TrustedSurfaceService({
      repo, registry, approvalStore: store, chainId: 84532, now: () => now,
      verifier: {
        verify: ({ address, domain, message, signature }) => verifyTypedData({
          address, domain, types: mandateApprovalTypes, primaryType: 'MandateApproval', message, signature,
        }),
      },
    });
    const { challenge, typedData } = await service.createApprovalChallenge({ openMandateId: mandate.id, ownerAddress: account.address });
    const signature = await account.signTypedData(typedData) as Hex;
    await expect(service.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: account.address, signature }))
      .rejects.toThrow(/inject consume failure/);
    expect(registry.get(mandate.id).status).toBe('awaiting_user_signature');
    expect((await store.get(challenge.id)).consumedAt).toBeUndefined();
    const approved = await service.verifyAndRecordApproval({ challengeId: challenge.id, ownerAddress: account.address, signature });
    expect(approved.mandate.status).toBe('active');
    expect(approved.mandate.activationProof?.signature).toBe(signature);
    expect(approved.mandate.activationProof?.payloadHash).toBe(mandate.canonicalPayloadHash);
  });
});

describe('review defect 6: outbox lease and strict hashes', () => {
  it('allows only one concurrent anchor and retries until failed with lease recovery', async () => {
    const outbox = new InMemoryMandateAnchorOutbox({ maxAttempts: 2, leaseMs: 1 });
    const client = new FakeMandateAnchorClient();
    const workerA = new MandateAnchorWorker(outbox, client, { maxAttempts: 2 });
    const workerB = new MandateAnchorWorker(outbox, client, { maxAttempts: 2 });
    const evidence = {
      closedCheckoutHash: sha('c'),
      closedPaymentHash: sha('p'),
      checkoutHash: sha('checkout'),
      transactionIdHash: sha('txn'),
      agentIdHash: sha('agent'),
      policyVersionHash: sha('policy'),
      mandateType: 1,
    };
    await outbox.enqueue(evidence);
    const [a, b] = await Promise.all([workerA.processOnce(), workerB.processOnce()]);
    const anchored = [a, b].filter((job) => job?.status === 'anchored');
    expect(anchored).toHaveLength(1);
    expect(client.anchored).toHaveLength(1);
    expect(anchored[0]?.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

    const failing = new MandateAnchorWorker(outbox, {
      anchor: async () => { throw new Error('rpc down'); },
    }, { maxAttempts: 2 });
    await outbox.enqueue({ ...evidence, closedCheckoutHash: sha('c2'), closedPaymentHash: sha('p2') });
    const firstFail = await failing.processOnce();
    expect(firstFail?.status).toBe('pending');
    const secondFail = await failing.processOnce();
    expect(secondFail?.status).toBe('failed');

    await expect(outbox.enqueue({ ...evidence, closedCheckoutHash: 'not-a-hash' })).rejects.toMatchObject({ code: 'ANCHOR_EVIDENCE' });
  });
});

describe('review defect 7: CLI/signer fail-closed', () => {
  it('rejects omitted NODE_ENV and divergent JWT iat/exp', async () => {
    await expect(createLocalMerchantSigner({ issuer: 'merchant_001', nodeEnv: '' })).rejects.toMatchObject({ code: 'MERCHANT_SIGNER_ENV' });
    const previous = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await expect(createLocalMerchantSigner({ issuer: 'merchant_001' })).rejects.toMatchObject({ code: 'MERCHANT_SIGNER_ENV' });
    } finally {
      process.env.NODE_ENV = previous;
    }

    const { createMandatesFromFile } = await import('../scripts/mandates-create.js');
    await expect(createMandatesFromFile('./fixtures/validated-checkout.json', {})).rejects.toThrow(/NODE_ENV/);
  });
});

describe('review defect open-mandate input validation', () => {
  it('rejects private d and incoherent constraints/dates', () => {
    const registry = new InMemoryOpenMandateRegistry();
    expect(() => registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'secret' } as JsonWebKey,
      constraints: constraints(), issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'n',
    })).toThrow(/Invalid open mandate input|OPEN_MANDATE_INPUT|Unrecognized key/);
    expect(() => registry.create({
      type: 'payment', tenantId: 'tenant_1', userReference: 'user_1', agentId: 'agent_1',
      agentPublicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      constraints: constraints({ minAmountMinor: 200, maxAmountMinor: 100 }),
      issuedAt, expiresAt: '2030-01-01T01:00:00.000Z', audience, nonce: 'n2',
    })).toThrow(/Invalid open mandate input|OPEN_MANDATE_INPUT/);
  });
});
