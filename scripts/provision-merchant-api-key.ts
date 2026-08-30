import pg from 'pg';
import { applyCatalogMigrations } from '../src/catalog/migrate.js';
import { provisionMerchantInPostgres } from '../src/catalog/postgres-acp-store.js';
import { loadConfig } from '../src/config/env.js';

async function main() {
  const config = loadConfig();
  if (!config.CATALOG_DATABASE_URL) {
    throw new Error('Set CATALOG_DATABASE_URL before provisioning a merchant API key');
  }
  const merchantId = process.argv[2] ?? 'merchant_acp_demo';
  const pool = new pg.Pool({ connectionString: config.CATALOG_DATABASE_URL });
  try {
    await applyCatalogMigrations(pool);
    const issued = await provisionMerchantInPostgres(pool, {
      merchant_id: merchantId,
      name: process.argv[3] ?? 'Merchant ACP demo',
      slug: merchantId.replaceAll('_', '-'),
      category: 'comercio',
    });
    process.stdout.write(`merchant_id=${issued.merchant_id}\napi_key=${issued.raw}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
