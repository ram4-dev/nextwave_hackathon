import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Opt-in Postgres mandate schema integration tests, against the same self-hosted
 * migration the app applies via `npm run mandates:migrate`.
 * Requires MANDATE_TEST_DATABASE_URL (never CATALOG_DATABASE_URL).
 * Run: MANDATE_TEST_DATABASE_URL=postgres://... npm run test:mandates:postgres
 */
const databaseUrl = process.env.MANDATE_TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;
const suffix = `${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const freshSchema = `mandate_fresh_${suffix}`;

/** Isolate the migration in its own schema so repeated test runs never collide. */
function isolatedMigration(sql: string, schema: string): string {
  const adjusted = sql.replaceAll(
    'set search_path = pg_catalog, public',
    `set search_path = pg_catalog, ${schema}, public`,
  );
  return `set search_path to ${schema}, public;\n${adjusted}`;
}

function reserveSql(schema: string): string {
  return `select remaining_budget_minor::text from ${schema}.reserve_mandate_policy(
    $1,$2,$3,$4,now(),$5,$6,$7,$8,$9,$10,$11,$12
  )`;
}

const reserveLimits = [100, 10, 3600, 10, 100, 10, 3600, 10] as const;

describePg('mandate schema fresh install (Postgres)', () => {
  if (!databaseUrl) throw new Error('MANDATE_TEST_DATABASE_URL required');
  let client: pg.Client | undefined;
  let schemaSql = '';

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`create schema ${freshSchema}`);
    schemaSql = await readFile(
      path.join(process.cwd(), 'migrations/mandates/001_mandate_schema.sql'),
      'utf8',
    );
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`drop schema if exists ${freshSchema} cascade`);
    await client.end();
  });

  it('covers a fresh request/policy install, RPCs, CHECKs, 512/513, and concurrent exact balances', async () => {
    if (!client) throw new Error('no pg client');
    await client.query(isolatedMigration(schemaSql, freshSchema));

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

    await client.query(`select ${freshSchema}.release_mandate_policy_reservation($1)`, ['fresh_reserve_30']);
    const released = await client.query(`
      select released_at is not null as released
      from ${freshSchema}.mandate_policy_reservations
      where transaction_id = $1
    `, ['fresh_reserve_30']);
    expect(released.rows[0]?.released).toBe(true);
  });
});
