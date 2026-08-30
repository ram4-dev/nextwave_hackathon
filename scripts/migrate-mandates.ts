import pg from 'pg';
import { applyMandateMigrations } from '../src/mandates/migrate.js';

async function main() {
  const url = process.env.MANDATES_DATABASE_URL;
  if (!url) {
    throw new Error('Set MANDATES_DATABASE_URL before migrating the mandate schema');
  }
  const pool = new pg.Pool({ connectionString: url });
  try {
    const applied = await applyMandateMigrations(pool);
    console.log(`mandate migrations applied=${applied.join(',') || 'none'}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
