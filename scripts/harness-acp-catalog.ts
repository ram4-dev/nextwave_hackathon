import pg from 'pg';
import { ACP_API_VERSION, MerchantFeedAuthorizer } from '../src/catalog/acp-contract.js';
import { DeterministicEmbeddingProvider } from '../src/catalog/embedding.js';
import { applyCatalogMigrations } from '../src/catalog/migrate.js';
import {
  PostgresAcpIngestionService,
  PostgresMerchantKeyStore,
  provisionMerchantInPostgres,
} from '../src/catalog/postgres-acp-store.js';
import { PostgresReindexWorker } from '../src/catalog/postgres-reindex-worker.js';
import { PostgresCatalogRepository } from '../src/catalog/postgres-repository.js';
import { CatalogSearchService } from '../src/catalog/search.js';
import { loadConfig } from '../src/config/env.js';
import { InMemoryRepository } from '../src/persistence/repository.js';
import { createApp } from '../src/server/app.js';

const DATABASE_URL =
  process.env.CATALOG_DATABASE_URL ?? 'postgres://catalog:catalog@127.0.0.1:55432/juno_catalog';

function headers(apiKey: string, idem: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'api-version': ACP_API_VERSION,
    'idempotency-key': idem,
    'request-id': `harness-${idem}`,
    timestamp: new Date().toISOString(),
    'accept-language': 'es-AR',
    'user-agent': 'juno-acp-harness/1.0',
  };
}

async function main() {
  process.env.CATALOG_DATABASE_URL = DATABASE_URL;
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'development',
    KYA_MODE: 'demo',
    CATALOG_ACP_ENABLED: 'true',
    CATALOG_EMBEDDING_PROVIDER: 'deterministic',
  });
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await applyCatalogMigrations(pool);
  const issued = await provisionMerchantInPostgres(pool, {
    merchant_id: `merchant_harness_${Date.now()}`,
    name: 'Harness Palermo',
    slug: 'harness-palermo',
    category: 'almacen',
  });
  const embedding = new DeterministicEmbeddingProvider();
  const { app } = createApp(new InMemoryRepository(), config, {
    catalogSearch: new CatalogSearchService(new PostgresCatalogRepository(pool), embedding),
    acpAuthorizer: new MerchantFeedAuthorizer(new PostgresMerchantKeyStore(pool)),
    acpIngestion: new PostgresAcpIngestionService(pool),
  });

  const created = await app.request('/product_feeds', {
    method: 'POST',
    headers: headers(issued.raw, 'harness-feed'),
    body: JSON.stringify({ target_country: 'AR' }),
  });
  const feed = (await created.json()) as { id: string };
  const patch = await app.request(`/product_feeds/${feed.id}/products`, {
    method: 'PATCH',
    headers: headers(issued.raw, 'harness-patch'),
    body: JSON.stringify({
      products: [
        {
          id: 'prod_yerba',
          title: 'Yerba mate suave',
          description: { plain: 'Yerba para mate de todos los días' },
          variants: [
            {
              id: 'var_kilo',
              title: 'Paquete 1kg',
              price: { amount: 4500, currency: 'ARS' },
              availability: { available: true, status: 'in_stock' },
              categories: [{ value: 'almacen' }],
            },
          ],
        },
      ],
    }),
  });
  const worker = new PostgresReindexWorker(pool, embedding, { leaseMs: 5_000, maxAttempts: 3 });
  while (await worker.processNext()) {
    /* drain outbox */
  }
  const search = await app.request('/v1/catalog/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'yerba mate', filters: { merchant_ids: [issued.merchant_id] } }),
  });
  const body = (await search.json()) as {
    catalog_version?: unknown;
    results: Array<{ item_id: string; data_revision: number; search_revision: number; index_revision: number }>;
  };
  await pool.end();
  const evidence = {
    feed_status: created.status,
    patch_status: patch.status,
    search_status: search.status,
    catalog_version_absent: !('catalog_version' in body),
    result_count: body.results.length,
    revisions: body.results[0]
      ? {
          data_revision: body.results[0].data_revision,
          search_revision: body.results[0].search_revision,
          index_revision: body.results[0].index_revision,
        }
      : null,
  };
  if (
    created.status !== 200 ||
    patch.status !== 200 ||
    search.status !== 200 ||
    !evidence.catalog_version_absent ||
    evidence.result_count < 1 ||
    evidence.revisions?.index_revision !== evidence.revisions?.search_revision
  ) {
    throw new Error(`ACP harness failed ${JSON.stringify(evidence)}`);
  }
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
