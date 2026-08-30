import { serve } from '@hono/node-server';
import path from 'node:path';
import pg from 'pg';
import { MerchantFeedAuthorizer } from '../catalog/acp-contract.js';
import { TransformersEmbeddingProvider } from '../catalog/embedding.js';
import { acpIngestionOptionsFromConfig } from '../catalog/ingestion.js';
import { PostgresAcpIngestionService, PostgresMerchantKeyStore } from '../catalog/postgres-acp-store.js';
import { PostgresCatalogRepository } from '../catalog/postgres-repository.js';
import { CatalogSearchService } from '../catalog/search.js';
import { loadConfig, type AppConfig } from '../config/env.js';
import { JsonFileRepository } from '../persistence/repository.js';
import { ensureSigningKey } from '../credentials/jws.js';
import { createApp } from './app.js';
import {
  assertRegistryReadyForChain,
  createRegistryPublicClient,
  selectLiveWatcherChains,
} from '../registry/identity.js';
import { startEventWatcher } from '../registry/events.js';
import type { Repository } from '../persistence/repository.js';

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
  const { app } = createApp(repo, config, { catalogSearch, acpAuthorizer, acpIngestion });

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

  console.log(`KYA server listening on :${config.PORT} mode=${config.KYA_MODE}`);
  serve({ fetch: app.fetch, port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
