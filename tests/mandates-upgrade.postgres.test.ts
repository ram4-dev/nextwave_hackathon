import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Opt-in Postgres mandate upgrade/integration tests.
 * Requires MANDATE_TEST_DATABASE_URL (never CATALOG_DATABASE_URL).
 * Run: MANDATE_TEST_DATABASE_URL=postgres://... npm run test:mandates:postgres
 */
const databaseUrl = process.env.MANDATE_TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;

describePg('mandate schema upgrade (Postgres)', () => {
  if (!databaseUrl) throw new Error('MANDATE_TEST_DATABASE_URL required');
  let client: pg.Client | undefined;
  const schema = `mandate_upgrade_${Date.now()}`;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}`);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.end();
  });

  it('upgrades legacy prompt + 9-arg reserve schema to remediated shape', async () => {
    if (!client) throw new Error('no pg client');
    // Legacy schema (pre-remediation)
    await client.query(`
      create table mandate_requests (
        id text primary key,
        transaction_id text not null unique,
        agent_id text not null,
        tenant_id text not null,
        prompt text not null,
        prompt_hash text not null,
        received_at timestamptz not null,
        status text not null default 'received',
        created_at timestamptz not null default now()
      );
      create table mandate_policy_reservations (
        transaction_id text primary key,
        checkout_mandate_id text not null,
        payment_mandate_id text not null,
        amount_minor bigint not null,
        reserved_at timestamptz not null,
        released_at timestamptz,
        created_at timestamptz not null default now()
      );
      create function create_mandate_request(
        p_id text, p_transaction_id text, p_agent_id text, p_tenant_id text,
        p_prompt text, p_prompt_hash text, p_received_at timestamptz
      ) returns mandate_requests language sql as $$
        insert into mandate_requests (id, transaction_id, agent_id, tenant_id, prompt, prompt_hash, received_at)
        values (p_id, p_transaction_id, p_agent_id, p_tenant_id, p_prompt, p_prompt_hash, p_received_at)
        returning *;
      $$;
      create function reserve_mandate_policy(
        p_checkout_mandate_id text, p_payment_mandate_id text, p_transaction_id text,
        p_amount_minor bigint, p_reserved_at timestamptz, p_total_budget_minor bigint,
        p_max_operations integer, p_frequency_window_seconds integer, p_max_operations_per_window integer
      ) returns void language plpgsql as $$ begin null; end; $$;
    `);

    const upgradeSql = await readFile(
      path.join(process.cwd(), 'supabase/migrations/20260830235959_upgrade_mandate_schema_v2.sql'),
      'utf8',
    );
    // Rewrite public. -> current schema for isolated test
    await client.query(upgradeSql.replaceAll('public.', `${schema}.`).replaceAll('set search_path = public', `set search_path = ${schema}`));

    const cols = await client.query(`
      select column_name from information_schema.columns
      where table_schema = $1 and table_name = 'mandate_requests' order by column_name
    `, [schema]);
    const names = cols.rows.map((row) => row.column_name);
    expect(names).toContain('prompt_hash');
    expect(names).toContain('encrypted_prompt_ref');
    expect(names).not.toContain('prompt');

    const funcs = await client.query(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1 and p.proname in ('create_mandate_request', 'reserve_mandate_policy')
      order by 1, 2
    `, [schema]);
    const reserveArgs = funcs.rows.filter((row) => row.proname === 'reserve_mandate_policy').map((row) => row.args);
    expect(reserveArgs.some((args: string) => args.split(',').length === 9)).toBe(false);
    expect(reserveArgs.some((args: string) => args.split(',').length === 13)).toBe(true);

    // Fresh-install idempotency: applying upgrade again must not fail.
    await client.query(upgradeSql.replaceAll('public.', `${schema}.`).replaceAll('set search_path = public', `set search_path = ${schema}`));
  });

  it('rejects plaintext-like prompt_hash via RPC and table CHECK', async () => {
    if (!client) throw new Error('no pg client');
    await expect(client.query(
      `select create_mandate_request($1,$2,$3,$4,$5,$6,now())`,
      ['id_plain', 'txn_plain', 'agent', 'tenant', 'this-is-plaintext!!', null],
    )).rejects.toThrow(/PROMPT_HASH_INVALID|check|mandate_requests_prompt_hash/i);

    const validHash = createHash('sha256').update('ok').digest('base64url');
    await client.query(
      `select create_mandate_request($1,$2,$3,$4,$5,$6,now())`,
      ['id_ok', 'txn_ok', 'agent', 'tenant', validHash, 'enc_ref_1'],
    );
  });
});
