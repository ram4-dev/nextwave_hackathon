import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';
import { mandateApprovalTypes } from '../src/mandates/index.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { createApp } from '../src/server/app.js';

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945388d2b4e6f6837b2c5cf6ddf72f146d3a24');

function config() {
  return loadConfig({ NODE_ENV: 'test', KYA_MODE: 'demo', PUBLIC_BASE_URL: 'http://localhost:8787', KYA_ISSUER: 'http://localhost:8787', KYA_AUDIENCE: 'kya-agent' });
}

describe('AP2 demo HTTP flow', () => {
  it('runs from demo KYC through EIP-712 approval to closed mandate hashes', async () => {
    const { app } = createApp(new InMemoryRepository(), config());
    const auth = await app.request('/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: account.address, message: 'DEMO_BYPASS', signature: '0x' }) });
    expect(auth.status).toBe(200);
    const token = (await auth.json()).token as string;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    expect((await app.request('/v1/kyc/demo/complete', { method: 'POST', headers })).status).toBe(200);

    const agentResponse = await app.request('/v1/mandates/demo/agents', { method: 'POST', headers });
    expect(agentResponse.status).toBe(201);
    const agent = await agentResponse.json() as { agentUuid: string };

    const now = new Date();
    const checkoutResponse = await app.request('/v1/mandates/checkout', {
      method: 'POST', headers,
      body: JSON.stringify({
        transactionId: 'txn_http_demo', merchant: { id: 'demo-merchant-1', legalName: 'Demo Store', website: 'https://demo-store.example' },
        lineItems: [{ productId: 'sku_1', title: 'Headphones', quantity: 1, unitAmountMinor: 9999, taxAmountMinor: 0, discountAmountMinor: 0 }],
        totals: { subtotalMinor: 9999, taxMinor: 0, discountMinor: 0, totalMinor: 9999, currency: 'USD' },
        issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(), source: { type: 'llm', requestId: 'req_http_demo' },
      }),
    });
    expect(checkoutResponse.status).toBe(201);
    const checkout = await checkoutResponse.json() as { checkoutJwt: string; checkoutHash: string };

    const openResponse = await app.request('/v1/mandates/open', {
      method: 'POST', headers,
      body: JSON.stringify({ agentUuid: agent.agentUuid, constraints: {
        merchantIds: ['demo-merchant-1'], payeeIds: ['demo-merchant-1'], maxQuantityPerProduct: 2,
        minAmountMinor: 1, maxAmountMinor: 20_000, currency: 'USD', totalBudgetMinor: 20_000,
        maxOperations: 5, frequencyWindowSeconds: 3600, maxOperationsPerWindow: 5, paymentInstrumentAlias: 'demo-card-••••4242',
      } }),
    });
    expect(openResponse.status).toBe(201);
    const open = await openResponse.json() as { checkout: { id: string }; payment: { id: string } };

    for (const mandate of [open.checkout, open.payment]) {
      const challengeResponse = await app.request(`/v1/mandates/open/${mandate.id}/challenge`, { method: 'POST', headers });
      expect(challengeResponse.status).toBe(200);
      const challenge = await challengeResponse.json() as { challenge: { id: string }; typedData: { domain: { name: string; version: string; chainId: number }; message: { mandateHash: `0x${string}`; userReferenceHash: `0x${string}`; agentIdHash: `0x${string}`; nonceHash: `0x${string}`; issuedAt: string; expiresAt: string } } };
      const signature = await account.signTypedData({
        domain: challenge.typedData.domain, types: mandateApprovalTypes, primaryType: 'MandateApproval',
        message: { ...challenge.typedData.message, issuedAt: BigInt(challenge.typedData.message.issuedAt), expiresAt: BigInt(challenge.typedData.message.expiresAt) },
      });
      const approved = await app.request(`/v1/mandates/open/${mandate.id}/approve`, { method: 'POST', headers, body: JSON.stringify({ challengeId: challenge.challenge.id, signature }) });
      expect(approved.status).toBe(200);
    }

    const closed = await app.request('/v1/mandates/close', {
      method: 'POST', headers,
      body: JSON.stringify({ openCheckoutMandateId: open.checkout.id, openPaymentMandateId: open.payment.id, checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: 'txn_http_demo', paymentInstrumentAlias: 'demo-card-••••4242', payeeId: 'demo-merchant-1' }),
    });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ status: 'verified', policy: { allowed: true }, trust: { allowed: true }, closedCheckoutHash: expect.any(String), closedPaymentHash: expect.any(String) });
  });
});
