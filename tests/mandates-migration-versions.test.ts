import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mandate migration version uniqueness', () => {
  it('requires unique numeric version prefixes for every migration file, covering both tables', async () => {
    const dir = path.join(process.cwd(), 'migrations/mandates');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    expect(files.length).toBeGreaterThanOrEqual(1);

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

    const combined = (
      await Promise.all(files.map((name) => readFile(path.join(dir, name), 'utf8')))
    ).join('\n');
    expect(combined).toContain('mandate_policy_reservations');
    expect(combined).toContain('mandate_requests');
  });
});
