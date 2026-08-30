import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

/** Same tracked-migrations pattern as src/catalog/migrate.ts, kept independent per domain. */
export async function applyMandateMigrations(
  client: Pool | PoolClient,
  migrationsDir = path.resolve(process.cwd(), 'migrations/mandates'),
): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS mandate_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const existing = await client.query('SELECT 1 FROM mandate_schema_migrations WHERE id = $1', [file]);
    if ((existing.rowCount ?? 0) > 0) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO mandate_schema_migrations (id) VALUES ($1)', [file]);
    applied.push(file);
  }
  return applied;
}
