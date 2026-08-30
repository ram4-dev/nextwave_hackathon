import { serve } from '@hono/node-server';
import path from 'node:path';
import pg from 'pg';
import { createPaymentRuntime } from '../api/payments/runtime.js';
import { MerchantFeedAuthorizer } from '../catalog/acp-contract.js';
import { TransformersEmbeddingProvider } from '../catalog/embedding.js';
import { acpIngestionOptionsFromConfig } from '../catalog/ingestion.js';
import { PostgresAcpIngestionService, PostgresMerchantKeyStore } from '../catalog/postgres-acp-store.js';
import { PostgresCatalogRepository } from '../catalog/postgres-repository.js';
import { CatalogSearchService } from '../catalog/search.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { ensureSigningKey } from '../credentials/jws.js';
import { FilePaymentRepository } from '../persistence/payments/file.js';
import { JsonFileRepository } from '../persistence/repository.js';
import type { Repository } from '../persistence/repository.js';
import { safeProviderHostname } from '../providers/yuno/sandbox-readiness.js';
import {
  assertRegistryReadyForChain,
  createRegistryPublicClient,
  selectLiveWatcherChains,
} from '../registry/identity.js';
import { startEventWatcher } from '../registry/events.js';
import { createApp } from './app.js';

export async function startLiveEventWatchers(
  config: AppConfig,
  repo: Repository,
): Promise<{ stopAll: () => void; chains: Array<84532 | 8453> }> {
  const chains = selectLiveWatcherChains(config);
  const stops: Array<() => void> = [];

  for (const chainId of chains) {
    const ready = await assertRegistryReadyForChain(config, chainId);
    const client = createRegistryPublicClient(config, chainId);
    const watcher = await startEventWatcher(client, repo, {
      chainId,
      registry: ready.registry,
      confirmations: 1,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      // Base's public HTTP RPC can create filters that another load-balanced
      // backend cannot later resolve. Stateless block-range polling avoids that.
      statelessPolling: true,
    });
    stops.push(watcher.stop);
    console.log(
      `KYA event watcher started chain=${chainId} registry=${ready.registry} version=${ready.version}`,
    );
  }

  return {
    chains,
    stopAll: () => {
      for (const stop of stops) {
        stop();
      }
      stops.length = 0;
    },
  };
}

async function main() {
  const config = loadConfig();
  const dataFile = path.resolve(config.KYA_DATA_DIR, 'store.json');
  const repo = new JsonFileRepository(dataFile);
  await ensureSigningKey(repo, config);

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

  const catalogPool = config.CATALOG_DATABASE_URL
    ? new pg.Pool({ connectionString: config.CATALOG_DATABASE_URL })
    : undefined;
  const catalogSearch = catalogPool
    ? new CatalogSearchService(
        new PostgresCatalogRepository(catalogPool),
        new TransformersEmbeddingProvider(config.CATALOG_EMBEDDING_MODEL),
      )
    : undefined;
  const acpAuthorizer =
    catalogPool && config.CATALOG_ACP_ENABLED
      ? new MerchantFeedAuthorizer(new PostgresMerchantKeyStore(catalogPool))
      : undefined;
  const acpIngestion =
    catalogPool && config.CATALOG_ACP_ENABLED
      ? new PostgresAcpIngestionService(catalogPool, acpIngestionOptionsFromConfig(config))
      : undefined;

  const { app } = createApp(repo, config, {
    catalogSearch,
    acpAuthorizer,
    acpIngestion,
    payment,
  });

  let stopAllWatchers: (() => void) | undefined;

  if (config.KYA_MODE === 'live') {
    try {
      const started = await startLiveEventWatchers(config, repo);
      stopAllWatchers = started.stopAll;
    } catch (err) {
      console.error('Failed to start live event watcher(s) (registry readiness)', err);
      process.exit(1);
    }
  }

  const shutdown = async () => {
    if (stopAllWatchers) {
      try {
        stopAllWatchers();
        console.log('KYA event watchers stopped');
      } catch (err) {
        console.error('Error stopping watchers', err);
      }
    }
    await catalogPool?.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  console.log(
    `KYA server listening on :${config.PORT} mode=${config.KYA_MODE} (COOP=same-origin-allow-popups)`,
  );
  serve({ fetch: app.fetch, port: config.PORT });
}

main().catch((err) => {
  // Never dump full Error/Zod objects — messages are already sanitized by loadConfig.
  const msg = err instanceof Error ? err.message : 'startup failed';
  console.error(msg);
  process.exit(1);
});
