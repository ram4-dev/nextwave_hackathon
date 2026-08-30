/**
 * Payment runtime composition for createApp (optional third argument).
 */
import type { AppConfig } from '../../config/env.js';
import { createAuthorizationVerifier } from '../../config/env.js';
import type { AuthorizationVerifier } from '../../domain/authorization/verifier.js';
import type { PaymentRepository } from '../../persistence/payments/types.js';
import { FilePaymentRepository } from '../../persistence/payments/file.js';
import { MemoryPaymentRepository } from '../../persistence/payments/memory.js';
import { YunoAdapter } from '../../providers/yuno/yuno-adapter.js';
import { YunoHttpClient } from '../../providers/yuno/yuno-http-client.js';
import { PaymentService } from '../../services/payments/payment-service.js';
import path from 'node:path';

export type PaymentRuntime = {
  service: PaymentService;
  repo: PaymentRepository;
  configured: true;
};

export type PaymentRuntimeOptions = {
  repo?: PaymentRepository;
  authz?: AuthorizationVerifier;
  fetchImpl?: typeof fetch;
  /** Outbound platform webhook delivery fetch (defaults to fetchImpl / global fetch). */
  outboundFetch?: typeof fetch;
  /** When false, skip building even if config has YUNO_BASE_URL. */
  enabled?: boolean;
};

export function createPaymentRuntime(
  config: AppConfig,
  options: PaymentRuntimeOptions = {},
): PaymentRuntime | null {
  if (options.enabled === false) return null;
  if (!config.paymentsConfigured) return null;
  if (
    !config.YUNO_BASE_URL ||
    !config.YUNO_PUBLIC_API_KEY ||
    !config.YUNO_PRIVATE_SECRET_KEY ||
    !config.YUNO_ACCOUNT_ID ||
    !config.paymentSecretsKey ||
    !config.YUNO_WEBHOOK_HMAC_SECRET
  ) {
    return null;
  }

  const repo =
    options.repo ??
    (config.NODE_ENV === 'test'
      ? new MemoryPaymentRepository()
      : new FilePaymentRepository(
          path.resolve(config.PAYMENT_DATA_DIR, 'payments-store.json'),
        ));

  const client = new YunoHttpClient({
    baseUrl: config.YUNO_BASE_URL,
    publicApiKey: config.YUNO_PUBLIC_API_KEY,
    privateSecretKey: config.YUNO_PRIVATE_SECRET_KEY,
    timeoutMs: config.YUNO_HTTP_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });

  const adapter = new YunoAdapter(client, {
    accountId: config.YUNO_ACCOUNT_ID,
    baseUrl: config.YUNO_BASE_URL,
    secretsKey: config.paymentSecretsKey,
  });

  const authz = createAuthorizationVerifier(config, options.authz);

  const service = new PaymentService({
    repo,
    adapter,
    authz,
    webhookHmacSecret: config.YUNO_WEBHOOK_HMAC_SECRET,
    accountId: config.YUNO_ACCOUNT_ID,
    outboundFetch: options.outboundFetch ?? options.fetchImpl,
  });

  return { service, repo, configured: true };
}
