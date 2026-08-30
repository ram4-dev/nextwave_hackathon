import { serve } from '@hono/node-server';
import path from 'node:path';
import { loadConfig } from '../config/env.js';
import { JsonFileRepository } from '../persistence/repository.js';
import { ensureSigningKey } from '../credentials/jws.js';
import { createApp } from './app.js';

async function main() {
  const config = loadConfig();
  const dataFile = path.resolve(config.KYA_DATA_DIR, 'store.json');
  const repo = new JsonFileRepository(dataFile);
  await ensureSigningKey(repo);
  const { app } = createApp(repo, config);

  console.log(`KYA server listening on :${config.PORT} (COOP=same-origin-allow-popups)`);
  serve({ fetch: app.fetch, port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
