import pg from 'pg';
import { loadConfig } from '../src/config/env.js';
import { applyCatalogMigrations } from '../src/catalog/migrate.js';

async function main() {
  const config = loadConfig();
  const url = config.CATALOG_DATABASE_URL ?? process.env.CATALOG_DATABASE_URL;
  if (!url) {
    throw new Error('Set CATALOG_DATABASE_URL before migrating the Juno catalog');
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const applied = await applyCatalogMigrations(pool);
    console.log(`catalog migrations applied=${applied.join(',') || 'none'}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
