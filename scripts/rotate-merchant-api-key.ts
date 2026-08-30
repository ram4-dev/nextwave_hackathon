import pg from 'pg';
import { rotateMerchantApiKeyInPostgres } from '../src/catalog/postgres-acp-store.js';
import { loadConfig } from '../src/config/env.js';

async function main() {
  const config = loadConfig();
  if (!config.CATALOG_DATABASE_URL) {
    throw new Error('Set CATALOG_DATABASE_URL before rotating a merchant API key');
  }
  const previousRawKey = process.argv[2];
  if (!previousRawKey) {
    throw new Error('Usage: npm run catalog:rotate -- <previous_api_key>');
  }
  const pool = new pg.Pool({ connectionString: config.CATALOG_DATABASE_URL });
  try {
    const issued = await rotateMerchantApiKeyInPostgres(pool, previousRawKey);
    process.stdout.write(`merchant_id=${issued.merchant_id}\napi_key=${issued.raw}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
