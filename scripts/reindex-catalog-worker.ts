import pg from 'pg';
import { TransformersEmbeddingProvider } from '../src/catalog/embedding.js';
import { applyCatalogMigrations } from '../src/catalog/migrate.js';
import { PostgresReindexWorker } from '../src/catalog/postgres-reindex-worker.js';
import { loadConfig } from '../src/config/env.js';

async function main() {
  const config = loadConfig();
  if (!config.CATALOG_DATABASE_URL) {
    throw new Error('CATALOG_DATABASE_URL is required for the catalog reindex worker');
  }
  if (!config.CATALOG_WORKER_ENABLED) {
    console.log('catalog_worker_disabled');
    return;
  }
  const pool = new pg.Pool({ connectionString: config.CATALOG_DATABASE_URL });
  await applyCatalogMigrations(pool);
  const embedding =
    process.env.CATALOG_EMBEDDING_PROVIDER === 'deterministic'
      ? new (await import('../src/catalog/embedding.js')).DeterministicEmbeddingProvider()
      : new TransformersEmbeddingProvider(config.CATALOG_EMBEDDING_MODEL);
  const worker = new PostgresReindexWorker(pool, embedding, {
    leaseMs: config.CATALOG_WORKER_LEASE_SECONDS * 1000,
    maxAttempts: config.CATALOG_WORKER_MAX_ATTEMPTS,
  });

  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ event: 'catalog_worker_stop', signal }));
    worker.requestStop();
    await worker.drain();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  console.log(JSON.stringify({ event: 'catalog_worker_start' }));
  await worker.runLoop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
