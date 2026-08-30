import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLocalMerchantSigner, createMandateService, JsonFileMandateReplayStore } from '../src/mandates/index.js';
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

const CLI_CLOCK_SKEW_MS = 5_000;

type CliMaterializationOptions = {
  now?: Date;
  clockSkewMs?: number;
  /** Explicitly shift the bundled static demo fixture onto `now`. */
  materializeDemoClock?: boolean;
};

function assertValidClock(now: Date, clockSkewMs: number): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('materializeCliInput requires a valid clock');
  }
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0) {
    throw new Error('materializeCliInput clockSkewMs must be a non-negative safe integer');
  }
}

function parsePeriod(issuedAt: string, expiresAt: string, label: string): { issued: number; expires: number } {
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) {
    throw new Error(`${label} requires finite issuedAt/expiresAt with expiresAt > issuedAt`);
  }
  return { issued, expires };
}

function assertLivePeriod(
  period: { issued: number; expires: number },
  now: Date,
  clockSkewMs: number,
  label: string,
): void {
  if (period.expires <= now.getTime()) throw new Error(`${label} is expired`);
  if (period.issued > now.getTime() + clockSkewMs) throw new Error(`${label} issuedAt is in the future`);
}

/**
 * Preserve and validate timestamps by default. Only the explicit demo option shifts
 * all bundled-fixture windows by one common delta so lineage and TTLs remain intact.
 */
export function materializeCliInput(input: CliInput, options: CliMaterializationOptions = {}): CliInput {
  const now = options.now ?? new Date();
  const clockSkewMs = options.clockSkewMs ?? CLI_CLOCK_SKEW_MS;
  assertValidClock(now, clockSkewMs);

  const checkout = parsePeriod(input.issuedAt, input.expiresAt, 'checkout');
  const checkoutMandate = parsePeriod(
    input.checkoutMandate.issuedAt,
    input.checkoutMandate.expiresAt,
    'checkoutMandate',
  );
  const paymentMandate = input.paymentMandate
    ? parsePeriod(input.paymentMandate.issuedAt, input.paymentMandate.expiresAt, 'paymentMandate')
    : undefined;

  if (!options.materializeDemoClock) {
    assertLivePeriod(checkout, now, clockSkewMs, 'checkout');
    assertLivePeriod(checkoutMandate, now, clockSkewMs, 'checkoutMandate');
    if (paymentMandate) assertLivePeriod(paymentMandate, now, clockSkewMs, 'paymentMandate');
    return structuredClone(input);
  }

  const deltaMs = now.getTime() - checkout.issued;
  const shifted = (timestamp: string): string => new Date(Date.parse(timestamp) + deltaMs).toISOString();
  const materialized: CliInput = {
    ...structuredClone(input),
    issuedAt: shifted(input.issuedAt),
    expiresAt: shifted(input.expiresAt),
    checkoutMandate: {
      ...structuredClone(input.checkoutMandate),
      issuedAt: shifted(input.checkoutMandate.issuedAt),
      expiresAt: shifted(input.checkoutMandate.expiresAt),
    },
    paymentMandate: input.paymentMandate
      ? {
          ...structuredClone(input.paymentMandate),
          issuedAt: shifted(input.paymentMandate.issuedAt),
          expiresAt: shifted(input.paymentMandate.expiresAt),
        }
      : undefined,
  };
  assertLivePeriod(parsePeriod(materialized.issuedAt, materialized.expiresAt, 'checkout'), now, clockSkewMs, 'checkout');
  assertLivePeriod(
    parsePeriod(materialized.checkoutMandate.issuedAt, materialized.checkoutMandate.expiresAt, 'checkoutMandate'),
    now,
    clockSkewMs,
    'checkoutMandate',
  );
  if (materialized.paymentMandate) {
    assertLivePeriod(
      parsePeriod(materialized.paymentMandate.issuedAt, materialized.paymentMandate.expiresAt, 'paymentMandate'),
      now,
      clockSkewMs,
      'paymentMandate',
    );
  }
  return materialized;
}

export async function createMandatesFromFile(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    replayStorePath?: string;
    now?: () => Date;
    /** Explicit opt-in for bundled static demo fixtures with absolute future timestamps. */
    materializeDemoClock?: boolean;
  } = {},
) {
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error('mandates:create requires NODE_ENV=development or NODE_ENV=test (fail-closed; no implicit default)');
  }
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as CliInput;
  const clock = options.now ?? (() => new Date());
  if (options.materializeDemoClock) {
    const bundledFixturePath = path.resolve(process.cwd(), 'fixtures/validated-checkout.json');
    if (path.resolve(filePath) !== bundledFixturePath) {
      throw new Error('--materialize-demo-clock is restricted to the bundled fixtures/validated-checkout.json');
    }
  }
  const input = materializeCliInput(raw, {
    now: clock(),
    materializeDemoClock: options.materializeDemoClock,
  });
  const rawKey = env.MERCHANT_SIGNING_PRIVATE_JWK;
  const privateJwk = rawKey ? JSON.parse(rawKey) as JsonWebKey : undefined;
  const signer = await createLocalMerchantSigner({ issuer: input.merchant.id, privateJwk, nodeEnv, now: clock });
  const store = new JsonFileMandateReplayStore(
    options.replayStorePath ?? path.resolve('.mandate-artifacts', `replay-store-${randomUUID()}.json`),
  );
  const service = createMandateService({ merchantSigner: signer, replayStore: store, now: clock });
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

function parseArgs(argv: string[]): { inputPath: string; materializeDemoClock: boolean } {
  let inputPath: string | undefined;
  let materializeDemoClock = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      if (inputPath !== undefined) throw new Error('--input may be provided only once');
      inputPath = argv[++i];
      if (!inputPath || inputPath.startsWith('--')) throw new Error('--input requires a path');
    } else if (arg === '--materialize-demo-clock') {
      if (materializeDemoClock) throw new Error('--materialize-demo-clock may be provided only once');
      materializeDemoClock = true;
    } else {
      throw new Error(`Unknown mandates:create argument: ${arg}`);
    }
  }
  if (!inputPath) {
    throw new Error(
      'Usage: NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json [--materialize-demo-clock]',
    );
  }
  return { inputPath, materializeDemoClock };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'mandates:create') {
    throw new Error(
      'Usage: NODE_ENV=test npm run mandates:create -- --input ./fixtures/validated-checkout.json [--materialize-demo-clock]',
    );
  }
  const { inputPath, materializeDemoClock } = parseArgs(rest);
  const result = await createMandatesFromFile(inputPath, process.env, { materializeDemoClock });
  const canShowFull = (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') && process.env.MANDATES_ALLOW_FULL_OUTPUT === 'true';
  console.log(JSON.stringify(safeOutput(result, canShowFull), null, 2));
}

if (process.argv[1]?.endsWith('mandates-create.ts')) {
  main().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
}
