import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('supabase migration version uniqueness', () => {
  it('requires unique numeric version prefixes for every migration file', async () => {
    const dir = path.join(process.cwd(), 'supabase/migrations');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(3);

    const versions = files.map((name) => {
      const match = name.match(/^(\d+)_/);
      expect(match, `migration ${name} must start with a numeric version prefix`).toBeTruthy();
      return match![1];
    });

    expect(new Set(versions).size).toBe(versions.length);

    const ordered = [...versions].sort((a, b) => {
      const left = BigInt(a!);
      const right = BigInt(b!);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    expect(versions).toEqual(ordered);

    expect(files.some((name) => name.includes('create_mandate_policy_ledger'))).toBe(true);
    expect(files.some((name) => name.includes('create_mandate_requests'))).toBe(true);
    expect(files.at(-1)).toBe('20260830235959_upgrade_mandate_schema_v2.sql');
  });
});
