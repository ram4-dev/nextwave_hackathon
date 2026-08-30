#!/usr/bin/env tsx
/**
 * Idempotent JSON ↔ Supabase import/export for KYA store via CAS aggregate.
 * Preserves existing IDs. Rejects forbidden material. Never prints secrets.
 *
 * Usage:
 *   npx tsx scripts/kya-store-migrate.ts export --out store.json
 *   npx tsx scripts/kya-store-migrate.ts import --in store.json [--dry-run]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config/env.js';
import {
  checkSupabaseSchemaReady,
  createSupabaseServiceClient,
  SupabaseRepository,
} from '../src/persistence/supabase-repository.js';
import type { KyaStore } from '../src/persistence/repository.js';
import {
  assertNoForbiddenMigrateMaterial,
  importStoreWithOptions,
  validateImportStore,
} from '../src/persistence/migrate-store.js';
import path from 'node:path';

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dryRun = args.includes('--dry-run');
  const fileFlag = args.includes('--in') ? '--in' : args.includes('--out') ? '--out' : undefined;
  const fileArg = fileFlag ? args[args.indexOf(fileFlag) + 1] : undefined;
  if (!cmd || !fileArg || !['import', 'export'].includes(cmd)) {
    console.error('Usage: kya-store-migrate.ts import|export --in|--out <file> [--dry-run]');
    process.exit(2);
  }
  const config = loadConfig();
  if (config.PERSISTENCE_BACKEND !== 'supabase') {
    console.error('PERSISTENCE_BACKEND must be supabase for this utility');
    process.exit(1);
  }
  const client = createSupabaseServiceClient(config);
  if (!(await checkSupabaseSchemaReady(client))) {
    console.error('Supabase schema not ready (kya_core_version missing)');
    process.exit(1);
  }
  const repo = new SupabaseRepository(client);
  const filePath = path.resolve(fileArg);

  if (cmd === 'export') {
    const store = await repo.getStore();
    assertNoForbiddenMigrateMaterial(store);
    if (dryRun) {
      console.log(`Dry-run export OK (${store.principals.length} principals; no payload printed)`);
      return;
    }
    await writeFile(
      filePath,
      JSON.stringify(store, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );
    console.log(`Exported KYA store to ${filePath} (IDs preserved; no secrets printed)`);
    return;
  }

  const raw = JSON.parse(await readFile(filePath, 'utf8')) as KyaStore;
  const result = await importStoreWithOptions(repo, validateImportStore(raw), { dryRun });
  if (result.action === 'dry-run') {
    console.log(
      `Dry-run import OK (${raw.principals?.length ?? 0} principals, ${raw.enrollments?.length ?? 0} enrollments; no remote write)`,
    );
    return;
  }
  console.log(`Imported KYA store from ${filePath} via CAS (${result.action}, v${result.version})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'migrate failed');
  process.exit(1);
});
