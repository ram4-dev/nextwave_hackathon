import pg from 'pg';
import { revokeMerchantApiKeyInPostgres } from '../src/catalog/postgres-acp-store.js';
import { loadConfig } from '../src/config/env.js';

async function main() {
  const config = loadConfig();
  if (!config.CATALOG_DATABASE_URL) {
    throw new Error('Set CATALOG_DATABASE_URL before revoking a merchant API key');
  }
  const rawKey = process.argv[2];
  if (!rawKey) {
    throw new Error('Usage: npm run catalog:revoke -- <api_key>');
  }
  const pool = new pg.Pool({ connectionString: config.CATALOG_DATABASE_URL });
  try {
    await revokeMerchantApiKeyInPostgres(pool, rawKey);
    process.stdout.write('revoked=true\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
