import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';

export async function applyCatalogMigrations(
  client: Pool | PoolClient,
  migrationsDir = path.resolve(process.cwd(), 'migrations'),
): Promise<string[]> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS catalog_schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const existing = await client.query('SELECT 1 FROM catalog_schema_migrations WHERE id = $1', [file]);
    if ((existing.rowCount ?? 0) > 0) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await client.query(sql);
    await client.query('INSERT INTO catalog_schema_migrations (id) VALUES ($1)', [file]);
    applied.push(file);
  }
  return applied;
}
