import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '../supabase/migrations',
);

/** Strip SQL line/block comments so policy prose does not trip executable-statement guards. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

/** Executable statements must never destroy existing KYA tables. */
const FORBIDDEN_EXECUTABLE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+SCHEMA\b/i,
  /\bTRUNCATE\b/i,
];

describe('KYA migration safety guard', () => {
  it('forbids destructive DROP/TRUNCATE executable statements in migrations', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const sql = stripSqlComments(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      for (const pattern of FORBIDDEN_EXECUTABLE) {
        if (pattern.test(sql)) {
          violations.push(`${file} matches ${pattern}`);
        }
      }
      // CASCADE only forbidden alongside DROP (ON DELETE CASCADE on new FKs is also disallowed here).
      if (/\bDROP\b[\s\S]{0,40}\bCASCADE\b/i.test(sql) || /\bTRUNCATE\b[\s\S]{0,40}\bCASCADE\b/i.test(sql)) {
        violations.push(`${file} uses DROP/TRUNCATE CASCADE`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('02 migration is additive and de-authorizes legacy draft tables without dropping', async () => {
    const raw = await readFile(
      path.join(MIGRATIONS_DIR, '20260830090100_kya_state_cas.sql'),
      'utf8',
    );
    const sql = stripSqlComments(raw);
    expect(raw).toMatch(/NON-DESTRUCTIVE|preserve/i);
    expect(sql).toMatch(/kya_state/);
    expect(sql).toMatch(/revoke all on table public\.%I from anon, authenticated, service_role/i);
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(raw).toMatch(/LEGACY DRAFT/);
  });

  it('defines rate limiting as one UPSERT with reset/increment and RETURNING semantics', async () => {
    const files = [
      '20260830090000_create_kya_core.sql',
      '20260830090100_kya_state_cas.sql',
    ];
    for (const file of files) {
      const sql = stripSqlComments(
        await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'),
      );
      const match = sql.match(
        /create\s+or\s+replace\s+function\s+public\.kya_check_rate_limit[\s\S]*?\$\$;/i,
      );
      expect(match, `${file} rate RPC`).not.toBeNull();
      const rpc = match![0];
      expect(rpc.match(/insert\s+into\s+public\.kya_rate_limits/gi)).toHaveLength(1);
      expect(rpc).toMatch(/on\s+conflict\s*\(bucket_key\)\s+do\s+update/i);
      expect(rpc).toMatch(/reset_at\s*<=\s*p_now\s+then\s+1/i);
      expect(rpc).toMatch(/kya_rate_limits\.count\s*\+\s*1/i);
      expect(rpc).toMatch(/reset_at\s*<=\s*p_now\s+then\s+p_now\s*\+\s*v_window/i);
      expect(rpc).toMatch(/returning\s+public\.kya_rate_limits\.count\s+into\s+v_count/i);
      expect(rpc).not.toMatch(/select[\s\S]*?from\s+public\.kya_rate_limits/i);
    }
  });
});
