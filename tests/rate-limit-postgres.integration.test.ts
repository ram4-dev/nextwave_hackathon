import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const ADMIN_URL = 'postgres://catalog:catalog@127.0.0.1:55432/postgres';
const databaseName = `kya_rate_test_${process.pid}_${Date.now()}`;
let pool: pg.Pool;

function databaseUrl(name: string): string {
  return `postgres://catalog:catalog@127.0.0.1:55432/${name}`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function withoutRoleGrants(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*(grant|revoke)\b/i.test(line))
    .join('\n');
}

async function ensureLocalPostgres(): Promise<void> {
  const existing = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await existing.connect();
    return;
  } catch {
    // Start the repository-local PostgreSQL only when the known local port is free.
  } finally {
    await existing.end().catch(() => undefined);
  }
  await execFileAsync('docker', [
    'compose',
    '-f',
    path.resolve(process.cwd(), 'docker-compose.catalog.yml'),
    'up',
    '-d',
    '--wait',
  ]);
}

describe('KYA rate-limit SQL RPC', () => {
  beforeAll(async () => {
    await ensureLocalPostgres();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${quoteIdentifier(databaseName)}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: databaseUrl(databaseName), max: 24 });
    for (const file of [
      '20260830090000_create_kya_core.sql',
      '20260830090100_kya_state_cas.sql',
    ]) {
      const sql = await readFile(
        path.resolve(process.cwd(), 'supabase/migrations', file),
        'utf8',
      );
      await pool.query(withoutRoleGrants(sql));
    }
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(
      `drop database if exists ${quoteIdentifier(databaseName)} with (force)`,
    );
    await admin.end();
  });

  it('returns correct allowance for new, existing, denied, and expired windows', async () => {
    const at = '2026-08-30T12:00:00.000Z';
    const call = (now: string) =>
      pool.query<{ allowed: boolean; remaining: number }>(
        'select * from public.kya_check_rate_limit($1, $2, $3, $4)',
        ['behavior', 2, 60_000, now],
      );

    expect((await call(at)).rows[0]).toEqual({ allowed: true, remaining: 1 });
    expect((await call(at)).rows[0]).toEqual({ allowed: true, remaining: 0 });
    expect((await call(at)).rows[0]).toEqual({ allowed: false, remaining: 0 });
    expect((await call('2026-08-30T12:01:01.000Z')).rows[0]).toEqual({
      allowed: true,
      remaining: 1,
    });
    const persisted = await pool.query<{ count: number }>(
      'select count from public.kya_rate_limits where bucket_key = $1',
      ['behavior'],
    );
    expect(persisted.rows[0]?.count).toBe(1);
  });

  it('serializes concurrent increments without lost updates', async () => {
    const requests = 20;
    const results = await Promise.all(
      Array.from({ length: requests }, () =>
        pool.query<{ allowed: boolean; remaining: number }>(
          'select * from public.kya_check_rate_limit($1, $2, $3, $4)',
          ['concurrent', 100, 60_000, '2026-08-30T12:00:00.000Z'],
        ),
      ),
    );
    const remaining = results
      .map((result) => result.rows[0]!.remaining)
      .sort((a, b) => a - b);
    expect(remaining).toEqual(Array.from({ length: requests }, (_, i) => 80 + i));
    const persisted = await pool.query<{ count: number }>(
      'select count from public.kya_rate_limits where bucket_key = $1',
      ['concurrent'],
    );
    expect(persisted.rows[0]?.count).toBe(requests);
  });
});
