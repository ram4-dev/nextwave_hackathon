import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Opt-in Postgres mandate migration/integration tests.
 * Requires MANDATE_TEST_DATABASE_URL (never CATALOG_DATABASE_URL).
 * Run: MANDATE_TEST_DATABASE_URL=postgres://... npm run test:mandates:postgres
 */
const databaseUrl = process.env.MANDATE_TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;
const suffix = `${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const freshSchema = `mandate_fresh_${suffix}`;
const legacySchema = `mandate_legacy_${suffix}`;
const decoySchema = `mandate_decoy_${suffix}`;

function isolatedMigration(sql: string, schema: string): string {
  return sql
    .replaceAll('set search_path = public', `set search_path = ${schema}`)
    .replaceAll('public.', `${schema}.`)
    .replaceAll('from public, anon, authenticated;', 'from public;')
    .replaceAll('from anon, authenticated;', 'from public;')
    .replaceAll('to service_role;', 'to public;');
}

function reserveSql(schema: string): string {
  return `select remaining_budget_minor::text from ${schema}.reserve_mandate_policy(
    $1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12
  )`;
}

const reserveLimits = [100, 10, 3600, 10, 100, 10, 3600, 10] as const;

describePg('mandate schema fresh install and upgrade (Postgres)', () => {
  if (!databaseUrl) throw new Error('MANDATE_TEST_DATABASE_URL required');
  let client: pg.Client | undefined;
  let requestSql = '';
  let policySql = '';
  let upgradeSql = '';

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`create schema ${freshSchema}`);
    await client.query(`create schema ${legacySchema}`);
    await client.query(`create schema ${decoySchema}`);
    [requestSql, policySql, upgradeSql] = await Promise.all([
      readFile(path.join(process.cwd(), 'supabase/migrations/20260830000200_create_mandate_requests.sql'), 'utf8'),
      readFile(path.join(process.cwd(), 'supabase/migrations/20260830000100_create_mandate_policy_ledger.sql'), 'utf8'),
      readFile(path.join(process.cwd(), 'supabase/migrations/20260830235959_upgrade_mandate_schema_v2.sql'), 'utf8'),
    ]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`drop schema if exists ${freshSchema} cascade`);
    await client.query(`drop schema if exists ${legacySchema} cascade`);
    await client.query(`drop schema if exists ${decoySchema} cascade`);
    await client.end();
  });

  it('covers a fresh request/policy install, RPCs, CHECKs, 512/513, and concurrent exact balances', async () => {
    if (!client) throw new Error('no pg client');
    await client.query(isolatedMigration(requestSql, freshSchema));
    await client.query(isolatedMigration(policySql, freshSchema));

    const constraintsResult = await client.query(`
      select c.conname
      from pg_constraint c
      where c.conrelid = $1::regclass
      order by c.conname
    `, [`${freshSchema}.mandate_requests`]);
    const constraintNames = constraintsResult.rows.map((row) => row.conname);
    expect(constraintNames).toContain('mandate_requests_prompt_hash_sha256_chk');
    expect(constraintNames).toContain('mandate_requests_encrypted_prompt_ref_chk');
    const policyConstraints = await client.query(`
      select c.conname
      from pg_constraint c
      where c.conrelid = $1::regclass
    `, [`${freshSchema}.mandate_policy_reservations`]);
    expect(policyConstraints.rows.map((row) => row.conname)).toContain('mandate_policy_reservations_amount_safe_chk');

    const validHash = createHash('sha256').update('fresh').digest('base64url');
    const ref512 = 'a'.repeat(512);
    const ref513 = 'a'.repeat(513);
    await expect(client.query(
      `select ${freshSchema}.create_mandate_request($1,$2,$3,$4,$5,$6,now())`,
      ['fresh_512', 'fresh_txn_512', 'agent', 'tenant', validHash, ref512],
    )).resolves.toBeDefined();
    await expect(client.query(
      `select ${freshSchema}.create_mandate_request($1,$2,$3,$4,$5,$6,now())`,
      ['fresh_513', 'fresh_txn_513', 'agent', 'tenant', validHash, ref513],
    )).rejects.toThrow(/ENCRYPTED_PROMPT_REF_INVALID|encrypted_prompt_ref/i);
    await expect(client.query(`
      insert into ${freshSchema}.mandate_requests
        (id, transaction_id, agent_id, tenant_id, prompt_hash, encrypted_prompt_ref, received_at)
      values ($1,$2,$3,$4,$5,$6,now())
    `, ['fresh_check', 'fresh_txn_check', 'agent', 'tenant', 'plaintext', ref512])).rejects.toThrow(/prompt_hash|check/i);
    await expect(client.query(`
      insert into ${freshSchema}.mandate_requests
        (id, transaction_id, agent_id, tenant_id, prompt_hash, encrypted_prompt_ref, received_at)
      values ($1,$2,$3,$4,$5,$6,now())
    `, ['fresh_check_ref', 'fresh_txn_check_ref', 'agent', 'tenant', validHash, ref513])).rejects.toThrow(/encrypted_prompt_ref|check/i);

    const first = await client.query(reserveSql(freshSchema), [
      'checkout_fresh', 'payment_fresh', 'fresh_reserve_30', 30, ...reserveLimits,
    ]);
    expect(first.rows[0]?.remaining_budget_minor).toBe('70');
    const second = await client.query(reserveSql(freshSchema), [
      'checkout_fresh', 'payment_fresh', 'fresh_reserve_20', 20, ...reserveLimits,
    ]);
    expect(second.rows[0]?.remaining_budget_minor).toBe('50');
    await expect(client.query(reserveSql(freshSchema), [
      'checkout_invalid', 'payment_invalid', 'fresh_reserve_invalid', 1,
      null, ...reserveLimits.slice(1),
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(reserveSql(freshSchema), [
      'checkout_negative', 'payment_negative', 'fresh_reserve_negative', -1, ...reserveLimits,
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(reserveSql(freshSchema), [
      'checkout_unsafe', 'payment_unsafe', 'fresh_reserve_unsafe', '9007199254740992', ...reserveLimits,
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(reserveSql(freshSchema), [
      'checkout_budget_unsafe', 'payment_budget_unsafe', 'fresh_budget_unsafe', 1,
      '9007199254740992', ...reserveLimits.slice(1),
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(reserveSql(freshSchema), [
      'checkout_frequency_invalid', 'payment_frequency_valid', 'fresh_checkout_frequency_invalid', 1,
      100, 1, 3_600, 2, 100, 10, 3_600, 10,
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(reserveSql(freshSchema), [
      'checkout_frequency_valid', 'payment_frequency_invalid', 'fresh_payment_frequency_invalid', 1,
      100, 10, 3_600, 10, 100, 1, 3_600, 2,
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(`
      insert into ${freshSchema}.mandate_policy_reservations
        (transaction_id, checkout_mandate_id, payment_mandate_id, amount_minor, reserved_at)
      values ($1,$2,$3,$4,now())
    `, ['fresh_direct_unsafe', 'checkout_direct', 'payment_direct', '9007199254740992']))
      .rejects.toThrow(/amount_safe|check/i);

    const concurrentA = new pg.Client({ connectionString: databaseUrl });
    const concurrentB = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([concurrentA.connect(), concurrentB.connect()]);
    try {
      const results = await Promise.all([
        concurrentA.query(reserveSql(freshSchema), [
          'checkout_concurrent', 'payment_concurrent', 'concurrent_10', 10, ...reserveLimits,
        ]),
        concurrentB.query(reserveSql(freshSchema), [
          'checkout_concurrent', 'payment_concurrent', 'concurrent_20', 20, ...reserveLimits,
        ]),
      ]);
      const balances = results.map((result) => Number(result.rows[0]?.remaining_budget_minor)).sort((a, b) => a - b);
      expect(balances[0]).toBe(70);
      expect([80, 90]).toContain(balances[1]);
    } finally {
      await Promise.all([concurrentA.end(), concurrentB.end()]);
    }
  });

  it('upgrades the complete legacy shape and ignores same-name constraints on another relation', async () => {
    if (!client) throw new Error('no pg client');
    await client.query(`
      create table ${decoySchema}.mandate_requests (
        prompt_hash text constraint mandate_requests_prompt_hash_sha256_chk check (length(prompt_hash) > 0),
        encrypted_prompt_ref text constraint mandate_requests_encrypted_prompt_ref_chk check (length(encrypted_prompt_ref) > 0)
      );
      create table ${legacySchema}.mandate_requests (
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
      create table ${legacySchema}.mandate_policy_reservations (
        transaction_id text primary key,
        checkout_mandate_id text not null,
        payment_mandate_id text not null,
        amount_minor bigint not null,
        reserved_at timestamptz not null,
        released_at timestamptz,
        created_at timestamptz not null default now()
      );
      create function ${legacySchema}.create_mandate_request(
        p_id text, p_transaction_id text, p_agent_id text, p_tenant_id text,
        p_prompt text, p_prompt_hash text, p_received_at timestamptz
      ) returns ${legacySchema}.mandate_requests language sql as $$
        insert into ${legacySchema}.mandate_requests (id, transaction_id, agent_id, tenant_id, prompt, prompt_hash, received_at)
        values (p_id, p_transaction_id, p_agent_id, p_tenant_id, p_prompt, p_prompt_hash, p_received_at)
        returning *;
      $$;
      create function ${legacySchema}.reserve_mandate_policy(
        p_checkout_mandate_id text, p_payment_mandate_id text, p_transaction_id text,
        p_amount_minor bigint, p_reserved_at timestamptz, p_total_budget_minor bigint,
        p_max_operations integer, p_frequency_window_seconds integer, p_max_operations_per_window integer
      ) returns void language plpgsql as $$ begin null; end; $$;
    `);

    const isolatedUpgrade = isolatedMigration(upgradeSql, legacySchema);
    await client.query(isolatedUpgrade);
    await client.query(isolatedUpgrade);

    const cols = await client.query(`
      select column_name from information_schema.columns
      where table_schema = $1 and table_name = 'mandate_requests' order by column_name
    `, [legacySchema]);
    const columnNames = cols.rows.map((row) => row.column_name);
    expect(columnNames).toContain('prompt_hash');
    expect(columnNames).toContain('encrypted_prompt_ref');
    expect(columnNames).not.toContain('prompt');

    const targetConstraints = await client.query(`
      select conname from pg_constraint where conrelid = $1::regclass
    `, [`${legacySchema}.mandate_requests`]);
    expect(targetConstraints.rows.map((row) => row.conname)).toEqual(expect.arrayContaining([
      'mandate_requests_prompt_hash_sha256_chk',
      'mandate_requests_encrypted_prompt_ref_chk',
    ]));
    const legacyPolicyConstraints = await client.query(`
      select conname from pg_constraint where conrelid = $1::regclass
    `, [`${legacySchema}.mandate_policy_reservations`]);
    expect(legacyPolicyConstraints.rows.map((row) => row.conname))
      .toContain('mandate_policy_reservations_amount_safe_chk');

    const funcs = await client.query(`
      select p.proname, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $1
        and p.proname in ('create_mandate_request', 'reserve_mandate_policy', 'release_mandate_policy_reservation')
      order by 1, 2
    `, [legacySchema]);
    const reserveFunctions = funcs.rows.filter((row) => row.proname === 'reserve_mandate_policy');
    expect(reserveFunctions.some((row) => row.args.split(',').length === 9)).toBe(false);
    expect(reserveFunctions.some((row) => row.args.split(',').length === 13)).toBe(true);
    expect(reserveFunctions[0]?.result).toMatch(/remaining_budget_minor bigint/i);
    expect(funcs.rows.some((row) => row.proname === 'release_mandate_policy_reservation')).toBe(true);

    const validHash = createHash('sha256').update('legacy').digest('base64url');
    const ref512 = 'b'.repeat(512);
    const ref513 = 'b'.repeat(513);
    await expect(client.query(
      `select ${legacySchema}.create_mandate_request($1,$2,$3,$4,$5,$6,now())`,
      ['legacy_512', 'legacy_txn_512', 'agent', 'tenant', validHash, ref512],
    )).resolves.toBeDefined();
    await expect(client.query(
      `select ${legacySchema}.create_mandate_request($1,$2,$3,$4,$5,$6,now())`,
      ['legacy_513', 'legacy_txn_513', 'agent', 'tenant', validHash, ref513],
    )).rejects.toThrow(/ENCRYPTED_PROMPT_REF_INVALID|encrypted_prompt_ref/i);
    await expect(client.query(`
      insert into ${legacySchema}.mandate_requests
        (id, transaction_id, agent_id, tenant_id, prompt_hash, encrypted_prompt_ref, received_at)
      values ($1,$2,$3,$4,$5,$6,now())
    `, ['legacy_plain', 'legacy_txn_plain', 'agent', 'tenant', 'this-is-plaintext', null])).rejects.toThrow(/prompt_hash|check/i);

    const reservation = await client.query(reserveSql(legacySchema), [
      'checkout_legacy', 'payment_legacy', 'legacy_reserve_25', 25, ...reserveLimits,
    ]);
    expect(reservation.rows[0]?.remaining_budget_minor).toBe('75');
    await expect(client.query(reserveSql(legacySchema), [
      'checkout_legacy_unsafe', 'payment_legacy_unsafe', 'legacy_reserve_unsafe',
      '9007199254740992', ...reserveLimits,
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(reserveSql(legacySchema), [
      'checkout_legacy_frequency_invalid', 'payment_legacy_frequency_valid',
      'legacy_checkout_frequency_invalid', 1,
      100, 1, 3_600, 2, 100, 10, 3_600, 10,
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(reserveSql(legacySchema), [
      'checkout_legacy_frequency_valid', 'payment_legacy_frequency_invalid',
      'legacy_payment_frequency_invalid', 1,
      100, 10, 3_600, 10, 100, 1, 3_600, 2,
    ])).rejects.toThrow(/POLICY_INPUT_INVALID/i);
    await expect(client.query(`
      insert into ${legacySchema}.mandate_policy_reservations
        (transaction_id, checkout_mandate_id, payment_mandate_id, amount_minor, reserved_at)
      values ($1,$2,$3,$4,now())
    `, ['legacy_direct_unsafe', 'checkout_direct', 'payment_direct', '9007199254740992']))
      .rejects.toThrow(/amount_safe|check/i);
    await client.query(`select ${legacySchema}.release_mandate_policy_reservation($1)`, ['legacy_reserve_25']);
    const released = await client.query(`
      select released_at is not null as released
      from ${legacySchema}.mandate_policy_reservations
      where transaction_id = $1
    `, ['legacy_reserve_25']);
    expect(released.rows[0]?.released).toBe(true);
  });
});
