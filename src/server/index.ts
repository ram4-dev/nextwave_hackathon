import { serve } from '@hono/node-server';
import path from 'node:path';
import { loadConfig } from '../config/env.js';
import { createPaymentRuntime } from '../api/payments/runtime.js';
import { JsonFileRepository } from '../persistence/repository.js';
import { FilePaymentRepository } from '../persistence/payments/file.js';
import { ensureSigningKey } from '../credentials/jws.js';
import { safeProviderHostname } from '../providers/yuno/sandbox-readiness.js';
import { createApp } from './app.js';

async function main() {
  const config = loadConfig();
  const dataFile = path.resolve(config.KYA_DATA_DIR, 'store.json');
  const repo = new JsonFileRepository(dataFile);
  await ensureSigningKey(repo);

  const paymentRepo = new FilePaymentRepository(
    path.resolve(config.PAYMENT_DATA_DIR, 'payments-store.json'),
  );
  const payment = createPaymentRuntime(config, { repo: paymentRepo });
  if (!payment && config.YUNO_BASE_URL) {
    console.warn(
      `YUNO_PROVIDER_ENV=${config.YUNO_PROVIDER_ENV} base URL set but payment runtime incomplete — payment routes return 503; ceremony routes still run`,
    );
  } else if (payment) {
    const host = safeProviderHostname(config.YUNO_BASE_URL);
    console.log(
      host
        ? `Payments enabled (providerEnv=${config.YUNO_PROVIDER_ENV}, host=${host})`
        : `Payments enabled (providerEnv=${config.YUNO_PROVIDER_ENV})`,
    );
  }

  const { app } = createApp(repo, config, payment);

  console.log(`KYA server listening on :${config.PORT} (COOP=same-origin-allow-popups)`);
  serve({ fetch: app.fetch, port: config.PORT });
}

main().catch((err) => {
  // Never dump full Error/Zod objects — messages are already sanitized by loadConfig.
  const msg = err instanceof Error ? err.message : 'startup failed';
  console.error(msg);
  process.exit(1);
});
