import path from 'node:path';
import pg from 'pg';
import { DeterministicEmbeddingProvider, TransformersEmbeddingProvider } from '../src/catalog/embedding.js';
import { loadJunoCatalogFromFile } from '../src/catalog/loader.js';
import { applyCatalogMigrations } from '../src/catalog/migrate.js';
import { PostgresCatalogRepository } from '../src/catalog/postgres-repository.js';
import { loadConfig } from '../src/config/env.js';

async function main() {
  const config = loadConfig();
  const url = config.CATALOG_DATABASE_URL ?? process.env.CATALOG_DATABASE_URL;
  if (!url) {
    throw new Error('Set CATALOG_DATABASE_URL before loading the Juno catalog');
  }
  const fixturePath = path.resolve(process.cwd(), 'fixtures/juno/catalog.json');
  const useDeterministic = process.env.CATALOG_EMBEDDING_PROVIDER === 'deterministic';
  const embedding = useDeterministic
    ? new DeterministicEmbeddingProvider()
    : new TransformersEmbeddingProvider(config.CATALOG_EMBEDDING_MODEL);
  const pool = new pg.Pool({ connectionString: url });
  try {
    await applyCatalogMigrations(pool);
    const repository = new PostgresCatalogRepository(pool);
    const result = await loadJunoCatalogFromFile({ fixturePath, repository, embedding });
    console.log(
      JSON.stringify({
        event: 'catalog_load',
        version: result.version,
        catalog_version_id: result.catalog_version_id,
        idempotent: result.idempotent,
        embedding_model: embedding.model,
        embedding_dimensions: embedding.dimensions,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
