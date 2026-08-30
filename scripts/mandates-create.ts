import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLocalMerchantSigner, createMandateService, InMemoryMandateReplayStore, JsonFileMandateReplayStore } from '../src/mandates/index.js';
import type { CreateMerchantCheckoutInput } from '../src/mandates/index.js';

type CliInput = CreateMerchantCheckoutInput & {
  userReference: string;
  checkoutMandate: { nonce: string; issuedAt: string; expiresAt: string };
  paymentMandate?: {
    checkoutNonce: string;
    issuedAt: string;
    expiresAt: string;
    payee: { id: string; name: string; website: string };
    paymentAmount: { amountMinor: number; currency: string };
    paymentInstrument: { id: string; type: string; descriptionMasked: string };
  };
};

export async function createMandatesFromFile(filePath: string, env: NodeJS.ProcessEnv = process.env) {
  const input = JSON.parse(await readFile(filePath, 'utf8')) as CliInput;
  const nodeEnv = env.NODE_ENV ?? 'development';
  const rawKey = env.MERCHANT_SIGNING_PRIVATE_JWK;
  const privateJwk = rawKey ? JSON.parse(rawKey) as JsonWebKey : undefined;
  const signer = await createLocalMerchantSigner({ issuer: input.merchant.id, privateJwk, nodeEnv });
  // Test runs must not inherit replay state from a developer's local CLI session.
  const store = nodeEnv === 'test'
    ? new InMemoryMandateReplayStore()
    : new JsonFileMandateReplayStore(path.resolve('.mandate-artifacts/replay-store.json'));
  const service = createMandateService({ merchantSigner: signer, replayStore: store });
  const { userReference, checkoutMandate, paymentMandate, ...checkoutInput } = input;
  const checkout = await service.createMerchantCheckout(checkoutInput);
  const checkoutDraft = await service.createCheckoutMandateDraft({
    checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash, transactionId: input.transactionId,
    userReference, ...checkoutMandate,
  });
  const paymentDraft = paymentMandate ? await service.createPaymentMandateDraft({
    transactionId: input.transactionId, checkoutJwt: checkout.checkoutJwt, checkoutHash: checkout.checkoutHash,
    checkoutMandateDraftId: checkoutDraft.id, userReference, nonce: paymentMandate.checkoutNonce,
    issuedAt: paymentMandate.issuedAt, expiresAt: paymentMandate.expiresAt, payee: paymentMandate.payee,
    paymentAmount: paymentMandate.paymentAmount, paymentInstrument: paymentMandate.paymentInstrument,
  }) : undefined;
  return { checkout, checkoutDraft, paymentDraft };
}

function safeOutput(result: Awaited<ReturnType<typeof createMandatesFromFile>>, full: boolean) {
  if (full) return result;
  return {
    checkout: { transactionId: result.checkout.transactionId, checkoutHash: result.checkout.checkoutHash, expiresAt: result.checkout.expiresAt },
    checkoutDraft: { id: result.checkoutDraft.id, status: result.checkoutDraft.status, expiresAt: result.checkoutDraft.expiresAt },
    paymentDraft: result.paymentDraft && { id: result.paymentDraft.id, status: result.paymentDraft.status, expiresAt: result.paymentDraft.expiresAt },
  };
}

async function main() {
  const [command, flag, inputPath] = process.argv.slice(2);
  if (command !== 'mandates:create' || flag !== '--input' || !inputPath) {
    throw new Error('Usage: npm run mandates:create -- --input ./fixtures/validated-checkout.json');
  }
  const result = await createMandatesFromFile(inputPath);
  const canShowFull = (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') && process.env.MANDATES_ALLOW_FULL_OUTPUT === 'true';
  console.log(JSON.stringify(safeOutput(result, canShowFull), null, 2));
}

if (process.argv[1]?.endsWith('mandates-create.ts')) {
  main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
}
